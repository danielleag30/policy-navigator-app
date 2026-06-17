// NOTE: This function is intentionally excluded from task 3-7's pre-launch lockdown. keepalive-health stays permanently public as the GitHub Actions keep-alive target.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import db from "../_shared/db-client.ts";
import { error, success } from "../_shared/response.ts";

Deno.serve(async (_req: Request): Promise<Response> => {
  const { error: dbError } = await db.rpc("ping");
  if (dbError) {
    return error("INGESTION_FAILED", "DB ping failed");
  }
  return success({ alive: true, ts: new Date().toISOString() });
});
