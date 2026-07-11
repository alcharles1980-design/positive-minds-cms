# Positive Minds — Content CMS

Content management system for **Positive Minds**, a children's CBMT (Cognitive Bias Modification
Therapy) word game for ages ~5–12. This repo holds the CMS (the admin web app) and the edge
functions that serve content to the game.

> **New here? Read this file, then open the app and go to the `Developer` page.** That page holds the
> three living documents — **Architecture**, **CLAUDE.md** (hard rules), and **Build Prompt** (enough
> to rebuild the whole app from scratch). They are updated with every change and are the authoritative
> reference. This README is the map; those are the territory.

---

## 1. What this is

A single-page admin app where you author **packs** of **questions**, organise them into **levels**,
generate content with **AI** (with mandatory human review), and **publish** to the game via a sync API.

**The game mechanic — read this or nothing else makes sense.** It is a **spelling** puzzle, not a
comprehension puzzle. A short first-person sentence appears with one word partly hidden:

```
I feel PR_UD when I try.     →   child picks between   PROUD   /   CALM
```

The child picks the word whose **spelling** fits the revealed letters and the blank shape. **Both
options are always positive** — never show a child a negative word about themselves. That is the
therapeutic core of CBMT.

**How the wrong option is guaranteed wrong:** the alternate must not be able to spell into the blank.
At the highest levels the *whole word* is hidden, so the only clue is its **length** — which means
**the alternate must be a different length from the answer**. If both are the same length the puzzle
has two correct answers and is broken. This is not theoretical: `BRIGHT/GENTLE` and `SURE/GLAD`
shipped broken. Both look fine to a human eye. The validator catches this now.

---

## 2. Live coordinates

| What | Where |
|---|---|
| **CMS (live app)** | Cloudflare Pages project `positive-minds-cms` |
| **Supabase project** | `tytrmjjucqijzcrbwjfm` → `https://tytrmjjucqijzcrbwjfm.supabase.co` |
| **Publishable (anon) key** | `sb_publishable_S16YFhxUtKsUYlUixYGW8g_t5nk28Ev` — safe in the browser; RLS enforces everything |
| **Repo** | `github.com/alcharles1980-design/positive-minds-cms` |
| **Admin login** | `admin@positiveminds.app` |

**Content API the game client calls:**

```
https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api
```

---

## 3. Repo layout

```
index.html              the entire CMS — self-contained, deployed as-is
pm_cms.jsx              readable combined source (for reference / diffing)
public/index.html       copy served by Cloudflare Pages
edge-functions/
  content-api.ts          sync API for the game client (public)
  generate-questions.ts   AI generation (auth-gated)
.github/workflows/
  deploy.yml              push to main → Cloudflare Pages
```

> **`index.html` is the OUTPUT, not the source.** The app is authored as modular `.jsx` files which are
> concatenated by `assemble.cjs`, compiled with Babel (`@babel/preset-react`, **classic** runtime), and
> wrapped by `build_html.cjs`. To change the app, see the **Build Prompt** on the Developer page — it
> specifies the entire app precisely enough to reconstruct it.

---

## 4. Deploying

**The CMS:** push to `main`. GitHub Actions stages `index.html` and publishes to Cloudflare Pages.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — needs *Account → Cloudflare Pages → Edit*
- `CLOUDFLARE_ACCOUNT_ID`

**Edge functions** (Supabase CLI):

```bash
supabase functions deploy content-api        --project-ref tytrmjjucqijzcrbwjfm --no-verify-jwt
supabase functions deploy generate-questions --project-ref tytrmjjucqijzcrbwjfm
```

`content-api` is public. `generate-questions` **must stay JWT-verified** so only a logged-in admin can
spend API credits.

**⚠️ The app is a PWA with an aggressive service worker.** After deploying you will often still see the
old build. Hard-refresh, clear site data, or use a private window. The sidebar shows a **build stamp**
(e.g. `2026.07.05-07`) — if it hasn't changed, you are looking at a cached build. **Bump `CFG.build` on
every deploy** so this stays detectable.

---

## 5. The three things that will bite you

1. **PostgREST silently caps at 1,000 rows.** Not an error — it just returns 1,000 and you never
   notice the rest are missing. Every query needs an explicit `limit`, or use the paginating helper.
2. **The masking engine exists in four places** (the app, `content-api`, `game-feed`,
   `generate-questions`) and they **must stay byte-identical**. If a blank renders differently in the
   CMS than in the game, the game is wrong. The same applies to the question **validator**.
3. **The service-worker cache.** Most "my change didn't deploy" reports are this.

---

## 6. Integrating a game client

The game pulls content from `content-api`. The short version:

```js
const BASE = 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api';

// 1. Cheap poll — has anything changed at all?
const manifest = await (await fetch(`${BASE}?manifest=1`)).json();
if (manifest.global_version === myStoredVersion) return;      // nothing to do

// 2. Pull only what changed since last time (plus what to delete)
const data = await (await fetch(`${BASE}?since=${myStoredVersion}`)).json();

for (const d of data.deletions ?? []) removeLocally(d.type, d.slug ?? d.id);
for (const pack of data.packs) upsertPackWithQuestions(pack); // wholesale replace per pack

myStoredVersion = data.meta.global_version;
```

Each question arrives with its **variations already rendered, one per level** — the sentence, the blank
shape (`BRA_E`), and the two options. **The client does no masking of its own.**

**Do not assume 10 levels.** Render however many the feed reports — levels are data and can be added.

Full endpoint reference, response shapes, ETag/304 caching, and a complete worked sync implementation
are in the **Architecture** doc → *Integration Guide*, on the app's Developer page.

---

## 7. Known outstanding items

- The GitHub token used by local tooling should be **revoked and regenerated**.
- The admin password is weak; set a strong one.
- **No AI provider key is configured** — nothing can generate until one is added in **AI Settings**.
- `pm_deletions` and `pm_ai_usage` grow unbounded (pg_cron isn't available on this project to prune
  them). Harmless at current volumes; worth clearing manually one day.
