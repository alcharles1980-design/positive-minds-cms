# Option A Setup — GitHub → Cloudflare Pages (CI/CD)

Every push to `main` auto-builds and deploys. Matches your AQA/mbot pattern.

---

## Step 1 — Gather two Cloudflare values (only you can do this)

**A. Account ID**
- Cloudflare dashboard → Workers & Pages → (right sidebar) **Account ID** → copy.

**B. API Token** (scoped, not your global key)
- Cloudflare dashboard → My Profile → **API Tokens** → **Create Token**
- Use template **"Edit Cloudflare Workers"**, OR create a custom token with:
  - Permissions: **Account → Cloudflare Pages → Edit**
  - Account Resources: **Include → your account**
- Create, then **copy the token now** (shown once).

---

## Step 2 — Create the Pages project (one time)

- Workers & Pages → **Create** → **Pages** → **Connect to Git** is one option,
  but for this flow choose **"Direct Upload"** path just to reserve the name:
  create a project literally named `positive-minds-cms`.
- (Or skip — the first workflow run with wrangler will create it automatically.)

The project name **must** match `--project-name=positive-minds-cms` in the workflow.

---

## Step 3 — Push the repo to GitHub

From the folder that contains `index.html`:

```bash
git init
git add index.html README.md SETUP.md .github/workflows/deploy.yml
git commit -m "Positive Minds Pack CMS — initial deploy"
git branch -M main
git remote add origin https://github.com/alcharles1980-design/positive-minds-cms.git
git push -u origin main
```

(Create the empty `positive-minds-cms` repo on GitHub first, under the
`alcharles1980-design` account, so the remote exists.)

---

## Step 4 — Add the two secrets to GitHub

GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name             | Value                          |
|-------------------------|--------------------------------|
| `CLOUDFLARE_API_TOKEN`  | the token from Step 1B         |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from Step 1A    |

---

## Step 5 — Deploy

- The push in Step 3 already triggered the workflow. Check the **Actions** tab.
- If secrets were added after the first run, re-run the job (Actions → latest run →
  **Re-run all jobs**), or push any commit.
- On success you get a live `positive-minds-cms.pages.dev` URL
  (Cloudflare → Workers & Pages → positive-minds-cms).

---

## Updating later

Just edit `index.html` and push:

```bash
git add index.html && git commit -m "update" && git push
```

Cloudflare redeploys automatically in ~1 minute.

---

## ⚠️ Before you share the URL publicly

The app writes with the public anon key + permissive RLS — **anyone with the URL
can edit/delete content.** Add a Supabase Auth login gate and drop the
`*_anon_write` policies before handing the link to parents. Public read stays,
so browsing published packs still works. (Next task.)
