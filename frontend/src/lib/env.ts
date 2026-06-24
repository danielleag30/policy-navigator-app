/**
 * Validated env vars sourced from Vercel environment variables:
 * NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * Set these in the Vercel project dashboard (or .env.local for local dev).
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const QUERY_PIPELINE_URL = process.env.NEXT_PUBLIC_QUERY_PIPELINE_URL ?? '';
export const ADMIN_SECRET = process.env.NEXT_PUBLIC_ADMIN_SECRET ?? '';
