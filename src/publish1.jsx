// ============================================================
// Field-mapping row (visual builder)
// ============================================================
function FieldMapRow({ map, sources, onChange, onRemove }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto auto", gap: 8, alignItems: "center" }}>
      <Select value={map.from} onChange={(e) => onChange({ ...map, from: e.target.value })} style={{ padding: "7px 10px", fontSize: 13 }}>
        {sources.map(s => <option key={s} value={s}>{s}</option>)}
      </Select>
      <span style={{ color: C.faint, fontSize: 14 }}>→</span>
      <Input value={map.to} onChange={(e) => onChange({ ...map, to: e.target.value })} placeholder="output name" style={{ padding: "7px 10px", fontSize: 13 }} />
      <Select value={map.transform || "none"} onChange={(e) => onChange({ ...map, transform: e.target.value })} style={{ padding: "7px 10px", fontSize: 12.5, minWidth: 92 }}>
        {TRANSFORMS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
      </Select>
      <button onClick={onRemove} aria-label="Remove" style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 16, padding: 4 }}>×</button>
    </div>
  );
}

// ============================================================
// Profile Builder — visual + JSON, with live preview
// ============================================================
function ProfileBuilder({ profile, sampleContent, onSave, onClose }) {
  const isNew = !profile?.id;
  const [name, setName] = useState(profile?.name || "New profile");
  const [desc, setDesc] = useState(profile?.description || "");
  const [spec, setSpec] = useState(profile?.spec || emptySpec());
  const [tab, setTab] = useState("visual"); // visual | json | preview
  const [jsonText, setJsonText] = useState(JSON.stringify(profile?.spec || emptySpec(), null, 2));
  const [jsonErr, setJsonErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const setSpecField = (k, v) => setSpec(s => ({ ...s, [k]: v }));
  const setFilter = (k, v) => setSpec(s => ({ ...s, filters: { ...(s.filters || {}), [k]: v } }));

  // keep JSON tab in sync when leaving visual
  const syncToJson = () => setJsonText(JSON.stringify(spec, null, 2));
  const applyJson = () => {
    try { const parsed = JSON.parse(jsonText); setSpec(parsed); setJsonErr(""); return true; }
    catch (e) { setJsonErr(e.message); return false; }
  };
  const switchTab = (t) => {
    if (tab === "json" && t !== "json") { if (!applyJson()) return; }
    if (t === "json") syncToJson();
    setTab(t);
  };

  // live preview
  const preview = useMemo(() => {
    try {
      const s = { ...spec, __name: name };
      const packs = sampleContent.packs.slice(0, 2);
      const body = buildOutput(s, packs, sampleContent.byPack, "id");
      const out = withMeta(s, body, { packs: packs.length, questions: sampleContent.questionCount });
      return JSON.stringify(out, null, 2);
    } catch (e) { return "// Preview error: " + e.message; }
  }, [spec, name, sampleContent]);

  const submit = async () => {
    if (tab === "json" && !applyJson()) { setTab("json"); return; }
    setBusy(true); setSaveErr("");
    try { await onSave({ name, description: desc, spec: tab === "json" ? JSON.parse(jsonText) : spec }, profile?.id); onClose(); }
    catch (e) { setSaveErr(e.message); setBusy(false); }
  };

  const updateFields = (key, fields) => setSpec(s => ({ ...s, [key]: fields }));

  return (
    <>
      <ModalHead title={isNew ? "New export profile" : "Edit profile"} subtitle="Define how content is shaped for a game backend" />
      <div style={{ padding: `${S.lg}px ${S.xl}px 0` }}>
        <div className="pm-form-2">
          <Field label="Profile name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Firebase import format" /></Field>
        </div>
      </div>
      {/* tabs */}
      <div style={{ display: "flex", gap: 4, padding: `${S.md}px ${S.xl}px 0` }}>
        {[["visual", "◫ Visual"], ["json", "{ } JSON"], ["preview", "◉ Preview"]].map(([v, l]) => (
          <button key={v} onClick={() => switchTab(v)} style={{ padding: "8px 14px", borderRadius: R.sm, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700, background: tab === v ? C.brandSoft : "transparent", color: tab === v ? C.brandInk : C.sub }}>{l}</button>
        ))}
      </div>

      <div style={{ padding: S.xl, maxHeight: "56vh", overflowY: "auto" }}>
        {tab === "visual" && (
          <div style={{ display: "grid", gap: S.xl }}>
            {/* structure */}
            <div>
              <SectionLabel>Output structure</SectionLabel>
              <div className="pm-form-2">
                <Field label="Shape">
                  <Select value={spec.structure} onChange={(e) => setSpecField("structure", e.target.value)}>
                    <option value="nested">Nested — packs with questions inside</option>
                    <option value="flat">Flat — one array of questions</option>
                    <option value="keyed">Keyed — dictionary by slug</option>
                  </Select>
                </Field>
                <Field label="Root key" hint="Top-level wrapper (blank = bare)">
                  <Input value={spec.root_key || ""} onChange={(e) => setSpecField("root_key", e.target.value)} placeholder="packs" />
                </Field>
              </div>
              <div className="pm-form-2" style={{ marginTop: S.md }}>
                {spec.structure !== "flat" && <Field label="Questions key" hint="Name of the questions array"><Input value={spec.questions_key || "questions"} onChange={(e) => setSpecField("questions_key", e.target.value)} /></Field>}
                {spec.structure === "keyed" && <Field label="Key by"><Select value={spec.key_by || "slug"} onChange={(e) => setSpecField("key_by", e.target.value)}><option value="slug">slug</option><option value="name">name</option></Select></Field>}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 9, marginTop: S.md, cursor: "pointer" }}>
                <input type="checkbox" checked={spec.include_meta !== false} onChange={(e) => setSpecField("include_meta", e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand }} />
                <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include metadata envelope (version, counts, timestamp)</span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 9, marginTop: S.sm + 2, cursor: "pointer" }}>
                <input type="checkbox" checked={!!spec.expand_levels} onChange={(e) => setSpecField("expand_levels", e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
                <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Expand levels<div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Add a <code>levels</code> array to each question with the sentence, blank, and an explicit <code>target</code> (the guess word) + <code>frames</code> map for all 10 levels.</div></span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 9, marginTop: S.sm + 2, cursor: "pointer" }}>
                <input type="checkbox" checked={!!spec.include_frames} onChange={(e) => setSpecField("include_frames", e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
                <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include frame-word config<div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Attach the raw <code>frameSlots</code> (pools + per-level pins) to each question, so the game can vary the swappable words itself instead of using the pre-resolved ones.</div></span>
              </label>
            </div>

            {/* filters */}
            <div>
              <SectionLabel>What to include</SectionLabel>
              <div className="pm-form-2">
                <Field label="Pack status"><Select value={spec.filters?.status || ""} onChange={(e) => setFilter("status", e.target.value)}><option value="">All</option><option value="published">Published only</option><option value="draft">Draft only</option></Select></Field>
                <Field label="Question status"><Select value={spec.filters?.question_status || ""} onChange={(e) => setFilter("question_status", e.target.value)}><option value="">All</option><option value="active">Active only</option><option value="inactive">Inactive only</option></Select></Field>
              </div>
            </div>

            {/* pack fields */}
            <div>
              <SectionLabel>Pack fields <span style={{ fontWeight: 500, color: C.faint }}>· source → output</span></SectionLabel>
              <div style={{ display: "grid", gap: 8 }}>
                {(spec.pack_fields || []).map((m, i) => (
                  <FieldMapRow key={i} map={m} sources={PACK_SOURCE_FIELDS}
                    onChange={(nm) => updateFields("pack_fields", spec.pack_fields.map((x, j) => j === i ? nm : x))}
                    onRemove={() => updateFields("pack_fields", spec.pack_fields.filter((_, j) => j !== i))} />
                ))}
              </div>
              <Btn variant="ghost" size="sm" style={{ marginTop: 8 }} onClick={() => updateFields("pack_fields", [...(spec.pack_fields || []), { from: "slug", to: "", transform: "none" }])}>+ Add pack field</Btn>
            </div>

            {/* question fields */}
            <div>
              <SectionLabel>Question fields <span style={{ fontWeight: 500, color: C.faint }}>· source → output</span></SectionLabel>
              <div style={{ display: "grid", gap: 8 }}>
                {(spec.question_fields || []).map((m, i) => (
                  <FieldMapRow key={i} map={m} sources={QUESTION_SOURCE_FIELDS}
                    onChange={(nm) => updateFields("question_fields", spec.question_fields.map((x, j) => j === i ? nm : x))}
                    onRemove={() => updateFields("question_fields", spec.question_fields.filter((_, j) => j !== i))} />
                ))}
              </div>
              <Btn variant="ghost" size="sm" style={{ marginTop: 8 }} onClick={() => updateFields("question_fields", [...(spec.question_fields || []), { from: "template", to: "", transform: "none" }])}>+ Add question field</Btn>
            </div>

            {/* value maps */}
            <div>
              <SectionLabel>Value maps <span style={{ fontWeight: 500, color: C.faint }}>· remap specific values</span></SectionLabel>
              <ValueMapEditor maps={spec.value_maps || {}} onChange={(vm) => setSpecField("value_maps", vm)} />
            </div>
          </div>
        )}

        {tab === "json" && (
          <div>
            <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 8 }}>Edit the raw spec. This is the same config the visual editor produces.</div>
            <Textarea value={jsonText} onChange={(e) => { setJsonText(e.target.value); setJsonErr(""); }} rows={20} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} />
            {jsonErr && <div style={{ color: C.danger, fontSize: 13, marginTop: 8, fontWeight: 600 }}>Invalid JSON: {jsonErr}</div>}
          </div>
        )}

        {tab === "preview" && (
          <div>
            <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 8 }}>Live output using your first 2 packs as a sample.</div>
            <pre style={{ background: C.bgDeep, borderRadius: R.md, padding: 16, fontSize: 12.5, lineHeight: 1.5, overflowX: "auto", color: C.ink2, margin: 0, maxHeight: 400, fontFamily: "ui-monospace, monospace" }}>{preview}</pre>
          </div>
        )}
        {saveErr && <div style={{ marginTop: S.md }}><ErrorState error={saveErr} /></div>}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Create profile" : "Save profile"}</Btn>
      </ModalFoot>
    </>
  );
}
const SectionLabel = ({ children }) => <div style={{ fontSize: 12, fontWeight: 800, color: C.ink2, letterSpacing: 0.3, marginBottom: 10, textTransform: "uppercase" }}>{children}</div>;

function ValueMapEditor({ maps, onChange }) {
  const entries = Object.entries(maps);
  const [nf, setNf] = useState("");
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {entries.map(([field, m]) => (
        <div key={field} style={{ background: C.bg, borderRadius: R.md, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.brandInk }}>{field}</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => { const c = { ...maps }; delete c[field]; onChange(c); }} style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 12, fontWeight: 700 }}>remove</button>
          </div>
          {Object.entries(m).map(([k, v]) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: 6, alignItems: "center", marginBottom: 5 }}>
              <Input value={k} onChange={(e) => { const nm = { ...m }; delete nm[k]; nm[e.target.value] = v; onChange({ ...maps, [field]: nm }); }} style={{ padding: "6px 9px", fontSize: 12.5 }} />
              <span style={{ color: C.faint }}>→</span>
              <Input value={String(v)} onChange={(e) => { let nv = e.target.value; if (/^-?\d+$/.test(nv)) nv = parseInt(nv); onChange({ ...maps, [field]: { ...m, [k]: nv } }); }} style={{ padding: "6px 9px", fontSize: 12.5 }} />
              <button onClick={() => { const nm = { ...m }; delete nm[k]; onChange({ ...maps, [field]: nm }); }} style={{ background: "none", border: "none", cursor: "pointer", color: C.faint, fontSize: 14 }}>×</button>
            </div>
          ))}
          <button onClick={() => onChange({ ...maps, [field]: { ...m, "": "" } })} style={{ fontSize: 12, color: C.brandInk, background: "none", border: "none", cursor: "pointer", fontWeight: 700, marginTop: 2 }}>+ add value</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <Input value={nf} onChange={(e) => setNf(e.target.value)} placeholder="output field name (e.g. level)" style={{ padding: "7px 10px", fontSize: 13 }} />
        <Btn variant="soft" size="sm" onClick={() => { if (nf.trim()) { onChange({ ...maps, [nf.trim()]: {} }); setNf(""); } }}>+ Map a field's values</Btn>
      </div>
    </div>
  );
}
