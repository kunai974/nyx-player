import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as jose from "jsr:@panva/jose@6";
import {
  mayWriteCache,
  mayWriteSearchCache,
  searchResultCount,
  normalizeSearchQuery,
  searchCacheKey,
  normalizeGenres,
  normalizeLanguage,
  normalizeSeasonNumber,
  normalizeTmdbId,
} from "../_shared/tmdbRequest.ts";
import { isGuestToken, isSignedInAccount, TOKEN_AUDIENCE } from "../_shared/tokenClaims.ts";
import { clientAddress, guestVerdict, retryAfterSeconds } from "../_shared/guestQuota.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  BATCH_CONCURRENCY,
  type BatchItem,
  mapWithLimit,
  parseBatchItems,
  slimSearchAnswer,
} from "../_shared/tmdbBatch.ts";

// CORS: the app's origins only (shared list, see ../_shared/cors.ts)
const getCorsHeaders = (req: Request) => corsHeaders(req, "GET, OPTIONS");

// ============================================================================
// JWT VERIFICATION — Asymmetric JWKS (official Supabase pattern)
// Uses the project's public JWKS endpoint to verify JWT signatures.
// This replaces the gateway verify_jwt flag which is incompatible with
// new asymmetric JWT signing keys and Tauri origins.
// Ref: https://supabase.com/docs/guides/functions/auth
// ============================================================================

const SUPABASE_JWT_ISSUER =
  Deno.env.get("SB_JWT_ISSUER") ?? Deno.env.get("SUPABASE_URL") + "/auth/v1";

const SUPABASE_JWT_KEYS = jose.createRemoteJWKSet(
  new URL(Deno.env.get("SUPABASE_URL")! + "/auth/v1/.well-known/jwks.json")
);

/** Who is calling: a signed-in account, or a guest (anonymous sign-in, counted in the database). */
interface Caller {
  userId: string;
  guest: boolean;
}

async function verifyCaller(req: Request): Promise<Caller> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer" || !token) {
    throw new Error("Auth header is not 'Bearer {token}'");
  }

  // Verify signature + expiration + issuer + audience cryptographically
  const { payload } = await jose.jwtVerify(token, SUPABASE_JWT_KEYS, {
    issuer: SUPABASE_JWT_ISSUER,
    audience: TOKEN_AUDIENCE,
  });
  const claims = payload as Record<string, unknown>;
  // A guest token is told apart here; the account check itself is unchanged
  const guest = isGuestToken(claims);
  if (!guest && !isSignedInAccount(claims)) {
    throw new Error("Invalid token: not a signed-in account");
  }

  const userId = payload.sub;
  if (!userId) {
    throw new Error("Invalid token: missing user ID (sub claim)");
  }

  return { userId, guest };
}

// ============================================================================
// GUEST LIMITS — asked to the database on every guest request (closed by default)
// ============================================================================

/** Longest wait for the database's answer before a guest is refused */
const GUEST_QUOTA_TIMEOUT_MS = 3000;

async function askGuestQuota(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  address: string | null,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GUEST_QUOTA_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      supabaseAdmin.rpc("nyx_invite_demande", { p_invite: userId, p_adresse: address }),
      timeout,
    ]);
    return guestVerdict(result as { data?: unknown; error?: unknown } | null);
  } catch {
    return guestVerdict(null);
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// TMDB CONFIG
// ============================================================================

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_TOKEN = Deno.env.get("TMDB_TOKEN") ?? "";

if (!TMDB_TOKEN) {
  console.error("[tmdb-proxy] FATAL: TMDB_TOKEN is not set — all TMDB requests will fail");
}

const TTL_DETAILS = 604800;  // 7 days
const TTL_LISTS = 86400;     // 24 hours
const TTL_SEARCH = 604800;   // 7 days: titles of a list are searched again by every user; a title TMDB adds today is found within a week

// ============================================================================
// HELPERS
// ============================================================================

type CorsHeaders = Record<string, string>;

function jsonResponse(data: unknown, cors: CorsHeaders, status = 200, cacheStatus = "MISS") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "X-Cache-Status": cacheStatus,
    },
  });
}

function errorResponse(message: string, cors: CorsHeaders, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** TMDB answered with a non-2xx status (kept so a 404 is returned as a 404, not a 500). */
// No TypeScript parameter property here: the Supabase bundler only strips types and refuses them
// (the deploy failed with an internal error).
class TmdbHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ============================================================================
// PARAMETER WHITELISTS (free params let callers reach any TMDB endpoint)
// Languages, ids and genres are normalised in _shared/tmdbRequest.ts (every value
// that ends up in a cache key is closed or normalised, so an account cannot fill the database).
// ============================================================================

const YEAR_RE = /^\d{4}$/;
const MAX_QUERY_LENGTH = 200;
const WINDOWS = new Set(["day", "week"]);
const MEDIA_TYPES = new Set(["movie", "tv"]);

/** Fetch from TMDB API with Bearer token */
async function fetchTmdb(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${TMDB_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new TmdbHttpError(response.status, `TMDB API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ============================================================================
// CACHE LOGIC
// ============================================================================

interface CacheResult {
  data: unknown;
  cacheStatus: "HIT" | "MISS" | "BYPASS";
}

async function getOrFetchCached(
  supabaseAdmin: ReturnType<typeof createClient>,
  cacheKey: string,
  ttlSeconds: number,
  fetchFn: () => Promise<unknown>
): Promise<CacheResult> {
  // 1. Check cache
  const { data: cached } = await supabaseAdmin
    .from("tmdb_cache")
    .select("data, cached_at")
    .eq("cache_key", cacheKey)
    .single();

  if (cached) {
    const cachedAt = new Date(cached.cached_at).getTime() / 1000;
    const now = Date.now() / 1000;
    if (now - cachedAt < ttlSeconds) {
      return { data: cached.data, cacheStatus: "HIT" };
    }
  }

  // 2. Cache MISS or STALE → fetch from TMDB
  const freshData = await fetchFn();

  // 3. Store in cache (upsert), only while the cache is under its cap: a full cache
  //    still answers, it just stops growing. Refreshing an existing row never adds one.
  let rowCount: number | null = null;
  if (!cached) {
    // Titles and lists only: the title searches have their own budget and never take their places
    const { count } = await supabaseAdmin
      .from("tmdb_cache")
      .select("cache_key", { count: "exact", head: true })
      .not("cache_key", "like", "search:%");
    rowCount = count ?? null;
  }
  if (mayWriteCache(Boolean(cached), rowCount, JSON.stringify(freshData).length)) {
    await supabaseAdmin
      .from("tmdb_cache")
      .upsert(
        {
          cache_key: cacheKey,
          data: freshData,
          cached_at: new Date().toISOString(),
          ttl_seconds: ttlSeconds,
        },
        { onConflict: "cache_key" }
      );
  }

  return { data: freshData, cacheStatus: "MISS" };
}

// ============================================================================
// TITLE SEARCH CACHE — same table, own row budget (see _shared/tmdbRequest.ts)
// ============================================================================

async function searchCached(
  supabaseAdmin: ReturnType<typeof createClient>,
  kind: "movie" | "tv",
  language: string,
  year: string,
  rawQuery: string,
  endpoint: string,
  tmdbParams: (query: string) => Record<string, string>
): Promise<CacheResult> {
  const query = normalizeSearchQuery(rawQuery);
  // Not a plausible cleaned title: answered, never cached
  if (!query) return { data: await fetchTmdb(endpoint, tmdbParams(rawQuery)), cacheStatus: "BYPASS" };

  const key = searchCacheKey(kind, language, year, query);
  const { data: cached } = await supabaseAdmin
    .from("tmdb_cache")
    .select("data, cached_at")
    .eq("cache_key", key)
    .maybeSingle();
  if (cached && Date.now() / 1000 - new Date(cached.cached_at).getTime() / 1000 < TTL_SEARCH) {
    return { data: cached.data, cacheStatus: "HIT" };
  }

  const fresh = await fetchTmdb(endpoint, tmdbParams(query));
  let count: number | null = null;
  // An answer without result is never written: no need to count the rows
  if (!cached && searchResultCount(fresh) > 0) {
    const result = await supabaseAdmin
      .from("tmdb_cache")
      .select("cache_key", { count: "exact", head: true })
      .like("cache_key", "search:%");
    count = result.count ?? null;
  }
  if (mayWriteSearchCache(Boolean(cached), count, JSON.stringify(fresh).length, searchResultCount(fresh))) {
    await supabaseAdmin
      .from("tmdb_cache")
      .upsert(
        { cache_key: key, data: fresh, cached_at: new Date().toISOString(), ttl_seconds: TTL_SEARCH },
        { onConflict: "cache_key" }
      );
  }
  return { data: fresh, cacheStatus: "MISS" };
}

// ============================================================================
// ROUTE PARSER
// ============================================================================

interface RouteMatch {
  route: string;
  params: Record<string, string>;
}

function matchRoute(pathname: string): RouteMatch | null {
  // Remove /tmdb-proxy prefix
  const path = pathname.replace(/^\/tmdb-proxy/, "");

  // Static routes — accepts both simplified AND original TMDB paths
  const staticMap: Record<string, string> = {
    // Simplified routes
    "/trending": "/trending",
    "/now-playing": "/now-playing",
    "/on-the-air": "/on-the-air",
    "/top-rated": "/top-rated",
    "/popular": "/popular",
    "/search/movie": "/search/movie",
    "/search/tv": "/search/tv",
    "/search/batch": "/search/batch",
    // Original TMDB routes (sent by tmdbApi.ts client)
    "/movie/now_playing": "/now-playing",
    "/movie/popular": "/popular",
    "/tv/on_the_air": "/on-the-air",
  };

  if (staticMap[path]) return { route: staticMap[path], params: {} };

  let match: RegExpMatchArray | null;

  // /trending/all/:window (original TMDB path)
  match = path.match(/^\/trending\/all\/(day|week)$/);
  if (match) return { route: "/trending", params: { window: match[1] } };

  // /:type/top_rated (original TMDB path)
  match = path.match(/^\/(movie|tv)\/top_rated$/);
  if (match) return { route: "/top-rated", params: { type: match[1] } };

  // /discover/:type (original TMDB path for genre)
  match = path.match(/^\/discover\/(movie|tv)$/);
  if (match) return { route: "/genre-discover", params: { type: match[1] } };

  // /movie/:id/recommendations
  match = path.match(/^\/movie\/(\d+)\/recommendations$/);
  if (match) return { route: "/movie/:id/recommendations", params: { id: match[1] } };

  // /movie/:id
  match = path.match(/^\/movie\/(\d+)$/);
  if (match) return { route: "/movie/:id", params: { id: match[1] } };

  // /tv/:id/season/:n
  match = path.match(/^\/tv\/(\d+)\/season\/(\d+)$/);
  if (match) return { route: "/tv/:id/season/:n", params: { id: match[1], n: match[2] } };

  // /tv/:id
  match = path.match(/^\/tv\/(\d+)$/);
  if (match) return { route: "/tv/:id", params: { id: match[1] } };

  // /genre/:id (simplified)
  match = path.match(/^\/genre\/(\d+)$/);
  if (match) return { route: "/genre/:id", params: { id: match[1] } };

  return null;
}

// ============================================================================
// GROUPED TITLE SEARCH — several titles in one call (see _shared/tmdbBatch.ts)
// ============================================================================

/**
 * Searches the first `allowed` titles (cache first, TMDB for the others, a few at a time); the titles
 * past the caller's limits are answered `limited`, a title whose search failed `error`. The app keeps
 * both unsearched and asks again later.
 */
async function handleBatch(
  supabaseAdmin: ReturnType<typeof createClient>,
  items: BatchItem[],
  allowed: number,
  searchParams: URLSearchParams,
  cors: CorsHeaders
): Promise<Response> {
  const language = normalizeLanguage(searchParams.get("language"));
  if (!language) return errorResponse("Invalid 'language' parameter", cors);
  const answers = await mapWithLimit(items, BATCH_CONCURRENCY, async (item, index) => {
    const echo = { kind: item.kind, year: item.year, query: item.query };
    if (index >= allowed) return { ...echo, status: "limited" };
    try {
      const endpoint = item.kind === "movie" ? "/search/movie" : "/search/tv";
      const { data } = await searchCached(
        supabaseAdmin, item.kind, language, item.year, item.query, endpoint,
        (q) => item.kind === "movie"
          ? { query: q, year: item.year, language }
          : (item.year ? { query: q, language, first_air_date_year: item.year } : { query: q, language })
      );
      return { ...echo, status: "ok", results: slimSearchAnswer(item.kind, data) };
    } catch (err) {
      console.error("[tmdb-proxy] batch item failed:", err instanceof TmdbHttpError ? err.status : "unknown");
      return { ...echo, status: "error" };
    }
  });
  return jsonResponse({ results: answers }, cors, 200, "BYPASS");
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

async function handleRoute(
  supabaseAdmin: ReturnType<typeof createClient>,
  routeMatch: RouteMatch,
  searchParams: URLSearchParams,
  cors: CorsHeaders
): Promise<Response> {
  const { route } = routeMatch;
  const language = normalizeLanguage(searchParams.get("language"));
  if (!language) return errorResponse("Invalid 'language' parameter", cors);

  // Ids without leading zeros and of bounded length: "0550" is the same cache row as "550"
  const params = { ...routeMatch.params };
  if (params.id !== undefined) {
    const id = normalizeTmdbId(params.id);
    if (!id) return errorResponse("Invalid id", cors);
    params.id = id;
  }
  if (params.n !== undefined) {
    const n = normalizeSeasonNumber(params.n);
    if (!n) return errorResponse("Invalid season number", cors);
    params.n = n;
  }

  switch (route) {
    // ---- DETAILS (TTL 7 days) ----
    case "/movie/:id": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `movie:${params.id}:${language}`,
        TTL_DETAILS,
        () => fetchTmdb(`/movie/${params.id}`, {
          language,
          append_to_response: "credits,videos,recommendations,images",
          include_image_language: "fr,en,null",
        })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/tv/:id": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `tv:${params.id}:${language}`,
        TTL_DETAILS,
        () => fetchTmdb(`/tv/${params.id}`, {
          language,
          append_to_response: "credits,videos,images",
          include_image_language: "fr,en,null",
        })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/tv/:id/season/:n": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `season:${params.id}:${params.n}:${language}`,
        TTL_DETAILS,
        () => fetchTmdb(`/tv/${params.id}/season/${params.n}`, { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/search/movie": {
      const query = searchParams.get("query") || "";
      const year = searchParams.get("year") || "";
      if (!query) return errorResponse("Missing 'query' parameter", cors);
      if (query.length > MAX_QUERY_LENGTH) return errorResponse("'query' too long", cors);
      if (year && !YEAR_RE.test(year)) return errorResponse("Invalid 'year' parameter", cors);

      const { data, cacheStatus } = await searchCached(
        supabaseAdmin, "movie", language, year, query, "/search/movie",
        (q) => ({ query: q, year, language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/search/tv": {
      const query = searchParams.get("query") || "";
      // Client sends first_air_date_year (TMDB param name), also accept year as fallback
      const year = searchParams.get("first_air_date_year") || searchParams.get("year") || "";
      if (!query) return errorResponse("Missing 'query' parameter", cors);
      if (query.length > MAX_QUERY_LENGTH) return errorResponse("'query' too long", cors);
      if (year && !YEAR_RE.test(year)) return errorResponse("Invalid 'year' parameter", cors);

      const { data, cacheStatus } = await searchCached(
        supabaseAdmin, "tv", language, year, query, "/search/tv",
        (q) => (year ? { query: q, language, first_air_date_year: year } : { query: q, language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    // ---- LISTS (TTL 24 hours) ----
    case "/trending": {
      // window can come from route params (original path) or query params
      const window = params.window || searchParams.get("window") || "week";
      if (!WINDOWS.has(window)) return errorResponse("Invalid 'window' parameter", cors);
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `trending:${window}:${language}`,
        TTL_LISTS,
        () => fetchTmdb(`/trending/all/${window}`, { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/now-playing": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `now_playing:${language}`,
        TTL_LISTS,
        () => fetchTmdb("/movie/now_playing", { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/on-the-air": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `on_the_air:${language}`,
        TTL_LISTS,
        () => fetchTmdb("/tv/on_the_air", { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/top-rated": {
      // type can come from route params (original path) or query params
      const type = params.type || searchParams.get("type") || "movie";
      if (!MEDIA_TYPES.has(type)) return errorResponse("Invalid 'type' parameter", cors);
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `top_rated:${type}:${language}`,
        TTL_LISTS,
        () => fetchTmdb(`/${type}/top_rated`, { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/popular": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `popular:${language}`,
        TTL_LISTS,
        () => fetchTmdb("/movie/popular", { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/movie/:id/recommendations": {
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `movie_reco:${params.id}:${language}`,
        TTL_LISTS,
        () => fetchTmdb(`/movie/${params.id}/recommendations`, { language })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    case "/genre/:id":
    case "/genre-discover": {
      const type = params.type || searchParams.get("type") || "movie";
      const rawGenres = params.id || searchParams.get("with_genres") || "";
      if (!rawGenres) return errorResponse("Missing genre ID", cors);
      if (!MEDIA_TYPES.has(type)) return errorResponse("Invalid 'type' parameter", cors);
      // 1 to 5 ids, sorted: one set of genres is one cache row
      const genreId = normalizeGenres(rawGenres);
      if (!genreId) return errorResponse("Invalid genre ID", cors);
      const { data, cacheStatus } = await getOrFetchCached(
        supabaseAdmin,
        `genre:${genreId}:${type}:${language}`,
        TTL_LISTS,
        () => fetchTmdb(`/discover/${type}`, {
          with_genres: genreId,
          sort_by: "popularity.desc",
          language,
        })
      );
      return jsonResponse(data, cors, 200, cacheStatus);
    }

    default:
      return errorResponse("Unknown route", cors, 404);
  }
}

// ============================================================================
// SERVER KEY — new secret key first, legacy service_role key as a fallback
// The legacy keys stop working once disabled (Supabase session, before end 2026): reading the new
// `sb_secret_…` key first lets this code be deployed now and keep working after that switch.
// ============================================================================

function serverKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
    if (typeof keys.default === "string" && keys.default) return keys.default;
  } catch {
    // Unreadable variable: fall back to the legacy key below
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

// ============================================================================
// RATE LIMITER (in-memory, per-user)
// ============================================================================

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 60;           // 60 requests per window

/** Map<userId, timestamp[]> — purged naturally when isolate recycles */
const rateLimitMap = new Map<string, number[]>();

/** `weight`: requests this call counts for (a grouped search counts each of its titles) */
function checkRateLimit(userId: string, weight = 1): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let timestamps = rateLimitMap.get(userId);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(userId, timestamps);
  }

  // Remove timestamps outside the window
  const recent = timestamps.filter((t) => t > windowStart);
  rateLimitMap.set(userId, recent);

  if (recent.length + weight > RATE_LIMIT_MAX) {
    return false; // Rate limited
  }

  for (let i = 0; i < weight; i++) recent.push(now);
  return true; // Allowed
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  // Only GET requests
  if (req.method !== "GET") {
    return errorResponse("Method not allowed", cors, 405);
  }

  try {
    // 1. Verify JWT via JWKS (cryptographic signature verification)
    let caller: Caller;
    try {
      caller = await verifyCaller(req);
    } catch (err) {
      // No account id and no token detail in the logs or the response
      console.error("[tmdb-proxy] JWT verification failed:", err instanceof Error ? err.name : "unknown");
      return errorResponse("Invalid or expired token", cors, 401);
    }

    // 2. Route first (no database call): a grouped search counts each of its titles in the limits
    const url = new URL(req.url);
    const routeMatch = matchRoute(url.pathname);
    if (!routeMatch) {
      return errorResponse(`Unknown endpoint: ${url.pathname}`, cors, 404);
    }
    let batch: BatchItem[] | null = null;
    if (routeMatch.route === "/search/batch") {
      batch = parseBatchItems(url.searchParams.getAll("t"));
      if (!batch) return errorResponse("Invalid 't' parameters", cors);
      if (!normalizeLanguage(url.searchParams.get("language"))) return errorResponse("Invalid 'language' parameter", cors);
    }
    // Guests: each title counts (their database limits are small). Accounts: one per 4 titles, so a
    // grouped search of the home cards leaves room for the cards opened right after
    const guestWeight = batch ? batch.length : 1;
    const accountWeight = batch ? Math.ceil(batch.length / 4) : 1;
    let allowed = guestWeight;

    // Admin client for the guest limits and the cache (bypasses RLS)
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      serverKey()
    );

    // 3. Guests: limits kept in the database (per device, per address, all guests together).
    //    Every guest request is counted, cached answers included. No address or account id in logs.
    if (caller.guest) {
      // A guest past its limits that keeps calling is stopped here first, without a database call
      if (!checkRateLimit(caller.userId, guestWeight)) {
        return new Response(
          JSON.stringify({ error: "Guest limit reached", reason: "minute", retry_at: null }),
          { status: 429, headers: { ...cors, "Content-Type": "application/json", "Retry-After": "60" } }
        );
      }
      // One count per title, in order, until the first refusal: the titles before it are searched
      const address = clientAddress(req.headers);
      let verdict = await askGuestQuota(supabaseAdmin, caller.userId, address);
      allowed = verdict.allowed ? 1 : 0;
      while (verdict.allowed && allowed < guestWeight) {
        const next = await askGuestQuota(supabaseAdmin, caller.userId, address);
        if (!next.allowed) break;
        allowed++;
      }
      if (!verdict.allowed) {
        const unavailable = verdict.reason === "unavailable";
        if (unavailable) console.error("[tmdb-proxy] guest limits unavailable");
        // Guest erased by the nightly purge (or no longer anonymous): its token is still signed, but
        // the app must sign in again as a new guest, not retry
        if (verdict.reason === "unknown") return errorResponse("Invalid or expired token", cors, 401);
        return new Response(
          JSON.stringify({ error: "Guest limit reached", reason: verdict.reason, retry_at: verdict.retryAt }),
          {
            status: unavailable ? 503 : 429,
            headers: {
              ...cors,
              "Content-Type": "application/json",
              "Retry-After": String(retryAfterSeconds(verdict.retryAt)),
            },
          }
        );
      }
    } else if (!checkRateLimit(caller.userId, accountWeight)) {
      // Accounts: 60 requests per minute, counted in this instance's memory (approximate)
      console.warn("[tmdb-proxy] rate limited");
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded — max 60 requests per minute" }),
        {
          status: 429,
          headers: { ...cors, "Content-Type": "application/json", "Retry-After": "60" },
        }
      );
    }

    // 4. Handle route
    if (batch) return await handleBatch(supabaseAdmin, batch, allowed, url.searchParams, cors);
    return await handleRoute(supabaseAdmin, routeMatch, url.searchParams, cors);

  } catch (err) {
    // Error name and TMDB status only: a network error message quotes the TMDB address, search
    // included.
    console.error(
      "[tmdb-proxy] Error:",
      err instanceof Error ? err.name : "unknown",
      err instanceof TmdbHttpError ? err.status : "",
    );
    // TMDB 404 → 404 (the app treats it as "not found"); any other TMDB failure → 502.
    // Generic message: internal details stay in the function logs, never in the response.
    if (err instanceof TmdbHttpError) {
      return err.status === 404
        ? errorResponse("Not found", cors, 404)
        : errorResponse("Upstream error", cors, 502);
    }
    return errorResponse("Internal server error", cors, 500);
  }
});
