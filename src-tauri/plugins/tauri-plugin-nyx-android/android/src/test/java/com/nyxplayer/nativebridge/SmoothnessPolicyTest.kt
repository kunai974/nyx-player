package com.nyxplayer.nativebridge

import com.nyxplayer.nativebridge.SmoothnessPolicy.Sample
import com.nyxplayer.nativebridge.SmoothnessPolicy.Window
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmoothnessPolicyTest {
    private val start = Sample(drops = 0, position = 100.0, wallMs = 0, audioTrouble = 0, playing = true)

    /** Fenêtre de 6 s d'horloge où la vidéo a avancé de [played] s. */
    private fun after(played: Double, drops: Long = 0, audio: Int = 0, playing: Boolean = true) =
        Sample(drops, start.position + played, 6_000, audio, playing)

    @Test
    fun `lecture fluide`() {
        val window = SmoothnessPolicy.judge(start, after(6.0), speed = 1.0, fps = 25.0)!!
        assertEquals(1.0, window.progress, 1e-9)
        assertEquals(0.0, window.dropRatio, 1e-9)
        assertFalse(window.bad)
    }

    @Test
    fun `fenêtre non jugée`() {
        // Premier relevé
        assertNull(SmoothnessPolicy.judge(null, after(6.0), 1.0, 25.0))
        // Pause, mise en tampon ou saut au début ou à la fin de la fenêtre
        assertNull(SmoothnessPolicy.judge(start.copy(playing = false), after(6.0), 1.0, 25.0))
        assertNull(SmoothnessPolicy.judge(start, after(6.0, playing = false), 1.0, 25.0))
        // Moins de 2 s entre les relevés
        assertNull(SmoothnessPolicy.judge(start, after(1.0).copy(wallMs = 1_999), 1.0, 25.0))
        // Position revenue en arrière (saut)
        assertNull(SmoothnessPolicy.judge(start, after(-3.0), 1.0, 25.0))
        // Position illisible
        assertNull(SmoothnessPolicy.judge(start, after(6.0).copy(position = Double.NaN), 1.0, 25.0))
    }

    @Test
    fun `images perdues`() {
        // 6 s à 25 images/s = 150 images ; 30 perdues = 20 % : mauvaise fenêtre
        val bad = SmoothnessPolicy.judge(start, after(6.0, drops = 30), 1.0, 25.0)!!
        assertEquals(0.2, bad.dropRatio, 1e-9)
        assertTrue(bad.bad)
        // Presque pas de lecture : la part d'images perdues ne veut rien dire
        assertEquals(0.0, SmoothnessPolicy.judge(start, after(0.5, drops = 90), 1.0, 25.0)!!.dropRatio, 0.0)
    }

    @Test
    fun `vidéo plus lente que l'horloge`() {
        // 4,8 s en 6 s = 80 % : mauvaise
        val slow = SmoothnessPolicy.judge(start, after(4.8), 1.0, 25.0)!!
        assertEquals(0.8, slow.progress, 1e-9)
        assertTrue(slow.bad)
    }

    @Test
    fun `la vitesse de lecture est prise en compte`() {
        // En x2, 12 s de vidéo en 6 s : normal
        assertEquals(1.0, SmoothnessPolicy.judge(start, after(12.0), 2.0, 25.0)!!.progress, 1e-9)
        // Vitesse ou cadence inconnues : x1 et 24 images/s
        val unknown = SmoothnessPolicy.judge(start, after(6.0, drops = 36), null, null)!!
        assertEquals(1.0, unknown.progress, 1e-9)
        assertEquals(0.25, unknown.dropRatio, 1e-9)
        // Valeurs aberrantes bornées (pas de division par zéro) : vitesse comptée x0,1
        assertEquals(10.0, SmoothnessPolicy.judge(start, after(6.0), 0.0, 0.0)!!.progress, 1e-9)
    }

    @Test
    fun `seuils exacts`() {
        val zero = Sample(drops = 0, position = 0.0, wallMs = 0, audioTrouble = 0, playing = true)
        fun at(wallMs: Long, played: Double, drops: Long = 0) = Sample(drops, played, wallMs, 0, true)
        // 2 s pile : la fenêtre se juge
        assertNotNull(SmoothnessPolicy.judge(zero, at(2_000, 2.0), 1.0, 25.0))
        // 6 s à 20 images/s = 120 images : 18 perdues = 15 % pile, pas encore mauvais ; 60 = 50 %, mauvais
        val dropsAtBad = SmoothnessPolicy.judge(zero, at(6_000, 6.0, drops = 18), 1.0, 20.0)!!
        assertEquals(0.15, dropsAtBad.dropRatio, 0.0)
        assertFalse(dropsAtBad.bad)
        val dropsAtFatal = SmoothnessPolicy.judge(zero, at(6_000, 6.0, drops = 60), 1.0, 20.0)!!
        assertTrue(dropsAtFatal.bad)
        // 85 % pile de la vitesse : pas mauvais ; 50 % pile : mauvais
        assertFalse(SmoothnessPolicy.judge(zero, at(10_000, 8.5), 1.0, 25.0)!!.bad)
        val halfSpeed = SmoothnessPolicy.judge(zero, at(10_000, 5.0), 1.0, 25.0)!!
        assertEquals(0.5, halfSpeed.progress, 0.0)
        assertTrue(halfSpeed.bad)
    }

    @Test
    fun `son qui décroche trois fois`() {
        assertFalse(SmoothnessPolicy.judge(start, after(6.0, audio = 2), 1.0, 25.0)!!.bad)
        val window = SmoothnessPolicy.judge(start.copy(audioTrouble = 4), after(6.0, audio = 7), 1.0, 25.0)!!
        assertEquals(3, window.audioTrouble)
        assertTrue(window.bad)
    }

    @Test
    fun `deux mauvaises fenêtres de suite`() {
        val good = Window(progress = 1.0, dropRatio = 0.0, audioTrouble = 0)
        val bad = Window(progress = 0.8, dropRatio = 0.0, audioTrouble = 0)

        assertEquals(1, SmoothnessPolicy.badWindowsAfter(bad, 0))
        assertFalse(SmoothnessPolicy.tooSlow(1))
        assertEquals(2, SmoothnessPolicy.badWindowsAfter(bad, 1))
        assertTrue(SmoothnessPolicy.tooSlow(2))
        // Une bonne fenêtre remet le compte à zéro
        assertEquals(0, SmoothnessPolicy.badWindowsAfter(good, 1))
        assertFalse(SmoothnessPolicy.tooSlow(0))
    }

    @Test
    fun `zapping - une fenêtre isolée très saccadée ne déclenche pas l'alerte, même au processeur`() {
        // Chaîne en direct (H264 720p en matériel, ou MPEG-2 SD au processeur) : une fenêtre très
        // saccadée pendant que le panneau de zapping charge l'interface, puis la lecture redevient fluide
        val veryBad = Window(progress = 0.4, dropRatio = 0.6, audioTrouble = 3)
        val good = Window(progress = 1.0, dropRatio = 0.0, audioTrouble = 0)
        val afterVeryBad = SmoothnessPolicy.badWindowsAfter(veryBad, 0)
        assertFalse(SmoothnessPolicy.tooSlow(afterVeryBad))
        assertFalse(SmoothnessPolicy.tooSlow(SmoothnessPolicy.badWindowsAfter(good, afterVeryBad)))
        // Elle continue de saccader à la fenêtre suivante : là, l'alerte se justifie
        assertTrue(SmoothnessPolicy.tooSlow(SmoothnessPolicy.badWindowsAfter(veryBad, afterVeryBad)))
    }

    @Test
    fun `le souvenir expire après 7 jours`() {
        val day = 24L * 60 * 60 * 1000
        val saved = 1_000_000_000_000L
        assertTrue(SmoothnessPolicy.stillRemembered(saved, saved))
        assertTrue(SmoothnessPolicy.stillRemembered(saved, saved + 7 * day))
        assertFalse(SmoothnessPolicy.stillRemembered(saved, saved + 7 * day + 1))
        // Horloge revenue en arrière, ou date illisible : souvenir expiré
        assertFalse(SmoothnessPolicy.stillRemembered(saved, saved - 1))
        assertFalse(SmoothnessPolicy.stillRemembered(0L, saved))
    }

    @Test
    fun `seul un format décodé au processeur est retenu`() {
        // Un format matériel retenu signalait chaque chaîne de ce format dès son lancement
        assertFalse(SmoothnessPolicy.remembers("h264|sd|hw"))
        assertFalse(SmoothnessPolicy.remembers(SmoothnessPolicy.formatSignature("h264", 720, "mediacodec", false)))
        assertFalse(SmoothnessPolicy.remembers(SmoothnessPolicy.formatSignature("hevc", 2160, "mediacodec-copy", false)))
        assertTrue(SmoothnessPolicy.remembers(SmoothnessPolicy.formatSignature("hevc", 2160, "no", dolbyVision = true)))
        assertTrue(SmoothnessPolicy.remembers(SmoothnessPolicy.formatSignature("mpeg2video", 576, null, false)))
        assertTrue(SmoothnessPolicy.isSoftwareDecoding(null))
        assertTrue(SmoothnessPolicy.isSoftwareDecoding("no"))
        assertFalse(SmoothnessPolicy.isSoftwareDecoding("mediacodec"))
    }

    @Test
    fun `signature du format, sans adresse`() {
        assertEquals("hevc|2160|sw|dv5", SmoothnessPolicy.formatSignature("HEVC", 2160, "no", dolbyVision = true))
        assertEquals("h264|1080|hw", SmoothnessPolicy.formatSignature("h264", 1080, "mediacodec", dolbyVision = false))
        assertEquals("mpeg2video|sd|sw", SmoothnessPolicy.formatSignature("mpeg2video", 576, null, dolbyVision = false))
        // Seuils des tranches de hauteur
        assertEquals("h264|2160|hw", SmoothnessPolicy.formatSignature("h264", 2000, "mediacodec-copy", false))
        assertEquals("h264|1080|hw", SmoothnessPolicy.formatSignature("h264", 1999, "mediacodec-copy", false))
        assertEquals("h264|1080|hw", SmoothnessPolicy.formatSignature("h264", 1000, "mediacodec-copy", false))
        assertEquals("h264|sd|hw", SmoothnessPolicy.formatSignature("h264", 999, "mediacodec-copy", false))
    }

    @Test
    fun `détail lisible du format`() {
        assertEquals(
            "HEVC · 3840x1920 · Dolby Vision 5 · software",
            SmoothnessPolicy.formatDetail("hevc", 3840, 1920, "no", dolbyVision = true),
        )
        assertEquals("H264 · 1920x1080 · hardware", SmoothnessPolicy.formatDetail("h264", 1920, 1080, "mediacodec", false))
        // Valeurs inconnues : omises
        assertEquals("software", SmoothnessPolicy.formatDetail(null, null, null, null, false))
        assertEquals("H264 · 720 · software", SmoothnessPolicy.formatDetail("h264", null, 720, null, false))
    }
}
