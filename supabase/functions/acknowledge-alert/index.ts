/**
 * acknowledge-alert — admin-only PendingAlert acknowledgement endpoint.
 *
 * Secret rotation: update ADMIN_SECRET in both Vercel and Supabase Edge
 * Function env vars, then redeploy both the frontend and this function. Both
 * surfaces must use the same value during and after rotation.
 */

import "@supabase/functions-js/edge-runtime.d.ts";
import db from "../_shared/db-client.ts";
import { type AcknowledgeAlertDb, handleAcknowledgeAlert } from "./handler.ts";

Deno.serve((req: Request): Promise<Response> =>
  handleAcknowledgeAlert(req, {
    db: db as unknown as AcknowledgeAlertDb,
    adminSecret: Deno.env.get("ADMIN_SECRET"),
  })
);
