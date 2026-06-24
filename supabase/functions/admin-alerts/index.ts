/**
 * admin-alerts — admin-only listing of all unacknowledged pending_alerts rows.
 *
 * Auth: ADMIN_SECRET via `x-admin-secret` header or `Authorization: Bearer` token.
 * Secret rotation: update ADMIN_SECRET in both Vercel and Supabase Edge Function
 * env vars, then redeploy all functions that verify against it (admin-alerts and
 * acknowledge-alert). Both functions share the same secret via _shared/admin-auth.ts.
 * See acknowledge-alert/index.ts for the canonical rotation doc comment.
 */

import "@supabase/functions-js/edge-runtime.d.ts";
import db from "../_shared/db-client.ts";
import { type AdminAlertsDb, handleAdminAlerts } from "./handler.ts";

Deno.serve((req: Request): Promise<Response> =>
  handleAdminAlerts(req, {
    db: db as unknown as AdminAlertsDb,
    adminSecret: Deno.env.get("ADMIN_SECRET"),
  })
);
