package com.nyxplayer.nativebridge

/**
 * Raison de la dernière fermeture de l'app, lue au lancement suivant (Android 11 et plus,
 * `ActivityManager.getHistoricalProcessExitReasons`). Un plantage natif (libmpv, décodeur), le moteur
 * de la page tué, ou une app figée ferment l'app sans laisser à la page le temps de prévenir Sentry :
 * c'est le seul moyen de les voir (cas d'un boîtier Google TV qui se fermait à l'ouverture d'un flux).
 *
 * Sans appel Android, pour être testé sur la JVM (ExitReportPolicyTest). Rien d'envoyé ne contient
 * d'adresse, de nom de serveur ni d'identifiant : la description du système passe par
 * [StreamDiagnostics.redact], l'état du lecteur ne garde que le type de contenu, l'extension, le
 * codec et le décodeur.
 */
internal object ExitReportPolicy {
    // Valeurs de ApplicationExitInfo.REASON_* (fixées par Android, recopiées pour les tests JVM)
    const val REASON_UNKNOWN = 0
    const val REASON_EXIT_SELF = 1
    const val REASON_SIGNALED = 2
    const val REASON_LOW_MEMORY = 3
    const val REASON_CRASH = 4
    const val REASON_CRASH_NATIVE = 5
    const val REASON_ANR = 6
    const val REASON_INITIALIZATION_FAILURE = 7
    const val REASON_PERMISSION_CHANGE = 8
    const val REASON_EXCESSIVE_RESOURCE_USAGE = 9
    const val REASON_USER_REQUESTED = 10
    const val REASON_USER_STOPPED = 11
    const val REASON_DEPENDENCY_DIED = 12
    const val REASON_OTHER = 13
    const val REASON_FREEZER = 14
    const val REASON_PACKAGE_STATE_CHANGE = 15
    const val REASON_PACKAGE_UPDATED = 16

    /**
     * ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE : à cette valeur ou en dessous
     * (premier plan 100, service de premier plan 125, visible 200), l'app était à l'écran.
     */
    const val IMPORTANCE_VISIBLE = 200

    /** Une fermeture plus ancienne n'apprend plus rien (et ne doit pas ressortir des semaines après). */
    const val MAX_AGE_MS = 3L * 24 * 60 * 60 * 1000

    /**
     * Sortie demandée par l'utilisateur (Retour à la racine, `exit(0)` de Tauri) : sur Android, elle
     * peut finir en SIGABRT pendant que la WebView tourne encore (appRestart.ts). Une fin survenue
     * dans ce délai après la demande n'est pas une panne.
     */
    const val REQUESTED_EXIT_WINDOW_MS = 10_000L

    /** Description du système : quelques mots suffisent (« crash », « Input dispatching timed out »). */
    const val MAX_DESCRIPTION_CHARS = 200

    /** Ce qu'Android a retenu de la fin du processus. */
    data class Exit(
        val reason: Int,
        /** Signal (plantage natif, processus tué) ou code de sortie */
        val status: Int,
        val importance: Int,
        val timestampMs: Long,
        val description: String?,
        /** Mémoire du processus au moment de la fin (Ko), 0 si inconnue */
        val pssKb: Long,
        val rssKb: Long,
    )

    /** Ce que faisait le lecteur (PlayerMark), sans adresse. */
    data class PlayerState(
        /** live, movie, series ou stream */
        val kind: String,
        val extension: String,
        /** opening (flux en cours d'ouverture) ou playing */
        val phase: String,
        val codec: String?,
        val hwdec: String?,
        val sinceMs: Long,
    )

    data class Report(
        val reason: String,
        val status: Int,
        val foreground: Boolean,
        val timestampMs: Long,
        val description: String?,
        val pssKb: Long,
        val rssKb: Long,
        /** null : aucune lecture en cours au moment de la fermeture */
        val player: PlayerState?,
    )

    fun reasonName(reason: Int): String = when (reason) {
        REASON_EXIT_SELF -> "exit_self"
        REASON_SIGNALED -> "signaled"
        REASON_LOW_MEMORY -> "low_memory"
        REASON_CRASH -> "crash"
        REASON_CRASH_NATIVE -> "crash_native"
        REASON_ANR -> "anr"
        REASON_INITIALIZATION_FAILURE -> "initialization_failure"
        REASON_PERMISSION_CHANGE -> "permission_change"
        REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive_resource_usage"
        REASON_USER_REQUESTED -> "user_requested"
        REASON_USER_STOPPED -> "user_stopped"
        REASON_DEPENDENCY_DIED -> "dependency_died"
        REASON_OTHER -> "other"
        REASON_FREEZER -> "freezer"
        REASON_PACKAGE_STATE_CHANGE -> "package_state_change"
        REASON_PACKAGE_UPDATED -> "package_updated"
        else -> "unknown"
    }

    /** Toujours une panne, que l'app ait été à l'écran ou non. */
    private val ALWAYS_ABNORMAL = setOf(
        REASON_CRASH, REASON_CRASH_NATIVE, REASON_ANR, REASON_INITIALIZATION_FAILURE, REASON_EXCESSIVE_RESOURCE_USAGE,
    )

    /**
     * Une panne seulement si l'app était à l'écran ou lisait un flux : en arrière-plan, Android ferme
     * normalement les apps pour libérer de la mémoire. « signaled » couvre aussi la fermeture forcée
     * quand la page (WebView) est tuée.
     */
    private val ABNORMAL_IN_USE = setOf(
        REASON_UNKNOWN, REASON_SIGNALED, REASON_LOW_MEMORY, REASON_DEPENDENCY_DIED, REASON_OTHER,
    )

    /**
     * Rapport à envoyer, ou null : fin normale (mise à jour, fermeture par l'utilisateur, app en
     * arrière-plan libérée), déjà signalée ([lastReportedMs]), trop ancienne, ou datée du futur.
     * [player] : état du lecteur retenu avant la fermeture (gardé seulement s'il date d'avant elle).
     */
    fun report(exit: Exit?, player: PlayerState?, lastReportedMs: Long, nowMs: Long, exitRequestedMs: Long = 0L): Report? {
        if (exit == null) return null
        if (exit.timestampMs <= lastReportedMs) return null
        if (exitRequestedMs > 0 && exit.timestampMs in exitRequestedMs..(exitRequestedMs + REQUESTED_EXIT_WINDOW_MS)) return null
        if (exit.timestampMs > nowMs || nowMs - exit.timestampMs > MAX_AGE_MS) return null
        val playerAtExit = player?.takeIf { it.sinceMs <= exit.timestampMs }
        val foreground = exit.importance in 1..IMPORTANCE_VISIBLE
        val abnormal = exit.reason in ALWAYS_ABNORMAL ||
            (exit.reason in ABNORMAL_IN_USE && (foreground || playerAtExit != null))
        if (!abnormal || isTaskRemoval(exit)) return null
        return Report(
            reason = reasonName(exit.reason),
            status = exit.status,
            foreground = foreground,
            timestampMs = exit.timestampMs,
            description = cleanDescription(exit.description),
            pssKb = exit.pssKb,
            rssKb = exit.rssKb,
            player = playerAtExit,
        )
    }

    /** App balayée hors des applications récentes : Android la note « other » avec « remove task ». */
    private fun isTaskRemoval(exit: Exit): Boolean =
        exit.reason == REASON_OTHER && exit.description?.trim()?.startsWith("remove task", ignoreCase = true) == true

    /** Sans adresse ni serveur, sur une ligne, raccourcie. */
    fun cleanDescription(description: String?): String? {
        val text = description?.replace(Regex("""\s+"""), " ")?.trim().orEmpty()
        if (text.isEmpty()) return null
        return StreamDiagnostics.redact(text).take(MAX_DESCRIPTION_CHARS)
    }

    /**
     * Type de contenu et extension tirés de `StreamDiagnostics.describeUrl` (« live · ts »), réduits
     * à des mots sûrs : « stream » et « ? » si la forme est inattendue.
     */
    fun kindAndExtension(described: String): Pair<String, String> {
        val separator = " · "
        if (!described.contains(separator)) return "stream" to "?"
        val kind = safeToken(described.substringBefore(separator))?.takeIf { it != "?" } ?: "stream"
        val rawExtension = described.substringAfter(separator)
        val extension = safeToken(rawExtension)?.takeIf { it != "?" && rawExtension.length <= MAX_EXTENSION_CHARS } ?: "?"
        return kind to extension
    }

    private const val MAX_EXTENSION_CHARS = 5

    /** Valeur courte et sûre pour l'état du lecteur : lettres, chiffres, `-_.,`, sinon « ? ». */
    fun safeToken(value: String?, maxLength: Int = 32): String? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        return if (Regex("""^[A-Za-z0-9_.,\-]+$""").matches(text)) text.take(maxLength) else "?"
    }
}
