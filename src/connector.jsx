// ============================================================
// Claude Connector — let partners write content by talking to Claude.
//
// A partner adds this CMS as a connector in their own Claude account, then simply says
// "write 15 questions for Calmness about bedtime worries". Claude reads the pack, checks its own
// drafts against the real game engine, and sends them to the AI Review queue.
//
// WHY THIS IS SAFE, and it matters more than any permission check:
//   A partner CANNOT reach a child. pm_review_approve is the only path into live content and it
//   requires a human to press Approve. The worst a partner can do — even a compromised one — is
//   fill the review queue with things you reject. That is the entire blast radius.
//   There is deliberately no tool to publish, delete, or edit a pack.
//
// TOKENS: shown ONCE at creation, then only ever stored as a sha256 hash. Not even an authenticated
// admin can read them back from the browser (verified: the table has RLS on and zero policies).
// ============================================================

const MCP_URL = `${CFG.url}/functions/v1/mcp`;

const db_mcp = {
  list: () => rpc("pm_mcp_list_tokens"),
  issue: (partner) => rpc("pm_mcp_issue_token", { p_partner: partner }),
  revoke: (id) => rpc("pm_mcp_revoke_token", { p_id: id }),
};

function ConnectorView() {
  const { loading, error, data, reload } = useAsync(() => db_mcp.list(), []);
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState(null);   // the one-time reveal
  const [copiedUrl, setCopiedUrl] = useState(false);

  const tokens = data || [];
  const active = tokens.filter(t => t.active);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 1800);
      notify("Connector URL copied");
    } catch { notify("Couldn't copy — select and copy manually", "error"); }
  };

  const revoke = async (t) => {
    const ok = await confirmDialog({
      title: `Revoke ${t.partner}'s access?`,
      body: "Their Claude connector will stop working immediately. Anything they've already sent for review stays in the queue.",
      confirmText: "Revoke", tone: "danger",
    });
    if (!ok) return;
    try { await db_mcp.revoke(t.id); await reload(); notify(`${t.partner}'s access revoked`); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Claude Connector</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5, lineHeight: 1.55 }}>
          Let a partner write content just by talking to Claude. Everything they produce comes to you
          for approval first — they can't publish anything.
        </p>
      </div>

      {/* What a partner can and cannot do. Say it plainly — this is the whole security story. */}
      <div className="pm-readable" style={{ background: C.brandSoft, borderRadius: R.lg, padding: "14px 17px",
        marginBottom: S.lg, fontSize: 13.5, color: C.brandInk, lineHeight: 1.65 }}>
        <b>A partner can only propose questions.</b> They can read your packs (so they don't repeat
        words you've already used), and send new questions to <b>AI Review</b>. That's all. They cannot
        publish, delete, or edit anything. The worst they can do is fill your review queue with things
        you then reject.
      </div>

      {/* The URL partners need */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.lg }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Connector URL</div>
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ flex: "1 1 300px", fontSize: 12.5, fontFamily: "ui-monospace, monospace",
            background: C.bg, padding: "9px 12px", borderRadius: R.sm, color: C.ink2,
            overflowWrap: "anywhere", border: "1px solid " + C.line }}>{MCP_URL}</code>
          <Btn size="sm" variant="soft" onClick={copyUrl} icon={copiedUrl ? "✓" : "⧉"}>
            {copiedUrl ? "Copied" : "Copy"}
          </Btn>
        </div>
        <div style={{ fontSize: 12, color: C.faint, marginTop: 7, lineHeight: 1.5 }}>
          The same for everyone. What identifies a partner is their token.
        </div>
      </div>

      {/* Partners */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: S.md, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>Partners</h2>
        {active.length > 0 && <Pill tone="muted">{active.length} with access</Pill>}
        <div style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => setAdding(true)}>Add a partner</Btn>
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: 10 }}>{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} h={74} r={12} />)}</div>
      ) : tokens.length === 0 ? (
        <EmptyState
          icon="◇"
          title="No partners yet"
          body="Add one and you'll get a token to send them. They paste it into Claude, and can start writing straight away."
        />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {tokens.map(t => (
            <div key={t.id} style={{ background: C.panel, borderRadius: R.lg, padding: S.lg,
              border: "1px solid " + C.line,
              borderLeft: "4px solid " + (t.active ? C.ok : C.faint),
              opacity: t.active ? 1 : 0.62 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: S.md, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>{t.partner}</span>
                    {!t.active && <Pill tone="muted">Revoked</Pill>}
                  </div>
                  <div style={{ fontSize: 12.5, color: C.sub, marginTop: 4, lineHeight: 1.6 }}>
                    {t.last_used_at
                      ? <>Last used {relativeTime(t.last_used_at)} · {t.calls_made} call{t.calls_made === 1 ? "" : "s"}</>
                      : <span style={{ color: C.faint }}>Hasn't connected yet</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>
                    Added {relativeTime(t.created_at)}
                  </div>
                </div>
                {t.active && (
                  <button onClick={() => revoke(t)}
                    style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 13px", borderRadius: 8, cursor: "pointer",
                      border: "1px solid " + C.line, background: "transparent", color: C.danger }}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* How it works for them */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg,
        padding: S.lg, marginTop: S.xl }} className="pm-readable">
        <h2 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 800, color: C.ink }}>What your partner does</h2>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: C.ink2, lineHeight: 1.85 }}>
          <li>In Claude: <b>Settings → Connectors → Add custom connector</b>.</li>
          <li>They paste <b>just the URL</b> above and click Add. (Nothing goes in the OAuth boxes.)</li>
          <li>They click <b>Connect</b>. A Positive Minds sign-in page opens — they paste their token there.</li>
          <li>Then they simply talk to it: <i>"Write me 15 questions for the Calmness pack about worries at bedtime."</i></li>
        </ol>
        <div style={{ fontSize: 13, color: C.sub, marginTop: 12, lineHeight: 1.65, paddingTop: 12, borderTop: "1px solid " + C.lineSoft }}>
          Behind the scenes, Claude reads the pack so it doesn't repeat words you've already used,
          checks its own drafts against the real game engine — including whether the two words are the
          same length, which would give the child two correct answers — fixes anything it got wrong,
          and only then sends them to you. <b>You'll see them in AI Review, tagged with who wrote them.</b>
        </div>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} width={480}>
        {adding && (
          <AddPartner
            onClose={() => setAdding(false)}
            onIssued={async (result) => { setAdding(false); setIssued(result); await reload(); }}
          />
        )}
      </Modal>

      <Modal open={issued !== null} onClose={() => setIssued(null)} width={540}>
        {issued && <TokenReveal result={issued} onClose={() => setIssued(null)} />}
      </Modal>
    </div>
  );
}

function AddPartner({ onClose, onIssued }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n) { notify("Give them a name — you'll want to know whose work you're reviewing", "error"); return; }
    setBusy(true);
    try {
      const res = await db_mcp.issue(n);
      onIssued(res);
    } catch (e) {
      setBusy(false);
      notify(friendlyError(0, String(e?.message || e)), "error");
    }
  };

  return (
    <>
      <ModalHead title="Add a partner" subtitle="They'll get a token to paste into Claude" />
      <div style={{ padding: S.xl, display: "grid", gap: S.md }}>
        <Field label="Their name" hint="Shown against every question they send, so you know whose work you're reviewing">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            placeholder="e.g. Sarah" onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <div style={{ fontSize: 12.5, color: C.faint, lineHeight: 1.55 }}>
          You'll see the token once, on the next screen. It isn't stored, so it can't be shown again —
          if they lose it, just add them afresh.
        </div>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create token"}</Btn>
      </ModalFoot>
    </>
  );
}

// The one-time reveal. This is the ONLY moment the raw token exists anywhere — we store a hash, so
// it genuinely cannot be shown again. Say so plainly rather than letting them find out later.
function TokenReveal({ result, onClose }) {
  const [copied, setCopied] = useState(false);
  const token = result?.token || "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
      notify("Token copied");
    } catch { notify("Couldn't copy — select the text and copy it manually", "error"); }
  };

  return (
    <>
      <ModalHead title={`${result.partner}'s token`} subtitle="Copy it now — you won't see it again" />
      <div style={{ padding: S.xl, display: "grid", gap: S.md }}>
        <div style={{ background: C.warn + "12", border: "1px solid " + C.warn + "44", borderRadius: R.md,
          padding: "11px 14px", fontSize: 13, color: C.ink2, lineHeight: 1.6 }}>
          <b style={{ color: C.warn }}>This is the only time you'll see this.</b> We store it as a
          one-way hash, so it genuinely can't be recovered — not by you, not by anyone. Send it to{" "}
          {result.partner} now. If it's lost, just add them again.
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Token</div>
          <div style={{ display: "flex", gap: 9, alignItems: "stretch", flexWrap: "wrap" }}>
            <code style={{ flex: "1 1 260px", fontSize: 13, fontFamily: "ui-monospace, monospace",
              background: C.bg, padding: "12px 14px", borderRadius: R.sm, color: C.ink,
              border: "1px solid " + C.line, overflowWrap: "anywhere", userSelect: "all" }}>{token}</code>
            <Btn onClick={copy} icon={copied ? "✓" : "⧉"}>{copied ? "Copied" : "Copy"}</Btn>
          </div>
        </div>

        <div style={{ background: C.bg, borderRadius: R.md, padding: "12px 15px" }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: .3,
            textTransform: "uppercase", marginBottom: 7 }}>Send them this</div>
          <div style={{ fontSize: 13, color: C.ink2, lineHeight: 1.75 }}>
            1. In Claude: <b>Settings → Connectors → Add custom connector</b><br />
            2. Paste this URL and click Add:<br />
            <code style={{ fontSize: 11.5, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{MCP_URL}</code><br />
            3. Click <b>Connect</b> — a sign-in page opens.<br />
            4. Paste the token above into it.
          </div>
        </div>
      </div>
      <ModalFoot>
        <Btn onClick={onClose}>Done — I've copied it</Btn>
      </ModalFoot>
    </>
  );
}
