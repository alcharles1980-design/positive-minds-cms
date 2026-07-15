// ============================================================
// Pack detail — paginated question bank with multi-select
// ============================================================
function PackDetail({ pack, levels, onBack, refreshPacks, onEditPack }) {
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [qEdit, setQEdit] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [play, setPlay] = useState(false);
  const [derive, setDerive] = useState(false);
  const [deriveQs, setDeriveQs] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [search, setSearch] = useState("");
  const [lvlF, setLvlF] = useState("all");
  const [datePreset, setDatePreset] = useState("all"); // all | 24h | 7d | 30d
  const [sortBy, setSortBy] = useState("order"); // order | recent | oldest
  const dateWindow = useMemo(() => {
    const now = Date.now();
    if (datePreset === "24h") return { from: new Date(now - 864e5).toISOString(), to: null };
    if (datePreset === "7d") return { from: new Date(now - 7 * 864e5).toISOString(), to: null };
    if (datePreset === "30d") return { from: new Date(now - 30 * 864e5).toISOString(), to: null };
    return { from: null, to: null };
  }, [datePreset]);

  const load = useCallback(async () => {
    setErr("");
    try {
      const { data, total } = await db.questions(pack.id, {
        page,
        fromDate: dateWindow.from, toDate: dateWindow.to,
        level: lvlF === "all" ? null : parseInt(lvlF), packLevel: pack.level,
        sort: sortBy,
      });
      setRows(data || []); setTotal(total || 0);
    } catch (e) { setErr(e.message); }
  }, [pack.id, page, dateWindow, lvlF, sortBy]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [dateWindow, lvlF, sortBy]);

  // Live sync: if another device changes a question in THIS pack (or its per-level
  // overrides), reload the list. Filter to this pack to avoid needless reloads.
  useRealtimeRefresh(["pm_questions", "pm_question_levels"], (info) => {
    const rec = info.record || info.old || {};
    if (info.table === "pm_questions" && rec.pack_id && rec.pack_id !== pack.id) return;
    load();
  }, [load, pack.id]);

  const afterChange = async () => { await load(); refreshPacks(); setSel(new Set()); };

  const saveQ = async (payload, id) => { id ? await db.updateQuestion(id, payload) : await db.createQuestion(payload); await afterChange(); notify(id ? "Question updated" : "Question added"); };
  // Imports no longer land in the pack — they go to the AI Review queue for approval. So there is
  // nothing to insert here; just refresh (the queue count updates) and point the user at Review.
  const importQ = async () => { await afterChange(); };
  const delQ = async (q) => {
    const ok = await confirmDialog({ title: "Delete question?", message: "This can't be undone.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try { await db.deleteQuestion(q.id); await afterChange(); notify("Question deleted"); } catch (e) { notify("Couldn't delete: " + e.message, { kind: "error" }); }
  };
  const toggleQ = async (q) => { try { await db.updateQuestion(q.id, { status: q.status === "active" ? "inactive" : "active" }); await afterChange(); } catch (e) { notify("Couldn't update status: " + e.message, { kind: "error" }); } };

  const bulkDelete = async () => {
    const ids = [...sel];
    const ok = await confirmDialog({ title: `Delete ${ids.length} questions?`, message: "This permanently removes the selected questions.", confirmLabel: `Delete ${ids.length}`, danger: true });
    if (!ok) return;
    try { await db.deleteQuestions(ids); await afterChange(); notify(`${ids.length} questions deleted`); } catch (e) { notify("Bulk delete failed: " + e.message, { kind: "error" }); }
  };
  const bulkStatus = async (status) => { const ids = [...sel]; try { await db.setQuestionsStatus(ids, status); await afterChange(); notify(`${ids.length} set to ${status}`); } catch (e) { notify("Bulk update failed: " + e.message, { kind: "error" }); } };

  // True when a server-side filter (date window or level) is narrowing the pack.
  const isFiltered = datePreset !== "all" || lvlF !== "all";
  // Date filter, level filter, and sort are now applied server-side (in db.questions) so they
  // span the whole pack and paginate correctly. Only the quick text search stays client-side.
  const shown = (rows || []).filter(q => {
    if (search && !`${q.template} ${q.answer} ${q.alt_answer}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const allSelected = shown.length > 0 && shown.every(q => sel.has(q.id));
  const toggleSel = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(shown.map(q => q.id)));

  const pages = Math.ceil(total / CFG.pageSize);

  return (
    <div>
      <button onClick={onBack} style={{ background: "none", border: "none", color: C.sub, cursor: "pointer", fontSize: 13.5, fontWeight: 700, padding: 0, marginBottom: S.lg, display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>← All packs</button>

      <div style={{ background: C.panel, borderRadius: R.lg, padding: S.xl, marginBottom: S.lg + 2, border: "1px solid " + C.line, borderLeft: `5px solid ${pack.color}`, display: "flex", alignItems: "flex-start", gap: S.lg }}>
        <div style={{ fontSize: 42, lineHeight: 1 }}>{pack.emoji}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 23, fontWeight: 800, color: C.ink }}>{pack.name}</h1>
            <Badge kind={pack.status} /><Pill>{pack.difficulty}</Pill>{pack.is_custom && <Pill tone="muted">custom</Pill>}
          </div>
          {pack.description && <p style={{ margin: "8px 0 0", color: C.sub, fontSize: 14.5, lineHeight: 1.5 }}>{pack.description}</p>}
          {pack.tags?.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>{pack.tags.map(t => <span key={t} style={{ fontSize: 11.5, fontWeight: 700, background: C.lineSoft, color: C.sub, padding: "2px 8px", borderRadius: R.sm }}>#{t}</span>)}</div>}
          <div style={{ marginTop: S.md, fontSize: 13, color: C.faint }}><b style={{ color: C.ink }}>{pack.total_questions ?? total}</b> question{(pack.total_questions ?? total) === 1 ? "" : "s"}{isFiltered && total !== (pack.total_questions ?? total) ? ` · ${total} match filter` : ""} · slug <code style={{ background: C.bg, padding: "1px 6px", borderRadius: 5 }}>{pack.slug}</code></div>
        </div>
        <div className="pm-pack-actions" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Btn variant="soft" size="sm" onClick={() => setPlay(true)} icon="▶">Play</Btn>
          {onEditPack && <Btn variant="ghost" size="sm" onClick={() => onEditPack(pack)} icon="✎">Edit</Btn>}
          <Btn variant="ghost" size="sm" onClick={() => setDerive(true)} icon="⚙">Derive level</Btn>
        </div>
      </div>

      {(pack.purpose || pack.focus_areas || pack.style_approach || pack.example_objectives) && (
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.lg }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: C.brandInk, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: S.md }}>About this pack</div>
          <div className="pm-about-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.md }}>
            {pack.purpose && <AboutItem label="Purpose" value={pack.purpose} />}
            {pack.focus_areas && <AboutItem label="Focus areas" value={pack.focus_areas} />}
            {pack.style_approach && <AboutItem label="Style & approach" value={pack.style_approach} />}
            {pack.example_objectives && <AboutItem label="Example objectives" value={pack.example_objectives} />}
          </div>
        </div>
      )}

      {sel.size > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: S.md, marginBottom: S.md + 2, background: C.brandSoft, borderRadius: R.md, padding: `${S.sm + 2}px ${S.md + 2}px`, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: C.brandInk }}>{sel.size} selected</span>
          <div className="pm-grow" />
          <Btn variant="soft" size="sm" onClick={() => bulkStatus("active")}>Activate</Btn>
          <Btn variant="soft" size="sm" onClick={() => bulkStatus("inactive")}>Deactivate</Btn>
          <Btn variant="danger" size="sm" onClick={bulkDelete}>Delete</Btn>
          <Btn variant="dim" size="sm" onClick={() => setSel(new Set())}>Clear</Btn>
        </div>
      ) : (
        <div className="pm-toolbar" style={{ marginBottom: S.md + 2 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>Question bank</h2>
          <div className="pm-grow" />
          <SearchBox value={search} onChange={setSearch} placeholder="Search…" />
          <Select value={lvlF} onChange={(e) => setLvlF(e.target.value)} aria-label="Filter by level" title="Filter by level" style={{ minWidth: 130, padding: "8px 12px" }}>
            <option value="all">All levels</option>
            {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
              <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
            ))}
          </Select>
          <Select value={datePreset} onChange={(e) => setDatePreset(e.target.value)} aria-label="Filter by date added" title="Filter by date added" style={{ minWidth: 130, padding: "8px 12px" }} title="Filter by when the question was added">
            <option value="all">Any time added</option>
            <option value="24h">Added last 24h</option>
            <option value="7d">Added last 7 days</option>
            <option value="30d">Added last 30 days</option>
          </Select>
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort order" title="Sort order" style={{ minWidth: 120, padding: "8px 12px" }} title="Sort order">
            <option value="order">Default order</option>
            <option value="recent">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
          <Btn variant="soft" size="sm" onClick={() => setBulk(true)} icon="⭳">Import</Btn>
          <Btn size="sm" onClick={() => setQEdit({})} icon="＋">Add</Btn>
        </div>
      )}

      {err ? <ErrorState error={err} onRetry={load} />
        : rows === null ? <div style={{ display: "grid", gap: 10 }}>{[0,1,2,3].map(i => <Skeleton key={i} h={62} r={12} />)}</div>
        : shown.length === 0 ? (
          <EmptyState icon="✍️" title={total === 0 ? "No questions yet" : "Nothing matches"} body={total === 0 ? "Add your first question to this pack." : "Try a different search or filter."} action={total === 0 ? <Btn onClick={() => setQEdit({})} icon="＋">Add first question</Btn> : null} />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px 10px" }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 16, height: 16, accentColor: C.brand }} />
              <span style={{ fontSize: 12.5, color: C.faint, fontWeight: 600 }}>Select all on this page</span>
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {shown.map(q => {
                const pv = previewAtLevel(q, levels, pack.level);
                const selected = sel.has(q.id);
                const isOpen = expanded.has(q.id);
                return (
                  <div key={q.id} style={{ borderRadius: R.md, border: "1px solid " + (selected ? C.brand : isOpen ? C.brand2 : C.line), background: selected ? C.brandSoft : C.panel, overflow: "hidden", opacity: q.status === "active" ? 1 : 0.6 }}>
                  <div className="pm-qrow" style={{ background: "transparent", border: "none", borderRadius: 0 }}>
                    <input type="checkbox" className="pm-qrow-check" checked={selected} onChange={() => toggleSel(q.id)} aria-label="Select question" style={{ width: 18, height: 18, accentColor: C.brand, flexShrink: 0 }} />
                    <div className="pm-qrow-main">
                      <div className="pm-qrow-sentence" style={{ color: C.ink, fontWeight: 500 }}>{pv.sentence}</div>
                      <div style={{ fontSize: 13.5, color: C.brandInk, fontWeight: 800, marginTop: 4 }}>→ {pv.opts}</div>
                    </div>
                    <div className="pm-qrow-meta">
                      <button onClick={() => toggleExpand(q.id)} title={isOpen ? "Hide levels" : "Show all levels"} aria-expanded={isOpen} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: isOpen ? C.brandSoft : C.bg, border: "1px solid " + (isOpen ? C.brand : C.line), borderRadius: R.pill, padding: "3px 10px", cursor: "pointer", color: isOpen ? C.brandInk : C.sub, fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>
                        <span style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", fontSize: 10 }}>▶</span>Levels
                      </button>
                      <LevelChip level={q.level || pack.level} levels={levels} size="xs" />
                      {q.created_at && <span title={`Added ${new Date(q.created_at).toLocaleString()}`} style={{ fontSize: 11, color: C.faint, fontWeight: 600, whiteSpace: "nowrap" }}>{relativeTime(q.created_at)}</span>}
                      <button onClick={() => toggleQ(q)} title="Toggle active" style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}><Badge kind={q.status} /></button>
                    </div>
                    <div className="pm-qrow-actions">
                      <Btn variant="ghost" size="sm" onClick={() => setQEdit(q)}>Edit</Btn>
                      <Btn variant="danger" size="sm" onClick={() => delQ(q)}>Delete</Btn>
                    </div>
                  </div>
                  {isOpen && (
                    <div style={{ borderTop: "1px solid " + C.lineSoft, background: C.bg + "80", padding: "8px 12px 10px" }}>
                      <QuestionLevelsPanel question={q} packLevel={pack.level} levels={levels} />
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
            {pages > 1 && <Pager page={page} pages={pages} onPage={(p) => { setPage(p); setSel(new Set()); }} />}
          </>
        )}

      <Modal open={qEdit !== null} onClose={() => setQEdit(null)} labelledBy="pm-q-title">
        {qEdit !== null && <QuestionEditor question={qEdit.id ? qEdit : null} packId={pack.id} packLevel={pack.level} levels={levels} onSave={saveQ} onClose={() => setQEdit(null)} />}
      </Modal>
      <Modal open={bulk} onClose={() => setBulk(false)} labelledBy="pm-imp-title">
        {bulk && <BulkImport packId={pack.id} levels={levels} packLevel={pack.level} onDone={importQ} onClose={() => setBulk(false)} />}
      </Modal>
      <Modal open={derive} onClose={() => setDerive(false)} width={560}>
        {derive && (
          <DeriveLevelGate pack={pack} levels={levels}
            onClose={() => setDerive(false)}
            onDone={afterChange} />
        )}
      </Modal>
      {play && <PlayMode pack={pack} levels={levels} onClose={() => setPlay(false)} />}
    </div>
  );
}

// Loads ALL active questions for the pack (past the paginated view) then hands off to the dialog.
function DeriveLevelGate({ pack, levels, onClose, onDone }) {
  const { loading, error, data } = useAsync(() => db.allQuestionsForPack(pack.id), [pack.id]);
  if (loading) return <div style={{ padding: S.xl }}><Spinner label="Loading pack questions…" /></div>;
  if (error) return <div style={{ padding: S.xl }}><ErrorState error={error} /></div>;
  return <DeriveLevelDialog pack={pack} questions={data || []} levels={levels} onClose={onClose} onDone={onDone} />;
}

const Pager = ({ page, pages, onPage }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: S.sm, marginTop: S.xl }}>
    <Btn variant="ghost" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>← Prev</Btn>
    <span style={{ fontSize: 13, color: C.sub, fontWeight: 600, padding: "0 8px" }}>Page {page + 1} of {pages}</span>
    <Btn variant="ghost" size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next →</Btn>
  </div>
);

// ============================================================
// All questions — global search across every pack (server-side)
// ============================================================
function AllQuestions({ onOpenPack, levels, packs }) {
  const [q, setQ] = useState("");
  const [stat, setStat] = useState("all");
  const [lvl, setLvl] = useState("all");
  const [packF, setPackF] = useState("all"); // pack id or "all"
  const [datePreset, setDatePreset] = useState("all"); // all | 24h | 7d | 30d | custom
  const [fromDate, setFromDate] = useState(""); // yyyy-mm-dd (custom range)
  const [toDate, setToDate] = useState("");
  const [sort, setSort] = useState("recent"); // recent | oldest | pack
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState("");
  const debounced = useDebounced(q, 250);

  // Resolve the date preset to an actual [from, to) window (ISO strings or null).
  const dateWindow = useMemo(() => {
    const now = Date.now();
    if (datePreset === "24h") return { from: new Date(now - 864e5).toISOString(), to: null };
    if (datePreset === "7d") return { from: new Date(now - 7 * 864e5).toISOString(), to: null };
    if (datePreset === "30d") return { from: new Date(now - 30 * 864e5).toISOString(), to: null };
    if (datePreset === "custom") return {
      from: fromDate ? new Date(fromDate + "T00:00:00").toISOString() : null,
      // inclusive end-of-day: add a day so the whole toDate is included
      to: toDate ? new Date(new Date(toDate + "T00:00:00").getTime() + 864e5).toISOString() : null,
    };
    return { from: null, to: null };
  }, [datePreset, fromDate, toDate]);

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await db.searchQuestions({ q: debounced, pack: packF === "all" ? null : packF, stat: stat === "all" ? null : stat, lvl: lvl === "all" ? null : parseInt(lvl), lim: CFG.pageSize, off: page * CFG.pageSize, from_date: dateWindow.from, to_date: dateWindow.to, sort: sort === "pack" ? null : sort });
      setRows(r || []); setTotal(r?.[0]?.total_count ? Number(r[0].total_count) : 0);
    } catch (e) { setErr(e.message); }
  }, [debounced, stat, lvl, packF, page, dateWindow, sort]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(0); }, [debounced, stat, lvl, packF, dateWindow, sort]);

  // Live sync: refresh the global search when questions change anywhere.
  useRealtimeRefresh(["pm_questions", "pm_question_levels"], () => load(), [load]);

  const pages = Math.ceil(total / CFG.pageSize);

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>All questions</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Search across every pack{total ? ` · ${total} match${total === 1 ? "" : "es"}` : ""}</p>
      </div>
      <div className="pm-toolbar" style={{ marginBottom: S.lg }}>
        <SearchBox value={q} onChange={setQ} placeholder="Search all questions…" autoFocus />
        <Select value={packF} onChange={(e) => setPackF(e.target.value)} aria-label="Filter by pack" title="Filter by pack" style={{ minWidth: 160, padding: "8px 12px" }} title="Filter by pack">
          <option value="all">All packs</option>
          {[...(packs || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(p => (
            <option key={p.id} value={p.id}>{p.emoji ? p.emoji + " " : ""}{p.name}</option>
          ))}
        </Select>
        <Select value={lvl} onChange={(e) => setLvl(e.target.value)} aria-label="Filter by level" title="Filter by level" style={{ minWidth: 140, padding: "8px 12px" }}>
          <option value="all">All levels</option>
          {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
            <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
          ))}
        </Select>
        <Select value={stat} onChange={(e) => setStat(e.target.value)} aria-label="Filter by status" title="Filter by status" style={{ minWidth: 130, padding: "8px 12px" }}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </Select>
        <Select value={datePreset} onChange={(e) => setDatePreset(e.target.value)} aria-label="Filter by date added" title="Filter by date added" style={{ minWidth: 140, padding: "8px 12px" }} title="Filter by when the question was added">
          <option value="all">Any time added</option>
          <option value="24h">Added last 24 hours</option>
          <option value="7d">Added last 7 days</option>
          <option value="30d">Added last 30 days</option>
          <option value="custom">Custom date range…</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort order" title="Sort order" style={{ minWidth: 130, padding: "8px 12px" }} title="Sort order">
          <option value="recent">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="pack">Group by pack</option>
        </Select>
        {(q || packF !== "all" || lvl !== "all" || stat !== "all" || datePreset !== "all" || sort !== "recent") && (
          <Btn variant="ghost" size="sm" onClick={() => { setQ(""); setPackF("all"); setLvl("all"); setStat("all"); setDatePreset("all"); setFromDate(""); setToDate(""); setSort("recent"); }} title="Clear all filters">Clear filters</Btn>
        )}
      </div>
      {datePreset === "custom" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: S.md, padding: "10px 12px", background: C.panel, border: "1px solid " + C.line, borderRadius: R.md }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Added between</span>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="From date" title="From date" style={{ width: 160, padding: "7px 10px" }} />
          <span style={{ fontSize: 12.5, color: C.faint }}>and</span>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="To date" title="To date" style={{ width: 160, padding: "7px 10px" }} />
          {(fromDate || toDate) && <Btn variant="ghost" size="sm" onClick={() => { setFromDate(""); setToDate(""); }}>Clear</Btn>}
        </div>
      )}
      {err ? <ErrorState error={err} onRetry={load} />
        : rows === null ? <div style={{ display: "grid", gap: 10 }}>{[0,1,2,3,4].map(i => <Skeleton key={i} h={58} r={12} />)}</div>
        : rows.length === 0 ? <EmptyState icon="🔍" title="No matches" body={
            (debounced || packF !== "all" || lvl !== "all" || stat !== "all" || datePreset !== "all")
              ? "No questions match these filters. Try widening or clearing them."
              : "No questions yet. Add some to a pack to see them here."
          } />
        : (
          <>
            <div style={{ display: "grid", gap: 10 }}>
              {rows.map(r => {
                const pv = previewAtLevel(r, levels, r.pack_level || 1);
                return (
                  <div key={r.id} className="pm-qrow pm-qrow-search" style={{ background: C.panel, borderRadius: R.md, border: "1px solid " + C.line, opacity: r.status === "active" ? 1 : 0.6 }}>
                    <button className="pm-qrow-pack" onClick={() => onOpenPack(r.pack_id)} title={`Open ${r.pack_name}`} style={{ display: "flex", alignItems: "center", gap: 7, background: r.pack_color + "18", border: "none", borderRadius: R.sm, padding: "6px 10px", cursor: "pointer", flexShrink: 0 }}>
                      <span style={{ fontSize: 15 }}>{r.pack_emoji}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.ink2, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.pack_name}</span>
                    </button>
                    <div className="pm-qrow-main">
                      <div className="pm-qrow-sentence" style={{ color: C.ink, fontWeight: 500 }}>{pv.sentence}</div>
                      <div style={{ fontSize: 13.5, color: C.brandInk, fontWeight: 800, marginTop: 4 }}>→ {pv.opts}</div>
                    </div>
                    <div className="pm-qrow-meta">
                      {r.level && <LevelChip level={r.level} levels={levels} size="xs" />}
                      {r.created_at && <span title={`Added ${new Date(r.created_at).toLocaleString()}`} style={{ fontSize: 11, color: C.faint, fontWeight: 600, whiteSpace: "nowrap" }}>{relativeTime(r.created_at)}</span>}
                      <Badge kind={r.status} />
                    </div>
                  </div>
                );
              })}
            </div>
            {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
          </>
        )}
    </div>
  );
}

const useDebounced = (value, ms) => {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
};

const AboutItem = ({ label, value }) => (
  <div style={{ background: C.bg, borderRadius: R.md, padding: "11px 13px" }}>
    <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: 0.3, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
    <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.5 }}>{value}</div>
  </div>
);
