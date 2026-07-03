# Positive Minds — Pack CMS

Content management system for the Positive Minds CBMT word-game pack library.
Single-file React 18 + Babel-standalone app backed by Supabase.

- **Database:** Supabase project `positive-minds-cms` (`tytrmjjucqijzcrbwjfm`)
- **Tables:** `pm_packs`, `pm_questions` (+ `pm_pack_overview` view)
- **App:** `index.html` — no build step, fully self-contained

---

## Deploy — Option B: Direct upload (fastest, ~30 seconds)

1. Go to the Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. Name the project `positive-minds-cms`
3. Drag in `index.html` (or the whole folder)
4. Click **Deploy** — you get a live `*.pages.dev` URL immediately

To update later: re-upload the file, or switch to Option A for auto-deploy.

---

## Deploy — Option A: GitHub → Cloudflare Pages (CI/CD, matches AQA/mbot)

1. Create a repo (e.g. `alcharles1980-design/positive-minds-cms`)
2. Add these files:
   - `index.html`
   - `.github/workflows/deploy.yml`  (rename `deploy.yml` and place it here)
3. In GitHub repo **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — a token with the **Cloudflare Pages: Edit** permission
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID
4. In the Cloudflare dashboard, create a Pages project named `positive-minds-cms`
   (first deploy can also create it automatically via wrangler)
5. Push to `main` — every push now auto-deploys.

---

## Security note (do this before sharing the URL widely)

The app currently writes to Supabase using the **public anon key** with permissive
RLS policies (`pm_packs_anon_write`, `pm_questions_anon_write`). That means anyone
with the URL can add/edit/delete content. Before this is truly public-facing:

- Add an auth/login gate (Supabase Auth)
- Drop the two `*_anon_write` policies so only authenticated users can write
- Keep the public-read policies so the game/parents can still browse published packs

The RLS is already structured for this — the published-only read path exists and stays.
