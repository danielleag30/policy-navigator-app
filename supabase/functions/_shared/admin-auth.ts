/**
 * Shared admin-secret authentication helpers.
 *
 * Used by both `acknowledge-alert` and `admin-alerts` Edge Functions.
 * Both functions verify against the same ADMIN_SECRET value.
 *
 * Secret rotation: update ADMIN_SECRET in both Vercel and Supabase Edge
 * Function env vars, then redeploy all functions that import this module.
 * See `acknowledge-alert/index.ts` for the canonical rotation doc comment.
 */

export const ADMIN_SECRET_HEADER = "x-admin-secret";

/** Extracts the admin secret from a request — direct header or Bearer token. */
export function requestSecret(req: Request): string | null {
  const directSecret = req.headers.get(ADMIN_SECRET_HEADER);
  if (directSecret) return directSecret;

  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim();
}

/** Returns true when the request carries the correct admin secret. */
export function verifyAdminSecret(
  req: Request,
  adminSecret: string,
): boolean {
  return requestSecret(req) === adminSecret;
}
