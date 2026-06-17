import { success } from "../_shared/response.ts";

Deno.serve((_req: Request): Response => {
  return success({});
});
