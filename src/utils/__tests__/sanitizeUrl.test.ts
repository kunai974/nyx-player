import { describe, it, expect } from 'vitest';
import { sanitizeIptvUrl, describeStreamForLog } from '../sanitizeUrl';

describe('sanitizeIptvUrl', () => {
  // ── Stream URLs (path-based credentials) ──

  it('masque les credentials dans une URL stream live', () => {
    const url = 'http://provider.com:8080/live/john_doe/myP@ss123/789.ts';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/live/***/***/789.ts');
  });

  it('masque les credentials dans une URL stream movie', () => {
    const url = 'http://provider.com:8080/movie/john_doe/myP@ss123/12345.mp4';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/movie/***/***/12345.mp4');
  });

  it('masque les credentials dans une URL stream series', () => {
    const url = 'http://provider.com:8080/series/john_doe/myP@ss123/67890.mkv';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/series/***/***/67890.mkv');
  });

  // ── API URLs (query param credentials) ──

  it('masque username et password dans une URL API', () => {
    const url = 'http://provider.com:8080/player_api.php?username=john_doe&password=myP@ss123&action=get_live_streams';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/player_api.php?username=***&password=***&action=get_live_streams');
  });

  it('masque les credentials avec ordre inversé des params', () => {
    const url = 'http://provider.com:8080/player_api.php?password=secret&username=admin';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/player_api.php?password=***&username=***');
  });

  // ── URLs sans credentials (passthrough) ──

  it('ne modifie pas une URL TMDB normale', () => {
    const url = 'https://api.themoviedb.org/3/movie/550?api_key=abc123';
    expect(sanitizeIptvUrl(url)).toBe(url);
  });

  it('ne modifie pas une URL Supabase', () => {
    const url = 'https://abc.supabase.co/rest/v1/watchlist';
    expect(sanitizeIptvUrl(url)).toBe(url);
  });

  it('ne modifie pas une URL interne localhost', () => {
    const url = 'http://localhost:1420/';
    expect(sanitizeIptvUrl(url)).toBe(url);
  });

  // ── Edge cases ──

  it('gère une chaîne vide', () => {
    expect(sanitizeIptvUrl('')).toBe('');
  });

  it('gère une URL sans path IPTV', () => {
    const url = 'http://provider.com:8080/other/path/here';
    expect(sanitizeIptvUrl(url)).toBe(url);
  });

  // ── Timeshift, forme courte, identifiants dans l'adresse, JSON ──

  it('masque les credentials dans une URL timeshift', () => {
    const url = 'http://provider.com:8080/timeshift/john_doe/secret/60/2026-09-28:20-00/123.ts';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/timeshift/***/***/60/2026-09-28:20-00/123.ts');
  });

  it('masque la forme courte Xtream host:port/USER/PASS/ID', () => {
    expect(sanitizeIptvUrl('http://provider.com:8080/john_doe/secret/123')).toBe('http://provider.com:8080/***/***/123');
    expect(sanitizeIptvUrl('http://provider.com:8080/john_doe/secret/123.ts')).toBe('http://provider.com:8080/***/***/123.ts');
  });

  it('masque les credentials placés avant l\'hôte (userinfo)', () => {
    expect(sanitizeIptvUrl('http://john_doe:secret@provider.com:8080/get.php')).toBe('http://***:***@provider.com:8080/get.php');
  });

  it('masque toutes les URLs d\'un même message', () => {
    const msg = 'switch http://h.com/live/u1/p1/1.ts -> http://h.com/live/u2/p2/2.ts';
    const out = sanitizeIptvUrl(msg);
    expect(out).not.toMatch(/u1|p1|u2|p2/);
  });

  it('masque une erreur reqwest qui cite l\'URL API', () => {
    const msg = 'Request failed: error sending request for url (http://h.com:8080/player_api.php?username=john&password=secret&action=get_live_streams): timeout';
    const out = sanitizeIptvUrl(msg);
    expect(out).not.toContain('john');
    expect(out).not.toContain('secret');
    expect(out).toContain('action=get_live_streams');
  });

  it('masque les identifiants d\'une réponse player_api au format JSON', () => {
    const msg = '{"user_info":{"username":"john","password":"secret","auth":1}}';
    expect(sanitizeIptvUrl(msg)).toBe('{"user_info":{"username":"***","password":"***","auth":1}}');
  });

  it('masque tout un mot de passe JSON contenant un guillemet échappé', () => {
    const msg = String.raw`{"password":"ab\"cdSECRET","auth":1}`;
    expect(sanitizeIptvUrl(msg)).toBe('{"password":"***","auth":1}');
  });

  it('ne masque pas une URL TMDB à trois segments', () => {
    const url = 'https://api.themoviedb.org/3/tv/1399/season/1';
    expect(sanitizeIptvUrl(url)).toBe(url);
  });

  // ── Formes sans port, en majuscules ou encodées ──

  it('masque la forme courte sans port avec une extension longue (mpegts)', () => {
    expect(sanitizeIptvUrl('http://h.example/John/Secret/1.mpegts')).toBe('http://h.example/***/***/1.mpegts');
  });

  it('masque la forme courte sans port host/USER/PASS/ID', () => {
    expect(sanitizeIptvUrl('http://provider.example/john_doe/secret/123.ts')).toBe('http://provider.example/***/***/123.ts');
    expect(sanitizeIptvUrl('erreur http://provider.example/john_doe/secret/123 ici')).toBe('erreur http://provider.example/***/***/123 ici');
    expect(sanitizeIptvUrl('http://provider.example/12345678/87654321/42.m3u8?t=1')).toBe('http://provider.example/***/***/42.m3u8?t=1');
    // Fin de phrase ou erreur ffmpeg relayée par mpv
    expect(sanitizeIptvUrl('http://provider.example/jdoe/p4ss/123.ts: Server returned 404')).toBe('http://provider.example/***/***/123.ts: Server returned 404');
    expect(sanitizeIptvUrl('Échec de http://provider.example/jdoe/p4ss/123.ts.')).toBe('Échec de http://provider.example/***/***/123.ts.');
    expect(sanitizeIptvUrl('http://provider.example/jdoe/p4ss/123/')).toBe('http://provider.example/***/***/123/');
  });

  it('forme courte sans port : une adresse d\'API à numéro de version reste lisible', () => {
    const url = 'https://api.themoviedb.org/3/movie/550';
    expect(sanitizeIptvUrl(url)).toBe(url);
    const longer = 'http://provider.example/a/b/123/suite';
    expect(sanitizeIptvUrl(longer)).toBe(longer);
  });

  it('masque les chemins de flux écrits en majuscules', () => {
    expect(sanitizeIptvUrl('http://provider.example/LIVE/John/Secret/1.ts')).toBe('http://provider.example/LIVE/***/***/1.ts');
    expect(sanitizeIptvUrl('http://provider.example:8080/Movie/John/Secret/2.mkv')).toBe('http://provider.example:8080/Movie/***/***/2.mkv');
  });

  it('masque les paramètres encodés (adresse dans une adresse)', () => {
    expect(sanitizeIptvUrl('username%3DJohn%26password%3DSecret')).toBe('username%3D***%26password%3D***');
    const nested = 'http://proxy.example/go?u=http%3A%2F%2Fh.example%2Fplayer_api.php%3Fusername%3DJohn%26password%3DS%40cret%26action%3Dx';
    expect(sanitizeIptvUrl(nested)).toBe('http://proxy.example/go?u=http%3A%2F%2Fh.example%2Fplayer_api.php%3Fusername%3D***%26password%3D***%26action%3Dx');
    expect(sanitizeIptvUrl('x%3fUSERNAME%3dJohn')).toBe('x%3fUSERNAME%3d***');
  });

  it('masque le chemin de flux encodé (adresse de flux dans une autre adresse)', () => {
    expect(sanitizeIptvUrl('go?u=http%3A%2F%2Fh.example%2Flive%2FJohn%2FSecret%2F1.ts')).toBe('go?u=http%3A%2F%2Fh.example%2Flive%2F***%2F***%2F1.ts');
    expect(sanitizeIptvUrl('u=http%3a%2f%2fh.example%2fMOVIE%2fJo%40hn%2fS%2Bcret%2f2.mkv')).toBe('u=http%3a%2f%2fh.example%2fMOVIE%2f***%2F***%2F2.mkv');
  });

  it('gère des credentials contenant des caractères spéciaux', () => {
    const url = 'http://provider.com:8080/live/user%40special/p@ss!w0rd/123.ts';
    expect(sanitizeIptvUrl(url)).toBe('http://provider.com:8080/live/***/***/123.ts');
  });
  it('masque les jetons d\'une adresse tierce (guide EPG, flux HLS)', () => {
    expect(sanitizeIptvUrl('http://h.example/live/U/P/1.ts?token=X')).toBe('http://h.example/live/***/***/1.ts?token=***');
    expect(sanitizeIptvUrl('https://epg.example/guide.xml?key=Abc123&lang=fr')).toBe('https://epg.example/guide.xml?key=***&lang=fr');
    expect(sanitizeIptvUrl('https://epg.example/g.xml?AUTH=a&apikey=b&pass=d&pwd=e&signature=f'))
      .toBe('https://epg.example/g.xml?AUTH=***&apikey=***&pass=***&pwd=***&signature=***');
    expect(sanitizeIptvUrl('go?u=http%3A%2F%2Fepg.example%2Fg.xml%3Ftoken%3DSecret%26lang%3Dfr'))
      .toBe('go?u=http%3A%2F%2Fepg.example%2Fg.xml%3Ftoken%3D***%26lang%3Dfr');
    // Un paramètre dont le nom ne fait que contenir « key » reste lisible
    expect(sanitizeIptvUrl('https://h.example/x?monkey=1&sort_key=2')).toBe('https://h.example/x?monkey=1&sort_key=2');
  });

  it('masque un identifiant placé avant l\'hôte sans mot de passe', () => {
    expect(sanitizeIptvUrl('http://John@h.example/get.php')).toBe('http://***@h.example/get.php');
    expect(sanitizeIptvUrl('http://John:Secret@h.example/x')).toBe('http://***:***@h.example/x');
  });

  it('masque les chemins de flux /hls/ et /play/', () => {
    expect(sanitizeIptvUrl('http://h.example/hls/John/Secret/1.m3u8')).toBe('http://h.example/hls/***/***/1.m3u8');
    expect(sanitizeIptvUrl('http://h.example:8080/play/John/Secret/42')).toBe('http://h.example:8080/play/***/***/42');
    expect(sanitizeIptvUrl('go?u=http%3A%2F%2Fh.example%2Fhls%2FJohn%2FSecret%2F1.m3u8')).toBe('go?u=http%3A%2F%2Fh.example%2Fhls%2F***%2F***%2F1.m3u8');
  });

  it('garde lisible une adresse TMDB', () => {
    const tmdb = 'https://api.themoviedb.org/3/tv/1399/season/1?language=fr-FR';
    expect(sanitizeIptvUrl(tmdb)).toBe(tmdb);
  });
});

describe('describeStreamForLog', () => {
  it('adresse Xtream : hôte, type et numéro du flux, sans identifiants', () => {
    expect(describeStreamForLog('http://h.example:8080/live/USER/PASS/123.ts')).toBe('http://h.example:8080/live/…/123.ts');
  });

  it('adresse de liste M3U : ni chemin ni paramètres, où un secret peut se cacher', () => {
    const text = describeStreamForLog('https://cdn.example/abc123secret/index.m3u8?sig=XYZ&exp=1');
    expect(text).toBe('https://cdn.example/…/.m3u8');
    expect(text).not.toContain('abc123secret');
    expect(text).not.toContain('XYZ');
  });

  it('identifiants dans l\'adresse et adresse illisible : rien ne sort', () => {
    expect(describeStreamForLog('http://u:p@h.example/flux')).toBe('http://h.example/…/');
    expect(describeStreamForLog('pas une adresse')).toBe('(adresse illisible)');
  });
});
