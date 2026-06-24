# Policy Navigator

Policy Navigator is a web application for policy Q&A over local government source material. The planned runtime architecture is a hybrid deterministic pipeline with targeted LLM calls; it is not an MCP-consuming agent at runtime.

## Stack Summary

- Supabase Postgres, pgvector, Edge Functions, and pg_cron-backed scheduled work live under `supabase/`.
- The Vercel-hosted Next.js frontend lives under `frontend/`.
- Retrieval and LLM architecture will be implemented in later tasks. This scaffold contains structure and project metadata only.

## Repository Structure

```text
.
├── frontend/
├── supabase/
│   ├── functions/
│   ├── migrations/
│   └── pg_cron/
├── deno.json
├── DEPS.md
├── package.json
└── README.md
```

## Seed URL Validation

The seed URL validation script reads `supabase/config/seed-sources.json`, collects every
`discovery_urls` entry, and sends a HEAD request to each URL. It prints one status line per
URL and exits non-zero if any discovery URL does not return HTTP 200.

Run it from the repository root:

```bash
deno run --allow-net --allow-read supabase/scripts/validate-seeds.ts
```

Run this check before the first ingestion deployment and whenever `seed-sources.json` is
updated.

## Build Loop

Every build-plan task follows the Linear + Obsidian handoff protocol.

Linear receives three updates per task:

1. On task start, mark the issue `In Progress` and comment: `Started [date]. Starting conditions verified: [list].`
2. On mid-session pause, comment: `Paused [date]. Completed steps: [list]. Remaining steps: [list]. Exact next action: [one sentence]. Partial artifacts: [file paths or db state].`
3. On task completion, mark the issue `Done` and comment: `Completed [date]. AC outcome: [pass / pass-with-notes / deviation]. Deviations: [any]. Open questions: [any].`

Obsidian receives one build-log entry on task completion:

- File path: `/Users/daniellegeorge/obsideanbrain/01 Projects/Policy Navigator/build-log/[TASK-ID]-[task-slug].md`
- Required fields: task ID, task name, Linear issue URL, completion date, AC outcome, one-line summary, what was built, acceptance criteria outcome, deviations, open questions, links, and handoff state.

Logging fallback:

- If Linear write fails, write to Obsidian and add: `Linear update pending -- manual sync required.`
- If Obsidian write fails, write to Linear and add: `Obsidian log pending -- manual sync required.`
- A logging failure is recorded and flagged, but it does not block task closure.
