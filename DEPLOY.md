# Deployment Notes

## Vercel — Root Directory setting (one-time manual step)

The Next.js frontend lives in `frontend/`. Vercel must be told to build from
that subdirectory via Project Settings, not via `vercel.json`.

**One-time setup (if not already done):**
1. Go to the Vercel project dashboard
2. Settings → General → Root Directory
3. Set to: `frontend`
4. Save — future deployments will automatically build from `frontend/`

Once Root Directory is set to `frontend`, Vercel will pick up
`frontend/vercel.json` for build configuration.

## Environment Variables (Vercel dashboard)

Set these in Vercel Project Settings → Environment Variables:
- `NEXT_PUBLIC_SUPABASE_URL` — your Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — your Supabase anon (public) key

**Never set** `SUPABASE_SERVICE_ROLE_KEY` in Vercel frontend env vars.
