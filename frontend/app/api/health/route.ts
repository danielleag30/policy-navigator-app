// TODO (task 3-7): Disable or gate this endpoint before public launch.
// It must require ADMIN_SECRET header verification so it is not publicly readable.

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

export function GET(): NextResponse {
  const env: Record<string, boolean> = {};

  for (const key of REQUIRED_ENV_VARS) {
    const value = process.env[key];
    env[key] = typeof value === 'string' && value.length > 0;
  }

  const allPresent = Object.values(env).every(Boolean);

  return NextResponse.json({ ok: allPresent, env });
}
