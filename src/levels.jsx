// ============================================================
// Levels — the game's progression structure (1..10), editable.
// Level lives on packs (default) and can be overridden per question.
// ============================================================
const db_levels = {
  list: () => rest("pm_levels?order=level.asc&limit=200").then(r => r.data || []),
  update: (level, patch) => rest(`pm_levels?level=eq.${level}`, { method: "PATCH", body: patch }).then(r => r.data?.[0]),
  create: (row) => rest("pm_levels", { method: "POST", body: row }).then(r => r.data?.[0]),
  remove: (level) => rest(`pm_levels?level=eq.${level}`, { method: "DELETE" }),
};

// Per-question, per-level overrides (rows exist only where a level was hand-edited).
const db_qlevels = {
  forQuestion: (qid) => rest(`pm_question_levels?question_id=eq.${qid}&order=level.asc&limit=200`).then(r => r.data || []),
  upsert: (row) => rest("pm_question_levels", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: row }).then(r => r.data?.[0]),
  upsertMany: (rows) => rest("pm_question_levels", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: rows }).then(r => r.data || []),
  reset: (qid, level) => rest(`pm_question_levels?question_id=eq.${qid}&level=eq.${level}`, { method: "DELETE" }),
  // Which questions in a pack already have an override row at this level (so derive can skip them).
  // Chunk the id list so a large pack doesn't blow past URL-length limits.
  overridesForPackLevel: async (questionIds, level) => {
    const out = [];
    for (let i = 0; i < questionIds.length; i += 150) {
      const list = questionIds.slice(i, i + 150).join(",");
      if (!list) continue;
      const r = await rest(`pm_question_levels?level=eq.${level}&question_id=in.(${list})&select=question_id&limit=10000`);
      out.push(...(r.data || []));
    }
    return out;
  },
};

// Build all level variants for a question. `overrides` is a map { [level]: overrideRow }.
// Each variant renders the SAME concept at that level's blank difficulty.
// buildLevelVariants moved to core.jsx (shared engine, single source for previews + export).

// Small helper: a colored level chip used across the app.
function LevelChip({ level, levels, size = "sm" }) {
  const def = (levels || []).find(l => l.level === level);
  const color = def?.color || C.brand;
  const pad = size === "xs" ? "1px 7px" : "2px 9px";
  const fs = size === "xs" ? 10.5 : 11.5;
  return (
    <span title={def ? `Level ${level}: ${def.name}` : `Level ${level}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: fs, fontWeight: 800, padding: pad, borderRadius: R.pill, background: color + "1E", color, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />L{level}{def?.name ? ` · ${def.name}` : ""}
    </span>
  );
}

// ============================================================
// Levels management page
// ============================================================
function LevelsView({ levels: levelsProp, reload: reloadProp }) {
  // Prefer the shell's shared levels state (kept fresh via the pm_levels realtime subscription) so
  // this page never diverges from what PackDetail/Generator see. Fall back to a local fetch only if
  // rendered standalone without props. (useAsync always runs its fn, so when props are supplied the
  // fn returns them directly instead of hitting the network.)
  const usingShared = Array.isArray(levelsProp);
  const local = useAsync(() => usingShared ? Promise.resolve(levelsProp) : db_levels.list(), [usingShared]);
  const loading = usingShared ? false : local.loading;
  const error = usingShared ? null : local.error;
  const levels = usingShared ? levelsProp : (local.data || []);
  const reload = usingShared ? (reloadProp || (() => {})) : local.reload;
  const [edit, setEdit] = useState(null);      // an existing level being edited
  const [creating, setCreating] = useState(null); // a new (unsaved) level draft
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const topLevel = levels.length ? Math.max(...levels.map(l => l.level)) : 0;
  const nextLevel = topLevel + 1;

  const save = async (level, patch) => { await db_levels.update(level, patch); await reload(); notify(`Level ${level} updated`); };
  const createLevel = async (row) => {
    await db_levels.create(row);
    await reload();
    notify(`Level ${row.level} added`);
    try { await rpc("pm_log", { p_action: "level_added", p_detail: `Level ${row.level}: ${row.name}` }); } catch {}
  };
  const removeLevel = async (l) => {
    const ok = await confirmDialog({
      title: `Delete Level ${l.level}?`,
      body: `"${l.name}" will be removed. Any questions pinned to level ${l.level}, and any per-question overrides at this level, should be moved first. Only the highest level can be deleted to keep the ladder contiguous.`,
      confirmText: "Delete level", tone: "danger",
    });
    if (!ok) return;
    try {
      await db_levels.remove(l.level);
      await reload();
      notify(`Level ${l.level} deleted`);
      try { await rpc("pm_log", { p_action: "level_deleted", p_detail: `Level ${l.level}: ${l.name}` }); } catch {}
    } catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  // A new level pre-fills from the current top level's rules (a sensible harder-tier starting point).
  const startCreate = () => {
    const base = levels.find(l => l.level === topLevel) || {};
    setCreating({
      level: nextLevel,
      name: "", tagline: "", letters_rule: "", word_rule: "", theme: "", age_hint: "",
      hidden_mode: base.hidden_mode || "word",
      letters_hidden_default: base.letters_hidden_default ?? 9,
      letter_position: base.letter_position || "end",
      letter_grouping: base.letter_grouping || "spread",
      color: nextColor(nextLevel),
      min_word_len: base.max_word_len ?? null, max_word_len: null,
      allow_multiword: base.allow_multiword ?? false, vocab_rule: "",
      sort_order: nextLevel,
    });
  };

  return (
    <div>
      <div style={{ marginBottom: S.lg, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: S.md, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Levels</h1>
          <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>The game's progression structure. Each level defines how words are hidden, which words to use, and its theme. Add levels above the current top to extend the ladder.</p>
        </div>
        <Btn onClick={startCreate} disabled={nextLevel > 100} title={nextLevel > 100 ? "Maximum of 100 levels reached" : ""}>+ Add level {nextLevel <= 100 ? nextLevel : ""}</Btn>
      </div>

      <div style={{ background: C.brandSoft, borderRadius: R.md, padding: "12px 16px", marginBottom: S.lg, fontSize: 13, color: C.brandInk, lineHeight: 1.5 }}>
        These rules are <b>live</b> — they control exactly how every question is hidden in the game at each level. Each level sets <b>how much of the word is hidden</b> (one letter → the whole word), <b>where</b> the gaps sit, <b>which words</b> to use (length band, multi-word), and its <b>theme</b>. A pack has a default level; individual questions can override it. New levels start from the current top level's rules — tune them, then generate or derive questions for them.
      </div>

      {loading ? <div style={{ display: "grid", gap: 10 }}>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={84} r={12} />)}</div>
        : (
          <div style={{ display: "grid", gap: 10 }}>
            {levels.map(l => (
              <div key={l.level} style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, borderLeft: `5px solid ${l.color}`, padding: S.lg, display: "flex", gap: S.lg, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ width: 52, height: 52, borderRadius: 13, background: l.color + "1E", color: l.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 900, flexShrink: 0 }}>{l.level}</div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 16.5, fontWeight: 800, color: C.ink }}>{l.name}</span>
                    <Pill tone="muted">{l.hidden_mode === "word" ? "whole word" : `${l.letters_hidden_default ?? 1} letter${(l.letters_hidden_default ?? 1) === 1 ? "" : "s"}`}</Pill>
                    {wordBandLabel(l) && <Pill tone="muted">{wordBandLabel(l)}</Pill>}
                    {l.allow_multiword && <Pill tone="muted">multi-word ok</Pill>}
                    <span style={{ fontSize: 12.5, color: C.faint }}>{l.age_hint}</span>
                  </div>
                  {l.tagline && <div style={{ fontSize: 13.5, color: C.sub, marginTop: 3, fontStyle: "italic" }}>“{l.tagline}”</div>}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>{describeLevelRule(l)}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, background: C.bg, borderRadius: R.sm, padding: "5px 11px" }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: 0.3, textTransform: "uppercase" }}>Looks like</span>
                      <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, fontWeight: 800, color: l.color, letterSpacing: 2 }}>{sampleMask(l)}</span>
                    </div>
                  </div>
                  <div className="pm-level-rules" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
                    <Rule label="Letters" value={l.letters_rule} />
                    <Rule label="Words" value={l.word_rule} />
                    <Rule label="Theme" value={l.theme} />
                    {l.hidden_mode !== "word" && <Rule label="Position" value={{ start: "Towards start", middle: "Towards middle", end: "Towards end", random: "Random" }[l.letter_position] || l.letter_position} />}
                    {l.hidden_mode !== "word" && <Rule label="Grouping" value={l.letter_grouping === "spread" ? "Spread apart" : "Grouped together"} />}
                    {l.vocab_rule && <Rule label="Vocabulary" value={l.vocab_rule} />}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                  <Btn variant="ghost" size="sm" onClick={() => setEdit(l)}>Edit</Btn>
                  {l.level === topLevel && topLevel > 1 && (
                    <button onClick={() => removeLevel(l)} title="Delete this level (top level only)"
                      style={{ fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + C.line, background: "transparent", color: C.danger }}>Delete</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

      <Modal open={edit !== null} onClose={() => setEdit(null)} width={560}>
        {edit !== null && <LevelEditor level={edit} onSave={save} onClose={() => setEdit(null)} />}
      </Modal>
      <Modal open={creating !== null} onClose={() => setCreating(null)} width={560}>
        {creating !== null && <LevelEditor level={creating} isNew onSave={async (_lvl, patch) => { await createLevel({ ...creating, ...patch }); }} onClose={() => setCreating(null)} />}
      </Modal>
    </div>
  );
}
// Distinct palette entry for a new level so consecutive levels don't collide in color.
const LEVEL_PALETTE = ["#00B894","#55EFC4","#0984E3","#74B9FF","#6C4CE0","#A29BFE","#E17055","#E84393","#D63031","#2D3436","#F39C12","#00CEC9","#FD79A8","#636E72","#00A8FF"];
const nextColor = (lvl) => LEVEL_PALETTE[(lvl - 1) % LEVEL_PALETTE.length];
// Short label for a level's word-length band, if set.
function wordBandLabel(l) {
  const lo = l.min_word_len, hi = l.max_word_len;
  if (lo && hi) return `${lo}–${hi} letters`;
  if (lo) return `${lo}+ letters`;
  if (hi) return `≤${hi} letters`;
  return "";
}
const Rule = ({ label, value }) => (
  <div style={{ background: C.bg, borderRadius: R.sm, padding: "8px 11px" }}>
    <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: 0.3, textTransform: "uppercase" }}>{label}</div>
    <div style={{ fontSize: 12.5, color: C.ink2, marginTop: 2, lineHeight: 1.4 }}>{value || "—"}</div>
  </div>
);

// Plain-English description of what a level ACTUALLY does mechanically (from the real fields the
// engine uses, not the free-text rule prose). This is the "rule" in one legible sentence.
function describeLevelRule(l) {
  if (l.hidden_mode === "word") return "Hides the whole word — the child spells it from scratch.";
  const n = l.letters_hidden_default ?? 1;
  const where = { start: "toward the start", middle: "toward the middle", end: "toward the end", random: "in random spots" }[l.letter_position] || "toward the middle";
  const how = n >= 2 ? (l.letter_grouping === "spread" ? ", spread apart" : ", grouped together") : "";
  return `Hides ${n} letter${n === 1 ? "" : "s"} ${where}${how}.`;
}
// A concrete sample rendered exactly as the game would mask it at this level, so you see the shape.
function sampleMask(l) {
  const sample = "STRONG"; // 6 letters — long enough to show position/spread differences
  if (l.hidden_mode === "word") return "_".repeat(sample.length);
  const n = Math.min(l.letters_hidden_default ?? 1, sample.length - 1);
  return maskWord(sample, n, l.letter_position, l.letter_grouping);
}

function LevelEditor({ level, onSave, onClose, isNew = false }) {
  const [f, setF] = useState({ ...level });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      const minV = f.min_word_len === "" || f.min_word_len == null ? null : parseInt(f.min_word_len);
      const maxV = f.max_word_len === "" || f.max_word_len == null ? null : parseInt(f.max_word_len);
      if (minV != null && maxV != null && minV > maxV) {
        setBusy(false);
        notify("Min word length can't be greater than max word length.", "error");
        return;
      }
      await onSave(level.level, {
        name: f.name, tagline: f.tagline, letters_rule: f.letters_rule, word_rule: f.word_rule,
        theme: f.theme, age_hint: f.age_hint, hidden_mode: f.hidden_mode,
        letters_hidden_default: f.letters_hidden_default, letter_position: f.letter_position,
        letter_grouping: f.letter_grouping, color: f.color,
        min_word_len: minV, max_word_len: maxV,
        allow_multiword: !!f.allow_multiword, vocab_rule: f.vocab_rule || "",
        ...(isNew ? { level: f.level, sort_order: f.sort_order ?? f.level } : {}),
      });
      onClose();
    }
    catch (e) { setBusy(false); notify(friendlyError(0, String(e?.message || e)), "error"); }
  };
  return (
    <>
      <ModalHead title={isNew ? `Add Level ${level.level}` : `Edit Level ${level.level}`} subtitle={isNew ? "Define the new level's rules and theme" : "Define this level's rules and theme"} />
      <div style={{ padding: S.xl, display: "grid", gap: S.md + 2, maxHeight: "64vh", overflowY: "auto" }}>
        <Field label="Level name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus placeholder={isNew ? "e.g. Master Wordsmith" : ""} /></Field>
        <Field label="Tagline" hint="Short, child-friendly description"><Input value={f.tagline} onChange={(e) => set("tagline", e.target.value)} /></Field>
        <Field label="Letters rule" hint="How much of the word is hidden"><Input value={f.letters_rule} onChange={(e) => set("letters_rule", e.target.value)} /></Field>
        <Field label="Words rule" hint="Word length / complexity (free text)"><Input value={f.word_rule} onChange={(e) => set("word_rule", e.target.value)} /></Field>
        <Field label="Theme" hint="Emotional / thematic focus"><Input value={f.theme} onChange={(e) => set("theme", e.target.value)} /></Field>
        <div className="pm-form-2">
          <Field label="Age hint"><Input value={f.age_hint} onChange={(e) => set("age_hint", e.target.value)} /></Field>
          <Field label="Default letters hidden" hint="Suggested for new questions"><Input type="number" min={0} value={f.letters_hidden_default} onChange={(e) => set("letters_hidden_default", parseInt(e.target.value) || 0)} /></Field>
        </div>
        <Field label="Hidden mode" hint="How the target word is masked in the game">
          <Select value={f.hidden_mode} onChange={(e) => set("hidden_mode", e.target.value)}><option value="letters">Hide some letters</option><option value="word">Hide the whole word</option></Select>
        </Field>
        <div className="pm-form-2">
          <Field label="Missing letters position" hint="Where the gaps sit in the word">
            <Select value={f.letter_position} onChange={(e) => set("letter_position", e.target.value)} disabled={f.hidden_mode === "word"}>
              <option value="start">Towards the start</option>
              <option value="middle">Towards the middle</option>
              <option value="end">Towards the end</option>
              <option value="random">Random</option>
            </Select>
          </Field>
          <Field label="When 2+ are hidden" hint="Group them or space them out">
            <Select value={f.letter_grouping} onChange={(e) => set("letter_grouping", e.target.value)} disabled={f.hidden_mode === "word"}>
              <option value="grouped">Grouped together</option>
              <option value="spread">Spread apart</option>
            </Select>
          </Field>
        </div>

        {/* Vocabulary rules — shape WHICH answer words this level uses (drives the generator + shows intent). */}
        <div style={{ borderTop: "1px solid " + C.line, paddingTop: S.md }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.faint, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 8 }}>Vocabulary rules</div>
          <div className="pm-form-2">
            <Field label="Min word length" hint="Blank = no minimum"><Input type="number" min={1} max={40} value={f.min_word_len ?? ""} onChange={(e) => set("min_word_len", e.target.value)} placeholder="—" /></Field>
            <Field label="Max word length" hint="Blank = no maximum"><Input type="number" min={1} max={40} value={f.max_word_len ?? ""} onChange={(e) => set("max_word_len", e.target.value)} placeholder="—" /></Field>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 13.5, color: C.ink2, marginTop: 4 }}>
            <input type="checkbox" checked={!!f.allow_multiword} onChange={(e) => set("allow_multiword", e.target.checked)} style={{ width: 16, height: 16 }} />
            Allow two-word answers / short phrases
          </label>
          <Field label="Vocabulary guidance" hint="Free text passed to the AI generator (e.g. 'nuanced emotional-regulation words, GCSE-level')" style={{ marginTop: S.sm }}>
            <Textarea rows={2} value={f.vocab_rule || ""} onChange={(e) => set("vocab_rule", e.target.value)} />
          </Field>
        </div>

        <div style={{ background: C.bg, borderRadius: R.md, padding: "11px 14px" }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 6 }}>Example shape</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {["BRAVE", "HELPFUL", "KIND"].map(w => (
              <span key={w} style={{ fontFamily: "ui-monospace, monospace", fontSize: 16, fontWeight: 700, letterSpacing: 3, color: C.brandInk }}>
                {f.hidden_mode === "word" ? "_".repeat(Math.max(3, w.length)) : maskWord(w, Math.min(f.letters_hidden_default, w.length - 1), f.letter_position, f.letter_grouping)}
              </span>
            ))}
          </div>
        </div>
        <Field label="Color">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {["#00B894","#55EFC4","#0984E3","#74B9FF","#6C4CE0","#A29BFE","#E17055","#E84393","#D63031","#2D3436","#F39C12","#00CEC9","#FD79A8","#636E72","#00A8FF"].map(c => (
              <button key={c} onClick={() => set("color", c)}
                aria-label={`Use colour ${c}`} title={c}
                aria-pressed={f.color === c}
                style={{ width: 30, height: 30, borderRadius: R.sm, cursor: "pointer", background: c, border: "3px solid " + (f.color === c ? C.ink : "transparent") }} />
            ))}
          </div>
        </Field>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || !f.name}>{busy ? "Saving…" : (isNew ? "Add level" : "Save level")}</Btn>
      </ModalFoot>
    </>
  );
}

// ============================================================
// Expandable per-question level variants (shown in the question bank)
// ============================================================
function QuestionLevelsPanel({ question, packLevel, levels }) {
  const { loading, data, reload } = useAsync(() => db_qlevels.forQuestion(question.id), [question.id]);
  const [editLevel, setEditLevel] = useState(null);
  const overrides = {};
  (data || []).forEach(r => { overrides[r.level] = r; });
  const variants = buildLevelVariants(question, levels, overrides);

  const saveOverride = async (level, patch) => {
    await db_qlevels.upsert({ question_id: question.id, level, ...patch });
    await reload(); notify(`Level ${level} version updated`);
  };
  const resetLevel = async (level) => {
    const ok = await confirmDialog({ title: `Reset Level ${level}?`, body: "This level will go back to the auto-generated version.", confirmText: "Reset", tone: "danger" });
    if (!ok) return;
    await db_qlevels.reset(question.id, level); await reload(); notify(`Level ${level} reset to auto`);
  };

  if (loading) return <div style={{ padding: S.md }}><Spinner label="Loading levels…" /></div>;

  return (
    <div style={{ padding: "4px 2px 2px", display: "grid", gap: 6 }}>
      <div style={{ fontSize: 11.5, color: C.faint, fontWeight: 700, padding: "2px 4px 6px" }}>
        The same question at every level. Auto-generated from the level rules; edit any to customize.
      </div>
      {variants.map(v => (
        <div key={v.level} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", background: v.enabled ? C.bg : C.lineSoft, borderRadius: R.sm, border: "1px solid " + C.lineSoft, borderLeft: `3px solid ${v.color}`, opacity: v.enabled ? 1 : 0.5 }}>
          <div style={{ width: 30, flexShrink: 0, fontSize: 12, fontWeight: 900, color: v.color }}>L{v.level}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, color: C.ink, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v.sentence}</div>
            <div style={{ fontSize: 11, color: C.faint, marginTop: 1 }}>{v.name}{v.isOverride && <span style={{ color: C.brandInk, fontWeight: 700 }}> · edited</span>}</div>
          </div>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, fontWeight: 700, letterSpacing: 2, color: v.color, flexShrink: 0 }}>{v.blank}</span>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button onClick={() => setEditLevel(v)} title="Edit this level" style={miniBtn(C)}>Edit</button>
            {v.isOverride && <button onClick={() => resetLevel(v.level)} title="Reset to auto" style={miniBtn(C, true)}>↺</button>}
          </div>
        </div>
      ))}
      <Modal open={editLevel !== null} onClose={() => setEditLevel(null)} width={520}>
        {editLevel !== null && <QuestionLevelEditor question={question} variant={editLevel} onSave={saveOverride} onClose={() => setEditLevel(null)} />}
      </Modal>
    </div>
  );
}
const miniBtn = (C, ghost) => ({ fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid " + C.line, background: ghost ? "transparent" : C.panel, color: ghost ? C.sub : C.ink2 });

function QuestionLevelEditor({ question, variant, onSave, onClose }) {
  const ov = variant.override || {};
  const [f, setF] = useState({
    template: ov.template ?? "", answer: ov.answer ?? "", alt_answer: ov.alt_answer ?? "",
    letters_hidden: ov.letters_hidden ?? "", letter_position: ov.letter_position ?? "", letter_grouping: ov.letter_grouping ?? "",
    enabled: ov.enabled !== false,
  });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setF(p => ({ ...p, [k]: val }));
  // live preview using the overrides-on-top-of-concept
  const merged = { template: f.template || question.template, answer: f.answer || question.answer, alt_answer: f.alt_answer || question.alt_answer };
  const previewLetters = f.letters_hidden === "" ? variant.letters : parseInt(f.letters_hidden);
  const pos = f.letter_position || variant.position, grp = f.letter_grouping || variant.grouping;
  const word = (merged.answer || "").toUpperCase();
  const blank = (variant.target?.wholeWord && f.letters_hidden === "") || previewLetters >= word.length ? "_".repeat(Math.max(3, word.length)) : maskWord(word, previewLetters || 0, pos, grp);
  const previewSentence = (merged.template || "").replace(/\{blank\}/g, blank);

  const submit = async () => {
    setBusy(true);
    const patch = {
      template: f.template.trim() || null, answer: f.answer.trim().toUpperCase() || null, alt_answer: f.alt_answer.trim().toUpperCase() || null,
      letters_hidden: (f.letters_hidden === "" || isNaN(parseInt(f.letters_hidden))) ? null : Math.max(0, parseInt(f.letters_hidden)),
      letter_position: f.letter_position || null, letter_grouping: f.letter_grouping || null, enabled: f.enabled,
    };
    try { await onSave(variant.level, patch); onClose(); } catch { setBusy(false); }
  };
  return (
    <>
      <ModalHead title={`Level ${variant.level} — ${variant.name}`} subtitle="Customize this level's version. Leave a field blank to keep the auto value." />
      <div style={{ padding: S.xl, display: "grid", gap: S.md, maxHeight: "60vh", overflowY: "auto" }}>
        <div style={{ background: C.brandSoft, borderRadius: R.md, padding: "12px 14px" }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: C.brandInk, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6 }}>How the child sees it</div>
          <div style={{ fontSize: 15, color: C.ink, fontWeight: 500 }}>{previewSentence}</div>
          <div style={{ fontSize: 12.5, color: C.brandInk, fontWeight: 800, marginTop: 4 }}>→ {[merged.answer, merged.alt_answer].filter(Boolean).map(w => w.toUpperCase()).join(" / ")}</div>
        </div>
        <Field label="Sentence" hint="Blank to inherit the concept's sentence"><Textarea value={f.template} onChange={(e) => set("template", e.target.value)} rows={2} placeholder={question.template} /></Field>
        <div className="pm-form-2">
          <Field label="Word" hint="Blank = inherit"><Input value={f.answer} onChange={(e) => set("answer", e.target.value)} placeholder={question.answer} /></Field>
          <Field label="Alt word" hint="Blank = inherit"><Input value={f.alt_answer} onChange={(e) => set("alt_answer", e.target.value)} placeholder={question.alt_answer || "—"} /></Field>
        </div>
        <div className="pm-form-2">
          <Field label="Letters hidden" hint="Blank = level default"><Input type="number" min={0} value={f.letters_hidden} onChange={(e) => set("letters_hidden", e.target.value)} placeholder={String(variant.letters)} /></Field>
          <Field label="Enabled" hint="Turn this level off for this concept">
            <Select value={f.enabled ? "yes" : "no"} onChange={(e) => set("enabled", e.target.value === "yes")}><option value="yes">Enabled</option><option value="no">Disabled</option></Select>
          </Field>
        </div>
        <div className="pm-form-2">
          <Field label="Position" hint="Blank = level default">
            <Select value={f.letter_position} onChange={(e) => set("letter_position", e.target.value)}>
              <option value="">Inherit level</option><option value="start">Towards start</option><option value="middle">Towards middle</option><option value="end">Towards end</option><option value="random">Random</option>
            </Select>
          </Field>
          <Field label="Grouping" hint="Blank = level default">
            <Select value={f.letter_grouping} onChange={(e) => set("letter_grouping", e.target.value)}>
              <option value="">Inherit level</option><option value="grouped">Grouped</option><option value="spread">Spread</option>
            </Select>
          </Field>
        </div>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save this level"}</Btn>
      </ModalFoot>
    </>
  );
}

// ============================================================
// Derive a level across a whole pack — materialize editable override rows for a target level,
// pre-filled by applying that level's masking rule to each question's current word. Handy when
// you add a new high level and want per-question rows you can then hand-tune. (A new level ALSO
// renders automatically for every question via the shared engine — this is only for when you want
// explicit, editable per-question versions at that level.)
// ============================================================
function DeriveLevelDialog({ pack, questions, levels, onClose, onDone }) {
  const [targetLevel, setTargetLevel] = useState(() => (levels && levels.length ? Math.max(...levels.map(l => l.level)) : 1));
  const [mode, setMode] = useState("skip"); // skip | overwrite
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // Array.isArray, not `|| []` — the latter only catches null/undefined. If this prop ever arrives
  // as an object (a shape change upstream), .filter() throws and the whole page goes white.
  const activeQs = (Array.isArray(questions) ? questions : []).filter(q => q.status === "active");
  const lvlDef = (levels || []).find(l => l.level === targetLevel);

  // Preview the first few masked results for the chosen level.
  const preview = React.useMemo(() => {
    if (!lvlDef) return [];
    return activeQs.slice(0, 4).map(q => {
      const v = buildLevelVariants(q, [lvlDef], {})[0];
      return { answer: q.answer, blank: v?.blank || "", sentence: v?.sentence || "" };
    });
  }, [lvlDef, activeQs]);

  const run = async () => {
    if (!lvlDef) return;
    setBusy(true);
    try {
      const ids = activeQs.map(q => q.id);
      // Which already have an override at this level?
      let skipIds = new Set();
      if (mode === "skip") {
        const existing = await db_qlevels.overridesForPackLevel(ids, targetLevel);
        skipIds = new Set(existing.map(r => r.question_id));
      }
      const targets = activeQs.filter(q => !skipIds.has(q.id));
      const isWordLevel = lvlDef.hidden_mode === "word";
      // Build override rows. For a LETTERS level we pin the computed letter count/position/grouping
      // so the row is concrete and editable. For a WORD level we intentionally leave letters_hidden
      // null (the level already forces whole-word); pinning a fixed number would freeze to the
      // word's current length and silently break if the word is later edited. template/answer/alt
      // stay null so the concept's own text still flows through.
      const rows = targets.map(q => {
        const v = buildLevelVariants(q, [lvlDef], {})[0];
        return {
          question_id: q.id, level: targetLevel,
          template: null, answer: null, alt_answer: null,
          letters_hidden: isWordLevel ? null : (v?.letters ?? lvlDef.letters_hidden_default ?? 1),
          letter_position: isWordLevel ? null : (lvlDef.letter_position || null),
          letter_grouping: isWordLevel ? null : (lvlDef.letter_grouping || null),
          enabled: true,
        };
      });
      let written = 0;
      // Upsert in chunks to stay well under any payload limits.
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        if (chunk.length) { await db_qlevels.upsertMany(chunk); written += chunk.length; }
      }
      setResult({ written, skipped: skipIds.size, total: activeQs.length });
      try { await rpc("pm_log", { p_action: "level_derived", p_detail: `L${targetLevel} across ${pack.slug}: ${written} rows` }); } catch {}
      notify(`Derived Level ${targetLevel} for ${written} question${written === 1 ? "" : "s"}`);
      onDone && onDone();
    } catch (e) {
      notify(friendlyError(0, String(e?.message || e)), "error");
    } finally { setBusy(false); }
  };

  return (
    <>
      <ModalHead title="Derive a level across this pack" subtitle={`Create editable per-question versions at a chosen level for “${pack.name}”`} />
      <div style={{ padding: S.xl, display: "grid", gap: S.md, maxHeight: "64vh", overflowY: "auto" }}>
        <div style={{ background: C.brandSoft, borderRadius: R.md, padding: "11px 14px", fontSize: 12.5, color: C.brandInk, lineHeight: 1.5 }}>
          A new level already renders automatically for every question. Use this only when you want concrete, <b>editable</b> rows at a level so you can hand-tune individual questions. It applies the level's masking rule to each question's current word.
        </div>
        <div className="pm-form-2">
          <Field label="Target level">
            <Select value={targetLevel} onChange={(e) => setTargetLevel(parseInt(e.target.value))}>
              {(levels || []).map(l => <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>)}
            </Select>
          </Field>
          <Field label="If a version already exists">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="skip">Skip those questions</option>
              <option value="overwrite">Overwrite them</option>
            </Select>
          </Field>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub }}>
          {activeQs.length} active question{activeQs.length === 1 ? "" : "s"} in this pack{lvlDef ? "" : " · pick a level"}.
        </div>
        {preview.length > 0 && (
          <div style={{ background: C.bg, borderRadius: R.md, padding: "11px 14px" }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 8 }}>Preview at Level {targetLevel}</div>
            <div style={{ display: "grid", gap: 7 }}>
              {preview.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 12.5, color: C.sub, minWidth: 70, fontWeight: 700 }}>{p.answer}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13.5, fontWeight: 800, letterSpacing: 2, color: lvlDef?.color || C.brand }}>{p.blank}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {result && (
          <div style={{ background: "#00B89415", border: "1px solid #00B89440", borderRadius: R.md, padding: "11px 14px", fontSize: 13, color: C.ink }}>
            Done — <b>{result.written}</b> version{result.written === 1 ? "" : "s"} written{result.skipped ? `, ${result.skipped} skipped` : ""} (of {result.total} active).
          </div>
        )}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>{result ? "Close" : "Cancel"}</Btn>
        {!result && <Btn onClick={run} disabled={busy || !lvlDef || activeQs.length === 0}>{busy ? "Deriving…" : `Derive Level ${targetLevel}`}</Btn>}
      </ModalFoot>
    </>
  );
}
