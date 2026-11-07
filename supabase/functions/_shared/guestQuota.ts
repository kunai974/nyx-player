/**
 * Guest limits of the TMDB relay: the decision comes from the database (public.nyx_invite_demande),
 * which counts per device, per internet address and for all guests together.
 * Closed by default: only an explicit "allowed: true" lets a guest through. A database error, an
 * empty answer or a timeout is a refusal (never a request that goes through without being counted).
 */

export type GuestRefusal = "minute" | "day" | "address" | "budget" | "off" | "unknown" | "unavailable";

export type GuestVerdict =
  | { allowed: true }
  | { allowed: false; reason: GuestRefusal; retryAt: string | null };

const REASONS = new Set<GuestRefusal>(["minute", "day", "address", "budget", "off", "unknown"]);

/** Reads the answer of the database call (supabase-js returns `{ data, error }`, it does not throw). */
export function guestVerdict(result: { data?: unknown; error?: unknown } | null | undefined): GuestVerdict {
  const data = result?.data as Record<string, unknown> | null | undefined;
  if (!result || result.error || !data || typeof data !== "object") {
    return { allowed: false, reason: "unavailable", retryAt: null };
  }
  if (data.allowed === true) return { allowed: true };
  const reason = typeof data.reason === "string" && REASONS.has(data.reason as GuestRefusal)
    ? data.reason as GuestRefusal
    : "unavailable";
  const retryAt = typeof data.retry_at === "string" ? data.retry_at : null;
  return { allowed: false, reason, retryAt };
}

/** Seconds until `retryAt` (at least 1), for the Retry-After header; 60 when unknown. */
export function retryAfterSeconds(retryAt: string | null, now = Date.now()): number {
  const at = retryAt ? Date.parse(retryAt) : NaN;
  if (Number.isNaN(at)) return 60;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/**
 * The caller's internet address, as counted for the per-address limit.
 * Only `cf-connecting-ip`: Cloudflare, in front of Supabase, replaces any value the caller sends.
 * `x-forwarded-for` and `x-real-ip` are NOT used: a caller can write them.
 * An IPv6 address counts by its /64 block (one home or one phone gets a whole /64, so counting each
 * address would let one device change address at will). Null when unknown: the database then uses
 * one shared bucket.
 */
export function clientAddress(headers: Headers): string | null {
  const raw = (headers.get("cf-connecting-ip") ?? "").trim();
  if (!raw || raw.length > 64) return null;
  // An IPv4 address written the IPv6 way ("::ffff:192.0.2.1") counts as that IPv4 address
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(raw);
  if (mapped) return mapped[1];
  if (raw.includes(":")) {
    const groups = expandIpv6(raw);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : null;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : null;
}

/** "2001:db8::1" → the 8 groups, lower case, without leading zeros; null if not an IPv6 address. */
function expandIpv6(address: string): string[] | null {
  const lower = address.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lower)) return null;
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((g) => g.length === 0 || g.length > 4)) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ""));
}
