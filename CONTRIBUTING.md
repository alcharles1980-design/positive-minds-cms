# Contributing — start here (humans and Claude alike)

This repo is designed so anyone who can clone it — a person, or a Claude instance working
through a shell — can build it, test it, change it, and deploy it **without needing anything
that isn't in the repo**. No hidden workspace, no machine-specific setup. If you are a Claude
reading this at the start of a session: read this whole file before you touch anything.

The authoritative design docs live **inside the app**, on the `Developer` page
(Architecture / CLAUDE.md / Build Prompt). They are embedded in `src/devdocs.jsx`. This file
is only about *how to work on the repo*; those docs are about *what the app is and its rules*.

---

## How this project is deployed, and how to get access to work on it

**Three services. They are decoupled — this is the thing to understand before anything else.**

```
   Front-end (the CMS website)          Backend (data + logic)
   ────────────────────────────         ──────────────────────
   edit src/ ─build─► index.html         Supabase project tytrmjjucqijzcrbwjfm
        │                                  · Postgres (18 tables, RLS on all)
     git push                              · Auth (admin login)
        │                                  · 5 edge functions
        ▼                                        ▲
   GitHub Actions                               │  deployed MANUALLY
        │                                        │  (MCP or Supabase CLI)
        ▼                                        │
   Cloudflare ──serves──► your browser ──talks──►┘   (never via GitHub)
```

- **GitHub** stores the front-end source and triggers its deploy. It also holds a *copy* of the
  edge-function source (`edge-functions/*.ts`) — but that copy is not wired to anything.
- **Cloudflare** serves the compiled `index.html`. A `git push` to `main` → GitHub Actions → Cloudflare,
  automatically. (The deployment also shows up as a Cloudflare Worker named `positive-minds-cms`.)
- **Supabase** is the whole backend. **GitHub never deploys to it.** Committing an edge function does
  NOT deploy it; database/RLS/RPC changes do NOT happen from a push. They are applied directly to
  Supabase, by hand.

### What access is needed for each layer

| To change… | You need… | It goes live by… |
|---|---|---|
| The CMS **website** (`src/`) | **GitHub** write access | `git push` → Actions → Cloudflare (automatic) |
| An **edge function** | Access to the **Supabase project** | a manual deploy (MCP or CLI) — *not* a push |
| **Database / RLS / RPC** | Access to the **Supabase project** | migration / SQL, applied live |

**GitHub access alone lets a person change only the website.** The backend is a separate system with
separate authorization.

### Onboarding a new contributor to the BACKEND (the part people get stuck on)

Connecting the Supabase MCP on a Claude account grants nothing by itself — it is only a pipe, and it
inherits whatever the **Supabase account it logs into** can already see. So the project must be made
visible to that Supabase account first. Two ways:

**Path 1 — Supabase org membership (preferred; scoped and revocable).**
1. Owner: Supabase dashboard → **Organization → Team → Invite member** (invite as **Developer** so they
   can build but can't delete the project or touch billing).
2. Contributor accepts → this project now appears under their own Supabase account.
3. Contributor connects the **Supabase MCP** on their own Claude account, signing in with their own
   Supabase credentials.
4. Claude can now `deploy_edge_function`, `apply_migration`, `execute_sql`, `get_logs` — scoped to the
   granted role. Remove them from the org to revoke.

**Path 2 — a personal access token (only if you can't use Path 1).**
Dashboard → **Account → Access Tokens → Generate**. This carries the owner's account access (not neatly
per-project) and is a bearer secret — whoever holds it acts *as the owner* until it is revoked. Usable
via the Supabase CLI or an MCP configured with it. Treat like any credential: never paste it into a
chat or commit it; rotate if exposed.

### The three kinds of working session

- **Shell / bash** (git + Node): builds and ships the **front-end** (push → Actions → Cloudflare); can
  edit edge-function *source* but **cannot deploy to Supabase or reach the DB**.
- **Chat with the Supabase MCP** (connected to this project): drives the whole **backend** live —
  deploy edge functions, run SQL/migrations, read logs; **cannot build the front-end** (that needs the
  shell toolchain).
- **A session with both**: does everything end to end.

Deeper detail is in the app's Developer page → **Architecture §0.4** and **CLAUDE.md rule 4d**.

---

## 0. The one thing that will trip you up

**`index.html` is a build artifact. Do not edit it by hand. Do not edit `pm_cms.jsx` by hand.**

The app is authored as 20 module files in `src/*.jsx`. Those are the source. Everything else
downstream is generated:

```
src/*.jsx  ──assemble──▶  pm_cms.jsx  ──build──▶  index.html  ( ==  public/index.html )
                                                      │
                                                      └─▶ this is the ONLY file Cloudflare deploys
```

Edit `src/`. Run the build. Commit all of it together. If you edit `index.html` or `pm_cms.jsx`
directly, the next `npm run build` silently overwrites your change — it was never in the source.

---

## 1. First-time setup (about 30 seconds)

```bash
npm install          # pinned deps: babel, react, react-dom, jsdom
npm run workspace    # recreates the symlinks the test scripts expect (see §5)
npm run verify       # proves the pipeline is intact BEFORE you change anything
```

`npm run verify` must print **PIPELINE VERIFIED** on a fresh clone. If it doesn't, stop and
work out why — do not start editing on top of a broken baseline.

> Why `npm run workspace`? The six test scripts (`engine.js`, `runtime.js`, …) were originally
> written against a directory layout rooted at `/home/claude/bt/v2/`, and they hardcode those
> paths. Rather than rewrite the tests (and risk changing what they check), `tools/workspace.cjs`
> creates local symlinks that mirror that layout. The symlinks are git-ignored; regenerate them
> any time with `npm run workspace`.

---

## 2. The normal change loop

```bash
# 1. edit the relevant module(s) in src/*.jsx
#    (find the right module: the // ===== name.jsx ===== banners in pm_cms.jsx map 1:1 to src/)

npm run build        # src/ -> pm_cms.jsx -> index.html + public/index.html  (with safety guards)
npm test             # run all six test layers (see §4)
npm run verify       # assert the whole pipeline is still lossless

# 2. review the diff — expect changes in src/<yours>, pm_cms.jsx, index.html, public/index.html
git add -A
git commit -m "..."  # commit source AND generated output together, always
git push
```

**Always commit the generated files with the source.** The repo's `index.html` *is* what gets
deployed — if you commit a `src/` change without rebuilding, the source and the live site drift
apart, which is exactly the failure this structure exists to prevent.

Bump `CFG.build` in `src/core.jsx` on any change you intend to deploy — the app shows it as a
build stamp, and it's how you tell a real deploy from the PWA service worker serving a stale cache.

---

## 3. What `npm run build` guarantees

`tools/build.cjs` compiles with `@babel/preset-react` in **classic** runtime (`React.createElement`),
never the automatic/dev runtime (which emits `import jsxDEV` and breaks a plain `<script>` — you'd
get a blank "Loading…" screen). Before writing anything, it parses its own output and refuses to
emit if it finds:

- any real `jsxDEV(` call        → wrong Babel runtime
- any real ESM `import` statement → breaks the standalone `<script>`
- fewer than 100 `React.createElement` calls → not actually classic runtime

Note: the embedded design docs legitimately contain the *words* "jsxDEV" and "import" as English
prose. The guards check the compiled **AST**, not substrings — a plain text grep will false-alarm
here, so don't "fix" a warning that a text search invents.

---

## 4. Tests — six layers

`npm test` runs them in sequence. They need `npm run workspace` to have been run once.

| script | what it checks |
|---|---|
| `engine.js`   | **Parity**: every copy of `maskWord` must agree byte-for-byte; masking/validator invariants |
| `runtime.js`  | Mounts every page in jsdom, captures React warnings SSR never shows |
| `interact.js` | Clicks every button, changes every input — nothing throws |
| `inspect.js`  | Computed styles per page — layout sanity |
| `visual.js`   | 27 page×device combos — flags serious layout defects (minor touch-target notes are expected) |
| `read.js`     | Renders page text content |

### ⚠️ Known gaps in the tests themselves (fix these when you touch the area)

- **`engine.js` only compares 3 engine copies** (core, content-api, generate-questions). It predates
  `edge-functions/mcp.ts`, which *also* contains `maskWord` **and** `validateQuestion`. The MCP copy is
  currently unchecked by the parity test. If you change the engine, verify `mcp.ts` by hand or extend
  the test.
- **`src/connector.jsx` is in no test's module list.** The Claude Connector page (the one that lets a
  third party propose content via MCP) is mounted/checked by nothing. Add it when you work on it.

---

## 5. The parity invariant (the highest-stakes rule in the codebase)

The masking engine `maskWord` and the question `validateQuestion` are **duplicated on purpose** so the
edge functions have no import dependency. They must stay behaviourally identical everywhere:

- `maskWord`         — in `src/core.jsx`, `content-api.ts`, `generate-questions.ts`, `mcp.ts`  (**4 copies**)
- `validateQuestion` — in `src/core.jsx`, `generate-questions.ts`, `mcp.ts`                    (**3 copies**)

If a blank renders one way in the CMS and another way in the game, the game is wrong and a child sees a
broken or ambiguous puzzle. `engine.js` enforces the `maskWord` half (minus the `mcp.ts` gap above).
**Any change to one copy must be applied to all copies in the same commit.**

(Older docs mention a `game-feed` copy. There is no `game-feed.ts` in this repo — treat that reference
as historical.)

---

## 6. What a shell-based contributor CAN and CANNOT do from here

Reachable from this environment: **GitHub** (clone, commit, push). So the CMS front-end — everything in
`src/`, compiled to `index.html` — can be fully edited and shipped, because deploy is automatic:
**push to `main` → GitHub Actions → Cloudflare Pages.**

**NOT reachable** from a Claude shell: **Supabase** and the **Cloudflare API**. That means:

- **Edge functions** (`edge-functions/*.ts`) can be *edited* in the repo, but **not deployed** from here.
  A human must run:
  ```bash
  supabase functions deploy content-api        --project-ref tytrmjjucqijzcrbwjfm --no-verify-jwt
  supabase functions deploy generate-questions --project-ref tytrmjjucqijzcrbwjfm
  # mcp is deployed similarly; keep generate-questions JWT-verified so only an admin spends credits
  ```
  ⚠️ Because they can't be deployed from here, it's easy to change an edge function, ship the matching
  `src/` change, and leave the live edge function behind — silently breaking parity. If you touch an
  engine copy in an edge function, say so loudly in the commit and flag that a human must redeploy it.
- **Database / RPC / RLS** changes: write the SQL in the repo or the message, but a human runs it.

---

## 6b. If you have the Supabase + Cloudflare MCP connectors (the normal claude.ai chat)

A chat session with those connectors is the OPPOSITE of the shell in what it can reach — and the two
are complementary. With the **Supabase MCP** you CAN, directly and without a human:

- Inspect the live DB: `list_tables`, `list_migrations`, `execute_sql` (read), `get_advisors`.
- Change the DB: `apply_migration` (DDL), `execute_sql` (writes) — this is how you ship RLS/RPC changes.
- **Deploy edge functions**: `deploy_edge_function`. So the "a human must run `supabase functions
  deploy`" caveat in §6 does NOT apply to you — you can deploy `content-api`, `generate-questions`,
  `mcp`, `game-feed`, `pack-describe` yourself. Keep `generate-questions`, `mcp` and `pack-describe`
  JWT-verified; `content-api` and `game-feed` are public (`--no-verify-jwt` / `verify_jwt: false`).
- Read logs: `get_logs` (service: edge-function / postgres / auth …).

**The live backend has FIVE edge functions; the repo carries all five as source** (`content-api`,
`generate-questions`, `mcp`, `game-feed`, `pack-describe`). Two of them — `game-feed` and
`pack-describe` — were once deployed without being committed and had to be recovered from the live
deployment. **Before editing any edge function, confirm the repo source matches what's deployed**
(`get_edge_function` → diff against `edge-functions/<name>.ts`); if they differ, the deployed version
is the source of truth until reconciled.

What the MCP chat likely CANNOT do: the **front-end build**. Compiling `src/*.jsx` → `index.html` needs
the bash/git toolchain (§1–2). If your chat also has code execution (the "bash method"), you have
everything — build the front-end AND drive the backend. If it only has the connectors, you can do all
backend/DB/edge-function work, but hand front-end `src/` changes to a bash-enabled session (or do them
in the same session if it has both).

**Cloudflare**: the CMS front-end deploys via **push to `main` → GitHub Actions → Cloudflare Pages**
(it also appears as a Worker named `positive-minds-cms`). The Cloudflare MCP is scoped to
Workers/D1/KV/R2 and is not the deploy path for the CMS — a git push is. So front-end deploy still
routes through GitHub, not the Cloudflare connector.

The golden division: **backend (DB, RPC, RLS, edge functions) → do it live via the Supabase MCP.
Front-end (`src/` → `index.html`) → build with bash and push to deploy.**

---

## 7. Golden rules (short version)

1. Edit `src/`, never `index.html` or `pm_cms.jsx`.
2. `npm run build && npm test && npm run verify` before every commit.
3. Commit source **and** generated output together.
4. Bump `CFG.build` on anything you deploy.
5. Change one copy of the engine → change **all** copies, same commit.
6. Every DB read needs an explicit `limit` — PostgREST silently caps at 1,000 rows.
7. Read the Developer-page docs (`src/devdocs.jsx`) for the *why*; they are authoritative and kept current.
