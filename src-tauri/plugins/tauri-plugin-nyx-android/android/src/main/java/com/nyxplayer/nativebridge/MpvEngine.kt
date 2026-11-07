package com.nyxplayer.nativebridge

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import app.tauri.plugin.JSObject
import dev.jdtech.mpv.MPVLib
import dev.jdtech.mpv.MPVLib.MpvEvent
import dev.jdtech.mpv.MPVLib.MpvFormat
import dev.jdtech.mpv.MPVLib.MpvLogLevel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/**
 * libmpv (same engine as the desktop player, FFmpeg based) rendered into a SurfaceView
 * inserted *behind* the Tauri WebView.
 *
 * Decoding: `mediacodec` (hardware, zero-copy) then `mediacodec-copy`, then FFmpeg software
 * decoding for everything the phone's chip cannot decode (H.264 10-bit, MPEG-2, VC-1…).
 * Properties are mpv's own, so the frontend receives exactly what it gets on desktop.
 *
 * libmpv events arrive on a native thread: everything touching views or the WebView bridge
 * is posted to the main thread.
 */
class MpvEngine(
    private val activity: Activity,
    private val webView: WebView,
    private val emit: EngineEmitter,
    /** Téléphone : « écouteurs débranchés » met en pause. La TV n'en a pas l'usage (sortie HDMI). */
    pauseWhenNoisy: Boolean,
    /** TV : sous-titres remontés au-dessus de la bande que la télé rogne (TvSubtitlePolicy) */
    private val television: Boolean,
) : PlayerEngine, MPVLib.EventObserver, MPVLib.LogObserver, SurfaceHolder.Callback {
    override val id = "libmpv"

    private val main = Handler(Looper.getMainLooper())
    private var mpv: MPVLib? = null
    private var surfaceView: SurfaceView? = null
    private var surfaceReady = false
    /** Fichier de certificats donné à libmpv (null tant que l'export n'a pas réussi) */
    private var caFile: File? = null

    private data class LoadRequest(val url: String, val startSeconds: Double, val paused: Boolean)

    /** Loaded as soon as the surface exists (mpv needs a surface before the first loadfile). */
    private var pendingLoad: LoadRequest? = null
    private var currentUrl: String? = null
    /** Dernier flux envoyé à mpv, et s'il a fini de s'ouvrir (avant : durée et position inconnues). */
    private var lastLoad: LoadRequest? = null
    @Volatile private var fileLoaded = false

    // Load failure detection: END_FILE after START_FILE without FILE_LOADED + an explicit failure log
    @Volatile private var loading = false
    @Volatile private var stopRequested = false
    @Volatile private var openFailed = false
    @Volatile private var lastHttpStatus: Int? = null
    /** Échec de la couche TLS (négociation, certificat) pendant l'ouverture */
    @Volatile private var tlsFailed = false
    @Volatile private var decoderFailureReported = false
    /** Incremented by every play/stop: a deferred failure check is dropped if another load started since. */
    @Volatile private var loadGeneration = 0

    private var lastTimePosEmit = 0L

    /** Entre onStop et onResume : aucun flux ne s'ouvre, les demandes attendent le retour. */
    private var inBackground = false
    /** Ce qui repart au retour au premier plan (flux fermé par onBackground, ou lecture demandée entre-temps). */
    private var backgroundResume: LoadRequest? = null

    // Appel, Assistant, autre app, écouteurs débranchés (fil principal)
    private val focusPolicy = AudioFocusPolicy()
    private val interruptions = AudioInterruptions(
        activity, main, pauseWhenNoisy,
        onFocusLoss = ::onFocusLoss,
        onFocusGain = ::onFocusGain,
        onBecomingNoisy = ::onBecomingNoisy,
    )

    // Assistant, boutons du casque, touches média non traitées par la page (fil principal)
    private val mediaSession = PlayerMediaSession(activity, main, object : PlayerMediaSession.Commands {
        override fun onPlayCommand() {
            if (currentUrl != null) setPaused(false)
        }

        override fun onPauseCommand() {
            if (currentUrl != null) setPaused(true)
        }

        override fun onSeekCommand(positionMs: Long) {
            val target = MediaSessionPolicy.seekTarget(sessionKind(), positionMs, mpv?.getPropertyDouble("duration") ?: 0.0)
            if (currentUrl != null && target != null) seek(target, relative = false)
        }

        override fun onStepCommand(forward: Boolean) {
            if (currentUrl == null || sessionKind() != MediaSessionPolicy.Kind.VOD) return
            val step = MediaSessionPolicy.SEEK_STEP_SECONDS
            seek(if (forward) step else -step, relative = true)
        }

        // Direct : c'est l'interface qui connaît la catégorie et choisit la chaîne voisine
        override fun onSkipCommand(next: Boolean) {
            if (currentUrl == null || sessionKind() != MediaSessionPolicy.Kind.LIVE) return
            emit("mediaCommand", JSObject().apply { put("action", if (next) "next" else "previous") })
        }
    })

    // Dolby Vision profile 5 has no HDR10/SDR base layer: decoded by MediaCodec it shows green/purple
    // colours. Software decoding + gpu-next lets libplacebo apply the DV reshaping, if the CPU keeps up.
    /** Main thread. vo applied when the surface exists (surfaceCreated). */
    private var videoOutput = DEFAULT_VO
    private var dolbyVisionMode = false

    // ---- Fluidité (toute vidéo) : l'appareil suit-il ? ------------------------------------
    // Chromecast : un Dolby Vision 5 en 4K décodé au processeur faisait ralentir image ET son
    // (coupures du son), avec peu d'images « perdues ». Trois signaux : images perdues, vidéo qui avance
    // moins vite que l'horloge, son qui décroche. Le lecteur prévient sans arrêter (l'utilisateur choisit).
    /** Incrémenté à chaque surveillance lancée : une surveillance plus ancienne s'arrête d'elle-même. */
    private var smoothnessToken = 0
    /** Mise en mémoire tampon ou saut pendant la fenêtre : on ne juge pas l'appareil sur le réseau. */
    @Volatile private var stalledInWindow = false
    /** Son qui décroche (« Audio device underrun », désynchronisation), compté sur le fil de libmpv. */
    private val audioTrouble = AtomicInteger(0)
    /** Un seul avertissement par fichier. */
    private var tooSlowReported = false
    private val slowFormats by lazy { activity.getSharedPreferences(SLOW_PREFS, Context.MODE_PRIVATE) }

    /** Ce que fait le lecteur, relu au lancement suivant si l'app a été tuée entre-temps (ExitReports) */
    private val playerMark by lazy { PlayerMark.prefs(activity) }

    /** Regroupement des messages de log identiques (thread d'événements libmpv uniquement) */
    private val logRepeats = LogRepeatFilter()

    override fun play(url: String, startSeconds: Double, userAgent: String?) {
        val lib = ensureMpv(userAgent ?: DEFAULT_USER_AGENT)
        // Retenté aussi pour un flux http : il peut rediriger vers https
        val verifiable = ensureCertificates(lib)
        if (PlaybackPolicy.isHttps(url) && !verifiable) {
            refuseUnverifiedHttps(url)
            return
        }
        val request = LoadRequest(url, startSeconds, paused = false)
        if (inBackground) {
            // Relance automatique ou zap arrivé pendant l'arrière-plan : ouvrir le flux ferait jouer
            // le son sans image et occuperait une connexion du fournisseur. Il s'ouvrira au retour.
            backgroundResume = request
            StreamDiagnostics.log(id, "play ${StreamDiagnostics.describeUrl(url)} deferred until foreground")
            return
        }
        backgroundResume = null
        StreamDiagnostics.log(id, "play ${StreamDiagnostics.describeUrl(url)} start=${startSeconds}s")
        requestLoad(request)
    }

    private fun requestLoad(request: LoadRequest) {
        loadGeneration++
        restoreDecodingDefaults()
        stopRequested = false
        openFailed = false
        lastHttpStatus = null
        tlsFailed = false
        currentUrl = request.url
        // Un FILE_LOADED en retard du flux précédent ne doit pas marquer celui-ci « en lecture »
        fileLoaded = false
        PlayerMark.opening(playerMark, StreamDiagnostics.describeUrl(request.url), System.currentTimeMillis())
        val effective = withAudioFocus(request)
        interruptions.watchNoisy()
        setVideoLayerVisible(true)
        if (surfaceReady) load(effective) else pendingLoad = effective
        refreshMediaSession()
    }

    /** Pendant un appel, le flux s'ouvre en pause et démarre quand Android rend le son. */
    private fun withAudioFocus(request: LoadRequest): LoadRequest {
        if (request.paused) {
            focusPolicy.reset()
            return request
        }
        val action = focusPolicy.onPlayRequested(interruptions.requestFocus(), SystemClock.elapsedRealtime())
        if (action != AudioFocusPolicy.Action.PAUSE) return request
        StreamDiagnostics.log(id, "audio focus delayed (call in progress): opened paused")
        return request.copy(paused = true)
    }

    private fun load(request: LoadRequest) {
        val lib = mpv ?: return
        // `start` as an option (not loadfile's per-file options): same syntax on every mpv version
        lib.setOptionString("start", if (request.startSeconds > 0) request.startSeconds.toString() else "none")
        lib.setPropertyBoolean("pause", request.paused)
        lastLoad = request
        fileLoaded = false
        lib.command(arrayOf("loadfile", request.url, "replace"))
    }

    /**
     * Certificats de confiance donnés à libmpv. Un export raté au démarrage est retenté ici à chaque
     * lecture : la vérification reste active dans tous les cas. Un flux
     * HTTP redirigé vers HTTPS sans certificats échoue aussi (vérification sans aucune autorité), avec
     * le même message ([reportLoadFailure]).
     */
    private fun ensureCertificates(lib: MPVLib): Boolean {
        if (caFile != null) return true
        val file = SystemCaBundle.ensure(activity) ?: return false
        lib.setOptionString("tls-ca-file", file.absolutePath)
        caFile = file
        return true
    }

    /**
     * Flux HTTPS sans certificats pour le vérifier : refusé avec un message clair au lieu d'être lu
     * sans vérification. Les flux HTTP ne sont pas concernés.
     */
    private fun refuseUnverifiedHttps(url: String) {
        stop()
        StreamDiagnostics.warn(id, "play ${StreamDiagnostics.describeUrl(url)} refused: system CA bundle unavailable, HTTPS not verifiable")
        main.post { emit("error", errorPayload(id, PlaybackPolicy.TLS_CA_UNAVAILABLE)) }
    }

    override fun stop() {
        loadGeneration++
        stopRequested = true
        pendingLoad = null
        currentUrl = null
        backgroundResume = null
        focusPolicy.reset()
        interruptions.release()
        mediaSession.deactivate()
        surfaceView?.keepScreenOn = false
        mpv?.command(arrayOf("stop"))
        PlayerMark.clear(playerMark)
        setVideoMargins(0.0, 0.0, 0.0, 0.0)
        setVideoLayerVisible(false)
    }

    override fun setPaused(paused: Boolean) {
        if (inBackground) {
            backgroundResume?.let { backgroundResume = it.copy(paused = paused) }
            return
        }
        if (paused) {
            focusPolicy.reset()
        } else if (currentUrl != null &&
            focusPolicy.onPlayRequested(interruptions.requestFocus(), SystemClock.elapsedRealtime()) == AudioFocusPolicy.Action.PAUSE
        ) {
            // Appel en cours : la lecture partira à la fin de l'appel, l'interface reste sur « pause »
            emitProp("pause", true)
            return
        }
        pendingLoad?.let { pendingLoad = it.copy(paused = paused) }
        mpv?.setPropertyBoolean("pause", paused)
    }

    override fun seek(seconds: Double, relative: Boolean) {
        mpv?.command(arrayOf("seek", seconds.toString(), if (relative) "relative" else "absolute"))
    }

    override fun setVolume(value: Double) {
        mpv?.setPropertyDouble("volume", PlayerSettings.volume(value))
    }

    override fun setMuted(value: Boolean) {
        mpv?.setPropertyBoolean("mute", value)
    }

    override fun setSpeed(speed: Double) {
        mpv?.setPropertyDouble("speed", PlayerSettings.speed(speed))
    }

    override fun selectTrack(type: String, id: Int) {
        mpv?.setPropertyString(PlayerSettings.trackProperty(type), PlayerSettings.trackValue(id))
    }

    override fun setResizeMode(mode: String) {
        val lib = mpv ?: return
        val resize = PlayerSettings.resize(mode)
        lib.setPropertyString("keepaspect", resize.keepAspect)
        lib.setPropertyDouble("panscan", resize.panscan)
    }

    override fun setVideoMargins(left: Double, right: Double, top: Double, bottom: Double) {
        val lib = mpv ?: return
        lib.setPropertyDouble("video-margin-ratio-left", left)
        lib.setPropertyDouble("video-margin-ratio-right", right)
        lib.setPropertyDouble("video-margin-ratio-top", top)
        lib.setPropertyDouble("video-margin-ratio-bottom", bottom)
    }

    override fun setSubtitleScale(scale: Double) {
        mpv?.setPropertyDouble("sub-scale", PlayerSettings.subtitleScale(scale))
    }

    override fun getProperty(name: String): Any? {
        val raw = mpv?.getPropertyString(name) ?: return null
        return convert(name, raw)
    }

    override fun onBackground() {
        // Deuxième onStop sans onResume : le flux est déjà fermé, la reprise déjà mémorisée
        if (inBackground) return
        inBackground = true
        val lib = mpv
        val url = currentUrl
        val opening = lastLoad?.takeIf { !fileLoaded && it.url == url }
        // Surface pas encore prête, ou flux pas encore ouvert (durée inconnue) : la demande est
        // reprise telle quelle, avec sa position de reprise
        val resume = pendingLoad ?: opening ?: if (lib != null && url != null) {
            val duration = lib.getPropertyDouble("duration") ?: 0.0
            val position = lib.getPropertyDouble("time-pos") ?: 0.0
            LoadRequest(url, if (PlaybackPolicy.isLive(url, duration)) 0.0 else position, paused = lib.getPropertyBoolean("pause") ?: false)
        } else null
        // Mis en pause par un appel (et non par l'utilisateur) : repart au retour
        val systemPaused = focusPolicy.resumePending
        focusPolicy.reset()
        interruptions.release()
        mediaSession.deactivate()
        surfaceView?.keepScreenOn = false
        if (resume == null) return
        pendingLoad = null
        backgroundResume = if (systemPaused) resume.copy(paused = false) else resume
        loadGeneration++
        stopRequested = true
        lib?.command(arrayOf("stop"))
        PlayerMark.clear(playerMark)
        StreamDiagnostics.log(id, "background: stream closed (resume at ${resume.startSeconds}s)")
    }

    override fun onForeground() {
        // onResume sans onStop (fenêtre par-dessus l'app) : rien n'a été fermé
        if (!inBackground) return
        inBackground = false
        val request = backgroundResume ?: return
        backgroundResume = null
        requestLoad(request)
        StreamDiagnostics.log(id, "foreground: stream reopened (start=${request.startSeconds}s)")
    }

    // ---- Interruptions du son (fil principal) ---------------------------

    private fun isPlaying(): Boolean =
        pendingLoad?.let { !it.paused } ?: (mpv?.getPropertyBoolean("pause") == false)

    private fun pauseForSystem() {
        pendingLoad?.let { pendingLoad = it.copy(paused = true) }
        mpv?.setPropertyBoolean("pause", true)
    }

    private fun onFocusLoss(transient: Boolean) {
        if (inBackground || currentUrl == null) return
        val action = focusPolicy.onLoss(transient, isPlaying(), SystemClock.elapsedRealtime())
        if (action != AudioFocusPolicy.Action.PAUSE) return
        pauseForSystem()
        StreamDiagnostics.log(id, "audio focus lost (transient=$transient): paused")
    }

    private fun onFocusGain() {
        if (inBackground) return
        val url = currentUrl ?: return
        val pending = pendingLoad
        // Direct une fois le flux ouvert (pendant l'ouverture, on ne sait pas) ; un film sans durée n'en est pas un
        val live = pending == null && !loading && PlaybackPolicy.isLive(url, mpv?.getPropertyDouble("duration") ?: 0.0)
        when (focusPolicy.onGain(live, SystemClock.elapsedRealtime())) {
            AudioFocusPolicy.Action.RESUME -> {
                if (pending != null) pendingLoad = pending.copy(paused = false)
                else mpv?.setPropertyBoolean("pause", false)
                StreamDiagnostics.log(id, "audio focus regained: resumed")
            }
            AudioFocusPolicy.Action.RELOAD_LIVE -> {
                requestLoad(LoadRequest(url, 0.0, paused = false))
                StreamDiagnostics.log(id, "audio focus regained: live reopened at the live edge")
            }
            else -> Unit
        }
    }

    /** Écouteurs débranchés : pause, sans reprise automatique (le son partirait sur le haut-parleur). */
    private fun onBecomingNoisy() {
        if (inBackground || currentUrl == null || !isPlaying()) return
        focusPolicy.reset()
        pauseForSystem()
        StreamDiagnostics.log(id, "audio output unplugged: paused")
    }

    // ---- MediaSession (fil principal) -----------------------------------

    /** Direct, film, ou flux en cours d'ouverture (on ne sait pas encore). */
    private fun sessionKind(): MediaSessionPolicy.Kind =
        MediaSessionPolicy.kind(fileLoaded && pendingLoad == null, mpv?.getPropertyDouble("duration") ?: 0.0, currentUrl.orEmpty())

    /** État annoncé à Android : suit la pause, la mise en tampon, la position et la vitesse. */
    private fun refreshMediaSession() {
        val lib = mpv
        if (inBackground || currentUrl == null || lib == null) {
            surfaceView?.keepScreenOn = false
            mediaSession.deactivate()
            return
        }
        val pending = pendingLoad
        val opening = pending != null || !fileLoaded
        val paused = pending?.paused ?: (lib.getPropertyBoolean("pause") ?: false)
        // Allumé pendant la lecture, éteint normalement pendant une pause
        surfaceView?.keepScreenOn = !paused
        mediaSession.update(
            kind = sessionKind(),
            paused = paused,
            buffering = opening || lib.getPropertyBoolean("paused-for-cache") == true,
            timePos = lib.getPropertyDouble("time-pos") ?: 0.0,
            speed = lib.getPropertyDouble("speed") ?: 1.0,
            duration = lib.getPropertyDouble("duration") ?: 0.0,
        )
    }

    override fun release() {
        loadGeneration++
        stopRequested = true
        pendingLoad = null
        currentUrl = null
        backgroundResume = null
        focusPolicy.reset()
        interruptions.release()
        mediaSession.release()
        surfaceView?.let {
            it.holder.removeCallback(this)
            (it.parent as? ViewGroup)?.removeView(it)
        }
        surfaceView = null
        surfaceReady = false
        mpv?.let {
            it.removeObserver(this)
            it.removeLogObserver(this)
            it.destroy()
        }
        mpv = null
        PlayerMark.clear(playerMark)
        webView.setBackgroundColor(APP_BACKGROUND)
        StreamDiagnostics.log(id, "released")
    }

    // ---------------------------------------------------------------------

    private fun ensureMpv(userAgent: String): MPVLib {
        mpv?.let { return it }
        // Vérifié avant de créer libmpv : un échec ici ne laisse aucune instance derrière lui
        val parent = webView.parent as? ViewGroup ?: throw IllegalStateException("WebView has no parent layout")
        val lib = MPVLib.create(activity) ?: throw IllegalStateException("libmpv could not be created")
        val view: SurfaceView
        try {
            configure(lib, userAgent)
            // No background on a SurfaceView: it would be drawn over the video
            view = SurfaceView(activity).apply {
                // Allumé pendant la lecture seulement (refreshMediaSession) : une longue pause laisse l'écran s'éteindre
                keepScreenOn = false
                visibility = View.GONE
                holder.addCallback(this@MpvEngine)
            }
            parent.addView(
                view,
                0,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            )
        } catch (e: Exception) {
            runCatching { lib.destroy() }
            throw e
        }

        mpv = lib
        surfaceView = view
        StreamDiagnostics.log(id, "libmpv created (hwdec=mediacodec,mediacodec-copy then software)")
        return lib
    }

    private fun configure(lib: MPVLib, userAgent: String) {
        lib.setOptionString("profile", "fast")
        TvSubtitlePolicy.subtitleMarginY(television)?.let { lib.setOptionString("sub-margin-y", it.toString()) }
        lib.setOptionString("vo", DEFAULT_VO)
        lib.setOptionString("gpu-context", "android")
        lib.setOptionString("opengl-es", "yes")
        lib.setOptionString("hwdec", DEFAULT_HWDEC)
        lib.setOptionString("hwdec-codecs", "h264,hevc,mpeg4,mpeg2video,vp8,vp9,av1")
        lib.setOptionString("ao", "audiotrack,opensles")
        lib.setOptionString("audio-set-media-role", "yes")
        // Same network behaviour as the desktop player (mpvBridge.ts)
        lib.setOptionString("user-agent", userAgent)
        lib.setOptionString("network-timeout", "30")
        lib.setOptionString("stream-lavf-o", "multiple_requests=0")
        lib.setOptionString("cache", "yes")
        val cache = cacheSizes()
        lib.setOptionString("demuxer-max-bytes", cache.forwardBytes.toString())
        lib.setOptionString("demuxer-max-back-bytes", cache.backBytes.toString())
        lib.setOptionString("keep-open", "yes")
        lib.setOptionString("ytdl", "no")
        // Comme sous Windows (mpv_guard.rs) : une liste de lecture distante ne mène jamais à un fichier local
        lib.setOptionString("load-unsafe-playlists", "no")
        lib.setOptionString("input-default-bindings", "no")
        // HTTPS: FFmpeg's mbedtls has no access to the Android trust store → export the system CAs
        // (préparé en arrière-plan au chargement du plugin, SystemCaBundle.prefetch). Vérification
        // toujours active : sans certificats, un flux HTTPS est refusé à la lecture.
        lib.setOptionString("tls-verify", "yes")
        val bundle = SystemCaBundle.ensure(activity)
        if (bundle != null) {
            lib.setOptionString("tls-ca-file", bundle.absolutePath)
            caFile = bundle
        } else {
            StreamDiagnostics.warn(id, "system CA bundle unavailable: HTTPS streams refused until it is exported")
        }

        lib.init()

        lib.setOptionString("save-position-on-quit", "no")
        lib.setOptionString("force-window", "no")
        lib.setOptionString("idle", "yes")

        lib.addObserver(this)
        lib.addLogObserver(this)
        for ((property, format) in OBSERVED) lib.observeProperty(property, format)
    }

    /** Cache réduit sur un appareil à peu de mémoire (Chromecast 2 Go). */
    private fun cacheSizes(): PlaybackPolicy.CacheSizes {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val info = ActivityManager.MemoryInfo()
        am?.getMemoryInfo(info)
        val sizes = PlaybackPolicy.cacheSizes(if (am != null) info.totalMem else 0L, am?.isLowRamDevice == true)
        StreamDiagnostics.log(id, "demuxer cache ${sizes.forwardBytes / MIB}+${sizes.backBytes / MIB} MiB (RAM ${info.totalMem / MIB} MiB)")
        return sizes
    }

    private fun setVideoLayerVisible(visible: Boolean) {
        surfaceView?.visibility = if (visible) View.VISIBLE else View.GONE
        webView.setBackgroundColor(if (visible) Color.TRANSPARENT else APP_BACKGROUND)
    }

    // ---- Surface (main thread) ------------------------------------------

    override fun surfaceCreated(holder: SurfaceHolder) {
        val lib = mpv ?: return
        lib.attachSurface(holder.surface)
        lib.setOptionString("force-window", "yes")
        surfaceReady = true
        lib.setPropertyString("vo", videoOutput)
        val request = pendingLoad
        pendingLoad = null
        if (request != null) load(request)
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        mpv?.setPropertyString("android-surface-size", "${width}x$height")
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        val lib = mpv ?: return
        surfaceReady = false
        lib.setPropertyString("vo", "null")
        lib.setPropertyString("force-window", "no")
        lib.detachSurface()
    }

    // ---- libmpv events (native thread) ----------------------------------

    override fun eventProperty(property: String) {
        if (property == "track-list") {
            main.post { logTracks() }
            // Change signal only: the JS reads the list with get_property (audio/subtitle menus and
            // preferred languages on live channels, whose duration stays 0)
            emitProp(property, null)
        }
        // Unavailable while the next stream loads: forwarded like the desktop IPC does, otherwise the
        // JS keeps "end reached" from the previous (cut) stream (useLiveEndWatchdog)
        else if (property == "eof-reached") emitProp(property, null)
    }

    override fun eventProperty(property: String, value: Long) {
        emitProp(property, value)
    }

    override fun eventProperty(property: String, value: Double) {
        if (property in SESSION_PROPERTIES) main.post { refreshMediaSession() }
        if (property == "time-pos") {
            val now = SystemClock.elapsedRealtime()
            if (now - lastTimePosEmit < TIME_POS_INTERVAL_MS) return
            lastTimePosEmit = now
        }
        emitProp(property, value)
    }

    override fun eventProperty(property: String, value: Boolean) {
        if (value && (property == "paused-for-cache" || property == "seeking")) stalledInWindow = true
        if (property in SESSION_PROPERTIES) main.post { refreshMediaSession() }
        emitProp(property, value)
    }

    override fun eventProperty(property: String, value: String) {
        emitProp(property, convert(property, value))
    }

    override fun event(eventId: Int) {
        when (eventId) {
            MpvEvent.MPV_EVENT_START_FILE -> {
                loading = true
                openFailed = false
                lastHttpStatus = null
                tlsFailed = false
                decoderFailureReported = false
                main.post { lastTracksLog = ""; lastDecodingLog = ""; tooSlowReported = false }
            }
            MpvEvent.MPV_EVENT_FILE_LOADED -> {
                loading = false
                fileLoaded = true
                main.post { markPlaying(); logDecoding(); startSmoothnessCheck(SMOOTH_WARMUP_MS); refreshMediaSession() }
            }
            // Décodeur changé (Dolby Vision 5 décodé au processeur) : retenu aussi
            MpvEvent.MPV_EVENT_VIDEO_RECONFIG -> main.post { markPlaying(); logDecoding() }
            MpvEvent.MPV_EVENT_END_FILE -> {
                val wasLoading = loading && !stopRequested
                loading = false
                if (wasLoading) {
                    // mpv delivers log messages through a separate buffer: "Failed to open" / "HTTP error"
                    // can arrive just after END_FILE. Decide once they had time to come in.
                    val generation = loadGeneration
                    main.postDelayed({ reportLoadFailure(generation) }, LATE_LOG_GRACE_MS)
                }
            }
        }
    }

    /** Main thread. Ignored if the user stopped or another load started meanwhile (START_FILE resets the flags). */
    private fun reportLoadFailure(generation: Int) {
        if (generation != loadGeneration || stopRequested) return
        // Plus rien ne s'ouvre, même quand l'échec n'est pas signalé ci-dessous
        PlayerMark.clear(playerMark)
        val code = PlaybackPolicy.loadFailureCode(tlsFailed, certificatesAvailable = caFile != null)
        if (!openFailed && lastHttpStatus == null && code == PlaybackPolicy.LOAD_FAILED) return
        // Pas de certificats : le code HTTP d'une redirection n'explique pas l'échec
        val status = lastHttpStatus.takeIf { code == PlaybackPolicy.LOAD_FAILED }
        // Rien à rouvrir au retour de l'arrière-plan : c'est l'écran d'erreur (relance espacée) qui décide
        currentUrl = null
        mediaSession.deactivate()
        surfaceView?.keepScreenOn = false
        StreamDiagnostics.warn(id, "load failed" + (status?.let { " http=$it" } ?: "") +
            if (code == PlaybackPolicy.TLS_CA_UNAVAILABLE) ": HTTPS not verifiable (system CA bundle unavailable)" else "")
        emit("error", errorPayload(id, code, status))
    }

    override fun logMessage(prefix: String, level: Int, text: String) {
        val line = text.trimEnd()
        MpvLogPolicy.httpErrorStatus(line)?.let { lastHttpStatus = it }
        MpvLogPolicy.serverReturnedStatus(line)?.let { lastHttpStatus = lastHttpStatus ?: it }
        if (MpvLogPolicy.isOpenFailure(line)) openFailed = true
        if (level <= MpvLogLevel.MPV_LOG_LEVEL_WARN && PlaybackPolicy.isTlsFailure(line)) tlsFailed = true
        if (MpvLogPolicy.isAudioTrouble(line)) audioTrouble.incrementAndGet()
        // No decoder at all (hardware and FFmpeg software both failed): tell the UI once per file
        val failedCodec = MpvLogPolicy.decoderFailureCodec(line)
        if (failedCodec != null && !decoderFailureReported && !stopRequested) {
            decoderFailureReported = true
            main.post { emit("error", errorPayload(id, "NO_DECODER", detail = failedCodec)) }
        }

        val forward = level <= MpvLogLevel.MPV_LOG_LEVEL_WARN ||
            (level <= MpvLogLevel.MPV_LOG_LEVEL_INFO && prefix in INFO_PREFIXES)
        if (forward) forwardLog(prefix, line)
    }

    /** Thread d'événements libmpv. Les messages identiques (chiffres mis à part) sont regroupés (LogRepeatFilter). */
    private fun forwardLog(prefix: String, line: String) {
        logRepeats.admit(prefix, line, SystemClock.elapsedRealtime())?.let { StreamDiagnostics.log(id, it) }
    }

    // ---------------------------------------------------------------------

    private fun emitProp(name: String, value: Any?) {
        main.post {
            emit("property", JSObject().apply {
                put("name", name)
                put("data", value ?: JSONObject.NULL)
            })
        }
    }

    /** mpv string values → the JSON types the desktop IPC delivers. */
    private fun convert(name: String, raw: String): Any? = when {
        name in FLAG_PROPERTIES -> raw == "yes"
        name == "aid" || name == "sid" -> raw.toIntOrNull() ?: false
        name in STRING_PROPERTIES -> raw
        raw.startsWith("{") -> runCatching { JSONObject(raw) }.getOrDefault(raw)
        raw.startsWith("[") -> runCatching { JSONArray(raw) }.getOrDefault(raw)
        else -> raw.toDoubleOrNull() ?: raw
    }

    // track-list and VIDEO_RECONFIG fire repeatedly (HLS variants, surface changes): log changes only
    private var lastTracksLog = ""
    private var lastDecodingLog = ""

    private fun logTracks() {
        val json = mpv?.getPropertyString("track-list") ?: return
        if (json == lastTracksLog) return
        lastTracksLog = json
        val tracks = runCatching { JSONArray(json) }.getOrNull() ?: return
        for (i in 0 until tracks.length()) {
            val t = tracks.optJSONObject(i) ?: continue
            val parts = mutableListOf(
                "track ${t.optString("type")} #${t.optInt("id")}",
                t.optString("codec"),
                t.optString("codec-desc").ifBlank { null },
                t.optString("codec-profile").ifBlank { null },
            )
            val dvProfile = t.optInt("dolby-vision-profile", 0)
            if (dvProfile > 0) parts += "Dolby Vision $dvProfile"
            if (t.optInt("demux-w") > 0) parts += "${t.optInt("demux-w")}x${t.optInt("demux-h")}"
            if (t.optDouble("demux-fps", 0.0) > 0) parts += "%.0f fps".format(t.optDouble("demux-fps"))
            if (t.optInt("demux-channel-count") > 0) parts += "${t.optInt("demux-channel-count")} ch"
            if (t.optBoolean("selected")) parts += "selected"
            StreamDiagnostics.log(id, parts.filterNotNull().joinToString(" · "))

            if (t.optString("type") == "video" && t.optBoolean("selected") && dvProfile == 5) {
                enterDolbyVisionMode("Dolby Vision 5 · ${t.optInt("demux-w")}x${t.optInt("demux-h")}")
            }
        }
    }

    // ---- Dolby Vision profile 5 (main thread) ----------------------------

    private fun enterDolbyVisionMode(detail: String) {
        val lib = mpv ?: return
        if (dolbyVisionMode || stopRequested) return
        dolbyVisionMode = true
        StreamDiagnostics.log(id, "$detail: software decoding + gpu-next (Dolby Vision reshaping)")
        // Read when the decoder is re-created by the hwdec change: skipping deblocking on
        // non-reference frames is a large HEVC speedup with little visible loss
        lib.setPropertyString("vd-lavc-skiploopfilter", "nonref")
        lib.setPropertyString("hwdec", "no")
        setVideoOutput(DOLBY_VISION_VO)
        // Décodeur recréé : la surveillance repart après son temps de mise en route
        startSmoothnessCheck(DV_WARMUP_MS)
    }

    private fun restoreDecodingDefaults() {
        if (!dolbyVisionMode) return
        dolbyVisionMode = false
        mpv?.let {
            it.setPropertyString("vd-lavc-skiploopfilter", "default")
            it.setPropertyString("hwdec", DEFAULT_HWDEC)
        }
        setVideoOutput(DEFAULT_VO)
    }

    private fun setVideoOutput(vo: String) {
        videoOutput = vo
        // Without a surface the option is applied by surfaceCreated
        if (surfaceReady) mpv?.setPropertyString("vo", vo)
    }

    /** Main thread. Démarre (ou relance) la surveillance de fluidité du fichier en cours. */
    private fun startSmoothnessCheck(delayMs: Long) {
        val token = ++smoothnessToken
        scheduleSmoothnessCheck(token, loadGeneration, previous = null, badWindows = 0, delayMs = delayMs)
    }

    /**
     * Fenêtres de SMOOTH_CHECK_INTERVAL_MS, jugées seulement en lecture continue (ni pause, ni mise en
     * tampon, ni saut). Règles : SmoothnessPolicy.
     */
    private fun scheduleSmoothnessCheck(token: Int, generation: Int, previous: SmoothnessPolicy.Sample?, badWindows: Int, delayMs: Long) {
        main.postDelayed({
            if (token != smoothnessToken || generation != loadGeneration || stopRequested || tooSlowReported) return@postDelayed
            val lib = mpv ?: return@postDelayed
            val stalled = stalledInWindow
            stalledInWindow = false
            val playing = !stalled && lib.getPropertyBoolean("pause") == false &&
                lib.getPropertyBoolean("paused-for-cache") != true &&
                lib.getPropertyBoolean("seeking") != true
            val drops = (lib.getPropertyInt("frame-drop-count") ?: 0).toLong() +
                (lib.getPropertyInt("decoder-frame-drop-count") ?: 0).toLong()
            val sample = SmoothnessPolicy.Sample(
                drops, lib.getPropertyDouble("time-pos") ?: 0.0, SystemClock.elapsedRealtime(), audioTrouble.get(), playing,
            )

            var bad = badWindows
            val window = SmoothnessPolicy.judge(
                previous, sample, lib.getPropertyDouble("speed"), lib.getPropertyDouble("container-fps"),
            )
            if (window != null) {
                bad = SmoothnessPolicy.badWindowsAfter(window, bad)
                StreamDiagnostics.log(
                    id,
                    "smoothness: video at %.0f %% of real time, %.0f %% frames dropped, audio trouble %d"
                        .format(window.progress * 100, window.dropRatio * 100, window.audioTrouble),
                )
                if (SmoothnessPolicy.tooSlow(bad)) {
                    reportTooSlow(known = false)
                    return@postDelayed
                }
            }
            scheduleSmoothnessCheck(token, generation, sample, bad, SMOOTH_CHECK_INTERVAL_MS)
        }, delayMs)
    }

    /** Format décodé en cours, sans adresse : « hevc|2160|sw|dv5 ». Clé de la mémoire de cet appareil. */
    private fun formatSignature(): String? {
        val lib = mpv ?: return null
        val codec = lib.getPropertyString("video-format") ?: return null
        return SmoothnessPolicy.formatSignature(
            codec, lib.getPropertyInt("height") ?: 0, lib.getPropertyString("hwdec-current"), dolbyVisionMode,
        )
    }

    /** Détail lisible du message : « HEVC · 3840x1920 · Dolby Vision 5 · software ». */
    private fun formatDetail(): String {
        val lib = mpv ?: return ""
        return SmoothnessPolicy.formatDetail(
            lib.getPropertyString("video-format"), lib.getPropertyInt("width"), lib.getPropertyInt("height"),
            lib.getPropertyString("hwdec-current"), dolbyVisionMode,
        )
    }

    /**
     * Main thread. Prévient l'interface, sans arrêter la lecture (« Arrêter » ou « Continuer quand
     * même »), et retient le format sur cet appareil pour prévenir dès le début la prochaine fois.
     */
    private fun reportTooSlow(known: Boolean) {
        if (tooSlowReported || stopRequested) return
        tooSlowReported = true
        val detail = formatDetail()
        StreamDiagnostics.warn(id, "$detail: device too slow" + if (known) " (already seen on this device)" else "")
        if (!known) formatSignature()?.takeIf(SmoothnessPolicy::remembers)?.let {
            slowFormats.edit().putLong(it, System.currentTimeMillis()).apply()
        }
        emit("error", errorPayload(id, "DEVICE_TOO_SLOW", detail = detail).apply {
            put("continuable", true)
            if (known) put("known", true)
        })
    }

    /** Main thread. Flux ouvert : codec et décodeur retenus pour le rapport de fermeture (ExitReports). */
    private fun markPlaying() {
        if (stopRequested || currentUrl == null || !fileLoaded) return
        val lib = mpv ?: return
        // « hevc », « h264 » (video-codec est une phrase) ; « mediacodec », « no »…
        PlayerMark.playing(playerMark, lib.getPropertyString("video-format"), lib.getPropertyString("hwdec-current"))
    }

    private fun logDecoding() {
        val lib = mpv ?: return
        val codec = lib.getPropertyString("video-codec") ?: return
        val hwdec = lib.getPropertyString("hwdec-current") ?: "no"
        val pixfmt = lib.getPropertyString("video-params/hw-pixelformat")
            ?: lib.getPropertyString("video-params/pixelformat") ?: "?"
        val vo = lib.getPropertyString("current-vo") ?: "?"
        val summary = "video decoding: $codec · hwdec=$hwdec · pixfmt=$pixfmt · vo=$vo"
        if (summary == lastDecodingLog) return
        lastDecodingLog = summary
        StreamDiagnostics.log(id, summary)
        // Format déjà trop lourd pour cet appareil : prévenir dès le début, sans attendre les saccades
        // (décodé au processeur, retenu il y a moins de 7 jours ; sinon le souvenir est effacé)
        val signature = formatSignature() ?: return
        if (!slowFormats.contains(signature)) return
        val savedAt = runCatching { slowFormats.getLong(signature, 0L) }.getOrDefault(0L)
        if (SmoothnessPolicy.remembers(signature) && SmoothnessPolicy.stillRemembered(savedAt, System.currentTimeMillis())) {
            reportTooSlow(known = true)
        } else {
            slowFormats.edit().remove(signature).apply()
        }
    }

    companion object {
        private const val TIME_POS_INTERVAL_MS = 250L
        private const val MIB = 1024L * 1024L
        /** Time left for log messages delivered after END_FILE (observed: a few ms) */
        private const val LATE_LOG_GRACE_MS = 500L

        private const val DEFAULT_VO = "gpu"
        private const val DEFAULT_HWDEC = "mediacodec,mediacodec-copy"
        /** gpu-next applies Dolby Vision reshaping; gpu as a fallback (wrong colours but a picture) */
        private const val DOLBY_VISION_VO = "gpu-next,gpu"
        /** Decoder re-creation + cache refill after switching to software decoding */
        private const val DV_WARMUP_MS = 5_000L
        /** Surveillance de fluidité : mise en route (cache, décodeur), puis fenêtres de 6 s */
        private const val SMOOTH_WARMUP_MS = 8_000L
        private const val SMOOTH_CHECK_INTERVAL_MS = 6_000L
        private const val SLOW_PREFS = "nyx_slow_formats"
        /** Same User-Agent as the desktop mpv (providers reject unknown clients) */
        const val DEFAULT_USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        val APP_BACKGROUND = Color.rgb(2, 10, 25)

        private val OBSERVED = listOf(
            "time-pos" to MpvFormat.MPV_FORMAT_DOUBLE,
            "duration" to MpvFormat.MPV_FORMAT_DOUBLE,
            "pause" to MpvFormat.MPV_FORMAT_FLAG,
            "paused-for-cache" to MpvFormat.MPV_FORMAT_FLAG,
            "seeking" to MpvFormat.MPV_FORMAT_FLAG,
            "core-idle" to MpvFormat.MPV_FORMAT_FLAG,
            "eof-reached" to MpvFormat.MPV_FORMAT_FLAG,
            "volume" to MpvFormat.MPV_FORMAT_DOUBLE,
            "mute" to MpvFormat.MPV_FORMAT_FLAG,
            "speed" to MpvFormat.MPV_FORMAT_DOUBLE,
            "sub-scale" to MpvFormat.MPV_FORMAT_DOUBLE,
            "aid" to MpvFormat.MPV_FORMAT_STRING,
            "sid" to MpvFormat.MPV_FORMAT_STRING,
            "track-list" to MpvFormat.MPV_FORMAT_NONE,
        )

        /** Changements qui modifient l'état annoncé par la MediaSession (position recalée après un saut) */
        private val SESSION_PROPERTIES = setOf("pause", "paused-for-cache", "seeking", "speed", "duration")

        private val FLAG_PROPERTIES = setOf("pause", "mute", "seeking", "paused-for-cache", "core-idle", "eof-reached", "idle-active")
        private val STRING_PROPERTIES = setOf("hwdec-current", "video-codec", "audio-codec-name", "filename", "media-title")
        /** Info-level mpv messages worth keeping: track list, decoder choice, demuxer */
        private val INFO_PREFIXES = setOf("cplayer", "vd", "ad", "demux")
    }
}
