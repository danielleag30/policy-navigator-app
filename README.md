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

