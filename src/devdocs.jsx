// ============================================================
// Developer Notes — embedded reference documents.
// These are hardcoded so they always ship with the build.
// ============================================================

const DOC_ARCHITECTURE = `# Positive Minds CMS — Site Architecture & Structure

## 0. START HERE (new developer / taking over)

**Read in this order.** This document is long because it is complete; you do not need all of it on
day one.

1. **§1 What this is** and **§2 The game mechanic** — 5 minutes. Nothing else makes sense without
   them. The single most important idea: it is a SPELLING puzzle, both words are always POSITIVE,
   and the wrong option is guaranteed wrong by being a DIFFERENT LENGTH.
2. **§0.1 Live coordinates** (just below) — where everything actually lives.
3. **§0.2 Run it / change it / ship it** — the loop.
4. **CLAUDE.md** (the second tab) — the hard rules. These are invariants learned from real bugs.
   Breaking one silently breaks the game. Read it before your first change, not after.
5. **§7d Integration Guide** — if you are building or maintaining the game client, go straight there.
   It has a complete, runnable sync implementation.
6. The rest as you need it. **§12 is the changelog** — read the top few entries to see what has been
   moving lately.

If you only remember three things:
- **The masking engine \`maskWord\` is duplicated in FIVE places and MUST stay byte-identical** (app/
  core.jsx, content-api, generate-questions, mcp, game-feed); the validator \`validateQuestion\` in three
  (core.jsx, generate-questions, mcp). If a blank renders differently in the CMS than in the game, the
  game is wrong. Change one copy → change all, same commit. NOTE: \`game-feed.buildLevelVariants\` emits a
  different OUTPUT shape on purpose (legacy \`opts\` string vs \`options\` array) — the masking is identical,
  only the serialization differs.
- **PostgREST silently caps at 1,000 rows.** No error. Always set an explicit limit or paginate.
- **The app is a PWA with an aggressive service worker.** Most "my change didn't deploy" reports are a
  cached build. The sidebar shows a build stamp — if it didn't change, you are seeing a cached build.

### 0.1 Live coordinates

| What | Where |
|---|---|
| Supabase project | \`tytrmjjucqijzcrbwjfm\` → \`https://tytrmjjucqijzcrbwjfm.supabase.co\` |
| Publishable (anon) key | \`sb_publishable_S16YFhxUtKsUYlUixYGW8g_t5nk28Ev\` — safe in the browser; RLS enforces everything |
| Repo | \`github.com/alcharles1980-design/positive-minds-cms\` |
| Hosting | Cloudflare Pages project \`positive-minds-cms\` (push to \`main\` → GitHub Actions → deploy) |
| Admin login | \`admin@positiveminds.app\` |
| **Content API (the game client calls this)** | \`https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api\` |

**Edge functions (5) — all five have committed source in \`edge-functions/*.ts\`:**
- \`content-api\` — the sync API for the game client. **Public** (verify_jwt=false). Manifest,
  full pull, incremental \`?since=\`, deletions, ETag/304. **This is the one the game uses.**
- \`generate-questions\` — AI content generation. **Auth-gated (verify_jwt=TRUE)** so only a logged-in
  admin can spend API credits. Writes ONLY to the review queue, never to live content.
- \`mcp\` — the Claude Connector (OAuth 2.1 + PKCE). Partners propose content via Claude; writes ONLY to
  the review queue. Public entry (verify_jwt=false), but every tool call requires an OAuth access token.
- \`game-feed\` — the older, profile-driven feed. **Public** (verify_jwt=false). Kept for back-compat;
  new clients should use content-api. **Carries its own engine copy** (see parity note below).
- \`pack-describe\` — small helper that asks an LLM to write a pack description. Auth-gated.

**GitHub secrets needed for deploys:** \`CLOUDFLARE_API_TOKEN\` (Account → Cloudflare Pages → Edit) and
\`CLOUDFLARE_ACCOUNT_ID\`.

### 0.2 Run it, change it, ship it

**The app you deploy is \`index.html\` — a single self-contained file. It is the OUTPUT, not the
source.** The app is authored as modular \`.jsx\` files, concatenated in a fixed dependency order by
\`assemble.cjs\`, compiled with Babel (\`@babel/preset-react\`, **classic** runtime — the automatic/dev
runtime emits an import that breaks the plain \`<script>\` and yields a blank screen), then wrapped by
\`build_html.cjs\`.

The loop:
1. Edit the modular source.
2. **Check the docs still parse BEFORE building.** They are template literals; a stray backtick or
   \`\${\` silently breaks them, and \`assemble.cjs\` will then leave the PREVIOUS compiled file in place —
   so \`node --check\` passes on a stale build and you ship nothing. This has happened repeatedly.
3. Build. Confirm the compiled file was **freshly written** and contains a string you just added.
4. Bump \`CFG.build\` (the stamp shown in the sidebar).
5. Push to \`main\`. GitHub Actions deploys to Cloudflare Pages.
6. Hard-refresh (service worker) and check the stamp changed.

**Database changes** are Postgres migrations against the Supabase project. **Edge functions** deploy
separately (\`supabase functions deploy <name> --project-ref tytrmjjucqijzcrbwjfm\`; add
\`--no-verify-jwt\` for content-api).

### 0.3 What is where

| Concern | Where it lives |
|---|---|
| Config, auth, data layer, **the masking engine**, **the validator** | \`core.jsx\` |
| UI primitives (buttons, modals, fields, toasts) | \`primitives.jsx\` |
| Packs / questions editors, bulk import | \`editors.jsx\` |
| Levels (definitions, per-question overrides, derive) | \`levels.jsx\` |
| AI review queue (approve / edit / reject) | \`aireview.jsx\` |
| AI settings (providers, keys, usage) | \`aisettings.jsx\` |
| Prompt builder (copy-paste workflow) | \`generator.jsx\` |
| Export/transform engine + publishing | \`engine.jsx\`, \`publish1/2.jsx\` |
| These three documents | \`devdocs.jsx\` |
| Routing, nav, app shell | \`shell.jsx\` |

### 0.4 Continuing this project — what runs where, and how a new person gets access

**Three services, and they are decoupled. This is the single most misunderstood thing about the setup.**

| Service | Role | How it changes | How it goes live |
|---|---|---|---|
| **GitHub** (\`alcharles1980-design/positive-minds-cms\`) | Source of truth for the FRONT-END + a copy of the edge-function source | edit \`src/\`, build, \`git push\` | — |
| **Cloudflare** | Serves the CMS website (the static \`index.html\`) | (nothing edited here directly) | \`git push\` → GitHub Actions → Cloudflare, automatic |
| **Supabase** (\`tytrmjjucqijzcrbwjfm\`) | The entire BACKEND: Postgres, auth, RLS, and the 5 edge functions | deploy edge fns / run SQL | **manual deploy — GitHub never touches Supabase** |

**The trap:** the edge functions in \`edge-functions/*.ts\` are a SAVED COPY, not a live link. Committing
and pushing them updates Cloudflare and leaves Supabase untouched. A function only changes on Supabase
when someone explicitly deploys it there. (This exact decoupling is why \`game-feed\` and \`pack-describe\`
once ran live for weeks with no source in the repo.) **Commit the source AND deploy it, every time, or
the repo and the live backend drift apart.**

**Front-end path (fully covered by GitHub):** edit \`src/\` → build → push to \`main\` → GitHub Actions →
Cloudflare updates the live site. A contributor with only GitHub access can change the website and
nothing else.

**Backend path (NOT reachable through GitHub):** to change the database, RLS, RPCs, or deploy an edge
function, a person needs access to the **Supabase project itself**. Two ways:

- **Path 1 — Supabase org membership (preferred).** In the Supabase dashboard: *Organization → Team →
  Invite member* (invite as Developer so they can build but can't delete the project or change billing).
  Once they accept, this project appears under their own Supabase account. They then connect the
  **Supabase MCP** on their own Claude account, logging in with their own Supabase credentials, and
  Claude can now deploy edge functions (\`deploy_edge_function\`) and run SQL/migrations
  (\`apply_migration\`, \`execute_sql\`) — scoped to the role granted. Revoke by removing them from the org.
- **Path 2 — a personal access token.** Dashboard → *Account → Access Tokens → Generate*. Carries your
  account access (not neatly per-project), usable via the Supabase CLI or an MCP configured with it.
  It is a bearer secret: whoever holds it acts AS you until it is revoked. Prefer Path 1 for anyone you
  want to limit.

**Key distinction:** connecting the Supabase MCP on a Claude account is only the *pipe*. It grants no
access by itself — it inherits whatever the authenticated **Supabase** account can already see.
Authorization happens on Supabase (org membership or token), never on the Claude side.

**Two kinds of working session:**
- A **chat with the Supabase MCP** connected to this project → can drive the whole BACKEND live (deploy
  edge fns, run SQL). Front-end build still needs a shell.
- A **shell/bash session** (git + Node) → can build and ship the FRONT-END (push → Actions → Cloudflare)
  and can edit edge-function source, but CANNOT deploy to Supabase or reach the DB.
- A session with **both** does everything end to end.

See \`CONTRIBUTING.md\` in the repo for the step-by-step onboarding checklist.

## 1. What this is
A content management system for the **Positive Minds** children's word game
(CBMT — Cognitive Bias Modification Therapy). The game is a SPELLING puzzle: it shows a
short, warm first-person sentence with one word partly hidden — some letters revealed, the
rest shown as blanks (e.g. "I feel PR_UD of the things I do") — and the child chooses between
two positive words. BOTH words are positive (there is never a negative option — the
therapeutic core), and the child's job is to pick the one whose SPELLING fits the revealed
letters + blank shape. The primary word (\`answer\`) spells into the pattern; the alternate
(\`alt_answer\`) is another genuinely-positive word that does NOT fit that letter pattern
(easiest to guarantee when it's a different length, so it can never match the fixed blanks).
It is NOT a meaning/comprehension test — both words can make sense in the sentence; the
LETTERS decide. How much of the word is hidden is controlled by the question's level. This
CMS is the **authoring source of truth**:
content is created, organized, reviewed, and version-tracked here, then published to
a separate game backend through a customizable, multi-channel sync pipeline.

The CMS is a **content production + publishing layer**, not the game's live database.

## 2. Tech stack
- **Frontend:** React 18.3.1 (single self-contained \`index.html\`, no runtime build step).
  JSX is **pre-compiled to plain JS** via Babel *classic* runtime (React.createElement) —
  NOT the automatic/dev runtime (which emits \`import jsxDEV\` and breaks a plain <script>).
- **No in-browser Babel.** React + ReactDOM load from unpkg (pinned to 18.3.1 UMD).
- **Backend:** Supabase (Postgres + PostgREST + Edge Functions + Auth).
  Project ref: \`tytrmjjucqijzcrbwjfm\`.
- **Hosting:** Cloudflare (Worker) at \`positive-minds-cms.<subdomain>.workers.dev\`,
  auto-deploying from GitHub \`main\` via Cloudflare's Git integration.
- **Repo:** GitHub \`alcharles1980-design/positive-minds-cms\` (private).
- **Styling:** inline styles + a small CSS-variable theme system (light/dark). No CSS framework.

## 3. Source layout (authoring → build)
The app is authored as modular \`.jsx\` files in \`/v2/\`, then concatenated and compiled
into one file. **Assembly order matters** (const helpers must precede their consumers;
all cross-file components are \`function\` declarations so they hoist):

    core.jsx        config (incl CFG.build stamp), session/auth, data layer (rest/rpc/restAll),
                    tokens, hooks, AND the shared rendering engine (maskWord, resolveSlots,
                    resolveFrameMap, buildLevelVariants, previewAtLevel)
    primitives.jsx  Btn, Badge, Pill, Field, inputs, Modal, Confirm, Toasts, states
    realtime.jsx    lean realtime sync (raw websocket, no SDK): connect/reconnect + useRealtime hooks
    engine.jsx      transformation engine (buildOutput), profiles/sync/targets data, fetchAllContent
    firebase.jsx    Firebase transport (RTDB/Firestore/CloudFn writers), planWrites
    editors.jsx     PackEditor, QuestionEditor, FrameSlotEditor, BulkImport (with duplicate detection)
    features.jsx    CommandPalette, PlayMode, HealthView, ActivityView, TagInput, ThemeToggle
    publish1.jsx    ProfileBuilder (visual + JSON + preview), ValueMapEditor, FieldMapRow
    firebase2.jsx   FirebaseTargetEditor, CloudFnDocs
    publish2.jsx    PublishHub, ChannelsPanel, SyncHistory, FeedRow
    devdocs.jsx     the three embedded docs as template-literal strings (this Architecture doc, CLAUDE.md, Build Prompt)
    devnotes.jsx    Developer Notes page — renders the three docs + an editable scratchpad
    generator.jsx   Content Generator (AI prompt builder): GeneratorView, buildGeneratorPrompt, buildAvoidList, OUTPUT_FORMATS, MASTER_CONTEXT
    levels.jsx      LevelsView, LevelEditor, LevelChip, QuestionLevelsPanel, QuestionLevelEditor (the 10-level UI + per-question level overrides)
    views1.jsx      Dashboard, Library, PackCard
    views2.jsx      PackDetail, AllQuestions, Pager
    shell.jsx       Login, ChangePassword, CloneDialog, App (nav/routing/state), GlobalStyle

Build pipeline (\`/v2/\`):
- \`assemble.cjs\` — strips React imports, converts \`export default function App\`→\`function App\`,
  concatenates in order, adds React globals + mount, compiles via @babel/preset-react
  (runtime: classic, development: false) → \`app.compiled.js\`.
- \`build_html.cjs\` — wraps compiled JS in the HTML shell (unpkg React, PWA manifest+SW,
  CDN-failure fallback, viewport-fit=cover) → \`index.html\`.
- Final outputs copied to \`/repo/\` (git) and pushed; Cloudflare auto-builds.

## 4. Architecture layers (in the app)
config → data layer → design tokens → hooks → primitives → feature views → app shell.

- **Data layer (core.jsx):** the \`db\` object is the ONLY place features touch data.
  \`rest()\` and \`rpc()\` wrap PostgREST; both auto-refresh the auth token and retry once
  on 401, then drop to login if refresh fails (via \`authEvents\`). \`restAll()\` paginates
  in 1000-row batches to defeat the PostgREST cap.
- **Live sync (realtime.jsx):** a lean websocket client subscribes to postgres_changes on
  the UI tables; \`useRealtimeRefresh(tables, cb)\` debounce-refreshes affected lists. Any
  table a feature reads and expects to stay live must be in the Realtime publication AND in
  realtime.jsx's TABLES list. On background token refresh, call \`realtime.updateToken()\`.
- **Design tokens:** \`C\` (colors, as CSS variables), \`S\` (spacing), \`R\` (radius),
  \`SH\` (shadows), \`FONT\`. Colors resolve to \`var(--name)\`; \`THEMES\` holds the light/dark
  values injected by GlobalStyle. \`data-theme\` on <html> flips the palette instantly.
  All text colors are WCAG-checked: 'faint' is #726E88 light / #8A87A3 dark (≥4.5 on
  their backgrounds). Inputs use the panel token (never hardcoded white — that broke dark
  mode), 1.5px borders, and an explicit ::placeholder color (the 'sub' token) so search
  fields stay legible while typing.
- **Hooks:** useBreakpoint — **device class, NOT raw width**. It decides on the SHORT side of the
  screen for touch devices (invariant under rotation) and on live width for a resizable desktop
  window: \`basis = coarse ? min(w,h) : w\`, then phone <640 / tablet <1024 / desktop. THE BUG THIS
  FIXED: the old version keyed purely off innerWidth (phone<640), so rotating any phone to landscape
  (667–932px) made the app think it was a TABLET — the bottom nav vanished, an icon side-rail
  appeared, two-column forms came back, modals stopped being bottom sheets, and iOS resumed
  auto-zooming on input focus. Rotating back flipped it all again. A phone is a phone in ANY
  orientation. Also: useAsync,
  useHotkey, useFocusTrap, useDebounced, useTheme; toast bus (notify), confirm bus.

## 5. Data model (Supabase, all with RLS)
**Tables:**
- \`pm_packs\` — id, slug (unique), name, emoji, description, color, difficulty
  (basic/advanced/mixed), status (draft/published/archived), sort_order, is_custom,
  tags text[], content_version, released_version, released_at, level, and structured
  descriptive fields: purpose, focus_areas, style_approach, example_objectives. timestamps.
- \`pm_questions\` — id, pack_id (FK cascade), template (with \`{blank}\` for the target, plus
  optional \`{token}\` frame-word slots), answer, alt_answer, status (active/inactive),
  sort_order, notes, level (nullable = inherit pack), letter_position, letter_grouping,
  frame_slots (jsonb: per-token {pool, byLevel}), timestamps. (There are NO per-question
  difficulty or letters_hidden columns — the old derived-legacy ones were dropped; rendering
  is driven entirely by the level + any pm_question_levels overrides.)
- \`pm_activity\` — audit log: entity, entity_id, entity_name, action, actor, detail, created_at.
- \`pm_export_profiles\` — id, name, description, spec (jsonb transform config), is_builtin.
- \`pm_sync_log\` — profile/target/channel/mode/status/counts/detail, created_at.
- \`pm_sync_targets\` — id, name, channel, profile_id, config (jsonb), enabled.
- \`pm_dev_notes\` — singleton row (id=1) holding the editable Developer-Notes scratchpad.
- \`pm_review_queue\` — the HUMAN APPROVAL GATE for AI content. Every AI-generated question lands
  here first; NOTHING reaches pm_questions (and therefore no child) without an explicit human
  Approve / Edit / Reject. Columns: id, batch_id, pack_id, template, answer, alt_answer, frame_slots,
  target_level, provider, model, status (pending|approved|rejected), edited, reject_reason,
  decided_at, decided_by, approved_question_id, validation (jsonb), created_at. RLS: authenticated
  only — anon has NO access (this is unreviewed content). In the realtime publication.
- \`pm_ai_config\` — **SECURITY-CRITICAL.** Stores third-party API keys (anthropic/openai/gemini).
  Unlike every other pm_ table, it has **NO select policy for anon OR authenticated** — the browser
  literally cannot read it. Verified empirically: a fully authenticated admin SELECT returns [] while
  the same token reads pm_levels fine. Writes go through SECURITY DEFINER RPCs only; the
  generate-questions edge fn reads the key with the service role, server-side. Columns: provider (PK),
  api_key, model, enabled, updated_at, updated_by.
- \`pm_ai_usage\` — one row per PROVIDER CALL (generate / repair / test), with provider, model,
  pack, batch, input_tokens, output_tokens, questions_returned, ok, error, actor, created_at.
  AI generation is the ONLY operation in this app that spends real money, and it used to leave NO
  trace whatsoever — no audit trail, no token counts, no way to notice a runaway. Readable by the
  admin (the Usage panel), written only by the edge fn (service role).
- \`pm_ai_settings\` — singleton (id=1) NON-secret settings: active_provider, batch_size,
  auto_repair. Safe for the client to read/write.
- \`pm_deletions\` — deletion tombstones for incremental sync (a "changed since" query can't see
  rows that no longer exist). Columns: id, entity_type ('pack'|'question'), entity_id, pack_id,
  slug, deleted_at. Written ONLY by SECURITY DEFINER triggers — trg_tombstone_pack/
  trg_tombstone_question (before DELETE) AND trg_pack_status_tombstone/
  trg_question_status_tombstone (after status change: leaving published/active writes a
  tombstone, re-entering clears it). anon/authenticated may SELECT, nobody may write directly.
  Consumed by the content-api's \`?since=\` deletions array.
- \`pm_levels\` — the game's progression structure (levels 1–100, editable; ships with 1–10
  but you can add more above the top): level (PK, CHECK 1..100), name, tagline, letters_rule,
  word_rule, theme, age_hint, hidden_mode (letters/word), letters_hidden_default,
  letter_position (start/middle/end/random), letter_grouping (grouped/spread), color, sort_order,
  plus VOCABULARY-RULE columns that shape which ANSWER words a level uses (they drive the
  generator + show intent; the masking engine ignores them): min_word_len (int, nullable),
  max_word_len (int, nullable), allow_multiword (bool, default false), vocab_rule (free text).
  CHECK pm_levels_wordlen_band ensures min<=max when both set. The LEVEL NUMBER is the difficulty
  — no separate basic/advanced tier (removed as redundant). Packs have a \`level\` (default);
  questions have nullable \`level\`, \`letter_position\`, \`letter_grouping\` (null = inherit).
  The blank SHAPE is computed by maskWord(word, letters, position, grouping) and the effective
  settings resolve question-override → level-default (via buildLevelVariants). Adding a level row
  is enough for it to render everywhere (CMS previews + both feeds) — nothing is pre-materialized.
  pm_questions.level and pm_question_levels.level share the same 1..100 CHECK.
- \`pm_question_levels\` — per-question, per-level OVERRIDES. Every question is a single
  "concept" that auto-renders every level (buildLevelVariants derives each level's blank
  from the question + the level rules). A row exists here ONLY when a specific level's
  version was hand-edited (override template/answer/alt_answer/letters_hidden/letter_position/
  letter_grouping, or \`enabled=false\` to hide that level). In the question bank, each row has
  a "Levels" expand toggle showing all 10 variants.

**View:** \`pm_pack_overview\` — packs + active_questions + total_questions +
has_pending_changes (= content_version > released_version). MUST be created with
\`security_invoker = true\` so it respects the caller's RLS — otherwise anon can read
draft/unpublished packs through the public API. Because it uses \`p.*\`, adding a column to
pm_packs shifts positions — DROP+recreate, never CREATE OR REPLACE.

**Realtime:** publication \`supabase_realtime\` includes pm_packs, pm_questions, pm_levels,
pm_question_levels, pm_export_profiles, pm_sync_targets, pm_activity. pm_questions and
pm_question_levels are set to REPLICA IDENTITY FULL so realtime DELETE events carry the full
old row (pack_id / question_id) — otherwise the client can't route a delete to the right pack.

**Triggers:** \`pm_touch_updated_at\` (updated_at maintenance); \`pm_bump_pack_version\`
(bumps pack content_version on any question insert/update/delete).

**Functions (RPC):** (all SECURITY INVOKER — they respect the caller's RLS; anon EXECUTE
was revoked on the admin/write ones, so these are authenticated-only in practice)
- \`pm_dashboard_stats()\` — aggregate counts for the Overview: total/published/draft packs,
  total/active questions, distinct_levels_used (how many of the 10 levels have questions),
  questions_by_level (a {level: count} map for the distribution), empty_packs, and
  avg_questions_per_pack. No tier/difficulty counts (those concepts were removed).
- \`pm_search_questions(q,pack,stat,lvl,lim,off,from_date,to_date,sort)\` — global paginated
  question search. Returns the effective level + resolved letter_position/letter_grouping +
  frame_slots + created_at/updated_at. from_date/to_date filter by created_at (a [from, to)
  window); sort = 'recent' | 'oldest' | null (default keeps pack order).
- \`pm_clone_pack(src,new_slug,new_name)\` — duplicate a pack + its questions (as draft).
- \`pm_lint()\` / \`pm_lint_details()\` — content health checks (invalid templates,
  missing 2nd option, duplicates, thin packs, revealed answer [the effective LEVEL hides 0
  letters], empty answer).
- \`pm_log(...)\` — append an activity row.
- \`pm_mark_released(pack_ids uuid[])\` — set released_version = content_version
  (null = all published) so "pending changes" clears after a sync.
- \`pm_content_manifest()\` — (SECURITY DEFINER, published-only) the lightweight sync manifest
  for the content-api: global_version (epoch of newest change across packs/questions/levels +
  deletions), levels_version, pack_count, question_count, and per-pack version rows. Lets a
  client check what changed without transferring content.
- Tombstone triggers \`pm_tombstone_pack\` / \`pm_tombstone_question\` (SECURITY DEFINER,
  before-delete) write to pm_deletions so incremental sync can report removals. Companion
  status-transition triggers \`pm_pack_status_tombstone\` / \`pm_question_status_tombstone\`
  (SECURITY DEFINER, after UPDATE OF status) handle the softer case: a pack leaving 'published'
  (or a question leaving 'active') writes a tombstone AND advances global_version, while
  re-entering the live set deletes the stale tombstone so a resync doesn't both add and remove
  it. Without these, unpublishing/deactivating would be invisible to sync (the manifest's
  global_version is computed only over published/active rows).
- Level-delete cleanup trigger \`pm_level_delete_cleanup\` (SECURITY DEFINER, BEFORE DELETE on
  pm_levels): there is no FK from pm_packs.level / pm_questions.level / pm_question_levels.level to
  pm_levels (level is a plain int), so deleting a level could leave references pointing at a level
  that no longer exists (a stale pointer — not content loss, since the engine renders every EXISTING
  level for every question regardless of the pinned level). The trigger fixes ALL THREE reference
  types atomically: PACKS pinned to the removed level are reset to the highest REMAINING level (a
  pack's level is its questions' fallback and can't be null; since the UI only deletes the highest
  level, this drops affected packs to the next-highest); QUESTIONS pinned to it are un-pinned (level
  = null → they inherit the pack default); OVERRIDE rows at that level are deleted. Verified under
  load (a test level with a pinned pack + pinned question + override → pack reset to next level,
  question nulled, override removed).

**RLS model:** anon = READ-ONLY (published/active content, profiles, logs, targets, notes);
authenticated = full write. Anon write policies were dropped and the lockdown verified.

## 6. Auth
Single shared admin password. Auth user \`admin@positiveminds.app\` in Supabase Auth.
Login uses the password grant → access + refresh tokens stored in localStorage (persists
across tab/browser restarts) with a 7-day window from login. The access token is refreshed
proactively in the background (timer + on tab refocus) and reactively on a 401, so the user
stays signed in until they log out or the 7 days elapse.
Writes send the access token as Bearer. Tokens expire ~1hr; the data layer refreshes
transparently. Sign-out + change-password built in. Anon (publishable) key is safe to
embed publicly and authorizes only reads.

## 7. The transformation engine (customizable output)
Content lives in a stable internal shape; **export profiles** project it into whatever
a consumer needs. A profile's \`spec\` (jsonb) describes:
- \`structure\`: "nested" (packs with questions) | "flat" (one question array) | "keyed" (dict by slug)
- \`root_key\`, \`questions_key\`, \`key_by\`
- \`include_meta\` (envelope with counts/timestamp)
- \`filters\`: { status, question_status }
- \`pack_fields\` / \`question_fields\`: [{ from, to, transform }] — rename + include/exclude
  + per-field transform (none/upper/lower/trim)
- \`value_maps\`: { outputField: { fromValue: toValue } } — e.g. status:active → state:1

\`buildOutput(spec, packs, byPack, keyField)\` runs the projection; \`withMeta\` adds the
envelope. The engine exists in TWO places that MUST stay in sync: the client (engine.jsx)
and the \`game-feed\` edge function (server-side mirror).

Four seeded starter profiles: **Firebase (nested)**, **Flat API (question list)**,
**Unity (keyed dictionary)** — all now include the real \`effective_level\` — and
**Full game export (with levels)**, which turns on \`expand_levels\` to emit the complete
10-level structure per question (the reference profile to point the game at).
Output is available as JSON or XML: the file download offers both buttons, and the
game-feed accepts \`?format=xml\` (mirrored toXml on client + edge).

## 7b. Sync API for external backends (content-api edge function)
A dedicated \`content-api\` edge function (separate from game-feed; verify_jwt=false) is the
full sync API for an external backend (e.g. Firebase) to pull content on demand. One clean,
well-designed shape (NOT the profile-projection system) plus everything needed to sync efficiently:
- \`?manifest=1\` — lightweight version manifest: global_version (epoch of the newest change
  anywhere, incl. deletions), levels_version, per-pack {slug, content_version, active_questions,
  version}. A client polls this and only pulls content when global_version changed.
- (default) — full published content: levels (definitions/rules — including the vocabulary-rule
  fields min_word_len/max_word_len/allow_multiword/vocab_rule) + packs, each with its questions,
  each question carrying its 10 rendered level-variations (same engine as game-feed).
- \`?since=<iso|epoch>\` — INCREMENTAL: only packs that changed (a pack counts as changed if it OR
  any of its questions changed since the cursor; returns that pack's full current question set for a
  wholesale replace) PLUS a \`deletions\` array (from pm_deletions) so the client knows what to remove.
- \`?packs=slug1,slug2\` and \`?levels=1,2,3\` — filter the payload.
- \`?format=xml\` — XML instead of JSON. \`?health=1\` — liveness.
- ETag on every response (hash of global_version + the exact query shape); \`If-None-Match\` →
  304 Not Modified. The match is tolerant of the platform's weak-validator \`W/\` prefix.
- Optional auth: set the CONTENT_API_KEY secret to require a key (X-API-Key header or ?key=);
  unset = public. Works both server-to-server and from the client (CORS *).
Backed by the \`pm_content_manifest()\` RPC (SECURITY DEFINER, published-only) and the pm_deletions
tombstone table. Source lives in the repo at edge-functions/content-api.ts.

## 7c. AI content generation (with mandatory human review)
Two new pages — **AI Settings** (aisettings.jsx) and **AI Review** (aireview.jsx) — plus the
\`generate-questions\` edge function (verify_jwt=TRUE, so only a logged-in admin can spend your API
credits). Supports THREE providers: Anthropic, OpenAI, Gemini (three genuinely different API shapes,
one adapter each).

**The approval gate (non-negotiable):** generate-questions writes ONLY to pm_review_queue, never to
pm_questions. A human must Approve / Edit / Reject each item. Approve goes through the
\`pm_review_approve\` RPC — the single atomic path into live content (creates the question, links it,
records who decided and whether they edited it, tags the question "AI-generated — human approved").
Reject records a reason and writes nothing.

**API-key security:** keys live in pm_ai_config, which the browser CANNOT read (no RLS select policy
at all). The settings page writes keys via \`pm_ai_set_key\` and displays status ONLY —
"Configured ••••••1234" — via \`pm_ai_status\`, which returns a masked hint and never the key. Even
someone with the admin login, or an XSS in this app, cannot lift the keys. Empirically verified.
Rotate by saving a new key over the old one. \`callFn()\` in core.jsx invokes verify_jwt edge fns with

**GENERATION PARAMETERS (per provider, in pm_ai_config):** max_tokens, temperature, top_p,
system_prompt — all editable in AI Settings, each with an (i) explaining what it does FOR THIS JOB.
Originally max_tokens was HARDCODED at 4000, temperature was never sent at all (so you silently got
the default 1.0 — maximally creative, the wrong end of the dial for rule-compliant structured output),
and the game rules were stuffed into the USER turn rather than a system prompt.

**CRITICAL: temperature and top_p are NULLABLE and are OMITTED from the request when unset.** This is
not laziness — it is REQUIRED. Anthropic returns 400 for temperature on Opus 4.7+, and OpenAI rejects
it on GPT-5 reasoning models. Sending a "harmless default" would break generation ENTIRELY on those
models. Because null means "don't change" in the setter, there are explicit p_clear_temperature /
p_clear_top_p flags so a value can actually be UNSET. The UI warns about this in the Advanced section.

Per-provider mapping (they differ, and getting it wrong fails silently):
| Param | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| max tokens | max_tokens | max_completion_tokens | generationConfig.maxOutputTokens |
| temperature | temperature | temperature | generationConfig.temperature |
| top-p | top_p | top_p | generationConfig.topP |
| system prompt | \`system\` field | a system MESSAGE | \`systemInstruction\` (separate field) |

**The \`enabled\` flag is now ENFORCED.** It existed as a column and was reported by pm_ai_status,
but NOTHING ever checked it — so a provider marked "disabled" was still used. Dead config that lies is
worse than no config. The edge fn now refuses with \`provider_disabled\`, and there is a Turn on/off
button (pm_ai_set_enabled). Verified live: a disabled-but-keyed provider returns 400.

**Clearing the system prompt actually clears it.** The UI used to send null when you emptied the
textarea — but null means "don't change" in the setter, so a custom brief could NEVER be removed and
the UI lied (empty box, old prompt still in use). It now sends an empty string, which the RPC treats
as an explicit clear.

**A short batch no longer fails quietly.** If you asked for 20 and got 8, nothing said why. The
response now carries \`requested\`, \`truncated\` and a \`warning\`, and the UI shows it — naming the
likely cause (hit the token ceiling) and the fix.

**Truncation is now surfaced.** A too-low max_tokens cuts the JSON off mid-array and used to appear as
a baffling parse error. All three adapters report stop_reason/finish_reason, and the error now says
plainly: "ran out of output tokens — raise Max tokens or generate fewer questions."

**Saving params must not wipe the key.** You can never read a key back, so pm_ai_set_key accepts a
null key meaning "keep the existing one". (A previous 3-arg overload of this function had to be
DROPPED — it made the call ambiguous, "function is not unique".)

**COST + RATE CONTROL (this was completely missing):** AI generation is the ONLY operation in this app
that spends real money, and it originally had NO brake and NO audit trail at all - no run count, no
token counts, no way to notice a runaway. Now: every provider call (generate / repair / test, success
AND failure) is recorded in \`pm_ai_usage\` with token counts and the actor from the JWT; the edge fn
calls \`pm_ai_rate_check\` BEFORE any provider call and returns 429 if the limits are exceeded
(defaults 20/hour, 100/day); and the AI Settings page shows a Usage panel (runs, questions, tokens,
errors, by provider, 30 days) via \`pm_ai_usage_summary\`. Logging is best-effort so it can never break
a generation the user is waiting on.
the user's token (mirrors rpc()'s 401 refresh-and-retry).

**THE VALIDATOR (\`validateQuestion\` in core.jsx — the reason this is trustworthy):** most quality
rules for this game are MECHANICALLY DECIDABLE, so the machine catches its own errors before a human
sees them. It runs the REAL masking engine at EVERY level and flags: no/multiple {blank}; missing or
identical words; word-length band + multi-word rule for the target level; bad characters; duplicates;
and above all **ambiguous** — the alternate ALSO fits the blank at some level, so the puzzle has TWO
correct answers and a child is marked wrong for a right answer.

**REPETITION CHECKS — five distinct cases, because they mean different things.**
WHERE THEY RUN (Aug 2026): these are ADVISORY and live in pm_lint/pm_lint_details ONLY. None of
them is in validateQuestion, so the review queue will not flag them on new content — that is
deliberate, not drift. See rule 4.15 for the hard/advisory split.
NOT COVERED BY ANY OF THE FIVE: cross-role reuse, where a word is the ANSWER in one question and
the DISTRACTOR in another. \`reversed_pair\` needs the same PAIR; \`overused_alt\` only counts
distractors. It is live in the Calmness pack today — see section 11z.
- \`duplicate\` — same sentence AND same answer. A true repeat.
- \`same_sentence\` — same sentence, different answer. Repetitive phrasing.
- \`answer_reused\` — the ANSWER WORD is already taught elsewhere.
- \`reversed_pair\` — **the same two words offered as the choice, just swapped over.** CALM/PROUD and
  PROUD/CALM. Different sentences, so NOT a duplicate — but the child faces the identical two-word
  decision twice. Found by reading the LIVE feed, not by testing code: the confidence pack really had
  both. Invisible to every check before, because they all grouped by ANSWER only.
- \`overused_alt\` — the same word used as the DISTRACTOR three or more times. A predictable wrong
  option teaches the child "it is never that one" instead of teaching them to read the blank. Also
  invisible before, because nothing ever looked at the alternate.

**DUPLICATE HANDLING (the original three, for reference):**
- \`duplicate\` — same sentence AND same answer. A true repeat.
- \`same_sentence\` — same sentence, different answer. Repetitive phrasing.
- \`answer_reused\` — the ANSWER WORD is already taught elsewhere. This is the one that matters most
  and is invisible if you only compare whole questions: in a 10-20 question pack, teaching BRAVE
  twice is a real quality problem. The flag says exactly WHERE the word is already used.
The de-dup CONTEXT is deliberately wider than "live questions in this pack". It includes:
live questions (active AND inactive) + anything PENDING in the review queue + anything previously
REJECTED + the other items in the SAME BATCH (validated cumulatively, so if the model hands back
BRAVE twice, the second copy is flagged, not the first). Without the queue in scope, two generate
runs before a review would duplicate each other, and a question you rejected would be cheerfully
regenerated next time. The prompt's avoid-list is likewise uncapped (it was truncated at 40 words)
and now lists every taken answer word, calls out previously-rejected words explicitly, and shows the
sentences already used so the model varies phrasing rather than just swapping the word.
In the UI, \`answer_reused\` and \`same_sentence\` are SOFT (amber, advisory — you may still want the
question); everything else is a hard mechanical defect (red). Bulk "Approve N clean" only ever takes
rows with ZERO flags of any kind. At whole-word levels the ONLY clue is
LENGTH, so ANY same-length alternate is ambiguous there. This is not theoretical: BRIGHT/GENTLE,
SURE/GLAD and KIND/MEAN were all found broken at L7-10 in LIVE content — each looks perfectly fine to
a human eye. PARITY INVARIANT: validateQuestion must stay byte-identical between core.jsx and the
edge function (verified across 45 cases), exactly like maskWord.

**Auto-repair:** failures are sent back to the model ONCE with the exact defect ("GENTLE also fits the
blank at levels 7-10 — use a different-length alternate"), re-validated, and swapped in if fixed.
Best-effort: if repair fails, the originals are queued WITH their flags.

**What the machine can't do:** judge tone, meaning, suitability. A rejected test case proved the
point — "PERFECT" passes every mechanical check but a human rightly rejected it as an unhealthy
standard for a child. Machine catches mechanics; human catches meaning. That is why the queue exists.

## 7d. INTEGRATION GUIDE (for whoever builds/maintains the game client)

Everything a client needs to consume content. The shapes below are copied from a REAL response, not
from memory.

**Base URL**
\`\`\`
https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api
\`\`\`
Public by default (no auth). CORS is open, so it works from a browser, a mobile app, or a server.
If a \`CONTENT_API_KEY\` secret is ever set on the function, send it as \`X-API-Key: <key>\` or \`?key=\`.

### The mental model

The CMS is the source of truth. The client keeps a **cursor** (\`global_version\`) and periodically asks
"has anything changed?". If yes, it pulls only what changed, applies deletions, and advances its
cursor. **Questions arrive with every level variation ALREADY RENDERED — the client never does any
masking itself.**

### Endpoints

| Call | Use it for |
|---|---|
| \`?manifest=1\` | Cheap poll. Returns versions only, no content. |
| (no params) | Full pull of all published content. |
| \`?since=<epoch or ISO>\` | Incremental: only changed packs + a \`deletions\` array. |
| \`?packs=slug1,slug2\` | Restrict to certain packs. |
| \`?levels=1,2,3\` | Restrict which level variations are rendered. |
| \`?format=xml\` | XML instead of JSON. |
| \`?health=1\` | Liveness check. |

Every response carries an **ETag**. Send it back as \`If-None-Match\` and you get **304 Not Modified**
with no body when nothing changed.

### The manifest (poll this)

\`\`\`json
{
  "global_version": 1783810085,
  "global_updated_at": "2026-07-11T22:48:04.891Z",
  "levels_version": 1783242969,
  "pack_count": 14,
  "question_count": 12,
  "packs": [
    { "slug": "confidence", "name": "Confidence", "content_version": 56,
      "active_questions": 12, "version": 1783810085 }
  ]
}
\`\`\`
If \`global_version\` matches the cursor you stored, **there is nothing to do**. That is the whole point:
one tiny request instead of pulling all content.

### The content response

\`\`\`json
{
  "meta": {
    "mode": "full",                      // or "incremental"
    "global_version": 1783810085,        // <-- STORE THIS as your next cursor
    "levels_version": 1783242969,
    "pack_count": 14,
    "question_count": 12,
    "generated_at": "2026-07-11T23:31:04.287Z"
  },
  "levels":  [ /* the level DEFINITIONS — see below */ ],
  "packs":   [ /* each pack, with its questions */ ],
  "deletions": [ /* ONLY present when ?since= was used */ ]
}
\`\`\`

**A level definition** (use these for labels, colours, age hints — NOT for masking):
\`\`\`json
{
  "level": 1, "name": "First Words", "tagline": "Just one letter to find",
  "theme": "Simple self-affirmation", "age_hint": "Around 5", "color": "#00B894",
  "hidden_mode": "letters", "letters_hidden_default": 1,
  "letter_position": "middle", "letter_grouping": "grouped",
  "min_word_len": null, "max_word_len": null, "allow_multiword": false, "vocab_rule": ""
}
\`\`\`

**A pack:** \`slug, name, emoji, description, color, difficulty, tags, level, content_version,
updated_at, questions[]\`.

**A question — this is the important one:**
\`\`\`json
{
  "id": "d21d33cc-...",
  "template": "I am {blank} when I try new things",
  "answer": "BRAVE",
  "alt_answer": "BOLD",
  "level": 10,                      // its own level (metadata; does NOT limit the variations)
  "updated_at": "...",
  "levels": [                       // ONE ENTRY PER LEVEL — already rendered for you
    {
      "level": 1,
      "level_name": "First Words",
      "sentence": "I am BRA_E when I try new things",   // <-- SHOW THIS
      "blank": "BRA_E",                                  // <-- the masked word
      "options": ["BRAVE", "BOLD"],                      // <-- SHOW THESE TWO (shuffle them!)
      "answer": "BRAVE",                                 // <-- the correct one
      "alt_answer": "BOLD",
      "target": {
        "word": "BRAVE", "altWord": "BOLD", "blankShape": "BRA_E",
        "wholeWord": false, "lettersHidden": 1,
        "position": "random", "grouping": "spread"
      },
      "frames": {},
      "enabled": true
    }
    // ... one of these per level
  ]
}
\`\`\`

**To render a question at level N:** find the entry in \`question.levels\` where \`level === N\`, show
\`sentence\`, and offer \`options\` (shuffled). The child is right if they pick \`answer\`. That is all.

### A complete sync implementation

\`\`\`js
const BASE = 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api';

async function sync(store) {
  // store = { version: number|null, etag: string|null, packs: {...}, levels: [...] }

  // 1) Cheap poll. Nothing changed => stop here.
  const m = await (await fetch(BASE + '?manifest=1')).json();
  if (store.version && m.global_version === store.version) return { changed: false };

  // 2) First run => full pull. Otherwise => incremental.
  const url = store.version ? BASE + '?since=' + store.version : BASE;

  const res = await fetch(url, {
    headers: store.etag ? { 'If-None-Match': store.etag } : {},
  });
  if (res.status === 304) return { changed: false };   // belt and braces
  if (!res.ok) throw new Error('sync failed: ' + res.status);

  const data = await res.json();

  // 3) Apply deletions FIRST (incremental only).
  for (const d of data.deletions ?? []) {
    if (d.type === 'pack')     delete store.packs[d.slug];
    if (d.type === 'question') removeQuestionById(store, d.id);
  }

  // 4) Upsert. A returned pack always carries its FULL current question set,
  //    so replace it wholesale — do not try to merge question-by-question.
  for (const pack of data.packs) store.packs[pack.slug] = pack;

  // 5) Level definitions (labels/colours). Cheap; just take the latest.
  if (data.levels?.length) store.levels = data.levels;

  // 6) Advance the cursor. Do this LAST, only after everything applied cleanly.
  store.version = data.meta.global_version;
  store.etag    = res.headers.get('etag');

  return { changed: true, packs: data.packs.length };
}
\`\`\`

### Rules for the client (learned the hard way)

1. **Never assume 10 levels.** Levels are data and can be added (up to 100). Iterate whatever the feed
   reports. Hardcoding 10 will silently drop new content.
2. **Never do your own masking.** The blanks are pre-rendered. If the client re-implements masking it
   WILL drift from the CMS and the game will show a different puzzle than the author designed.
3. **Shuffle the two options.** The correct answer is always \`options[0]\`. Present them in random order.
4. **Apply deletions before upserts**, and **advance the cursor last** — so a crash mid-sync just means
   you redo the same window, rather than skipping it.
5. **A pack in an incremental response is complete.** Replace it wholesale rather than merging.
6. **Only published packs and active questions are ever returned.** Unpublishing a pack shows up as a
   deletion in \`?since=\`.
7. **The integer cursor is safe.** \`global_version\` is a floored epoch, so it can re-send the boundary
   row but will never skip one. Redundant, never lossy.

### Testing it

\`\`\`bash
curl 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api?health=1'
curl 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api?manifest=1'
curl 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api?packs=confidence&levels=1'
\`\`\`

## 7e. CLAUDE CONNECTOR (MCP) — partners write content by talking to Claude

Three trusted partners connect this CMS to their OWN Claude account and propose content by simply
asking for it: "write 15 questions for Calmness about bedtime worries". Their Claude subscription pays
for the generation — no API key of ours is involved.

**WHY IT IS SAFE, and this matters more than any permission check:** a partner CANNOT reach a child.
\`pm_review_approve\` is the ONLY path into live content and it requires a human to press Approve. So
the worst a partner can do — even a compromised one — is fill the review queue with things you reject,
plus create or rename pack containers. That is the entire blast radius. There is deliberately NO tool
to DELETE a pack, and none to approve or publish a QUESTION.

**The server:** edge function \`mcp\` (verify_jwt=FALSE — partners authenticate with their own token,
not a Supabase JWT). Speaks JSON-RPC 2.0 over Streamable HTTP. Ten tools, deliberately narrow:
| Tool | Reads | Writes |
|---|---|---|
| \`list_packs\` | packs (published + draft) w/ per-pack stats, level rules, the brief | — |
| \`get_pack_content\` | existing questions, words already used, pack statistics | — |
| \`check_questions\` | — | — (pure validation, saves nothing) |
| \`propose_questions\` | — | **the review queue ONLY** |
| \`create_pack\` | — | a new pack row (published immediately) |
| \`update_pack\` | — | an existing pack's details (never its slug) |
| \`review_status\` | ALL contributors' queue rows + reject reasons | — |
| \`preview_questions\` | renders drafts/queue as a CHILD sees them | — |
| \`reject_questions\` | — | rejects PENDING queue items (never approves) |
| \`edit_queued_question\` | — | fixes a PENDING queue item, re-validated |

**PACK CREATION (Aug 2026).** \`create_pack\` mirrors the CMS's own PackEditor + \`savePack\` convention
EXACTLY — same \`slugify\` as core.jsx, \`sort_order = count + 1\`, emoji default 💪, the same pack-detail
fields (purpose / focus_areas / style_approach / example_objectives), and an activity-log row. Three
deliberate differences from the CMS form: the slug is collision-checked up front (the form does not
check), the level is validated against the real \`pm_levels\` list, and \`status\` is **published**
rather than draft.

Publishing the CONTAINER immediately is safe because the two gates are independent: a pack is only a
container, and its QUESTIONS still reach it solely through the review queue. A newly created pack is
simply EMPTY until Albert approves content into it. \`update_pack\` patches only the fields supplied;
the slug is immutable because the game and \`get_pack_content\` key on it, and changing \`level\` on a
pack that already has questions returns a WARNING (not a block) since those questions were written to
the old level's word-length band. Every create/update writes \`pm_activity\` with
\`actor = 'partner:<name>'\`, so connector-originated changes are identifiable in the CMS.

**PER-PACK STATISTICS.** \`list_packs\` returns \`stats\` for each pack (live_questions,
distinct_answer_words, awaiting_review) plus a \`how_to_start\` hint, and \`get_pack_content\` returns a
\`statistics\` summary. This exists so a contributor can SEE how full each pack is and choose where the
gaps are, instead of guessing. \`list_packs\` includes DRAFT packs as well as published (and returns
each pack's \`status\`) — otherwise a contributor could not see a pack that was not yet published.

**REVIEW STATUS (Aug 2026).** \`review_status\` closes the feedback loop: a contributor proposes into
a queue and otherwise never learns what became of it. Read-only. Optional \`pack_slug\` narrows it.

VISIBILITY IS SHARED AND EQUAL — every partner sees EVERY contributor's submissions, with
attribution. An earlier version scoped it to the caller; that was removed because the boundary did
not hold anywhere else: under the shared-admin model (option B) partners log into the CMS with the
same credentials and can already see everything. A per-caller filter on this one tool was therefore
cosmetic, and seeing each other's rejections is the fastest way for a new contributor to learn the
bar. It returns totals across all contributors, a \`by_contributor\` breakdown (incl.
approved_but_edited_first per person), \`by_pack\`, the live pending queue with who submitted each
and when, the reviewer's \`reject_reason\` for recent rejections, and a \`your_own\` convenience block.

### Preview, edit and reject — the pre-approval review surface (Aug 2026)

**\`preview_questions\` is the important one.** It renders a question EXACTLY as a child sees it —
the sentence with the masked word in place — AT EVERY LEVEL. It mirrors buildLevelVariants in
core.jsx: whole-word levels blank the entire word (min 3 underscores), otherwise maskWord hides
letters_hidden_default letters at the level's position/grouping. It works on drafts (nothing saved)
or on the pending queue, where it also returns the queue \`id\` so items can be acted on.

Why it matters: every other check is mechanical. The engine can prove two words are different
lengths; it cannot tell you whether a sentence is the right thing to teach a child. Seeing
"I feel _____ when I try." the way a seven-year-old sees it is what makes a human judgement
possible. NOTE: frame_slots are NOT resolved (connector questions never set them, and resolveSlots
would be a fifth parity copy) — rows that have slots are flagged instead of rendered wrong.

**\`preview_questions\` takes \`source\`** — "pending" (default, what is awaiting review) or "live"
(a pack's already-approved bank, requires \`pack_slug\`). The SERVER fetches and renders either. An
earlier version achieved the live case by instructing the assistant to call get_pack_content, convert
____ back to {blank} and remap fields; that worked but was the server's job done by a prompt, and it
was replaced.

**Truncation is reported, never silent.** A preview returns at most PREVIEW_CAP (40) questions, but
the TRUE total is counted separately and returned as \`total_in_pack\` / \`total_awaiting\` alongside
\`showing\` and a \`truncated\` flag, with the note saying so. Reporting only the capped length would
have quietly told the person "12 questions" when the pack had 90 — the same silent-truncation trap
that has bitten this project twice before. Not currently reachable (largest pack is 12) — fixed while
it was still latent.

**The live branch returns \`question_id\`, not \`id\`.** Deliberate: reject_questions and
edit_queued_question only ever accept PENDING review-queue ids. A field called \`id\` on a live
question invites feeding it to those tools; it would fail safely ("Review item not found") but the
naming removes the trap.

**The rendering instruction carries the CMS design tokens** (taken from core.jsx, verified to match):
background #F6F5FB, white cards with #E4E0F0 borders at 16px radius, ink #191728 / #6E6B85, brand
#6C4CE0 for the selected level tab and the masked blank, correct #DEF5F1/#0E8C7E/#0A6B60, wrong
#FDECEC/#C2352F, monospace words — so the playable card looks like part of the product rather than a
generic widget. If the palette in core.jsx changes, this instruction must change with it.

**\`reject_questions\`** rejects pending items with a required reason, via the existing
pm_review_reject RPC (which enforces status='pending' itself). GOTCHA: that RPC stamps \`decided_by\`
from a JWT email claim, which the service-role connector does not have — it would record 'admin'.
The real actor is patched in afterwards as \`partner:<name>\`. Verified live.

**\`edit_queued_question\`** fixes a PENDING item in place (the CMS edits at APPROVAL time instead,
via pm_review_approve's optional params — this is a different, additive path). The merged result is
RE-VALIDATED with the full engine and refused if it breaks a rule, so an edit can never make things
worse; verified live by trying STEADY/GENTLE (same length) and having it correctly refused with the
original left untouched. The row being edited is excluded from the dedup set or it would flag
itself. It deliberately does NOT set the \`edited\` flag — that means "the APPROVER changed it at
approval time" and is what review_status reports as approved_but_edited_first.

**WHY THIS IS ALL SAFE:** every one of these is PRE-approval. Rejecting only removes something from
the pipeline. An edited item stays pending. Nothing here can put a word in front of a child —
pm_review_approve is still the only route, and there is deliberately no tool for it.

### How the preview is rendered — BOTH paths now work

The goal was a PLAYABLE card in chat: sentence, level tabs, two tappable words going green/red.
There are two ways it can happen, and as of Aug 2026 both are live.

**Path 1 — the ARTIFACT (always available, no platform dependency).** preview_questions returns
structured data and the tool description asks the assistant to build the card as an artifact. This
is the FALLBACK and it must stay working: any host without MCP Apps support gets this, and so does
any session whose tools/list predates the widget being enabled.

**Path 2 — the MCP Apps (SEP-1865) WIDGET, verified rendering Aug 2026.** The shim serves a ui://
resource as text/html;profile=mcp-app via resources/list + resources/read, and injects
_meta.ui.resourceUri INSIDE the preview_questions tool object in tools/list (nested form; the flat
_meta["ui/resourceUri"] is deprecated in the spec and deliberately not sent). The view itself is
mcp-shim/view-app.js, raw JSON-RPC over postMessage, no SDK, because the Worker has no bundler.
(preview-app.js and overview-app.js were merged into it — see THE VIEW below.)

THE BUG THAT MADE IT LOOK IMPOSSIBLE, and it is worth knowing exactly what it was. For three
iterations the widget was described as rendering BLANK, and the file recorded a platform gap as the
likely cause. It was never blank. It was CLIPPED to about one card's header. The evidence was in the
screenshot the whole time: the diagnostic status bar read "data received — 12 question(s)" and the
first card's chips were drawing. The host had fetched the resource, the view had mounted, the data
had arrived.

The actual cause: the view never sent \`ui/notifications/size-changed\`. Per SEP-1865, when a host
uses FLEXIBLE dimensions (maxHeight, or nothing at all) the VIEW owns its height and MUST report it,
and the host resizes the iframe to match. The min-height:160px that had been added to force the issue
could never have worked — an iframe is sized from OUTSIDE, so its own stylesheet cannot make it
taller. Three further deviations were found in the same reading of the spec: ui/initialize sent the
wrong params (it wants appInfo + appCapabilities, and availableDisplayModes is what lets a host offer
fullscreen); the initialize RESULT was never read, discarding hostContext.containerDimensions, theme
and displayMode; and \`ui/notifications/context-update\` is not a method in the spec at all, so every
reviewer interaction had been posting into the void — the real one is the ui/update-model-context
REQUEST.

The lesson is not about iframes. Three sessions were spent iterating against a guess when the answer
was in the specification, and a screenshot that showed the widget half-working was read as showing it
not working at all. See rules 4.33 and 4.21.

**Regression safety.** The text content block still carries the full JSON, so path 1 stays reachable
if the widget fails or the host does not support it. The status bar in the view is permanent and
deliberate: it states its own state ("handshake sent", "NO HANDSHAKE after 5s", "12 question(s)"), so
a failure is loud rather than silent. That is rule 4.24, which this feature broke once already.

**Test:** mcp-shim/widget-test.mjs drives the view through the real lifecycle in jsdom — handshake,
capabilities, containerDimensions applied, one card per question, level tabs, correct answer not
revealed before tapping, size reported AND tracking content (2,580px for 12 cards, not 60), spec
method used for context updates, teardown answered. 15 checks. Run it with node directly; it is not
in npm test because it needs jsdom, which is not a dependency of the site build.
CAVEAT, per rule 4.20: this harness MODELS the host, so it can only catch bugs that were modelled.
It is not proof of a render. The render was confirmed by a person looking at a real client.

**If you change the widget's layout, keep reportSize() reachable.** Anything that changes height —
level taps, answer taps, theme, font loading, wrapping — must end up calling it, or the frame will
be wrong again in exactly the way that cost three sessions.

### ARRIVAL: the \`overview\` tool and the connection-time hook

A partner attaching the connector used to arrive at ten tools and no idea what was in the system.
They now get a full picture on arrival.

**THERE IS NO "ON CONNECT" EVENT IN MCP.** Nothing fires when someone attaches a connector, so there
is nowhere to push a greeting. The one thing a host reads at connection is the \`instructions\` string
from \`initialize\`. That is the hook — and it must be a DIRECTIVE TO CALL a tool, never the content
itself: instructions are a static string and would be stale the moment anyone proposed a question.

The shim PREPENDS its orientation directive rather than replacing what the mcp function returns; the
upstream instructions carry the intent-routing that stops an unconditional "always call X first"
from hijacking unrelated requests. It also fires on a greeting or "what can I do here", not only on
a literal first message, because that is when people actually ask.

**THE TOOL.** \`overview\` is read-only and declared FIRST in tools/list. Position is not decorative —
a tool listed first is the one reached for when someone opens with "what's here?". It returns every
pack with live and awaiting-review counts, totals split published/draft, how many packs are EMPTY
(rather than making the reader count fifteen entries), the review queue by pack and contributor, the
nine things a partner can do in plain language, and the one thing they cannot: approve.

**IT IS COMPOSED IN THE SHIM** from the existing list_packs and review_status reads, called with the
CALLER'S OWN token. No new credentials and no new privilege — nothing here is anything that partner
could not already read; it just saves three round trips and a lot of phrasing. It lives in the shim
because the shim deploys from the repo on push. If edge-function CI takes over deploys, this belongs
upstream in mcp.ts, and that is a deliberate trade recorded rather than left silent.

**COMPOSING TOOLS MEANS INHERITING THEIR FAILURE SEMANTICS — see rule 4.35.** Caught by testing the
DEPLOYED shim, not by reading the code: an unauthenticated call returned HTTP 200 with a cheerful
"Partial overview" instead of 401. Nothing leaked, but MCP clients start the OAuth flow off a 401
with WWW-Authenticate. Since overview is now the FIRST call of every session, an expired token would
have shown a partner an empty CMS in confident detail and never prompted them to sign in. 401/403 are
now propagated; a genuine upstream outage (503) is still a partial 200, because those are different
failures and must not be collapsed.

**Partial results are flagged.** A tool whose whole job is "here is where things stand" must never
answer with a confident zero that actually means the call failed. If either leg fails, the headline
says "Partial overview", the failing leg is named, whatever did arrive is still returned, and the
render instruction tells the presenter not to pass partial numbers off as complete.

**Test:** mcp-shim/overview-test.mjs — merge, totals, ordering (packs needing a human sort first,
empty packs sink), the menu, the invariant, tools/list declaration and position, and every failure
mode including the 401/403/503 distinction. 22 checks, no live data touched.

### THE VIEW: one file, both payloads, and the two level controls

**ONE VIEW, NOT TWO.** There were briefly two ui:// resources — a question preview and an overview
menu — each linked to its own tool via _meta.ui.resourceUri. CLAUDE WEB DOES NOT HONOUR THAT. It
loaded the question-preview resource for an \`overview\` call and then sent it nothing, so a partner
saw an idle widget beside a perfectly good answer. It picks ONE view per connector.
Proved, not guessed: each view was made to NAME ITS OWN RESOURCE in its status bar, and one
screenshot settled it (rule 4.21). Reordering resources/list would probably have fixed it and would
also have destroyed the evidence.
So mcp-shim/view-app.js is the single view; both URIs serve it and it dispatches on the SHAPE of the
payload — a \`previews\` array vs \`what_you_can_do\` + \`content_status\` — rather than on which tool
the host believes it is showing, since the host has already been wrong about exactly that. A test
asserts the lifecycle code exists EXACTLY ONCE, because a second copy would have been a fourth
parity problem waiting to happen.

**TILES: ui/message, and what to do when it is refused.** Tapping a capability posts a plain-English
request into the chat via \`ui/message\`. The spec lists NO host capability for it, so the only way to
know whether a host supports it is to send one and READ THE REPLY — and this host refuses it. Every
message now carries an id, its reply is handled, and a 2.5s timeout catches silence.
THE ORDERING MATTERS: the clipboard copy runs DURING the tap, synchronously, inside the gesture.
The first version only fell back AFTER the rejection arrived, which meant the first tap did nothing
visible and the copy needed a second — and a copy fired from an async rejection is not reliable at
all, because clipboard writes require a user gesture. One tap now always achieves something: the
tile says either "Sent" or "Copied — paste it below", keeps its label, and shows the phrase to type
if there is no clipboard.

**TWO LEVEL CONTROLS, on purpose.** The GLOBAL bar sets every question at once — "how does this pack
read at level 7?" is a property of the sitting, not of each question, and setting it twelve times
made comparison at a fixed level nearly impossible. The PER-CARD tabs stay, because the other real
job is checking ONE question ACROSS levels, which is how the same-length bug is actually felt.
A card moved on its own is marked "own level" and the global bar reports MIXED with nothing
selected, rather than highlighting a level that is only true for some of them. Question cards carry
\`.card.q\` and the header \`.card.head\`, so counting cards means counting questions.

**A MERGE HAZARD WORTH KNOWING.** Combining the two views spliced one stylesheet into the other by
cutting at \`body.dark{...}\` — which silently discarded every dark rule after that line. The visible
result was white numbers on white tiles: \`.stat\` kept its light background while \`.stat b\`, having
no colour of its own, inherited the dark-mode text colour. Only the purple stat survived, which made
it look like a design choice. ANYTHING WITH ITS OWN BACKGROUND NEEDS ITS OWN FOREGROUND.

### THE VIEW URI IS CONTENT-ADDRESSED — and why it has to be

**A HOST WILL SERVE YOU YESTERDAY'S WIDGET.** SEP-1865 explicitly allows hosts to prefetch and cache
a ui:// resource, and they key that cache on the URI. There is NO message in the protocol for "that
resource changed". So with a fixed URI, a view can be redeployed, verified live over the wire, and
the person still sees the old one — which is exactly what happened with a wording change: deployed,
confirmed by fetching resources/read, and still wrong on screen for three rounds.

**THE FIX:** \`UI_URI = "ui://positive-minds/view-" + djb2(VIEW_HTML)\`. Change one character of the
view and the URI changes, which a host cannot mistake for something it already holds. Nothing to
remember to bump — and that matters, because the failure is SILENT and looks exactly like a deploy
not working. djb2 rather than crypto.subtle because the URI is built synchronously.
The old fixed URIs stay SERVABLE (a session holding one keeps working) but are no longer advertised.

**ONLY ONE RESOURCE IS ADVERTISED.** Two entries for the same file only invited the host to pick the
"wrong" one, which it did.

**A WIDGET NEVER RE-FETCHES.** An already-rendered widget keeps the HTML it was born with, for the
life of that message. Scrolling back to an earlier preview shows the version from that moment,
permanently — which is not a cache bug and cannot be fixed. When checking whether a view change
landed, ask for a NEW preview; the status line at the top of the card names the build.

### THE VERDICT WORDING LIVES IN TWO PLACES, deliberately

Tapping a word says, exactly:
  correct → "Correct answer — you got it right! 😊"
  wrong   → "Nearly right — you're getting better every time you try 🙂 Try again…"
NEVER "wrong", "incorrect", or anything describing the child in the third person. This view exists so
a person can FEEL what a child feels, and a child using this game is never told they failed.

**THE REVIEWER CHECK SURVIVES, DEMOTED.** The old wrong-answer line ("Marked wrong. If this word ALSO
fits the blank, the question is broken.") was doing two jobs — it was also the prompt that turns a
reviewer's surprise into the same-length bug being caught, the one defect that has broken real
content. Replacing it purely for tone would have removed the check. It now appears under a wrong
answer only, in the small grey hint style, never in the child-facing verdict.

**BOTH RENDERERS CARRY THE STRINGS.** They used to live only in the view, so on a host without MCP
Apps — the documented fallback — Claude phrased the verdict itself and could reproduce the exact
sentence being removed. The wording is now also in preview_questions' render note with an explicit
"do not improvise them". Rule 4.42 applied BEFORE it bit rather than after.

### SYNCING CONTENT OUT: the two APIs, and how to choose

A developer wiring a game or a backend to this CMS needs one decision and then a handful of
parameters. The decision:

  content-api  — SYNCING. Versioning, ?since incremental, deletions, ETag/304, selectable blocks.
                 Use it for the recurring pull that keeps something in step with the CMS.
  game-feed    — SHAPING. A saved profile renames every field and picks the structure, so the
                 consumer gets ITS vocabulary rather than ours. Use it when field names must match
                 an engine you do not control.
Both read the same content, both return the same stats block, and both live at
\`{SUPABASE_URL}/functions/v1/<name>\`. Auth is OPTIONAL: set the CONTENT_API_KEY secret to require
\`X-API-Key\` (or ?key=); unset, the endpoints are public and read-only over published content.

**content-api parameters**
  ?manifest=1            versions and counts only — poll this to decide whether to pull at all
  ?since=<iso|epoch>     only what changed, plus a deletions array of tombstones
  ?include=…             packs, questions, levels, variants, stats, deletions, or all
  ?shape=                nested (default) | keyed (packs keyed by slug) | flat (one question array)
  ?packs= ?levels=       narrow by pack slug, or narrow the variant expansion to certain levels
  ?released=1            only released content (see the gate below)
  ?format=xml            XML instead of JSON

**THE BIG ONE IS \`variants\`.** The pre-rendered per-level sentences dominate the payload:
    default (with variants)     363,038 bytes
    ?include=packs,questions     18,811 bytes     — about 19x smaller
Include them if the client renders what it is given. Omit them and take \`levels\` instead if the
client masks its own words — but then its masking MUST match maskWord exactly, which is the parity
invariant in rule 4.4, and getting it wrong shows a child two correct answers.

**USE THE ETAG.** Every response carries one; send it back as If-None-Match and an unchanged pull is
a 304 with no body. The key covers every parameter, including include, shape and released — so
switching any of them refetches instead of returning a stale 304 for a different question.

**game-feed parameters**
  ?list=1                available profiles
  ?profile=<id|name>     export in that shape (default: first built-in)
  ?stats=1 | ?stats=only add the status block, or return it alone
  ?packs=                narrow — deliberately the SAME parameter name as content-api
  ?released=1 ?format=xml
Profiles are edited in the CMS under Publishing → Export profiles (ProfileBuilder): per-field
mapping (template->sentence, answer->primaryWord), value transforms, structure, root and questions
keys, filters, and include_stats.

**THE STATS BLOCK** (?include=stats, or ?stats=1) is the whole CMS content status in one call,
backed by pm_content_stats(): pack counts by state, question counts and distinct answer words,
level count, review-queue totals, and per-pack live/pending/approved/rejected with descriptions and
versions. Cheap enough for a dashboard to poll, and it short-circuits before loading any content.

**THE RELEASE GATE — off by default, and know why before you turn it on.**
\`released_version\` tracks what has been PUSHED to a configured sync target; publish2 calls
pm_mark_released after a successful Firebase sync or import. A PULL is not a release, so pulls have
never been gated. ?released=1 opts in: only packs where released_version >= content_version.
Today that returns NOTHING, because no push target has ever run — every pack has released_version 0.
If you want the gate in a pull model you must also arrange to release, or the game starves.

**WHAT A CONSUMER SHOULD ACTUALLY DO**, in order:
  1. Poll ?manifest=1 (or send your ETag). If global_version has not moved, stop.
  2. Pull ?since=<your last successful sync>. Apply packs/questions, then apply deletions.
  3. Store the new global_version and the ETag against your sync record.
  4. Never assume a 200 means changed — check the version. Never assume 304 means broken.

### DUPLICATE DETECTION, and APPROVING FROM THE CONNECTOR

**DUPLICATES — the whole database, not exact matches in one pack.** The engine's own \`duplicate\`
flag only fires when an existing question in the SAME pack has the SAME sentence AND the SAME pair.
Everything that actually happens slipped past it: the same sentence with a different pair, a reword
of three words, a question already living in another pack, and anything sitting in the queue rather
than live.
  pm_norm_template()  lowercase, {blank} removed, punctuation stripped, whitespace collapsed. This
                      is the whole trick — without it a comma hides a duplicate.
  pm_find_similar()   searches LIVE content and the PENDING queue together, via GIN trigram indexes
                      over the normalised form, and returns a reason with a severity:
                        1 exact_same_pair  identical sentence AND pair      -> BLOCKS
                        2 same_sentence    identical sentence, new pair     -> BLOCKS
                        3 near_sentence    reworded above the threshold     -> advises
                        4 same_pair        the same two words elsewhere     -> advises
Severity 1-2 block because a duplicate sentence is a defect in the content; 3-4 advise because a
reword may be deliberate and a reused pair is a variety judgement (rule 4.15 draws that line).
REPORT THE STRONGEST REASON: a reword that also reuses the pair first reported as \`same_pair\`,
which reads as a variety nudge when it is actually a near duplicate. Severity now drives both the
label and the ORDER BY so the two cannot disagree.
A FAILED SCAN NEVER BLOCKS A PROPOSAL. It is a check, not a gate.

**CHECKS ARE STORED ON THE QUEUE ROW.** propose_questions writes the whole validation result into
pm_review_queue.validation — flags, similar_questions, vocabulary_advice — plus checked_at,
proposed_by, a CHECKS_VERSION and \`checks_run\` NAMING each check that ran. describeChecks() renders
it in one line for preview_questions and approve_question.
WHY NAME THE CHECKS: a stored {ok:true, flags:[]} cannot tell a reviewer whether a question was
checked and clean, or checked by a build that never looked for duplicates. Absence must be
distinguishable from a pass, so a row below the current CHECKS_VERSION reports "checked by an older
version" and says to play it rather than trust the silence.
Reported at approval AFTER the fact, never as a gate: blocking on stale checks would strand every
question queued before the scanner existed.

**APPROVING.** See rule 4.19 for the reasoning and the conditions. pm_connector_unapprove() is the
undo — it sets the live question inactive and returns the queue row to pending. In short: approve_question takes
ONE review-queue id plus confirm_answer (the correct word, exactly as shown on the card), and
unapprove_question undoes it by setting the question inactive and returning the row to pending.
can_approve on pm_mcp_tokens gates both, defaults TRUE, and tokens without it never see the tools.
THE INTENDED FLOW, and the reason confirm_answer exists:
    preview_questions (source: pending)   -> play the card, tap the words
    approve_question(id, confirm_answer)  -> one at a time
    unapprove_question(question_id)       -> the moment it looks wrong
Approving straight from a list without previewing defeats the point: a same-length pair or a
distractor that also fits the sentence is invisible until the question is played.

### VOCABULARY: why a word must not play both roles

**THE DEFECT.** In the Calmness pack, seven of twelve words are the ANSWER to one question and the
DISTRACTOR in another. QUIET and RELAXED are a straight swap across adjacent questions. A child is
marked wrong for a word and right for it moments later. Confidence has the same with CALM/PROUD.

**THE DEEPER PROBLEM, which cross-role reuse only makes VISIBLE:** the wrong option is often a
GENUINELY correct answer to its sentence. "I stay PROUD when things go wrong" reads perfectly well.
A child who reads carefully is punished for reading carefully. Reuse is the smell; a plausible
distractor is the disease. THE TEST: read the sentence back with the WRONG word in it. If it still
makes sense, the question has two right answers and only one of them scores.

**IT WAS A MISSING INPUT, NOT A MISSING RULE.** get_pack_content used to return
\`answer_words_already_taken\` and NOTHING about distractors — so Claude knew which words were
answers and picked wrong-options blind, landing on words that are correct two questions along.
It now also returns \`distractor_words_already_used\` and \`every_word_in_use\`, and the note directs
writers to move AWAY from that list rather than merely avoid exact duplicates.
THE BRIEF now argues for vocabulary as a goal in itself: twelve questions built from six words teach
less than twelve built from twenty-four. Calmness is 12 questions, 23 word-slots, 16 distinct words.

**check_questions and propose_questions return \`vocabulary_advice\`** per question when a draft's
wrong option is already an answer, its answer is already someone's wrong option, or the answer word
is simply reused. ADVISORY, NEVER BLOCKING (rule 4.15) — it does not break the engine, so it must
not stop a proposal, but the writer and the reviewer should both see it.
FIRST VERSION COMPUTED IT AND DID NOT RETURN IT, which is the same as not having it. Caught only by
running it over the wire against a real pack.

**The nine live instances are NOT auto-fixed.** That is content judgement.

### THE CONNECTOR LOG: what to read when a connection misbehaves

pm_connector_log records EVERY request, logged in a wrapper around the whole handler — the handler
has 22 return points and several (discovery, CORS preflight, the sign-in page, a thrown handler)
answer before any per-branch logging could run. That left the single most important question
unanswerable: when a client appears to do nothing, DID IT EVEN ASK US?

Per request: \`phase\` (discovery/register/authorize/token/mcp), method, redacted query, status,
\`had_auth\`, ua, \`cf_ray\`, \`country\` (which distinguishes Anthropic's cloud from a browser — the
two user agents in an OAuth flow come from different places), \`session_id\`, a truncated \`err\` body
on >=400, and \`ms\`. The per-branch log survives only where it knows the JSON-RPC METHOD, which the
wrapper cannot see without consuming the body.

**NEVER LOG A SECRET.** token, code, code_verifier, client_secret, access_token, refresh_token,
password and authorization become \`<redacted:N chars>\` — present, so absence is distinguishable
from omission, never valued. mcp-shim/logging-test.mjs asserts this with a real-shaped pmk token, an
auth code and a PKCE verifier. A log that quietly accumulates credentials is a breach waiting to
happen regardless of who can read the table.

**A HEALTHY CONNECT LOOKS LIKE THIS** (10 Aug 22:36, read straight off the table):
    python-httpx  POST /mcp                                401   <- correct, triggers OAuth
    python-httpx  GET  /.well-known/oauth-protected-resource     200
    python-httpx  GET  /.well-known/oauth-authorization-server/mcp  200
    python-httpx  POST /mcp/register                       201
    browser       GET  /mcp/authorize                      200   <- sign-in page
    browser       POST /mcp/authorize                      200   <- token accepted
    python-httpx  POST /mcp/token                          200   <- exchange
    Claude-User   POST /mcp  x8, had_auth=true             200/202
\`Claude-User\` rows at 200 with had_auth true mean the connector IS working, whatever any badge says.

### THE "CONNECTION HAS EXPIRED" BADGE IS AN UPSTREAM BUG — do not chase it

The Connectors page can show "Connection issue — Connection has expired" while the connector works
perfectly in chat. THIS IS NOT OUR SERVER. Established from the log above: a complete OAuth flow and
eight authenticated sessions, zero errors, and no polling of any kind afterwards — nothing we serve
feeds that badge.

It is a documented, open, unfixed bug in Anthropic's claude.ai proxy: anthropics/claude-ai-mcp#228,
with #155 (token never attached), #188 (unreachable after the Connections->Customize migration) and
#207 (token issued but never used). First-party connectors are unaffected; it is specific to custom
connectors via mcp-proxy.anthropic.com.

**OUR DATA CONTRADICTS THEIR STATED TRIGGER, which is worth reporting.** #228 says the badge appears
once the access token expires (~1 hour). Ours does not expire until 2036 and the badge appeared
within minutes. So expiry is not the cause; the proxy marks the connection stale for some other
reason.

**DO NOT "FIX" THIS.** Four separate remedies were attempted in one night — a copy-the-URL panel, a
hijack detector, a full shim revert — and every one was wrong because the premise was. Test the
connector by opening a chat and calling a tool. Never by reading the badge (rule 4.41).

### TOKEN LIFETIMES ARE EFFECTIVELY INDEFINITE, and that is deliberate

ACCESS_TTL and REFRESH_TTL are both ~10 years. The usual advice — short access tokens, frequent
refresh — assumes the client REFRESHES. The claude.ai proxy does not, ever (#228, and our own log:
one /token hit at connect, zero refresh grants). So a short expiry is not a security boundary here.
It is a SCHEDULED OUTAGE: the day it lapses the connector dies and nobody remembers why. Everyone in
those issue threads with 1-hour tokens re-authenticates DAILY.

**REVOCATION IS THE CONTROL, and it is stronger than the expiry ever was.** authenticate() re-reads
pm_mcp_tokens.active on EVERY request, so this kills every session for a partner on their next call,
mid-session, immediately:
    update pm_mcp_tokens set active = false where partner = '<name>';

**RESIDUAL RISK, stated not buried:** a leaked access token stays valid until someone revokes the
partner token. That was already true for 30 days; it is now true indefinitely. Mitigations are
revocation (instant) and pm_connector_log (every use recorded).

Ten years rather than a NULL expiry because the auth path checks expires_at unconditionally, and
adding a null branch to the hot path of AUTHENTICATION is a new way to get authentication wrong.

### CONNECTING: the four defects, and why the diagnosis took all night

An earlier version of this section blamed Claude's own OAuth flow, citing \`step=end_error\` and a
\`flow_id\` collision. THAT WAS WRONG — the end_error came from driving the flow in a headless browser
with no Claude session, which naturally fails. It is corrected here because the wrong version was
confidently written and would have sent the next person nowhere.

**THE REPORTED SYMPTOM:** the connector authenticates and the Connectors page then shows
"Connection has expired. You can reconnect to re-authenticate." Server logs full of 200s.

**FOUR REAL DEFECTS, all found, all fixed. None of them alone was "the" cause:**
1. The mcp FUNCTION issued no refresh_token. The code was in the repo and the DB columns existed;
   the hand-paste deploy had simply never happened. Fixed by the first CI deploy.
2. The SHIM kept its OWN hand-written copy of the OAuth metadata, advertising
   grant_types_supported ["authorization_code"] while the function advertised both. Clients read the
   shim's, because it is the one at the domain root. Fixed by DERIVING it from the function.
3. \`/register\` returned grant_types ["authorization_code"] hardcoded, ignoring what the client
   asked for. The registration response is what tells a client what it is ALLOWED to do, so this
   alone stops any refresh regardless of the other two.
4. \`initialize\` answered 200 to anyone, on the reasoning that "the handshake precedes the token".
   Backwards for a protected resource: the 401 with WWW-Authenticate IS the handshake.

**AND THEN THE ACTUAL ANSWER: the connector was working.** Once pm_connector_log existed, one query
settled it. Two user agents tell the whole story — \`python-httpx\` is Anthropic's backend running
the OAuth flow, \`Claude-User\` is the live MCP session:
    03:31:36  Claude-User   initialize 200 auth=true    <- already connected, BEFORE the attempt
    03:31:37  Claude-User   tools/list 200 auth=true
    03:31:40  python-httpx  initialize 401 auth=false   <- OAuth begins
    03:31:41  python-httpx  register   201
    03:31:58  python-httpx  token      200
    03:31:59  Claude-User   initialize 200 auth=true
    03:32:00  Claude-User   tools/list 200 auth=true
Three complete authenticated sessions, all 11 tools listed. The Settings card was showing a status
that did not match what its own backend was doing. THE CARD WAS NOT EVIDENCE. See rule 4.41.

**HOW TO DIAGNOSE THIS NEXT TIME — one query, not four hours:**
    select to_char(at,'HH24:MI:SS') t, path, rpc_method, status, had_auth, ua
    from pm_connector_log where at > now() - interval '20 minutes' order by at;
\`Claude-User\` rows returning 200 with had_auth true means the connector IS working, whatever any
badge says. Test it by opening a chat and using a tool, never by reading the Connectors page.

**pm_connector_log** is written from the shim, INSERT-ONLY under the anon key — it can write a line
and never read one back, so it cannot enumerate clients, partners or tokens. Capped at 2000 rows by
pm_connector_log_prune (this project has blown a storage quota once). Fire-and-forget with errors
swallowed: an observer must never be able to break the thing it observes.

### DEPLOY CHECKING: why a downloaded edge function never matches your source

\`supabase functions download\` does NOT return your source. It returns the extracted ESZIP BUNDLE:
TypeScript transpiled away, formatting re-printed, comments gone, imports resolved and hoisted. On
mcp the download came back 6,400 bytes SMALLER than the repo file.

This matters because the obvious drift check — diff deployed against repo — is a GUARANTEED FALSE
POSITIVE. The first dry run reported drift on all five functions, including ones with no reason to
have drifted. A check that always fires is worse than no check at all.

Normalising both sides (comments, type annotations, generics, non-null assertions, trailing commas,
all insignificant whitespace) narrowed mcp from 6,400 raw bytes to 190. Every remaining divergence
inspected was still an artifact: a type annotation remnant, redundant parentheses the bundler drops
(\`(a*31+b)>>>0\` vs \`a*31+b>>>0\` — identical, since >>> binds looser than +), and a hoisted import.

WHERE THIS LANDS, honestly. The dry run reliably proves the token works, that every function is
deployed, and gives sizes plus a first-divergence with context for a person to judge. It CANNOT be a
pass/fail gate, and it was not tuned until it went green — a check tuned until it passes is worth
nothing. The first-divergence view is not proof of full equality and must not be quoted as such.

THE REAL FIX IS TO STOP NEEDING THE COMPARISON. Once one \`mode: deploy\` runs, deployed == repo is
true BY CONSTRUCTION and CI keeps it true. The drift question then dies permanently, which is the
actual point of the workflow.

### The preview payload is QUESTION-FIRST, on purpose

preview_questions once returned each question with every level nested inside it. Twelve questions x
ten levels = 120 level objects, and the natural way to summarise that is level-by-level — so asking
"preview the pending questions" produced a table of level rules instead of the questions. The data
shape, not the prompt, decided the rendering.

Each preview is now ONE QUESTION: "sentence" (already masked, ready to display), "options" (the two
words), "correct", "level_shown", plus a compact "at_other_levels" of {level, sentence} for tabs, and
"n" for ordering. Only ONE level renders by default; pass "levels" for more. Keep it this way — if
levels ever outnumber questions in the payload again, the rendering will drift back.

### Routing: the instructions branch by intent

The connection instructions used to open with "ALWAYS call list_packs first". That is the WRITING
workflow, but stated unconditionally it hijacked every request, so a preview request called
list_packs and showed its level rules. The instructions now branch: PREVIEW/PLAY/REVIEW-PENDING goes
straight to preview_questions and is told explicitly not to call list_packs first; WRITING keeps the
list_packs to get_pack_content to check_questions to propose_questions chain; progress, packs and
queue-fixing each get their own line. The same warning is repeated inside preview_questions' own
description so it survives if the instructions are truncated or ignored.

**\`reject_questions\`** rejects pending items with a required reason, via the existing
pm_review_reject RPC (which enforces status='pending' itself). GOTCHA: that RPC stamps \`decided_by\`
from a JWT email claim, which the service-role connector does not have — it would record 'admin'.
The real actor is patched in afterwards as \`partner:<name>\`. Verified live.

**\`edit_queued_question\`** fixes a PENDING item in place (the CMS edits at APPROVAL time instead,
via pm_review_approve's optional params — this is a different, additive path). The merged result is
RE-VALIDATED with the full engine and refused if it breaks a rule, so an edit can never make things
worse; verified live by trying STEADY/GENTLE (same length) and having it correctly refused with the
original left untouched. The row being edited is excluded from the dedup set or it would flag
itself. It deliberately does NOT set the \`edited\` flag — that means "the APPROVER changed it at
approval time" and is what review_status reports as approved_but_edited_first.

**WHY THIS IS ALL SAFE:** every one of these is PRE-approval. Rejecting only removes something from
the pipeline. An edited item stays pending. Nothing here can put a word in front of a child —
pm_review_approve is still the only route, and there is deliberately no tool for it.

### How the preview is rendered — the MCP Apps route, and what the "dead end" really was

This section previously recorded MCP Apps as a platform-level dead end. That conclusion was WRONG,
and it is left here in corrected form because the way it went wrong is the useful part.

**The MCP Apps route (SEP-1865) works and is enabled.** The shim implements every rung to spec:
\`initialize\` declares \`resources\` and ECHOES the client's protocolVersion (the mcp function
hardcodes an older one, and a silent downgrade can stop a host offering UI at all);
\`_meta.ui.resourceUri\` is injected INSIDE the preview_questions tool object, not on the result;
\`resources/list\` and \`resources/read\` serve a CONTENT-ADDRESSED \`ui://positive-minds/view-<hash>\` as
\`text/html;profile=mcp-app\`; and tools/call returns structuredContent. All verified over the wire.

**THE FALSE CONCLUSION, and how it survived five attempts.** This file used to state that Claude Web
advertises \`io.modelcontextprotocol/ui\`, accepts the capability declaration and the tool's
\`_meta.ui\`, and then NEVER calls \`resources/list\` or \`resources/read\` — a platform gap matching a
public bug report, unfixable from here. Every part of that was mistaken. The host did fetch the
resource and did mount the view. What looked like "never reaches for the widget" was a view that
mounted, received its data, rendered, and was then CLIPPED to about one card because it never
reported its height (see the section above for the mechanism and the three other spec deviations).

Two things kept the wrong answer alive. First, a screenshot showing the widget HALF working — status
bar populated, first card drawing — was read as showing it not working. Second, a matching public bug
report made the platform explanation feel confirmed; it was pattern-matched to, not tested against.
The instrumentation that "showed" resources/read was never called was measuring the wrong thing.

**Both paths ship.** The artifact path stays as the fallback:  Claude, given the structured data, will build the interactive
card itself as an artifact. That was happening by accident, so the shim now makes it deliberate:
preview_questions results carry a \`how_to_show_this\` instruction telling Claude to render a playable
artifact and, importantly, NOT to reveal which word is correct before it is tapped. Same experience,
no platform dependency.

**The MCP Apps layer is ACTIVE, not dormant.** Earlier text here said to leave it in place because it
might light up one day. It has. Do not delete it and do not treat it as speculative.

**Where this lives, and why it is in the shim not mcp.ts:** the Worker deploys exactly, from the repo,
via CI. mcp.ts can only be deployed by transcribing ~1,300 lines inline. The shim owns "how a preview
is presented"; the mcp function owns what a preview IS. If edge-function CI deploys are ever set up,
the artifact hint belongs in the tool's own note in mcp.ts.

\`check_questions\` is the interesting one: Claude validates its OWN drafts against the real engine
before proposing, so it catches and fixes the same-length-words bug itself. Verified live — given
BRIGHT/GENTLE it correctly reported "GENTLE also fits the blank at levels 7, 8, 9, 10 — two correct
answers", AND noticed BRIGHT was already used. The queue gets BETTER content, not just more.

**AUTH: OAuth 2.1 with PKCE — and this was NOT a choice.** I first built a shared-secret bearer
token, then discovered that Claude's "Add custom connector" screen offers a URL and an OAuth client
ID/secret and NOTHING else. There is no field to paste a bearer token, so Claude would simply never
send that header. The MCP spec is unambiguous: a protected server does OAuth 2.1, or it is authless.

THE LESSON, worth writing down: ask "how will someone ACTUALLY use this?" BEFORE building, not after.
I assumed a token field existed because that is how most APIs work, built for it, and only found out
when Albert asked how partners connect.

The partner's pmk_ token was not wasted — it became the LOGIN CREDENTIAL. Because the partners are
three trusted people, the consent screen is just "paste the token you were sent". From their side:
click Connect → a sign-in page opens → paste → done.

Five endpoints, all on the \`mcp\` function:
| Endpoint | Purpose |
|---|---|
| \`/.well-known/oauth-protected-resource\` | RFC 9728 — "here is my authorization server" |
| \`/.well-known/oauth-authorization-server\` | RFC 8414 — "here are my endpoints" |
| \`POST /register\` | RFC 7591 — Claude registers itself |
| \`GET/POST /authorize\` | the partner's sign-in page |
| \`POST /token\` | code → access token, PKCE verified |
A 401 MUST carry \`WWW-Authenticate\` or Claude never starts the flow.

**THREE BUGS IN THE BASE URL**, all real, all caught by testing rather than assuming:
1. Supabase terminates TLS at the edge, so \`url.origin\` sees plain HTTP — and Claude rejects an
   insecure OAuth server outright.
2. The function is served at \`/functions/v1/mcp\`, not \`/mcp\` — so it advertised URLs that did not exist.
3. The \`host\` header INSIDE the container is Supabase's internal one (edge-runtime.supabase.com), not
   the project's domain — so it sent Claude to the wrong server entirely.
All three vanish if you derive the base from \`SUPABASE_URL\`, which is the authoritative public origin.
Every one of these returned HTTP 200 while being completely wrong: "it responded" is not "it works".

Tables (all RLS-on, ZERO policies — the browser cannot read any of them): pm_oauth_clients,
pm_oauth_codes (PKCE-bound, single-use, 10-minute), pm_oauth_tokens (30-day).

### The Cloudflare discovery shim — REQUIRED, not optional

**THE CONNECTOR URL IS THE SHIM, NOT THE SUPABASE FUNCTION:**
\`https://positive-minds-mcp.alcharles1980.workers.dev/mcp\`

**The problem it solves.** Claude's custom-connector OAuth discovery probes the ORIGIN ROOT for
\`/.well-known/oauth-protected-resource\` and \`/.well-known/oauth-authorization-server\` (bare, and in
the RFC 8414 host-inserted form). A Supabase edge function is served under \`/functions/v1/mcp\` and
CANNOT serve root \`/.well-known/*\` paths — so every probe 404s, Claude never starts the sign-in flow,
and the connector reports **"no tools available"** with no sign-in screen ever appearing. Confirmed
from logs: ZERO well-known requests reached the gateway. This is structural, not a bug in our code —
a bare Supabase function cannot host a Claude custom connector.

**The fix** (\`mcp-shim/\` in the repo — a Cloudflare Worker on its own origin, deployed by
\`.github/workflows/deploy-mcp-shim.yml\` using the existing CLOUDFLARE_* repo secrets):
1. serves both discovery documents at its ROOT (covering bare, \`/mcp\`-suffixed and OIDC forms),
   advertising its OWN URLs;
2. proxies \`/mcp\`, \`/mcp/token\`, \`/mcp/register\` to the UNCHANGED Supabase function;
3. rewrites the 401 \`WWW-Authenticate\` header to point at its own discovery doc;
4. serves its OWN sign-in page for \`GET /mcp/authorize\`, CMS-themed, and submits it via JS.

**Why the shim serves the sign-in page itself.** Proxying Supabase's login page failed twice: the
proxied response arrived as \`content-type: text/plain\` (browsers rendered raw HTML source, so there
was no form to type into), and its native \`<form method="POST">\` submit did NOTHING inside Claude's
OAuth window — the Connect button appeared dead. The shim now renders its own page and posts via
\`fetch\` with an \`X-Shim-Ajax\` header, converting Supabase's 302 into \`{ok, redirect}\` JSON that the
page then navigates to. It shows "Connecting…" and real error text instead of failing silently.
When transforming a proxied body, DROP \`content-length\`/\`content-encoding\`/\`transfer-encoding\` —
they become wrong and cause exactly this class of failure.

**THE LESSON.** The original self-test "proved" the whole OAuth flow end-to-end — but it HARD-CODED
the discovery URLs, so it never exercised the one step a real client performs first. It passed while
the connector was completely unusable. A test that skips the client's own discovery is not a test of
the client's path.

**Table \`pm_mcp_tokens\`** — same security posture as pm_ai_config: RLS on, ZERO policies, so the
browser cannot read it at all. Only sha256 HASHES are stored; the raw token is shown ONCE at creation
and is genuinely unrecoverable. Verified: an authenticated admin reading the table gets [].
RPCs: \`pm_mcp_issue_token\` (returns the raw token exactly once), \`pm_mcp_list_tokens\` (never returns
a token), \`pm_mcp_revoke_token\`.

**Page:** Claude Connector (connector.jsx). Issue a token, see usage, revoke access, and the setup
instructions to hand a partner.

**ATTACK-TESTED:** no token → 401. Forged token → 401. Forged token attempting to write → 401 and
nothing reached the database. A successful propose landed in the QUEUE tagged \`partner:...\`, and ZERO
questions reached the live pack.

## 8. Publishing channels
All emit through a chosen profile:
- **File** — download the transformed JSON bundle.
- **Feed (pull):** \`game-feed\` edge function serves content at a stable URL per profile.
  Endpoints: \`?profile=<name|uuid>\`, \`?list=1\`, \`?health=1\`. verify_jwt disabled;
  pages past 1000 rows; ~60s cache.
- **Push:** POST the payload to a configurable target (Channels tab), CORS permitting.
- **Firebase targets:** saved destinations pairing a profile with a database + layout.
  Modes: Realtime DB (REST direct), Firestore (REST direct w/ typed-value conversion),
  Cloud Function (POST \`{writes,payload}\`). Layouts: per-pack / per-question / single-doc,
  with \`{slug}\`/\`{id}\` path templates. planWrites() builds the op list; fbWriters do the writing.

**Control modes:** manual / auto-on-publish / scheduled (stored in push config).
**Release state:** content_version vs released_version → "pending changes"; a successful
sync calls pm_mark_released to clear it.

## 9. Navigation & views
Sidebar (desktop) / icon rail (tablet) / bottom-tab bar (phone). Routes:
Overview (Dashboard, incl. an at-a-glance one-line index of every pack), Packs (Library),
Questions (AllQuestions global search), Generator (Content Generator — builds a paste-ready
AI prompt), Levels (the 10-level progression structure — view/edit each level's rules),
Health (lint), Publishing (profiles/targets/channels/history), Activity, Developer (three
embedded docs + editable scratchpad).
URL-HASH ROUTING: the current view is encoded in the URL hash (#/questions, #/levels,
#/pack/<id>, empty/#/ = dashboard). On load the app reads location.hash to set the initial
section (so a REFRESH keeps you where you were, and pack URLs are deep-linkable/shareable);
goNav writes the hash; a hashchange listener keeps state in sync so browser Back/Forward and
manual hash edits all work. A pack id from the URL is resolved to the open pack once packs
load (shows the library skeleton in the meantime). The browser tab title also tracks the
current section/pack (document.title).
Command palette (⌘/Ctrl-K): fuzzy nav/actions/theme/jump-to-pack.

## 10. Responsive & PWA
Breakpoints 640 / 1024. Question rows are compact single-lines on desktop and
content-first CARDS below desktop (sentence hero on top, meta+actions footer,
checkbox floated to the corner). 16px inputs (no iOS zoom), bottom-sheet modals on phone,
prefers-reduced-motion respected. Installable PWA (inline manifest blob + service worker
that network-first caches GETs).

## 11. Key gotchas (learned the hard way)
- **PostgREST 1000-row cap:** a big \`limit=\` does NOT defeat it (server max-rows=1000).
  Use \`restAll()\` pagination. Applies to the edge function too.
- **Babel runtime:** must be classic; automatic runtime emits imports that break the <script>.
- **Assembly/hoisting:** cross-file components must be \`function\` declarations; const
  helpers must be defined in a file that loads before consumers.
- **Session expiry:** refresh the token; don't leave the UI "logged in" on 401.
- **Client/server engine parity:** any change to the rendering engine (maskWord, resolveSlots,
  resolveFrameMap, buildLevelVariants) OR the transform engine (buildOutput/projectRow/toXml)
  must be mirrored in the game-feed edge function. Watch the position/grouping PRECEDENCE:
  \`override ?? question.own ?? level.default ?? hard-default\` — must match in both. (A real bug
  lived here: the client gained the question.own step, the edge fn didn't.)
- **View column order:** adding a column to pm_packs shifts \`p.*\` in the view — drop &
  recreate pm_pack_overview rather than CREATE OR REPLACE.
- **PWA service-worker caching:** the deployed app registers an aggressive service worker, so
  after a deploy the browser can keep serving the OLD build — a new feature (e.g. the editor
  preview) looks "missing" when it's actually live. Confirm a change shipped by grepping the
  deployed index.html; tell the user to hard-refresh / clear site data / use incognito. It is
  almost never a code bug when "the thing I just deployed isn't showing".
- **npm prune breaks the build toolchain:** /home/claude/bt has NO lockfile, so a bare
  \`npm install <pkg> --no-save\` PRUNES the "extraneous" @babel packages and silently breaks
  assemble.cjs (which needs @babel/core + @babel/preset-react). Keep a package.json in
  /home/claude/bt pinning @babel/core, @babel/preset-react, react@18.3.1, react-dom@18.3.1 and
  run \`npm install\` (no args) so nothing gets pruned. This package.json lives in the build
  workspace only — it is NOT part of the deployed repo.

## 11y. STARTING A NEW SESSION — everything needed to continue development

Written for a fresh assistant with no memory of this project, holding only a GitHub PAT. Follow it
top to bottom; it assumes nothing.

### 1. Get the code
The repo is PRIVATE. With a PAT (classic, \`repo\` scope):
    git clone https://x-access-token:<PAT>@github.com/alcharles1980-design/positive-minds-cms.git
    cd positive-minds-cms
    git remote set-url origin https://github.com/alcharles1980-design/positive-minds-cms.git
That last line matters: cloning with the token embeds it in .git/config. Scrub it, never commit it,
never echo it into output. Push with the token supplied on the command line instead:
    git push https://x-access-token:<PAT>@github.com/alcharles1980-design/positive-minds-cms.git main

### 2. Set up
    npm install
    node tools/workspace.cjs      # mirrors src/ -> v2/ and edge-functions/ -> the paths scripts expect
Nothing else. There is no framework, no bundler, no dev server.

THE LAYOUT, so nothing is a surprise:
  src/*.jsx              21 modules, the whole CMS. shell/core/primitives are the spine; views1,
                         views2, editors, levels, generator, aireview, aisettings, publish1,
                         publish2, realtime, features, engine, firebase, firebase2 are pages and
                         subsystems; connector.jsx is partner tokens; sysarch.jsx is the partner
                         setup guide shown in the app; devdocs.jsx is THIS document; devnotes.jsx
                         is the viewer over it plus a scratchpad backed by pm_dev_notes.
  tools/                 workspace.cjs (mirror), split.cjs (pm_cms.jsx -> src/), assemble.cjs
                         (src/ -> pm_cms.jsx), build.cjs (-> index.html), verify.cjs (proves the
                         round trip is byte-identical), typecheck.sh (tsc --noEmit over the edge
                         functions, config in tsconfig.check.json — see rule 4.48)
  mcp-shim/index.js      the Cloudflare Worker partners connect to; view-app.js is the MCP App UI
  edge-functions/*.ts    mcp, content-api, game-feed, pack-describe, generate-questions
  engine.js runtime.js read.js inspect.js interact.js visual.js   the six test harnesses

### 3. Read, in this order
  1. This file's section 11z — current state, what is temporary, what is outstanding.
  2. DOC_CLAUDE_MD's golden rules, 4.1-4.45. EVERY ONE EXISTS BECAUSE SOMETHING BROKE. They are
     numbered oldest-first, listed newest-first, and none is theoretical.
  3. DOC_BUILD_PROMPT if you need to understand a subsystem you have not touched.

### 4. The build pipeline — non-negotiable order
    edit src/*.jsx
    bump CFG.build in src/core.jsx        (e.g. 2026.08.10-29 -> -30)
    npm run assemble && npm run build && npm run verify
\`assemble\` concatenates src/*.jsx into pm_cms.jsx; \`build\` compiles to index.html + public/
index.html; \`verify\` proves split->assemble is byte-identical and the two HTML files match.
NEVER hand-edit pm_cms.jsx or index.html — they are generated and will be overwritten.

### 5. The test suites — run ALL of them before pushing
    npm test        # runs SIX suites: engine, runtime, interact, inspect, visual, read
There are six, not two. engine.js and runtime.js are the ones people remember; read.js, inspect.js,
interact.js and visual.js exist, do real work, and are easy to skip for a whole session without
noticing (rule 4.47). Then, after any change under mcp-shim/, run these three by hand — npm test
does NOT cover them:
    node mcp-shim/widget-test.mjs      # the MCP App view, both payload shapes, in jsdom
    node mcp-shim/overview-test.mjs    # the overview tool, failure modes, URI behaviour
    node mcp-shim/logging-test.mjs     # redaction — asserts no secret can reach the log
KNOW THE BASELINE: test:visual reports ~153 MINOR defects and 0 serious. That is steady state (touch
targets under 40px in a desktop-density UI), not a regression. Watch the SERIOUS count.
Edge function changes: compile-check before deploying, because a syntax error ships silently:
    npx esbuild edge-functions/mcp.ts --outfile=/tmp/check.js --format=esm --target=es2022

### 6. What deploys where, and how
Everything deploys from a push to main. There are three workflows:
  .github/workflows/deploy.yml               -> the SITE Worker (positive-minds-cms)
  .github/workflows/deploy-mcp-shim.yml      -> the SHIM Worker (positive-minds-mcp)
  .github/workflows/deploy-edge-functions.yml-> Supabase edge functions, on edge-functions/** only
  .github/workflows/mcp-selftest.yml         -> exercises the connector end to end against the
                                                DEPLOYED shim; run it after touching auth or the
                                                shim, since it tests the thing users actually hit
Secrets already configured: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SUPABASE_ACCESS_TOKEN.
Edge functions can also be dispatched manually with mode=dry-run (compares deployed vs repo, changes
nothing) or mode=deploy, optionally only=<slug>.
Deploys take roughly 60-90 seconds. VERIFY OVER THE WIRE AFTERWARDS — a green Action is not proof
(rule 4.26). Fetch the site and check CFG.build appears; call the shim and check the behaviour.

### 7. Services and identifiers
  Supabase project ref  tytrmjjucqijzcrbwjfm
  Site                  https://positive-minds-cms.alcharles1980.workers.dev
  Connector (the SHIM)  https://positive-minds-mcp.alcharles1980.workers.dev/mcp
  Partners connect to the SHIM's /mcp, never the Supabase function — the shim serves the discovery
  documents at the domain ROOT, which is the only place Claude looks for them.

### 8. How to verify anything
Read pm_connector_log for connector behaviour — it answers in one query what inference cannot:
    select to_char(at,'HH24:MI:SS') t, phase, method, path, status, had_auth, country, ua
    from pm_connector_log where at > now() - interval '30 minutes' order by at;
For the app, fetch the deployed site and grep for what you changed. For edge functions, call them.

### 9. Things that will bite you
- Doc text lives inside JS template literals. ESCAPE EVERY BACKTICK or the build breaks.
- NEVER verify a deploy with a WRITE tool against live data (rule 4.23). A pack description was
  overwritten and lost that way.
- The connector is in REAL USE. pm_review_approve is the only route content takes into a pack.
- The Connectors page badge lies (upstream bug). Test with a tool call, never the badge.
- On EVERY change, update ALL THREE docs in devdocs.jsx in the SAME pass.

### 10. Before you finish
Bump CFG.build, run every suite, update all three docs, push, and VERIFY THE DEPLOY OVER THE WIRE.
If you found something that surprised you, write a numbered rule — that list is the most valuable
thing in the repo.

## 11z. WHERE THINGS STAND (read this first when picking the project back up)

LIVE AND WORKING
- Connector is in real use. Questions have been proposed, approved and rejected through it.
  TOKENS (10 Aug): a shared \`beta\` token was issued for onboarding trials. SHARED IS A TRADE — every
  submission from it reads "by beta", so contributors cannot be told apart in review and rejection
  feedback cannot reach the person who wrote the question. Fine to get people through the door,
  wrong before anyone reviews volume. Switch to per-person tokens (pm_mcp_issue_token) before that.
  Multiple people CAN use one token simultaneously: pm_oauth_tokens is keyed on access_token and
  token_id has no unique constraint, so each sign-in adds a session and none evicts another.
  ACCURACY NOTE (9 Aug): three tokens are active, but the traffic is all Albert's. "albert" has
  55 calls and "albert-reconnect" 16, and those two hold the only bound OAuth tokens. "Steve",
  issued 16 Jul, shows calls_made 0, last_used_at null and no OAuth token — on the data, Steve
  has never completed a connection. Confirm before treating him as an active contributor, and
  before clearing anything of his in the token cleanup.
- Ten tools: list_packs, get_pack_content, check_questions, propose_questions, create_pack,
  update_pack, review_status, preview_questions, reject_questions, edit_queued_question.
- Connector URL is the Cloudflare shim: positive-minds-mcp.alcharles1980.workers.dev/mcp
  (NOT the Supabase function — see the discovery-shim section).
- Preview returns question-first data; the assistant renders it as a playable artifact.
- Site deploys automatically on push (wrangler deploy, Worker + static assets from ./public).
  The shim deploys automatically on push to mcp-shim/.

EDGE FUNCTIONS — CI IS LIVE AND HAS DEPLOYED. deployed == repo is now true by construction.
- First real deploy 10 Aug, and it immediately fixed a production defect: the mcp function had been
  running without refresh-token support for weeks because the code was in the repo and the
  hand-paste never happened. That is exactly the failure the workflow existed to prevent.
- \`only: <slug>\` WORKS. An earlier note here claimed it did not, on the evidence of five functions
  showing fresh timestamps right after an only:pack-describe dispatch. Wrong: a PUSH-triggered run
  forty seconds earlier had deployed everything, which is correct behaviour — push deploys all
  changed functions and sets no filter. The canary log reads ONLY="pack-describe" and
  "Deployed Functions: pack-describe", exactly as intended.
  Two runs seconds apart, and the effect was attributed to the wrong one. When timestamps cluster,
  check WHICH run produced them before writing down a bug (rule 4.40 — read the instrument).
- WHAT ACTUALLY DEPLOYED THE REFRESH-TOKEN FIX: commit a1ca5a8, "OAuth: issue refresh tokens and
  support the refresh_token grant", which had been sitting in the repo UNDEPLOYED from an earlier
  session. The first push through the new CI shipped it automatically. The hand-paste gap closed
  itself the moment CI existed, which is a better argument for the workflow than any written here.
(historical note below)
EDGE FUNCTIONS — the state before 10 Aug
- SUPABASE_ACCESS_TOKEN was added 9 Aug 2026. deploy-edge-functions.yml runs, authenticates and can
  download every deployed function. Verified, not assumed.
- WHAT HAS NOT HAPPENED: no automated deploy has run. Until one does, the live functions are still
  whatever was last hand-pasted, and the hand-paste risk is armed but not yet retired. The first
  \`mode: deploy\` run makes the REPO authoritative and ends this whole class of problem permanently.
  Suggested order: \`only: pack-describe\` first as a canary (smallest, nothing depends on it), verify
  over the wire, then the full run.
- DRIFT, as far as it can be determined: NONE behaviourally. See the dry-run section for why that
  sentence has a caveat in it and cannot be made unconditional.

TEMPORARY THINGS STILL IN PLACE (remove when convenient)
- The SYNC API is documented for developers in two places, kept in step: the CMS itself
  (Publishing -> Channels & sync -> API reference, with per-endpoint parameter tables and copyable
  recipes) and the SYNCING CONTENT OUT section of this document. Change one, change the other.
- pm_connector_log records every connector request (capped at 2000 rows, self-pruning). KEEP IT. It
  is the thing that made connection failures readable, and it settled in one query what four hours
  of theorising could not. See THE CONNECTOR LOG section for how to read it.
- THE "CONNECTION HAS EXPIRED" BADGE IS AN UPSTREAM BUG (anthropics/claude-ai-mcp#228). The
  connector works; the badge lies. Do not chase it — four separate remedies were attempted in one
  night and every one was wrong because the premise was. Test with a tool call in a chat.
- TOKENS DO NOT EXPIRE in any practical sense (~10 years, and all 31 existing sessions were extended
  to Aug 2036 on 10 Aug). Deliberate: the proxy never refreshes, so a short expiry is a scheduled
  outage rather than a boundary. Revocation is the control — pm_mcp_tokens.active is re-read on
  every request. See rule 4.44 before shortening this.
- CROSS-ROLE WORD REUSE: still nine live instances (7 Calmness, 2 Confidence). Detection now exists
  as ADVICE on new drafts (vocabulary_advice) and the inputs were fixed so it should stop recurring,
  but the existing content has NOT been corrected — that is content judgement. Confidence's
  CALM/PROUD swap is the clearest and worth fixing first.
- OAuth clutter from 10 Aug troubleshooting: ~20 extra pm_oauth_clients rows (every Connect
  registers a fresh client) and 27 \`beta\` sessions in pm_oauth_tokens, plus a few clients named
  diagnostic/browser-test/textcheck from testing the flow by hand.
  DELIBERATELY LEFT: deleting a client cascades to its tokens, and \`beta\`'s live sessions are spread
  across these clients — tidying would cut working connections for no gain. Harmless where it is.
- TOKENS ALL LEFT ACTIVE by decision (10 Aug): albert (55 calls), albert-reconnect (47), beta (131,
  in daily use), Steve (0, never connected). Nothing is revoked.
- (pm_tool_log and toolLog() are GONE — dropped 10 Aug, superseded by pm_connector_log, which
  records strictly more and prunes itself.)
- (The MCP Apps widget is no longer here. It is ACTIVE and verified rendering — see the widget
  section. It is not temporary and must not be removed.)

KNOWN OUTSTANDING (not bugs in the code)
- Admin password is weak, and Supabase leaked-password protection is off. One shared admin account is
  used by all partners; that account can approve, edit and delete children's content.
- A GitHub PAT was used throughout development and should be rotated.
- The Calmness pack's description was overwritten during a smoke test (pm_activity id 8, actor
  partner:albert-reconnect, 9 Aug 09:36, detail "updated via Claude connector (description)").
  The original text is still UNRECOVERABLE — there is no history table, pm_activity records only
  WHICH field changed and never its previous value, and the repo holds no copy. The fixture in
  inspect.js is NOT a witness: it is hand-written test data and disagrees with production on other
  packs. On 9 Aug the smoke-test value "Find your calm." was replaced with a reconstruction,
  "Find your calm and stay steady when things feel big.", written to match the two-clause house
  pattern every other pack follows and the pack's own surviving purpose/focus_areas/style_approach.
  It is a reconstruction, not the original. See rule 4.23.
- Five stale OAuth client registrations and two debug tokens ("albert", "albert-reconnect") can be
  cleared; keep Steve's.
- Twelve published packs currently have no approved questions. Harmless given the separate CMS-to-game
  sync gate, but worth knowing.
- CROSS-ROLE WORD REUSE is LIVE and unchecked. In the Calmness pack SEVEN of twelve words are the
  ANSWER in one question and the DISTRACTOR in another — QUIET and RELAXED are a straight swap across
  two adjacent questions, so a child is marked wrong for QUIET and then right for it. The same shape
  is in the pending Focus Pack batch (CALM and PLAN each play both roles). No check sees it: see rule
  4.15 for why, and for the test that says it ought to. The mechanics are fine in both packs — every
  pair differs in length, so nothing is \`ambiguous\` at any level. This is the same family of defect as
  the original CALM/PROUD find in rule 4.16, one level up.

## 12. Recent hardening & changes (most recent first)
- **Aug 2026 — CONNECTOR MADE ACTUALLY USABLE + pack creation.** Four related changes:
  1. **The Cloudflare discovery shim** (\`mcp-shim/\`). The connector had NEVER worked from a real
     Claude client: a Supabase edge function cannot serve root \`/.well-known/*\`, which is where
     custom-connector OAuth discovery probes, so Claude reported "no tools available" and no sign-in
     screen ever appeared. A Worker now serves the discovery docs at its own root, proxies the rest to
     the unchanged Supabase function, and serves its OWN CMS-themed sign-in page (the proxied Supabase
     page rendered as text/plain and its native form submit did nothing inside Claude's OAuth window).
     **The connector URL is now the shim**, not the Supabase function. Full OAuth verified end-to-end
     through it — register, sign-in, token exchange, authenticated tool calls.
  2. **create_pack / update_pack.** Partners can create a themed pack and edit pack details, following
     the CMS PackEditor+savePack convention exactly. Packs are created PUBLISHED; questions still go
     only to the review queue, so a new pack is empty until approved into. No delete tool. Attributed
     in pm_activity as \`partner:<name>\`.
  3. **Per-pack statistics** in list_packs/get_pack_content, so a contributor sees how full each pack
     is; list_packs now includes draft packs and returns status. Plus **review_status**, which tells
     a contributor what happened to what they sent — counts by state, per pack, and the reviewer's
     reject reasons so Claude can avoid repeating a rejected mistake.
  7. **Preview tidied + latent truncation bug fixed.** preview_questions gained source pending|live
     so the server does the work instead of the assistant reshaping data; tool descriptions and
     connection instructions moved back out of the shim into mcp.ts where they belong; the render
     instruction now carries the CMS design tokens. Fixed while latent: previews reported the CAPPED
     length as the total, which would have under-reported once any pack passed 40 — now total/showing/
     truncated are all returned. Renamed the live branch's \`id\` to \`question_id\` so it cannot be
     mistaken for a review-queue id. Corrected a stale "THE TOOLS. Four of them" comment (ten).
  8. **Preview made usable, then the widget rolled back.** preview_questions gained source
     pending|live; instructions now route by intent rather than opening with "ALWAYS call list_packs
     first" (which was hijacking preview requests into showing level rules); the payload was
     restructured QUESTION-FIRST after the level-shaped version kept being summarised as levels; the
     render instruction carries the CMS design tokens. The MCP Apps widget was enabled, appeared to
     render blank three times, was found to be DISPLACING the working artifact path, and was disabled
     by removing the _meta.ui link. Also fixed while latent: capped reads now report the true total.
     [SUPERSEDED — see item 9. It was never blank; it was clipped, because the view never reported
     its height. The widget is now enabled and confirmed rendering.]
  6. **Playable preview.** Tried MCP Apps (SEP-1865) for a real interactive widget — implemented
     correctly and verified over the wire, but concluded Claude Web never fetches the resource for a
     CUSTOM connector (platform gap, matching an open anthropics/claude-ai-mcp issue). Shipped
     instead by having the tool result ask Claude to render a playable artifact.
     [SUPERSEDED — see item 9. The platform-gap conclusion was WRONG; the host does fetch and render.
     The artifact path remains as the fallback, which is why it was worth building.]
  5. **preview_questions / reject_questions / edit_queued_question** — a pre-approval review surface
     in chat. Preview renders a question as a CHILD sees it at every level, which is the one thing
     no automated check can do (it lets a person judge tone). Reject and edit act only on PENDING
     items; edits are re-validated and refused if they would break a rule. APPROVAL was deliberately
     NOT added — see the note in DOC_CLAUDE_MD rule 4.19.
  4. **Strict-dedup alignment.** The BRIEF and tool descriptions used to tell Claude to avoid word
     reuse and reversed pairs — things the validator no longer flags. Variety is now stated as a
     PREFERENCE; the only hard rule is the exact-triple duplicate.
  Also fixed in the same period: the SITE DEPLOY had been failing silently for days because
  deploy.yml ran \`wrangler pages deploy\` against what is actually a Static-Assets WORKER — switched
  to \`wrangler deploy\`, which uses the existing wrangler.toml.
- **NEW: Claude Connector (MCP) — partners write content by talking to Claude.** Three trusted
  partners add this CMS as a custom connector in their OWN Claude account and simply ask for content.
  Their subscription pays for it. New edge fn \`mcp\` (JSON-RPC 2.0, verify_jwt=false), new table
  \`pm_mcp_tokens\`, new page **Claude Connector** (connector.jsx), three new RPCs.
  FOUR TOOLS, deliberately narrow: list_packs, get_pack_content, check_questions (pure validation —
  saves nothing), propose_questions (writes to the REVIEW QUEUE only). No publish. No delete. No pack
  editing.
  [SUPERSEDED Aug 2026 — see the top entry: there are now SEVEN tools; create_pack, update_pack and
  review_status were added. The question-side invariant below is UNCHANGED and still holds.]
  THE POINT: a partner cannot reach a child. pm_review_approve is still the only path into live
  content. The worst they can do — even compromised — is fill the queue with things you reject.
  \`check_questions\` means Claude catches its OWN mistakes before proposing. Verified live: given
  BRIGHT/GENTLE it reported "GENTLE also fits the blank at levels 7, 8, 9, 10 — two correct answers"
  AND noticed BRIGHT was already taken. The queue gets better content, not just more.
  AUTH: a token per partner, NOT OAuth (with three trusted people that would be ceremony). Stored as a
  sha256 hash; the raw token is shown once and is genuinely unrecoverable. Queued rows are tagged
  \`partner:sarah\` so you know whose work you're reviewing.
  ATTACK-TESTED: no token → 401; forged token → 401; forged token trying to WRITE → 401 with nothing
  reaching the DB; an authenticated admin reading pm_mcp_tokens from the browser → []. A successful
  propose landed in the QUEUE and ZERO questions reached the live pack.
- **Deep audit after the restructure — five real bugs, two of them found by reading the LIVE feed.**
  I had just restructured a page, deleted a component and redeployed the edge function. That is exactly
  when things break in ways the existing tests cannot see, because those tests were written BEFORE the
  change. So I went looking specifically for what I had broken.
  FOUND BY READING THE LIVE GAME FEED (not by testing code):
  (1) **\`CALM/PROUD\` and \`PROUD/CALM\` are both live** — the same two-word choice, just swapped over.
  Different sentences, so not a "duplicate", but the child faces the identical decision twice. EVERY
  check was blind to it, because they all grouped by ANSWER only: they saw CALM once and PROUD once and
  reported nothing.
  (2) **\`KIND\` is the distractor in several questions.** Nothing had ever looked at the ALTERNATE word.
  A wrong option that keeps reappearing becomes predictable — the child learns "it is never KIND"
  rather than reading the blank.
  Both are now caught: \`reversed_pair\` and \`overused_alt\` in pm_lint/pm_lint_details, AND in BOTH
  copies of validateQuestion (so the AI cannot generate one and have the review queue call it clean).
  [SUPERSEDED Aug 2026 — the strict-dedup alignment later REMOVED both from validateQuestion and
  restated variety as a preference. They remain in pm_lint/pm_lint_details only. That is intended;
  see rule 4.15, which was rewritten because this entry and the code had been contradicting each
  other. The rest of this entry still stands.]
  FOUND WHILE FIXING:
  (3) **A bug in my own fix.** The reversed-pair message said "(PROUD / PROUD)" instead of
  "(CALM / PROUD)" — I had wrapped max() INSIDE least()/greatest(), so it took the max across the group
  first and both sides collapsed to the same word. The GROUPING expressions are already the two words.
  (4) **Three literal \`\\u2014\` escape sequences** ended up in the edge function's source instead of real
  em-dashes — users would have seen a backslash-u in the middle of a sentence.
  (5) **A LATENT bug, surfaced by the new check:** the queued-questions query was selecting
  \`template,answer,status\` but NOT \`alt_answer\`. So the reversed-pair check would have been completely
  blind to anything already sitting in the review queue. It only came to light because the new check
  needs both words.
  ALSO HARDENED: the Generate page's "default to API if a key exists" effect was only correct BY
  ACCIDENT — it worked because keyReady happens not to change again. If it ever did (a key added in
  another tab, a realtime refresh) it would have yanked the user out of the mode they deliberately
  picked. Now guarded with a ref, so an explicit choice is never overridden.
  VERIFIED: all four edge functions healthy; every one of the 11 live questions confirmed safe in what
  the GAME actually receives (BRIGHT/CURIOUS 6v7, SURE/CONFIDENT 4v9); client↔edge validator parity
  restored and re-verified across 24 cases; all six test layers pass.
- **Generation restructured: ONE page, ONE set of options, TWO ways to run it.**
  THE PROBLEM: generation lived in two places and they disagreed. The Generator page built a prompt
  to copy (with pack, levels, themes, count, format, frames, avoid-existing). AI Settings had a
  SECOND, stripped-down generate panel buried under key management — same idea, but missing themes and
  frame words for no reason. So (a) generation was hidden inside a SETTINGS page, which is the wrong
  home — settings should CONFIGURE, a content page should CREATE; and (b) the API path was a poor
  relation of the manual one.
  THE FIX: the page (renamed \`Generate\`) now leads with a method switch — **Use my API key** or
  **Copy a prompt** — and the options below are IDENTICAL either way. How you run it must not change
  what you're allowed to ask for. Only the right-hand column differs: the API route shows a plain
  summary of what's about to happen plus a Generate button; the prompt route shows the prompt, ready
  to copy. Both end in the same place: the review queue.
  The API option is offered but DISABLED with a reason when no key is saved, rather than failing when
  pressed; and the page defaults to whichever method can actually run.
  Prompt-only options (output format, background context, avoid-existing) are HIDDEN in API mode —
  the edge fn always returns structured JSON, always carries the brief in its system prompt, and
  always avoids existing words. Showing those controls in API mode would be controls that do nothing.
  ALSO: the edge function now accepts \`themes\` and \`with_frames\`, which were manual-prompt-only. The
  two paths are now genuinely equivalent.
  AI Settings now only CONFIGURES: providers, keys, parameters, usage. GeneratePanel deleted (dead
  code rots), with a clear signpost to the Generate page in its place.
- **Visual pass — actually READ the pages, and found three bugs nothing else had caught.**
  HONEST LIMIT FIRST: I cannot take true screenshots here (no browser in the sandbox, and Chrome's
  CDN is unreachable — I tried puppeteer, resvg and sharp). So instead of pretending, I did two things
  that ARE rigorous: computed the real layout boxes from the real evaluated stylesheet, and RENDERED
  EACH PAGE TO READABLE TEXT so I could read what it actually says. The second is what found the bugs.
  BUGS FOUND BY READING:
  (1) **The Health page showed "(untitled)" on every issue row.** The UI read \`d.label\` and \`d.issue\`,
  but pm_lint_details returns \`answer\` and \`code\`. The field names never matched, so every row showed
  "(untitled)" with no issue type. It had been broken the whole time and NO automated check caught it —
  the markup was perfectly valid, it just said nothing useful. Only reading the page revealed it.
  (2) **HelpField had an EMPTY label.** My previous fix wrapped the control in a second \`<label>\` — which
  made it "associated", so my checker passed it — but that label had no text, so a screen reader
  announced an unnamed field. An empty label is worse than none: it defeats the check. Now ONE label
  containing both the text and the control. The inspector now requires a label to have actual TEXT, not
  merely to exist.
  (3) **The AI Review page's copy was wrong** after routing imports through the queue: it said "Every
  AI-generated question waits here", but the queue now also holds hand-written imports. Someone pasting
  their own lines would be confused. Now: "Nothing becomes a real question until you approve it —
  whether an AI wrote it or you imported it yourself."
  Also fixed: Pack detail skipped h1→h3 (heading-level gap).
  ALL SIX TEST LAYERS PASS: DOM inspection, interaction (41 clicks / 55 input changes), runtime mount
  (no React warnings), visual layout (computed boxes, 44 page×device combinations), structural checks,
  and engine parity (1,725 cases identical across all three copies).
  A viewable .html file per page/device is now written to /visual — so a human CAN look at them.
- **ALL imported content now goes through the human review queue.** There were TWO ways content got
  into a pack and only ONE was gated:
    generate-questions (API key) → review queue → human approval  ✓
    Bulk Import (paste)          → STRAIGHT INTO THE LIVE PACK    ✗
  Same AI, same risks, no gate. That is the exact path by which BRIGHT/GENTLE reached children.
  DESIGN DECISION: everything imported goes to the queue — we do NOT try to guess whether a paste
  "came from AI". We usually cannot tell, and a wrong guess means unchecked content reaches a child.
  The gate protects children regardless of where the content came from, so there is no bypass and no
  judgement call.
  WHAT CHANGED:
  • New RPC \`pm_review_enqueue(pack_id, items, source, target_level)\` — pushes a batch into
    pm_review_queue with source 'import' or 'ai-paste'.
  • BulkImport now runs the REAL validator (same engine, every level) on every pasted row and shows
    the flags BEFORE you commit — "Two answers", "Same word", "No blank", "Word reused". You see a
    broken pair in the preview, not after it is live.
  • BulkImport no longer writes to pm_questions at all (verified: zero \`createQuestions\` calls
    remain in editors.jsx). The ONLY path into live content is still pm_review_approve.
  • The review queue labels the source: "Imported" / "Pasted from AI" / the provider name.
  PACK-FILE IMPORT (restore a backup / move packs between environments) is deliberately NOT queued —
  putting a 200-question restore through one-by-one approval would be absurd, and those packs land as
  DRAFTS so nothing reaches a child until you publish. But it no longer imports silently: every
  question is validated and you get a clear warning ("N imported questions have problems — check Health
  before publishing"). Defence in depth without making a restore unusable.
  VERIFIED END-TO-END: mounted BulkImport, pasted three questions including the exact BRIGHT/GENTLE
  pair that reached children, and confirmed — flagged "Two answers" in the preview; button reads "Send
  3 for review"; on submit it calls pm_review_enqueue and makes ZERO direct writes to pm_questions.
- **Comprehensive audit — found TWO BROKEN QUESTIONS LIVE IN A PUBLISHED PACK, and the systemic hole
  that let them sit there.**
  THE SERIOUS ONE: \`BRIGHT/GENTLE\` and \`SURE/GLAD\` were live in the published \`confidence\` pack and
  being served to children by the content API. Both same-length pairs — so at levels 7-10, where the
  whole word is hidden, the child sees \`______\` and BOTH options fit. Pick the "wrong" one and you
  are marked wrong for a right answer. In a therapy app for children's self-esteem that is the worst
  possible failure. Verified against the LIVE API (the game really was receiving them), then fixed:
  GENTLE→CURIOUS (7 letters) and GLAD→CONFIDENT (9 letters) — both still genuinely positive words, both
  now a different length. Published packs now have ZERO ambiguous questions.
  THE SYSTEMIC HOLE: **pm_lint never checked for this.** It checked missing-alt, duplicates, thin packs
  and bad templates — but not the one defect that actually breaks the game. So the app's own health
  check reported everything was fine while two broken questions were live. The AI validator catches
  this for NEW content; nothing was catching it for EXISTING content. pm_lint and pm_lint_details now
  check: ambiguous (ERROR — the headline), same_word, multi_blank, bad_chars, reused_word. The Health
  page leads with "Two correct answers" as its first stat and shows a red banner explaining, in plain
  words, why it harms a child.
  NEW TEST LAYERS (the previous audits could not see any of this):
  • RUNTIME MOUNT — actually mounts every page in a real DOM and captures React's warnings. SSR shows
    none of these. Result: 12/12 pages clean, no key warnings, no controlled/uncontrolled switches.
  • INTERACTION — actually CLICKS things. 41 buttons clicked, 55 inputs changed across every page.
    Nothing broke. (Nothing in any previous audit had ever clicked a button.)
  • ENGINE STRESS — 1,725 cases across all three copies of maskWord: byte-identical, and every
    invariant holds (length preserved, characters uncorrupted, blank count exact, deterministic).
  • SECURITY — attack-tested the newest tables. Anon reading pm_review_queue → [], reading pm_ai_usage
    → [], INJECTING into pm_review_queue → 401 RLS violation (they cannot smuggle content into the
    approval pipeline hoping you bulk-approve it).
  ALSO: hardened DeriveLevelDialog's array guard (\`|| []\` only catches null/undefined; an object still
  throws and white-screens the page — Array.isArray is the correct guard).
  NOTED, NOT CHANGED: devdocs.jsx is 29% of the source (162KB of prose every user downloads for one
  page). It gzips well and the total is 160KB, so it is a deliberate trade-off — the docs living inside
  the app is what stops them going stale.
- **Real-DOM inspection pass — stopped auditing the source and started inspecting the RESULT.** My
  previous passes read the code and grepped for suspicious patterns. That is not inspection. This pass
  renders every page and modal into a real DOM (jsdom) with the real EVALUATED stylesheet, then walks
  the tree checking computed styles.
  FIRST I HAD TO FIX MY OWN ORACLE — twice. (a) I extracted the CSS by regexing the source, which left
  \`\${themeVars(...)}\` template placeholders unevaluated; jsdom silently rejected the whole stylesheet
  and EVERY computed style was a lie. Now it RENDERS GlobalStyle to get the real CSS and aborts if any
  \`\${\` remains. (b) My label check only looked for aria-label/for=, so it flagged every field built
  with our <Field> primitive — but a control WRAPPED IN A <label> is programmatically associated
  (implicit association) and screen readers announce it. Those were false positives. A broken oracle is
  worse than no oracle.
  REAL DEFECTS FOUND AND FIXED:
  (1) **19 unlabelled form controls** — the bare filter dropdowns (status, level, date, pack, sort) had
  no label of any kind. A screen-reader user heard "combo box" with no idea what it filtered. All now
  carry aria-label + title.
  (2) **HelpField provided NO label association at all.** I built it with a <div>+<span> instead of a
  <label>. It looked identical but left every control inside it completely unlabelled to assistive
  tech. Now uses a real <label> (with the (i) button OUTSIDE it, so it can't swallow clicks meant for
  the field).
  (3) **The colour-swatch buttons in LevelEditor were unlabelled** — a coloured square with no text.
  Now aria-label + aria-pressed.
  ALSO: I mangled 12 lines with a careless regex (it inserted attributes INSIDE arrow functions:
  \`onChange={(e) = aria-label="x"> setFoo(...)}\`). Only the BUILD caught it. Repaired, and worth
  recording: never regex-edit JSX.
  VERIFIED: all 11 pages × 4 device classes and all 9 modals — no overflow, no invisible text, no
  illegible fonts, no unlabelled controls, no unlabelled buttons. WCAG contrast checked on the real
  theme colours: every text colour passes AA (warn is 3.86:1, large-text only, and is used only on
  small badges).
- **Layout audit: fixed the white space and stretched formatting.** The previous pass fixed the
  NAVIGATION flipping but only verified pages "render without throwing" — a very low bar that catches
  nothing about layout. This pass rendered every page in its LOADED state (stubbing useAsync, since
  SSR otherwise only ever shows skeletons) and measured the actual column widths.
  WHAT WAS WRONG:
  (1) **Nothing capped the CONTENT.** \`.pm-main\` capped the container at 1080px, but inside it a
  single form field, a settings panel with one control, or a page subtitle simply filled the whole
  1080px. A text input the width of the page, a line of body copy ~150 characters long, and a lot of
  dead space beside it. That IS the "white space / broken formatting". Fixed with readable-width
  constraints: \`.pm-readable\` (720px) on panels, \`.pm-form-2\` capped at 860px, \`.pm-prose\` (680px,
  ~75 chars/line) on every page subtitle and intro. aisettings.jsx, levels.jsx and editors.jsx had
  ZERO maxWidth constraints anywhere.
  (2) **A landscape phone was the worst case.** It gets phone chrome but ~800px of width, and the
  portrait single-column rules stretched one form field to **812px**. Landscape now gets two columns
  (399px each), a 3-col index grid, and side safe-area padding (viewport-fit=cover was letting
  content slide under the notch in landscape).
  (3) Pack detail had an \`<h2>\` as its top heading and no \`<h1>\` — a heading-level skip. Fixed.
  VERIFIED: computed real column widths across 7 device sizes — everything now lands in a sensible
  150–423px range, with nothing over 700px (the "too wide" threshold) and nothing under 80px. All 12
  pages render on all 4 device classes with real data loaded (48 combinations, zero failures).
- **Fixed the mobile layout flipping between different navigations (reported: "flipping in different
  layouts with different menus from the side").** ROOT CAUSE: useBreakpoint keyed purely off
  window.innerWidth (phone < 640). Rotate ANY phone to landscape and its width becomes 667–932px, so
  the app decided it was a TABLET: the bottom nav disappeared, an icon-only side rail appeared, and —
  because the CSS had its OWN parallel breakpoints (@media max-width:639px) — the phone rules were
  lost too, so two-column forms came back, modals stopped being bottom sheets, and iOS resumed
  AUTO-ZOOMING on every input focus. Rotating back flipped everything again.
  THE FIX (three parts):
  (1) useBreakpoint now decides on DEVICE CLASS, not raw width: for a touch device it keys off the
  SHORT side of the screen (invariant under rotation), for a resizable desktop window off live width.
  A phone stays a phone in any orientation; an iPad stays a tablet in any orientation. Verified across
  15 real devices: rotating NEVER rearranges the navigation now.
  (2) Killed the two-parallel-breakpoint-systems problem. The JS now stamps a device class on <html>
  (pm-phone / pm-tablet / pm-desktop / pm-coarse / pm-landscape) and the CSS keys off THAT, so the two
  can never drift apart again. (The old width media queries remain only as a pre-mount fallback.)
  (3) Added the mobile foundations that were missing and whose absence makes a page feel broken rather
  than merely ugly: a global overflow-x guard (one stubborn element shifts the whole page), safe-area
  padding for left/right (viewport-fit=cover was letting landscape content slide UNDER the notch),
  overflow-wrap for long slugs/model names, momentum scrolling + overscroll containment in modals,
  and tap-highlight/touch-action fixes. Coarse-pointer devices get 40px minimum hit targets and 16px
  inputs regardless of screen size.
  VERIFIED: all 12 pages render on all 4 device classes (48 combinations, zero failures), and the full
  App renders correctly at every real device size with the expected layout.
- **Review of the AI-parameters work — three real bugs found and fixed.**
  (1) **Clearing the system prompt did nothing.** Emptying the textarea sent null, and null means
  "don't change" in the setter — so a custom brief could NEVER be removed, and the UI actively lied to
  you (empty box, old prompt still driving the AI). Now sends an empty string, which the RPC already
  treated as an explicit clear. Found by tracing the round-trip, not by reading the code.
  (2) **The \`enabled\` flag was dead config that lied.** The column existed and pm_ai_status reported
  it, but NOTHING ever checked it — a provider you had "disabled" would still be used. Now enforced in
  the edge fn (400 \`provider_disabled\`) with a Turn on/off button and a pm_ai_set_enabled RPC.
  Verified live: a disabled-but-keyed provider is refused.
  (3) **A short batch failed quietly.** Ask for 20, get 8, and nothing told you why. The response now
  returns \`requested\`, \`truncated\` and a \`warning\`, and the UI surfaces it — naming the likely cause
  (hit the token ceiling) and how to fix it.
  Also verified (not assumed): the client→RPC contract works over REST with the exact 9-param payload
  the browser sends (PostgREST resolves by argument name — 200 OK); numeric params serialise as JSON
  NUMBERS not strings, so the UI and edge fn handle them correctly; an untouched save preserves every
  value; a params-only save still does not wipe the key. Prod restored (no keys, active=anthropic, 12
  questions, empty queue).
- **Exposed the generation parameters (they were hardcoded or missing entirely), each with an (i)
  explaining what it does.** Before: max_tokens was HARDCODED at 4000; temperature was NEVER SENT (so
  you silently got the default 1.0 — maximally creative, which is the wrong end of the dial for
  rule-compliant structured output and meant more broken questions); the game rules were stuffed into
  the USER turn instead of a system prompt (models follow system prompts far more reliably); and the
  model list was a static array that would rot. Now per-provider in pm_ai_config: max_tokens,
  temperature, top_p, system_prompt, plus a free-text model box so a new model doesn't need a redeploy.
  THE IMPORTANT PART: temperature and top_p are OMITTED when unset, because Anthropic returns 400 for
  temperature on Opus 4.7+ and OpenAI rejects it on GPT-5 reasoning models — a naive "sensible default"
  slider would have broken generation entirely on those models. The Advanced section warns about
  exactly this. Each of the seven settings has an (i) explaining what it is, why it matters FOR THIS
  JOB, a suggested value, and (for the two dangerous ones) a warning.
  Also: truncation is now surfaced — a too-low max_tokens cut the JSON off mid-array and appeared as a
  baffling parse error; all three adapters now report it and the message says to raise Max tokens.
  Also: saving params must not wipe the key (you can never read one back), so the setter accepts a null
  key meaning "keep the existing one" — and the old 3-arg overload had to be DROPPED because it made
  the call ambiguous ("function is not unique"), which I hit while testing.
- **Deep audit of the AI feature — found what we hadn't thought about.** Verified the one integration
  nobody had tested: approving an AI question DOES bump the pack's content_version and the sync
  manifest's global_version, so Firebase actually pulls it (proved live end-to-end; without that the
  whole pipeline would have been a dead end).
  FOUND AND FIXED:
  (1) **AI pages were unreachable on mobile.** The phone drawer had a HARDCODED list (health, levels,
  activity, devnotes) that never included AI Review, AI Settings — or even Generator. On a phone you
  simply could not approve queued content. The drawer is now DERIVED from NAV, so a new page can never
  be silently stranded again.
  (2) **No cost control or audit trail at all.** Generation is the only thing here that spends real
  money and it was completely invisible and unbounded — no run count, no token counts, no brake. Added
  pm_ai_usage (a row per provider call incl. failures and connection tests, with token counts and the
  actor from the JWT), pm_ai_rate_check (checked BEFORE any provider call; 429 with a clear message;
  defaults 20/hour, 100/day), pm_ai_usage_summary, and a Usage panel on AI Settings. Logging is
  best-effort so it can never break a generation you're waiting on.
  (3) **Approve/reject had a race window.** The RPCs read the row, checked status, then updated — two
  truly simultaneous calls could both see 'pending'. Now SELECT ... FOR UPDATE, so the second blocks
  and then correctly sees 'approved'. Also added a guard for the pack having been deleted between
  generating and approving.
  (4) **The queue counts downloaded up to 10,000 rows to the browser just to count them** — wasteful,
  and silently WRONG past the cap. Replaced with a cheap server-side pm_review_counts() RPC.
  (5) Added a **pack filter** to the review queue (it was one undifferentiated list across all packs)
  and a **"Reject N broken"** bulk action — which deliberately only sweeps up HARD mechanical defects,
  never the soft advisory flags (a reused word may still be a question you want).
  Confirmed already-correct: pm_review_queue cascades on pack delete; double-approve is rejected;
  bulk-approve only takes zero-flag rows. Prod left pristine (12 questions, 15 packs, empty queue).
- **Duplicate handling rebuilt — four real gaps closed.** The original check only caught an EXACT
  duplicate (same sentence AND same answer), which missed the cases that actually matter. Now three
  distinct flags: \`duplicate\` (true repeat), \`same_sentence\` (repetitive phrasing), and
  \`answer_reused\` — the ANSWER WORD is already taught elsewhere, which is invisible if you only
  compare whole questions and is a real quality problem in a 10-20 question pack (BRAVE taught twice).
  GAPS CLOSED: (1) same answer word in a new sentence was NOT flagged; (2) the review queue was
  invisible to de-dup, so two generate runs before a review could duplicate each other; (3) REJECTED
  items were invisible, so a question you rejected got cheerfully regenerated; (4) the avoid-list sent
  to the model was capped at 40 words, so past ~40 questions the model stopped being told about the
  older ones. The de-dup context now spans live questions (active AND inactive) + pending + rejected
  queue items + the other items in the SAME BATCH (validated cumulatively — if the model returns BRAVE
  twice, the SECOND copy is flagged, not the first; verified). The repair pass is seeded with the
  batch's already-good items so a "fix" can't collide with them. The prompt now lists every taken
  answer word (uncapped), calls out previously-rejected words explicitly, and shows the sentences
  already used so the model varies phrasing rather than just swapping the word. UI: answer_reused and
  same_sentence are SOFT (amber, advisory — you may still want the question); mechanical defects stay
  red. Bulk "Approve N clean" still only takes rows with ZERO flags. Validator parity re-verified
  (client ↔ deployed edge fn identical across 22 cases including every duplicate type).
- **NEW: AI content generation with a mandatory human review queue (two new pages, existing pages
  untouched).** Pages: **AI Settings** (aisettings.jsx — pick provider, save keys, generate) and
  **AI Review** (aireview.jsx — the approve/edit/reject queue). New edge fn \`generate-questions\`
  (verify_jwt=TRUE) supporting Anthropic, OpenAI AND Gemini. New tables: pm_review_queue,
  pm_ai_config, pm_ai_settings. New RPCs: pm_review_approve/reject, pm_ai_set_key/clear_key/status.
  New in core.jsx (pure additions): \`validateQuestion\` + \`altFitsBlank\` (the shared validator) and
  \`callFn\` (auth'd edge-fn caller).
  THE GATE: generated questions go ONLY to pm_review_queue — never to pm_questions. A human must
  Approve / Edit / Reject each one. Approve is the single atomic RPC path into live content and tags
  the question "AI-generated — human approved". Reject writes nothing.
  KEY SECURITY: pm_ai_config has NO select policy for anon OR authenticated, so the browser cannot
  read the keys at all. Attack-tested: an authenticated admin SELECT returns [] while the SAME token
  reads pm_levels fine; a direct anon INSERT returns 401 RLS violation. The UI shows only
  "Configured ••••••1234". Even the admin login (or an XSS) cannot lift the keys.
  THE VALIDATOR: runs the REAL masking engine at EVERY level. Its headline flag, "ambiguous", catches
  the defect a human eye cannot — an alternate that ALSO fits the blank, giving the puzzle TWO correct
  answers. Found REAL bugs in LIVE content this way (BRIGHT/GENTLE, SURE/GLAD, KIND/MEAN all broken at
  L7-10 — each looks fine to a human). Byte-identical between core.jsx and the edge fn (verified, 45
  cases) — a parity invariant like maskWord. Auto-repair sends failures back to the model once with
  the exact defect.
  BUG FOUND AND FIXED WHILE TESTING: pm_questions.frame_slots is NOT NULL but queued AI rows have it
  null, so EVERY approve failed until the RPC coalesced it to '{}'. Caught by running the real path.
  All three decisions verified live (approve / approve-with-edit / reject), and a reject test proved
  why humans are still needed: "PERFECT" passes every mechanical check but is an unhealthy standard
  for a child — the machine cannot see that, a person can. Test data cleaned up; prod untouched.
- **Deeper audit pass — one real gap fixed, one enhancement added.** GAP (fixed): the
  pm_level_delete_cleanup trigger handled questions and override rows pinned to a deleted level, but
  NOT packs — a pack pinned to the deleted level was left as a stale pointer (a pack's level can't be
  null, it's the question fallback). Extended the trigger to also reset such packs to the highest
  REMAINING level (verified: a test level with a pinned pack + pinned question + override → pack
  reset to the next level, question nulled, override dropped, all atomically). ENHANCEMENT: Bulk
  import now surfaces the pack level's vocabulary rules — imported answer words outside the level's
  length band (or multi-word when the level disallows it) get a soft “Length” flag and a guidance
  line, so the new per-level vocab rules are actionable at import time. It's advisory only (never
  blocks import; imported questions still inherit the pack level). Band-check logic unit-tested (7/7:
  too-short / in-range / too-long / multiword-not-allowed / multiword-allowed / empty / no-level).
  Also confirmed clean this pass: game-feed's buildLevelVariants is level-count-agnostic like
  content-api (maps over all pm_levels rows, no hardcoded 10) and its masking logic is identical to
  content-api's (the only intentional difference is the output field shape — game-feed emits opts as
  a joined string, content-api emits options as an array); levels are consistently ordered by
  level.asc everywhere; PlayMode renders a chip per real level (no 10-cap); no pack/question is
  currently mis-pinned to a nonexistent level; RLS + grant posture unchanged. Prod left pristine (10
  levels, 14 packs, 11 questions, 0 overrides, 0 tombstones).
- **Audit pass over the expandable-levels work — four real bugs fixed, three improvements, all
  verified live.** (1) DANGLING LEVEL REFS: deleting a level left pm_questions.level and
  pm_question_levels rows pointing at a gone level (there's no FK — level is a plain int), leaving a
  stale effective_level pointer. Fixed with a SECURITY DEFINER BEFORE DELETE trigger
  pm_level_delete_cleanup that un-pins affected questions (→ null → pack default) and drops override
  rows at that level; verified it cleaned 11 derived override rows when a test level was removed.
  (2) DERIVE URL OVERFLOW: db_qlevels.overridesForPackLevel put every question id in one in.(...)
  URL — a large pack would exceed URL-length limits. Now chunked at 150 ids/request (the upsert was
  already chunked at 200). (3) DERIVE FROZE WORD-LEVEL LETTER COUNT: for a whole-word level, derive
  pinned letters_hidden = answer.length, which would silently stop being whole-word if the word was
  later edited (pm_question_levels has no hidden_mode column). Fixed: word-level derived rows leave
  letters_hidden/position/grouping null (the level already forces whole-word); only letters-level
  derives pin concrete values. (4) ADD-LEVEL AT CEILING: the "Add level" button wasn't disabled at
  100, so clicking would try to create 101 and hit a raw CHECK error — now disabled with a tooltip.
  Improvements: (5) LevelsView fetched its own levels copy separate from the shell's realtime-backed
  shared state (a staleness gap where another device's level edit wouldn't refresh this page); it now
  uses the shared levels + reload passed from the shell, so all views share one source of truth.
  (6) Added a friendly client-side min<=max word-length guard before the DB CHECK. (7) Refined the
  CMS "edited" flag (hasOv) so a no-op enabled-only override row (e.g. a word-level derive handle)
  no longer reads as edited. Confirmed clean: maskWord parity client↔edge still byte-identical (720
  cases, 0 mismatches); a real letters-mode Level 11 derived across the confidence pack rendered
  B___E / P_T_E_T / S_R__G etc. through the live feed, then cleaned up; RLS still enforced; grant
  posture clean (new triggers are inert, only pm_content_manifest is callable and anon can't); prod
  left pristine (10 levels, 11 questions, 0 overrides, 0 tombstones).
- **Expandable levels: add new levels above the current top with their own rules, generate/derive
  questions for them, and have them flow through publish/export/both feeds automatically.** Schema:
  raised the level CHECK from 1..20 to 1..100 on pm_levels, pm_questions, and pm_question_levels;
  added vocabulary-rule columns to pm_levels — min_word_len, max_word_len, allow_multiword,
  vocab_rule (free text) — that shape which ANSWER words a level uses (they drive the generator and
  display intent; the masking engine ignores them; CHECK ensures min<=max). Levels page: an "Add
  level N" button creates the next level pre-filled from the current top level's rules via the full
  rule editor (now including the vocab fields), and the top level (highest only) can be deleted to
  keep the ladder contiguous; cards show word-band / multi-word badges. Engine: the shared
  buildLevelVariants already derives every level on demand from pm_levels, so a new level renders
  everywhere (CMS previews + game-feed + content-api) with ZERO per-question work and nothing
  pre-materialized — proven live by creating a real Level 11 (whole-word, spread, 8–14 letter band,
  multiword) and confirming the content-api returned 11 level definitions with the vocab fields and
  BRAVE rendered 11 variations (L11 blank _____), then removing it cleanly. Fixed a latent
  number-based assumption: previewAtLevel's fallback used "level>=7 ⇒ whole word"; now neutral
  (letters) — levels are fully data-driven, never inferred from the number. Generator: the prompt
  now includes each target level's word-length band, multi-word allowance, and vocab_rule, plus a
  reminder that both answers stay in-band yet differ in length, and rule #3 relaxes to allow
  two-word answers when a selected level permits them. Derive: a new "Derive level" pack action
  (DeriveLevelDialog, loads all active questions via db.allQuestionsForPack) materializes editable
  pm_question_levels override rows for a chosen level across the pack — applying that level's masking
  rule to each word, skip-or-overwrite existing, chunked upserts — for when concrete per-question
  rows are wanted to hand-tune. content-api redeployed (v3) to expose the new level fields. All
  three docs updated. NOTE: adding a level is purely additive; the game client must handle however
  many levels the feed reports.
- **Full pre-production audit of the content-api + sync layer; one real bug found and fixed.**
  BUG: unpublishing a pack (published→draft/archived) or deactivating a question (active→inactive)
  was invisible to sync — no tombstone was written (those triggers only fired on hard DELETE), and
  the manifest computes global_version only over published/active rows, so the change could fail to
  advance global_version. A client would keep serving now-unpublished content and never learn to
  remove it. FIX: added SECURITY DEFINER after-UPDATE-OF-status triggers
  (pm_pack_status_tombstone / pm_question_status_tombstone) — leaving the live set writes a
  tombstone (which advances global_version via max(deleted_at) and shows up in ?since deletions);
  re-entering the live set deletes the stale tombstone so a resync doesn't both add and remove the
  item. Verified live: unpublish→global_version advanced + tombstone appeared; republish→
  global_version advanced again + tombstone cleared; original state restored. Everything else
  audited clean: incremental ?since boundary is safe (int cursor floors to before the change, so the
  boundary row is re-sent, never missed); deactivation is covered because a question edit cascades
  to bump the pack's updated_at (verified); RLS empirically enforced (anon cannot read drafts, anon
  INSERT into pm_deletions returns 401 RLS violation, content-api hides drafts); grant posture clean
  (only inert trigger fns are anon-executable, every callable RPC incl. pm_content_manifest is
  authenticated-only); route==menu parity intact (9 nav ids, activity is fallthrough); the 1000-row
  PostgREST cap is handled by restAll pagination; the assemble 'jsxDEV present' warning is the known
  false alarm (only doc-string text, zero real jsxDEV imports/calls; output uses React.createElement);
  all 12 major components render headless. NOTE: pg_net misreports XML Content-Type as text/plain,
  but game-feed (long in production, identical xmlResp) reports the same via pg_net, so this is a
  test-harness artifact, not an API bug — the code sets application/xml. NOTE: pm_deletions grows
  unbounded (pg_cron unavailable on this project to auto-prune); harmless at CMS mutation rates.
- **New content-api edge function: a full sync API for external backends (Firebase).** Separate
  from game-feed; verify_jwt=false. Endpoints: \`?manifest=1\` (version manifest — global +
  per-pack), default (full published content with levels expanded), \`?since=<iso|epoch>\`
  (incremental — only changed packs + a deletions array), \`?packs=\`/\`?levels=\` filters,
  \`?format=xml\`, \`?health=1\`. ETag on every response with \`If-None-Match\`→304 (tolerant of the
  platform's \`W/\` weak-validator prefix — a bug caught and fixed during testing: our bare ETag
  was wrapped as W/"..." so the first 304 attempt returned 200). Optional API-key auth via the
  CONTENT_API_KEY secret (X-API-Key header or ?key=); unset = public. Added the pm_deletions
  tombstone table + before-delete triggers (so deletions are reportable) and the
  pm_content_manifest() RPC (global/per-pack versions). Verified live end-to-end: health, manifest
  (+ETag), full content, 304 on unchanged, incremental since-now returns 0 packs, since-past
  returns changed + deletions, pack filter returns just that pack, and a create→delete→sync cycle
  surfaced the tombstone in the deletions array; BRAVE renders BRA_E→_____ identically to the game
  feed (engine parity preserved across all three consumers). Source: edge-functions/content-api.ts.
- **Full audit pass (no bugs found; one architectural invariant documented).** Rendered all 20
  components (the single "failure" was a wrong-props test artifact — QuestionLevelEditor takes a
  \`variant\` prop, which its real caller passes correctly). Verified: no duplicate component/const
  definitions (the apparent dups were prefix-match false positives — DOC_*, NAV/NAV_PHONE,
  PACK_SOURCE_FIELDS/PACK_TAG_SUGGESTIONS are distinct); no leftover console.log/debugger/TODO in
  shipped code; all RPCs work; only the 2 inert trigger fns are anon-callable; 0 tables without RLS;
  0 dropped columns lingering; client/edge maskWord parity holds (304 cases, 0 mismatches); the live
  game feed renders BRAVE L1 BRA_E → L4 B___E → L10 _____ (confirming earlier live level-sync tests
  were fully reverted — data untouched). Documented a previously-implicit invariant (#4a in
  CLAUDE.md): questions are never pre-rendered — their level-variations are computed on demand
  from pm_levels every render/request, so a level edit propagates live to every inheriting question
  in the CMS and the game; never add a cached per-question variation store.
- **Audit-pass UX fixes on the global Questions page:** (1) the empty-state was misleading — it
  said "Start typing to search…" even when a non-text filter (pack/level/status/date) had matched
  zero, implying nothing was happening; now it's filter-aware ("No questions match these filters"
  vs "No questions yet"). (2) Added a "Clear filters" button that appears whenever any of the six
  filters is active and resets them all — with pack + level + status + date + sort + text it's easy
  to narrow to nothing, so one-click reset matters. Verified via full audit: all 18 components
  render; RLS confirmed live (a draft pack's active question returns [] to the anon API — no leak);
  security posture intact (only the 2 inert trigger fns are anon-callable); client/edge maskWord
  parity holds (504 cases incl. edge-case words, 0 mismatches); game feed renders BRAVE L1→L10; no
  service-role key/PAT in the shipped client (only the safe publishable key).
- **Questions page: added a PACK filter (the one filter it was missing).** The global Questions
  page could filter by text, level, status, when-added, and sort — but not by pack, which made no
  sense for finding a specific pack's questions. Added an "All packs" dropdown (every pack,
  alphabetised, with emoji) wired to the search RPC's existing \`pack\` param — so no backend change
  was needed, just the frontend control + passing the packs list into AllQuestions. Verified the
  RPC discriminates (an empty pack returns 0, Confidence returns 11).
- **Levels page: the rules for each level are now legible at a glance (+ live preview).** The
  cards previously showed only the free-text rule prose; now each card also shows a plain-English
  summary of the ACTUAL mechanical rule (derived from hidden_mode/letters_hidden_default/
  letter_position/letter_grouping via a new describeLevelRule helper — e.g. "Hides 3 letters
  toward the middle, spread apart" / "Hides the whole word") and a live "Looks like" sample word
  masked through the real maskWord engine (sampleMask helper), so you see the true shape without
  opening the editor. Intro reworded to make clear the rules are LIVE (they drive the game) and
  editable via the per-level Edit button (which already exposes every field). Full editing was
  already available; this is about visibility. (Also fixed a stale "Basic ≈ 1–6 / Advanced ≈ 7–10"
  tier reference in the Architecture levels section — the tier concept was removed.)
- **Doc verification pass (all three docs checked against the live system).** Confirmed all 9
  tables, 9 functions (exact signatures), and the view are documented; the pm_questions /
  pm_levels / pm_question_levels schemas match reality (no dropped columns claimed, live override
  columns present); the nav section lists all 9 pages incl. Generator and describes the URL-hash
  routing; and the RPC/feature specs are current. Filled two real gaps found in the golden-rules +
  build docs: (1) the RPC-grant footgun — DROP+CREATE on a function silently restores the PUBLIC
  execute grant, so anon regains call access unless you revoke from PUBLIC (added to CLAUDE.md
  invariants + the Build Prompt's grant instruction); (2) the URL-hash routing invariant — don't
  revert nav to plain constant-initialised state or you reintroduce the refresh-loses-your-place
  bug (added to CLAUDE.md).
- **Fixed: refreshing the page always dumped you back on the dashboard (URL now reflects the
  view).** nav was plain React state initialised to "dashboard" and never written to the URL, so
  every reload lost your place. Added URL-hash routing: the current section (and open pack) live in
  location.hash (#/questions, #/levels, #/pack/<id>, #/ = dashboard). On mount the app parses the
  hash to seed the initial section; goNav/goPack write the hash; a hashchange listener re-derives
  state so browser Back/Forward and manual edits work. A pack id from the URL resolves once packs
  load (library skeleton shows meanwhile), which also makes pack views deep-linkable/shareable.
  Verified: the App's initial nav state now derives from the hash for every route (#/questions →
  "questions", etc.). Bonus: document.title now tracks the current section/pack, so browser tabs
  and history are meaningful. (The old pushState back-button logic was replaced by this.)
- **Comprehensive audit fixes (two real issues found + fixed):**
  · **Pack header count bug (introduced by the server-side pack filters):** the header showed the
    QUERY total, which is now the FILTERED count — so applying a date/level filter made it read
    e.g. "3 questions" for an 11-question pack. Fixed: the header now shows the pack's true count
    (pack.total_questions from pm_pack_overview) and, when a filter is active, appends "· N match
    filter". Added an isFiltered flag (datePreset !== 'all' || level !== 'all').
  · **RPC grant posture drift:** recreating pm_search_questions (and earlier pm_clone_pack) via
    DROP+CREATE silently restored the PUBLIC execute grant, so anon could CALL pm_search_questions,
    pm_clone_pack, pm_dashboard_stats, pm_lint, pm_lint_details, pm_log, pm_mark_released. No breach
    (all are SECURITY INVOKER, so writes were still RLS-blocked and reads were published-scoped), but
    it contradicted the intended model. Revoked execute from PUBLIC + anon on all of them (the fix
    that had been missed needed to target PUBLIC, not just anon); authenticated retains execute. Now
    only the two trigger functions are anon-executable, and those can't be called as RPCs anyway.
  Audit also verified (no change needed): all 16 components render; client/edge maskWord parity
  (384 cases, 0 mismatches) + buildLevelVariants override handling; all RPCs execute; the live
  game-feed renders BRAVE correctly L1→L10; created_at auto-populates and updated_at trigger fires;
  db.questions builds valid URLs for every filter combo (verified the full combined query live).
- **Pack-detail filters moved SERVER-SIDE (span the whole pack, not just the loaded page).** The
  per-pack "when added" / level / sort filters were initially client-side (page-only). db.questions
  now takes fromDate/toDate/level/packLevel/sort and builds the PostgREST query, so filtering +
  sorting cover every question in the pack and the count/pagination stay correct. The level filter
  correctly includes inheritors: when the chosen level equals the pack's own level it uses
  or=(level.eq.X,level.is.null); otherwise a plain level=eq.X. Verified the exact queries against
  the live REST endpoint (incl. the or=() syntax → 200 with the right rows). Quick text search
  stays client-side over the loaded page (a debounced nicety). The global Questions page already
  did server-side date filtering; the two pages are now consistent.
- **Pack-detail question bank: same "when added" filter, sort, and timestamps as the global
  Questions page.** The global page got these last change; the per-pack view (PackDetail) was
  missing them. Added a "when added" dropdown (any / 24h / 7d / 30d), a sort dropdown (default
  order / newest / oldest), and a relative "added" stamp on every row (full timestamp on hover).
  db.questions already selects created_at, so no data-layer change was needed. Note: like the
  existing text/level filters here, these operate client-side on the loaded page (the global
  Questions page does true server-side date filtering across everything).
- **Questions page: filter & sort by when a question was added.** pm_questions already had a
  populated created_at (every question is timestamped on insert), so this was purely surfacing +
  filtering it. pm_search_questions gained from_date/to_date (a [from, to) window on created_at)
  and a sort param ('recent' newest-first / 'oldest' / null keeps pack order), and now returns
  created_at + updated_at. The All-questions page got a "when added" dropdown (last 24h / 7d /
  30d / custom range with two date pickers) and a sort dropdown, and each row shows a compact
  relative "added" stamp (relativeTime helper in core.jsx: "just now" / "5m" / "3h" / "2d" /
  "3w" / date), full timestamp on hover.
- **Leftover cleanup pass (full app sweep for old-model remnants):**
  · Dropped the two dead per-question columns \`pm_questions.difficulty\` and
    \`pm_questions.letters_hidden\` — they were written on every save/clone and returned by the
    search RPC, but NOTHING read them (rendering is driven by the level + pm_question_levels
    overrides). Removed the derive-and-save code in the question editor, took them out of
    \`pm_search_questions\`' return signature, and stopped \`pm_clone_pack\` from copying them.
    (The pack-level \`difficulty\` tag and the live \`pm_question_levels.letters_hidden\` OVERRIDE are
    unaffected — those stay.)
  · Fixed a latent clone bug found on the way: \`pm_clone_pack\` wasn't copying \`frame_slots\`, so a
    cloned pack lost its frame-word slots — now copied.
  · Play-mode tip reworded from the old "only the primary word is the correct fill for this
    sentence" (meaning framing) to the spelling framing ("the correct one is the word whose
    spelling fits the revealed letters").
  Verified: all affected components (QuestionEditor, PackEditor, BulkImport, PackDetail,
  AllQuestions, PlayMode) render; search RPC still returns rows; columns confirmed dropped.
  Remaining "difficulty" in the codebase is all legit pack-level difficulty or general help text.
- **Overview: dropped the "Levels in use / of 10" box — it was measuring the wrong thing.** It
  counted the distinct DEFAULT levels questions are assigned to, but every question renders at ALL
  10 levels (that's the point of the level system), so "2 of 10" wrongly implied only 2 levels'
  worth of content existed. Replaced it with a "Published packs · live in the game" box (a
  genuinely operational number). The level DISTRIBUTION is still shown correctly by the "questions
  by level" mini bar-chart in the Library-health card, which conveys the spread without the
  misleading "of 10" framing. (The RPC's now-unused distinct_levels_used field was left in place;
  harmless.)
- **Removed the basic/advanced TIER concept entirely — the level number is the difficulty.**
  Tier was a redundant leftover from the old model (like the purged difficulty field): the app
  already has a clean 1–10 level progression, so classifying levels into basic/advanced added
  nothing. Removed everywhere: the two "Basic-tier / Advanced-tier levels" Overview boxes (replaced
  with "Levels in use" + "Empty packs" boxes and a "questions by level" mini bar-chart in the
  Library-health card); the Tier <Select> in the Level editor and the tier Pill in the level list
  (now shows the hidden-mode: "whole word" / "N letters"); the tier field in buildLevelVariants
  output and the export projection; the tier branch in the derived-legacy difficulty (now keys off
  hidden_mode only). Fixed a latent bug found on the way: the QuestionLevelEditor preview used
  \`variant.tier === "advanced"\` to decide whole-word rendering — now uses \`variant.target.wholeWord\`.
  DB: pm_dashboard_stats rewritten to return distinct_levels_used + questions_by_level instead of
  tier counts; game-feed edge fn redeployed (v11) without tier; and the \`pm_levels.tier\` COLUMN was
  dropped. Verified no functions/views referenced it before dropping.
- **Play mode level filter:** added a level selector at the top of Play mode. Default "each own
  level" plays every question at its own effective level; picking a specific level forces the whole
  pack to render at that level's blank difficulty (via previewAtLevel with an overridden q.level —
  same shared engine, parity preserved), so you can feel how the pack plays at any difficulty.
  Changing the filter restarts the run and the active level shows in the header.
- **CRITICAL — the build was silently broken; recent "deploys" shipped a STALE bundle.** The
  earlier pack-undo edit (preserving all pack fields on Undo) left a brace mismatch — the onClick
  arrow closed with a stray \`}\` and the \`action\`/\`notify\` closers were dropped — so assemble.cjs's
  Babel compile threw and never rewrote app.compiled.js. build_html.cjs kept wrapping the OLD
  compiled file, and \`node --check app.compiled.js\` passed because it was checking the old valid
  file — so several commits (docs, generator mechanic, Play-mode fixes) never actually reached the
  deployed bundle. Fixed the braces; assemble now compiles and writes a fresh bundle (index.html
  jumped ~388KB→399KB, confirming how far behind it was). LESSON: after every build, verify
  assemble.cjs printed its success summary AND that app.compiled.js was newly written (check its
  mtime / grep a just-added string) — do NOT trust \`node --check app.compiled.js\` alone, since a
  failed assemble leaves a stale-but-valid file.
- **Added a visible build stamp** (CFG.build, shown small in the sidebar footer) so a stale cached
  build is obvious at a glance — bump it on every deploy.
- **Game mechanic corrected — it's a SPELLING puzzle, not a meaning test:** earlier docs/prompt
  said "both words positive but only the primary FITS THE MEANING of the sentence". That was
  wrong. The real mechanic: the sentence shows a word with some letters revealed and some blank;
  the child picks the positive word whose SPELLING fits the revealed letters + blank shape. Both
  words are positive (therapeutic core intact); the primary spells into the pattern, the alternate
  is another positive word that does NOT — reliably guaranteed by giving it a DIFFERENT LENGTH
  (a different-length word can never match the fixed blanks at any level). Updated the intros of
  the Architecture doc + Build Prompt, the Play-mode spec (why the primary is correct), the
  Content Generator spec, AND the live generator (generator.jsx: MASTER_CONTEXT + the AI prompt
  lines) so generated questions come out spelling-valid, not meaning-based. First real content
  (10 Confidence questions) was authored/validated under this rule — every distractor is a
  different length from its answer, verified against the actual maskWord pattern at every level.
- **Full audit — several real bugs found & fixed:**
  · **Client/edge PARITY bug (important):** the client buildLevelVariants precedence was changed to
    \`ov ?? q.letter_position ?? lvl ?? default\` during the editor rebuild, but the game-feed edge
    function still used \`ov ?? lvl ?? default\`. A question with its OWN letter_position/grouping
    rendered differently in the game than in the CMS (proven: "start" → __AVE in CMS, BRA__ in
    game). Fixed the edge function to the same precedence and redeployed (game-feed v10). Parity
    invariant restored.
  · **PlayMode silent 100-row cap:** Play mode fetched only the first 100 active questions
    (size:100), so packs with >100 questions were truncated and the "X of Y" count was wrong.
    Switched to db.allQuestionsForPack (paginated). 
  · **Pack-delete Undo dropped fields:** restoring a deleted pack via the Undo toast recreated
    only the basics — it silently lost level, purpose, focus_areas, style_approach,
    example_objectives. Now restores all pack fields (the overview view exposes them).
  · **Stale lint check:** pm_lint_details' \`revealed_answer\` rule keyed off the dead
    difficulty/letters_hidden columns; rewrote it to use the effective LEVEL's hidden_mode +
    letters_hidden_default. pm_lint (summary) was already clean.
  · **RPC grant hygiene:** revoked anon EXECUTE on the admin/write RPCs (pm_dashboard_stats,
    pm_search_questions, pm_lint, pm_lint_details, pm_mark_released, pm_log) — they already failed
    for anon via RLS/INVOKER, but the grants were misleading. Public game feed (service_role via
    edge fn) unaffected.
  Verified: all major components render headlessly without crashing; maskWord "random" is
  deterministic; whole-word levels hide the whole word; transform engine still guards objects on
  both client and edge; RLS confirmed published-only for anon.
- **Play mode scoring fixed + game rule clarified:** Play mode treated BOTH answer words as
  correct (picking either said "Great choice!" and scored a point), so a wrong pick was reported
  as correct. Clarified rule: both words are positive, but only the PRIMARY word (\`answer\`) is
  the correct fill for the sentence; the alternate is positive-but-wrong-here (a distractor, not
  a synonym). Play mode now checks the pick against the primary answer, shows "Correct! ✓" vs
  "Not quite — the answer is X", colours the buttons green/red and reveals the right answer, and
  scores only correct picks (done screen shows "X of Y correct"). The MASTER_CONTEXT doc and the
  generator PROMPT were rewritten to teach this (the alternate must be a plausible positive word
  that does NOT fit the blank — never a synonym). Also purged the word "affirmation(s)" as a name
  for the items across the UI (editor subtitle, empty state, levels caption, Play mode) — they're
  "questions"; only genuine CBMT adjective usage ("self-affirming") remains in the therapy blurb.
- **Dashboard stats fixed to use level tiers (was counting dead difficulty):** pm_dashboard_stats
  computed its basic/advanced question split from the derived-legacy difficulty column. It now
  counts by the effective LEVEL's tier (question level → pack level → pm_levels.tier), which is
  the meaningful measure; the Overview cards were relabelled "Basic-tier / Advanced-tier levels".
  Also swept the three developer docs for stale old-model teaching (outside the changelog):
  removed the "difficulty→level" value-map examples, and expanded the Build Prompt's question-
  editor + dashboard + JSON-backup descriptions to match the current level-based reality.
- **Search RPC signature scrubbed:** pm_search_questions dropped its legacy \`diff\` (question
  difficulty) parameter and filter clause — signature is now (q, pack, stat, lvl, lim, off).
  The client call and its doc comment were updated to match. Verified 200 OK through the actual
  PostgREST endpoint with the client's exact payload. (Returned columns still include the
  derived-legacy difficulty/letters_hidden so nothing reading them breaks.)
- **Old difficulty/letters model purged from the app (follow-through cleanup):** after the
  editor was reconciled with levels, a full sweep removed the remaining old-model residue.
  Per-question difficulty is now DERIVED from the level (never authored), so: the question-list
  and global-search "difficulty" filters and the per-question difficulty pills were removed
  (a LevelChip shows the meaningful axis instead); difficulty/letters_hidden were dropped from
  the exportable QUESTION_SOURCE_FIELDS; the built-in export profiles had their stale
  level→difficulty value-map and redundant difficulty fields stripped (DB); the dead
  packDifficulty prop was removed from QuestionEditor; the bulk importer stopped hard-coding
  difficulty/letters_hidden (they fall to DB defaults, questions inherit the pack level). The
  whole-CMS JSON backup was also MODERNIZED (v3): it now exports/imports level, letter_position,
  letter_grouping, frame_slots and the pack's purpose/focus/style fields (previously it carried
  the dead letters_hidden/difficulty and silently DROPPED levels + frame words on restore).
  NOTE: pack-level difficulty (basic/advanced/mixed) is a real pack tag and was kept. (The
  per-question letters_hidden/difficulty columns were left as derived-legacy at the time of this
  change, then fully dropped in a later cleanup — see the top of this changelog.)
- **Question editor reconciled with the level system (bug fix):** the editor still exposed the
  OLD model — a per-question "Difficulty" (basic/advanced) toggle and a "Letters hidden" number
  — but rendering has long been driven by the LEVEL (hidden_mode, letters_hidden_default,
  position, grouping), so those controls did nothing (you literally couldn't change how many
  letters were hidden). Removed both. The editor now: sets the question's Level (which controls
  letters-vs-whole-word), shows position/grouping overrides only when the previewed level hides
  letters, and — crucially — the "how the child sees it" preview now renders through the SAME
  engine as the game (buildLevelVariants) with a level picker so you can flip through every
  level and see exactly what the child sees. On save, difficulty/letters_hidden are DERIVED from
  the question's level (so filters, pack pills and exports stay coherent) rather than edited.
- **One shared preview engine:** buildLevelVariants moved to core.jsx (single source), and a new
  previewAtLevel() helper now powers the editor, the question-list rows, the search-result rows,
  and Play mode — all previously used a separate previewQuestion() path that could drift from the
  game. previewQuestion and effectiveMask (both now unused) were removed. buildLevelVariants also
  now honors the question's own letter_position/grouping at the base level (was ignored before).
  Verified the editor/rows/game render identically across levels.
- **Audit pass on the generator/import loop:**
  · Import now sanitizes AI/user-supplied frame_slots before it reaches the DB
    (sanitizeFrameSlots): pool coerced to a clean string array, byLevel keys must be numeric
    and values become strings, junk/blank tokens dropped, returns null if nothing valid. The
    resolver was already crash-proof against malformed shapes; this keeps the DB clean too.
  · Import duplicate-check now has a loading state — the Import button is disabled and shows
    "Checking…" until the pack's existing questions have loaded, so you can't accidentally
    import past an un-loaded dedup check.
  · Generator: applyPack fetches are guarded by a ref (latestPackReq) so rapidly switching
    packs can't leave a stale pack's questions in the avoid-list (out-of-order response race).
  · Generator: the avoid-list sentence signatures are capped (120) with an "…and N more" note
    so a large pack can't bloat the prompt or bury the instructions (a 250-question pack was
    ~17.7K chars); the compact answer-word list is always included in full.
  Verified: sanitizer across 10 malformed shapes; resolver crash-proof across 9; dedup
  classification (exact/similar/new/in-batch) across 6; normSentence collision behavior
  reviewed (frame-word-only differences surface as "similar" for review — intended).
- **Generator: background context + duplicate avoidance (belt & suspenders):**
  · A standalone, reusable MASTER_CONTEXT document (the full CBMT "why", who the child is, what
    good/bad looks like) lives on the Generator page with copy — paste it once at the top of a
    fresh AI chat, then paste generated prompts after it. An "Include background context" toggle
    also folds a compact version into the prompt itself.
  · An "Avoid existing questions" toggle loads the selected pack's questions (new
    db.allQuestionsForPack, paginated) and appends an "ALREADY COVERED — do not repeat" list
    (answer words already used + existing sentence signatures) so the AI steers away from dupes.
  · The Bulk importer now flags duplicates against the pack's existing questions: EXACT (same
    normalized sentence + same answer, punctuation-insensitive; also catches repeats within the
    pasted batch) and SIMILAR (same sentence OR same answer word). Exact defaults to skip,
    similar defaults to keep-but-flagged; every flagged row has a per-row Skip/Keep toggle, and
    only kept rows import. It also soft-flags answer words that fall outside the PACK LEVEL's
    vocabulary rules (length band / multi-word) with a “Length” badge + a guidance line — advisory
    only, never blocks import (imported questions inherit the pack level). All verified against real
    pack data.
- **Content Generator page (prompt builder):** a new "Generator" nav page (generator.jsx,
  GeneratorView) that assembles a ready-to-paste AI prompt for authoring a batch of questions
  in our format. Controls: pack picker (pre-fills themes from the pack's focus_areas/purpose,
  all editable), a multi-select of target levels (chips), a themes field, a count, an
  output-format picker (JSON import-ready / pipe / markdown table — chosen each time), an
  optional "include frame-word variations" toggle (teaches the AI the {token} pool + byLevel
  system), and an extra-instructions field. The generated prompt teaches the CBMT philosophy,
  the {blank}-target + both-positive-words rules, level context, and the exact output shape
  with a concrete example; it live-updates and has a copy button. Also: the Bulk importer now
  carries frame_slots from imported JSON (was dropping it), so the generate → import loop works
  end-to-end for frame-word questions. Prompt output verified valid + importable.
- **Export now carries the target word + frame structure explicitly (self-describing):**
  each per-level variant gained a \`target\` object (word, altWord, blankShape, wholeWord,
  lettersHidden, position, grouping) so the game never parses the sentence to find the guess
  word, plus a \`frames\` map (token -> resolved word) showing exactly which frame words were
  used. Questions now expose BOTH a raw \`template\` (with {tokens}) and a resolved
  \`base_sentence\` (real words at the base level). A new optional per-profile flag
  \`include_frames\` attaches the raw frameSlots config (pools + per-level pins) so the game can
  vary the swappable words itself. base_sentence is a pickable field; the ProfileBuilder has
  the new toggle; the Full export profile turns include_frames on. Client engine + game-feed
  edge fn kept byte-identical (added resolveFrameMap). Verified end-to-end via the feed.
- **Polymath audit pass:**
  · TRANSFORM ENGINE (xf/mapVal + edge applyTransform/mapValue): guarded against object/array
    values — an accidental upper/lower/trim on frame_slots or tags would have produced
    "[object Object]"; now objects pass through untouched, and value_maps only key on
    primitives (the \`in\` operator on an object was fragile). Client + edge kept identical.
  · REALTIME: connect() now tears down a socket still in CLOSING state before opening a new
    one (a tab-refocus during close could otherwise create two live sockets + double
    heartbeats). Set REPLICA IDENTITY FULL on pm_questions/pm_question_levels so DELETE events
    carry pack_id (the PackDetail live-refresh filter needs it; before, deletes reloaded
    every open pack view).
  · LINT: added two checks — "revealed_answer" (a basic question hiding 0 letters shows the
    child the answer) and "empty_answer"; the health total now counts actual detail rows so
    new rules always reflect in the count. New issue labels added to the UI.
  Verified safe-but-noted (no live bug): {Blank}/{BLANK} as a target is caught by the
  {blank}-required save validation; byLevel numeric/string key coercion is correct; optimistic
  pack delete doesn't race the realtime refresh; localStorage access is exception-safe.
  Verified clean: frame-word feed render across L1–10 after the changes; feed 200 OK.
- **Frame-word variations:** the sentence template can now contain swappable {token} words
  (other than {blank}, which stays the selectable target). Each such token gets a \`frame_slots\`
  config on pm_questions: a \`pool\` of alternatives + optional per-level pins (\`byLevel\`). This
  lets levels 7–10 differ even when the blank is a whole word (e.g. "…when things get {hard}"
  → difficult / stressful / challenging / problematic per level). resolveSlots (in core.jsx,
  mirrored in the game-feed edge fn) resolves them deterministically: byLevel wins, else a
  seeded pick from the pool (stable + identical client/edge), else the bare token. The question
  editor auto-detects tokens and shows a pool editor + per-level pin grid (FrameSlotEditor).
  frame_slots is exportable and the search RPC returns it. Verified end-to-end via the feed.
- **Full audit pass — security + robustness fixes:**
  · SECURITY: pm_pack_overview was SECURITY DEFINER, so anon could read draft/unpublished
    packs' metadata through the public API. Set security_invoker=true — anon now only sees
    published packs (verified: a test draft was invisible to anon via the view).
  · SECURITY (defense in depth): revoked the unused insert/update/delete/truncate grants from
    anon on all pm_ tables (RLS already blocked writes, now the grant surface matches intent).
  · DARK MODE BUG: toasts used background:C.ink, which flips to near-white in dark mode,
    making the pale accent colors + white text invisible. Fixed to a permanent dark bg.
  · ROBUSTNESS: guarded bulk delete/status against empty id arrays (an empty in.() query
    would be malformed) — the UI already prevented it, but the data layer now does too.
  · REALTIME: on background token refresh, push the new token to the live socket
    (realtime.updateToken) so long-lived connections stay authorized without waiting for a
    reconnect.
  · ERROR HANDLING: the question action handlers (toggle status, bulk delete/status, import,
    single delete) had no try/catch — a failed operation vanished silently with no feedback.
    They now surface a clear error toast. (Editors, pack delete/clone/reorder already caught.)
  Verified clean: maskWord client/edge parity (624 combos, identical), data integrity (zero
  orphans/broken refs), all db.* calls resolve, all components resolve, feed still 200 OK.
- **Stay logged in for 7 days:** the session was being lost on tab/browser close (it used
  sessionStorage) and the access token was only refreshed reactively. Fixed: the session now
  persists in localStorage with a 7-day window measured from login, the short-lived access
  token is refreshed proactively in the background (every 45 min and on tab refocus, plus the
  existing on-401 retry), and a legacy sessionStorage entry is migrated on load. Users now
  stay signed in across restarts until they log out or the 7 days elapse.
- **Live sync (realtime):** open sessions now update automatically when anyone edits data,
  so multiple people on multiple devices don't work off stale views. A lean websocket client
  (realtime.jsx, no Supabase SDK) connects to Supabase Realtime and subscribes to
  postgres_changes on the 7 UI tables; a debounced refresh reloads the affected lists
  (packs, questions, per-pack question list, global search, levels). A "Live" badge in the
  header shows connection status; it auto-reconnects and re-subscribes on tab focus. Realtime
  is enabled on the publication for pm_packs, pm_questions, pm_levels, pm_question_levels,
  pm_export_profiles, pm_sync_targets, pm_activity. (Note: auth is still a single shared
  account — per-user accounts are a separate future step.)
- **Pack purpose at a glance:** Library pack cards reveal the pack's Purpose + Focus areas
  on hover (desktop) or via an ⓘ toggle (touch), without opening the pack; the Overview
  pack-index tooltip also includes the purpose.
- **Structured pack descriptions:** each pack now has purpose, focus_areas, style_approach,
  and example_objectives (shown as an "About this pack" panel on the pack page, editable in
  the pack editor, exportable via the field mapper). An AI "draft" button calls a new
  pack-describe edge function (Anthropic; needs ANTHROPIC_API_KEY server secret) to fill a
  first draft the user then edits. All 14 existing packs were seeded with grounded drafts.
- **Export pipeline reviewed for levels + XML added:** the 3 starter profiles were updated
  to carry the real effective_level (Flat API had mislabeled difficulty as "level"); a new
  "Full game export (with levels)" starter emits the complete 10-level structure
  (expand_levels on) — verified via the live feed. Added XML output everywhere: a toXml
  serializer (client + edge, kept identical), JSON/XML buttons on the file download, and
  ?format=xml on the game-feed. All four channels (file, feed, push, Firebase) carry level
  data because they share fetchAllContent(expandLevels) + buildOutput.
- **Level filters + audit:** the question bank (global search), the in-pack question list,
  and the Library now all have a Level filter (pm_search_questions gained an \`lvl\` param
  matching effective level). Fixed three mislabeled "All levels" dropdowns that were really
  difficulty filters. Fixed a real bug: maskWord "random" position used Math.random() so the
  blank flickered every render and wouldn't match the game — it's now deterministic (seeded
  from the word), stable across renders and identical client/edge.
- **Audit fixes:** (1) level data now reaches the game — the export engine + game-feed
  (v4) attach effective_level to every question and, when a profile enables "Expand levels",
  add a \`levels\` array with the sentence + blank for all 10 levels (client and edge kept in
  sync; verified via the feed). (2) pm_clone_pack now copies the pack level, question-level
  overrides, and pm_question_levels rows (was silently dropping them). (3) NaN guard on the
  per-level editor's letters_hidden.
- **Questions are multi-level concepts:** each question auto-renders every level (same
  affirmation, blank difficulty derived per level via buildLevelVariants). The question bank
  keeps flat rows with a "Levels" expand toggle that reveals every level's version. Any level
  can be individually edited (override sentence/word/letters/position/grouping or disabled),
  stored in pm_question_levels; un-edited levels stay auto-generated. Reset returns a level
  to auto.
- **Blank shape control:** levels now also define WHERE missing letters sit
  (letter_position: start/middle/end/random) and whether multiple hidden letters are
  grouped or spread (letter_grouping). maskWord() generates the actual blank; the "how the
  child sees it" preview, the question rows, PlayMode, and search all reflect it.
  Question-level overrides fall back to the level default (in buildLevelVariants). Defaults were
  seeded to match the concept deck (b__ve style = middle/grouped for the gentle levels).
- **Expandable level progression (1–100):** a \`pm_levels\` table defines the levels (ships with
  1–10; you can add more above the top, up to a CHECK ceiling of 100). Each level has letter-hiding
  rules (hidden_mode letters/word, letters_hidden_default, letter_position, letter_grouping), a
  color/theme/age hint, AND vocabulary rules — min_word_len, max_word_len, allow_multiword, and a
  free-text vocab_rule — that shape which ANSWER words the level uses (they feed the generator and
  display intent; the masking engine ignores them). The level NUMBER is the difficulty; no separate
  basic/advanced tier. Packs carry a default \`level\`; questions can override (null = inherit).
  The Levels page lets you view/edit each definition AND add a new level above the current top
  ("Add level N", pre-filled from the current top level's rules) or delete the top level (only the
  highest, to keep the ladder contiguous). Each level card shows a plain-English summary of the
  ACTUAL mechanical rule plus a live "Looks like" sample masked through the real engine, and word-band
  / multi-word badges. Adding a level row is sufficient for it to render everywhere (CMS previews and
  BOTH feeds) with zero per-question work — nothing is pre-materialized; the shared engine derives
  every level on demand. Questions for a new level come two ways: (1) the AI generator prompt now
  includes each target level's word-length band, multi-word allowance, and vocab_rule (plus a
  reminder that both answers stay in-band yet differ in length); (2) a "Derive level" action on a
  pack materializes editable pm_question_levels override rows for a chosen level across all active
  questions (applying that level's masking rule to each word; skip-or-overwrite existing), for when
  you want concrete per-question rows to hand-tune. LevelChip shows the level on cards and question
  rows; the pack/question editors have level selectors. pm_search_questions returns the effective
  level (coalesce question→pack).
- **Contrast/accessibility pass:** every text color WCAG-checked; 'faint' darkened
  (2.57 → 4.88 on white) and brightened in dark mode; inputs now use the panel token
  (fixed dark-mode white inputs), 1.5px borders, explicit readable ::placeholder.
- **Developer Notes page** added (this page): 3 hardcoded docs (Architecture, CLAUDE.md,
  Build Prompt) with copy+download, plus an autosaved scratchpad (pm_dev_notes table).
- **Overview pack index:** compact one-line, tap-to-open list of every pack at the bottom
  of the dashboard (responsive grid; 2 cols on phone).
- **Mobile question cards:** below desktop, question rows became content-first cards
  (sentence hero on top, meta+actions footer, checkbox floated to the corner) instead of
  a folded desktop row that buried the sentence.
- **Audit fixes:** (1) session token refresh + retry on 401, with fallback to login
  (tokens expire ~1hr and the UI used to silently break); (2) release-state lifecycle —
  pm_mark_released clears "pending changes" after a sync (was never advancing); (3)
  restAll() pagination on client AND edge function to defeat the 1000-row cap; (4) command
  palette closes on Escape; (5) confirmDialog fails safe if opened before host mount.
- **Firebase channel + keyless-ish feed:** Firebase targets (RTDB/Firestore/CloudFn),
  configurable path layouts; game-feed edge function with health probe (v3, paginated).

IMPORTANT: keep this section and the CLAUDE.md/Build-Prompt docs updated on EVERY change.
`;

const DOC_CLAUDE_MD = `# CLAUDE.md — Positive Minds CMS

Guidance for AI assistants (and humans) working on this codebase.

## Project
Content management system for the Positive Minds children's word game (CBMT
fill-in-the-blank affirmations). This is the **authoring + publishing** layer; a
separate game backend reads the content. Single-file React app, Supabase backend,
Cloudflare Worker hosting, GitHub Actions/Cloudflare Git auto-deploy.

## Stack & identifiers
- React 18.3.1, single self-contained index.html, **NO runtime build** (JSX pre-compiled).
- **Three decoupled services:** GitHub (front-end source + edge-fn source copy) → Cloudflare (serves
  the static site; push to main → GitHub Actions → deploy) ; Supabase (the backend — DB, auth, RLS,
  edge functions — **deployed MANUALLY, GitHub never touches it**). See Architecture §0.4.
- Supabase project ref: tytrmjjucqijzcrbwjfm
- GitHub: alcharles1980-design/positive-minds-cms
- Live: positive-minds-cms (Cloudflare; also appears as a Worker of that name)
- **Edge functions (5):** content-api (public), generate-questions (JWT), mcp (public entry, OAuth per
  call), game-feed (public, legacy), pack-describe (JWT). All five have source in edge-functions/*.ts.

## Golden rules (do not break these)

NUMBERING: rules are listed NEWEST FIRST but numbered OLDEST FIRST, so 4.1 is at the bottom of
the list and the highest number is at the top. A new rule takes the next number and goes on top;
no existing number ever shifts. (Letters were used until Aug 2026 and had collided six times —
there were two 4t, two 4u, two 4r, two 4s, two 4v and two 4d, so "see rule 4t" was ambiguous.)
1. **Babel classic runtime only.** Compile with @babel/preset-react { runtime: "classic",
   development: false }. The automatic/dev runtime emits \`import jsxDEV\` which breaks a
   plain <script> and causes a blank "Loading…" screen. Verify the compiled output has
   React.createElement and NO jsxDEV / NO top-level import.
2. **PostgREST 1000-row cap.** Never rely on \`limit=10000\`; the server caps at 1000.
   Use restAll() (paginate in 1000-row batches) for any list that can exceed 1000 rows.
   The game-feed edge function must paginate too.
3. **Assembly order + hoisting.** The app is concatenated from /v2/*.jsx in a fixed order
   (see assemble.cjs). Cross-file COMPONENTS must be \`function\` declarations (hoisted).
   Cross-file \`const\` helpers must be defined in a file that loads BEFORE their consumers.
4. **Client/server engine parity.** The RENDERING engine is duplicated across FIVE copies that must
   stay byte-identical: core.jsx (the client) and FOUR edge functions — content-api, generate-questions,
   mcp, and game-feed. \`maskWord\` is identical in all five (verified); \`validateQuestion\` lives in
   core.jsx, generate-questions and mcp. This covers \`maskWord\`, \`resolveSlots\`, \`resolveFrameMap\`,
   \`buildLevelVariants\` AND the TRANSFORM engine (\`buildOutput\`/\`projectRow\`/\`applyTransform\`/\`mapValue\`/
   \`toXml\`). Any change to one MUST be mirrored in ALL copies, same commit, or a feed diverges from what
   the CMS shows. ONE deliberate exception: \`game-feed.buildLevelVariants\` emits the legacy \`opts\`
   string ("A / B") instead of content-api's \`options\` array — the masking is identical, only that
   output field differs; keep it that way unless retiring game-feed. (\`engine.js\` currently parity-tests
   only 3 of the 5 maskWord copies — it predates mcp and game-feed being in the repo; verify those two
   by hand or extend the test.)
   Watch the PRECEDENCE CHAIN specifically: buildLevelVariants resolves position/grouping as
   \`override(pm_question_levels) ?? question.own ?? level.default ?? hard-default\` — this exact
   order must match in both files. (A past bug: the client gained the \`question.own\` step but
   the edge function didn't, so a question with its own letter_position rendered differently
   in-game than in the CMS.) After any engine edit, diff the two by fetching the deployed edge
   function and comparing, or run a parity test with a question that has its own overrides.
4.48. **A bundler is not a type checker. \`esbuild\` compiles an undefined identifier without a
   murmur.** The pre-deploy check for edge functions was
   \`esbuild edge-functions/mcp.ts --outfile=/tmp/check.js\`, and it passed cleanly on a handler that
   referenced \`who\` — a variable that exists in the request scope and NOT inside callTool(), whose
   signature is (db, partner, name, args). It deployed. Every approve call threw
   "ReferenceError: who is not defined" at the first real request.
   The second bug was worse because it fails SILENTLY: authenticate() SELECTED can_approve and then
   returned only { partner, id }, so the flag would have read undefined forever, tools/list would
   have hidden the tools permanently, and the symptom would have been "the feature just does not
   appear" with nothing in any log. \`npm run test:types\` (tools/typecheck.sh, tsc --noEmit) found
   that one on its own, in one line, the moment it existed.
   esbuild PARSES. It does not resolve identifiers, scopes or types. A check that cannot fail on an
   undefined variable is not a check, and I leaned on it for a whole session.
   test:types now runs FIRST in npm test, because it is the cheapest and catches the class of error
   that reaches production silently. Deno/jsr specifiers cannot resolve under tsc and are filtered;
   everything else is a genuine finding.
   AND: the first bug was caught by CALLING THE DEPLOYED ENDPOINT, whose raw JSON-RPC response said
   "ReferenceError: who is not defined" in plain words. Compiling and assuming would never have
   found either.
4.47. **Run the whole test target, not the commands you happen to remember.** This project has SIX
   test suites wired into \`npm test\` — engine, runtime, read, inspect, interact, visual — plus three
   more under mcp-shim/. I learned \`node engine.js\` and \`node runtime.js\` early and ran only those
   for an entire session, across dozens of commits, without once opening package.json. read.js,
   inspect.js, interact.js and visual.js were sitting there doing real work: inspect checks computed
   styles in a real DOM, interact CLICKS 42 buttons and changes 52 inputs, visual renders 27
   page/device combinations. None of them ran.
   Nothing broke, which is luck, not vindication.
   THE RULE: read package.json scripts before you decide what "the tests" are, prefer the aggregate
   target over remembered incantations, and WRITE DOWN THE HEALTHY BASELINE for any suite that
   reports non-zero by design — test:visual always shows ~153 minor touch-target advisories, and a
   suite whose normal output looks like failure will be quietly ignored by the next person too.
4.46. **A handover is only true if you FOLLOW IT from a clean clone.** The new-session instructions
   in 11y were written from memory of what works — and every command in them passed on the first
   run, which proved nothing, because they were passing on the machine that had been building this
   project all day. Cloning fresh and following the steps literally found that the jsdom tests
   imported \`/home/claude/node_modules/jsdom/lib/api.js\` by ABSOLUTE PATH. That resolves here by
   coincidence and would fail on any other machine, so the test suite a new session is told to run
   would not have run. jsdom was even a declared dependency — the import just never used it.
   THE RULE: documentation of a process is a claim, and claims get tested. Clone into a new
   directory, follow your own instructions word for word, and treat every step that only works
   because of ambient state on your machine as a bug in the code, not in the instructions.
4.45. **Test the question a CLIENT asks, not the property you just implemented.** The
   content-addressed view URI shipped with four passing checks: the current URI resolves, the hash
   matches the content, a changed view yields a changed URI, the URI reads back. All true, all
   beside the point. Not one asked the question a real client asks — "I am holding YESTERDAY'S URI,
   does it still work?" — and the answer was no, so every deploy served a red "Failed to load the
   MCP app" to anyone with a cached tool list.
   The tests were written from inside the change, asserting the thing I had just built rather than
   the thing that had to remain true. Before calling a feature tested, write down what the CLIENT
   holds, does and remembers across time — stale references, old sessions, cached lists — and test
   from there. A suite that only exercises the happy path of the code you just wrote will pass
   forever and catch nothing.
4.44. **A short token expiry is only a security boundary if something REFRESHES it. Otherwise it is
   a scheduled outage.** The claude.ai proxy never calls /token again after the initial exchange
   (anthropics/claude-ai-mcp#228, and our own log agrees exactly). With a 1-hour token that means
   re-authenticating daily, which is what everyone in those threads suffers; with our 30-day token
   it meant a dead connector on a date already in the diary and no memory of why.
   So lifetimes here are ~10 years, and the control moved to REVOCATION — which is stronger anyway,
   because authenticate() re-reads pm_mcp_tokens.active on EVERY request and active=false takes
   effect on the next call, mid-session. Expiry could never do that.
   THE GENERAL FORM: work out which half of a protocol the other party actually performs before
   relying on it. A boundary the counterparty never enforces is not a boundary; it is a timer.
   And state the residual risk rather than burying it — a leaked token now lives until revoked.
4.43. **If a client may cache your artefact, put its identity in the URI — and remember a rendered
   widget never re-fetches.** A wording change was deployed, verified live by fetching the resource
   over the wire, and STILL wrong on screen. Not a deploy failure: SEP-1865 lets hosts prefetch and
   cache a ui:// resource keyed on its URI, and the protocol has no "that resource changed" message.
   With a fixed URI you cannot invalidate anything, and the failure is SILENT — it looks precisely
   like the deploy not working, which is where three rounds went.
   FIX: content-address it — ui://.../view-<hash of the content>. Change a character, get a new URI,
   which the host cannot mistake for what it holds. Nothing to remember to bump; anything requiring a
   human to bump a version will eventually not be bumped.
   AND KEEP SERVING THE OLD ADDRESSES. Content-addressing invalidates the host's cache of the
   RESOURCE — but the host also caches TOOLS/LIST, which is where it reads the URI from, so it will
   keep asking for the hash it saw THERE. Serving only the current hash turned every shim deploy
   into "Failed to load the MCP app" for anyone holding a stale tool list. Any past URI must resolve,
   and to the CURRENT content: an old address should not pin old content, it should simply keep
   working. Fixing a cache while breaking old references is not a fix.
   AND THE PART THAT IS NOT A CACHE AT ALL: an already-rendered widget keeps the HTML it was born
   with, forever. Scrollback shows the build from that moment and cannot be updated. When checking
   whether a view change landed, ask for a NEW one — and have the view NAME ITS OWN BUILD so a
   screenshot settles it (rule 4.21).
4.42. **A capability implemented ONCE but advertised in several places fails silently if ANY of the
   advertisements says no.** Refresh tokens were broken in three independent ways at once: the
   function did not issue them (undeployed), the shim's hand-copied metadata did not advertise the
   grant, and /register returned a hardcoded grant list ignoring what the client asked for. Fixing
   each one changed nothing visible, because any single "no" is enough for a client to never try.
   The implementation was correct and reachable throughout — it was purely a false advertisement,
   which is the most expensive kind of wrong, because everything you inspect looks right.
   WHEN A CAPABILITY IS DECLARED, ENUMERATE EVERY PLACE THAT DECLARES IT and check them together:
   server metadata, per-client registration response, the runtime behaviour, and any proxy that
   fronts them. If two of them are hand-maintained copies, that is the bug waiting to happen —
   derive, do not duplicate (the shim now fetches the function's metadata instead of restating it).
4.41. **A status badge is not the system. Test the capability, not the indicator.** The Connectors
   page said "Connection has expired" for hours while the connector was working: three complete
   authenticated MCP sessions, all 11 tools listed, one of them BEFORE the reconnect that was
   supposedly needed. I took a screenshot of a status card as evidence of the connection state and
   went looking for a failure that was, by then, partly imaginary.
   Ask what the thing is FOR and test that: open a chat and call a tool. A green light proves the
   light works. Applies to our own UI too — the Health page once showed "(untitled)" on every row
   while the data was fine (rule 4.14), which is the same error seen from the other side.
4.40. **Build the instrument before the theories.** Four hours went into Android link handling, plan
   limits, stale OAuth flows and a headless-browser end_error — all of it inference from status codes
   and screenshots. Then a small log table (rpc method, status, had_auth, user agent) answered it in
   ONE query, and would have answered it at any point that night.
   Supabase's function logs give a URL and a status: "POST 200 /mcp" four times is a handshake you
   have to guess at. The missing fields were cheap to add and decisive once present.
   THE RULE: when a second round of diagnosis begins, stop theorising and add the missing
   observation. If you cannot see which method was called, whether credentials were present, or who
   called it, you are not debugging — you are guessing with extra steps. Instrument first; it is
   almost always faster than the third theory, let alone the fifth.
4.39. **Do not ship a remedy built on an unconfirmed diagnosis. A wrong instruction in the product is
   worse than none.** When a partner could not connect, I concluded Android was hijacking the OAuth
   callback and shipped guidance into the SIGN-IN PAGE telling people to paste the callback URL into
   their address bar. It was wrong twice over: pasting that URL starts another transient add rather
   than completing the original flow, so it walked people round the loop — and the diagnosis itself
   was wrong, since the same failure happened with the shim reverted to known-good code.
   A second attempt tried to DETECT the hijack: navigate, and if the page is still visible 1.8s
   later, show a fallback. It never fired. When the app takes the foreground the browser tab is
   backgrounded, so \`document.hidden\` goes true — and the guard added to avoid false positives
   suppressed the only true positive. You cannot observe an app switch from inside the tab that the
   switch backgrounds.
   THE RULE: a theory you have not tested is not a fix, and putting it in front of users multiplies
   it by everyone who reads it. Confirm the cause first; if you cannot, say what is known and what is
   not. Both changes were removed and the page went back to what it had when it worked.
4.38. **"It worked before" is not proof you broke it — and checking the part you think matters is not
   proof you did not. BISECT.** A connector stopped attaching. I diffed the auth path, found it
   untouched, and treated that as exoneration — then spent four rounds blaming the phone, the OS
   link settings and the account plan. The auth path is not the only thing a client needs in order to
   persist a connector, and I never questioned the parts I HAD changed.
   The move that settled it in one step: revert the whole component to the last state that
   demonstrably worked, deploy, and test. It still failed, which proved the cause was elsewhere and
   let everything be restored at once instead of unpicking ten commits. Had it succeeded, the same
   revert would have bounded the search to that set.
   A revert costs minutes and is fully reversible in git. Defending a change costs a session and
   convinces nobody, least of all the person whose thing is broken.
4.37. **When a client and a server disagree, get a real client and record what it does.** The
   connector authenticated and then reported itself disconnected, with clean server logs. Reading
   code could not settle it. Driving the actual sign-in page in a real Chromium with request and
   navigation logging settled it in one run: our side returned 200 throughout, the browser reached
   the callback with a valid code, and CLAUDE'S flow ended at \`step=end_error\`.
   That is the difference between "the server looks fine" and "the server IS fine and the failure is
   downstream of it" — and only the second one lets you stop changing the server. Installing a
   browser to answer it took ten minutes; guessing had already taken hours.
4.36. **A check tuned until it passes is worth nothing — and a check that always fires is worse than
   no check.** The edge-function dry run compares deployed against repo. Its first version reported
   drift on all five functions, including ones that had no reason to have drifted, because
   \`supabase functions download\` returns the extracted ESZIP BUNDLE, not your source: transpiled,
   re-printed, comments gone, imports hoisted. mcp came back 6,400 bytes SMALLER than the repo file.
   Normalising both sides narrowed that to 190 bytes, and the remainder was STILL artifacts —
   redundant parentheses the bundler drops, a type-annotation remnant, a hoisted import.
   THE DISCIPLINE: at that point the temptation is to keep loosening the normaliser until it goes
   green. Do not. A comparison tuned until it agrees with you has stopped being evidence. Say what
   the check can and cannot establish, and then go and remove the NEED for it — here, one deploy
   from the repo makes deployed == repo true by construction and the question dies permanently.
   ALSO: never quote a first-divergence as proof of full equality. It is the first difference, not
   the only one.
4.35. **When you COMPOSE tools, you inherit their failure semantics — and it is easy to flatten them
   into success. Auth failure is not a partial result.** The \`overview\` tool merges two existing
   reads. Unauthenticated, it answered HTTP 200 with a cheerful "Partial overview" showing zeros,
   because both legs had failed and it treated that as missing data. Nothing leaked, but MCP clients
   start the OAuth flow off a 401 with WWW-Authenticate — so a partner with an expired token would
   have been shown an empty CMS, in confident detail, and never prompted to sign in. The tool built
   to say where things stand would have said everything was gone.
   Distinguish the failures: 401/403 propagate with the right status and header; a genuine outage
   stays a partial 200 and says which leg failed. Never let a composed tool report a confident zero
   that actually means "the call failed".
   Found by testing the DEPLOYED shim over the wire. Reading the code would not have shown it.
4.34. **There is no "on connect" event — an orientation must be a DIRECTIVE, not a payload.** Nothing
   fires when a partner attaches a connector. The only thing a host reads at connection is the
   \`instructions\` string from initialize, and it is STATIC: any counts written into it are stale the
   moment someone proposes a question. So instructions must tell the assistant to CALL a tool, and
   the tool carries the live state. PREPEND to the upstream instructions rather than replacing them —
   the routing rules that stop "always call X first" from hijacking unrelated requests live there.
4.33. **Read the specification before diagnosing, and believe a screenshot over a theory.**
   The preview widget was called "blank" for three sessions. It was never blank. It was CLIPPED to
   about one card, and the proof was sitting in a screenshot the whole time: the diagnostic status
   bar read "data received — 12 question(s)" and the first card's chips were drawing. A view that
   mounts, receives data and renders is not a view the host refused to fetch. The reported symptom
   ("it's blank") was accepted as an observation when it was already an interpretation.
   THE ACTUAL CAUSE, found by reading SEP-1865 rather than iterating: a view must send
   \`ui/notifications/size-changed\`. Under flexible dimensions the VIEW owns its height and the host
   resizes the iframe to what it reports. Ours never sent it once. The min-height:160px added to
   force the issue could never have worked — an iframe is sized from OUTSIDE, so its own stylesheet
   cannot make it taller. Reading the spec properly turned up three more deviations in the same pass:
   wrong ui/initialize params, the initialize RESULT never read (discarding containerDimensions,
   theme, displayMode), and a \`ui/notifications/context-update\` method that does not exist, so every
   reviewer interaction had been going nowhere.
   THE RULE: when integrating against a published spec, the cost of reading it is one session and the
   cost of not reading it was three. Before iterating on a symptom, (a) go to the primary
   specification, not blog posts or an issue tracker; (b) re-read the evidence you already have and
   ask what it PROVES rather than what it suggests; (c) distrust any hypothesis that conveniently
   makes the problem someone else's. See also 4.21.
4.32. **Questions are never pre-rendered — level rules propagate live.** A question row stores only
   its template + answer/alt + optional own overrides. Its level-variations (masked blanks, one per pm_levels row) are
   COMPUTED ON DEMAND by buildLevelVariants from the current pm_levels rows every time — in the CMS
   (previews recompute on each render from the levels prop, which the shell keeps fresh via the
   pm_levels realtime subscription) AND in the game feed (the edge fn fetches pm_levels per request).
   So editing a level's rule on the Levels page instantly changes that level's variation for EVERY
   inheriting question, everywhere, with no re-save/republish. Do NOT introduce a cached/materialised
   per-question variation store — it would break this and desync the game from the CMS. Precedence
   still applies: a per-question pm_question_levels override wins over the level default (intended).
   Corollary: the level ladder is DATA-DRIVEN and expandable (1..100). Adding a pm_levels row is
   enough for that level to render everywhere; NEVER infer a level's mode/difficulty from its NUMBER
   (no "level>=N ⇒ whole word" shortcuts anywhere, including preview fallbacks) — always read the
   level row. The game client must handle however many levels the feed reports, not assume 10.
   Because level is a plain int (no FK to pm_levels), deleting a level MUST clean up ALL references
   via the pm_level_delete_cleanup BEFORE DELETE trigger: reset pinned PACKS to the highest remaining
   level (a pack's level can't be null), un-pin QUESTIONS (→ null), drop OVERRIDE rows at that level.
   Never remove or narrow that trigger or you leave stale pointers.
4.31. **AI content NEVER bypasses human review.** generate-questions writes ONLY to pm_review_queue.
   The single path into pm_questions is the pm_review_approve RPC, which requires an explicit human
   decision. Never add a "publish straight through" path, an auto-approve, or a direct insert from a
   generator - a child must never see a question no person approved.
4.30. **GitHub does NOT deploy Supabase. The two are decoupled.** Pushing to the repo updates ONLY the
   Cloudflare-hosted front-end. The edge functions in edge-functions/*.ts are a SAVED COPY — committing
   them does NOT deploy them. A function changes on Supabase only when someone explicitly deploys it
   (MCP \`deploy_edge_function\`, or CLI \`supabase functions deploy <name> --project-ref
   tytrmjjucqijzcrbwjfm\`; add --no-verify-jwt for content-api and game-feed). SAME for DB/RLS/RPC —
   apply via migration/SQL, never via a push. When you edit an edge function: commit the source AND
   deploy it in the same unit of work, and say so in the commit — otherwise the repo and the live
   backend silently drift (this is exactly how game-feed and pack-describe ran live for weeks with no
   source in the repo). Before editing any edge function, diff the repo copy against the deployed one
   (\`get_edge_function\`); if they differ, the DEPLOYED version is source of truth until reconciled.
   **DEPLOYING BY TRANSCRIPTION IS THE RISKIEST THING IN THIS REPO.** deploy_edge_function takes the
   file CONTENT inline, so deploying mcp.ts means re-emitting ~1,300 lines by hand. That has already
   caused a real incident: a 1-line PLACEHOLDER was deployed over the live mcp function, breaking it
   until it was recovered. It also causes benign-looking drift — comments get condensed in transit, so
   the deployed copy and the repo copy stop matching even when behaviour is identical. Rules: after
   ANY inline deploy, fetch the deployed copy back and compare; and never treat "it deployed" as "it
   works" — exercise the changed tool over the wire before moving on.
   **CI IS LIVE: .github/workflows/deploy-edge-functions.yml.** It stages the flat
edge-functions/<slug>.ts into the supabase/functions/<slug>/index.ts layout the CLI wants and deploys
byte-for-byte, with --no-verify-jwt for the functions that authenticate their own callers (mcp,
content-api, game-feed, pack-describe) and the JWT gate left on for generate-questions.
SUPABASE_ACCESS_TOKEN was added 9 Aug 2026 and is confirmed working. NOTE it is a PERSONAL ACCESS
TOKEN (account level, starts sbp_, from the account Access Tokens page) — NOT a project API key.
Those are different credentials and the naming misleads: project keys authenticate requests TO the
database and cannot deploy anything, and the service_role key must never go near CI because it
bypasses every RLS policy.
TWO GUARDS were added before it was ever run for real. The workflow used to list ITS OWN FILE in its
push paths, so editing the deploy script deployed the live mcp function as a side effect — editing
CI must never ship code. And \`mode: dry-run\` (the default for manual dispatch) downloads what is
actually deployed and compares, deploying nothing.

**THE REAL FIX IS CI.** The repo has CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, which is why the
   site and the mcp-shim Worker deploy automatically and exactly. There is NO SUPABASE_ACCESS_TOKEN,
   which is the only reason edge functions cannot. Adding that one secret would let a workflow run
   supabase functions deploy straight from edge-functions/*.ts, making deployed == repo true by
   construction and removing this whole class of error. Strongly recommended.
   ACCESS: a contributor with only GitHub access can change the website and nothing else. To touch the
   backend they need access to the Supabase PROJECT — invited to the Supabase org (preferred) or a
   personal access token — then the Supabase MCP on their own Claude account inherits that access. The
   MCP connector is only the pipe; authorization lives on Supabase, not on the Claude side. Full
   onboarding steps: Architecture §0.4 and CONTRIBUTING.md.
4.29. **API keys must never be readable by the browser.** pm_ai_config deliberately has NO RLS select
   policy for anon OR authenticated. The CMS is a browser app with a shared admin login, so anything
   the client can SELECT is effectively public to anyone with that login (or any XSS). Keys are
   written via pm_ai_set_key and read ONLY server-side by the edge function (service role). The UI
   reads pm_ai_status, which returns a masked hint and NEVER the key. Never add a select policy to
   pm_ai_config, never return api_key from an RPC, never send a key to the client "just to show it".
4.28. **Settings configure; content pages create.** Generation was buried inside AI Settings as a
   stripped-down panel — which put it in two places at once, and made the API path a poor relation of
   the manual one (no themes, no frame words). One page, one set of options, two ways to run it. How
   you run something must never change what you're allowed to ask for. And never show a control that
   does nothing in the current mode: hide it.
4.27. **Ask "how will someone ACTUALLY use this?" BEFORE building the auth model.** I built the MCP
   connector with a shared-secret bearer token, because that is how most APIs work. Claude's connector
   screen has no field for one — it does OAuth or nothing — so the whole auth model was unusable, and
   I only found out when Albert asked how partners connect. Check the actual UI the user will face
   before designing for it.
4.26. **"It returned 200" is not "it works".** All three base-URL bugs in the OAuth server (http instead
   of https, wrong path, Supabase's INTERNAL hostname) returned a perfectly healthy 200 while telling
   Claude to go somewhere that did not exist. Read what the response SAYS, not just its status code.
4.25. **The SHAPE of a tool's output decides how it gets rendered — more than any instruction does.**
   preview_questions returned each question with all ten levels nested inside it. Twelve questions x
   ten levels meant the payload was overwhelmingly level-shaped, so it was summarised level-by-level,
   and no amount of "show the questions, not the levels" wording fixed that — the wording was fighting
   the data. Restructuring it question-first fixed it immediately. When output is being presented
   wrongly, look at what dominates the payload before writing another instruction.
4.24. **Do not let a nicer version regress a working one, and make failure visible if you try.**
   The preview already worked: the assistant built a playable card from the data. Adding an MCP Apps
   widget made the host render the widget INSTEAD — and the assistant still reported success, because
   from its side the widget had rendered. A working feature was replaced by a broken-looking one and
   the failure was invisible from the inside. If you layer a new renderer over a working path, keep
   the old path reachable and make the new one fail loudly.
   (The widget was later found to be CLIPPED, not blank — see rule 4.33. That does not weaken this
   rule, it vindicates it: the rollback kept a working preview available for three sessions while the
   real cause was still misdiagnosed. The widget now ships WITH this rule satisfied — the text content
   block still carries the full JSON so the artifact path stays reachable, and the view's status bar
   announces its own state, so a failure is loud rather than silent.)
4.23. **NEVER smoke-test with a WRITE tool against live data.** Verifying the connector after a deploy,
   I called update_pack on the real Calmness pack to prove the handler worked. It did — and it
   overwrote that pack's description, which no table records the previous value of, so it was simply
   gone. The check itself caused the damage. Exercise READ tools (list_packs, get_pack_content,
   review_status, preview_questions, check_questions) to prove a deploy landed; they cover the same
   code paths for the purpose of "did the transcription survive". If a write path genuinely must be
   tested, create a throwaway row first and act on that, or read the current value and put it back.
   Note the asymmetry: this project has no history table, so an overwrite is unrecoverable while a
   bad read costs nothing.
4.22. **Any capped read must report the true total.** A tool that returns \`limit(40)\` rows and then
   reports \`count: rows.length\` is lying by omission the moment there are 41. Count separately with a
   head/exact query and return total + showing + truncated, and say so in the note. This project has
   now hit the silent-truncation class three times (PostgREST's 1,000-row cap, Alpaca's ~2,000-row
   cap, and this one) — the pattern is always the same: the response looks healthy and the number is
   simply wrong. Assume every cap will be reached eventually and fix it while it is still latent.
   Related: name identifiers for what they are. A live-question \`id\` sitting next to tools that take
   review-queue ids is a trap even when the wrong id fails safely.
4.21. **Instrument the negotiation, not just your own code — and do not let a plausible external
   explanation end the investigation.**
   ORIGINAL FORM: this rule said MCP Apps was implemented to spec but Claude Web never asks a custom
   connector for the UI resource, so no amount of correct implementation would open it. THAT WAS
   FALSE, and it was believed for three sessions. The host did fetch the resource and did render the
   view; it was clipped because the view never reported its height (rule 4.33).
   WHAT ACTUALLY WENT WRONG is worth more than the original advice. An open bug report existed that
   matched the symptom, so the symptom was pattern-matched to it and treated as confirmed. A
   screenshot showing the widget HALF working — status bar populated, first card drawing — was read
   as showing it not working at all. The rung-logging that supposedly proved resources/read was never
   called was measuring the wrong thing, and its result was never sanity-checked against the
   screenshot sitting in the same conversation.
   THE RULE: instrumenting each rung is still right. But an external cause (platform gap, upstream
   bug, someone else's issue tracker) is the most comfortable answer available and therefore the one
   to distrust most. Before accepting it, state what you would expect to see if the cause were LOCAL,
   and go and check that. Here the local hypothesis predicted exactly what the screenshot showed.
   AND: ship the fallback that works today anyway. That part held up — the artifact path is why there
   was something usable throughout, and it is still the fallback for hosts without MCP Apps.
4.20. **A self-test that hard-codes what the CLIENT discovers is not a test.** The MCP self-test drove
   the OAuth flow by calling /register, /authorize and /token at URLs it already knew — so it passed,
   green, repeatedly, while the connector was completely unusable from a real Claude client. The step
   it skipped (root /.well-known discovery) was the ONLY step that was broken. When a client does
   discovery, routing or negotiation on its own, the test must start where the CLIENT starts, or it
   proves nothing about the path that matters. When you cannot drive the real client, INSTRUMENT the
   server and read what it actually receives: adding request logging to the shim is what finally
   located this, and each stage of an OAuth flow leaves a row (pm_oauth_clients → codes → tokens),
   so a count of those tables tells you exactly how far the real client got.
4.19. **The MCP connector must never gain a write path to LIVE QUESTIONS — except approval, which
   was built Aug 2026 under conditions this rule set.** The invariant is that pm_review_approve stays
   the only route a question takes into a pack. propose_questions writes to the queue and nowhere
   else. Never let a tool write pm_questions directly.
   create_pack and update_pack DO write, and that is acceptable, because a pack is a CONTAINER, not
   content — a connector-created pack is EMPTY until questions are approved into it.
   preview_questions is READ-ONLY; reject_questions and edit_queued_question write only to PENDING
   queue rows — rejecting removes from the pipeline and an edited row stays pending, so neither can
   reach a child. An edit is re-validated and refused if it breaks a rule.
   APPROVE, BUILT 11 Aug 2026, meeting the three conditions this rule named when it withheld it:
   • PER-TOKEN. can_approve on pm_mcp_tokens. Tokens without it never SEE approve_question or
     unapprove_question — tools/list filters them out, because a capability that is absent cannot be
     attempted or argued with. DEFAULT IS TRUE by Albert's explicit decision: a partner approving is
     still a HUMAN approving, which is what this invariant protects. The cost, recorded plainly, is
     that the writer and the reviewer may now be the same person, so the queue is a checkpoint the
     author passes through rather than a second pair of eyes. Withdraw it per token with one UPDATE;
     authenticate() re-reads the row every request, so it bites immediately.
   • ONE AT A TIME, NO BULK. A same-length pair, or a wrong option that also fits the sentence, is
     invisible in a list and only surfaces when the question is PLAYED. Bulk approval is one tap that
     puts unexamined questions in front of children. The friction is the feature.
   • confirm_answer MUST MATCH the correct word, exactly as shown on the card. Statelessly we cannot
     verify a preview happened; requiring the word back proves the caller SAW the question rather
     than approving an id off a list. It is a weak proof and an honest one — a speed bump, not
     security.
   • AND AN UNDO, which is what makes approval a tap rather than a commitment. unapprove_question
     sets the question inactive (feeds serve active only, so it leaves the game next poll) and
     returns the row to pending. Nothing is deleted. It only ever REMOVES content from children —
     the same reasoning that has always permitted reject_questions.
   review_status is READ-ONLY and its visibility is deliberately SHARED (all partners see all
   submissions), matching the shared-admin model rather than inventing a boundary the CMS does not
   enforce.
   Deliberately still absent: DELETE for packs (destructive — it takes the questions with it), and
   any edit to a live question's CONTENT. Removing is safe; changing is not.

4.18. **EVERY content-entry path goes through the review queue.** Not just AI generation — imports
   too. There were two ways in and only one was gated, and the ungated one (Bulk Import) is how
   BRIGHT/GENTLE reached children. Do NOT try to detect whether content "came from AI": you usually
   cannot tell, and a wrong guess means unchecked content reaches a child. The ONLY path into
   pm_questions is pm_review_approve. If you add a new way to create content, it goes through the gate
   or it does not ship. (The one deliberate exception is whole-pack file RESTORE, which lands as a
   DRAFT and is validated with a loud warning — but it must never be published unchecked.)
4.17. **The lint must check the defect that actually breaks the game.** pm_lint checked four cosmetic
   things and missed the ONE that harms a child: an alternate the same length as the answer. Two
   broken questions sat LIVE in a published pack while the health check said all was well. Any check
   the AI validator performs on new content, the lint must perform on existing content — above all
   \`ambiguous\`. A health page that cannot see the worst defect is worse than none: it is false comfort.
4.16. **Read the LIVE FEED, not just the code.** Two real content defects (a reversed pair, an
   overused distractor) were invisible to every automated check AND to reading the pages — they only
   showed up when I looked at what the GAME actually receives. The checks were all grouped by ANSWER,
   so a repeated PAIR and a repeated ALTERNATE were structurally invisible. Periodically pull the real
   feed and look at it as a child would.
4.15. **If a check can make a question WRONG FOR A CHILD, the lint and the validator must both have
   it. Advisory checks may live in the lint alone — but say which is which.**
   ORIGINALLY this rule read "if the lint catches it, the validator must too", full stop, after the
   Health lint flagged reversed pairs that validateQuestion passed as clean. The Aug 2026 strict-dedup
   alignment then deliberately removed the repetition checks from the validator and restated variety
   as a PREFERENCE — which left the rule and the code contradicting each other, and the contradiction
   sat undetected because nothing tests one against the other.
   REVISED Aug 2026, and this is the actual invariant:
   • HARD checks — the ones where the child is shown two correct answers or is marked wrong for a good
     word — must exist in the lint AND in every copy of validateQuestion. \`ambiguous\` above all.
   • ADVISORY checks — variety, repetition, predictability — may live in pm_lint/pm_lint_details only.
     They describe a pack getting stale, not a question that is broken.
   CURRENT STATE, verified against the live function bodies: pm_lint and pm_lint_details carry
   \`reversed_pair\` and \`overused_alt\`; validateQuestion carries neither, in any of its four copies.
   That is now INTENDED, not drift. If you re-add them to the validator you are changing policy, not
   fixing a bug — update this rule in the same pass.
   KNOWN GAP, caught neither side: CROSS-ROLE WORD REUSE, where a word is the ANSWER in one question
   and the DISTRACTOR in another. \`reversed_pair\` groups on the same PAIR so it cannot see it, and
   \`overused_alt\` only counts repeated distractors. This is a HARD defect by the test above — the
   child is marked wrong for a word and then right for it — so it belongs in both, and is in neither.
4.14. **READ the page, don't just inspect it.** A page can be structurally perfect and still say
   nothing useful. The Health page showed "(untitled)" on every row for weeks — valid markup, correct
   layout, every automated check green — because the UI read \`d.label\`/\`d.issue\` while the RPC returned
   \`answer\`/\`code\`. No structural test can catch that. Render the page to text and READ it.
4.13. **An empty label is worse than no label.** A control wrapped in a text-less \`<label>\` counts as
   "associated" and will pass a naive check, while announcing an unnamed field to a screen reader.
   Always require the label to have TEXT.
4.12. **Inspect the RESULT, not the source.** Grepping code for suspicious patterns is not a UI audit.
   Render into a real DOM with the real evaluated stylesheet and walk the computed styles. And VALIDATE
   YOUR ORACLE FIRST: extracting CSS by regex left \`\${...}\` placeholders that jsdom silently rejected,
   so every computed style was a lie; and a naive label check flagged every correctly-built field,
   because a control wrapped in a <label> IS associated (implicit association). A broken oracle is worse
   than none.
4.11. **Never regex-edit JSX.** A careless pattern inserted attributes inside arrow functions
   (\`onChange={(e) = aria-label="x"> setFoo(...)}\`) across 12 lines. Only the build caught it. Use
   targeted, structure-aware edits.
4.10. **Cap the CONTENT, not just the container.** A max-width on the page wrapper does nothing for a
   lone form field or a paragraph inside it — they will happily fill all 1080px, leaving a giant
   input marooned in white space and body copy ~150 characters wide. Every form gets a readable cap
   (\`.pm-form-2\` 860px), every panel \`.pm-readable\` (720px), every paragraph \`.pm-prose\` (680px).
   This is the difference between "responsive" and "actually looks designed".
4.9. **Device class is decided on the SHORT side, never on raw width.** A phone in landscape is
   667–932px wide — wider than many tablets. Keying layout off innerWidth alone made rotating a phone
   swap the entire navigation and drop every phone-specific rule (including the 16px inputs that stop
   iOS auto-zooming). Decide on min(w,h) for touch devices; only a resizable desktop window should key
   off live width. And there must be ONE breakpoint system: the JS stamps a class on <html> and the
   CSS keys off it. Never reintroduce parallel width media queries — they WILL drift.
4.8. **Config must never lie.** If a flag exists and is reported to the UI, something must ENFORCE
   it. \`pm_ai_config.enabled\` sat unchecked for a while: you could "disable" a provider and it would
   still be used. Either enforce a flag or delete it — dead config that lies is worse than none.
4.7. **"Null means don't change" needs an escape hatch for every field.** The setter treats null as
   "leave it alone", which is right for a key you can't read back — but it means an empty value cannot
   be expressed. Temperature/top_p have explicit clear flags; the system prompt uses an empty string.
   Any new nullable setting needs one or the other, or users will be unable to UNSET it and the UI
   will silently lie.
4.6. **NEVER send temperature/top_p unconditionally.** Anthropic returns 400 for them on Opus 4.7+;
   OpenAI rejects them on GPT-5 reasoning models. They must be nullable and OMITTED from the request
   body when unset. A "sensible default" here breaks generation entirely on those models. Because null
   means "don't change" in the setter, keep the explicit clear flags so a value can actually be unset.
4.5. **A params-only save must never wipe the API key.** The key can never be read back, so the setter
   takes a null key to mean "keep the existing one". Never add an overload of pm_ai_set_key — two
   signatures make the call ambiguous and every save fails.
4.4. **Anything that spends money must be logged and rate-limited.** AI generation is the only
   operation in this app with a real cost. Every provider call (generate/repair/test, success AND
   failure) goes to pm_ai_usage with token counts and the actor; the edge fn checks pm_ai_rate_check
   BEFORE calling a provider. Never add a new paid call without both. Logging must be best-effort so
   it can't break the request.
4.3. **Mobile nav must be DERIVED from NAV, never hardcoded.** The phone drawer once had a hardcoded
   list, which left three whole pages (AI Review, AI Settings, Generator) unreachable on a phone. It
   now renders NAV.filter(n => !NAV_PHONE.includes(n.id)). Never hardcode that list again.
4.2. **De-dup context must include the review queue and the current batch.** Comparing only against
   live questions is not enough: two generate runs before a review will duplicate each other, and a
   question you REJECTED will be regenerated. Always seed the validator's \`existing\` with live
   questions + pending + rejected queue rows, and validate a batch CUMULATIVELY (each item sees the
   ones before it) so a word repeated within one batch is caught. Also: an answer WORD reused in a
   different sentence is a real defect (a 10-20 question pack teaching BRAVE twice) - never collapse
   duplicate detection back to "same sentence AND same answer".
4.1. **validateQuestion is a PARITY INVARIANT** (like maskWord). The copy in core.jsx and the copy in
   the generate-questions edge fn must stay byte-identical - the CMS and the generator must agree on
   what "valid" means. Its headline check, "ambiguous", runs the REAL engine at EVERY level: if the
   alternate ALSO fits the blank anywhere, the puzzle has TWO correct answers. At whole-word levels
   the only clue is LENGTH, so ANY same-length alternate is broken there. This is not hypothetical -
   BRIGHT/GENTLE, SURE/GLAD and KIND/MEAN all shipped broken in live content and all look fine to a
   human eye. Never weaken or skip this check.
5. **View column order.** pm_pack_overview uses \`p.*\`. Adding a column to pm_packs shifts
   positions and CREATE OR REPLACE VIEW will error — DROP and recreate the view instead.
6. **Auth/session.** Access tokens expire ~1hr. rest()/rpc() auto-refresh + retry once on
   401 and fall back to the login screen. Don't remove that; don't leave the UI logged-in
   on a dead token.
7. **Keep the docs current.** On EVERY change/feature/fix, update the three embedded docs
   in devdocs.jsx (DOC_ARCHITECTURE incl. its §12 changelog, DOC_CLAUDE_MD, DOC_BUILD_PROMPT)
   in the SAME pass, so the Developer Notes page never drifts from the real build.
8. **Accessibility/tokens.** All text must meet WCAG AA on its background — use the C tokens
   (faint is already the minimum readable grey; don't go lighter for text). Never hardcode
   a hex where a token exists (dark mode + contrast depend on it). Inputs use C.panel bg and
   the ::placeholder rule — don't reintroduce white input backgrounds.
9. **URL-hash routing (don't break refresh-persistence).** The current view lives in
   location.hash (#/questions, #/pack/<id>, #/ = dashboard). nav state is SEEDED from parseHash()
   at mount, goNav/goPack WRITE the hash, and a hashchange listener re-derives state. If you add a
   nav section, add its id to VALID_NAV and give it a hash. Never revert nav to plain state
   initialised to a constant — that reintroduces the "refresh always dumps you on the dashboard" bug.

## Data access
- The \`db\` object (core.jsx) is the ONLY way to touch data. Add new queries there.
- RPCs live in Supabase: pm_dashboard_stats, pm_search_questions, pm_clone_pack, pm_lint,
  pm_lint_details, pm_log, pm_mark_released.
- Levels: pm_levels holds the 10 editable level definitions. Packs have a default \`level\`;
  questions have a nullable \`level\` (null = inherit pack). Effective level = coalesce(
  question.level, pack.level). Levels also define blank SHAPE: letter_position (start/
  middle/end/random) and letter_grouping (grouped/spread), overridable per question.
  maskWord(word, letters, position, grouping) generates the blank; buildLevelVariants(q, levels,
  overrides) resolves the chain override(pm_question_levels) → question's own → level default →
  hard-default, and previewAtLevel wraps it for single rows. If you change how blanks render,
  update maskWord/buildLevelVariants in ONE place — every view (editor preview, rows, PlayMode,
  export) and the game feed mirror it.
- Multi-level concepts: every question renders every level via buildLevelVariants (question
  + level rules → per-level blank). Overrides live in pm_question_levels (one row per edited
  level; absent = auto-generated). The question-bank row expands to show all variants. Don't
  duplicate a question into 10 rows — it's ONE row, derived. To send levels to the game, a
  profile sets spec.expand_levels → fetchAllContent({...},{expandLevels:true}) attaches a
  \`levels\` array; the game-feed edge function mirrors this. If you touch buildLevelVariants or
  the expand logic, update BOTH engine.jsx and the edge function (parity invariant). Same for
  maskWord AND resolveSlots AND resolveFrameMap (frame-word slots + the token->word map): the
  client (core.jsx) and edge fn must stay byte-identical, including the deterministic seeded
  pool-pick, or the CMS preview and the exported target/frames won't match what the game renders.
  If you add a column to pm_packs, DROP+recreate pm_pack_overview (it uses p.*).
- RLS: anon read-only, authenticated full write. Never add anon write policies.
- RPC grant footgun: recreating a function with DROP+CREATE (needed when its signature/return
  changes) silently RESTORES the default PUBLIC execute grant — so anon regains the ability to CALL
  it. After any such recreate, \`revoke execute on function fn(exact_sig) from public, anon;\` (revoke
  from PUBLIC, not just anon — the grant flows through PUBLIC) and \`grant ... to authenticated;\`.
  Intended posture: ONLY the two trigger functions (pm_bump_pack_version, pm_touch_updated_at) are
  anon-executable, and those are inert (trigger fns can't be called as RPCs). All real RPCs are
  authenticated-only. (Because every RPC is SECURITY INVOKER, a stray grant is posture-not-breach —
  RLS still blocks writes and scopes reads — but keep the posture correct.)

## Editing / build workflow
- Edit the modular files in /v2/, NOT the compiled output.
- Rebuild: \`node assemble.cjs && node build_html.cjs\`.
- Validate before deploy: \`node --check app.compiled.js\`; confirm all JSX components
  resolve to definitions; confirm all db.* / rpc names resolve; parse each inline <script>.
- Test DB changes against the live project (RPCs, RLS) before shipping — verify, don't assume.
- Deploy: copy index.html + source into /repo/, commit, push to main; Cloudflare auto-builds.
- Always sync final files to the outputs directory and present them.

## Conventions
- Formatting: inline styles using the C/S/R/SH tokens; keep the CSS-variable theme intact
  (don't hardcode hex where a token exists — dark mode depends on it).
- Responsive: question rows are compact rows on desktop, content-first cards below desktop.
  Use the pm-qrow / pm-qrow-main / pm-qrow-meta / pm-qrow-actions classes.
- Every mutation should call logActivity(...) so the Activity log stays complete.
- After a successful sync to the game, call db_sync.markReleased(null) to clear pending flags.
- Keep responses/docs truthful to the actual schema (query pg_proc / pg_tables to confirm).

## Testing capabilities

### THE TEST SUITES — SEVEN, and \`npm test\` runs them all
Run \`npm test\`. Do not run the two you remember (rule 4.47).
  npm run test:types     tools/typecheck.sh — tsc --noEmit over edge-functions/*.ts. RUNS FIRST.
                         esbuild only PARSES; it compiled "who is not defined" and shipped it
                         (rule 4.48). This is the only check that catches an undefined identifier
                         or a property that does not exist on a returned object.
  npm run test:engine    engine.js    1725 cases — maskWord parity across EVERY copy of it
  npm run test:runtime   runtime.js   renders each page headless, fails on any warning or crash
  npm run test:read      read.js      reads each page as a human would: the words, in order
  npm run test:inspect   inspect.js   real DOM + real stylesheet, inspects COMPUTED styles
  npm run test:interact  interact.js  actually CLICKS things — 42 buttons, 52 inputs
  npm run test:visual    visual.js    layout across 27 page/device combinations
Plus three the npm target does NOT cover, run them by hand after touching mcp-shim/:
  node mcp-shim/widget-test.mjs     the MCP App view, both payload shapes, in jsdom
  node mcp-shim/overview-test.mjs   the overview tool, its failure modes, the view URI rules
  node mcp-shim/logging-test.mjs    redaction — asserts no secret can reach pm_connector_log

### What a HEALTHY run looks like, so you can tell a regression from the baseline
  engine    "1725 cases across 3 implementations — ALL IDENTICAL"
  runtime   "No runtime warnings or errors."
  inspect   "No defects found."
  interact  "42 buttons clicked, 52 inputs changed. Nothing broke."
  visual    ~153 MINOR defects, 0 serious — every one a control under the 40px comfortable touch
            target. That is the STEADY STATE for a desktop-density admin UI, not a regression.
            Watch the SERIOUS count; if it is not 0, something actually broke.
  visual also writes browsable HTML to /home/claude/bt/visual/ — open it rather than guessing.

### Edge functions: TYPE-CHECK before you deploy, do not merely compile
  npm run test:types
esbuild is NOT sufficient and this is not a style preference — it parses without resolving
identifiers, so a ReferenceError compiles and deploys (rule 4.48). Use esbuild only as a fast
syntax smoke test; tsc is what decides.

This environment cannot reach *.supabase.co / *.workers.dev / *.pages.dev / Firebase hosts
directly from bash. Work around it:
- **DB / SQL:** use the Supabase tools (execute_sql, apply_migration, etc.).
- **HTTP round-trips (game feed, push, any endpoint):** trigger them FROM the database with
  pg_net — \`select net.http_get('https://…/functions/v1/game-feed?health=1')\` then, after a
  few seconds, read \`select status_code, content from net._http_response where id = <n>\`. This
  lets you verify the live edge function / REST endpoints without the user. Also good for
  confirming an RPC through the real PostgREST \`/rpc\` path with the client's exact payload.
- **Rendering the app headless (yes, this works):** install react@18.3.1 + react-dom@18.3.1 +
  @babel/core + @babel/preset-react locally (KEEP a package.json in /home/claude/bt pinning
  them — a bare \`npm install X\` with no lockfile PRUNES the others and breaks the build), then
  compile the .jsx with preset-react {runtime:'classic'} and render a component with
  react-dom/server \`renderToString\` inside a vm sandbox (stub window/document/fetch/localStorage).
  This catches real runtime crashes and lets you assert on the output HTML — it found several
  bugs a grep never would.
- **Confirm the build actually rebuilt (learned the hard way):** the assemble step Babel-compiles
  the combined source; if it THROWS, it leaves the old compiled file and the HTML builder wraps the
  STALE bundle. \`node --check app.compiled.js\` still passes (checking the old valid file), so it
  does NOT catch this — a broken build can ship silently for several commits. After every build,
  verify assemble printed its success summary AND the compiled file was freshly written (mtime, or
  grep a just-added string / the bumped build stamp) before trusting anything downstream.
- Everything else: verify deterministically (component/db/rpc reference resolution, running engine
  logic in Node against real data pulled via SQL, parse each inline script via vm.Script,
  babel-parse the doc template literals to confirm they're balanced).

## Known-safe "do not touch"
- The four seeded builtin export profiles (is_builtin=true) unless explicitly asked: "Flat API
  (question list)", "Firebase (nested)", "Unity (keyed dictionary)" — the three simple ones that
  key off level/effective_level — plus "Full game export (with levels)", the reference profile
  (expand_levels + include_frames; exports template + base_sentence + per-level target + frames).
- pm_dev_notes is a singleton (id=1) — don't insert extra rows.
`;

const DOC_BUILD_PROMPT = `# Build Prompt — recreate Positive Minds CMS from scratch

Use this as a single instruction to Claude (with code execution + a fresh Supabase
project + a GitHub repo) to rebuild the entire app.

---

Build a content management web app called "Positive Minds" — a CMS for a children's
word game based on CBMT (Cognitive Bias Modification Therapy). The game is a SPELLING
puzzle: it shows a warm first-person sentence with one word partly hidden (some letters
revealed, the rest blank — e.g. "I feel PR_UD of the things I do") and offers TWO positive
words. Both words are positive (never a negative option — the therapeutic core); the child
picks the one whose SPELLING fits the revealed letters + blank shape. The primary word
(\`answer\`) fits the letter pattern; the alternate (\`alt_answer\`) is another positive word
that does NOT fit it (make it a DIFFERENT LENGTH so it can never match the fixed blanks). It
is NOT a meaning test — the letters decide which word is correct. How much is hidden is set by
the question's level. This CMS
is the authoring + publishing layer; a separate game backend consumes the content.

## Architecture requirements
- Single self-contained index.html. React 18.3.1 from unpkg (pinned UMD). NO runtime
  build step and NO in-browser Babel: author modular .jsx, then pre-compile to plain JS
  with @babel/preset-react { runtime: "classic", development: false } and concatenate.
  Cross-file components must be function declarations (hoisting); const helpers precede use.
- Backend: Supabase (Postgres + PostgREST + Edge Functions + Auth).
- Host on Cloudflare (Worker) auto-deploying from GitHub main.
- Styling: inline styles + a CSS-variable theme system for light/dark. No CSS framework.
- Include a CDN-failure fallback message and PWA (inline manifest + service worker).

## Data model (Supabase, all RLS: anon read-only, authenticated full write)
- pm_packs(id, slug unique, name, emoji, description, color, difficulty
  [basic/advanced/mixed], status [draft/published/archived], sort_order, is_custom,
  tags text[], content_version int default 1, released_version int default 0, released_at,
  timestamps)
- pm_questions(id, pack_id FK cascade, template with {blank} + optional {token} frame slots,
  answer, alt_answer, status [active/inactive], sort_order, notes, level, letter_position,
  letter_grouping, frame_slots jsonb, timestamps). No per-question difficulty or letters_hidden
  columns — the level (+ any pm_question_levels override) fully drives how much is hidden.
- pm_question_levels(question_id FK, level, per-level override of letters_hidden / letter_position /
  letter_grouping) — the exception layer over pm_levels, for a question that needs different masking
  at one level only.
- pm_levels(level 1..10, letters_hidden, letter_position, letter_grouping, whole_word, label, …) —
  the level ladder. Editing a row here changes EVERY question at that level immediately, because
  questions are never pre-rendered.
- pm_review_queue(id, pack_id, template, answer, alt_answer, status [pending/approved/rejected],
  provider, validation jsonb, target_level, reason, timestamps) — the ONLY way partner content
  enters a pack, via pm_review_approve.
- pm_activity (audit log), pm_export_profiles(spec jsonb, is_builtin), pm_sync_log,
  pm_sync_targets(config jsonb), pm_dev_notes (singleton id=1)
- AI: pm_ai_config (provider keys, model, temperature — keys written ONLY through
  pm_ai_set_key/pm_ai_clear_key, never selected back), pm_ai_settings, pm_ai_usage (per-call token
  and cost accounting, feeding pm_ai_rate_check).
- CONNECTOR / OAUTH — these are what let partners in, and a rebuild without them has no connector:
  pm_mcp_tokens(id, partner, token_hash [sha256 hex of the pmk_ token, never the token],
    active, created_at, created_by, last_used_at, calls_made). RLS on, ZERO policies: only the
    service role touches it. active is re-read on EVERY request, so revocation is immediate.
  pm_oauth_clients(client_id, client_name, redirect_uris, created_at) — dynamic registration,
    RFC 7591. One row per Connect press; expect many.
  pm_oauth_codes(code, client_id, token_id, code_challenge, redirect_uri, used, expires_at) —
    single-use PKCE authorization codes.
  pm_oauth_tokens(access_token PK, token_id FK, client_id, expires_at, refresh_token,
    refresh_expires_at, last_used_at) — NO unique constraint on token_id, deliberately: one partner
    token supports many simultaneous sessions.
  pm_connector_log(at, phase, method, path, query, status, had_auth, client_id, partner, ua,
    cf_ray, country, session_id, err, ms, note) — insert-only under anon (a policy for INSERT and
    no read policy), capped by pm_connector_log_prune.
- The FULL RPC surface is larger than the list below: pm_ai_set_key / pm_ai_clear_key /
  pm_ai_set_enabled / pm_ai_status / pm_ai_usage_summary / pm_ai_rate_check, pm_content_manifest,
  pm_review_enqueue / pm_review_approve / pm_review_reject / pm_review_counts,
  pm_mcp_issue_token / pm_mcp_list_tokens / pm_mcp_revoke_token, pm_oauth_cleanup,
  pm_connector_log_prune, pm_bump_pack_version, pm_level_delete_cleanup, plus the tombstone and
  touch triggers. The SECURITY DEFINER ones are exactly those that must act beyond the caller's
  RLS: the AI key handling, token issuing, the connector log prune, and the tombstone triggers.
- View pm_pack_overview: packs + active_questions + total_questions + has_pending_changes
  (content_version > released_version). Create it with security_invoker=true so it respects
  the caller's RLS (otherwise anon can read draft packs via the public API).
- Triggers: touch updated_at; bump pack content_version on any question change
- RPCs: pm_dashboard_stats, pm_search_questions(q,pack,stat,lvl,lim,off,from_date,to_date,sort) [paginated, date-filter+sort],
  pm_clone_pack(src,slug,name), pm_lint + pm_lint_details, pm_log, pm_mark_released(uuid[])
- All RPCs SECURITY INVOKER. Grants: REVOKE EXECUTE ... FROM public, anon on every real RPC and
  GRANT ... TO authenticated (only the two trigger functions stay anon-executable, and they're inert).
  Note: DROP+CREATE on a function re-grants PUBLIC by default, so re-revoke after any recreate.
- CRITICAL: paginate all list reads in 1000-row batches (restAll) — PostgREST caps at 1000.

## Auth
Single shared admin password (Supabase Auth user). Password grant → access+refresh tokens
persisted in localStorage (survives tab/browser restarts) with a 7-day window from login;
Bearer on writes; refresh the access token proactively in the background (timer + on tab
refocus) AND reactively on a 401 with one retry, falling back to login only if the refresh
token is genuinely dead or the 7 days elapse. Anon publishable key authorizes reads only.

## Features to build
1. **Dashboard/Overview:** four headline stat boxes — total packs (published/draft in subtitle),
   questions (active in subtitle), published packs (live in the game), and empty packs (need
   content) — plus a "questions by level" mini bar-chart showing the distribution across the 10
   levels in the Library-health card. Do NOT add a "levels in use / of 10" box: every question
   renders at every level, so counting distinct assigned levels is misleading. All via one RPC;
   quick actions; and a compact at-a-glance index of ALL pack names (one line each, tap to open).
2. **Library:** pack cards (emoji, color accent, status, question counts); search + status/
   difficulty filters; drag-to-reorder; clone (duplicate pack + questions); delete with
   optimistic Undo; JSON import/export that round-trips the FULL model (pack level + purpose/
   focus/style, and per-question level/position/grouping/frame_slots).
3. **Pack detail:** paginated question bank. Filters: level, WHEN-ADDED (any / 24h / 7d / 30d),
   and a sort (default order / newest first / oldest first) — all applied SERVER-SIDE in the
   question query so they span the whole pack and paginate correctly (the level filter includes
   inheritors via or=(level.eq.X,level.is.null) when X is the pack's own level). A quick text
   search stays client-side over the loaded page. Each row shows a level chip, a compact relative
   "added" stamp (full timestamp on hover), and a per-question "Levels" expander. Add/edit
   questions. The question editor is LEVEL-BASED —
   it has NO difficulty or letters-hidden controls (those are derived from the level). It offers
   the sentence template, the two positive words, a Level selector (controls letters-vs-whole-
   word), position/grouping overrides that appear only when the previewed level hides letters,
   and a "how the child sees it" preview that renders through the real level engine with a
   level-chip picker so you can flip through every level. Also: bulk import (pipe OR JSON, with
   duplicate detection); multi-select bulk activate/deactivate/delete; and **Play mode** — an
   author preview that plays the pack like a child: for each active question it renders the
   sentence at the effective level (through the shared engine) and shows the two words shuffled.
   The PRIMARY word (answer) is the correct one because its SPELLING fits the revealed letters
   (the alternate is positive too but doesn't match the blank pattern). Picking the primary shows
   "Correct! ✓" and scores a point; picking the alternate shows "Not quite — the answer is X" and
   reveals the right word (green/red button states). The done screen shows "X of Y correct". Load
   ALL active questions (paginate — do NOT cap at 100). A LEVEL FILTER at the top plays the whole
   pack at one chosen level (forcing every question to that level's blank difficulty) or "each own
   level" (default); changing it restarts the run.
4. **All questions:** server-side global search across every pack, paginated, click-through
   to the source pack. Filters: text, PACK (a dropdown of every pack, alphabetised, "All packs"
   default → the \`pack\` param on the search RPC), status, level, and WHEN-ADDED (created_at) —
   presets (last 24h / 7d / 30d) or a custom date range — plus a sort (newest first / oldest
   first / group by pack). Each row shows a compact relative "added" stamp (e.g. "3h ago",
   "2w ago", or a date), full timestamp on hover. A "Clear filters" button appears whenever any
   filter is active (resets all six). Empty state is filter-aware: distinguishes "no questions
   match these filters" (when any filter is set) from "no questions yet" (a genuinely empty library).
5. **Content health:** lint flags invalid templates (no {blank}), missing 2nd option,
   duplicates, thin packs (1–2 questions); links to fix.
6. **Publishing pipeline — the core differentiator:**
   - A **transformation engine** with user-defined "export profiles" whose spec (jsonb)
     controls output shape: structure (nested/flat/keyed), root/questions keys, field
     rename+include/exclude, per-field transforms (upper/lower/trim), value maps
     (e.g. status→a numeric code), filters, meta envelope.
   - A **profile builder** UI: visual field-mapper + raw JSON editor + live preview, all synced.
   - Seed 3 starter profiles: Firebase (nested), Flat API (flat), Unity (keyed).
   - Three channels, all emitting through a chosen profile: **File** download;
     **Feed (pull)** via a game-feed edge function serving per-profile content at a stable
     public URL (endpoints: ?profile, ?list, ?health; paginate; verify_jwt off; ~60s cache);
     **Push** POST to a configurable target.
   - **Firebase targets:** saved destinations (a table) pairing a profile with a database +
     layout. Support Realtime DB (REST), Firestore (REST with typed-value conversion), and
     Cloud Function (POST {writes,payload}). Configurable layouts (per-pack/per-question/
     single-doc) with {slug}/{id} path templates. Provide a sample Cloud Function in-app.
   - Control modes: manual / auto-on-publish / scheduled. Release state: content_version vs
     released_version → "pending changes"; a successful sync calls pm_mark_released to clear it.
   - Sync history log of every file/feed/push.
   - IMPORTANT: mirror the transform engine in the edge function; keep them identical.
6b. **Sync API for external backends (content-api edge function):** a SEPARATE edge function
   (verify_jwt off) that is the on-demand sync API for a Firebase-style backend. ONE clean shape
   (not the profile projection). Endpoints: \`?manifest=1\` (global_version + levels_version +
   per-pack version rows — a client polls this and only pulls when global_version changed);
   default (full published content: level definitions + packs with questions, each question's 10
   variations rendered by the SAME engine); \`?since=<iso|epoch>\` (incremental — packs where the
   pack OR any question changed since, returning that pack's full current questions for wholesale
   replace, PLUS a \`deletions\` array); \`?packs=\`/\`?levels=\` filters; \`?format=xml\`; \`?health=1\`.
   Put an ETag (hash of global_version + query shape) on every response and honour If-None-Match →
   304 — normalise the weak-validator \`W/\` prefix when comparing (the platform wraps bare ETags).
   Optional API-key auth via a CONTENT_API_KEY secret (X-API-Key header or ?key=); unset = public;
   CORS *. Requires: (a) a \`pm_deletions\` tombstone table (entity_type/entity_id/pack_id/slug/
   deleted_at; anon+authenticated SELECT only) written by SECURITY DEFINER triggers — before-DELETE
   on pm_packs + pm_questions AND after-UPDATE-OF-status (a pack leaving 'published' / question
   leaving 'active' writes a tombstone + bumps global_version; re-entering clears its tombstone).
   This status-transition path is REQUIRED: global_version is computed only over published/active
   rows, so without it an unpublish/deactivate would never reach a synced client. (b) a
   \`pm_content_manifest()\` SECURITY DEFINER RPC (published-only) returning the global/per-pack
   versions. The rendering engine (maskWord/resolveSlots/
   resolveFrameMap/buildLevelVariants) MUST stay byte-identical to the client and game-feed.
6c. **AI content generation + MANDATORY human review (two dedicated pages).**
   Build an edge function \`generate-questions\` with verify_jwt=TRUE (only a logged-in admin may
   spend API credits). It must support THREE providers - Anthropic (/v1/messages, x-api-key header),
   OpenAI (/v1/chat/completions, Bearer, max_completion_tokens) and Gemini
   (generativelanguage .../:generateContent?key=, contents[].parts[].text) - one adapter each,
   returning raw text; share the JSON-array parsing (strip code fences, slice from first [ to last ]).

   THE APPROVAL GATE (non-negotiable): the function writes ONLY to a \`pm_review_queue\` table, NEVER
   to pm_questions. Columns: id, batch_id, pack_id, template, answer, alt_answer, frame_slots,
   target_level, provider, model, status(pending|approved|rejected), edited, reject_reason,
   decided_at, decided_by, approved_question_id, validation jsonb, created_at. RLS authenticated-only
   (anon must NOT see unreviewed content); add it to the realtime publication. The ONLY path into
   live content is a \`pm_review_approve\` RPC (atomic: insert the question, mark the row approved,
   link them, flag edited if the human changed anything, note it as AI-generated+approved). CAUTION:
   pm_questions.frame_slots is NOT NULL - coalesce null to '{}' or every approve fails.
   \`pm_review_reject(id, reason)\` records the decision and writes nothing.

   API-KEY SECURITY: store keys in \`pm_ai_config\` (provider PK, api_key, model, enabled) with RLS
   enabled and DELIBERATELY NO SELECT POLICY for anon or authenticated - the browser must not be able
   to read keys at all (this CMS has a shared admin login, so a client-readable key is a public key).
   Write via SECURITY DEFINER \`pm_ai_set_key\`/\`pm_ai_clear_key\`; expose status via
   \`pm_ai_status()\` which returns {configured, hint: masked last 4, model, updated_at} and NEVER the
   key. The edge fn reads the key with the service role. Non-secret settings (active_provider,
   batch_size, auto_repair) go in a separate client-readable \`pm_ai_settings\` singleton. Add a
   \`callFn()\` helper in core.jsx to invoke verify_jwt edge fns with the user's token (mirror rpc()'s
   401 refresh-and-retry).

   THE VALIDATOR (the reason any of this is trustworthy): a \`validateQuestion(q, levels, opts)\` in
   core.jsx, MIRRORED byte-identically in the edge fn (a parity invariant like maskWord). It runs the
   REAL masking engine at EVERY level and flags: no/multiple {blank}; missing/identical words; the
   level's word-length band + multi-word rule; non-letter characters; duplicates; and above all
   AMBIGUOUS - the alternate ALSO fits the blank at some level, so the puzzle has TWO correct answers
   and a child is marked wrong for a right answer.

   REPETITION needs FIVE distinct flags, not one — and two of them are easy to miss entirely:
   \`duplicate\` (same sentence AND same answer), \`same_sentence\` (same sentence, different answer),
   \`answer_reused\` (the ANSWER WORD is already taught elsewhere), \`reversed_pair\` (THE SAME TWO WORDS
   offered as the choice, just swapped over — CALM/PROUD and PROUD/CALM: different sentences, so not a
   duplicate, but the child faces the identical decision twice), and \`overused_alt\` (the same word used
   as the DISTRACTOR 3+ times — a predictable wrong option teaches the child "it is never that one"
   instead of teaching them to read the blank).
   The last two are the ones you will miss: every naive check groups by ANSWER, so a repeated PAIR and
   a repeated ALTERNATE are structurally invisible. Both were live in real content and no check saw
   them. When you group, group by the SORTED PAIR, and separately by the ALTERNATE.
   And CRUCIALLY: every check the Health lint performs on EXISTING content, validateQuestion must
   perform on NEW content — in BOTH copies. They were inconsistent (the lint caught reversed pairs, the
   validator did not), which meant the AI could generate one and the review queue would call it clean.
   The de-dup context must therefore carry BOTH words (template, answer, AND alt_answer) — a query that
   selects only the answer makes the pair checks silently blind.
   DUPLICATES — the original three, for reference: \`duplicate\` (same sentence AND same answer),
   \`same_sentence\` (same sentence, different answer), and \`answer_reused\` (the ANSWER WORD is
   already taught elsewhere - the case that matters most, and the one you miss if you only compare
   whole questions; in a 10-20 question pack, teaching BRAVE twice is a real defect). The de-dup
   CONTEXT must be wider than "live questions in this pack": include live questions (active AND
   inactive) + PENDING queue items + REJECTED queue items + the other items in the SAME BATCH
   (validate cumulatively so the second copy of a repeated word is flagged, not the first; seed the
   repair pass with the batch's already-good items too). Without the queue in scope, two generate runs
   before a review duplicate each other and rejected questions get regenerated. Do NOT cap the
   avoid-list sent to the model - list every taken answer word, call out previously-rejected words,
   and show the sentences already used so it varies phrasing instead of just swapping the word.
   In the UI, treat answer_reused/same_sentence as SOFT (advisory) and the mechanical defects as HARD;
   bulk-approve must only take rows with ZERO flags of any kind. At whole-word levels the ONLY clue is LENGTH, so
   ANY same-length alternate is ambiguous there. Auto-repair: send failures back to the model ONCE
   with the exact defect text, re-validate, swap in the fixes (best-effort; on failure queue the
   originals WITH flags).

   PAGE 1 - AI Settings: a card per provider showing Configured/not with a MASKED hint only, the
   model, "Use this one", "Add/Replace key" (a write-only password field - never render a key back),
   "Test" (a tiny round-trip via the edge fn), "Remove". Plus generation defaults and a Generate panel
   (pack, target level, count, notes) whose output goes to the review queue.
   PAGE 2 - AI Review: tabs pending/approved/rejected; each row shows the sentence, both words WITH
   their letter counts, the pack, level, provider, and any validation flags with plain-English
   reasons; per-row Approve / Edit / Reject; bulk "Approve N clean"; a reject dialog capturing an
   optional reason. The Edit modal must RE-VALIDATE LIVE as you type (same validateQuestion) and show
   the blank shape at every level, highlighting the levels that are ambiguous - so you can see the
   moment a fix actually clears the problem.

   GENERATION PARAMETERS: expose max_tokens, temperature, top_p and system_prompt per provider
   (store them in pm_ai_config), plus a free-text model box so a new model doesn't need a redeploy.
   CRITICAL: temperature and top_p must be NULLABLE and OMITTED from the request body when unset -
   Anthropic returns 400 for temperature on Opus 4.7+ and OpenAI rejects it on GPT-5 reasoning models,
   so a "sensible default" slider BREAKS generation on those models. Since null means "don't change"
   in the setter, add explicit clear flags so a value can actually be unset, and warn about this in
   the UI. Per-provider mapping differs and silently fails if you get it wrong: max tokens is
   max_tokens / max_completion_tokens / generationConfig.maxOutputTokens; the system prompt is a
   top-level 'system' field (Anthropic) / a system MESSAGE (OpenAI) / a separate 'systemInstruction'
   (Gemini). Put the game's rules in the SYSTEM prompt, not the user turn - models follow them more
   reliably. Detect truncation (stop_reason/finish_reason) and say so plainly, or a too-low max_tokens
   just looks like a baffling JSON parse error. A params-only save must NOT wipe the API key (it can
   never be read back) - accept a null key meaning "keep the existing one", and never create a second
   overload of the setter or the call becomes ambiguous.
   ENFORCE WHAT YOU EXPOSE: if the config has an \`enabled\` flag (or any flag the UI shows), the edge
   fn MUST check it. A flag that is reported but never enforced is config that lies. Give it a Turn
   on/off control and refuse with a clear error when it's off.
   EVERY NULLABLE SETTING NEEDS A WAY TO UNSET IT: the setter treats null as "don't change" (correct
   for a key you can't read back), so an empty value cannot otherwise be expressed. Use explicit clear
   flags (temperature/top_p) or an empty string (the system prompt). Without this, users can never
   remove a value and the UI silently lies to them.
   SURFACE A SHORT BATCH: if the model returns fewer questions than asked, say so and name the likely
   cause (usually the token ceiling). Return 'requested', 'truncated' and a 'warning' and show it.
   EXPLAIN EVERY SETTING: each field gets an (i) that opens a plain-English explanation - what it is,
   why it matters FOR THIS JOB (writing children's puzzle content), a suggested value, and a warning
   where one is warranted. Do not write generic API documentation; write what it does HERE.
   COST + RATE CONTROL (do not skip this): generation is the only paid operation. Log EVERY provider
   call (generate/repair/test, success AND failure) to a pm_ai_usage table with provider, model, pack,
   batch, input/output tokens, questions returned, ok, error and the actor (read the email out of the
   verified JWT). Check a pm_ai_rate_check RPC BEFORE any provider call and return 429 with a clear
   message when over the limit (sensible defaults: 20/hour, 100/day). Surface a Usage panel on the
   settings page (runs, questions, tokens, errors, by provider). Make the logging best-effort so it can
   never break a generation the user is waiting on.
   CONCURRENCY: the approve/reject RPCs must SELECT ... FOR UPDATE, or two simultaneous approvals of
   the same queue row can both see 'pending' and create two questions. Also guard against the pack
   having been deleted between generating and approving.
   COUNTS: never download the whole queue to the browser to count it - use a server-side counts RPC.
   MOBILE: the phone drawer MUST be derived from NAV (NAV.filter(n => !NAV_PHONE.includes(n.id))), or
   new pages end up unreachable on a phone.
   EVERY CONTENT-ENTRY PATH GOES THROUGH THE QUEUE — not just the API-key generator. Bulk Import
   (pasting AI output, or your own lines) must ALSO enqueue, never write to pm_questions directly.
   Do NOT try to detect whether a paste "came from AI": you usually cannot tell, and a wrong guess
   means unchecked content reaches a child. Validate every imported row with the SAME validator and
   show the flags BEFORE the user commits. The single exception is whole-pack file RESTORE (a backup,
   or moving packs between environments) — queueing a 200-question restore one-by-one would be absurd,
   so it lands as a DRAFT instead, but it must still be validated and warn loudly.
   REMEMBER WHY THE HUMAN IS THERE: the machine judges mechanics; only a person judges tone and
   meaning. "PERFECT" passes every automated check and is still the wrong word to teach a child.
6d. **CLAUDE CONNECTOR (MCP) — let trusted partners write content by talking to Claude.**
   An edge fn \`mcp\` (verify_jwt=FALSE — partners use their OWN token, not a Supabase JWT) speaking
   JSON-RPC 2.0 over Streamable HTTP. Handle \`initialize\` (return protocolVersion, capabilities.tools,
   serverInfo, and instructions telling Claude the order to call things), \`notifications/initialized\`
   (202, no body), \`tools/list\` and \`tools/call\`.
   GIVE THE PARTNER AN ARRIVAL. There is no "on connect" event in MCP — nothing fires when someone
   attaches a connector. The only thing a host reads at connection is the \`instructions\` string from
   initialize, so build an \`overview\` tool and make instructions a DIRECTIVE TO CALL IT. Never write
   the counts into instructions: it is a static string and goes stale the moment a question is
   proposed. overview returns every pack with live/awaiting counts, how many packs are EMPTY, the
   review queue by pack and contributor, what the partner can do in plain language, and the one thing
   they cannot (approve). Declare it FIRST in tools/list — a tool listed first is the one reached for
   when someone opens with "what's here?". Compose it from the existing reads using the CALLER'S own
   token, so it needs no new privilege. Prepend the directive to the upstream instructions rather
   than replacing them, or you lose the intent-routing.
   IF YOU COMPOSE TOOLS, PROPAGATE 401/403 rather than reporting an empty system. A composed tool
   that swallows an auth failure into a cheerful "everything is zero" will show a signed-out partner
   an empty CMS and never prompt them to sign in. A genuine outage is a different thing from an auth
   failure and should stay a partial result.
   TEN TOOLS in the edge function (the shim adds overview on top, making eleven the partner sees):
   list_packs (packs + level rules + THE BRIEF so the rules are always in context, each
   pack carrying stats: live_questions / distinct_answer_words / awaiting_review, and INCLUDING draft
   packs with their status), get_pack_content (existing questions + words already taken + a statistics
   summary), check_questions (validate drafts, SAVE NOTHING — this is what lets Claude fix its own
   mistakes before proposing), propose_questions (writes to the REVIEW QUEUE ONLY), create_pack and
   update_pack, review_status, preview_questions, reject_questions and edit_queued_question.
   BUILD preview_questions EARLY — it renders a question exactly as a child sees it, at every level,
   mirroring the CMS's own level-variant builder. It is the only way a human can judge TONE, which is
   the thing every automated check misses and the reason the human reviewer exists at all.
   reject and edit act ONLY on pending rows; re-validate every edit with the full engine and refuse
   it if it would break a rule. Do NOT build an approve tool unless tokens carry a role flag.
   Give preview_questions a \`source\` of pending|live so the SERVER decides what to fetch; do not push
   that onto the assistant by telling it to re-shape another tool's output. Cap how many you return,
   but ALWAYS count the true total separately and return total/showing/truncated — returning only the
   capped length is silent truncation and it will mislead. Name ids for what they are: a live question
   id must not be called \`id\` when another tool takes review-queue ids.
   SHAPE THE PREVIEW PAYLOAD QUESTION-FIRST: one entry per question carrying its ready-to-display
   masked sentence, its two options, which is correct, and only a compact list of other levels. Do
   NOT nest every level inside every question — the payload becomes level-dominated and gets rendered
   as a table of level rules no matter what the instructions say. Default to ONE level.
   ROUTE INSTRUCTIONS BY INTENT, not as one chain. An unconditional "always call X first" will hijack
   every unrelated request; say what to do for previewing, for writing, for progress, separately.
   RENDERING THE PREVIEW: the useful form is a PLAYABLE card — sentence, level tabs, two tappable
   words, green/red on tap, and never reveal which is correct before it is tapped. BUILD TWO ROUTES
   TO IT, in this order.
   ROUTE 1, always: return the structured data plus an explicit instruction telling the assistant to
   build the interactive card as an artifact, carrying the CMS design tokens. This has no platform
   dependency and is the fallback forever — build it FIRST and never remove it.
   ROUTE 2, the MCP Apps widget (SEP-1865): the tool declares _meta.ui.resourceUri (NESTED under
   _meta.ui, inside the TOOL object in tools/list, not on the result; the flat _meta["ui/resourceUri"]
   is deprecated), and the shim serves a ui:// HTML resource as text/html;profile=mcp-app via
   resources/list and resources/read. The view speaks raw JSON-RPC over postMessage — no SDK, the
   Worker has no bundler.
   THE ONE THING THAT WILL WASTE YOUR TIME IF YOU MISS IT: the view MUST send
   ui/notifications/size-changed (ResizeObserver, debounced through rAF). Under flexible dimensions
   the VIEW owns its height and the host resizes the iframe to what it reports. A view that does not
   report will render correctly and be CLIPPED to its initial frame, which looks exactly like "the
   widget is blank" and is not. CSS min-height cannot fix it — the iframe is sized from outside.
   Also: send appInfo + appCapabilities.availableDisplayModes on ui/initialize; READ the result
   (hostContext carries containerDimensions, theme, displayMode) and apply it; send
   ui/notifications/initialized only on the MATCHING request id, because the host must not send
   anything before it; use the ui/update-model-context REQUEST for reviewer interactions (there is no
   ui/notifications/context-update — it is not a method, and sending it does nothing).
   CONTENT-ADDRESS THE ui:// URI: ui://<app>/view-<hash of the HTML>. Hosts cache a ui:// resource
   keyed on its URI and the protocol has no way to say "that changed", so a FIXED URI means a
   redeployed view can keep rendering the old one — silently, looking exactly like a failed deploy.
   Hash the view itself so nobody has to remember to bump anything. Keep serving any older URI so a
   live session does not break. And know that an already-rendered widget NEVER re-fetches: scrollback
   is not a current view.
   THE SYNC API IS TWO ENDPOINTS, and keep them distinct: one for SYNCING (versions, ?since
   incremental, deletions, ETag/304, selectable blocks) and one for SHAPING (saved profiles that
   rename fields and choose structure for a specific engine). Give the sync one ?include= so a
   caller takes only the blocks it needs — the pre-rendered level variants are ~19x the rest of the
   payload, so a client that masks its own words must be able to decline them. Give it
   ?shape=nested|keyed|flat, because a keyed object is what Firestore wants and a flat array is what
   a SQL import wants. PUT EVERY PARAMETER IN THE ETAG KEY: a 304 promises the body the client holds
   is still correct, and a key that ignores ?include or ?shape answers "unchanged" to a client asking
   a different question.
   Expose the CMS's own status through the same API (counts, review-queue totals, per-pack figures)
   from ONE database function, so a dashboard and the game cannot get different numbers.
   LOG EVERY REQUEST IN A WRAPPER around the whole handler, not per-branch: discovery probes, CORS
   preflight and error paths answer early, and those are exactly the requests you need when a client
   appears to do nothing. Record the phase, method, status, whether credentials were present, the
   user agent and the country (which tells the vendor's cloud from a browser). REDACT tokens, codes
   and verifiers to <redacted:N chars> and TEST that with real-shaped secrets — a log that
   accumulates credentials is a breach regardless of who can read it.
   TOKEN LIFETIMES: find out whether the client actually refreshes before choosing one. If it does
   not, a short expiry is a scheduled outage, not a boundary — make lifetimes long and make
   REVOCATION the control, re-checked on every request.
   MAKE THE VIEW STATE ITS OWN STATE. A permanent status line ("handshake sent", "NO HANDSHAKE after
   5s", "12 question(s)") is what turns a silent failure into a diagnosable one, and is the difference
   between one session and three. Have it NAME THE RESOURCE IT IS — one screenshot then tells you
   which view the host actually loaded, which you will need (see below).
   BUILD ONE VIEW, NOT ONE PER TOOL. The host picks ONE view per connector and does NOT honour
   per-tool _meta.ui.resourceUri: it will load the wrong resource for a tool and then send it
   nothing. Serve the same HTML from every ui:// URI and dispatch on the SHAPE of the payload that
   arrives. Two views also means two copies of the lifecycle code, which is a parity problem waiting
   to happen — assert in a test that the size-changed handling exists exactly once.
   TILES THAT POST INTO THE CHAT use \`ui/message\`, but the spec defines NO host capability for it and
   some hosts refuse it. Send it with an id, handle the reply, and time out on silence. Copy the text
   to the clipboard DURING the tap — synchronously, inside the gesture — not after a rejection
   arrives, because clipboard writes need a user gesture. One tap must always achieve something.
   LEVEL CONTROLS: build BOTH. A global bar that sets every question at once answers "how does this
   pack read at level 7?"; per-card tabs answer "is this one question sound all the way up?", which
   is how the same-length bug is felt. Show divergence rather than hiding it — mark a card that has
   been moved on its own, and report MIXED on the global bar instead of a value true for only some.
   THE INVARIANT: pm_review_approve must remain the ONLY route a QUESTION can take into a pack. Never
   add a tool that approves, publishes or edits a live question, or writes pm_questions directly.
   review_status is READ-ONLY and closes the feedback loop that a queue otherwise breaks: a
   contributor proposes and never finds out what happened. Report the CALLER's own submissions
   (awaiting / approved / rejected, plus how many were approved only AFTER the reviewer edited them),
   a per-pack breakdown, and the reviewer's reject_reason for recent rejections — that last part is
   what stops the same mistake being made again. Make visibility SHARED AND EQUAL: every contributor
   sees every other contributor's submissions, with attribution. Do NOT scope it per-caller unless
   contributors also have separate CMS logins — otherwise the filter is cosmetic (they can see it all
   in the CMS anyway) and it hides the rejection feedback that helps everyone.
   Pack tools are allowed because a pack is a CONTAINER, not content: a connector-created pack is
   EMPTY until the reviewer approves questions into it. NEVER add a pack DELETE tool.
   create_pack must mirror the CMS's own PackEditor + savePack convention exactly — the SAME slugify
   (lowercase, non-alphanumerics -> '-', trimmed) derived from the name, sort_order = count + 1, emoji
   default, and the pack-detail fields (purpose / focus_areas / style_approach / example_objectives).
   Add what the CMS form lacks: check the slug for collisions up front and validate the level against
   the real pm_levels rows. Create it as status='published' (the container is live in the CMS at once
   so the contributor can write into it; questions remain gated). update_pack patches ONLY supplied
   fields, must NEVER change the slug (the game keys on it), and should WARN rather than block when
   the level changes on a pack that already has questions. Log both to the activity table with
   actor='partner:<name>'.
   AUTH: OAuth 2.1 with PKCE — this is NOT optional and NOT ceremony. Claude's "Add custom connector"
   screen offers a URL and an OAuth client ID/secret and nothing else; there is no field for a bearer
   token, so a shared-secret header would never be sent. Implement /.well-known/oauth-protected-resource
   (RFC 9728), /.well-known/oauth-authorization-server (RFC 8414), POST /register (RFC 7591, dynamic
   client registration), GET+POST /authorize, POST /token. PKCE S256 mandatory, codes single-use and
   short-lived, and a 401 MUST carry WWW-Authenticate or the client never starts the flow.
   The partner's pmk_ token becomes the LOGIN CREDENTIAL on the sign-in page rather than a header.
   Store only a sha256 HASH; show the raw token ONCE. Put the token table under the same lockdown as
   the API keys (RLS on, ZERO policies). Tag every queued row \`partner:<name>\`.
   YOU ALSO NEED A DISCOVERY SHIM, or none of the above works. If the MCP server is hosted on a path
   prefix (e.g. a Supabase edge function at /functions/v1/mcp), it CANNOT serve the root
   /.well-known/* documents that Claude's discovery probes — every probe 404s and the connector shows
   "no tools available" with no sign-in screen. Put a tiny Worker on its own origin that serves both
   discovery documents at the ROOT (bare, path-suffixed and OIDC forms), proxies everything else to
   the unchanged server, rewrites the 401 WWW-Authenticate to its own discovery doc, and SERVES ITS
   OWN SIGN-IN PAGE submitted via fetch (a proxied login page arrives with the wrong content-type and
   its native form POST does nothing inside the OAuth window). The connector URL is the SHIM's /mcp.
   When transforming a proxied body, drop content-length/content-encoding/transfer-encoding.
   TEST IT THE WAY THE CLIENT DOES: a self-test that hard-codes the discovery URLs will pass while the
   connector is unusable. Start where the client starts, and instrument the server to see what it
   actually receives.
   The validator in the MCP server is a FOURTH copy — it must stay byte-identical to core.jsx,
   content-api and generate-questions.
   DEPLOYMENT: wire edge-function deploys into CI from day one. Keep the function source in the repo
   AND give the CI a provider access token so a workflow can deploy it. If you instead deploy by
   pasting file contents into a tool call, you WILL eventually paste something truncated over a
   working function — it has happened here — and the repo will silently drift from what is live.
   Whatever the method: after deploying, fetch the deployed copy back and compare, then exercise the
   changed tool over the wire. A successful deploy call is not evidence the tool works.
7. **Activity log:** every mutation recorded (who/what/when) via pm_log.
8. **Developer Notes page:** hardcoded architecture doc + CLAUDE.md + this build prompt,
   each viewable with copy + download, plus an editable scratchpad saved to pm_dev_notes.
   These docs MUST be kept in sync with the app on every subsequent change.
8b. **RESPONSIVE — get this right or the app is broken on a phone.** Decide the DEVICE CLASS on the
   SHORT side of the screen for touch devices (min(w,h)) and on live width only for a resizable
   desktop window. Keying off innerWidth alone is the classic bug: a phone in landscape is 667–932px,
   so it gets treated as a tablet and the whole navigation swaps on rotation. Phone <640 / tablet
   <1024 / desktop. Have the JS stamp the class onto <html> (pm-phone/pm-tablet/pm-desktop/pm-coarse/
   pm-landscape) and make the CSS key off THAT — never run parallel width media queries, they drift.
   ACCESSIBILITY IS NOT OPTIONAL: every form control needs a programmatic label. A control wrapped in
   a <label> gets it implicitly — but a <div>+<span> that merely LOOKS like a label gives nothing. Bare
   filter dropdowns need an explicit aria-label. Icon-only buttons (colour swatches, close buttons)
   need aria-label. Verify by rendering into a real DOM and checking el.labels, not by reading the code.
   CAP THE CONTENT, NOT JUST THE CONTAINER: a max-width on the page wrapper is not enough. A single
   form field or paragraph inside it will fill the whole width — an input the width of the page and a
   line of text ~150 characters long, with dead space beside it. Give forms a readable cap (~860px),
   panels ~720px, and prose ~680px (~75 chars/line). A landscape phone is the worst case: phone
   chrome but ~800px of width, so the portrait single-column rules stretch one field to 812px — give
   landscape two columns.
   Non-negotiable mobile foundations: overflow-x hidden on html/body (one stubborn element shifts the
   whole page); safe-area padding left/right if you use viewport-fit=cover, or landscape content slides
   under the notch; 16px inputs on touch (anything smaller makes iOS auto-zoom on focus); 40px minimum
   hit targets; modals as bottom sheets on phone; single-column forms on phone; overflow-wrap for long
   slugs. Three nav patterns is the maximum: bottom bar + drawer (phone), icon rail (tablet), full
   sidebar (desktop) — and every one must be DERIVED from the nav list so a new page cannot be
   stranded.
9. **Levels (progression structure, EXPANDABLE 1–100):** a pm_levels table defining the levels
   (ship with 1–10; support adding more above the top, CHECK ceiling 100 on pm_levels.level AND
   pm_questions.level AND pm_question_levels.level). Each level has a name, tagline, letter-hiding
   rule, word-length/complexity rule, emotional theme, age hint, hidden_mode (hide some letters vs
   the whole word), letters_hidden_default, letter_position, letter_grouping, color, AND vocabulary
   rules — min_word_len, max_word_len, allow_multiword, vocab_rule (free text) — that shape which
   ANSWER words the level uses (they drive the generator + display intent; the masking engine
   ignores them; CHECK min<=max when both set). The LEVEL NUMBER itself is the difficulty — do NOT
   add a separate basic/advanced tier. Packs carry a default \`level\`; questions have a nullable
   \`level\` override (null = inherit the pack). Build a dedicated Levels page to view/edit each
   definition AND to ADD a new level above the current top (button "Add level N", pre-filled from
   the current top level's rules) and DELETE the top level (highest only, to keep the ladder
   contiguous; guard with a confirm noting pinned questions/overrides should be moved first). Each
   level card must make the rule LEGIBLE: a plain-English summary derived from the actual mechanical
   fields AND a live "Looks like" sample word masked through the real maskWord engine, plus
   word-band / multi-word badges. CRUCIAL INVARIANT: adding a level row is sufficient for it to
   render everywhere (CMS previews + BOTH feeds) — nothing is pre-materialized; the shared engine
   derives every level on demand from pm_levels, so a new level instantly applies to every question.
   Never infer a level's mode from its number (no "level>=7 ⇒ whole word" shortcuts anywhere,
   including preview fallbacks). Also a level chip on pack cards and question rows, and level
   selectors in the pack and question editors. The question-search RPC returns the effective level
   (coalesce question→pack). Add a Level filter to the question bank, the in-pack list, and the pack
   library. GENERATING questions for a level: the AI generator prompt must include each target
   level's word-length band, multi-word allowance, and vocab_rule (and a reminder both answers stay
   in-band yet differ in length so only one fits). DERIVING for existing content: a "Derive level"
   pack action materializes editable pm_question_levels rows for a chosen level across all active
   questions (apply that level's masking rule to each word; skip-or-overwrite existing rows; chunk
   BOTH the existence-check query — ids in in.(...) at ~150/request to stay under URL limits — AND
   the upserts at ~200/request), for when concrete per-question rows are wanted to hand-tune. IMPORTANT
   derive nuance: pm_question_levels has NO hidden_mode column, so for a WORD-mode level leave
   letters_hidden/position/grouping null (the level already forces whole-word; pinning a number would
   freeze to the word's current length and break if the word is later edited); only for a LETTERS-mode
   level pin the computed letters_hidden/position/grouping. DELETING a level: there is no FK from
   pm_packs.level / pm_questions.level / pm_question_levels.level to pm_levels, so a BEFORE DELETE
   trigger on pm_levels MUST fix ALL THREE: reset PACKS pinned to the level to the highest REMAINING
   level (a pack's level can't be null — it's the question fallback), un-pin QUESTIONS at that level
   (set level = null), and delete OVERRIDE rows at that level, or you leave stale pointers. Guard the
   delete UI so only the highest level is removable and disable the "Add level" control at the 100
   ceiling. STATE: the Levels page must use the app's shared levels state (the same realtime-backed
   source the pack/generator views use) rather than its own fetch, so an edit on one device refreshes
   every view consistently. Validate min<=max word length client-side before the DB CHECK. The CMS
   "edited" indicator must treat a lone
   enabled=true override as a no-op (not edited).
10. **Blank-shape control:** each level (and per-question override) also controls WHERE the
   missing letters sit (letter_position: start/middle/end/random) and whether multiple hidden
   letters are grouped or spread (letter_grouping). A single maskWord(word, letters, position,
   grouping) generates the actual blank and MUST be the one source of truth used by every
   preview, row, PlayMode, and the export/feed. "random" must be DETERMINISTIC (seed from the
   word) so it's stable across renders and matches the game. Every preview ("how the child
   sees it") reflects the real shape.
11. **Questions are multi-level concepts:** every question auto-renders every level (one per pm_levels row) — the
   same question at each level's blank difficulty (buildLevelVariants derives them from the
   question + level rules; no row duplication). The question bank keeps flat rows with a
   "Levels" expand toggle revealing all 10 variants. Any individual level can be edited
   (override sentence/word/letters/position/grouping, or disabled for that concept), stored in
   a pm_question_levels table (a row exists only where edited; absent = auto). A Reset returns
   a level to auto. Cloning a pack must copy level data + these overrides.
12. **Export must carry levels, in JSON and XML:** the transform engine's field mapper must
   expose level, effective_level, letter_position, letter_grouping. A profile flag
   \`expand_levels\` attaches a \`levels\` array to each question — for every level: the resolved
   sentence, the blank shape, an explicit \`target\` object (the guess word: word, altWord,
   blankShape, wholeWord, lettersHidden, position, grouping) so the game never parses the
   sentence, and a \`frames\` map (token -> resolved word). Questions expose BOTH a raw
   \`template\` (with {tokens}) and a resolved \`base_sentence\`. An optional flag
   \`include_frames\` attaches the raw frame config so the game can vary swappable words itself.
   Provide a ready-made "Full game export (with levels)" starter profile. Offer BOTH JSON and
   XML output (a toXml serializer with sane singular tags + escaping); the pull-feed accepts
   ?format=xml. The client engine and the edge function must stay byte-identical (maskWord,
   resolveSlots, resolveFrameMap, buildLevelVariants, toXml, the expand logic) — hard invariant.
13. **Structured pack descriptions:** each pack has purpose, focus_areas, style_approach,
   and example_objectives (beyond the short card blurb). Show them as an "About this pack"
   panel on the pack page, edit them in the pack editor, and expose them in the field mapper
   so they can be exported to the game. Offer an AI "draft" button (via a server-side edge
   function proxying Anthropic) that generates a first draft grounded in the pack's name,
   theme, and words, which the user then edits. Surface the purpose at a glance on the Library
   pack cards too — reveal Purpose + Focus areas on hover (desktop) or via an ⓘ toggle (touch),
   without opening the pack; keep the card compact by default.
14. **Live sync (realtime):** open sessions across devices/browsers must update automatically
   when anyone edits data — no manual refresh, so simultaneous editors don't work off stale
   views or duplicate effort. Connect to Supabase Realtime (a lean websocket client is fine;
   no SDK required) and subscribe to postgres_changes on the content tables; on a change,
   debounce and reload the affected lists (pack overview, the open pack's question list, the
   global question search, levels). Show a "Live/Offline" status badge in the header, and
   auto-reconnect (and re-subscribe) when the tab regains focus. Enable the Realtime
   publication on those tables server-side.
15. **Frame-word variations:** the sentence template may contain swappable {token} words other
   than {blank} (which stays the word the child guesses). Store a \`frame_slots\` jsonb on the
   question: per token, a \`pool\` of alternatives + an optional \`byLevel\` pin map. Render per
   level: a pinned word wins, else a DETERMINISTIC seeded pick from the pool (stable + identical
   client/edge), else the bare token. This lets levels 7–10 differ even when the blank is a
   whole word (e.g. "…things get {hard}" → difficult/stressful/challenging across levels). The
   question editor auto-detects {tokens} and offers a pool editor + per-level pin grid. Keep
   the resolver byte-identical between the client engine and the game-feed edge function.
16. **Content Generator (AI prompt builder):** a page that assembles a ready-to-paste prompt
   for an external AI tool to author a batch of questions in the app's format. The user picks a
   pack (which pre-fills themes from the pack's focus/purpose, all editable), selects which
   levels to target, describes themes, sets a count, chooses the output format each time (an
   import-ready JSON, a simple pipe format, or a review table), and optionally toggles
   frame-word instructions on. The generated prompt must teach the CBMT philosophy, the
   {blank}-target rule, and — critically — the SPELLING-PUZZLE rule for the two words: both must
   be genuinely positive, but only the primary spells into the revealed letters; the alternate
   is a positive word that must NOT fit the blank's letter pattern. The reliable way to guarantee
   that is to make the alternate a DIFFERENT LENGTH from the primary (a different-length word can
   never match the fixed blank shape at any level). It must NOT be a meaning test and the two
   words must NOT be near-synonyms that both fit — the letters decide. The prompt also teaches
   the chosen level context, the frame-word
   {token} system (when toggled), and end with the exact output shape plus a concrete example.
   It live-updates as controls change and offers one-click copy. The bulk importer must accept
   the same JSON shape (including frame_slots) so the generate → paste-into-AI → import loop is
   closed. The generator should also (a) offer a standalone, reusable "master context" document
   — the full CBMT background — with copy, plus a toggle to fold a compact version into the
   prompt; and (b) help avoid regenerating existing content: a toggle that loads the selected
   pack's questions and appends an "already covered — do not repeat" list (answer words +
   sentence signatures) to the prompt. As a second line of defense, the bulk importer must flag
   duplicates against the pack's existing questions — exact (same normalized sentence + answer,
   punctuation-insensitive, and repeats within the pasted batch) vs similar (same sentence or
   same answer word) — defaulting exact to skip and similar to keep-but-flagged, with a per-row
   skip/keep control so the user decides.

## UX / cross-cutting
- Dark mode (light/dark/system, persisted, CSS variables). Command palette (⌘/Ctrl-K):
  fuzzy nav/actions/theme/jump-to-pack. Styled confirm dialogs (no native confirm()).
  Focus trap + Escape on modals, ARIA dialog roles, visible focus rings. Toasts with
  actions, skeletons, empty/error states. URL-HASH ROUTING (encode the current section +
  open pack in location.hash; read it on load so a refresh restores the view and pack URLs
  are deep-linkable; a hashchange listener drives Back/Forward). Sync document.title to the view.
- **Accessibility:** every text color must meet WCAG AA against its background (don't use a
  grey lighter than ~4.5:1 for text). Inputs use the panel background (not hardcoded white,
  which breaks dark mode) with an explicit readable ::placeholder color so search fields are
  legible while typing.
- Responsive: sidebar (desktop) / icon rail (tablet) / bottom-tab bar (phone). Question
  rows are compact single-lines on desktop and content-first CARDS below desktop (sentence
  hero on top, meta+actions footer, checkbox in the corner). 16px inputs, bottom-sheet
  modals on phone, prefers-reduced-motion respected. A small BUILD STAMP (from a bumped
  CFG.build constant) sits in the sidebar footer so a stale cached build is obvious at a glance.

## Build & verify discipline
Edit modular files, not compiled output. Rebuild with the assemble + build-html scripts.
CRITICAL: the assemble step Babel-compiles the combined source — if it throws, it leaves the
OLD compiled file in place and the HTML builder happily wraps the stale bundle. \`node --check\`
on the compiled JS will still PASS (it's checking the old valid file), so it will NOT catch a
broken build. After every build you MUST confirm assemble printed its success summary AND that
the compiled output was freshly written (check its mtime, or grep for a string you just added,
or bump+grep the build stamp). Only then: confirm every JSX component/db call/RPC resolves;
parse each inline <script>; babel-parse the doc template literals to confirm they're balanced
(raw backticks inside a doc string must be escaped). Test DB (RPCs, RLS) against the live
project; test HTTP endpoints via pg_net → net._http_response; render components headless with
react-dom/server to catch runtime crashes. Deploy by pushing to main (Cloudflare auto-builds);
bump CFG.build each deploy. Verify empirically — never assert a capability works without
testing it.
`;
