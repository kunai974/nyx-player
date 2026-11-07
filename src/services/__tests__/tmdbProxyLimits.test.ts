/**
 * Relais TMDB (supabase/functions/tmdb-proxy) : un compte ne doit pas pouvoir remplir la base.
 *
 * Le relais écrit chaque réponse de TMDB dans la table `tmdb_cache`. Avant ce correctif, un compte
 * gratuit pouvait y écrire sans limite : langue inventée (`xx-XX`, 26⁴ codes), même fiche sous
 * plusieurs numéros (`550`, `0550`…), recherches libres gardées 7 jours (aujourd'hui : 24 h, budget à part), aucune taille maximale.
 *
 * La fonction tourne sous Deno (imports jsr:/npm:), elle ne s'importe pas telle quelle : on transpile
 * le vrai fichier et on l'exécute avec de fausses dépendances (vérification du jeton, base, TMDB).
 * Tout le chemin d'une requête est donc celui de la production, sauf le réseau.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const functionsRoot = resolve(__dirname, '../../../supabase/functions');
const ISSUER = 'https://projet.supabase.co/auth/v1';

/** Jetons simulés : la signature est vérifiée par la fausse bibliothèque, seule la charge compte. */
const TOKENS: Record<string, Record<string, unknown>> = {
  'compte-a': { sub: 'a', iss: ISSUER, aud: 'authenticated', role: 'authenticated' },
  anonyme: { sub: 'x', iss: ISSUER, aud: 'authenticated', role: 'authenticated', is_anonymous: true },
  'autre-audience': { sub: 'y', iss: ISSUER, aud: 'autre', role: 'autre' },
};

class FakeJwtError extends Error {
  constructor(name: string) {
    super(`${name}: jeton refusé`);
    this.name = name;
  }
}

const fakeJose = {
  createRemoteJWKSet: () => ({}),
  jwtVerify: async (token: string, _keys: unknown, options: { issuer?: string; audience?: string }) => {
    const payload = TOKENS[token];
    if (!payload) throw new FakeJwtError('JWSSignatureVerificationFailed');
    if (options.issuer && payload.iss !== options.issuer) throw new FakeJwtError('JWTClaimValidationFailed');
    if (options.audience !== undefined) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(options.audience)) throw new FakeJwtError('JWTClaimValidationFailed');
    }
    return { payload };
  },
};

interface CacheRow {
  cache_key: string;
  data: unknown;
  cached_at: string;
  ttl_seconds: number;
}

interface RelayOptions {
  /** Lignes déjà présentes dans tmdb_cache */
  rows?: CacheRow[];
  /** Réponse de TMDB (par défaut : petite fiche qui cite l'adresse demandée) */
  tmdb?: (url: URL) => unknown;
  /** TMDB injoignable : fetch lève une erreur qui cite l'adresse, comme Deno */
  networkDown?: boolean;
  /** Réponse de la base aux limites des invités (public.nyx_invite_demande) ; absente : la base n'a pas l'opération */
  rpc?: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Charge un module des fonctions serveur (transpilé en CommonJS), avec les imports simulés. */
function loadModule(path: string, external: Record<string, unknown>, globals: Record<string, unknown>) {
  const source = readFileSync(path, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const localRequire = (spec: string) => {
    if (spec in external) return external[spec];
    if (spec.startsWith('.')) return loadModule(resolve(dirname(path), spec), external, globals);
    throw new Error(`import inattendu dans la fonction : ${spec}`);
  };
  const names = Object.keys(globals);
  new Function('exports', 'require', 'module', ...names, js)(
    module.exports,
    localRequire,
    module,
    ...names.map((n) => globals[n]),
  );
  return module.exports;
}

function loadRelay(options: RelayOptions = {}) {
  const table = new Map<string, CacheRow>((options.rows ?? []).map((r) => [r.cache_key, r]));
  const tmdbCalls: string[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const logs: unknown[][] = [];
  let handler: ((req: Request) => Promise<Response>) | undefined;

  const fakeAdmin = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (!options.rpc) return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
      return options.rpc(fn, args);
    },
    from(name: string) {
      if (name !== 'tmdb_cache') throw new Error(`table inattendue : ${name}`);
      return {
        select(_columns: string, selectOptions?: { count?: string; head?: boolean }) {
          const all = { data: selectOptions?.head ? null : [...table.values()], count: table.size, error: null };
          const one = async (key: string) => {
            const row = table.get(key);
            return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } };
          };
          return {
            eq: (_column: string, key: string) => ({ single: () => one(key), maybeSingle: () => one(key) }),
            not: (_column: string, _op: string, pattern: string) => {
              const prefix = pattern.replace(/%$/, '');
              const count = [...table.keys()].filter((k) => !k.startsWith(prefix)).length;
              return Promise.resolve({ data: null, count, error: null });
            },
            like: (_column: string, pattern: string) => {
              const prefix = pattern.replace(/%$/, '');
              const count = [...table.keys()].filter((k) => k.startsWith(prefix)).length;
              return Promise.resolve({ data: null, count, error: null });
            },
            then: (ok: (v: typeof all) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(all).then(ok, ko),
          };
        },
        async upsert(row: CacheRow) {
          table.set(row.cache_key, row);
          return { error: null };
        },
      };
    },
  };

  const fakeFetch = async (input: string) => {
    const url = new URL(input);
    tmdbCalls.push(`${url.pathname}${url.search}`);
    if (options.networkDown) throw new TypeError(`error sending request for url (${url.toString()})`);
    const body = options.tmdb ? options.tmdb(url) : url.pathname.includes('/search/')
      ? { path: url.pathname, page: 1, results: [{ id: 1 }] }
      : { path: url.pathname, page: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const env: Record<string, string> = { SUPABASE_URL: 'https://projet.supabase.co', TMDB_TOKEN: 'jeton-tmdb-essai' };
  const fakeConsole = {
    log: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
  };
  loadModule(
    resolve(functionsRoot, 'tmdb-proxy/index.ts'),
    {
      'jsr:@supabase/functions-js/edge-runtime.d.ts': {},
      'npm:@supabase/supabase-js@2': { createClient: () => fakeAdmin },
      'jsr:@panva/jose@6': fakeJose,
    },
    {
      Deno: { env: { get: (k: string) => env[k] }, serve: (h: typeof handler) => { handler = h; } },
      fetch: fakeFetch,
      console: fakeConsole,
    },
  );
  if (!handler) throw new Error('Deno.serve jamais appelé');
  const serve = handler;

  const call = (path: string, token = 'compte-a', headers: Record<string, string> = {}) =>
    serve(
      new Request(`https://projet.supabase.co/tmdb-proxy${path}`, {
        headers: { Authorization: `Bearer ${token}`, Origin: 'http://tauri.localhost', ...headers },
      }),
    );
  return { call, table, tmdbCalls, rpcCalls, logs };
}

/** Plafond du cache, lu dans le module partagé du relais (même fichier que la production). */
function cacheMaxRows(): number {
  const shared = loadModule(resolve(functionsRoot, '_shared/tmdbRequest.ts'), {}, {});
  return shared.TMDB_CACHE_MAX_ROWS as number;
}

function rows(count: number): CacheRow[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    cache_key: `movie:${i + 1}:fr-FR`,
    data: { id: i + 1 },
    cached_at: now,
    ttl_seconds: 604800,
  }));
}

describe('relais TMDB : usage normal de l\'app inchangé', () => {
  it.each([
    ['/movie/550?language=fr-FR&append_to_response=credits', 'movie:550:fr-FR'],
    ['/tv/1399?language=en-US', 'tv:1399:en-US'],
    ['/tv/1399/season/0?language=fr-FR', 'season:1399:0:fr-FR'],
    ['/tv/1399/season/2?language=fr-FR', 'season:1399:2:fr-FR'],
    ['/trending/all/week?language=fr-FR', 'trending:week:fr-FR'],
    ['/movie/now_playing?language=en-US', 'now_playing:en-US'],
    ['/tv/on_the_air?language=fr-FR', 'on_the_air:fr-FR'],
    ['/movie/top_rated?language=fr-FR', 'top_rated:movie:fr-FR'],
    ['/movie/popular?language=fr-FR', 'popular:fr-FR'],
    ['/movie/550/recommendations?language=fr-FR', 'movie_reco:550:fr-FR'],
    ['/discover/tv?with_genres=18&sort_by=popularity.desc&language=fr-FR', 'genre:18:tv:fr-FR'],
  ])('%s : servi puis gardé en cache', async (path, key) => {
    const relay = loadRelay();
    const first = await relay.call(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache-Status')).toBe('MISS');
    expect([...relay.table.keys()]).toEqual([key]);
    const second = await relay.call(path);
    expect(second.headers.get('X-Cache-Status')).toBe('HIT');
    expect(relay.tmdbCalls).toHaveLength(1);
  });

  it('sans langue : anglais, comme avant', async () => {
    const relay = loadRelay();
    expect((await relay.call('/movie/550')).status).toBe(200);
    expect([...relay.table.keys()]).toEqual(['movie:550:en-US']);
  });

  it('les recherches de l\'app restent servies (titre, année)', async () => {
    const relay = loadRelay();
    const movie = await relay.call('/search/movie?query=Le%20Parrain&year=1972&language=fr-FR');
    const tv = await relay.call('/search/tv?query=Dark&first_air_date_year=2017&language=fr-FR');
    expect([movie.status, tv.status]).toEqual([200, 200]);
    expect(await movie.json()).toEqual({ path: '/3/search/movie', page: 1, results: [{ id: 1 }] });
  });
});

describe('relais TMDB : un compte ne peut plus remplir le cache', () => {
  it('refuse une langue inventée, sans appeler TMDB ni écrire', async () => {
    const relay = loadRelay();
    for (const language of ['xx-XX', 'fr-CA', 'de', 'fr', 'en']) {
      expect((await relay.call(`/movie/550?language=${language}`)).status).toBe(400);
    }
    expect(relay.tmdbCalls).toEqual([]);
    expect(relay.table.size).toBe(0);
  });

  it('une même fiche demandée avec des zéros devant ne crée pas de nouvelle ligne', async () => {
    const relay = loadRelay();
    for (const path of ['/movie/550', '/movie/0550', '/movie/000550']) {
      expect((await relay.call(`${path}?language=fr-FR`)).status).toBe(200);
    }
    expect([...relay.table.keys()]).toEqual(['movie:550:fr-FR']);
    expect(relay.tmdbCalls).toEqual([expect.stringMatching(/^\/3\/movie\/550\?/)]);
    await relay.call('/tv/01399/season/02?language=fr-FR');
    expect(relay.table.has('season:1399:2:fr-FR')).toBe(true);
  });

  it('refuse un numéro démesuré ou nul', async () => {
    const relay = loadRelay();
    expect((await relay.call('/movie/12345678901?language=fr-FR')).status).toBe(400);
    expect((await relay.call(`/movie/${'0'.repeat(40)}1?language=fr-FR`)).status).toBe(400);
    expect((await relay.call('/movie/0?language=fr-FR')).status).toBe(400);
    expect((await relay.call('/tv/1399/season/12345?language=fr-FR')).status).toBe(400);
    expect(relay.table.size).toBe(0);
  });

  it('borne la liste de genres et la range dans un ordre unique', async () => {
    const relay = loadRelay();
    expect((await relay.call('/discover/movie?with_genres=28,12,16,35,80,99&language=fr-FR')).status).toBe(400);
    expect((await relay.call(`/discover/movie?with_genres=${'9'.repeat(50)}&language=fr-FR`)).status).toBe(400);
    expect((await relay.call('/discover/movie?with_genres=12,028&language=fr-FR')).status).toBe(200);
    expect((await relay.call('/discover/movie?with_genres=28,12&language=fr-FR')).status).toBe(200);
    expect([...relay.table.keys()]).toEqual(['genre:12,28:movie:fr-FR']);
  });

  it('garde les recherches dans le cache, sous une clé normalisée et un budget à part', async () => {
    const relay = loadRelay();
    const first = await relay.call('/search/movie?query=Star%20%20Wars&year=1977&language=fr-FR');
    expect(first.headers.get('X-Cache-Status')).toBe('MISS');
    // Même titre écrit autrement (majuscules, espaces) : même ligne, pas de nouvel appel à TMDB
    const second = await relay.call('/search/movie?query=%20star%20wars%20&year=1977&language=fr-FR');
    expect(second.headers.get('X-Cache-Status')).toBe('HIT');
    expect(relay.tmdbCalls).toHaveLength(1);
    // Autre année, autre type, autre langue : autres lignes
    await relay.call('/search/movie?query=star%20wars&language=fr-FR');
    await relay.call('/search/tv?query=star%20wars&language=fr-FR');
    await relay.call('/search/movie?query=star%20wars&year=1977&language=en-US');
    expect([...relay.table.keys()].sort()).toEqual([
      'search:movie:en-US:1977:star wars',
      'search:movie:fr-FR:-:star wars',
      'search:movie:fr-FR:1977:star wars',
      'search:tv:fr-FR:-:star wars',
    ]);
  });

  it('une recherche sans aucun résultat est servie mais jamais gardée', async () => {
    const relay = loadRelay({ tmdb: () => ({ page: 1, results: [], total_results: 0 }) });
    const res = await relay.call('/search/movie?query=titre%20qui%20nexiste%20pas&language=fr-FR');
    expect(res.status).toBe(200);
    expect(relay.table.size).toBe(0);
    await relay.call('/search/movie?query=titre%20qui%20nexiste%20pas&language=fr-FR');
    expect(relay.tmdbCalls).toHaveLength(2);
  });

  it('une recherche trop courte ou trop longue pour un titre est servie mais jamais gardée', async () => {
    const relay = loadRelay();
    for (const query of ['a', 'x'.repeat(81)]) {
      expect((await relay.call(`/search/movie?query=${query}&language=fr-FR`)).status).toBe(200);
    }
    expect(relay.table.size).toBe(0);
  });

  it('budget des recherches plein : servie mais pas écrite, et les fiches restent écrites', async () => {
    const shared = loadModule(resolve(functionsRoot, '_shared/tmdbRequest.ts'), {}, {});
    const searchMax = shared.TMDB_SEARCH_CACHE_MAX_ROWS as number;
    const now = new Date().toISOString();
    const full: CacheRow[] = Array.from({ length: searchMax }, (_, i) => ({
      cache_key: `search:movie:fr-FR:-:titre ${i}`, data: {}, cached_at: now, ttl_seconds: 86400,
    }));
    const relay = loadRelay({ rows: full });
    expect((await relay.call('/search/movie?query=nouveau%20titre&language=fr-FR')).status).toBe(200);
    expect(relay.table.has('search:movie:fr-FR:-:nouveau titre')).toBe(false);
    expect((await relay.call('/movie/550?language=fr-FR')).status).toBe(200);
    expect(relay.table.has('movie:550:fr-FR')).toBe(true);
  });

  it('des recherches fabriquées ne réduisent pas la place des fiches (plafond général compté sans elles)', async () => {
    const shared = loadModule(resolve(functionsRoot, '_shared/tmdbRequest.ts'), {}, {});
    const searchMax = shared.TMDB_SEARCH_CACHE_MAX_ROWS as number;
    const now = new Date().toISOString();
    const searches: CacheRow[] = Array.from({ length: searchMax }, (_, i) => ({
      cache_key: `search:movie:fr-FR:-:titre ${i}`, data: {}, cached_at: now, ttl_seconds: 86400,
    }));
    // Autant de fiches que le plafond général moins une : la dernière place doit rester libre malgré les recherches
    const relay = loadRelay({ rows: [...searches, ...rows(cacheMaxRows() - 1)] });
    expect((await relay.call('/movie/999999?language=fr-FR')).status).toBe(200);
    expect(relay.table.has('movie:999999:fr-FR')).toBe(true);
  });

  it('une recherche périmée est rafraîchie même budget plein, sans ligne en plus', async () => {
    const shared = loadModule(resolve(functionsRoot, '_shared/tmdbRequest.ts'), {}, {});
    const searchMax = shared.TMDB_SEARCH_CACHE_MAX_ROWS as number;
    const now = new Date().toISOString();
    const full: CacheRow[] = Array.from({ length: searchMax }, (_, i) => ({
      cache_key: `search:movie:fr-FR:-:titre ${i}`, data: { vieux: true }, cached_at: now, ttl_seconds: 86400,
    }));
    full[0] = { ...full[0], cached_at: '2026-01-01T00:00:00.000Z' };
    const relay = loadRelay({ rows: full });
    const res = await relay.call('/search/movie?query=titre%200&language=fr-FR');
    expect(res.headers.get('X-Cache-Status')).toBe('MISS');
    expect(relay.table.size).toBe(searchMax);
    expect(relay.table.get('search:movie:fr-FR:-:titre 0')?.cached_at).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('cache plein : la fiche est servie mais n\'est plus écrite', async () => {
    const TMDB_CACHE_MAX_ROWS = cacheMaxRows();
    const relay = loadRelay({ rows: rows(TMDB_CACHE_MAX_ROWS) });
    const res = await relay.call('/movie/999999?language=fr-FR');
    expect(res.status).toBe(200);
    expect(relay.table.size).toBe(TMDB_CACHE_MAX_ROWS);
    expect(relay.table.has('movie:999999:fr-FR')).toBe(false);
  });

  it('cache plein : une fiche déjà présente mais périmée est quand même rafraîchie (pas de ligne en plus)', async () => {
    const TMDB_CACHE_MAX_ROWS = cacheMaxRows();
    const full = rows(TMDB_CACHE_MAX_ROWS);
    full[0] = { ...full[0], cached_at: '2026-01-01T00:00:00.000Z' };
    const relay = loadRelay({ rows: full });
    expect((await relay.call('/movie/1?language=fr-FR')).headers.get('X-Cache-Status')).toBe('MISS');
    expect(relay.table.get('movie:1:fr-FR')?.cached_at).not.toBe('2026-01-01T00:00:00.000Z');
    expect(relay.table.size).toBe(TMDB_CACHE_MAX_ROWS);
  });

  it('une réponse démesurée de TMDB est servie mais pas écrite', async () => {
    const relay = loadRelay({ tmdb: () => ({ blob: 'x'.repeat(1_100_000) }) });
    expect((await relay.call('/movie/550?language=fr-FR')).status).toBe(200);
    expect(relay.table.size).toBe(0);
  });
});

describe('relais TMDB : journaux sans recherche ni adresse', () => {
  it('TMDB injoignable : ni le titre recherché ni l\'adresse dans les journaux', async () => {
    const relay = loadRelay({ networkDown: true });
    const res = await relay.call('/search/movie?query=Titre%20tres%20personnel&language=fr-FR');
    expect(res.status).toBe(500);
    const written = JSON.stringify(relay.logs);
    expect(written).not.toMatch(/Titre|personnel|themoviedb|query=/);
    expect(written).toContain('TypeError');
  });
});

describe('relais TMDB : comptes connectés, et invités dans leurs limites', () => {
  it('refuse un invité tant que la base n\'a pas les limites des invités (fermé par défaut)', async () => {
    const relay = loadRelay();
    expect((await relay.call('/movie/550?language=fr-FR', 'anonyme')).status).toBe(503);
    expect(relay.tmdbCalls).toEqual([]);
  });

  it('refuse un jeton d\'une autre audience', async () => {
    const relay = loadRelay();
    expect((await relay.call('/movie/550?language=fr-FR', 'autre-audience')).status).toBe(401);
  });

  it('refuse un jeton inconnu (inchangé)', async () => {
    const relay = loadRelay();
    expect((await relay.call('/movie/550?language=fr-FR', 'faux')).status).toBe(401);
  });
});

describe('relais TMDB : invités (connexion anonyme), limites tenues par la base', () => {
  const allowed = async () => ({ data: { allowed: true }, error: null });

  it('sert un invité quand la base dit oui, et demande pour CET invité et cette adresse', async () => {
    const relay = loadRelay({ rpc: allowed });
    const res = await relay.call('/movie/550?language=fr-FR', 'anonyme', { 'cf-connecting-ip': '192.0.2.7' });
    expect(res.status).toBe(200);
    expect(relay.rpcCalls).toEqual([{ fn: 'nyx_invite_demande', args: { p_invite: 'x', p_adresse: '192.0.2.7' } }]);
    expect(relay.tmdbCalls).toHaveLength(1);
  });

  it('compte aussi une réponse déjà en cache (chaque appel coûte au quota)', async () => {
    const relay = loadRelay({ rpc: allowed });
    await relay.call('/movie/550?language=fr-FR', 'anonyme');
    await relay.call('/movie/550?language=fr-FR', 'anonyme');
    expect(relay.rpcCalls).toHaveLength(2);
    expect(relay.tmdbCalls).toHaveLength(1);
  });

  it.each([
    ['minute', '2026-11-02T10:01:00Z'],
    ['day', '2026-11-03T00:00:00Z'],
    ['address', '2026-11-03T00:00:00Z'],
    ['budget', '2026-11-03T00:00:00Z'],
    ['off', '2026-11-03T00:00:00Z'],
  ])('refus « %s » : 429 avec la raison et l\'heure de reprise, sans appeler TMDB', async (reason, retryAt) => {
    const relay = loadRelay({ rpc: async () => ({ data: { allowed: false, reason, retry_at: retryAt }, error: null }) });
    const res = await relay.call('/movie/550?language=fr-FR', 'anonyme');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Guest limit reached', reason, retry_at: retryAt });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(relay.tmdbCalls).toEqual([]);
  });

  it.each([
    ['une erreur de la base', async () => ({ data: null, error: { message: 'boom' } })],
    ['une réponse vide', async () => ({ data: null, error: null })],
    ['un « allowed » qui n\'est pas exactement vrai', async () => ({ data: { allowed: 'true' }, error: null })],
    ['une exception', async () => { throw new Error('réseau'); }],
  ])('refuse l\'invité sur %s (jamais une demande sans être comptée)', async (_cas, rpc) => {
    const relay = loadRelay({ rpc: rpc as RelayOptions['rpc'] });
    expect((await relay.call('/movie/550?language=fr-FR', 'anonyme')).status).toBe(503);
    expect(relay.tmdbCalls).toEqual([]);
  });

  it('invité effacé par la purge (jeton encore signé) : 401, l\'app se reconnecte au lieu de réessayer', async () => {
    const relay = loadRelay({ rpc: async () => ({ data: { allowed: false, reason: 'unknown' }, error: null }) });
    expect((await relay.call('/movie/550?language=fr-FR', 'anonyme')).status).toBe(401);
    expect(relay.tmdbCalls).toEqual([]);
  });

  it('un compte connecté ne passe jamais par les limites des invités', async () => {
    const relay = loadRelay();
    expect((await relay.call('/movie/550?language=fr-FR', 'compte-a')).status).toBe(200);
    expect(relay.rpcCalls).toEqual([]);
  });

  it('les journaux ne citent ni l\'adresse ni l\'invité', async () => {
    const relay = loadRelay({ rpc: async () => ({ data: null, error: { message: 'boom' } }) });
    await relay.call('/movie/550?language=fr-FR', 'anonyme', { 'cf-connecting-ip': '192.0.2.77' });
    const written = JSON.stringify(relay.logs);
    expect(written).not.toContain('192.0.2.77');
    expect(written).not.toContain('"x"');
  });
});

describe('relais TMDB : un invité qui insiste au-delà de 60 par minute', () => {
  it('est arrêté avant d\'interroger la base (chaque appel à la base coûte aussi)', async () => {
    const relay = loadRelay({ rpc: async () => ({ data: { allowed: false, reason: 'minute', retry_at: null }, error: null }) });
    for (let i = 0; i < 60; i++) await relay.call('/movie/550?language=fr-FR', 'anonyme');
    expect(relay.rpcCalls).toHaveLength(60);
    expect((await relay.call('/movie/550?language=fr-FR', 'anonyme')).status).toBe(429);
    expect(relay.rpcCalls).toHaveLength(60);
  });
});

describe('relais TMDB : base trop lente pour un invité', () => {
  it('refuse l\'invité après 3 s sans réponse de la base, sans appeler TMDB', async () => {
    const relay = loadRelay({ rpc: () => new Promise(() => {}) });
    const started = Date.now();
    expect((await relay.call('/movie/550?language=fr-FR', 'anonyme')).status).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect(relay.tmdbCalls).toEqual([]);
  }, 8000);
});
