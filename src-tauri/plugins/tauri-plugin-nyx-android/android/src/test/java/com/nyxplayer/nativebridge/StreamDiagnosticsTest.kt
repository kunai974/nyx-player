package com.nyxplayer.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Journaux du lecteur : ni adresse de flux, ni nom de serveur, ni adresse IP. */
class StreamDiagnosticsTest {
    @Test
    fun `une adresse de flux est masquee`() {
        val text = StreamDiagnostics.redact("Opening http://tv.example.invalid:8080/live/jean/S3cret/1.ts failed")
        assertEquals("Opening <url> failed", text)
    }

    @Test
    fun `un chemin Xtream cite sans adresse est masque`() {
        assertEquals("Opening /live/***/***/1.ts failed", StreamDiagnostics.redact("Opening /live/jean/S3cret/1.ts failed"))
        assertEquals("'/MOVIE/***/***/2.mkv': 404", StreamDiagnostics.redact("'/MOVIE/jean/S3cret/2.mkv': 404"))
        assertEquals("/hls/***/***/3.m3u8", StreamDiagnostics.redact("/hls/jean/S3cret/3.m3u8"))
        assertEquals("/timeshift/***/***/60/4.ts", StreamDiagnostics.redact("/timeshift/jean/S3cret/60/4.ts"))
        assertFalse(StreamDiagnostics.redact("GET /play/jean/S3cret/5").contains("S3cret"))
    }

    @Test
    fun `un nom de serveur cite seul par FFmpeg est masque`() {
        val text = StreamDiagnostics.redact("tcp: Failed to resolve hostname tv.example.invalid: Name does not resolve")
        assertEquals("tcp: Failed to resolve hostname <host>: Name does not resolve", text)
    }

    @Test
    fun `une adresse IP et son port sont masques`() {
        val text = StreamDiagnostics.redact("Connection to 185.12.4.33:8080 failed")
        assertEquals("Connection to <ip> failed", text)
    }

    @Test
    fun `une adresse IPv6 et un en-tete Host sont masques`() {
        assertEquals("Connection to <ip> failed", StreamDiagnostics.redact("Connection to [2001:db8::1]:8080 failed"))
        assertEquals("addr <ip> x", StreamDiagnostics.redact("addr fe80::1 x"))
        assertEquals("Host: <host>", StreamDiagnostics.redact("Host: tv.example.invalid"))
    }

    @Test
    fun `les diagnostics utiles restent lisibles`() {
        assertEquals("host is unreachable", StreamDiagnostics.redact("host is unreachable"))
        assertEquals("time 00:01:23.456", StreamDiagnostics.redact("time 00:01:23.456"))
        assertEquals("demuxer cache 50+25 MiB (RAM 2048 MiB)", StreamDiagnostics.redact("demuxer cache 50+25 MiB (RAM 2048 MiB)"))
        assertEquals("load failed http=458", StreamDiagnostics.redact("load failed http=458"))
        assertFalse(StreamDiagnostics.redact("hostname=tv.example.invalid").contains("example"))
    }

    @Test
    fun `description d'une adresse, type de contenu et extension seulement`() {
        assertEquals("movie · mkv", StreamDiagnostics.describeUrl("http://h.invalid/movie/u/p/12.mkv"))
        assertEquals("live · ts", StreamDiagnostics.describeUrl("https://h.invalid:8080/live/u/p/7.ts?token=x#frag"))
        assertEquals("series · ?", StreamDiagnostics.describeUrl("http://h.invalid/series/u/p/3"))
        assertEquals("stream · m3u8", StreamDiagnostics.describeUrl("http://192.0.2.1/hls/index.m3u8"))
        // Sans chemin, ou pas une adresse : rien d'exploitable
        assertEquals("stream · ?", StreamDiagnostics.describeUrl("http://h.invalid"))
        assertEquals("stream · ?", StreamDiagnostics.describeUrl("pas une adresse"))
        // Le point de l'hôte n'est pas une extension
        assertEquals("", StreamDiagnostics.urlPath("http://h.invalid?x=1.mkv"))
    }
}
