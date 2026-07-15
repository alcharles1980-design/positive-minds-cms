// ============================================================
// Command Palette (⌘K) — fuzzy launcher
// ============================================================
function CommandPalette({ open, onClose, commands }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef(null);
  useEffect(() => { if (open) { setQ(""); setSel(0); } }, [open]);

  const fuzzy = (text, query) => {
    if (!query) return 1;
    text = text.toLowerCase(); query = query.toLowerCase();
    if (text.includes(query)) return 2 - text.indexOf(text) / 100;
    let ti = 0, score = 0;
    for (const ch of query) { const idx = text.indexOf(ch, ti); if (idx === -1) return 0; score += 1 / (idx - ti + 1); ti = idx + 1; }
    return score / query.length;
  };
  const results = useMemo(() => commands
    .map(c => ({ ...c, score: Math.max(fuzzy(c.label, q), (c.keywords || []).reduce((m, k) => Math.max(m, fuzzy(k, q)), 0) * 0.8) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8), [commands, q]);
  useEffect(() => { setSel(0); }, [q]);

  const run = (c) => { onClose(); c.run(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); results[sel] && run(results[sel]); }
  };

  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(25,23,40,0.5)", backdropFilter: "blur(3px)", zIndex: 200, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12vh 20px 20px" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.panel, borderRadius: R.xl, width: "100%", maxWidth: 560, boxShadow: SH.xl, overflow: "hidden", border: "1px solid " + C.line }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px", borderBottom: "1px solid " + C.line }}>
          <span style={{ fontSize: 18, color: C.faint }}>⌕</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Type a command or search…" className="pm-input"
            style={{ flex: 1, border: "none", outline: "none", fontSize: 16, fontFamily: "inherit", background: "transparent", color: C.ink }} />
          <kbd style={kbdStyle}>esc</kbd>
        </div>
        <div ref={listRef} style={{ maxHeight: 340, overflowY: "auto", padding: 8 }}>
          {results.length === 0 ? (
            <div style={{ padding: "28px 16px", textAlign: "center", color: C.faint, fontSize: 14 }}>No commands match “{q}”.</div>
          ) : results.map((c, i) => (
            <button key={c.id} onClick={() => run(c)} onMouseEnter={() => setSel(i)}
              style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", padding: "11px 12px", borderRadius: R.md, border: "none", cursor: "pointer", fontFamily: "inherit",
                background: i === sel ? C.brandSoft : "transparent", color: C.ink, transition: "background .1s" }}>
              <span style={{ fontSize: 17, width: 24, textAlign: "center" }}>{c.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{c.label}</div>
                {c.hint && <div style={{ fontSize: 12, color: C.sub, marginTop: 1 }}>{c.hint}</div>}
              </div>
              {c.section && <span style={{ fontSize: 11, color: C.faint, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>{c.section}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
const kbdStyle = { fontSize: 11, fontWeight: 700, color: C.sub, background: C.lineSoft, border: "1px solid " + C.line, borderRadius: 6, padding: "2px 7px", fontFamily: "inherit" };

// ============================================================
// Play Mode — experience a pack like a child would
// ============================================================
function PlayMode({ pack, levels, onClose }) {
  const [questions, setQuestions] = useState(null);
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState(null);
  const [correct, setCorrect] = useState(0);
  const [done, setDone] = useState(false);
  // Level filter: null = play each question at its OWN effective level; a number = force
  // every question to render at that level (to preview how the pack plays at that difficulty).
  const [playLevel, setPlayLevel] = useState(null);
  const levelList = (levels && levels.length) ? levels : Array.from({ length: 10 }, (_, n) => ({ level: n + 1, name: "" }));

  useEffect(() => {
    (async () => {
      const data = await db.allQuestionsForPack(pack.id);
      setQuestions((data || []).filter(q => q.status === "active"));
    })();
  }, [pack.id]);

  const q = questions?.[i];
  const options = useMemo(() => {
    if (!q) return [];
    const opts = [q.answer, q.alt_answer].filter(Boolean);
    return opts.slice().sort(() => Math.random() - 0.5); // shuffle display order
  }, [q]);

  // The primary answer is the correct fill for the sentence; the second word is a valid
  // positive word but not the right answer here.
  const correctAnswer = (q?.answer || "").toUpperCase();
  const isRight = picked != null && picked.toUpperCase() === correctAnswer;

  const pick = (opt) => {
    if (picked) return;
    setPicked(opt);
    if ((opt || "").toUpperCase() === correctAnswer) setCorrect(c => c + 1);
    setTimeout(() => {
      if (i + 1 >= questions.length) setDone(true);
      else { setI(i + 1); setPicked(null); }
    }, 1100);
  };

  const restart = () => { setI(0); setPicked(null); setCorrect(0); setDone(false); };
  // Switch the level filter and restart the run so progress/score stay consistent.
  const changeLevel = (lvl) => { setPlayLevel(lvl); restart(); };
  // Force the chosen level by overriding the question's own level; null = its natural level.
  const pv = q ? previewAtLevel(playLevel != null ? { ...q, level: playLevel } : q, levels, pack.level) : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 150, background: `linear-gradient(160deg, ${pack.color}22, ${C.bg} 55%)`, display: "flex", flexDirection: "column", fontFamily: FONT }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid " + C.line, background: C.panel }}>
        <div style={{ fontSize: 26 }}>{pack.emoji}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>{pack.name}</div>
          <div style={{ fontSize: 12, color: C.sub }}>Play preview{questions ? ` · ${questions.length} questions` : ""}{playLevel != null ? ` · Level ${playLevel}` : ""}</div>
        </div>
        <Btn variant="ghost" size="sm" onClick={onClose}>✕ Exit</Btn>
      </div>

      {/* Level filter — play the whole pack at one level, or each at its own */}
      {questions && questions.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderBottom: "1px solid " + C.line, background: C.panel, overflowX: "auto", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, color: C.faint, letterSpacing: 0.4, flexShrink: 0 }}>PLAY AT:</span>
          <button onClick={() => changeLevel(null)} style={playChip(playLevel === null, C)}>Each own level</button>
          {levelList.map(l => (
            <button key={l.level} onClick={() => changeLevel(l.level)} title={l.name ? `Level ${l.level} — ${l.name}` : `Level ${l.level}`} style={playChip(playLevel === l.level, C, l.color)}>
              L{l.level}
            </button>
          ))}
        </div>
      )}

      {/* progress bar */}
      {questions && questions.length > 0 && !done && (
        <div style={{ height: 5, background: C.line }}>
          <div style={{ height: "100%", width: `${((i) / questions.length) * 100}%`, background: pack.color, transition: "width .3s" }} />
        </div>
      )}

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, overflowY: "auto" }}>
        {questions === null ? <Spinner label="Loading pack…" />
          : questions.length === 0 ? (
            <EmptyState icon="🫙" title="No active questions" body="This pack has no active questions to play. Add some or activate existing ones." action={<Btn onClick={onClose}>Back to editing</Btn>} />
          ) : done ? (
            <div style={{ textAlign: "center", maxWidth: 420 }}>
              <div style={{ fontSize: 56, marginBottom: 10 }}>🌟</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: C.ink }}>All done!</div>
              <div style={{ fontSize: 15, color: C.sub, margin: "8px 0 24px" }}>You got {correct} of {questions.length} correct in “{pack.name}”.</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <Btn variant="soft" onClick={restart} icon="↻">Play again</Btn>
                <Btn onClick={onClose}>Back to editing</Btn>
              </div>
            </div>
          ) : (
            <div style={{ width: "100%", maxWidth: 560, textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.faint, letterSpacing: 0.5, marginBottom: 20 }}>QUESTION {i + 1} OF {questions.length}</div>
              <div style={{ background: C.panel, borderRadius: R.xl, padding: "36px 28px", boxShadow: SH.lg, border: "1px solid " + C.line }}>
                <div style={{ fontSize: 26, fontWeight: 700, color: C.ink, lineHeight: 1.4, marginBottom: 32 }}>{pv.sentence}</div>
                <div style={{ display: "grid", gap: 12 }}>
                  {options.map(opt => {
                    const isPicked = picked === opt;
                    const optIsCorrect = opt.toUpperCase() === correctAnswer;
                    // Once answered: picked-correct = green, picked-wrong = red, and also
                    // highlight the correct answer in green so the child learns it.
                    const showGreen = picked && (isPicked ? optIsCorrect : optIsCorrect);
                    const showRed = picked && isPicked && !optIsCorrect;
                    const bg = showGreen ? C.good : showRed ? C.danger : (picked ? C.lineSoft : C.panel);
                    const bd = showGreen ? C.good : showRed ? C.danger : (isPicked ? pack.color : C.line);
                    return (
                      <button key={opt} onClick={() => pick(opt)} disabled={!!picked}
                        style={{ padding: "16px 20px", fontSize: 19, fontWeight: 800, borderRadius: R.lg, cursor: picked ? "default" : "pointer", fontFamily: "inherit",
                          border: "2px solid " + bd,
                          background: bg,
                          color: (showGreen || showRed || isPicked) ? "#fff" : C.ink, transition: "all .2s", transform: isPicked ? "scale(1.02)" : "scale(1)" }}>
                        {opt}{picked && optIsCorrect && " ✓"}{showRed && " ✗"}
                      </button>
                    );
                  })}
                </div>
                {picked && (
                  isRight
                    ? <div style={{ marginTop: 20, fontSize: 16, fontWeight: 800, color: C.good }}>Correct! ✓</div>
                    : <div style={{ marginTop: 20, fontSize: 16, fontWeight: 800, color: C.danger }}>Not quite — the answer is {correctAnswer}.</div>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: C.faint, marginTop: 16 }}>Tip: both words are positive — the correct one is the word whose spelling fits the revealed letters.</div>
            </div>
          )}
      </div>
    </div>
  );
}

// Level-filter chip in Play mode. Active chip fills with the level's color (or brand).
const playChip = (active, C, color) => ({
  flexShrink: 0, padding: "5px 11px", borderRadius: 999, fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit",
  border: "1px solid " + (active ? (color || C.brand) : C.line),
  background: active ? (color || C.brand) : C.bg,
  color: active ? "#fff" : C.sub, transition: "all .15s",
});

// ============================================================
// Content Health (lint) — flags dupes, weak, invalid questions
// ============================================================
function HealthView({ onOpenPack }) {
  const { loading, error, data, reload } = useAsync(async () => {
    const [summary, details] = await Promise.all([rpc("pm_lint"), rpc("pm_lint_details")]);
    return { summary, details: details || [] };
  }, []);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const s = data?.summary || {};
  const details = data?.details || [];
  const totalIssues = details.length;

  const sevStyle = { error: { bg: C.dangerSoft, fg: C.dangerInk, dot: C.danger, label: "Error" }, warning: { bg: C.warnSoft, fg: C.warnInk, dot: C.warn, label: "Warning" } };
  const issueLabel = {
    ambiguous: "Two correct answers",     // the only one that actively harms a child
    same_word: "Both options identical",
    invalid_template: "Invalid template",
    multi_blank: "Too many blanks",
    empty_answer: "Empty answer",
    missing_alt: "Missing 2nd option",
    bad_chars: "Odd characters",
    reused_word: "Word used twice",
    reversed_pair: "Same pair, swapped",
    overused_alt: "Predictable distractor",
    duplicate: "Duplicate",
    revealed_answer: "Answer revealed",
  };
  const ambiguousCount = s.ambiguous || 0;

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Content health</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Automated checks across your whole library.</p>
      </div>
      <div className="pm-stats" style={{ marginBottom: S.lg }}>
        <HealthStat n={loading ? "…" : ambiguousCount} label="Two correct answers" color={ambiguousCount ? C.danger : C.good} />
        <HealthStat n={loading ? "…" : totalIssues} label="Total issues" color={totalIssues ? C.warn : C.good} />
        <HealthStat n={loading ? "…" : (s.invalid_template || 0) + (s.multi_blank || 0) + (s.empty_answer || 0)} label="Broken questions" color={(s.invalid_template || s.multi_blank || s.empty_answer) ? C.danger : C.faint} />
        <HealthStat n={loading ? "…" : (s.duplicates || 0) + (s.reused_word || 0)} label="Repeats" color={(s.duplicates || s.reused_word) ? C.warn : C.faint} />
      </div>

      {/* The defect that actually harms a child gets its own banner. Two same-length words means the
          blank fits BOTH — the child picks a correct word and is told they are wrong. */}
      {!loading && ambiguousCount > 0 && (
        <div className="pm-readable" style={{ background: C.danger + "12", border: "1px solid " + C.danger + "44",
          borderRadius: R.md, padding: "13px 16px", marginBottom: S.lg, fontSize: 13.5, color: C.ink, lineHeight: 1.6 }}>
          <b style={{ color: C.danger }}>{ambiguousCount} question{ambiguousCount === 1 ? " has" : "s have"} two correct answers.</b>{" "}
          The two options are the same length, so at the higher levels — where the whole word is hidden —
          <b> both of them fit the blank</b>. A child who picks the “wrong” one has actually given a right
          answer, and is told they are wrong. Give the alternate a <b>different length</b> to fix it.
        </div>
      )}
      {loading ? <div style={{ display: "grid", gap: 10 }}>{[0,1,2].map(i => <Skeleton key={i} h={56} r={12} />)}</div>
        : totalIssues === 0 ? <EmptyState icon="✅" title="Everything looks healthy" body="No ambiguous answers, broken templates, missing options or repeats. Nice work." />
        : (
          <div style={{ display: "grid", gap: 10 }}>
            {details.map((d, idx) => {
              const sev = sevStyle[d.severity] || sevStyle.warning;
              return (
                <div key={idx} style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.md, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: sev.dot, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* The RPC returns `answer` and `code` — NOT `label` and `issue`. Reading the
                        wrong field names meant every row showed "(untitled)" with no issue type.
                        Only visible by actually reading the rendered page. */}
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{d.answer || "(no answer word)"} <span style={{ fontSize: 12, fontWeight: 600, color: sev.fg, background: sev.bg, padding: "1px 7px", borderRadius: 5, marginLeft: 6 }}>{issueLabel[d.code] || d.code}</span></div>
                    <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>{d.detail}</div>
                  </div>
                  {d.pack_id && <Btn variant="ghost" size="sm" onClick={() => onOpenPack(d.pack_id)}>Open pack</Btn>}
                </div>
              );
            })}
          </div>
        )}
      {!loading && s.thin_packs > 0 && (
        <div style={{ marginTop: S.lg, background: C.infoSoft, borderRadius: R.md, padding: "14px 16px", fontSize: 13.5, color: C.ink2 }}>
          <b>{s.thin_packs}</b> pack{s.thin_packs === 1 ? " has" : "s have"} only 1–2 questions. Consider adding more so they're satisfying to play.
        </div>
      )}
    </div>
  );
}
const HealthStat = ({ n, label, color }) => (
  <div style={{ background: C.panel, borderRadius: R.lg, padding: "18px 20px", border: "1px solid " + C.line }}>
    <div style={{ fontSize: 30, fontWeight: 800, color, lineHeight: 1 }}>{n}</div>
    <div style={{ fontSize: 12.5, color: C.sub, marginTop: 7, fontWeight: 600 }}>{label}</div>
  </div>
);

// ============================================================
// Activity Log — who changed what, when
// ============================================================
function ActivityView() {
  const { loading, error, data, reload } = useAsync(() => rest("pm_activity?order=created_at.desc&limit=100").then(r => r.data || []), []);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const rows = data || [];
  const icon = { create: "＋", update: "✎", delete: "🗑", import: "⭳", clone: "⧉", reorder: "↕", bulk: "≡" };
  const relTime = (iso) => {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  };
  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Activity</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>A running history of every change.</p>
      </div>
      {loading ? <div style={{ display: "grid", gap: 8 }}>{[0,1,2,3,4].map(i => <Skeleton key={i} h={48} r={10} />)}</div>
        : rows.length === 0 ? <EmptyState icon="📋" title="No activity yet" body="Changes you make — creating packs, editing questions, imports — will appear here." />
        : (
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
            {rows.map((r, i) => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderTop: i ? "1px solid " + C.lineSoft : "none" }}>
                <div style={{ width: 32, height: 32, borderRadius: 9, background: C.brandSoft, color: C.brandInk, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>{icon[r.action] || "•"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: C.ink }}><b style={{ fontWeight: 700, textTransform: "capitalize" }}>{r.action}</b> {r.entity} <b style={{ fontWeight: 700 }}>{r.entity_name}</b></div>
                  {r.detail && <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>{r.detail}</div>}
                </div>
                <div style={{ fontSize: 12, color: C.faint, whiteSpace: "nowrap" }}>{relTime(r.created_at)}</div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ============================================================
// Tag input (used in PackEditor)
// ============================================================
function TagInput({ tags, onChange, suggestions = [] }) {
  const [input, setInput] = useState("");
  const add = (t) => { const v = t.trim().toLowerCase(); if (v && !tags.includes(v)) onChange([...tags, v]); setInput(""); };
  const remove = (t) => onChange(tags.filter(x => x !== t));
  const avail = suggestions.filter(s => !tags.includes(s) && s.includes(input.toLowerCase())).slice(0, 6);
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "8px 10px", border: "1px solid " + C.line, borderRadius: R.md, background: C.panel, minHeight: 42 }}>
        {tags.map(t => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 700, background: C.brandSoft, color: C.brandInk, padding: "3px 8px", borderRadius: R.sm }}>
            {t}<button onClick={() => remove(t)} style={{ background: "none", border: "none", cursor: "pointer", color: C.brandInk, padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
          </span>
        ))}
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input); } else if (e.key === "Backspace" && !input && tags.length) remove(tags[tags.length - 1]); }}
          placeholder={tags.length ? "" : "Add tags…"} className="pm-input" style={{ flex: 1, minWidth: 80, border: "none", outline: "none", fontSize: 13.5, fontFamily: "inherit", background: "transparent", color: C.ink, padding: "2px 0" }} />
      </div>
      {input && avail.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {avail.map(s => <button key={s} onClick={() => add(s)} style={{ fontSize: 12, fontWeight: 600, background: C.lineSoft, color: C.sub, border: "none", borderRadius: R.sm, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>+ {s}</button>)}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Theme toggle control
// ============================================================
function ThemeToggle({ theme, mini }) {
  const opts = [{ v: "light", i: "☀", l: "Light" }, { v: "dark", i: "☾", l: "Dark" }, { v: "system", i: "◐", l: "Auto" }];
  if (mini) {
    const cur = opts.find(o => o.v === theme.pref) || opts[2];
    const next = opts[(opts.indexOf(cur) + 1) % opts.length];
    return <button onClick={() => theme.set(next.v)} title={`Theme: ${cur.l} (tap for ${next.l})`} style={{ background: "none", border: "1px solid " + C.line, borderRadius: R.md, padding: "8px 12px", fontSize: 16, cursor: "pointer", color: C.ink2, fontFamily: "inherit" }}>{cur.i}</button>;
  }
  return (
    <div style={{ display: "flex", gap: 3, background: C.lineSoft, borderRadius: R.md, padding: 3 }}>
      {opts.map(o => (
        <button key={o.v} onClick={() => theme.set(o.v)} title={o.l}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "7px 8px", borderRadius: R.sm - 1, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
            background: theme.pref === o.v ? C.panel : "transparent", color: theme.pref === o.v ? C.ink : C.sub, boxShadow: theme.pref === o.v ? SH.sm : "none" }}>
          <span style={{ fontSize: 14 }}>{o.i}</span>{o.l}
        </button>
      ))}
    </div>
  );
}
