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

## Hardcoded Constants

- `gemma4:31b-cloud` is a hardcoded model string in the Ollama client module.
- UUID v7 generation uses `@std/uuid/v7`.
- SHA-256 is the canonical `content_hash` algorithm.

## Application Dependencies

| Purpose | Library | Import/Submodule | Pinned Version | Notes |
|---|---|---|---|---|
| Application-side primary key UUID v7 generation | `@std/uuid` | `@std/uuid/v7` via `jsr:@std/uuid@1.1.1/v7` | `1.1.1` | Canonical exports are `generate`, `validate`, and `extractTimestamp`. Do not use `unstable-v7` or another UUID v7 source. |

## Edge Function Naming Conventions

All Edge Functions live under `supabase/functions/<function-name>/`. The canonical seven functions are:

| Function Name | Directory | Responsibility |
|---|---|---|
| `ingest-orchestrator` | `supabase/functions/ingest-orchestrator/` | Orchestrates document ingestion pipeline |
| `query-pipeline` | `supabase/functions/query-pipeline/` | Handles RAG query: retrieval + reranking + LLM generation |
| `change-detection` | `supabase/functions/change-detection/` | Detects policy document changes via Municode/web polling |
| `reconciliation` | `supabase/functions/reconciliation/` | Reconciles ordinance provision data when Municode publishes new code supplements |
| `acknowledge-alert` | `supabase/functions/acknowledge-alert/` | Admin endpoint to acknowledge change alerts |
| `admin-alerts` | `supabase/functions/admin-alerts/` | Lists outstanding change alerts for admin UI |
| `keepalive-health` | `supabase/functions/keepalive-health/` | Permanently-public health check called by GitHub Actions every 5-6 days to prevent Supabase project auto-pause; returns `{ ok: true }` only |

**Dependency isolation:** Each function has its own `deno.json` at `supabase/functions/<function-name>/deno.json`. There is no shared `import_map.json` or `supabase/functions/deno.json` — per-function `deno.json` is the current Supabase-recommended approach (Deno 2; `import_map.json` is legacy). Shared modules live in `supabase/functions/_shared/` and are referenced via the `"../_shared/": "../_shared/"` import mapping in each function's `deno.json`.

**Entry point:** Each function's entry point is `index.ts` in its directory.

## Policy

- Secrets live in environment variables, not committed code.
- Edge Functions read server-side secrets with `Deno.env.get()`.
- Public frontend values are mirrored into the Vercel project settings when the frontend project is provisioned.
- Placeholder values in `.env.local.example` are documentation only and must never be replaced with production secrets in git-tracked files.
