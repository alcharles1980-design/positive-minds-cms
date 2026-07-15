# Starting a fresh Claude session (bash / git method)

This file exists so a brand-new Claude chat can pick up this project with a one-line prompt.
If you are that Claude: you've been asked to continue developing this project via the bash
method. Do the steps below in order, then read the docs before making changes.

## The starter prompt (what the human pastes)

> Continue developing `alcharles1980-design/positive-minds-cms` via the bash method.
> Clone it with this token: `<FRESH_PAT_HERE>`, read `CONTRIBUTING.md` and `SESSION_START.md`
> first, then confirm the build works before we make changes.

That's all the human needs to send. Everything else the repo tells you.

## What Claude does on arrival

```bash
git clone https://<PAT>@github.com/alcharles1980-design/positive-minds-cms.git pm
cd pm
npm install          # pinned deps (babel, react, react-dom, jsdom)
npm run workspace    # symlinks the test scripts expect
npm run build        # src/ -> index.html ; must print "✓ build ..."
npm run verify       # must print "PIPELINE VERIFIED"
```

If `verify` passes on a fresh clone, the pipeline is intact and you can start. Then **read
`CONTRIBUTING.md` in full** (the build/test/deploy loop and the rules) before editing anything.

## The change loop (short version — CONTRIBUTING.md §2 is the full version)

1. Edit the relevant module(s) in `src/*.jsx` — NEVER edit `index.html` or `pm_cms.jsx` (generated).
2. Bump `CFG.build` in `src/core.jsx` (the sidebar build stamp).
3. `npm run build && npm test && npm run verify`.
4. Commit source AND generated output together, then `git push` — this auto-deploys the front-end.

## What bash CAN and CANNOT do (important)

- **CAN**: everything front-end — edit `src/`, build, and `git push` to `main`, which deploys the
  CMS via GitHub Actions → Cloudflare automatically.
- **CANNOT**: reach Supabase or the Cloudflare API. So a bash session cannot deploy edge functions
  or run database/RLS/RPC changes. Those need the Supabase MCP (a chat connected to the project) or
  the Supabase CLI. For FULL-STACK work in one session, use a chat that has BOTH bash/code-execution
  AND the Supabase MCP connected.

## Credential note

The clone needs a GitHub token with access to this private repo. The human provides a FRESH,
fine-grained (single-repo) token each session and revokes it after. Never commit a token; never
reuse one that has appeared in a chat transcript.

## The map

- `CONTRIBUTING.md` — build/test/deploy loop, the parity invariant, access model.
- Developer page in the app (`src/devdocs.jsx`) — Architecture, CLAUDE.md (hard rules), Build Prompt.
- System Architecture page in the app — the three services with links/IDs and how to connect each.
