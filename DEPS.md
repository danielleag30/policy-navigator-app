# Dependency Register

This file records the canonical runtime/configuration choices for Policy Navigator.

## Secrets and Environment Variables

| Name | Lives In | Loaded By | Notes |
|---|---|---|---|
| `SUPABASE_URL` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()`; frontend build/runtime config when needed | Project API URL for Supabase. |
| `SUPABASE_ANON_KEY` | Local `.env.local` / Vercel project env | Frontend build/runtime config | Public key only; never used for privileged server writes. |
| `SUPABASE_SERVICE_ROLE_KEY` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Server-side only; bypasses RLS. |
| `OLLAMA_CLOUD_BASE_URL` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Base URL for Ollama Cloud requests. |
| `OLLAMA_TIMEOUT_MS` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Timeout ceiling for Ollama calls; default `15000`. |
| `HF_SPACES_DOCLING_URL` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Docling wrapper endpoint. |
| `HF_SPACES_KEEPWARM_URL` | Local `.env.local` / Vercel project env | GitHub Actions workflow and/or edge-side keep-warm logic | Keep-warm endpoint for the free-tier pause prevention job. |
| `MUNICODE_BASE_URL` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Municode API base URL. |
| `MUNICODE_CLIENT_ID` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Fairfax County client ID is `10051`. |
| `MUNICODE_USER_AGENT` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Required identifying header for Municode requests. |
| `RRF_K_CONSTANT` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Retrieval tuning, configurable without code deploy. |
| `RETRIEVAL_CANDIDATE_COUNT` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Retrieval tuning, configurable without code deploy. |
| `RETRIEVAL_CONTEXT_COUNT` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Retrieval tuning, configurable without code deploy. |
| `INCOMPLETE_SEARCH_FLOOR` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Retrieval tuning, configurable without code deploy. |
| `VERCEL_DEPLOY_TOKEN` | Vercel secret / local `.env.local` if needed for tooling | Deployment tooling only | Used for frontend deployment automation, not runtime code. |
| `ADMIN_SECRET` | Local `.env.local` / Vercel project env | Frontend route gate and `acknowledge-alert` Edge Function via `Deno.env.get()` | Dual-use secret; one value, two checks. |
| `KEEPALIVE_HEALTH_URL` | GitHub Actions repo secret | `.github/workflows/keep-alive.yml` via `${{ secrets.KEEPALIVE_HEALTH_URL }}` | Full URL of the deployed `keepalive-health` Edge Function: `https://ahaurkifxzqsrhwjshbj.supabase.co/functions/v1/keepalive-health`. NOT in `.env.local` — only needed by CI. |

## Hardcoded Constants

- `gemma4:31b-cloud` is a hardcoded model string in the Ollama client module.
- UUID v7 generation uses `@std/uuid/v7`.
- SHA-256 is the canonical `content_hash` algorithm.

## Frontend Routes

| Route | File | Description |
|---|---|---|
| `GET /api/health` | `frontend/app/api/health/route.ts` | Returns JSON with boolean presence flags for all 16 required env vars. Used to verify production env parity after Vercel deploy. **Must be gated before public launch** — see task 3-7 (`ADMIN_SECRET` header check). No secret values are returned, only `true`/`false` per key. |

## Application Dependencies

| Purpose | Library | Import/Submodule | Pinned Version | Notes |
|---|---|---|---|---|
| Application-side primary key UUID v7 generation | `@std/uuid` | `@std/uuid/v7` via `jsr:@std/uuid@1.1.1/v7` | `1.1.1` | Canonical exports are `generate`, `validate`, and `extractTimestamp`. Do not use `unstable-v7` or another UUID v7 source. |
| Supabase Data API client (PostgREST-backed) for all Edge Functions | `@supabase/supabase-js` | `npm:@supabase/supabase-js@2` | `2.x` (npm floating minor) | Service-role client only — bypasses RLS, server-side Edge Functions only, never shipped to frontend. Instantiated once in `_shared/db-client.ts`; all Edge Functions import from there. This is the PostgREST Data API path (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`), **not** a raw Postgres pooler connection. If task 2-7 (RRF retrieval) requires raw SQL that PostgREST cannot express, a separate `_shared/db-pool.ts` will be created at that time with documented rationale. |
| Next.js (frontend framework) | `next` | — | `^14.2.0` | App Router, TypeScript, no Tailwind. Bootstrapped in `frontend/` (task 0-14). |
| React | `react`, `react-dom` | — | `^18.3.0` | Required peer dependencies for Next.js 14. |

## Shared Modules

| Module | Location | Description |
|---|---|---|
| `hash.ts` | `supabase/functions/_shared/hash.ts` | Canonical SHA-256 `contentHash(input: string): Promise<string>`. All document deduplication imports from here — no other hashing for `content_hash` exists in the codebase. |
| `response.ts` | `supabase/functions/_shared/response.ts` | Typed response envelope constructors. `success<T>(data)` → HTTP 200 `{ ok: true, data }`. `error(code, message, status?)` → HTTP error `{ ok: false, error: { code, message } }`. Named error codes: `RATE_LIMITED` (429), `OLLAMA_EXHAUSTED` (503), `INGESTION_FAILED` (500), `NOT_FOUND` (404), `UNAUTHORIZED` (401). All Edge Functions must import from here — no raw response objects. |
| `db-client.ts` | `supabase/functions/_shared/db-client.ts` | Pre-instantiated service-role supabase-js client. Default export `db`. All Edge Functions import this rather than calling `createClient()` directly. Uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; bypasses RLS; server-side only. |

## Database Functions (SQL)

| Function | Migration | Description |
|---|---|---|
| `public.ping()` | `20260617000000_keepalive_ping.sql` | Returns `true` (boolean). Called by `keepalive-health` Edge Function via `db.rpc('ping')` to confirm PostgREST → Postgres connectivity. Option A chosen over raw REST endpoint fetch because it exercises the full supabase-js `rpc` path used by real application queries. SECURITY DEFINER is safe: no privileged logic in the function body. |

## Policy

- Secrets live in environment variables, not committed code.
- Edge Functions read server-side secrets with `Deno.env.get()`.
- Public frontend values are mirrored into the Vercel project settings when the frontend project is provisioned.
- Placeholder values in `.env.local.example` are documentation only and must never be replaced with production secrets in git-tracked files.
