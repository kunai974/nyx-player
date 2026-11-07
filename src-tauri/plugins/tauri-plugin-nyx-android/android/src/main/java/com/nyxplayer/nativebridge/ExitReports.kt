package com.nyxplayer.nativebridge

import android.app.ActivityManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log

/**
 * Lecture Android de la dernière fermeture (règles : [ExitReportPolicy]) et mémoire de l'état du
 * lecteur ([PlayerMark]) qui l'accompagne.
 */
internal class ExitReports(private val context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** État du lecteur et sortie demandée laissés par la session précédente ([snapshotPreviousSession]) */
    @Volatile private var previousPlayer: ExitReportPolicy.PlayerState? = null
    @Volatile private var previousExitRequestedMs = 0L
    @Volatile private var snapshotTaken = false

    /**
     * Fil principal, au chargement du plugin, avant toute commande du lecteur : relève puis efface
     * ce que la session précédente a laissé. Fait plus tard, une lecture relancée dès le démarrage
     * verrait sa marque toute neuve effacée.
     */
    fun snapshotPreviousSession() {
        if (snapshotTaken) return
        snapshotTaken = true
        previousPlayer = PlayerMark.read(prefs)
        previousExitRequestedMs = prefs.getLong(KEY_EXIT_REQUESTED, 0L)
        PlayerMark.clear(prefs)
        if (previousExitRequestedMs > 0) prefs.edit().remove(KEY_EXIT_REQUESTED).apply()
    }

    /** L'utilisateur quitte l'app (Retour à la racine) : écrit tout de suite, la sortie suit. */
    fun noteExitRequested(nowMs: Long) {
        prefs.edit().putLong(KEY_EXIT_REQUESTED, nowMs).commit()
    }

    /**
     * Rapport de la dernière fermeture anormale, une seule fois : la date de la fermeture lue est
     * retenue, même quand rien n'est à signaler. Null avant Android 11.
     */
    fun takeLastReport(): ExitReportPolicy.Report? {
        snapshotPreviousSession()
        val player = previousPlayer
        previousPlayer = null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val exit = try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
            // Le processus principal seulement : l'historique range aussi les processus isolés de l'app
            // (moteurs de rendu de la WebView), qui meurent juste après un plantage du principal et
            // en cacheraient la vraie raison
            am.getHistoricalProcessExitReasons(context.packageName, 0, HISTORY_DEPTH)
                .firstOrNull { it.processName == context.packageName }?.let {
                ExitReportPolicy.Exit(
                    reason = it.reason,
                    status = it.status,
                    importance = it.importance,
                    timestampMs = it.timestamp,
                    description = it.description,
                    pssKb = it.pss,
                    rssKb = it.rss,
                )
            }
        } catch (e: Exception) {
            Log.w(StreamDiagnostics.TAG, "exit reasons unavailable: ${e.javaClass.simpleName}")
            null
        } ?: return null
        val lastReported = prefs.getLong(KEY_LAST_EXIT, 0L)
        if (exit.timestampMs > lastReported) prefs.edit().putLong(KEY_LAST_EXIT, exit.timestampMs).apply()
        return ExitReportPolicy.report(exit, player, lastReported, System.currentTimeMillis(), previousExitRequestedMs)
    }

    companion object {
        const val PREFS = "nyx_exit_reports"
        private const val KEY_LAST_EXIT = "last_exit_ms"
        private const val KEY_EXIT_REQUESTED = "exit_requested_ms"
        private const val HISTORY_DEPTH = 8
    }
}

/**
 * Ce que fait le lecteur, écrit à chaque étape (ouverture, lecture, arrêt) : si l'app est tuée
 * pendant une lecture, le lancement suivant sait si c'était un direct ou un film, pendant
 * l'ouverture ou la lecture, avec quel codec et quel décodeur. Jamais d'adresse : seulement le
 * type de contenu et l'extension ([StreamDiagnostics.describeUrl]).
 */
internal object PlayerMark {
    private const val KEY_KIND = "player_kind"
    private const val KEY_EXTENSION = "player_extension"
    private const val KEY_PHASE = "player_phase"
    private const val KEY_CODEC = "player_codec"
    private const val KEY_HWDEC = "player_hwdec"
    private const val KEY_SINCE = "player_since"

    const val PHASE_OPENING = "opening"
    const val PHASE_PLAYING = "playing"

    fun prefs(context: Context): SharedPreferences = context.getSharedPreferences(ExitReports.PREFS, Context.MODE_PRIVATE)

    /**
     * Flux en cours d'ouverture (`describeUrl` : « live · ts »). Écrit tout de suite (commit, fichier
     * minuscule, une fois par lecture) : un plantage dès le début de l'ouverture tuerait le
     * processus avant une écriture différée, et c'est précisément le cas recherché.
     */
    fun opening(prefs: SharedPreferences, described: String, nowMs: Long) {
        val (kind, extension) = ExitReportPolicy.kindAndExtension(described)
        prefs.edit()
            .putString(KEY_KIND, kind)
            .putString(KEY_EXTENSION, extension)
            .putString(KEY_PHASE, PHASE_OPENING)
            .remove(KEY_CODEC)
            .remove(KEY_HWDEC)
            .putLong(KEY_SINCE, nowMs)
            .commit()
    }

    /** Flux ouvert, décodeur choisi. Sans effet si aucune ouverture n'est retenue. */
    fun playing(prefs: SharedPreferences, codec: String?, hwdec: String?) {
        if (!prefs.contains(KEY_PHASE)) return
        prefs.edit()
            .putString(KEY_PHASE, PHASE_PLAYING)
            .putString(KEY_CODEC, ExitReportPolicy.safeToken(codec))
            .putString(KEY_HWDEC, ExitReportPolicy.safeToken(hwdec))
            .apply()
    }

    fun clear(prefs: SharedPreferences) {
        if (!prefs.contains(KEY_PHASE)) return
        prefs.edit()
            .remove(KEY_KIND).remove(KEY_EXTENSION).remove(KEY_PHASE)
            .remove(KEY_CODEC).remove(KEY_HWDEC).remove(KEY_SINCE)
            .apply()
    }

    fun read(prefs: SharedPreferences): ExitReportPolicy.PlayerState? {
        val phase = prefs.getString(KEY_PHASE, null) ?: return null
        return ExitReportPolicy.PlayerState(
            kind = prefs.getString(KEY_KIND, null) ?: "stream",
            extension = prefs.getString(KEY_EXTENSION, null) ?: "?",
            phase = phase,
            codec = prefs.getString(KEY_CODEC, null),
            hwdec = prefs.getString(KEY_HWDEC, null),
            sinceMs = prefs.getLong(KEY_SINCE, 0L),
        )
    }
}
