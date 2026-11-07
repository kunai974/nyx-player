package com.nyxplayer.nativebridge

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class PlayArgs {
    lateinit var url: String
    var start: Double = 0.0
    var userAgent: String? = null
}

@InvokeArg
class PausedArgs {
    var paused: Boolean = false
}

@InvokeArg
class SeekArgs {
    var position: Double = 0.0
    var relative: Boolean = false
}

@InvokeArg
class VolumeArgs {
    var volume: Double = 100.0
}

@InvokeArg
class MutedArgs {
    var muted: Boolean = false
}

@InvokeArg
class SpeedArgs {
    var speed: Double = 1.0
}

@InvokeArg
class TrackArgs {
    lateinit var type: String
    var id: Int = 0
}

@InvokeArg
class ResizeArgs {
    lateinit var mode: String
}

@InvokeArg
class MarginsArgs {
    var left: Double = 0.0
    var right: Double = 0.0
    var top: Double = 0.0
    var bottom: Double = 0.0
}

@InvokeArg
class ScaleArgs {
    var scale: Double = 1.0
}

@InvokeArg
class FullscreenArgs {
    var enabled: Boolean = false
}

@InvokeArg
class PropertyArgs {
    lateinit var name: String
}

@InvokeArg
class SecureKeyArgs {
    lateinit var key: String
}

@InvokeArg
class SecureSetArgs {
    lateinit var key: String
    lateinit var value: String
}

@InvokeArg
class UpdateManifestArgs {
    lateinit var url: String
}

@InvokeArg
class UpdateDownloadArgs {
    lateinit var url: String
    lateinit var sha256: String
    var size: Long = 0
    /** Version annoncée à l'utilisateur : l'APK doit porter celle-là */
    lateinit var version: String
}

@TauriPlugin
class NyxAndroidPlugin(private val activity: Activity) : Plugin(activity) {
    private val secureStore by lazy { SecureStore(activity.applicationContext) }
    private val appUpdater by lazy { AppUpdater(activity) }
    private val exitReports by lazy { ExitReports(activity.applicationContext) }
    private val main = Handler(Looper.getMainLooper())

    private var webView: WebView? = null
    /** Video engine (libmpv), created on first playback */
    private var engine: PlayerEngine? = null
    private var fullscreen = false
    /** Entre onStop et onResume : un moteur créé pendant ce temps doit le savoir */
    private var backgrounded = false

    private val emitter: EngineEmitter = { event, payload ->
        if (Looper.myLooper() == Looper.getMainLooper()) trigger(event, payload) else main.post { trigger(event, payload) }
    }

    override fun load(webView: WebView) {
        this.webView = webView
        // Avant toute commande du lecteur : ce que la session précédente a laissé (ExitReports)
        exitReports.snapshotPreviousSession()
        // Certificats pour les flux HTTPS, prêts avant la première lecture (sans bloquer l'interface)
        SystemCaBundle.prefetch(activity)
        // APK d'une mise à jour précédente : installée ou abandonnée, il n'a plus d'usage
        // (jamais pendant un téléchargement : il écrit dans le même dossier)
        Thread {
            if (updateBusy.compareAndSet(false, true)) {
                try {
                    appUpdater.cleanUp()
                } finally {
                    updateBusy.set(false)
                }
            }
        }.start()
        // An app does not zoom: pinching used to scale the whole interface
        webView.settings.apply {
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // TV : la page se met en page sur une toile fixe (1280 px) que la WebView ajuste à
            // l'écran, pour un rendu identique sur toutes les TV (src/utils/tvScale.ts)
            if (isTelevision()) {
                useWideViewPort = true
                loadWithOverviewMode = true
            }
        }
        if (isTelevision()) holdRemoteFocusOnWebView(webView)
        fitWebViewInsideSystemBars(webView)
        activity.requestedOrientation = defaultOrientation()
    }

    /**
     * TV : la WebView garde le focus Android dès le lancement, sans cadre natif. Au premier lancement,
     * rien ne l'avait (aucun cadre sur le champ e-mail), puis la première flèche donnait le focus à la
     * WebView entière, qui s'entourait d'un cadre de sélection plein écran (Chromecast). Le cadre
     * de l'interface est dessiné par la page (tv.css) : celui du système est coupé.
     */
    private fun holdRemoteFocusOnWebView(webView: WebView) {
        webView.defaultFocusHighlightEnabled = false
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.post { webView.requestFocus() }
    }

    /**
     * Interface verrouillée en portrait sur téléphone (le paysage n'a pas de mise en page dédiée
     * hors lecteur) ; tablettes et TV gardent les deux sens. Le lecteur force le paysage.
     */
    private fun defaultOrientation(): Int {
        val config = activity.resources.configuration
        val isPhone = DevicePolicy.locksPortrait(config.smallestScreenWidthDp, isTelevision())
        return if (isPhone) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    private fun playerEngine(): PlayerEngine {
        engine?.let { return it }
        val view = webView ?: throw IllegalStateException("WebView not attached yet")
        return MpvEngine(activity, view, emitter, pauseWhenNoisy = !isTelevision(), television = isTelevision()).also {
            engine = it
            if (backgrounded) it.onBackground()
        }
    }

    /**
     * Android 15+ enforces edge-to-edge: without this the header would sit under the status bar
     * and the bottom navigation under the gesture bar. When the player hides the system bars
     * (immersive mode) the insets drop to zero and video + overlay fill the whole screen.
     *
     * The keyboard is handled the same way: edge-to-edge windows are not resized by the IME, so
     * the WebView kept its full height and bottom sheets (category search) ended up behind the
     * keyboard. Padding by the IME inset shrinks the WebView, and the page lays out above it.
     */
    private fun fitWebViewInsideSystemBars(webView: WebView) {
        val window = activity.window
        window.decorView.setBackgroundColor(APP_BACKGROUND)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        val container = webView.parent as? View ?: return
        container.setBackgroundColor(APP_BACKGROUND)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        ViewCompat.requestApplyInsets(container)
    }

    // onStop (not onPause): a dialog or multi-window over the app must not cut the stream
    override fun onStop() {
        activity.runOnUiThread {
            backgrounded = true
            engine?.onBackground()
        }
    }

    override fun onResume() {
        activity.runOnUiThread {
            backgrounded = false
            engine?.onForeground()
            if (fullscreen) applyFullscreen(true)
        }
    }

    override fun onDestroy() {
        activity.runOnUiThread {
            engine?.release()
            // Une commande reçue après ne doit pas viser un moteur libéré
            engine = null
        }
    }

    // ---- Player -----------------------------------------------------------

    @Command
    fun play(invoke: Invoke) {
        val args = invoke.parseArgs(PlayArgs::class.java)
        // Flux réseau seulement, et pas d'en-tête ajouté par la page (PlayerInputPolicy)
        if (!PlayerInputPolicy.isAllowedStreamUrl(args.url)) {
            invoke.reject("stream URL not allowed")
            return
        }
        if (!PlayerInputPolicy.isAllowedUserAgent(args.userAgent)) {
            invoke.reject("user agent not allowed")
            return
        }
        onUi(invoke) { playerEngine().play(args.url, args.start, args.userAgent) }
    }

    @Command
    fun stop(invoke: Invoke) = onUi(invoke) {
        engine?.stop()
        applyFullscreen(false)
    }

    @Command
    fun setPaused(invoke: Invoke) {
        val args = invoke.parseArgs(PausedArgs::class.java)
        onUi(invoke) { engine?.setPaused(args.paused) }
    }

    @Command
    fun seek(invoke: Invoke) {
        val args = invoke.parseArgs(SeekArgs::class.java)
        onUi(invoke) { engine?.seek(args.position, args.relative) }
    }

    @Command
    fun setVolume(invoke: Invoke) {
        val args = invoke.parseArgs(VolumeArgs::class.java)
        onUi(invoke) { engine?.setVolume(args.volume) }
    }

    @Command
    fun setMuted(invoke: Invoke) {
        val args = invoke.parseArgs(MutedArgs::class.java)
        onUi(invoke) { engine?.setMuted(args.muted) }
    }

    @Command
    fun setSpeed(invoke: Invoke) {
        val args = invoke.parseArgs(SpeedArgs::class.java)
        onUi(invoke) { engine?.setSpeed(args.speed) }
    }

    @Command
    fun selectTrack(invoke: Invoke) {
        val args = invoke.parseArgs(TrackArgs::class.java)
        onUi(invoke) { engine?.selectTrack(args.type, args.id) }
    }

    @Command
    fun setResizeMode(invoke: Invoke) {
        val args = invoke.parseArgs(ResizeArgs::class.java)
        onUi(invoke) { engine?.setResizeMode(args.mode) }
    }

    @Command
    fun setVideoMargins(invoke: Invoke) {
        val args = invoke.parseArgs(MarginsArgs::class.java)
        onUi(invoke) { engine?.setVideoMargins(args.left, args.right, args.top, args.bottom) }
    }

    @Command
    fun setSubtitleScale(invoke: Invoke) {
        val args = invoke.parseArgs(ScaleArgs::class.java)
        onUi(invoke) { engine?.setSubtitleScale(args.scale) }
    }

    @Command
    fun setFullscreen(invoke: Invoke) {
        val args = invoke.parseArgs(FullscreenArgs::class.java)
        onUi(invoke) { applyFullscreen(args.enabled) }
    }

    @Command
    fun getProperty(invoke: Invoke) {
        val args = invoke.parseArgs(PropertyArgs::class.java)
        // Propriétés de l'interface du lecteur seulement (liste fermée)
        if (!PlayerInputPolicy.isReadableProperty(args.name)) {
            invoke.reject("property not allowed")
            return
        }
        activity.runOnUiThread {
            try {
                val value = when (args.name) {
                    "fullscreen" -> fullscreen
                    "engine" -> engine?.id
                    else -> engine?.getProperty(args.name)
                }
                invoke.resolve(JSObject().apply { put("value", value ?: JSONObject.NULL) })
            } catch (e: Exception) {
                invoke.reject(e.message ?: "getProperty failed", e)
            }
        }
    }

    /** Immersive landscape while playing, like a native video app. */
    private fun applyFullscreen(enabled: Boolean) {
        val window = activity.window
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        if (enabled) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = defaultOrientation()
        }
        fullscreen = enabled
        emitter("property", JSObject().apply {
            put("name", "fullscreen")
            put("data", enabled)
        })
    }

    // ---- Appareil ---------------------------------------------------------

    /**
     * Type d'appareil : le même APK sert au téléphone et à la TV. Le front-end en déduit
     * la couche d'interface à activer (mobile tactile ou TV à la télécommande).
     */
    private fun isTelevision(): Boolean {
        val uiMode = activity.resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
        val packageManager = activity.packageManager
        return uiMode == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            packageManager.hasSystemFeature("android.hardware.type.television")
    }

    @Command
    fun deviceInfo(invoke: Invoke) {
        val config = activity.resources.configuration
        val hasTouch = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
        invoke.resolve(JSObject().apply {
            put("isTv", isTelevision())
            put("hasTouchscreen", hasTouch)
            put("smallestWidthDp", config.smallestScreenWidthDp)
        })
    }

    /**
     * Dernière fermeture anormale de l'app (plantage natif ou Java, app figée, app tuée pendant une
     * lecture), rendue une seule fois au lancement suivant ; `report` vaut null sinon. Envoyée à
     * Sentry par la page (services/androidExitReport.ts). Lecture du disque hors du fil de l'interface.
     */
    @Command
    fun lastExitReport(invoke: Invoke) {
        Thread {
            val report = try {
                exitReports.takeLastReport()
            } catch (e: Exception) {
                StreamDiagnostics.warn("app", "exit report failed: ${e.javaClass.simpleName}")
                null
            }
            invoke.resolve(JSObject().apply { put("report", report?.let(::exitReportJson) ?: JSONObject.NULL) })
        }.start()
    }

    /** Retour à la racine : la sortie qui suit n'est pas une panne (ExitReportPolicy.REQUESTED_EXIT_WINDOW_MS). */
    @Command
    fun noteExitRequested(invoke: Invoke) {
        try {
            exitReports.noteExitRequested(System.currentTimeMillis())
        } catch (e: Exception) {
            StreamDiagnostics.warn("app", "exit note failed: ${e.javaClass.simpleName}")
        }
        invoke.resolve()
    }

    private fun exitReportJson(report: ExitReportPolicy.Report): JSObject = JSObject().apply {
        put("reason", report.reason)
        put("status", report.status)
        put("foreground", report.foreground)
        put("timestamp", report.timestampMs)
        put("description", report.description ?: JSONObject.NULL)
        put("pssKb", report.pssKb)
        put("rssKb", report.rssKb)
        put("television", isTelevision())
        put("player", report.player?.let {
            JSObject().apply {
                put("kind", it.kind)
                put("extension", it.extension)
                put("phase", it.phase)
                put("codec", it.codec ?: JSONObject.NULL)
                put("hwdec", it.hwdec ?: JSONObject.NULL)
            }
        } ?: JSONObject.NULL)
    }

    // ---- Réseau -----------------------------------------------------------

    /** Type de connexion, pour ne pas télécharger l'EPG sur des données mobiles limitées (DevicePolicy). */
    @Command
    fun networkStatus(invoke: Invoke) {
        val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val network = manager?.activeNetwork
        val capabilities = network?.let { manager.getNetworkCapabilities(it) }
        val status = DevicePolicy.networkStatus(capabilities?.let {
            DevicePolicy.Capabilities(
                internet = it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                notMetered = it.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
                wifi = it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                cellular = it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                ethernet = it.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
            )
        })
        invoke.resolve(JSObject().apply {
            put("connected", status.connected)
            put("metered", status.metered)
            put("type", status.type)
        })
    }

    // ---- Mise à jour de l'app (AppUpdater) ---------------------------------

    @Command
    fun updateInfo(invoke: Invoke) {
        try {
            val info = appUpdater.info()
            invoke.resolve(JSObject().apply {
                put("packageName", info.packageName)
                put("versionName", info.versionName)
                put("abi", info.abi ?: JSONObject.NULL)
            })
        } catch (e: Exception) {
            invoke.reject(e.message ?: "updateInfo failed", e)
        }
    }

    /** Réseau hors du fil de l'interface ; échecs prévus rendus en { ok: false }, jamais levés */
    @Command
    fun fetchUpdateManifest(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateManifestArgs::class.java)
        Thread {
            val text = try {
                appUpdater.fetchManifest(args.url)
            } catch (e: Exception) {
                null
            }
            invoke.resolve(JSObject().apply {
                put("ok", text != null)
                if (text != null) put("text", text) else put("code", "network")
            })
        }.start()
    }

    @Command
    fun downloadUpdate(invoke: Invoke) {
        val args = invoke.parseArgs(UpdateDownloadArgs::class.java)
        if (!updateBusy.compareAndSet(false, true)) {
            invoke.resolve(JSObject().apply { put("ok", false); put("code", "install") })
            return
        }
        Thread {
            val failure = try {
                appUpdater.download(args.url, args.sha256, args.size, args.version) { downloaded, total ->
                    emitter("updateProgress", JSObject().apply {
                        put("downloaded", downloaded)
                        put("total", total)
                    })
                }
            } catch (e: Exception) {
                "network"
            } finally {
                updateBusy.set(false)
            }
            invoke.resolve(JSObject().apply {
                put("ok", failure == null)
                if (failure != null) put("code", failure)
            })
        }.start()
    }

    /** Avant le téléchargement : { granted } ; faux = écran « applis inconnues » ouvert pour Nyx */
    @Command
    fun requestInstallPermission(invoke: Invoke) {
        activity.runOnUiThread {
            val granted = try {
                appUpdater.requestInstallPermission()
            } catch (e: Exception) {
                true
            }
            invoke.resolve(JSObject().apply { put("granted", granted) })
        }
    }

    @Command
    fun installUpdate(invoke: Invoke) {
        activity.runOnUiThread {
            val result = try {
                appUpdater.install()
            } catch (e: Exception) {
                "install"
            }
            invoke.resolve(JSObject().apply {
                when (result) {
                    null -> { put("ok", true); put("step", "installer") }
                    "permission" -> { put("ok", true); put("step", "permission") }
                    else -> { put("ok", false); put("code", result) }
                }
            })
        }
    }

    // ---- Secure storage ---------------------------------------------------

    @Command
    fun secureGet(invoke: Invoke) {
        val args = invoke.parseArgs(SecureKeyArgs::class.java)
        try {
            val value = secureStore.get(args.key)
            invoke.resolve(JSObject().apply { put("value", value ?: JSONObject.NULL) })
        } catch (e: Exception) {
            invoke.reject(e.message ?: "secureGet failed", e)
        }
    }

    @Command
    fun secureSet(invoke: Invoke) {
        val args = invoke.parseArgs(SecureSetArgs::class.java)
        try {
            secureStore.set(args.key, args.value)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "secureSet failed", e)
        }
    }

    @Command
    fun secureDelete(invoke: Invoke) {
        val args = invoke.parseArgs(SecureKeyArgs::class.java)
        try {
            secureStore.delete(args.key)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "secureDelete failed", e)
        }
    }

    private companion object {
        val APP_BACKGROUND = Color.rgb(2, 10, 25)
        /**
         * Un seul téléchargement de mise à jour à la fois, et pas de nettoyage du dossier pendant
         * l'un d'eux. Partagé par tout le processus : une activité recréée garde le même verrou.
         */
        val updateBusy = AtomicBoolean(false)
    }

    private fun onUi(invoke: Invoke, block: () -> Unit) {
        activity.runOnUiThread {
            try {
                block()
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Player command failed", e)
            } catch (e: LinkageError) {
                // Bibliothèque native du lecteur qui ne se charge pas sur cet appareil
                // (UnsatisfiedLinkError, NoClassDefFoundError, ExceptionInInitializerError) : l'app se
                // fermait d'un coup, la page affiche maintenant l'écran d'erreur du lecteur
                // (usePlaybackSession). Les manques de mémoire (OutOfMemoryError) ne sont pas rattrapés.
                StreamDiagnostics.warn("app", "player unavailable: ${e.javaClass.simpleName}")
                invoke.reject(e.message ?: "Player unavailable", RuntimeException(e))
            }
        }
    }
}
