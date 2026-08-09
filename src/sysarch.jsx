// System Architecture — an at-a-glance reference of the three services this project runs on,
// with the live links, IDs, and dashboards for each. Reference-only page (no writes).
//
// SECURITY: this page shows IDENTIFIERS and DASHBOARD LINKS only — never secrets. The CMS is a
// shared-admin browser app, so anything rendered here is visible to anyone with the admin login.
// IDs and dashboard URLs are safe (they still require separate authentication to actually use);
// credentials (service-role key, Cloudflare API token, DB password, provider API keys) must NEVER
// be placed on this page. They live only in GitHub Actions secrets and each service's own console.

// The self-contained prompt a content contributor pastes into a FRESH Claude chat (which has no
// memory of this project). It never contains a token or any secret — only instructions. Everything
// concrete (pack names, counts, existing questions) is fetched from the connector at run time, so
// this text never goes stale. Kept as a template literal so it copies out verbatim.
const CONTRIB_PROMPT = `You're helping me write content for **Positive Minds**, a therapeutic spelling game for children (roughly ages 5–12). I've connected you to it through a tool connector in this chat — you'll see tools called list_packs, get_pack_content, check_questions and propose_questions.

HOW THE GAME WORKS (this is a SPELLING puzzle, not a meaning one):
A short, warm, first-person sentence appears with one word partly hidden, e.g. "I feel PR_UD when I try." The child is shown TWO words and picks the one whose spelling fits the blank.

TWO RULES THAT NEVER BEND:
1. BOTH words are always POSITIVE. Never put a negative word about a child in front of them. (This is therapy content — "KIND / MEAN" is forbidden; MEAN must never appear.)
2. The two words MUST be DIFFERENT LENGTHS. At higher levels the whole word is hidden, so length is the only clue — two same-length words would both fit and the puzzle breaks. E.g. PROUD (5) / CALM (4) is good; BRIGHT (6) / GENTLE (6) is broken.

WHAT I'D LIKE YOU TO DO:
1. Start by calling **list_packs**. It returns a full brief plus every pack and how full each one is (how many questions it has, how many distinct words, how many are already awaiting review).
2. Show me the packs as a **numbered list with those stats**, and ask me which ONE I'd like to add to. Wait for my answer — don't pick for me. If I want to write about a theme that doesn't exist yet, you can make a new pack with **create_pack** (and **update_pack** edits a pack's details). A new pack appears in the CMS straight away — its questions still go to the review queue like everything else.
3. Once I choose, call **get_pack_content** for that pack. Show me its current statistics and a sense of what's already in it. Then we'll write new questions together for that pack.
4. Before proposing anything, ALWAYS call **check_questions** on our drafts. It checks them against the real game engine AND the pack's existing content, so we never send a duplicate or a broken puzzle. Fix anything it flags, then check again.
5. Before proposing, call **preview_questions** so I can see exactly how each one looks to a child at each level — that's how I judge whether the words are right, not just valid. Then when they're clean, call **propose_questions**. That sends them to a human review queue — nothing goes live on its own; a person approves, edits or rejects every one.
6. If I ask about progress or what's pending, call **review_status** — it shows everything across all contributors. To go through the pending queue with me, call **preview_questions** (it gives each item's id): I can then reject any with **reject_questions**, or fix one with **edit_queued_question**. Approving happens in the CMS, not here.

Keep sentences warm, simple and first-person ("I am…", "I feel…"). Prefer fresh words and sentences for variety, but the only hard repetition rule is: don't reproduce an existing question exactly (same sentence AND the same two words).

Start now by calling list_packs and showing me the packs to choose from.`;

// A copyable multi-line prompt block (mirrors ArchRow's copy affordance, sized for a paragraph).
function PromptBlock({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div style={{ border: "1px solid " + C.line, borderRadius: R.md, overflow: "hidden", background: C.bgDeep }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid " + C.lineSoft, background: C.bg }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>Paste into a fresh Claude chat</span>
        <button onClick={copy} title="Copy prompt"
          style={{ background: copied ? C.goodSoft : C.brand, border: "none", borderRadius: R.sm, color: copied ? C.goodInk : "#fff", fontSize: 12, fontWeight: 800, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}>
          {copied ? "✓ Copied" : "Copy prompt"}
        </button>
      </div>
      <pre style={{ margin: 0, padding: "14px 16px", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, lineHeight: 1.65, color: C.ink2, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 340, overflowY: "auto" }}>{text}</pre>
    </div>
  );
}

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

// A single numbered step in the partner quick-start. Big number, title, body, optional inline extra
// (a copyable row, a prompt block, a callout).
function Step({ n, title, children, extra }) {
  return (
    <div style={{ display: "flex", gap: S.md, alignItems: "flex-start" }}>
      <div style={{ flex: "0 0 auto", width: 30, height: 30, borderRadius: 999, background: C.brand, color: "#fff",
        fontSize: 15, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{n}</div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: S.md }}>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink, marginBottom: 3 }}>{title}</div>
        <div className="pm-prose" style={{ fontSize: 13, color: C.ink2, lineHeight: 1.65 }}>{children}</div>
        {extra && <div style={{ marginTop: S.sm }}>{extra}</div>}
      </div>
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
  // The MCP connector URL partners paste into Claude. This is the Cloudflare Worker "discovery shim"
  // (positive-minds-mcp.…workers.dev), NOT the Supabase function directly — Claude's custom-connector
  // OAuth discovery probes the origin root for /.well-known/* metadata, which a Supabase edge function
  // (served under /functions/v1/…) cannot provide. The shim serves that metadata at its root and
  // proxies everything else to the unchanged Supabase MCP function.
  const MCP_CONNECTOR = "https://positive-minds-mcp.alcharles1980.workers.dev/mcp";

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>System architecture</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>
          Everything you need to connect Claude and start writing questions — step by step below. Technical service
          details (GitHub, Cloudflare, Supabase) follow underneath, for developers.
        </p>
      </div>

      {/* ============ PARTNER QUICK-START — the main event ============ */}
      <div style={{ background: C.panel, border: "2px solid " + C.brand, borderRadius: R.lg, overflow: "hidden", marginBottom: S.xl }}>
        <div style={{ padding: S.lg, borderBottom: "1px solid " + C.line, background: C.brandSoft }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.brandInk, letterSpacing: -0.2 }}>✍️ Write questions with Claude — start here</div>
          <div style={{ fontSize: 13, color: C.sub, marginTop: 3 }}>
            Six steps, about five minutes. You'll make your own access token, connect it to your own Claude, and start
            proposing questions. Everything you propose goes to a review queue first — nothing goes live on its own.
          </div>
        </div>
        <div style={{ padding: S.lg + "px " + S.lg + "px " + S.sm + "px" }}>

          <Step n={1} title="Sign in to this CMS">
            You're already here, so you're in. If you ever need to sign in again, use the <strong>username and password
            Albert sent you</strong> (they're shared privately — never shown on this page). That login is what lets you
            make your own token in the next step.
          </Step>

          <Step n={2} title="Make your access token"
            extra={
              <div style={{ background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.sm, padding: S.sm + "px " + S.md + "px", fontSize: 12, color: C.warnInk, lineHeight: 1.55 }}>
                <strong>Copy the token the moment it appears</strong> — it's shown only once and can't be recovered. If you
                lose it, just make another. Keep it private; it's a key, like a password.
              </div>
            }>
            Open the <strong>Claude Connector</strong> page (◇ in the left menu). Type <strong>your own name</strong> in the
            box (e.g. "Sarah") and click <strong>Create token</strong>. You'll get a <code>pmk_…</code> token — your name
            on it is how Albert can tell your proposals apart in review.
          </Step>

          <Step n={3} title="Add the connector to your Claude"
            extra={<ArchRow label="Connector URL" value={MCP_CONNECTOR} href={MCP_CONNECTOR} hint="Copy this — it's the address your Claude connects to." />}>
            <strong>Do this on a computer (claude.ai web or the desktop app) — you can't add a custom connector
            from the phone app.</strong> Once added there, it shows up on your phone automatically. Go to
            <strong> Settings → Connectors → Add custom connector</strong>, name it "Positive Minds", and paste the
            <strong> Connector URL</strong> below. Save it.
          </Step>

          <Step n={4} title="Sign in with your token">
            Start a new chat and turn the Positive Minds connector on. Click <strong>Connect</strong> — Claude opens a
            small <strong>Connect to Positive Minds</strong> sign-in screen. Paste your <code>pmk_…</code> token there and
            continue. (Claude handles the rest of the security handshake automatically; there are no codes to copy.) You
            only do this once per Claude.
          </Step>

          <Step n={5} title="Paste the starter prompt"
            extra={<PromptBlock text={CONTRIB_PROMPT} />}>
            Your chat has no idea what this project is yet, so paste the block below into it. It tells Claude everything —
            the game, the rules, and the exact steps to follow. Copy it with the button, paste, and send.
          </Step>

          <Step n={6} title="Pick a pack and write">
            Claude will show you the packs as a numbered list with their current stats (how many questions each has), and
            ask which one you want to add to. Choose one, then just talk: <em>"let's write 8 for level 2 about bedtime
            worries."</em> Claude checks every draft against what's already there so you never make a duplicate, then sends
            them to the review queue. <strong>Albert approves, edits, or rejects each one</strong> on the AI Review page —
            that's the only way anything reaches a child.
          </Step>

        </div>
      </div>

      {/* what happens to proposals + revoke */}
      <div style={{ display: "grid", gap: S.md, marginBottom: S.xl }}>
        <div style={{ background: C.goodSoft, border: "1px solid " + C.line, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.8, color: C.ink2, lineHeight: 1.65 }}>
          <strong style={{ color: C.goodInk }}>Nothing you propose goes live by itself.</strong> Every question is validated
          by the same engine the CMS uses and written <strong>only</strong> to the review queue. It reaches the game only
          when a human approves it on the <strong>AI Review</strong> page. The connector can read packs and propose — it
          can publish, edit, and delete nothing.
        </div>
        <div style={{ background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.5, color: C.warnInk, lineHeight: 1.6 }}>
          <strong>Lost or leaked a token?</strong> Go to the <strong>Claude Connector</strong> page and revoke it — that
          disables it instantly — then make a new one. Never paste your token anywhere public or commit it to code.
        </div>
      </div>

      {/* ============ TECHNICAL REFERENCE (for developers) ============ */}
      <div style={{ borderTop: "2px solid " + C.line, margin: S.xl + "px 0 " + S.lg + "px", paddingTop: S.lg }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, letterSpacing: -0.2 }}>Technical reference</div>
        <p className="pm-prose" style={{ margin: "3px 0 0", color: C.sub, fontSize: 13.5 }}>
          The services this project runs on, with their live links and IDs — for a developer working on the code or backend.
          A content contributor (above) needs none of this. GitHub holds the source and deploys the front-end; Cloudflare
          serves the site; Supabase is the backend. GitHub and Supabase are decoupled — a push never touches the backend.
        </p>
      </div>

      {/* how they fit together */}
      <div style={{ background: C.brandSoft, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.lg }}>
        <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.7 }}>
          <strong style={{ color: C.brandInk }}>Front-end:</strong> edit <code>src/</code> → build → <code>git push</code> → GitHub Actions → Cloudflare updates the live site.<br />
          <strong style={{ color: C.brandInk }}>Backend:</strong> the database, auth, and edge functions live in Supabase and are deployed manually (MCP or CLI) — <em>GitHub never deploys them</em>.
        </div>
      </div>

      {/* development partner access */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.xl }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: 4 }}>🛠 Development partner — builds the app</div>
        <div className="pm-prose" style={{ fontSize: 12.8, color: C.ink2, marginBottom: 0, lineHeight: 1.6 }}>
          Different from a content contributor: works on the code and backend, so needs <em>real</em> access —
          <strong> GitHub</strong> (collaborator, Write) and a <strong>Supabase org invitation</strong>. Cloudflare usually
          not needed. Full mechanics are in each service card below and in <code>CONTRIBUTING.md</code>.
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

      {/* content contributor setup guide */}
      <div style={{ background: C.bgDeep, border: "1px solid " + C.lineSoft, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", marginBottom: S.lg, fontSize: 12.5, color: C.ink2, lineHeight: 1.65 }}>
        <strong style={{ color: C.brandInk }}>Content contributor?</strong> You don't need any of the service access above —
        the full, step-by-step connect flow is at the top of this page (<em>“Write questions with Claude — start here”</em>).
        The connector reads packs and proposes to the review queue; it touches nothing else.
      </div>

      <div style={{ marginTop: S.lg, background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.5, color: C.warnInk, lineHeight: 1.65 }}>
        <strong>No secrets on this page.</strong> These are identifiers and dashboard links only — they still require each
        service's own login to use. Credentials (Supabase service-role key, Cloudflare API token, database password, AI
        provider keys) are deliberately excluded and live only in GitHub Actions secrets and each service's console.
      </div>
    </div>
  );
}
