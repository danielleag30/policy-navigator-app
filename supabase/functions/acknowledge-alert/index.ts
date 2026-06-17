import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { success } from "../_shared/response.ts";

Deno.serve((_req: Request): Response => {
  return success({});
});
