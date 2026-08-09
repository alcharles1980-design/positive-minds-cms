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

**REPETITION CHECKS — five distinct cases, because they mean different things:**
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
not a Supabase JWT). Speaks JSON-RPC 2.0 over Streamable HTTP. Seven tools, deliberately narrow:
| Tool | Reads | Writes |
|---|---|---|
| \`list_packs\` | packs (published + draft) w/ per-pack stats, level rules, the brief | — |
| \`get_pack_content\` | existing questions, words already used, pack statistics | — |
| \`check_questions\` | — | — (pure validation, saves nothing) |
| \`propose_questions\` | — | **the review queue ONLY** |
| \`create_pack\` | — | a new pack row (published immediately) |
| \`update_pack\` | — | an existing pack's details (never its slug) |
| \`review_status\` | ALL contributors' queue rows + reject reasons | — |

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
4a. **Questions are never pre-rendered — level rules propagate live.** A question row stores only
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
4b. **AI content NEVER bypasses human review.** generate-questions writes ONLY to pm_review_queue.
   The single path into pm_questions is the pm_review_approve RPC, which requires an explicit human
   decision. Never add a "publish straight through" path, an auto-approve, or a direct insert from a
   generator - a child must never see a question no person approved.
4d. **GitHub does NOT deploy Supabase. The two are decoupled.** Pushing to the repo updates ONLY the
   Cloudflare-hosted front-end. The edge functions in edge-functions/*.ts are a SAVED COPY — committing
   them does NOT deploy them. A function changes on Supabase only when someone explicitly deploys it
   (MCP \`deploy_edge_function\`, or CLI \`supabase functions deploy <name> --project-ref
   tytrmjjucqijzcrbwjfm\`; add --no-verify-jwt for content-api and game-feed). SAME for DB/RLS/RPC —
   apply via migration/SQL, never via a push. When you edit an edge function: commit the source AND
   deploy it in the same unit of work, and say so in the commit — otherwise the repo and the live
   backend silently drift (this is exactly how game-feed and pack-describe ran live for weeks with no
   source in the repo). Before editing any edge function, diff the repo copy against the deployed one
   (\`get_edge_function\`); if they differ, the DEPLOYED version is source of truth until reconciled.
   ACCESS: a contributor with only GitHub access can change the website and nothing else. To touch the
   backend they need access to the Supabase PROJECT — invited to the Supabase org (preferred) or a
   personal access token — then the Supabase MCP on their own Claude account inherits that access. The
   MCP connector is only the pipe; authorization lives on Supabase, not on the Claude side. Full
   onboarding steps: Architecture §0.4 and CONTRIBUTING.md.
4c. **API keys must never be readable by the browser.** pm_ai_config deliberately has NO RLS select
   policy for anon OR authenticated. The CMS is a browser app with a shared admin login, so anything
   the client can SELECT is effectively public to anyone with that login (or any XSS). Keys are
   written via pm_ai_set_key and read ONLY server-side by the edge function (service role). The UI
   reads pm_ai_status, which returns a masked hint and NEVER the key. Never add a select policy to
   pm_ai_config, never return api_key from an RPC, never send a key to the client "just to show it".
4t. **Settings configure; content pages create.** Generation was buried inside AI Settings as a
   stripped-down panel — which put it in two places at once, and made the API path a poor relation of
   the manual one (no themes, no frame words). One page, one set of options, two ways to run it. How
   you run something must never change what you're allowed to ask for. And never show a control that
   does nothing in the current mode: hide it.
4x. **Ask "how will someone ACTUALLY use this?" BEFORE building the auth model.** I built the MCP
   connector with a shared-secret bearer token, because that is how most APIs work. Claude's connector
   screen has no field for one — it does OAuth or nothing — so the whole auth model was unusable, and
   I only found out when Albert asked how partners connect. Check the actual UI the user will face
   before designing for it.
4y. **"It returned 200" is not "it works".** All three base-URL bugs in the OAuth server (http instead
   of https, wrong path, Supabase's INTERNAL hostname) returned a perfectly healthy 200 while telling
   Claude to go somewhere that did not exist. Read what the response SAYS, not just its status code.
4z. **A self-test that hard-codes what the CLIENT discovers is not a test.** The MCP self-test drove
   the OAuth flow by calling /register, /authorize and /token at URLs it already knew — so it passed,
   green, repeatedly, while the connector was completely unusable from a real Claude client. The step
   it skipped (root /.well-known discovery) was the ONLY step that was broken. When a client does
   discovery, routing or negotiation on its own, the test must start where the CLIENT starts, or it
   proves nothing about the path that matters. When you cannot drive the real client, INSTRUMENT the
   server and read what it actually receives: adding request logging to the shim is what finally
   located this, and each stage of an OAuth flow leaves a row (pm_oauth_clients → codes → tokens),
   so a count of those tables tells you exactly how far the real client got.
4w. **The MCP connector must never gain a write path to LIVE QUESTIONS.** The invariant is not "few
   tools" — it is that pm_review_approve stays the ONLY route a question can take into a pack.
   propose_questions writes to the queue and nowhere else. Never add a tool that approves, publishes
   or edits a live question, and never let one write pm_questions directly.
   REVISED Aug 2026: create_pack and update_pack DO write, and that is acceptable, because a pack is a
   CONTAINER, not content — a connector-created pack is EMPTY until Albert approves questions into it.
   review_status also exists but is READ-ONLY. Its visibility is deliberately SHARED (all
   partners see all submissions) — matching the shared-admin model rather than inventing a boundary
   the CMS itself does not enforce.
   The blast radius is still "a queue full of things Albert rejects", plus pack names he can rename.
   Deliberately still absent: DELETE for packs (destructive — it takes the questions with it), and
   anything touching a question's live status. If a partner needs those, they belong in the CMS.
   The validator in the MCP server is a FOURTH copy — it must stay byte-identical to the other three.
4q. **EVERY content-entry path goes through the review queue.** Not just AI generation — imports
   too. There were two ways in and only one was gated, and the ungated one (Bulk Import) is how
   BRIGHT/GENTLE reached children. Do NOT try to detect whether content "came from AI": you usually
   cannot tell, and a wrong guess means unchecked content reaches a child. The ONLY path into
   pm_questions is pm_review_approve. If you add a new way to create content, it goes through the gate
   or it does not ship. (The one deliberate exception is whole-pack file RESTORE, which lands as a
   DRAFT and is validated with a loud warning — but it must never be published unchecked.)
4p. **The lint must check the defect that actually breaks the game.** pm_lint checked four cosmetic
   things and missed the ONE that harms a child: an alternate the same length as the answer. Two
   broken questions sat LIVE in a published pack while the health check said all was well. Any check
   the AI validator performs on new content, the lint must perform on existing content — above all
   \`ambiguous\`. A health page that cannot see the worst defect is worse than none: it is false comfort.
4u. **Read the LIVE FEED, not just the code.** Two real content defects (a reversed pair, an
   overused distractor) were invisible to every automated check AND to reading the pages — they only
   showed up when I looked at what the GAME actually receives. The checks were all grouped by ANSWER,
   so a repeated PAIR and a repeated ALTERNATE were structurally invisible. Periodically pull the real
   feed and look at it as a child would.
4v. **If the lint catches it, the validator must too.** They were inconsistent: the Health lint flagged
   reversed pairs, but validateQuestion did not — so the AI could generate one and the review queue
   would show it as clean. Any check that exists for EXISTING content must exist for NEW content, in
   both copies of the validator.
4r. **READ the page, don't just inspect it.** A page can be structurally perfect and still say
   nothing useful. The Health page showed "(untitled)" on every row for weeks — valid markup, correct
   layout, every automated check green — because the UI read \`d.label\`/\`d.issue\` while the RPC returned
   \`answer\`/\`code\`. No structural test can catch that. Render the page to text and READ it.
4s. **An empty label is worse than no label.** A control wrapped in a text-less \`<label>\` counts as
   "associated" and will pass a naive check, while announcing an unnamed field to a screen reader.
   Always require the label to have TEXT.
4n. **Inspect the RESULT, not the source.** Grepping code for suspicious patterns is not a UI audit.
   Render into a real DOM with the real evaluated stylesheet and walk the computed styles. And VALIDATE
   YOUR ORACLE FIRST: extracting CSS by regex left \`\${...}\` placeholders that jsdom silently rejected,
   so every computed style was a lie; and a naive label check flagged every correctly-built field,
   because a control wrapped in a <label> IS associated (implicit association). A broken oracle is worse
   than none.
4o. **Never regex-edit JSX.** A careless pattern inserted attributes inside arrow functions
   (\`onChange={(e) = aria-label="x"> setFoo(...)}\`) across 12 lines. Only the build caught it. Use
   targeted, structure-aware edits.
4m. **Cap the CONTENT, not just the container.** A max-width on the page wrapper does nothing for a
   lone form field or a paragraph inside it — they will happily fill all 1080px, leaving a giant
   input marooned in white space and body copy ~150 characters wide. Every form gets a readable cap
   (\`.pm-form-2\` 860px), every panel \`.pm-readable\` (720px), every paragraph \`.pm-prose\` (680px).
   This is the difference between "responsive" and "actually looks designed".
4l. **Device class is decided on the SHORT side, never on raw width.** A phone in landscape is
   667–932px wide — wider than many tablets. Keying layout off innerWidth alone made rotating a phone
   swap the entire navigation and drop every phone-specific rule (including the 16px inputs that stop
   iOS auto-zooming). Decide on min(w,h) for touch devices; only a resizable desktop window should key
   off live width. And there must be ONE breakpoint system: the JS stamps a class on <html> and the
   CSS keys off it. Never reintroduce parallel width media queries — they WILL drift.
4j. **Config must never lie.** If a flag exists and is reported to the UI, something must ENFORCE
   it. \`pm_ai_config.enabled\` sat unchecked for a while: you could "disable" a provider and it would
   still be used. Either enforce a flag or delete it — dead config that lies is worse than none.
4k. **"Null means don't change" needs an escape hatch for every field.** The setter treats null as
   "leave it alone", which is right for a key you can't read back — but it means an empty value cannot
   be expressed. Temperature/top_p have explicit clear flags; the system prompt uses an empty string.
   Any new nullable setting needs one or the other, or users will be unable to UNSET it and the UI
   will silently lie.
4h. **NEVER send temperature/top_p unconditionally.** Anthropic returns 400 for them on Opus 4.7+;
   OpenAI rejects them on GPT-5 reasoning models. They must be nullable and OMITTED from the request
   body when unset. A "sensible default" here breaks generation entirely on those models. Because null
   means "don't change" in the setter, keep the explicit clear flags so a value can actually be unset.
4i. **A params-only save must never wipe the API key.** The key can never be read back, so the setter
   takes a null key to mean "keep the existing one". Never add an overload of pm_ai_set_key — two
   signatures make the call ambiguous and every save fails.
4f. **Anything that spends money must be logged and rate-limited.** AI generation is the only
   operation in this app with a real cost. Every provider call (generate/repair/test, success AND
   failure) goes to pm_ai_usage with token counts and the actor; the edge fn checks pm_ai_rate_check
   BEFORE calling a provider. Never add a new paid call without both. Logging must be best-effort so
   it can't break the request.
4g. **Mobile nav must be DERIVED from NAV, never hardcoded.** The phone drawer once had a hardcoded
   list, which left three whole pages (AI Review, AI Settings, Generator) unreachable on a phone. It
   now renders NAV.filter(n => !NAV_PHONE.includes(n.id)). Never hardcode that list again.
4e. **De-dup context must include the review queue and the current batch.** Comparing only against
   live questions is not enough: two generate runs before a review will duplicate each other, and a
   question you REJECTED will be regenerated. Always seed the validator's \`existing\` with live
   questions + pending + rejected queue rows, and validate a batch CUMULATIVELY (each item sees the
   ones before it) so a word repeated within one batch is caught. Also: an answer WORD reused in a
   different sentence is a real defect (a 10-20 question pack teaching BRAVE twice) - never collapse
   duplicate detection back to "same sentence AND same answer".
4d. **validateQuestion is a PARITY INVARIANT** (like maskWord). The copy in core.jsx and the copy in
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
- pm_activity (audit log), pm_export_profiles(spec jsonb, is_builtin), pm_sync_log,
  pm_sync_targets(config jsonb), pm_dev_notes (singleton id=1)
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
   SEVEN TOOLS: list_packs (packs + level rules + THE BRIEF so the rules are always in context, each
   pack carrying stats: live_questions / distinct_answer_words / awaiting_review, and INCLUDING draft
   packs with their status), get_pack_content (existing questions + words already taken + a statistics
   summary), check_questions (validate drafts, SAVE NOTHING — this is what lets Claude fix its own
   mistakes before proposing), propose_questions (writes to the REVIEW QUEUE ONLY), create_pack and
   update_pack, and review_status.
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
