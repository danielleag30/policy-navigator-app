import { NextResponse } from 'next/server';

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OLLAMA_CLOUD_BASE_URL',
  'OLLAMA_TIMEOUT_MS',
  'HF_SPACES_DOCLING_URL',
  'HF_SPACES_KEEPWARM_URL',
  'MUNICODE_BASE_URL',
  'MUNICODE_CLIENT_ID',
  'MUNICODE_USER_AGENT',
  'RRF_K_CONSTANT',
  'RETRIEVAL_CANDIDATE_COUNT',
  'RETRIEVAL_CONTEXT_COUNT',
  'INCOMPLETE_SEARCH_FLOOR',
  'VERCEL_DEPLOY_TOKEN',
  'ADMIN_SECRET',
] as const;

export function GET(request: Request): NextResponse {
  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = request.headers.get('x-admin-secret');

  if (
    typeof adminSecret !== 'string' ||
    adminSecret.length === 0 ||
    providedSecret !== adminSecret
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const env: Record<string, boolean> = {};
  for (const key of REQUIRED_ENV_VARS) {
    env[key] = typeof process.env[key] === 'string' && process.env[key]!.length > 0;
  }

  return NextResponse.json(env);
}
