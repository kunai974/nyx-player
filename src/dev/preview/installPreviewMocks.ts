/**
 * installPreviewMocks.ts — Mode preview (DEV uniquement, jamais dans un build).
 *
 * Lance la vraie app dans un navigateur sans Tauri ni comptes réels :
 * - IPC Tauri simulé (@tauri-apps/api/mocks), SQLite réel via sql.js (WASM)
 * - Session Supabase factice + API REST/Edge Functions interceptées
 * - Images TMDB remplacées par des placeholders
 *
 * Activation : `npm run dev` puis http://localhost:1420/?preview=android (ou ?preview=windows)
 */

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import {
  CATEGORIES, PREVIEW_CREDS, PREVIEW_PROFILE_ID, PREVIEW_USER_ID,
  catalogRows, epgRows, tmdbMovie, tmdbMovieDetails, tmdbSeason, tmdbTv, tmdbTvDetails, xtreamSeriesInfo,
} from './fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any -- simulations du mode aperçu : sql.js et réponses d'API non typés */

const SQL_JS_VERSION = '1.11.0';
const SQL_JS_BASE = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist`;

type SqlDb = any;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function seedCatalog(db: SqlDb) {
  const { movies, series, live } = catalogRows();
  const insert = (sql: string, rows: any[], cols: string[]) => {
    const stmt = db.prepare(sql);
    rows.forEach((row) => stmt.run(cols.map((c) => row[c] ?? null)));
    stmt.free();
  };
  insert('INSERT OR REPLACE INTO categories (id, name, type, sort_order) VALUES (?, ?, ?, ?)',
    CATEGORIES.map((c, i) => ({ ...c, sort_order: i })), ['id', 'name', 'type', 'sort_order']);
  insert('INSERT OR REPLACE INTO movies (id, tmdb_id, name, icon, category_id, added, rating, container_extension, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    movies, ['id', 'tmdb_id', 'name', 'icon', 'category_id', 'added', 'rating', 'container_extension', 'sort_order']);
  insert('INSERT OR REPLACE INTO series (id, tmdb_id, name, icon, category_id, added, rating, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    series, ['id', 'tmdb_id', 'name', 'icon', 'category_id', 'added', 'rating', 'sort_order']);
  insert('INSERT OR REPLACE INTO live (id, name, icon, category_id, epg_channel_id, matched_epg_id, match_method, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    live, ['id', 'name', 'icon', 'category_id', 'epg_channel_id', 'matched_epg_id', 'match_method', 'sort_order']);
  insert('INSERT OR REPLACE INTO epg_programs (channel_id, title, start_ts, stop_ts, description) VALUES (?, ?, ?, ?, ?)',
    epgRows(), ['channel_id', 'title', 'start_ts', 'stop_ts', 'description']);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastProvider', ?)", [PREVIEW_CREDS.host]);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdate', ?)", [new Date().toISOString()]);
  // Un peu d'historique pour "Reprendre la lecture" et "Ma liste"
  const now = Date.now();
  movies.slice(0, 4).forEach((m, k) => {
    db.run(
      `INSERT OR REPLACE INTO playback_progress (content_type, stream_id, tmdb_id, title, poster_url, time_seconds, duration_seconds, updated_at, container_extension)
       VALUES ('movie', ?, ?, ?, ?, ?, 7080, ?, 'mp4')`,
      [m.id, m.tmdb_id, m.name, m.icon, 1200 + k * 900, now - k * 3600_000],
    );
    db.run('INSERT OR REPLACE INTO watchlist (stream_id, tmdb_id, type, added_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [m.id, m.tmdb_id, 'movie', now - k * 1000, now]);
  });
  series.slice(0, 3).forEach((s, k) => {
    db.run('INSERT OR REPLACE INTO watchlist (stream_id, tmdb_id, type, added_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [s.id, s.tmdb_id, 'series', now - 10_000 - k, now]);
  });
}

function toSqlValues(values: unknown): unknown[] {
  if (!Array.isArray(values)) return [];
  return values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

async function createSqlHandler() {
  await loadScript(`${SQL_JS_BASE}/sql-wasm.js`);
  const SQL = await (window as any).initSqlJs({ locateFile: (file: string) => `${SQL_JS_BASE}/${file}` });
  const dbs = new Map<string, { db: SqlDb; seeded: boolean }>();
  const getDb = (name: string) => {
    let entry = dbs.get(name);
    if (!entry) {
      entry = { db: new SQL.Database(), seeded: false };
      dbs.set(name, entry);
    }
    return entry;
  };

  return (cmd: string, args: any): unknown => {
    switch (cmd) {
      case 'nyx_db_load':
        getDb(args.db);
        return args.db;
      case 'nyx_db_close':
        return true;
      case 'nyx_db_execute': {
        const entry = getDb(args.db);
        const values = toSqlValues(args.values);
        if (values.length > 0) entry.db.run(args.query, values);
        else entry.db.exec(args.query);
        const changes = entry.db.getRowsModified();
        const lastId = entry.db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]?.[0] ?? 0;
        if (!entry.seeded && /CREATE TABLE IF NOT EXISTS movies/.test(args.query)) {
          entry.seeded = true;
          seedCatalog(entry.db);
        }
        return [changes, lastId];
      }
      case 'nyx_db_select': {
        const entry = getDb(args.db);
        const stmt = entry.db.prepare(args.query);
        stmt.bind(toSqlValues(args.values));
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      }
    }
    return undefined;
  };
}

function xtreamResponse(url: string): string {
  const parsed = new URL(url);
  const action = parsed.searchParams.get('action');
  if (!action) {
    return JSON.stringify({
      user_info: {
        username: 'preview', password: 'preview', auth: 1, status: 'Active', exp_date: '1893456000',
        is_trial: '0', active_cons: '0', created_at: '1700000000', max_connections: '2', allowed_output_formats: ['m3u8', 'ts'],
      },
      server_info: { url: 'preview.nyxplayer.local', port: '80', https_port: '443', server_protocol: 'http', timezone: 'Europe/Paris' },
    });
  }
  if (action === 'get_series_info') return JSON.stringify(xtreamSeriesInfo(Number(parsed.searchParams.get('series_id'))));
  if (action === 'get_vod_info') return JSON.stringify({ info: {}, movie_data: { stream_id: Number(parsed.searchParams.get('vod_id')), container_extension: 'mp4' } });
  return '[]';
}

function installSupabaseMock() {
  const supabaseUrl: string = import.meta.env.VITE_SUPABASE_URL;
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  // Session injectée par bootstrap.ts avant l'init du client Supabase
  const session = JSON.parse(localStorage.getItem(`sb-${projectRef}-auth-token`) ?? '{}');
  const user = session.user;

  const profile = {
    id: PREVIEW_PROFILE_ID, user_id: PREVIEW_USER_ID, display_name: 'Preview', avatar_color: '#A8D8F4',
    is_active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const tmdbList = (path: string) => {
    const tv = path.includes('/tv') && !path.includes('/movie');
    const mixed = path.includes('/trending/all') || path.includes('/search/multi');
    const results = mixed
      ? Array.from({ length: 20 }, (_, k) => (k % 2 ? tmdbTv(k % 20) : tmdbMovie(k % 40)))
      : tv
        ? Array.from({ length: 20 }, (_, k) => tmdbTv(k))
        : Array.from({ length: 20 }, (_, k) => tmdbMovie(k));
    return { page: 1, total_pages: 1, total_results: results.length, results };
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(supabaseUrl)) return realFetch(input, init);
    const { pathname } = new URL(url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (pathname.startsWith('/auth/v1/user')) return json(user);
    if (pathname.startsWith('/auth/v1/token')) return json(session);
    if (pathname.startsWith('/auth/v1/logout')) return new Response(null, { status: 204 });

    if (pathname.startsWith('/functions/v1/tmdb-proxy')) {
      const endpoint = pathname.replace('/functions/v1/tmdb-proxy', '');
      const season = endpoint.match(/^\/tv\/(\d+)\/season\/(\d+)/);
      if (season) return json(tmdbSeason(Number(season[1]), Number(season[2])));
      const movie = endpoint.match(/^\/movie\/(\d+)$/);
      if (movie) return json(tmdbMovieDetails(Number(movie[1])));
      const tv = endpoint.match(/^\/tv\/(\d+)$/);
      if (tv) return json(tmdbTvDetails(Number(tv[1])));
      if (endpoint.startsWith('/genre')) return json({ genres: [{ id: 28, name: 'Action' }, { id: 18, name: 'Drame' }] });
      return json(tmdbList(endpoint));
    }
    if (pathname.startsWith('/functions/v1/')) return json({ ok: true });

    if (pathname.startsWith('/rest/v1/')) {
      if (method !== 'GET' && method !== 'HEAD') return new Response('[]', { status: 201, headers: { 'Content-Type': 'application/json' } });
      if (pathname.startsWith('/rest/v1/user_profiles')) return json([profile]);
      return json([]);
    }
    return json({});
  };
}

/** Remplace les images TMDB (hors ligne ici) par des placeholders déterministes. */
function installImageRewrite() {
  const rewrite = (value: string): string => {
    const match = value.match(/image\.tmdb\.org\/t\/p\/(\w+)\/([^"')\s]+)/);
    if (!match) return value;
    const [, size, file] = match;
    const seed = file.replace(/\.\w+$/, '');
    const backdrop = seed.includes('backdrop') || seed.includes('still') || size === 'w1280' || size === 'original';
    const person = seed.includes('person');
    const [w, h] = backdrop ? [1280, 720] : person ? [185, 185] : [342, 513];
    return value.replace(match[0], `picsum.photos/seed/${seed}/${w}/${h}`);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...srcDescriptor,
    set(this: HTMLImageElement, value: string) {
      srcDescriptor.set!.call(this, rewrite(String(value)));
    },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    return setAttribute.call(this, name, name === 'src' || name === 'style' ? rewrite(String(value)) : value);
  };
  // Styles inline posés par React (style.backgroundImage = …) : pas d'accesseur patchable, on observe le DOM
  const fixStyle = (el: HTMLElement) => {
    const bg = el.style?.backgroundImage;
    if (bg && bg.includes('image.tmdb.org')) el.style.backgroundImage = rewrite(bg);
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target instanceof HTMLElement) fixStyle(m.target);
      m.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        fixStyle(node);
        node.querySelectorAll<HTMLElement>('[style*="image.tmdb.org"]').forEach(fixStyle);
      });
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
}

// Partagés avec tauriCoreShim.ts (Symbol.for = même symbole entre modules)
const PASS_THROUGH = Symbol.for('nyx-preview-pass');
const PASS_WITH_ARGS = Symbol.for('nyx-preview-pass-with-args');
const DEFAULT_PREVIEW_STREAM_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
/**
 * Flux joué à la place des flux Xtream factices. `?previewStream=<url>` permet de tester un cas précis,
 * ex. un petit serveur local qui répond HTTP 458 (limite de connexions) :
 *   émulateur → http://10.0.2.2:8458/live/x.ts · desktop → http://127.0.0.1:8458/live/x.ts
 */
const PREVIEW_STREAM_URL = new URLSearchParams(location.search).get('previewStream') || DEFAULT_PREVIEW_STREAM_URL;

export async function installPreviewMocks(): Promise<void> {
  const platform = new URLSearchParams(location.search).get('preview') || 'android';
  const sql = await createSqlHandler();
  const credsJson = JSON.stringify(PREVIEW_CREDS);
  // Session Supabase factice : sur Android elle vit dans le coffre (authStorage.ts), simulé ici en mémoire
  const authVault = new Map<string, string>();

  // Commandes "données" simulées ; le reste part vers le vrai backend quand il existe.
  const dataHandler = (cmd: string, args: any): unknown => {
    // Base SQLite : commandes gardées de secure_db.rs (plus de plugin:sql depuis la page)
    if (cmd.startsWith('nyx_db_')) return sql(cmd, args);
    switch (cmd) {
      case 'nyx_secret_get':
        return credsJson;
      case 'plugin:nyx-android|secure_get': {
        const key = String(args?.key ?? '');
        if (key.startsWith('supabase-auth::')) return { value: authVault.get(key) ?? null };
        return { value: key.includes('iptv_credentials') ? credsJson : null };
      }
      case 'plugin:nyx-android|secure_set':
        if (String(args?.key ?? '').startsWith('supabase-auth::')) { authVault.set(args.key, args.value); return null; }
        break;
      case 'plugin:nyx-android|secure_delete':
        if (String(args?.key ?? '').startsWith('supabase-auth::')) { authVault.delete(args.key); return null; }
        break;
      case 'iptv_fetch':
      case 'iptv_fetch_public':
        return xtreamResponse(args.url);
      case 'cancel_catalog_ingestion':
        return null;
      case 'ingest_catalog':
        return { movies_count: 40, series_count: 20, live_count: 36, categories_count: 11, duration_ms: 10, partial: false, failed_endpoints: [], logs: [] };
      case 'fetch_and_parse_epg':
        return { programs_count: 0, channels_count: 0, duration_ms: 0, logs: [] };
      case 'plugin:nyx-android|play':
        // Flux Xtream factices → flux de test public, joué par le vrai lecteur natif
        return { [PASS_WITH_ARGS]: { ...args, url: PREVIEW_STREAM_URL } };
      case 'nyx_mpv_command': {
        // Desktop : même substitution pour le vrai MPV (garde Rust)
        if (args?.name === 'loadfile' && Array.isArray(args.args)) {
          return { [PASS_WITH_ARGS]: { ...args, args: [PREVIEW_STREAM_URL, ...args.args.slice(1)] } };
        }
        break;
      }
      case 'probe_stream_status':
        // La sonde doit viser le flux réellement joué, pas l'URL Xtream factice
        return { [PASS_WITH_ARGS]: { ...args, url: PREVIEW_STREAM_URL } };
    }
    return PASS_THROUGH;
  };

  // Vraie WebView Tauri (ex. émulateur Android) : window.__TAURI_INTERNALS__ est verrouillé,
  // l'interception passe par tauriCoreShim.ts (alias Vite activé par NYX_PREVIEW=1).
  (window as any).__NYX_PREVIEW_HANDLER__ = dataHandler;

  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    // Navigateur sans Tauri : tout est simulé
    mockWindows('main');
    mockIPC((cmd, args: any) => {
      const result = dataHandler(cmd, args);
      if (result !== PASS_THROUGH) return result;
      switch (cmd) {
        case 'plugin:nyx-android|get_property':
          return { value: null };
        case 'plugin:app|version':
          return '0.7.6';
        case 'plugin:app|name':
          return 'Nyx Player';
        case 'plugin:app|tauri_version':
          return '2.10.3';
        case 'plugin:path|resolve_directory':
          return '/preview';
        case 'get_app_setting':
          return 'true';
      }
      return null;
    }, { shouldMockEvents: true });
  }

  installSupabaseMock();
  installImageRewrite();
  console.info(`[Preview] Mocks installed (platform=${platform}, tauri=${Boolean(internals?.invoke)})`);
}
