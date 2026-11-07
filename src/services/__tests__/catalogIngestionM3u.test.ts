/**
 * Lecture d'une liste M3U : même chemin qu'une lecture Xtream (base prise au départ, liens du
 * guide recalculés après), et la déconnexion arrête les deux sortes de lecture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentDb: string | null = 'nyxplayer_a.db';
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../dbCore', () => ({ getDatabaseFileName: () => currentDb }));
vi.mock('../preferencesService', () => ({ getDnsProvider: () => 'system' }));
vi.mock('../progressRelink', () => ({ pushRelinkedProgress: vi.fn(async () => {}) }));

import { ingestM3uCatalog, cancelCatalogIngestion } from '../catalogIngestion';

const result = {
    movies_count: 0, series_count: 0, live_count: 3, categories_count: 1, duration_ms: 1, partial: false,
    failed_endpoints: [] as string[], logs: [], progress_relinks: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    currentDb = 'nyxplayer_a.db';
    invoke.mockImplementation(async (cmd: string) => (cmd === 'ingest_m3u' ? result : undefined));
});

describe('ingestM3uCatalog', () => {
    it('lit la liste dans la base ouverte puis recalcule les liens du guide', async () => {
        await expect(ingestM3uCatalog('http://tv.example/liste.m3u')).resolves.toEqual(result);
        expect(invoke).toHaveBeenCalledWith('ingest_m3u', {
            url: 'http://tv.example/liste.m3u',
            dbName: 'nyxplayer_a.db',
            dnsProvider: 'system',
        });
        expect(invoke).not.toHaveBeenCalledWith('ingest_catalog', expect.anything());
        expect(invoke).toHaveBeenCalledWith('remap_epg', { dbName: 'nyxplayer_a.db' });
    });

    it('autre compte pendant la lecture : rien n\'est fait dans la base suivante', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'ingest_m3u') {
                currentDb = 'nyxplayer_b.db';
                return result;
            }
            return undefined;
        });
        await ingestM3uCatalog('http://tv.example/liste.m3u');
        expect(invoke).not.toHaveBeenCalledWith('remap_epg', expect.anything());
        warn.mockRestore();
    });
});

describe('cancelCatalogIngestion', () => {
    it('arrête la lecture Xtream et la lecture M3U', async () => {
        await cancelCatalogIngestion();
        expect(invoke).toHaveBeenCalledWith('cancel_catalog_ingestion');
        expect(invoke).toHaveBeenCalledWith('cancel_m3u_ingestion');
    });

    it('un échec de l\'un n\'empêche pas l\'autre', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === 'cancel_catalog_ingestion') throw new Error('x');
            return undefined;
        });
        await cancelCatalogIngestion();
        expect(invoke).toHaveBeenCalledWith('cancel_m3u_ingestion');
        warn.mockRestore();
    });
});
