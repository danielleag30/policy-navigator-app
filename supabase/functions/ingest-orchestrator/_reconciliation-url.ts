/**
 * URL builder for the reconciliation trigger fetch in index.ts.
 *
 * Split out from index.ts (which has a top-level Deno.serve() and so isn't
 * safe to import from a test) so a regression test can pin the deployed
 * function name. The deployed function is `reconciliation`, not
 * `reconcile-ordinances` (see supabase/functions/reconciliation/index.ts).
 */
export function reconciliationInvokeUrl(supabaseUrl: string): string {
  return `${supabaseUrl}/functions/v1/reconciliation`;
}
