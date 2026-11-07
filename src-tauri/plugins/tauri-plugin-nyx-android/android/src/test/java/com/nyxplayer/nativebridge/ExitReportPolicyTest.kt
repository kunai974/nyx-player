package com.nyxplayer.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Dernière fermeture de l'app : seules les vraies pannes remontent, une fois, sans donnée perso. */
class ExitReportPolicyTest {
    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private fun exit(
        reason: Int,
        importance: Int = 100,
        at: Long = now - minute,
        description: String? = null,
    ) = ExitReportPolicy.Exit(reason, status = 11, importance = importance, timestampMs = at, description = description, pssKb = 0, rssKb = 0)

    private fun player(since: Long = now - 2 * minute, phase: String = PlayerMark.PHASE_OPENING) =
        ExitReportPolicy.PlayerState("movie", "mkv", phase, codec = null, hwdec = null, sinceMs = since)

    @Test
    fun `un plantage natif pendant l'ouverture d'un film est signale avec l'etat du lecteur`() {
        val report = ExitReportPolicy.report(exit(ExitReportPolicy.REASON_CRASH_NATIVE), player(), lastReportedMs = 0, nowMs = now)
        assertNotNull(report)
        assertEquals("crash_native", report!!.reason)
        assertEquals(11, report.status)
        assertTrue(report.foreground)
        assertEquals("movie", report.player?.kind)
        assertEquals(PlayerMark.PHASE_OPENING, report.player?.phase)
    }

    @Test
    fun `plantage Java, app figee et echec au demarrage sont toujours signales`() {
        for (reason in listOf(ExitReportPolicy.REASON_CRASH, ExitReportPolicy.REASON_ANR, ExitReportPolicy.REASON_INITIALIZATION_FAILURE)) {
            assertNotNull(reason.toString(), ExitReportPolicy.report(exit(reason, importance = 400), null, 0, now))
        }
    }

    @Test
    fun `une fin normale ne remonte jamais`() {
        val normal = listOf(
            ExitReportPolicy.REASON_EXIT_SELF, ExitReportPolicy.REASON_USER_REQUESTED, ExitReportPolicy.REASON_USER_STOPPED,
            ExitReportPolicy.REASON_PACKAGE_UPDATED, ExitReportPolicy.REASON_PERMISSION_CHANGE, ExitReportPolicy.REASON_FREEZER,
        )
        for (reason in normal) {
            assertNull(reason.toString(), ExitReportPolicy.report(exit(reason), player(), 0, now))
        }
    }

    @Test
    fun `app tuee a l'ecran ou pendant une lecture signalee, liberee en arriere-plan non`() {
        val killed = ExitReportPolicy.REASON_SIGNALED
        assertNotNull(ExitReportPolicy.report(exit(killed, importance = 100), null, 0, now))
        assertNotNull(ExitReportPolicy.report(exit(killed, importance = 400), player(), 0, now))
        assertNull(ExitReportPolicy.report(exit(killed, importance = 400), null, 0, now))
        assertNull(ExitReportPolicy.report(exit(ExitReportPolicy.REASON_LOW_MEMORY, importance = 400), null, 0, now))
    }

    @Test
    fun `une fermeture deja signalee, trop ancienne ou datee du futur ne revient pas`() {
        val crash = ExitReportPolicy.REASON_CRASH_NATIVE
        assertNull(ExitReportPolicy.report(exit(crash, at = now - minute), null, lastReportedMs = now - minute, nowMs = now))
        assertNull(ExitReportPolicy.report(exit(crash, at = now - ExitReportPolicy.MAX_AGE_MS - minute), null, 0, now))
        assertNull(ExitReportPolicy.report(exit(crash, at = now + minute), null, 0, now))
        assertNull(ExitReportPolicy.report(null, player(), 0, now))
    }

    @Test
    fun `un etat du lecteur posterieur a la fermeture n'y est pas rattache`() {
        val report = ExitReportPolicy.report(exit(ExitReportPolicy.REASON_CRASH), player(since = now), 0, now)
        assertNull(report?.player)
        // Et sans lui, une app tuée en arrière-plan n'est pas une panne
        assertNull(ExitReportPolicy.report(exit(ExitReportPolicy.REASON_SIGNALED, importance = 400), player(since = now), 0, now))
    }

    @Test
    fun `la description du systeme ne garde ni adresse ni serveur, sur une ligne courte`() {
        val raw = "crash\nOpening http://tv.example.invalid:8080/movie/jean/S3cret/12.mkv host=tv.example.invalid 10.0.0.2 " + "x".repeat(400)
        val text = ExitReportPolicy.cleanDescription(raw)!!
        assertFalse(text.contains("S3cret"))
        assertFalse(text.contains("jean"))
        assertFalse(text.contains("example"))
        assertFalse(text.contains("10.0.0.2"))
        assertFalse(text.contains("\n"))
        assertTrue(text.length <= ExitReportPolicy.MAX_DESCRIPTION_CHARS)
        assertNull(ExitReportPolicy.cleanDescription("  \n "))
    }

    @Test
    fun `l'etat du lecteur ne retient que des mots courts et surs`() {
        assertEquals("hevc", ExitReportPolicy.safeToken("hevc"))
        assertEquals("mediacodec-copy", ExitReportPolicy.safeToken("mediacodec-copy"))
        assertEquals("?", ExitReportPolicy.safeToken("h264 (H.264 / AVC)"))
        assertEquals("?", ExitReportPolicy.safeToken("http://x/y"))
        assertEquals("m3u8", ExitReportPolicy.safeToken("m3u8", maxLength = 5))
        assertNull(ExitReportPolicy.safeToken(null))
    }

    @Test
    fun `une fermeture juste apres une sortie demandee par Retour n'est pas une panne`() {
        val requested = now - 2 * minute
        val crash = ExitReportPolicy.REASON_CRASH_NATIVE
        assertNull(ExitReportPolicy.report(exit(crash, at = requested + 500), null, 0, now, exitRequestedMs = requested))
        // Plus tard (nouvelle session sans sortie notée), ou avant la demande : signalée
        assertNotNull(ExitReportPolicy.report(exit(crash, at = requested + ExitReportPolicy.REQUESTED_EXIT_WINDOW_MS + 1), null, 0, now, requested))
        assertNotNull(ExitReportPolicy.report(exit(crash, at = requested - 1), null, 0, now, requested))
    }

    @Test
    fun `l'app balayee hors des recentes n'est pas une panne`() {
        val swiped = exit(ExitReportPolicy.REASON_OTHER, description = "remove task")
        assertNull(ExitReportPolicy.report(swiped, player(), 0, now))
        assertNotNull(ExitReportPolicy.report(exit(ExitReportPolicy.REASON_OTHER, description = "something else"), player(), 0, now))
    }

    @Test
    fun `type de contenu et extension tires de la description du flux`() {
        assertEquals("live" to "ts", ExitReportPolicy.kindAndExtension("live · ts"))
        assertEquals("movie" to "mkv", ExitReportPolicy.kindAndExtension(StreamDiagnostics.describeUrl("http://h.invalid/movie/u/p/12.mkv")))
        assertEquals("series" to "?", ExitReportPolicy.kindAndExtension("series · webmxx"))
        assertEquals("stream" to "?", ExitReportPolicy.kindAndExtension("inattendu"))
        assertEquals("stream" to "?", ExitReportPolicy.kindAndExtension("a b · c d"))
    }

    @Test
    fun `chaque raison Android a un nom`() {
        assertEquals("low_memory", ExitReportPolicy.reasonName(ExitReportPolicy.REASON_LOW_MEMORY))
        assertEquals("anr", ExitReportPolicy.reasonName(ExitReportPolicy.REASON_ANR))
        assertEquals("unknown", ExitReportPolicy.reasonName(99))
    }
}
