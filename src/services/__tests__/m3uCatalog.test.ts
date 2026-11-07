/**
 * Entrées d'une liste M3U : adresse de lecture prise dans la colonne `data` du catalogue, jamais
 * pour une ligne Xtream, et jamais une adresse que le lecteur ne doit pas ouvrir.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = new Map<string, string | null>();
const select = vi.fn(async (sql: string, params: unknown[]) => {
    const table = /FROM (\w+)/.exec(sql)?.[1];
    const data = rows.get(`${table}:${String(params[0])}`);
    return data === undefined ? [] : [{ data }];
});
vi.mock('../dbCore', () => ({ getDatabase: async () => ({ select }) }));

import { parseM3uStream, getM3uSeriesEpisodes, resolveM3uPlayback } from '../m3uCatalog';

const m3u = (url: string, extra: Record<string, unknown> = {}) => JSON.stringify({ source: 'm3u', url, ...extra });

beforeEach(() => {
    rows.clear();
    select.mockClear();
});

describe('parseM3uStream', () => {
    it('garde l\'adresse et les en-têtes d\'une entrée M3U', () => {
        expect(parseM3uStream({ source: 'm3u', url: 'http://tv.example/a.ts', user_agent: 'Lecteur/1.0', referrer: 'http://r.example/' }))
            .toEqual({ url: 'http://tv.example/a.ts', userAgent: 'Lecteur/1.0', referrer: 'http://r.example/' });
    });

    it('une ligne Xtream n\'est jamais prise pour une entrée M3U', () => {
        expect(parseM3uStream({ url: 'http://tv.example/a.ts' })).toBeNull();
        expect(parseM3uStream({ source: 'xtream', url: 'http://tv.example/a.ts' })).toBeNull();
        expect(parseM3uStream(null)).toBeNull();
    });

    it('refuse les adresses que le lecteur ne doit pas ouvrir', () => {
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x', 'udp://239.0.0.1:1234', 'http://', 'pas une adresse', '']) {
            expect(parseM3uStream({ source: 'm3u', url })).toBeNull();
        }
        expect(parseM3uStream({ source: 'm3u', url: `http://tv.example/${'a'.repeat(9000)}` })).toBeNull();
        expect(parseM3uStream({ source: 'm3u', url: 'rtsp://tv.example/flux' })).toEqual({ url: 'rtsp://tv.example/flux' });
    });

    it('écarte un en-tête avec un retour à la ligne (pas d\'en-tête injecté)', () => {
        expect(parseM3uStream({ source: 'm3u', url: 'http://tv.example/a.ts', user_agent: 'A\r\nX-Evil: 1' }))
            .toEqual({ url: 'http://tv.example/a.ts' });
    });
});

describe('getM3uSeriesEpisodes', () => {
    it('range les épisodes par saison, chacun avec son adresse', async () => {
        rows.set('series:7', JSON.stringify({
            source: 'm3u',
            episodes: [
                { id: 11, title: 'Ma Série S01E01', season: 1, episode_num: 1, container_extension: 'mp4', data: { source: 'm3u', url: 'http://cdn.example/1-1.mp4' } },
                { id: 12, title: 'Ma Série S01E02', season: 1, episode_num: 2, container_extension: 'mp4', data: { source: 'm3u', url: 'http://cdn.example/1-2.mp4' } },
                { id: 21, title: 'Ma Série S02E01', season: 2, episode_num: 1, container_extension: 'mkv', data: { source: 'm3u', url: 'http://cdn.example/2-1.mkv' } },
                { id: 99, title: 'Sans adresse valide', season: 2, episode_num: 2, data: { source: 'm3u', url: 'file:///x' } },
            ],
        }));
        const episodes = await getM3uSeriesEpisodes(7);
        expect(Object.keys(episodes ?? {})).toEqual(['1', '2']);
        expect(episodes?.['1'].map((e) => e.id)).toEqual(['11', '12']);
        expect(episodes?.['2']).toHaveLength(1);
        expect(episodes?.['2'][0]).toMatchObject({ id: '21', episode_num: 1, container_extension: 'mkv' });
        expect(await resolveM3uPlayback(episodes!['2'][0])).toMatchObject({ url: 'http://cdn.example/2-1.mkv' });
    });

    it('série Xtream, ligne absente ou illisible : null (la page demande au fournisseur)', async () => {
        rows.set('series:1', null);
        rows.set('series:4', JSON.stringify({ plot: 'Xtream' }));
        rows.set('series:2', '{pas du json');
        expect(await getM3uSeriesEpisodes(1)).toBeNull();
        expect(await getM3uSeriesEpisodes(2)).toBeNull();
        expect(await getM3uSeriesEpisodes(3)).toBeNull();
        expect(await getM3uSeriesEpisodes(4)).toBeNull();
    });

    it('base illisible : null, jamais d\'erreur', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        select.mockRejectedValueOnce(new Error('base verrouillée'));
        expect(await getM3uSeriesEpisodes(7)).toBeNull();
        warn.mockRestore();
    });
});

describe('resolveM3uPlayback', () => {
    it('chaîne M3U : adresse de la table des chaînes, en direct', async () => {
        rows.set('live:5', m3u('http://tv.example/live/un.m3u8'));
        expect(await resolveM3uPlayback({ stream_id: 5, stream_type: 'live' }))
            .toMatchObject({ url: 'http://tv.example/live/un.m3u8', container: 'm3u8', live: true });
    });

    it('film M3U : adresse de la table des films', async () => {
        rows.set('movies:9', m3u('http://cdn.example/films/le-film.mkv'));
        expect(await resolveM3uPlayback({ stream_id: 9 }))
            .toMatchObject({ url: 'http://cdn.example/films/le-film.mkv', container: 'mkv', live: false });
    });

    it('chaîne ou film Xtream : null, l\'adresse Xtream est construite comme avant', async () => {
        rows.set('live:5', JSON.stringify({ name: 'Xtream' }));
        expect(await resolveM3uPlayback({ stream_id: 5, stream_type: 'live' })).toBeNull();
        expect(await resolveM3uPlayback({ stream_id: 6 })).toBeNull();
    });

    it('épisode de la page Séries : son adresse retenue, sans relire la base', async () => {
        rows.set('series:7', JSON.stringify({ source: 'm3u', episodes: [
            { id: 11, title: 'E1', season: 1, episode_num: 1, container_extension: 'mp4', data: { source: 'm3u', url: 'http://cdn.example/1-1.mp4' } },
        ] }));
        const episodes = await getM3uSeriesEpisodes(7);
        select.mockClear();
        const episode = episodes!['1'][0];
        expect(await resolveM3uPlayback(episode)).toMatchObject({ url: 'http://cdn.example/1-1.mp4', container: 'mp4', live: false });
        // Copie de la série par la page (épisodes repris tels quels) : retrouvé par son numéro
        expect(await resolveM3uPlayback({ id: '11', episode_num: 1 }, { seriesEpisodes: episodes! })).toMatchObject({ url: 'http://cdn.example/1-1.mp4' });
        expect(select).not.toHaveBeenCalled();
    });

    it('épisode Xtream portant un champ « m3u » dans le JSON du fournisseur : jamais lu à cette adresse', async () => {
        const injected = { id: '12', episode_num: 2, container_extension: 'mkv', m3u: { url: 'http://autre.example/x.mkv' } };
        expect(await resolveM3uPlayback(injected, { seriesEpisodes: { '1': [injected as never] } })).toBeNull();
    });

    it('épisode d\'une carte « Reprendre » : trouvé dans la série rangée en base', async () => {
        rows.set('series:7', JSON.stringify({ source: 'm3u', episodes: [
            { id: 12, title: 'E2', season: 1, episode_num: 2, data: { source: 'm3u', url: 'http://cdn.example/1-2.mp4' } },
        ] }));
        expect(await resolveM3uPlayback({ id: '12', episode_num: 2 }, { seriesId: 7 }))
            .toMatchObject({ url: 'http://cdn.example/1-2.mp4', live: false });
    });

    it('épisode Xtream : null', async () => {
        expect(await resolveM3uPlayback({ id: '12', episode_num: 2, container_extension: 'mkv' }, { seriesId: 8 })).toBeNull();
    });
});
