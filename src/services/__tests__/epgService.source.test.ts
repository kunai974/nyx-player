/**
 * epgService — adresse du guide. Une version normale télécharge toujours la source
 * publique epgshare01 ; seule une version du banc de tests (VITE_BANC=1) lit le guide du faux
 * fournisseur qui lui sert de source.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const source = vi.hoisted(() => ({ creds: null as null | { host: string; username: string; password: string } }));
vi.mock('../storage', () => ({ StorageService: { getCredentials: vi.fn(async () => source.creds) } }));

import { epgSourceUrl } from '../epgService';
import { brancherOutilsTest } from '../outilsTest';
import { adresseGuideBanc } from '../../dev/bancAdresses';

// Guide factice branché comme le fait src/dev/prisesBanc.ts dans une version du banc ; la condition
// VITE_BANC=1 d'epgSourceUrl décide seule s'il sert.
brancherOutilsTest({ guideBanc: adresseGuideBanc });

const PUBLIQUE = 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz';
const FAUX = { host: 'http://127.0.0.1:8765', username: 'banc', password: 'banc' };

afterEach(() => {
  vi.unstubAllEnvs();
  source.creds = null;
});

describe('epgSourceUrl', () => {
  it('version normale : la source publique epgshare01, même avec un faux fournisseur pour source', async () => {
    vi.stubEnv('VITE_BANC', '');
    source.creds = FAUX;
    expect(await epgSourceUrl()).toBe(PUBLIQUE);
  });

  it('version d\'audit ordinaire (VITE_AUDIT=1 seul) : la source publique', async () => {
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '');
    source.creds = FAUX;
    expect(await epgSourceUrl()).toBe(PUBLIQUE);
  });

  it('version du banc, source = faux fournisseur : son xmltv', async () => {
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '1');
    source.creds = FAUX;
    expect(await epgSourceUrl()).toBe('http://127.0.0.1:8765/xmltv.php?username=banc&password=banc');
  });

  it('version du banc, source réelle ou absente : la source publique, jamais l\'hôte de la source', async () => {
    vi.stubEnv('VITE_AUDIT', '1');
    vi.stubEnv('VITE_BANC', '1');
    source.creds = { host: 'http://fournisseur.example:8080', username: 'u', password: 'p' };
    expect(await epgSourceUrl()).toBe(PUBLIQUE);
    source.creds = null;
    expect(await epgSourceUrl()).toBe(PUBLIQUE);
  });
});

describe('adresseGuideBanc', () => {
  it('seulement pour un faux fournisseur du banc (hôte et port fixes)', () => {
    expect(adresseGuideBanc({ ...FAUX, host: 'http://127.0.0.1:8766/' })).toBe('http://127.0.0.1:8766/xmltv.php?username=banc&password=banc');
    expect(adresseGuideBanc({ ...FAUX, host: 'http://127.0.0.1:8790' })).toBeNull(); // relais du vrai fournisseur
    expect(adresseGuideBanc({ ...FAUX, host: 'http://127.0.0.1:9999' })).toBeNull();
    expect(adresseGuideBanc({ ...FAUX, host: 'http://user@127.0.0.1:8765' })).toBeNull();
    expect(adresseGuideBanc(null)).toBeNull();
  });

  it('identifiants encodés dans l\'adresse', () => {
    expect(adresseGuideBanc({ host: 'http://127.0.0.1:8765', username: 'a&b', password: 'c d' })).toBe('http://127.0.0.1:8765/xmltv.php?username=a%26b&password=c%20d');
  });
});
