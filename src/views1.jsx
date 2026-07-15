// ============================================================
// Dashboard
// ============================================================
function Dashboard({ packs, onOpenPack, onGoLibrary, onGoQuestions, onNewPack }) {
  const { loading, error, data, reload } = useAsync(() => db.dashboard(), []);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const d = data || {};
  const stat = (n, label, color, sub) => (
    <div style={{ background: C.panel, borderRadius: R.lg, padding: `${S.lg + 2}px ${S.xl}px`, border: "1px solid " + C.line }}>
      <div style={{ fontSize: 30, fontWeight: 800, color, lineHeight: 1 }}>{loading ? <Skeleton h={30} w={44} /> : n}</div>
      <div style={{ fontSize: 12.5, color: C.sub, marginTop: 7, fontWeight: 600 }}>{label}</div>
      {sub && !loading && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>{sub}</div>}
    </div>
  );
  return (
    <div>
      <div style={{ marginBottom: S.xl }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Overview</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Your content library at a glance.</p>
      </div>
      <div className="pm-stats" style={{ marginBottom: S.lg }}>
        {stat(d.total_packs ?? 0, "Total packs", C.brand, `${d.published_packs ?? 0} published · ${d.draft_packs ?? 0} draft`)}
        {stat(d.total_questions ?? 0, "Questions", C.ink, `${d.active_questions ?? 0} active`)}
        {stat(d.published_packs ?? 0, "Published packs", C.good, "live in the game")}
        {stat(d.empty_packs ?? 0, "Empty packs", (d.empty_packs ?? 0) > 0 ? C.warn : C.good, "need content")}
      </div>
      <div className="pm-dash-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: S.lg }}>
        <div style={{ background: C.panel, borderRadius: R.lg, padding: S.xl, border: "1px solid " + C.line }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: S.md }}>Library health</div>
          <Row label="Average questions per pack" value={loading ? "…" : d.avg_questions_per_pack} />
          <Row label="Empty packs (need content)" value={loading ? "…" : d.empty_packs} warn={d.empty_packs > 0} />
          <Row label="Draft packs (not live)" value={loading ? "…" : d.draft_packs} />
          {!loading && d.questions_by_level && Object.keys(d.questions_by_level).length > 0 && (() => {
            const byLevel = d.questions_by_level || {};
            const max = Math.max(1, ...Object.values(byLevel).map(Number));
            return (
              <div style={{ marginTop: S.md + 2 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, marginBottom: 8 }}>Questions by level</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 56 }}>
                  {Array.from({ length: 10 }, (_, idx) => {
                    const lvl = idx + 1; const cnt = Number(byLevel[lvl] || 0);
                    return (
                      <div key={lvl} title={`Level ${lvl}: ${cnt} question${cnt === 1 ? "" : "s"}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                        <div style={{ width: "100%", height: 40, display: "flex", alignItems: "flex-end" }}>
                          <div style={{ width: "100%", height: `${cnt ? Math.max(8, (cnt / max) * 40) : 2}px`, background: cnt ? C.brand : C.line, borderRadius: 3, transition: "height .3s" }} />
                        </div>
                        <div style={{ fontSize: 9.5, fontWeight: 700, color: C.faint }}>{lvl}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          {d.empty_packs > 0 && <div style={{ marginTop: S.md, fontSize: 12.5, color: C.warnInk, background: C.warnSoft, padding: "8px 12px", borderRadius: R.sm }}>{d.empty_packs} pack{d.empty_packs === 1 ? "" : "s"} have no questions yet.</div>}
        </div>
        <div style={{ background: C.panel, borderRadius: R.lg, padding: S.xl, border: "1px solid " + C.line }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.ink, marginBottom: S.md }}>Quick actions</div>
          <div style={{ display: "grid", gap: S.sm + 2 }}>
            <Btn variant="soft" full onClick={onNewPack} icon="＋">Create a new pack</Btn>
            <Btn variant="ghost" full onClick={onGoLibrary} icon="▦">Browse pack library</Btn>
            <Btn variant="ghost" full onClick={onGoQuestions} icon="⌕">Search all questions</Btn>
          </div>
        </div>
      </div>

      {/* At-a-glance index of every pack */}
      <div style={{ marginTop: S.xl }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: S.md }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>All packs</h2>
          <span style={{ fontSize: 12.5, color: C.faint, fontWeight: 600 }}>{(packs || []).length} total · tap to open</span>
        </div>
        {!packs ? (
          <div className="pm-index-grid">{[0,1,2,3,4,5].map(i => <Skeleton key={i} h={38} r={9} />)}</div>
        ) : packs.length === 0 ? (
          <div style={{ fontSize: 13.5, color: C.sub }}>No packs yet.</div>
        ) : (
          <div className="pm-index-grid">
            {packs.map(p => (
              <button key={p.id} onClick={() => onOpenPack(p)} title={`${p.name} — ${p.active_questions || 0} active of ${p.total_questions || 0}${p.purpose ? "\n\n" + p.purpose : ""}`}
                style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 12px", background: C.panel, border: "1px solid " + C.line, borderLeft: `3px solid ${p.color}`, borderRadius: R.sm, cursor: "pointer", fontFamily: "inherit", textAlign: "left", width: "100%", overflow: "hidden" }}>
                <span style={{ fontSize: 16, flexShrink: 0 }}>{p.emoji}</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{p.name}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.faint, flexShrink: 0 }}>{p.total_questions || 0}</span>
                {p.status !== "published" && <span style={{ width: 6, height: 6, borderRadius: 99, background: p.status === "draft" ? C.faint : C.warn, flexShrink: 0 }} title={p.status} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
const Row = ({ label, value, warn }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid " + C.lineSoft }}>
    <span style={{ fontSize: 13.5, color: C.sub }}>{label}</span>
    <span style={{ fontSize: 15, fontWeight: 800, color: warn ? C.warnInk : C.ink }}>{value}</span>
  </div>
);

// ============================================================
// Library — cards with drag-reorder, clone, delete
// ============================================================
function Library({ packs, levels, loading, error, onOpen, onNew, onEdit, onExport, onImportFile, onDelete, onClone, onReorder, reload }) {
  const [search, setSearch] = useState("");
  const [statusF, setStatusF] = useState("all");
  const [diffF, setDiffF] = useState("all");
  const [lvlF, setLvlF] = useState("all");
  const [dragId, setDragId] = useState(null);
  const [order, setOrder] = useState(packs || []);
  useEffect(() => { setOrder(packs || []); }, [packs]);

  const shown = order.filter(p => {
    if (statusF !== "all" && p.status !== statusF) return false;
    if (diffF !== "all" && p.difficulty !== diffF) return false;
    if (lvlF !== "all" && (p.level || 1) !== parseInt(lvlF)) return false;
    if (search && !`${p.name} ${p.slug} ${p.description}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const canReorder = !search && statusF === "all" && diffF === "all" && lvlF === "all";

  const onDrop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const cur = [...order];
    const from = cur.findIndex(p => p.id === dragId);
    const to = cur.findIndex(p => p.id === targetId);
    const [moved] = cur.splice(from, 1);
    cur.splice(to, 0, moved);
    setOrder(cur);
    setDragId(null);
    onReorder(cur.map((p, i) => ({ id: p.id, sort_order: i + 1 })));
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Pack library</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>{loading ? "Loading…" : `${order.length} pack${order.length === 1 ? "" : "s"}`}{canReorder && order.length > 1 ? " · drag cards to reorder" : ""}</p>
      </div>

      <div className="pm-toolbar" style={{ marginBottom: S.lg + 2 }}>
        <SearchBox value={search} onChange={setSearch} placeholder="Search packs…" />
        <Select value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Filter by status" title="Filter by status" style={{ minWidth: 140, padding: "8px 12px" }}>
          <option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option>
        </Select>
        <Select value={diffF} onChange={(e) => setDiffF(e.target.value)} aria-label="Filter by difficulty" title="Filter by difficulty" style={{ minWidth: 130, padding: "8px 12px" }}>
          <option value="all">All difficulty</option><option value="basic">Basic</option><option value="advanced">Advanced</option><option value="mixed">Mixed</option>
        </Select>
        <Select value={lvlF} onChange={(e) => setLvlF(e.target.value)} aria-label="Filter by level" title="Filter by level" style={{ minWidth: 130, padding: "8px 12px" }}>
          <option value="all">All levels</option>
          {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
            <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
          ))}
        </Select>
        <div className="pm-grow" />
        <Btn variant="ghost" size="sm" onClick={onImportFile} icon="⭳">Import</Btn>
        <Btn variant="ghost" size="sm" onClick={onExport} icon="⭱">Export</Btn>
        <Btn size="sm" onClick={onNew} icon="＋">New pack</Btn>
      </div>

      {loading ? (
        <div className="pm-pack-grid">{[0,1,2,3,4,5].map(i => <div key={i} style={{ background: C.panel, borderRadius: R.xl, border: "1px solid " + C.line, padding: S.xl }}><Skeleton h={52} w={52} r={13} /><Skeleton h={18} w="70%" style={{ marginTop: 14 }} /><Skeleton h={13} w="90%" style={{ marginTop: 10 }} /></div>)}</div>
      ) : shown.length === 0 ? (
        <EmptyState icon="📦" title={order.length === 0 ? "No packs yet" : "Nothing matches"} body={order.length === 0 ? "Create your first pack to get started." : "Try adjusting your search or filters."} action={order.length === 0 ? <Btn onClick={onNew} icon="＋">Create first pack</Btn> : null} />
      ) : (
        <div className="pm-pack-grid">
          {shown.map(p => (
            <PackCard key={p.id} pack={p} levels={levels} draggable={canReorder} dragging={dragId === p.id}
              onDragStart={() => setDragId(p.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(p.id)}
              onOpen={() => onOpen(p)} onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} onClone={() => onClone(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PackCard({ pack: p, levels, draggable, dragging, onDragStart, onDragOver, onDrop, onOpen, onEdit, onDelete, onClone }) {
  const [hover, setHover] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const hasDetails = !!(p.purpose || p.focus_areas);
  const reveal = hover || showInfo;
  return (
    <div draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: C.panel, borderRadius: R.xl, border: "1px solid " + (hover ? p.color : C.line), overflow: "hidden", transition: "border-color .15s, transform .15s, box-shadow .15s",
        transform: dragging ? "scale(0.98)" : hover ? "translateY(-3px)" : "none", boxShadow: dragging ? SH.lg : hover ? SH.md : "none", opacity: dragging ? 0.6 : 1, cursor: draggable ? "grab" : "default" }}>
      <div style={{ height: 6, background: p.color }} />
      <div style={{ padding: S.xl, cursor: "pointer" }} onClick={onOpen}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: S.md }}>
          <div style={{ width: 52, height: 52, borderRadius: 13, background: p.color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 27 }}>{p.emoji}</div>
          <Badge kind={p.status} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: C.ink, flex: 1, minWidth: 0 }}>{p.name}</div>
          {hasDetails && <button onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); }} title={reveal ? "Hide details" : "About this pack"} aria-label="About this pack"
            style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 99, border: "1px solid " + (reveal ? p.color : C.line), background: reveal ? p.color + "1E" : "transparent", color: reveal ? p.color : C.faint, cursor: "pointer", fontSize: 12, fontWeight: 800, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>ⓘ</button>}
        </div>
        <div style={{ fontSize: 13, color: C.sub, marginTop: 5, lineHeight: 1.45, minHeight: 36, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.description || "No description"}</div>
        {(p.purpose || p.focus_areas) && (
          <div style={{ maxHeight: reveal ? 200 : 0, opacity: reveal ? 1 : 0, overflow: "hidden", transition: "max-height .25s ease, opacity .2s ease, margin .2s ease", marginTop: reveal ? 10 : 0 }}>
            <div style={{ background: C.bg, borderRadius: R.md, padding: "10px 12px", display: "grid", gap: 8 }}>
              {p.purpose && <div>
                <div style={{ fontSize: 9.5, fontWeight: 800, color: C.faint, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 2 }}>Purpose</div>
                <div style={{ fontSize: 12, color: C.ink2, lineHeight: 1.45 }}>{p.purpose}</div>
              </div>}
              {p.focus_areas && <div>
                <div style={{ fontSize: 9.5, fontWeight: 800, color: C.faint, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 2 }}>Focus</div>
                <div style={{ fontSize: 12, color: C.ink2, lineHeight: 1.45 }}>{p.focus_areas}</div>
              </div>}
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: S.md + 2, paddingTop: S.md + 2, borderTop: "1px solid " + C.line }}>
          <Pill>{p.difficulty}</Pill>{p.is_custom && <Pill tone="muted">custom</Pill>}{p.level && <LevelChip level={p.level} levels={levels} size="xs" />}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 13, color: C.ink, fontWeight: 800 }}>{p.active_questions || 0}</span>
          <span style={{ fontSize: 12, color: C.faint }}>/ {p.total_questions || 0} Qs</span>
        </div>
      </div>
      <div style={{ display: "flex", borderTop: "1px solid " + C.line }} onClick={(e) => e.stopPropagation()}>
        <CardBtn color={C.brandInk} onClick={onOpen}>Open</CardBtn>
        <CardBtn color={C.sub} border onClick={onEdit}>Edit</CardBtn>
        <CardBtn color={C.sub} border onClick={onClone}>Clone</CardBtn>
        <CardBtn color={C.danger} border onClick={onDelete}>Delete</CardBtn>
      </div>
    </div>
  );
}
const CardBtn = ({ color, border, onClick, children }) => (
  <button onClick={onClick} style={{ flex: 1, padding: "11px 0", background: "none", border: "none", borderLeft: border ? "1px solid " + C.line : "none", cursor: "pointer", fontSize: 12.5, fontWeight: 700, color, fontFamily: "inherit" }}>{children}</button>
);
