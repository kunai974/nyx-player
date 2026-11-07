/**
 * Who may call the functions: a signed-in account only.
 * Every token signed by the project passes the signature check, including an anonymous sign-in
 * (`is_anonymous`) or a token issued for another audience. Anonymous sign-ins are disabled in the
 * project settings today; this check keeps the functions closed if that setting ever changes.
 */

/** Audience of a signed-in Supabase account: passed to jose.jwtVerify as well. */
export const TOKEN_AUDIENCE = "authenticated";

export function isSignedInAccount(payload: Record<string, unknown>): boolean {
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  return audiences.includes(TOKEN_AUDIENCE) && payload.is_anonymous !== true;
}

/**
 * A guest's token (anonymous sign-in, "Continue without an account"): accepted by tmdb-proxy only,
 * and only within the guest limits kept in the database. Every other function keeps
 * `isSignedInAccount`, which refuses it.
 */
export function isGuestToken(payload: Record<string, unknown>): boolean {
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  return audiences.includes(TOKEN_AUDIENCE) && payload.is_anonymous === true
    && typeof payload.sub === "string" && payload.sub.length > 0;
}
