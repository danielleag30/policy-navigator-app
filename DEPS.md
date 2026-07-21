# Dependency Register

This file records the canonical runtime/configuration choices for Policy Navigator.

## Secrets and Environment Variables

| Name | Lives In | Loaded By | Notes |
|---|---|---|---|
| `SUPABASE_URL` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()`; frontend build/runtime config when needed | Project API URL for Supabase. |
| `SUPABASE_ANON_KEY` | Local `.env.local` / Vercel project env | Frontend build/runtime config | Public key only; never used for privileged server writes. |
| `SUPABASE_SERVICE_ROLE_KEY` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Server-side only; bypasses RLS. |
| `OLLAMA_CLOUD_BASE_URL` | Local `.env.local` / Vercel project env | Edge Functions via `Deno.env.get()` | Base URL for Ollama Cloud requests. |
| `OLLAMA_API_KEY` | Supabase Edge Function secret / local `.env.local` | Edge Functions via `Deno.env.get()` | Preferred Ollama Cloud bearer token. When present, `_shared/ollama-client.ts` sends `Authorization: Bearer <value>`; absent is allowed for local or unauthenticated endpoints. |
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
| `ENCODE_ZONING_ENABLED` | Supabase Edge Function secret | `ingest-orchestrator/encode.ts`, `query-pipeline/_deep-historical.ts`, AND `encode-reprint-preingest/_preingest.ts` via `Deno.env.get()` | Human/legal sign-off gate for any request against EnCode's robots.txt-disallowed `/regs/` path — must be exactly `"true"`. Shared by the recurring current-tree crawler, the deep-historical live-lookup slow path, and the resumable OCR pre-ingestion job so a sign-off revocation shuts off every EnCode-touching path at once. |
| `ENCODE_BASE_URL` | Local `.env.local` / Vercel project env | `ingest-orchestrator/encode.ts` AND `_shared/encode-zoning-reprints.ts` (`reprintDocUrl`, used by both `query-pipeline/_deep-historical.ts` and `encode-reprint-preingest`) via `Deno.env.get()` | EnCode zoning-ordinance site root. Defaults to `https://online.encodeplus.com/regs/fairfaxcounty-va` if unset (each file keeps its own literal default rather than cross-importing — see `_shared/encode-zoning-reprints.ts`'s file header). |
| `DEEP_HISTORICAL_DOCLING_TIMEOUT_MS` | Local `.env.local` / Vercel project env | `query-pipeline/_deep-historical.ts` via `Deno.env.get()` | Docling-wrapper fetch timeout for the deep-historical slow path's live-OCR fallback only (the fast path below never touches this); default `110000` — bumped from the original `100000` once this call started hitting the OCR-enabled `/process-ocr` endpoint instead of `/process` (OCR is materially slower per page than native text extraction; see Tier 0/Tier 1 pre-ingestion work, 2026-07-21). Separate env var from `DOCLING_TIMEOUT_MS`, tunable independently. |
| `DEEP_HISTORICAL_LLM_TIMEOUT_MS` | Local `.env.local` / Vercel project env | `query-pipeline/_deep-historical.ts` via `Deno.env.get()` | Per-attempt Ollama timeout for the deep-historical slow path only, passed as `ollamaChat`'s `timeoutMsOverride`; default `20000`. Does **not** change `OLLAMA_TIMEOUT_MS` (15000) used by every other call site. |
| `VERCEL_DEPLOY_TOKEN` | Vercel secret / local `.env.local` if needed for tooling | Deployment tooling only | Used for frontend deployment automation, not runtime code. |
| `ADMIN_SECRET` | Local `.env.local` / Vercel project env | Frontend route gate and `acknowledge-alert` Edge Function via `Deno.env.get()` | Dual-use secret; one value, two checks. |
| `KEEPALIVE_HEALTH_URL` | GitHub Actions repo secret | `.github/workflows/keep-alive.yml` via `${{ secrets.KEEPALIVE_HEALTH_URL }}` | Full URL of the deployed `keepalive-health` Edge Function: `https://ahaurkifxzqsrhwjshbj.supabase.co/functions/v1/keepalive-health`. NOT in `.env.local` — only needed by CI. |

## Hardcoded Constants

- `gemma4:31b-cloud` is a hardcoded model string in the Ollama client module.
- Query-pipeline Ollama temperatures are set per call site: Temporal Judge `0.0`,
  Answer Drafter `0.3`, Verifier and correction passes `0.0`. Judge/Verifier paths
  favor deterministic filtering and citation checking; the drafter allows limited
  prose variation while remaining grounded in provided chunks.
- `reconciliation` and `amendment-resolution` Ollama temperature: `0.0` -- both are
  deterministic matching/judging passes over provided candidate text, same
  rationale as the Temporal Judge and Verifier.
- UUID v7 generation uses `@std/uuid/v7`.
- SHA-256 is the canonical `content_hash` algorithm.
- `query-pipeline/_deep-historical.ts` (deep-historical slow path) Ollama
  temperature: `0.3` -- same rationale as the normal Answer Drafter (prose may
  vary slightly while staying grounded in the live-fetched excerpt text).
- `ENCODE_ZONING_REPRINTS` (moved to `_shared/encode-zoning-reprints.ts`,
  re-exported unchanged from `query-pipeline/_deep-historical.ts` for
  backward compatibility -- see that shared file's header for why it moved,
  and `encode-reprint-preingest` for the other consumer) is a hardcoded
  table of 18 EnCode Archives zoning-ordinance reprint labels/years/
  `doclibrary.aspx` GUIDs (1941-2021), confirmed live against
  `https://online.encodeplus.com/regs/fairfaxcounty-va/archivedialog.aspx`
  2026-07-21 -- same "manually verified, hardcoded rather than re-scraped"
  convention as `encode.ts`'s `ROOT_TOCID`/`ROOT_SECID`/
  `AMENDMENT_HISTORY_SECID`. Re-verify against the live page before trusting
  it if EnCode's archive contents ever change.
- Deep-historical fast-path lookup (`fetchPreingestedReprintBlocks`, reads
  `encode_reprint_pages` once a reprint's `encode_reprint_preingest_state`
  row reaches `status = 'complete'`) has no live-fetch timeout at all — a
  normal DB query. Only a reprint the background job hasn't reached yet
  falls through to the slow path below.
- Deep-historical slow-path (live-OCR fallback) worst-case latency budget: up
  to `DEEP_HISTORICAL_DOCLING_TIMEOUT_MS` (default 110s, single
  whole-document OCR attempt, no retry -- bumped from the original 100s
  non-OCR figure once this call started hitting the OCR-enabled
  `/process-ocr` endpoint) for the Docling fetch, plus up to
  `DEEP_HISTORICAL_LLM_TIMEOUT_MS` (default 20s) per Ollama attempt,
  inheriting `ollamaChat`'s existing 3x retry + exponential backoff (~67s
  worst case for the LLM step alone) -- roughly 177s worst case end to end,
  still under the frontend's 190s `FETCH_TIMEOUT_MS` (`QueryForm.tsx`)
  budget. This is a best-effort attempt for a reprint the pre-ingestion job
  hasn't finished yet; it degrades gracefully to a refusal (never a
  fabrication) if OCR can't finish within the window, same NEVER-FABRICATE
  guarantee as the rest of the module.
- `encode-reprint-preingest/_preingest.ts`: `DEFAULT_PAGES_PER_CHUNK = 3`
  (page-chunk size per OCR call — bounded so one chunk's OCR call reliably
  fits inside one Edge Function invocation's soft deadline),
  `DEFAULT_OCR_CHUNK_TIMEOUT_MS = 110000` (same OCR-endpoint cost rationale
  as `DEEP_HISTORICAL_DOCLING_TIMEOUT_MS` above), `DEFAULT_PDFINFO_TIMEOUT_MS
  = 30000`, `DEFAULT_LEASE_MINUTES = 5` (same atomic-claim lease shape as
  `change-detection`'s `discovery_crawl_state` and `municode.ts`'s
  `documents.resume_claim_expires_at`), 300ms polite delay between
  successive Tier 0 wrapper calls within one invocation (same value as
  `municode.ts`'s `REQUEST_DELAY_MS`).
- `docling-wrapper/app.py`'s `/process-ocr` endpoint slices a requested page
  range out of the source PDF with poppler-utils (`pdfseparate` +
  `pdfunite`, already in the Dockerfile) before running the OCR-enabled
  Docling converter, then remaps returned `page_no` values back to the
  original document's numbering (a sliced sub-PDF's own page numbering
  always restarts at 1). The default `/process` endpoint and its converter
  instance (`do_ocr=False`) are completely untouched by this — a separate
  `DocumentConverter` instance backs `/process-ocr` only.

## Application Dependencies

| Purpose | Library | Import/Submodule | Pinned Version | Notes |
|---|---|---|---|---|
| Application-side primary key UUID v7 generation | `@std/uuid` | `@std/uuid/v7` via `jsr:@std/uuid@1.1.1/v7` | `1.1.1` | Canonical exports are `generate`, `validate`, and `extractTimestamp`. Do not use `unstable-v7` or another UUID v7 source. |
| Supabase Data API client (PostgREST-backed) for all Edge Functions | `@supabase/supabase-js` | `npm:@supabase/supabase-js@2` | `2.x` (npm floating minor) | Service-role client only — bypasses RLS, server-side Edge Functions only, never shipped to frontend. Instantiated once in `_shared/db-client.ts`; all Edge Functions import from there. This is the PostgREST Data API path (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`), **not** a raw Postgres pooler connection. If task 2-7 (RRF retrieval) requires raw SQL that PostgREST cannot express, a separate `_shared/db-pool.ts` will be created at that time with documented rationale. |

## Shared Modules

| Module | Location | Description |
|---|---|---|
| `hash.ts` | `supabase/functions/_shared/hash.ts` | Canonical SHA-256 `contentHash(input: string): Promise<string>`. All document deduplication imports from here — no other hashing for `content_hash` exists in the codebase. |
| `response.ts` | `supabase/functions/_shared/response.ts` | Typed response envelope constructors. `success<T>(data)` → HTTP 200 `{ ok: true, data }`. `error(code, message, status?)` → HTTP error `{ ok: false, error: { code, message } }`. Named error codes: `RATE_LIMITED` (429), `OLLAMA_EXHAUSTED` (503), `INGESTION_FAILED` (500), `NOT_FOUND` (404), `UNAUTHORIZED` (401). All Edge Functions must import from here — no raw response objects. |
| `db-client.ts` | `supabase/functions/_shared/db-client.ts` | Pre-instantiated service-role supabase-js client. Default export `db`. All Edge Functions import this rather than calling `createClient()` directly. Uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; bypasses RLS; server-side only. |
| `encode-zoning-reprints.ts` | `supabase/functions/_shared/encode-zoning-reprints.ts` | `ENCODE_ZONING_REPRINTS` (the 18-reprint table), `DeepHistoricalReprint` type, `reprintDocUrl()`, `selectReprintForYear()`, `EARLIEST_REPRINT_YEAR`. Single source of truth shared by `query-pipeline/_deep-historical.ts` (re-exports these unchanged) and `encode-reprint-preingest` — moved here once a second Edge Function needed the same table, since Edge Functions don't cross-import across sibling function directories. |

## Database Functions (SQL)

| Function | Migration | Description |
|---|---|---|
| `public.ping()` | `20260617000000_keepalive_ping.sql` | Returns `true` (boolean). Called by `keepalive-health` Edge Function via `db.rpc('ping')` to confirm PostgREST → Postgres connectivity. Option A chosen over raw REST endpoint fetch because it exercises the full supabase-js `rpc` path used by real application queries. SECURITY DEFINER is safe: no privileged logic in the function body. |
| `private.cron_invoke_edge_function(function_name text, body jsonb)` | `20260617000100_vault_cron_helpers.sql` (fixed in `20260617000300_fix_cron_invoke_signature.sql`) | Reads `project_url` and `service_role_key` from `vault.decrypted_secrets`, then calls `net.http_post` (pg_net). Returns a `bigint` request_id; actual response lands in `net._http_response` after a short async delay. Used by pg_cron jobs to invoke Edge Functions without hardcoding credentials. |

## Postgres Extensions

| Extension | Schema | Version | Status | Notes |
|---|---|---|---|---|
| `pg_net` | `net` | `0.20.3` | **Beta** — Supabase-hosted, async HTTP client for Postgres. `net.http_post(url, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int)` returns a `bigint` request_id immediately; the response row appears in `net._http_response` after network round-trip (typically < 1 s). Always `pg_sleep(2)` before polling `net._http_response` in tests. Not suitable for synchronous use. |
| `pg_cron` | `extensions` | `1.6.4` | Stable — enabled in `20260617000200_enable_extensions.sql`. Used by Phase 3 tasks for scheduled ingestion and keep-warm cron jobs. |
| `supabase_vault` | `vault` | `0.3.1` | Stable — pre-enabled on all Supabase projects. Secrets stored via `vault.create_secret(secret, name, description)` and read back through `vault.decrypted_secrets`. **CRITICAL:** `vault.create_secret()` calls pass the secret value as a SQL literal and will appear in Postgres statement logs (`pg_stat_statements`, Supabase dashboard query history). Always run vault setup via `supabase db query -f <file>` or the Dashboard SQL editor — never inside a tracked migration. |

## Database Tables

| Table | Migration | Description |
|---|---|---|
| `documents` | `001_documents.sql` | Source record for every ingested document — PDFs (budget, BOS minutes/summaries, ordinances) and Municode API responses. Tracks URL, doc_type, status (`current`/`superseded`/`unknown`), content hash, and parse metadata. No hard deletes; supersession flips `status`. RLS enabled, no policies (service role bypasses). |
| `encode_reprint_preingest_state` | `20260721130000_encode_reprint_preingest.sql` | Resumable cursor + progress for `encode-reprint-preingest`, one row per EnCode zoning reprint (`doc_library_id` PK). Tracks `status` (`pending`/`in_progress`/`complete`), `total_pages`, `next_page` (resume cursor), `pages_completed`, and the same atomic-claim `claim_expires_at` lease shape as `discovery_crawl_state`/`documents.resume_claim_expires_at`. Rows are upserted lazily by the Edge Function itself (`ensureStateRows`, sourced from `_shared/encode-zoning-reprints.ts`) rather than seeded by the migration. RLS enabled, no policies. |
| `encode_reprint_pages` | `20260721130000_encode_reprint_preingest.sql` | Extracted OCR'd page text for pre-ingested EnCode zoning reprints, one row per `(doc_library_id, page_number)` that produced non-empty text (sparse by design — a genuinely blank OCR'd page advances the cursor above without a row here). Read by `query-pipeline/_deep-historical.ts`'s fast path (`fetchPreingestedReprintBlocks`) once the corresponding `encode_reprint_preingest_state` row reaches `status = 'complete'`. RLS enabled, no policies. |

## Supabase Project

| Field | Value |
|---|---|
| Project name | `policy-navigator` |
| Project ref | `ahaurkifxzqsrhwjshbj` |
| URL | `https://ahaurkifxzqsrhwjshbj.supabase.co` |
| Region | `us-west-2` (West US — Oregon) |
| Organization ID | `uwwkhrjetfribiffwxvr` |
| Created | 2026-06-17 |

The service role key lives in `.env.local` only and is never committed. It is available via `supabase projects api-keys --project-ref ahaurkifxzqsrhwjshbj`.

## Policy

- Secrets live in environment variables, not committed code.
- Edge Functions read server-side secrets with `Deno.env.get()`.
- Supabase-hosted Edge Functions should store Ollama auth as the function secret `OLLAMA_API_KEY`.
- Public frontend values are mirrored into the Vercel project settings when the frontend project is provisioned.
- Placeholder values in `.env.local.example` are documentation only and must never be replaced with production secrets in git-tracked files.
