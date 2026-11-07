package com.nyxplayer.nativebridge

import android.util.Log

/**
 * Playback diagnostics written to logcat under the `NyxPlayerDiag` tag, to find out which
 * formats cannot be played: codec, profile, resolution, decoder (hardware/software) and the
 * provider's HTTP answer.
 *
 * IPTV stream URLs embed the account credentials: nothing logged here may contain a URL,
 * a host or a path segment other than the content type and the file extension.
 *
 *   adb logcat -s NyxPlayerDiag
 */
object StreamDiagnostics {
    const val TAG = "NyxPlayerDiag"

    private val URL_PATTERN = Regex("""[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'"<>]+""")

    /**
     * Server name quoted alone by FFmpeg: `Failed to resolve hostname tv.example.com: …`,
     * `Host: tv.example.com`. Only a dotted value is masked: `host is unreachable` stays.
     * Colon last in `[=:]`: Android compiles regexes with ICU, where an opening bracket followed by a colon
     * starts a Unicode property as soon as a colon-bracket follows later on, and the app crashed at startup (scripts/test/android-regex-icu.test.mjs).
     */
    private val HOST_PATTERN = Regex("""(?i)\b(hostname|host)(\s*[=:]\s*|\s+)['"]?[^\s'",;)]*\.[^\s'",;):]+""")

    /** IPv6 address: `[2001:db8::1]:8080`, `2001:db8:0:0:0:0:0:1`, `fe80::1`. */
    private val IPV6_PATTERN = Regex(
        """\[[0-9a-fA-F:]*::[0-9a-fA-F:.]*](?::\d{1,5})?""" +
            """|\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b""" +
            """|(?<![\w:])(?:[0-9a-fA-F]{1,4}:){1,6}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,5})?(?![\w:])"""
    )

    /**
     * Xtream stream path quoted without its scheme (`/live/USER/PASS/1.ts`, `/hls/USER/PASS/…`):
     * the two segments after the content type are the account credentials.
     */
    private val XTREAM_PATH_PATTERN = Regex("""(?i)/(live|movie|series|timeshift|hls|play)/[^/\s'"<>]+/[^/\s'"<>]+/""")

    /** IPv4 address, with an optional port: `Connection to 1.2.3.4:8080 failed`. */
    private val IPV4_PATTERN = Regex("""\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b""")

    fun log(engine: String, message: String) {
        Log.i(TAG, "[$engine] ${redact(message)}")
    }

    fun warn(engine: String, message: String) {
        Log.w(TAG, "[$engine] ${redact(message)}")
    }

    /** `http://host/movie/user/pass/123.mkv` → `movie · mkv` */
    fun describeUrl(url: String): String {
        val path = urlPath(url)
        val kind = Regex("^/(live|movie|series)/").find(path)?.groupValues?.get(1) ?: "stream"
        val extension = path.substringAfterLast('.', "").takeIf { it.length in 1..5 && !it.contains('/') } ?: "?"
        return "$kind · $extension"
    }

    /**
     * Chemin d'une adresse, sans « schéma://hôte », requête ni ancre. Sans android.net.Uri, qui
     * n'existe pas dans les tests sur la JVM (il y renvoyait un chemin vide).
     */
    internal fun urlPath(url: String): String {
        val afterScheme = url.substringAfter("://", "")
        val path = afterScheme.indexOf('/').let { if (it < 0) "" else afterScheme.substring(it) }
        return path.substringBefore('?').substringBefore('#')
    }

    /**
     * Masks any URL, Xtream stream path, server name or IP address inside a free text
     * (mpv / FFmpeg messages).
     */
    fun redact(text: String): String = URL_PATTERN.replace(text, "<url>")
        .let { XTREAM_PATH_PATTERN.replace(it) { match -> "/${match.groupValues[1]}/***/***/" } }
        .let { HOST_PATTERN.replace(it) { match -> "${match.groupValues[1]}${match.groupValues[2]}<host>" } }
        .let { IPV6_PATTERN.replace(it, "<ip>") }
        .let { IPV4_PATTERN.replace(it, "<ip>") }
}
