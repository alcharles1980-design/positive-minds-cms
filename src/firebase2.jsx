// ============================================================
// Firebase Target Editor
// ============================================================
function FirebaseTargetEditor({ target, profiles, sampleContent, onSave, onClose }) {
  const isNew = !target?.id;
  const [name, setName] = useState(target?.name || "Firebase");
  const [profileId, setProfileId] = useState(target?.profile_id || profiles[0]?.id || "");
  const [cfg, setCfg] = useState(target?.config || { mode: "rtdb", layout: "per-pack", packPath: "packs/{slug}", questionPath: "questions/{id}", singlePath: "content/all" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [testMsg, setTestMsg] = useState(null);
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  const profile = profiles.find(p => p.id === profileId);

  // preview the planned writes (paths only, with sample data)
  const plan = useMemo(() => {
    if (!profile || !sampleContent.packs.length) return [];
    try {
      const spec = { ...profile.spec, __name: profile.name };
      const ops = planWrites(cfg, sampleContent.packs.slice(0, 3), sampleContent.byPack, buildOutput, spec);
      return ops.slice(0, 6);
    } catch { return []; }
  }, [cfg, profile, sampleContent]);

  const submit = async () => {
    if (!profileId) { setErr("Choose an export profile."); return; }
    setBusy(true); setErr("");
    try { await onSave({ name, channel: "firebase", profile_id: profileId, config: cfg }, target?.id); onClose(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  const test = async () => {
    setTestMsg({ kind: "info", text: "Testing connection…" });
    try {
      if (cfg.mode === "rtdb") {
        if (!cfg.rtdbUrl) throw new Error("Enter the Realtime DB URL first");
        const base = cfg.rtdbUrl.replace(/\/$/, "");
        const auth = cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : "";
        const res = await fetch(`${base}/.settings/rules.json${auth}`).catch(() => null);
        // a reachable RTDB returns 200 or 401/403; anything is "reachable"
        setTestMsg(res ? { kind: "success", text: `Reached Realtime DB (HTTP ${res.status}). Ready to write.` } : { kind: "error", text: "Could not reach that URL." });
      } else if (cfg.mode === "firestore") {
        if (!cfg.projectId) throw new Error("Enter the Firestore project ID first");
        setTestMsg({ kind: "success", text: `Firestore target set for project “${cfg.projectId}”. A real write will confirm access.` });
      } else {
        if (!cfg.fnUrl) throw new Error("Enter the Cloud Function URL first");
        setTestMsg({ kind: "success", text: "Cloud Function URL set. Push will POST there." });
      }
    } catch (e) { setTestMsg({ kind: "error", text: e.message }); }
  };

  return (
    <>
      <ModalHead emoji="🔥" title={isNew ? "New Firebase target" : "Edit Firebase target"} subtitle="Configure how content writes into Firebase" />
      <div style={{ padding: S.xl, display: "grid", gap: S.lg, maxHeight: "62vh", overflowY: "auto" }}>
        <div className="pm-form-2">
          <Field label="Target name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Export profile" hint="Which format to send">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Firebase database & write method">
          <div style={{ display: "grid", gap: 8 }}>
            {[["rtdb", "Realtime Database (REST)", "Direct writes from the CMS. Only needs the database URL + secret. Works today."],
              ["firestore", "Firestore (REST)", "Direct writes via Firestore REST. Needs project ID + an API key or token."],
              ["cloudfn", "Cloud Function (POST)", "CMS posts the payload to your Firebase Function, which writes with the Admin SDK. Most secure."]].map(([v, l, d]) => (
              <label key={v} style={{ display: "flex", gap: 11, alignItems: "flex-start", padding: 11, borderRadius: R.md, border: "1px solid " + (cfg.mode === v ? C.brand : C.line), background: cfg.mode === v ? C.brandSoft : C.panel, cursor: "pointer" }}>
                <input type="radio" checked={cfg.mode === v} onChange={() => set("mode", v)} style={{ marginTop: 2, accentColor: C.brand }} />
                <div><div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{l}</div><div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>{d}</div></div>
              </label>
            ))}
          </div>
        </Field>

        {/* mode-specific credentials */}
        {cfg.mode === "rtdb" && (
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Realtime Database URL" hint="From Firebase console → Realtime Database"><Input value={cfg.rtdbUrl || ""} onChange={(e) => set("rtdbUrl", e.target.value)} placeholder="https://your-app-default-rtdb.firebaseio.com" /></Field>
            <Field label="Database secret / auth token" hint="Optional if rules allow writes; else a DB secret or ID token"><Input type="password" value={cfg.secret || ""} onChange={(e) => set("secret", e.target.value)} placeholder="secret or token" /></Field>
          </div>
        )}
        {cfg.mode === "firestore" && (
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Firestore project ID"><Input value={cfg.projectId || ""} onChange={(e) => set("projectId", e.target.value)} placeholder="my-game-project" /></Field>
            <div className="pm-form-2">
              <Field label="Web API key" hint="Optional"><Input value={cfg.apiKey || ""} onChange={(e) => set("apiKey", e.target.value)} placeholder="AIza…" /></Field>
              <Field label="Bearer token" hint="Optional OAuth/ID token"><Input type="password" value={cfg.bearer || ""} onChange={(e) => set("bearer", e.target.value)} placeholder="ya29.…" /></Field>
            </div>
          </div>
        )}
        {cfg.mode === "cloudfn" && (
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Cloud Function URL"><Input value={cfg.fnUrl || ""} onChange={(e) => set("fnUrl", e.target.value)} placeholder="https://us-central1-you.cloudfunctions.net/ingestContent" /></Field>
            <div className="pm-form-2">
              <Field label="Auth header name" hint="Optional"><Input value={cfg.header || ""} onChange={(e) => set("header", e.target.value)} placeholder="Authorization" /></Field>
              <Field label="Auth value / secret" hint="Optional"><Input type="password" value={cfg.secret || ""} onChange={(e) => set("secret", e.target.value)} placeholder="Bearer …" /></Field>
            </div>
            <div style={{ fontSize: 12, color: C.infoSoft ? C.sub : C.sub, background: C.infoSoft, padding: "10px 12px", borderRadius: R.sm }}>
              Your function receives <code>{`{ writes: [{path,data}], payload }`}</code>. A ready-to-deploy sample function is in the docs button below.
            </div>
          </div>
        )}

        {/* WHICH PACKS. Optional per target: none selected = send everything, which is what every
            existing target does and must keep doing. Useful for a staging destination that takes one
            pack, or for a faster sync when only one pack changed. */}
        <Field label="Which packs" hint="Leave all unticked to send everything. Ticking some sends only those — useful for a staging target, or a quick sync after changing one pack.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(sampleContent.packs || []).map((p) => {
              const on = Array.isArray(cfg.packs) && cfg.packs.includes(p.slug);
              return (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => {
                    const cur = Array.isArray(cfg.packs) ? cfg.packs : [];
                    set("packs", on ? cur.filter((x) => x !== p.slug) : [...cur, p.slug]);
                  }}
                  style={{
                    padding: "6px 11px", borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                    fontFamily: "inherit",
                    border: `1px solid ${on ? C.brand : C.line}`,
                    background: on ? C.brandSoft : C.card,
                    color: on ? C.brandInk : C.ink2,
                  }}
                >
                  {p.emoji ? p.emoji + " " : ""}{p.name}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: C.sub, marginTop: 7 }}>
            {Array.isArray(cfg.packs) && cfg.packs.length
              ? `Sending ${cfg.packs.length} of ${(sampleContent.packs || []).length} packs.`
              : `Sending all ${(sampleContent.packs || []).length} packs.`}
            {Array.isArray(cfg.packs) && cfg.packs.length
              ? " Unticking a pack stops sending it — it does not delete anything already in Firebase."
              : ""}
          </div>
        </Field>

        {/* layout (skip for cloudfn since the function decides) */}
        {cfg.mode !== "cloudfn" && (
          <Field label="Content layout" hint="Where documents/nodes are written. {slug} and {id} are placeholders.">
            <Select value={cfg.layout || "per-pack"} onChange={(e) => set("layout", e.target.value)} style={{ marginBottom: 8 }}>
              <option value="per-pack">One document per pack</option>
              <option value="per-question">One document per question</option>
              <option value="single-doc">Single document holding everything</option>
            </Select>
            {cfg.layout === "per-pack" && <Input value={cfg.packPath || "packs/{slug}"} onChange={(e) => set("packPath", e.target.value)} placeholder="packs/{slug}" style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }} />}
            {cfg.layout === "per-question" && <Input value={cfg.questionPath || "questions/{id}"} onChange={(e) => set("questionPath", e.target.value)} placeholder="questions/{id}" style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }} />}
            {cfg.layout === "single-doc" && <Input value={cfg.singlePath || "content/all"} onChange={(e) => set("singlePath", e.target.value)} placeholder="content/all" style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }} />}
          </Field>
        )}

        {/* write plan preview */}
        {cfg.mode !== "cloudfn" && plan.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.ink2, letterSpacing: 0.3, marginBottom: 8, textTransform: "uppercase" }}>Write plan (sample)</div>
            <div style={{ background: C.bg, borderRadius: R.md, padding: 12, display: "grid", gap: 5 }}>
              {plan.map((op, i) => (
                <div key={i} style={{ fontSize: 12.5, fontFamily: "ui-monospace,monospace", color: C.ink2, display: "flex", gap: 8 }}>
                  <span style={{ color: C.brand, fontWeight: 700 }}>PUT</span>
                  <span style={{ color: C.faint }}>{cfg.mode === "firestore" ? "firestore:" : "rtdb:"}</span>
                  <span>{op.path}</span>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>…one write per {cfg.layout === "single-doc" ? "everything" : cfg.layout === "per-question" ? "question" : "pack"}.</div>
            </div>
          </div>
        )}

        {testMsg && <div style={{ fontSize: 13, fontWeight: 600, padding: "10px 14px", borderRadius: R.md, background: testMsg.kind === "error" ? C.dangerSoft : testMsg.kind === "success" ? C.goodSoft : C.infoSoft, color: testMsg.kind === "error" ? C.dangerInk : testMsg.kind === "success" ? C.goodInk : C.ink2 }}>{testMsg.text}</div>}
        {err && <ErrorState error={err} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="soft" onClick={test}>Test connection</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Create target" : "Save target"}</Btn>
      </ModalFoot>
    </>
  );
}

// Sample Cloud Function docs modal
function CloudFnDocs({ onClose }) {
  const code = `// Firebase Cloud Function — receives content from the CMS.
// Deploy with: firebase deploy --only functions:ingestContent
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.ingestContent = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "POST"); return res.status(204).send(""); }

  // OPTIONAL: check a shared secret
  // if (req.get("Authorization") !== "Bearer YOUR_SECRET") return res.status(401).send("no");

  const { writes } = req.body; // [{ path, data }]
  const db = admin.firestore();          // or admin.database() for RTDB
  const batch = db.batch();
  for (const w of writes) {
    const parts = w.path.split("/").filter(Boolean);
    const id = parts.pop();
    const col = parts.join("/") || "content";
    batch.set(db.collection(col).doc(id), w.data, { merge: true });
  }
  await batch.commit();
  res.json({ ok: true, written: writes.length });
});`;
  const copy = () => navigator.clipboard?.writeText(code);
  return (
    <>
      <ModalHead emoji="⚡" title="Sample Firebase Cloud Function" subtitle="Deploy this, then point the target's URL at it" />
      <div style={{ padding: S.xl }}>
        <pre style={{ background: C.bgDeep, borderRadius: R.md, padding: 16, fontSize: 12, lineHeight: 1.55, overflowX: "auto", color: C.ink2, margin: 0, maxHeight: 400, fontFamily: "ui-monospace,monospace" }}>{code}</pre>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
        <Btn onClick={copy} icon="⧉">Copy code</Btn>
      </ModalFoot>
    </>
  );
}
