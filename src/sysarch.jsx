// System Architecture — an at-a-glance reference of the three services this project runs on,
// with the live links, IDs, and dashboards for each. Reference-only page (no writes).
//
// SECURITY: this page shows IDENTIFIERS and DASHBOARD LINKS only — never secrets. The CMS is a
// shared-admin browser app, so anything rendered here is visible to anyone with the admin login.
// IDs and dashboard URLs are safe (they still require separate authentication to actually use);
// credentials (service-role key, Cloudflare API token, DB password, provider API keys) must NEVER
// be placed on this page. They live only in GitHub Actions secrets and each service's own console.

// A single copyable coordinate row.
function ArchRow({ label, value, href, mono = true, hint }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!value) return;
    navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const missing = !value;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: S.md, padding: S.md + "px 0", borderBottom: "1px solid " + C.lineSoft }}>
      <div style={{ flex: "0 0 148px", fontSize: 12.5, fontWeight: 700, color: C.sub, paddingTop: 2 }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {missing ? (
          <span style={{ fontSize: 13.5, color: C.warnInk, background: C.warnSoft, padding: "3px 9px", borderRadius: R.sm, fontWeight: 600 }}>
            ⚠ fill this in
          </span>
        ) : href ? (
          <a href={href} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: mono ? "ui-monospace,Menlo,monospace" : "inherit", fontSize: 13.5, color: C.brand, wordBreak: "break-all", textDecoration: "none", fontWeight: 600 }}>
            {value}
          </a>
        ) : (
          <span style={{ fontFamily: mono ? "ui-monospace,Menlo,monospace" : "inherit", fontSize: 13.5, color: C.ink2, wordBreak: "break-all" }}>{value}</span>
        )}
        {hint && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>{hint}</div>}
      </div>
      {!missing && (
        <button onClick={copy} title="Copy"
          style={{ flex: "0 0 auto", background: copied ? C.goodSoft : C.bgDeep, border: "1px solid " + C.line, borderRadius: R.sm, color: copied ? C.goodInk : C.sub, fontSize: 11.5, fontWeight: 700, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit" }}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

function ArchCard({ icon, title, accent, tagline, children }) {
  return (
    <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden", marginBottom: S.lg }}>
      <div style={{ display: "flex", alignItems: "center", gap: S.md, padding: S.lg, borderBottom: "1px solid " + C.line, background: accent }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: C.ink, letterSpacing: -0.2 }}>{title}</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>{tagline}</div>
        </div>
      </div>
      <div style={{ padding: "2px " + S.lg + "px " + S.md + "px" }}>{children}</div>
    </div>
  );
}

function SystemArchitectureView() {
  const SB_REF = "tytrmjjucqijzcrbwjfm";
  const GH = "https://github.com/alcharles1980-design/positive-minds-cms";
  const CF_URL = "https://positive-minds-cms.alcharles1980.workers.dev";
  const CF_WORKER_ID = "95a06f3cafaa40908af725ab5347695e";
  const CF_ACCOUNT_ID = "bdb27846cbf6226edde4fa0f6d530ffa";  // Cloudflare dashboard → Workers & Pages → Account ID (also the CLOUDFLARE_ACCOUNT_ID GH Actions secret)
  const SB_URL = "https://" + SB_REF + ".supabase.co";
  const SB_DASH = "https://supabase.com/dashboard/project/" + SB_REF;
  const SB_DB_HOST = "db." + SB_REF + ".supabase.co";
  const SB_FUNCS = SB_URL + "/functions/v1";

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>System architecture</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>
          The three services this project runs on, with their live links and IDs. GitHub holds the source and deploys the
          front-end; Cloudflare serves the site; Supabase is the backend. GitHub and Supabase are decoupled — a push never
          touches the backend.
        </p>
      </div>

      {/* how they fit together */}
      <div style={{ background: C.brandSoft, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.xl }}>
        <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.7 }}>
          <strong style={{ color: C.brandInk }}>Front-end:</strong> edit <code>src/</code> → build → <code>git push</code> → GitHub Actions → Cloudflare updates the live site.<br />
          <strong style={{ color: C.brandInk }}>Backend:</strong> the database, auth, and edge functions live in Supabase and are deployed manually (MCP or CLI) — <em>GitHub never deploys them</em>.
        </div>
      </div>

      <ArchCard icon="⎇" title="GitHub" accent={C.bgDeep} tagline="Source of truth · deploy trigger for the front-end">
        <ArchRow label="Repository" value={GH} href={GH} />
        <ArchRow label="Owner / account" value="alcharles1980-design" mono={false} />
        <ArchRow label="Default branch" value="main" hint="Push here → GitHub Actions → Cloudflare deploy." />
      </ArchCard>

      <ArchCard icon="☁" title="Cloudflare" accent={C.infoSoft} tagline="Serves the CMS website (the static index.html)">
        <ArchRow label="Live site" value={CF_URL} href={CF_URL} hint="This is where the CMS loads." />
        <ArchRow label="Dashboard" value="Workers & Pages → positive-minds-cms" href="https://dash.cloudflare.com" mono={false} />
        <ArchRow label="Project name" value="positive-minds-cms" mono={false} />
        <ArchRow label="Worker ID" value={CF_WORKER_ID} />
        <ArchRow label="Account ID" value={CF_ACCOUNT_ID} hint="Dashboard → Workers & Pages → right sidebar → Account ID. Also stored as the CLOUDFLARE_ACCOUNT_ID GitHub Actions secret." />
      </ArchCard>

      <ArchCard icon="◆" title="Supabase" accent={C.goodSoft} tagline="The entire backend — Postgres, auth, RLS, edge functions">
        <ArchRow label="Project" value="positive-minds-cms" mono={false} />
        <ArchRow label="Project ID (ref)" value={SB_REF} />
        <ArchRow label="Dashboard" value={SB_DASH} href={SB_DASH} />
        <ArchRow label="API URL" value={SB_URL} href={SB_URL} />
        <ArchRow label="Database host" value={SB_DB_HOST} hint="Region us-east-1 · Postgres 17. Connecting still requires the DB credentials (not shown here)." />
        <ArchRow label="Edge functions" value={SB_FUNCS} href={SB_FUNCS} hint="content-api · generate-questions · mcp · game-feed · pack-describe" />
        <ArchRow label="Content API (game)" value={SB_FUNCS + "/content-api"} href={SB_FUNCS + "/content-api"} hint="The endpoint the game client pulls from." />
      </ArchCard>

      <div style={{ background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.5, color: C.warnInk, lineHeight: 1.65 }}>
        <strong>No secrets on this page.</strong> These are identifiers and dashboard links only — they still require each
        service's own login to use. Credentials (Supabase service-role key, Cloudflare API token, database password, AI
        provider keys) are deliberately excluded and live only in GitHub Actions secrets and each service's console.
      </div>
    </div>
  );
}
