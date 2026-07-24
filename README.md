<img src="docs/hero-banner.png" alt="Policy Navigator — a question box over a collage of Fairfax County ordinance text, board-minutes excerpts, and budget tables, with citation markers connecting the answer to source documents">

# Policy Navigator

Fairfax County publishes its ordinances, its Board of Supervisors' meeting minutes, and its budget documents online — as hundreds of separate PDFs and a Municode code browser, with no way to ask "is this ordinance still in effect?" or "when did the Board actually vote on this?" without reading primary sources by hand. Local ordinances also get amended, renumbered, and reprinted in ways that make citation tracking genuinely hard: Fairfax's 2023 zMOD zoning rewrite renumbered entire sections, and a 2021 court ruling voided an earlier version of that same rewrite over a procedural violation, then it was re-adopted months later. A tool that answers policy questions has to get the *history* right, not just the current text.

Policy Navigator is a Q&A system over that corpus — Municode ordinances, Board of Supervisors minutes and vote records, and budget/performance documents — built to answer questions like "what's the current setback requirement for a fence in this zoning district?" with a cited, temporally-aware answer, and to say "I don't know" or "this may have changed since" when the evidence doesn't support confidence.

I built it solo, end to end: schema design, ingestion pipeline, retrieval and generation pipeline, an eval harness to keep myself honest about accuracy, and the frontend.

## What it actually does

- **Hybrid retrieval, not vibes-based similarity search.** Every query runs BM25 full-text search and pgvector (HNSW) semantic search in parallel across five content tables (ordinance text, vote tallies, budget indicators, narrative chunks), then merges the two rankings with Reciprocal Rank Fusion. Pure semantic search alone was letting near-duplicate provisions dominate; pure keyword search alone missed paraphrased questions. Fusing both was the fix.
- **A deliberately non-agentic pipeline.** Retrieval, ranking, and version-filtering are all deterministic code, not LLM tool calls — the LLM's job is narrower: a Temporal Judge decides which chunk *versions* are relevant and flags time-sensitive answers, an Answer Drafter writes the cited response, and a Verifier double-checks any numeric claim before it ships. All three run against Ollama Cloud, with deterministic temperatures for the judge/verifier and slightly looser for prose.
- **Temporal correctness by design.** Ordinances get amended and superseded; the pipeline hard-filters superseded provisions, requires multiple version-chunks before answering "current state" questions with confidence, and appends explicit caveats ("this may have changed," "a pending code change exists") rather than silently picking the wrong version.
- **A slow-path fallback for the historical record.** For 18 scanned pre-2021 zoning-ordinance reprints with no extractable text, a "deep historical" path OCRs the relevant pages live (via a Docling microservice) when fast retrieval comes up empty — explicitly disclosed to the user as a live lookup, not silently blended into a normal answer.
- **A governance pipeline behind the scenes.** Separate Edge Functions detect when a source document changes, reconcile pending code changes against fresh Municode text, and resolve which specific ordinance section and board vote a newly-adopted amendment maps to — with a hard rule that it never fabricates a match: if it can't independently verify both the ordinance node and the vote, it leaves the decision unresolved and logs it for a human to check rather than guessing.
- **An eval suite that actually gets run.** 175 hand-built cases across 8 categories (citation accuracy, refusal boundaries, adversarial near-misses, temporal correctness, synthesis, out-of-corpus) hit the live pipeline and live database, graded deterministically — no LLM-as-judge — with exact chunk-ID matching for citations and regression tests that exercise the real shipping grader code, not a copy of it.
- **An ops layer**, not just a demo: rate limiting, request logging, a small admin dashboard for unacknowledged ingestion/reconciliation alerts, and a keep-alive job so the free-tier Supabase project doesn't get paused from inactivity.

## Architecture

```
Fairfax County sources (Municode, EnCode zoning archive, budget/minutes PDFs)
        │
        ▼
change-detection  ──►  ingest-orchestrator  ──►  Docling wrapper (HF Spaces)
  (crawl, diff)          (fetch/parse/chunk/        (PDF → structured text,
                          embed/persist, resumable    OCR fallback, batch
                          via claim leases)           embeddings)
        │                       │
        ▼                       ▼
  reconciliation           Supabase Postgres + pgvector
  amendment-resolution      (ordinance_provisions, vote_tallies,
  (never guesses a           budget_indicators, narrative_chunks,
   citation/vote match)       policy_decisions, + crosswalk/audit tables)
                                     │
                                     ▼
                          query-pipeline (Edge Function)
                    BM25 + vector retrieval → RRF merge →
                    Temporal Judge → FK traversal → Answer
                    Drafter → conditional Verifier
                                     │
                                     ▼
                      Next.js frontend (Vercel) — query UI,
                      citation drill-down, admin alert dashboard
```

pg_cron drives the recurring jobs (ingestion polling, change detection, reconciliation, watchdog recovery, keep-alive pings) by calling Edge Functions directly from Postgres via `pg_net`, with advisory-lock single-flight guards so overlapping cron ticks can't double-fire the same work.

## Engineering war stories

**The BM25 half of "hybrid retrieval" was silently useless for months.** The full-text side used Postgres's `plainto_tsquery`, which ANDs every stemmed term together — meaning a real multi-word question only matched a row if *every* word in it appeared in that row. A later audit measured this directly against 156 real eval questions: BM25 returned zero rows at all in 56% of them. The fix (rewriting the query's `&` connectives to `|`) took gold-answer-in-top-40 recall from 12% to 36% and top-10 recall from 10% to 18%, with no regressions. It's a reminder that "we have hybrid search" and "hybrid search is doing anything" are different claims worth actually measuring.

**A tax-rate amendment got linked to the wrong vote — a Girl Scout proclamation.** The first live run of the amendment-resolution pipeline correctly identified a 1993 ordinance amendment (a Gypsy Moth control district tax-rate cut) but blindly trusted a foreign key that pointed at the wrong vote on the same board-meeting document — a "Girl Scout Leader's Day" proclamation voted on the same day. That's exactly why the pipeline no longer trusts `vote_tally_id` at ingestion time: it now independently re-verifies the vote against the actual motion text before writing an amendment_events row.

**An ingestion watchdog fixed one bug and caused a worse one.** Rows stuck in "processing" for 30+ minutes were assumed dead and reset — reasonable, until the threshold was tightened to 5 minutes and the ingestion function itself was found to be legitimately hanging past that (a missing fetch timeout to the PDF-extraction service). The watchdog then reset in-flight rows into an infinite retry loop. Fixing the real timeout, then re-loosening the watchdog to 10 minutes, both mattered — a good example of why watchdogs need to fail *toward* the actual bug, not just paper over its symptoms.

## Eval-driven development

Every retrieval or prompt change gets checked against `eval/`'s 175 cases before it ships — categories include citation accuracy (numeric and textual), refusal correctness (does it decline to answer questions outside its remit, like state law or real-time data?), adversarial near-misses (repealed ordinance sections whose citation numbers get reused for something unrelated), and temporal correctness. Grading is deterministic, not an LLM judge, and a hand-tuned tolerant-text-match utility exists specifically because an earlier version of the grader flagged a *correct* answer as wrong for saying "permits" when the expected text said "allows."

## Stack

| Layer | Technology |
|---|---|
| Database | Supabase Postgres, pgvector (HNSW), full-text search (BM25-style ranking), `pg_cron`, `pg_net` |
| Backend | Supabase Edge Functions (Deno), 14 functions covering ingestion, retrieval, change detection, reconciliation, amendment resolution, and ops alerting |
| LLM | Ollama Cloud, native chat API, task-specific deterministic/creative temperature settings |
| PDF extraction | Docling (FastAPI microservice on Hugging Face Spaces), with an OCR fallback path for scanned historical reprints |
| Embeddings | `gte-small` (384-dim) |
| Frontend | Next.js (App Router), React, TypeScript, Tailwind, deployed on Vercel |
| Eval | Deno CLI harness, 175 hand-authored cases, deterministic grading against a live pipeline and live DB |
| Ops | GitHub Actions keep-alive, pg_cron watchdogs, admin alert dashboard |

## What's not (yet) here

- Retrieval is BM25 + vector + RRF — there's no learned reranker on top of it.
- The EnCode zoning-ordinance historical source is implemented but gated behind a compliance flag pending a legal check on that source's terms of use.
- Single LLM provider with retry/backoff but no fallback provider — a documented, monitored risk, not an oversight.
- Free-tier infrastructure (Supabase, Hugging Face Spaces) means real constraints: cold starts, CPU-time ceilings that shaped several design choices (e.g., moving embedding generation to an async HTTP call specifically to dodge Edge Function CPU billing).

## Project layout

```
.
├── frontend/                 # Next.js app — query UI, citation panel, admin dashboard
├── docling-wrapper/           # FastAPI PDF-extraction/OCR/embedding microservice (HF Spaces)
├── eval/                      # 175-case deterministic eval harness + runner
├── supabase/
│   ├── functions/             # 14 Edge Functions + _shared/ helpers
│   └── migrations/            # ~90 migrations — schema, RPCs, pg_cron jobs
├── tests/                     # Deno unit/regression tests
├── scripts/                   # One-off backfill/maintenance scripts
└── README.md
```
