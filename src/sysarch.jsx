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

// Per-service "how to get access and connect" block, rendered inside a card below its coordinates.
function AccessNote({ children }) {
  return (
    <div style={{ marginTop: S.md, background: C.bgDeep, border: "1px solid " + C.lineSoft, borderRadius: R.md, padding: S.md + "px " + S.lg + "px" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: C.brandInk, marginBottom: 6 }}>🔑 Access &amp; connect</div>
      <div className="pm-prose" style={{ fontSize: 12.8, color: C.ink2, lineHeight: 1.65 }}>{children}</div>
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

      {/* getting set up */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.xl }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Getting set up as a contributor</div>
        <div className="pm-prose" style={{ fontSize: 12.8, color: C.sub, marginBottom: S.md, lineHeight: 1.6 }}>
          Three grants, one per service. Each service card below has the full <strong>Access &amp; connect</strong> steps.
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: C.ink2, lineHeight: 1.75 }}>
          <li><strong>GitHub</strong> — be added as a <strong>collaborator with Write</strong> access. Lets you do all front-end work (edit, push, auto-deploy).</li>
          <li><strong>Supabase</strong> — accept an <strong>invitation to the organization</strong>. Then connect the Supabase MCP with your own login to work on the backend (DB + edge functions).</li>
          <li><strong>Cloudflare</strong> — <strong>usually nothing</strong>. The front-end deploys automatically via GitHub; you only need Cloudflare access to manage hosting directly.</li>
        </ol>
        <div className="pm-prose" style={{ fontSize: 12.5, color: C.faint, marginTop: S.md, lineHeight: 1.6 }}>
          Then read <code>CONTRIBUTING.md</code> in the repo (the build/test/deploy loop) and the app's Developer page
          (Architecture §0.4 + CLAUDE.md rule 4d) for the full workflow. No shared tokens — everyone uses their own accounts.
        </div>
      </div>

      <ArchCard icon="⎇" title="GitHub" accent={C.bgDeep} tagline="Source of truth · deploy trigger for the front-end">
        <ArchRow label="Repository" value={GH} href={GH} />
        <ArchRow label="Owner / account" value="alcharles1980-design" mono={false} />
        <ArchRow label="Default branch" value="main" hint="Push here → GitHub Actions → Cloudflare deploy." />
        <AccessNote>
          You need to be a <strong>repository collaborator with Write access</strong>. The owner adds you at
          <strong> repo → Settings → Collaborators → Add people</strong> (using your GitHub username) and grants
          <strong> Write</strong>. Once added: clone the repo, then follow <code>CONTRIBUTING.md</code> — edit
          <code> src/</code>, build, and <code>git push</code> to <code>main</code>. A push auto-deploys the
          front-end. GitHub access alone lets you change only the website — the backend is separate (see Supabase).
        </AccessNote>
      </ArchCard>

      <ArchCard icon="☁" title="Cloudflare" accent={C.infoSoft} tagline="Serves the CMS website (the static index.html)">
        <ArchRow label="Live site" value={CF_URL} href={CF_URL} hint="This is where the CMS loads." />
        <ArchRow label="Dashboard" value="Workers & Pages → positive-minds-cms" href="https://dash.cloudflare.com" mono={false} />
        <ArchRow label="Project name" value="positive-minds-cms" mono={false} />
        <ArchRow label="Worker ID" value={CF_WORKER_ID} />
        <ArchRow label="Account ID" value={CF_ACCOUNT_ID} hint="Dashboard → Workers & Pages → right sidebar → Account ID. Also stored as the CLOUDFLARE_ACCOUNT_ID GitHub Actions secret." />
        <AccessNote>
          <strong>Usually no access needed.</strong> The site deploys automatically through GitHub Actions using the
          owner's stored secrets — you never touch Cloudflare to ship a front-end change; you just push to GitHub.
          Direct access is only required to manage hosting itself (DNS, the Worker, cache), via an invite as a
          <strong> Member</strong> at <strong>dash → Manage Account → Members</strong> (use a scoped role, not
          Super Administrator). The Account ID above is an identifier, not a credential — acting on the account still
          needs the Cloudflare API <em>token</em>, which stays in GitHub Actions secrets and is never shown here.
        </AccessNote>
      </ArchCard>

      <ArchCard icon="◆" title="Supabase" accent={C.goodSoft} tagline="The entire backend — Postgres, auth, RLS, edge functions">
        <ArchRow label="Project" value="positive-minds-cms" mono={false} />
        <ArchRow label="Project ID (ref)" value={SB_REF} />
        <ArchRow label="Dashboard" value={SB_DASH} href={SB_DASH} />
        <ArchRow label="API URL" value={SB_URL} href={SB_URL} />
        <ArchRow label="Database host" value={SB_DB_HOST} hint="Region us-east-1 · Postgres 17. Connecting still requires the DB credentials (not shown here)." />
        <ArchRow label="Edge functions" value={SB_FUNCS} href={SB_FUNCS} hint="content-api · generate-questions · mcp · game-feed · pack-describe" />
        <ArchRow label="Content API (game)" value={SB_FUNCS + "/content-api"} href={SB_FUNCS + "/content-api"} hint="The endpoint the game client pulls from." />
        <AccessNote>
          <strong>You need an invitation to the Supabase organization</strong> — GitHub access does not reach the
          backend. The owner invites you at <strong>Supabase dashboard → Organization → Team → Invite member</strong>,
          using your email and a role (choose a role below Owner if offered, so an accidental delete/billing change
          is prevented). <strong>Accept the emailed invitation</strong>, and this project appears under your own
          Supabase account.<br /><br />
          <strong>To connect and work:</strong> connect the <strong>Supabase MCP</strong> on your own Claude account,
          signing in with <em>your own</em> Supabase login — it inherits whatever the org role grants. You can then
          deploy edge functions and run database changes directly from a chat. (Or use the <strong>Supabase CLI</strong>
          with your own credentials.) The MCP connector is only the pipe; authorization comes from your Supabase org
          membership, not from Claude.<br /><br />
          <strong>Note:</strong> this org is on the free plan, so membership spans <em>all</em> projects in it, not just
          this one. Deploying edge functions / running SQL is manual (MCP or CLI) — a GitHub push never touches Supabase.
        </AccessNote>
      </ArchCard>

      <div style={{ background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.5, color: C.warnInk, lineHeight: 1.65 }}>
        <strong>No secrets on this page.</strong> These are identifiers and dashboard links only — they still require each
        service's own login to use. Credentials (Supabase service-role key, Cloudflare API token, database password, AI
        provider keys) are deliberately excluded and live only in GitHub Actions secrets and each service's console.
      </div>
    </div>
  );
}
