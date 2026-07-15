// ============================================================
// Developer Notes page — three reference docs + editable scratchpad
// ============================================================
const db_notes = {
  get: () => rest("pm_dev_notes?id=eq.1&limit=1").then(r => r.data?.[0]?.content ?? ""),
  save: (content) => rest("pm_dev_notes?id=eq.1", { method: "PATCH", body: { content, updated_at: new Date().toISOString() } }),
};

const DEV_DOCS = [
  { id: "architecture", label: "Architecture & Structure", file: "ARCHITECTURE.md", icon: "🗂", body: DOC_ARCHITECTURE, desc: "Complete technical reference: modules, data model, engine, channels, build." },
  { id: "claude_md", label: "CLAUDE.md", file: "CLAUDE.md", icon: "📘", body: DOC_CLAUDE_MD, desc: "Conventions & rules for AI assistants working on this codebase." },
  { id: "build_prompt", label: "Build Prompt", file: "BUILD_PROMPT.md", icon: "🛠", body: DOC_BUILD_PROMPT, desc: "A single prompt to recreate this entire app from scratch in Claude." },
];

const downloadText = (filename, text) => {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

function DeveloperNotes() {
  const [active, setActive] = useState("architecture");
  const [copied, setCopied] = useState(false);

  // scratchpad
  const [notes, setNotes] = useState(null);
  const [saved, setSaved] = useState(true);
  const [savingState, setSavingState] = useState("");
  const saveTimer = useRef(null);

  useEffect(() => { db_notes.get().then(c => setNotes(c)).catch(() => setNotes("")); }, []);

  const onNotesChange = (val) => {
    setNotes(val); setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSavingState("saving");
      try { await db_notes.save(val); setSaved(true); setSavingState("saved"); setTimeout(() => setSavingState(""), 1500); }
      catch { setSavingState("error"); }
    }, 800);
  };

  const doc = active === "scratchpad" ? null : DEV_DOCS.find(d => d.id === active);
  const copy = () => { if (doc) { navigator.clipboard?.writeText(doc.body); setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Developer notes</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Reference documentation and a shared scratchpad for this project.</p>
      </div>

      {/* doc tabs */}
      <div className="pm-dev-tabs" style={{ display: "flex", gap: 8, marginBottom: S.lg, flexWrap: "wrap" }}>
        {DEV_DOCS.map(d => (
          <button key={d.id} onClick={() => setActive(d.id)} style={docTabStyle(active === d.id)}>
            <span style={{ fontSize: 16 }}>{d.icon}</span>{d.label}
          </button>
        ))}
        <button onClick={() => setActive("scratchpad")} style={docTabStyle(active === "scratchpad")}>
          <span style={{ fontSize: 16 }}>✎</span>Scratchpad
        </button>
      </div>

      {doc ? (
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: `${S.md + 2}px ${S.lg}px`, borderBottom: "1px solid " + C.line, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink }}>{doc.file}</div>
              <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>{doc.desc}</div>
            </div>
            <Btn variant="ghost" size="sm" onClick={copy}>{copied ? "Copied ✓" : "⧉ Copy"}</Btn>
            <Btn variant="soft" size="sm" onClick={() => downloadText(doc.file, doc.body)}>⭳ Download</Btn>
          </div>
          <pre style={{ margin: 0, padding: S.lg, fontSize: 12.5, lineHeight: 1.6, color: C.ink2, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", maxHeight: "62vh", overflowY: "auto" }}>{doc.body}</pre>
        </div>
      ) : (
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: `${S.md + 2}px ${S.lg}px`, borderBottom: "1px solid " + C.line }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink }}>Shared scratchpad</div>
              <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>Free-form notes, saved automatically. Visible to anyone with access.</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: savingState === "error" ? C.danger : savingState === "saving" ? C.faint : saved ? C.good : C.faint }}>
              {savingState === "error" ? "Save failed" : savingState === "saving" ? "Saving…" : saved ? "Saved" : "Unsaved"}
            </span>
          </div>
          {notes === null ? <div style={{ padding: S.xl }}><Spinner label="Loading notes…" /></div> : (
            <>
              <Textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} rows={16}
                placeholder="Jot down TODOs, decisions, credentials to rotate, ideas…"
                style={{ border: "none", borderRadius: 0, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.6 }} />
              {savingState === "error" && <div style={{ padding: "8px 16px" }}><Btn variant="ghost" size="sm" onClick={() => onNotesChange(notes)}>Retry save</Btn></div>}
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: S.md, fontSize: 12, color: C.faint }}>
        Docs are embedded in the build (always current with this version). The scratchpad is stored in the database.
      </div>
    </div>
  );
}

const docTabStyle = (on) => ({
  display: "flex", alignItems: "center", gap: 8, padding: "9px 15px", borderRadius: R.md,
  border: "1px solid " + (on ? C.brand : C.line), background: on ? C.brandSoft : C.panel,
  color: on ? C.brandInk : C.ink2, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700,
});
