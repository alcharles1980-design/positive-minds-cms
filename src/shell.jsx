// ============================================================
// Login
// ============================================================
function Login({ onSuccess }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!pw) return;
    setBusy(true); setErr("");
    try { await auth.login(pw); onSuccess(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(155deg, ${C.brandSoft}, ${C.bg} 60%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: FONT }}>
      <div style={{ background: C.panel, borderRadius: R.xl + 2, padding: "42px 38px", width: "100%", maxWidth: 400, boxShadow: SH.xl, textAlign: "center" }}>
        <div style={{ width: 62, height: 62, borderRadius: R.lg + 2, background: `linear-gradient(135deg, ${C.brand}, ${C.brand2})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, margin: "0 auto 18px", boxShadow: SH.brand }}>🧠</div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.ink }}>Positive Minds</h1>
        <div style={{ fontSize: 12.5, color: C.faint, fontWeight: 700, letterSpacing: 0.4, marginTop: 4, marginBottom: 28 }}>PACK CONTENT MANAGER</div>
        <div style={{ textAlign: "left" }}>
          <Field label="Admin password">
            <Input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Enter password" />
          </Field>
        </div>
        {err && <div style={{ background: C.dangerSoft, color: C.dangerInk, padding: "10px 14px", borderRadius: R.md, fontSize: 13, marginTop: 14, textAlign: "left", fontWeight: 600 }}>{err}</div>}
        <div style={{ marginTop: 20 }}><Btn onClick={submit} disabled={busy || !pw} full size="lg">{busy ? "Signing in…" : "Sign in"}</Btn></div>
        <div style={{ fontSize: 11.5, color: C.faint, marginTop: 18, lineHeight: 1.5 }}>Admin access only. Content edits require this password.</div>
      </div>
    </div>
  );
}

function ChangePassword({ onClose, onDone }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const submit = async () => {
    if (pw.length < 8) { setErr("Use at least 8 characters."); return; }
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    setBusy(true); setErr("");
    try { await auth.changePassword(pw); onDone(); onClose(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <ModalHead title="Change admin password" subtitle="The shared password for editing content" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.md + 2 }}>
        <Field label="New password" hint="At least 8 characters"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
        <Field label="Confirm new password"><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>
        {err && <div style={{ background: C.dangerSoft, color: C.dangerInk, padding: "10px 14px", borderRadius: R.md, fontSize: 13, fontWeight: 600 }}>{err}</div>}
      </div>
      <ModalFoot><Btn variant="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={submit} disabled={busy}>{busy ? "Updating…" : "Update password"}</Btn></ModalFoot>
    </>
  );
}

// Clone dialog
function CloneDialog({ pack, onClone, onClose }) {
  const [name, setName] = useState(pack.name + " (copy)");
  const [slug, setSlug] = useState(pack.slug + "-copy");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true); setErr("");
    try { await onClone(pack.id, slug, name); onClose(); } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <ModalHead emoji={pack.emoji} title="Duplicate pack" subtitle={`Copies all ${pack.total_questions || 0} questions into a new draft`} />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.md + 2 }}>
        <Field label="New pack name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="New slug"><Input value={slug} onChange={(e) => setSlug(slugify(e.target.value))} /></Field>
        {err && <ErrorState error={err} />}
      </div>
      <ModalFoot><Btn variant="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={submit} disabled={busy}>{busy ? "Duplicating…" : "Duplicate pack"}</Btn></ModalFoot>
    </>
  );
}

const NAV = [
  { id: "dashboard", label: "Overview", icon: "◈" },
  { id: "library", label: "Packs", icon: "▦" },
  { id: "questions", label: "Questions", icon: "⌕" },
  { id: "generator", label: "Generate", icon: "✦" },
  { id: "levels", label: "Levels", icon: "▲" },
  { id: "aireview", label: "AI Review", icon: "◎" },
  { id: "aisettings", label: "AI Settings", icon: "✧" },
  { id: "connector", label: "Claude Connector", icon: "◇" },
  { id: "health", label: "Health", icon: "◉" },
  { id: "publish", label: "Publishing", icon: "⇧" },
  { id: "activity", label: "Activity", icon: "≡" },
  { id: "devnotes", label: "Developer", icon: "⌘" },
];
// Phone shows a subset in the bottom bar; the rest live in the ⋯ menu.
const NAV_PHONE = ["dashboard", "library", "questions", "publish"];

// ============================================================
// Root App
// ============================================================
// Fire-and-forget activity logger (never blocks the UI)
const logActivity = (entity, id, name, action, detail = "") => {
  rpc("pm_log", { _entity: entity, _entity_id: id || null, _entity_name: name || "", _action: action, _detail: detail }).catch(() => {});
};

function App() {
  const bp = useBreakpoint();
  const theme = useTheme();

  // ONE SOURCE OF TRUTH for the device class.
  //
  // The CSS used to have its OWN breakpoints (@media max-width:639px / 1023px) running in parallel
  // with the JS ones. Two independent systems that could disagree — and did: on a landscape phone
  // the JS said "tablet" (side rail) while the CSS said "not a phone" (so two-column forms came
  // back, modals stopped being bottom sheets, and iOS resumed auto-zooming inputs).
  //
  // Now the JS decides ONCE and stamps the answer onto <html>. The CSS keys off that class, so the
  // two can never drift apart again.
  useEffect(() => {
    const el = document.documentElement;
    el.classList.remove("pm-phone", "pm-tablet", "pm-desktop");
    el.classList.add(bp.isPhone ? "pm-phone" : bp.isTablet ? "pm-tablet" : "pm-desktop");
    el.classList.toggle("pm-coarse", !!bp.coarse);
    el.classList.toggle("pm-landscape", !!bp.landscape);
  }, [bp.isPhone, bp.isTablet, bp.isDesktop, bp.coarse, bp.landscape]);

  const [authed, setAuthed] = useState(() => !!session.load());
  // URL-hash routing so a refresh keeps you where you were (e.g. #/questions, #/pack/<id>).
  const VALID_NAV = ["dashboard", "library", "questions", "generator", "levels", "aireview", "aisettings", "connector", "health", "publish", "activity", "devnotes"];
  const parseHash = () => {
    const raw = (window.location.hash || "").replace(/^#\/?/, "").trim(); // "questions" | "pack/<id>" | ""
    if (!raw) return { nav: "dashboard", packId: null };
    const [head, id] = raw.split("/");
    if (head === "pack" && id) return { nav: "library", packId: id };
    if (VALID_NAV.includes(head)) return { nav: head, packId: null };
    return { nav: "dashboard", packId: null };
  };
  const initial = parseHash();
  const [nav, setNav] = useState(initial.nav);
  const [active, setActive] = useState(null);     // open pack (hydrated from packId once packs load)
  const pendingPackId = useRef(initial.packId);   // pack id from the URL, resolved when packs arrive
  const [editPack, setEditPack] = useState(null); // {} new | {...} edit
  const [clonePack, setClonePack] = useState(null);
  const [changePw, setChangePw] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const fileRef = useRef(null);

  const packsState = useAsync(() => db.packsOverview(), [authed]);
  const packs = packsState.data;
  const reloadPacks = packsState.reload;
  const levelsState = useAsync(() => db_levels.list(), [authed]);
  const levels = levelsState.data || [];

  // Live sync: connect when authed, refresh lists when others change data.
  const live = useRealtime(authed);
  useRealtimeRefresh(["pm_packs", "pm_questions", "pm_question_levels"], () => reloadPacks(), [reloadPacks]);
  useRealtimeRefresh(["pm_levels"], () => levelsState.reload(), [levelsState.reload]);

  // Hash routing: write the current view into the URL so refresh/back/forward all work.
  const goPack = useCallback((p) => { setActive(p); window.location.hash = "#/pack/" + p.id; }, []);
  const closePack = useCallback(() => {
    setActive(null);
    // Return to the library hash (also pops the pack from browser history if we came via back).
    window.location.hash = "#/library";
    reloadPacks();
  }, [reloadPacks]);

  // React to browser back/forward and manual hash edits: re-derive nav + open pack from the URL.
  useEffect(() => {
    const onHash = () => {
      const { nav: n, packId } = parseHash();
      setNav(n);
      if (packId) {
        const p = (packsState.data || []).find(x => x.id === packId);
        if (p) setActive(p); else { pendingPackId.current = packId; setActive(null); }
      } else {
        setActive(null);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [packsState.data]);

  // Once packs have loaded, resolve a pack id that came from the initial URL (deep link / refresh on a pack).
  useEffect(() => {
    if (pendingPackId.current && packsState.data) {
      const p = packsState.data.find(x => x.id === pendingPackId.current);
      pendingPackId.current = null;
      if (p) setActive(p);
    }
  }, [packsState.data]);

  // Keep the browser tab title in sync with the current view (helps with multiple tabs + history).
  useEffect(() => {
    const NAV_TITLES = { dashboard: "Overview", library: "Packs", questions: "Questions", generator: "Generator", levels: "Levels", health: "Content health", publish: "Publishing", activity: "Activity", devnotes: "Developer notes" };
    const label = active ? active.name : (NAV_TITLES[nav] || "");
    document.title = label ? `${label} · Positive Minds` : "Positive Minds — Pack Content Manager";
  }, [nav, active]);

  // open a pack by id (from global search)
  const openPackById = useCallback((id) => {
    const p = (packs || []).find(x => x.id === id);
    if (p) { setNav("library"); goPack(p); }
  }, [packs, goPack]);

  // pack CRUD
  const savePack = async (payload, id) => {
    if (id) { await db.updatePack(id, payload); logActivity("pack", id, payload.name, "update"); notify("Pack updated"); }
    else { const np = await db.createPack({ ...payload, sort_order: (packs?.length || 0) + 1 }); logActivity("pack", np?.id, payload.name, "create"); notify("Pack created"); }
    await reloadPacks();
    if (active && id === active.id) setActive(a => ({ ...a, ...payload }));
  };
  const doClonePack = async (src, slug, name) => { await db.clonePack(src, slug, name); logActivity("pack", null, name, "clone", "duplicated from another pack"); await reloadPacks(); notify("Pack duplicated"); };
  const deletePack = async (p) => {
    const ok = await confirmDialog({ title: `Delete "${p.name}"?`, message: `This permanently removes the pack and all ${p.total_questions || 0} of its questions.`, confirmLabel: "Delete pack", danger: true });
    if (!ok) return;
    // optimistic remove + undo
    const snapshot = packs;
    packsState.setData(cur => (cur || []).filter(x => x.id !== p.id));
    try {
      await db.deletePack(p.id);
      logActivity("pack", p.id, p.name, "delete", `${p.total_questions || 0} questions removed`);
      notify("Pack deleted", { action: { label: "Undo", onClick: async () => {
        await db.createPack({ slug: p.slug, name: p.name, emoji: p.emoji, description: p.description, color: p.color, difficulty: p.difficulty, status: p.status, is_custom: p.is_custom, sort_order: p.sort_order, level: p.level ?? 1, purpose: p.purpose ?? null, focus_areas: p.focus_areas ?? null, style_approach: p.style_approach ?? null, example_objectives: p.example_objectives ?? null });
        await reloadPacks(); notify("Pack restored");
      } } });
    } catch (e) { packsState.setData(snapshot); notify("Couldn't delete: " + e.message, { kind: "error" }); }
  };
  const reorderPacks = async (updates) => { try { await db.reorderPacks(updates); } catch (e) { notify("Reorder failed", { kind: "error" }); reloadPacks(); } };

  // export / import
  const exportJSON = async () => {
    const { packs: pk, questions } = await db.exportAll();
    const byPack = {};
    questions.forEach(x => (byPack[x.pack_id] = byPack[x.pack_id] || []).push(x));
    const out = { exported_at: new Date().toISOString(), version: 3, packs: pk.map(p => ({
      slug: p.slug, name: p.name, emoji: p.emoji, description: p.description, color: p.color, difficulty: p.difficulty, status: p.status, is_custom: p.is_custom,
      level: p.level, purpose: p.purpose, focus_areas: p.focus_areas, style_approach: p.style_approach, example_objectives: p.example_objectives,
      questions: (byPack[p.id] || []).map(x => ({ template: x.template, answer: x.answer, alt_answer: x.alt_answer, status: x.status, level: x.level, letter_position: x.letter_position, letter_grouping: x.letter_grouping, frame_slots: x.frame_slots })),
    })) };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `positive-minds-export-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    notify(`Exported ${out.packs.length} packs`);
  };
  const onImportFile = () => fileRef.current?.click();
  const handleFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const arr = data.packs || (Array.isArray(data) ? data : []);
      if (!arr.length) { notify("No packs found in file", { kind: "error" }); return; }
      const ok = await confirmDialog({ title: `Import ${arr.length} packs?`, message: "Packs are added as drafts. Existing packs with the same slug are skipped.", confirmLabel: `Import ${arr.length}` });
      if (!ok) return;
      const existing = new Set((packs || []).map(p => p.slug));
      let created = 0, skipped = 0, flagged = 0;
      for (const p of arr) {
        if (existing.has(p.slug)) { skipped++; continue; }
        const newPack = await db.createPack({ slug: p.slug, name: p.name, emoji: p.emoji || "💡", description: p.description || "", color: p.color || C.brand, difficulty: p.difficulty || "basic", status: "draft", is_custom: !!p.is_custom, sort_order: (packs?.length || 0) + created + 1, level: p.level ?? 1, purpose: p.purpose || null, focus_areas: p.focus_areas || null, style_approach: p.style_approach || null, example_objectives: p.example_objectives || null });
        if (newPack && p.questions?.length) {
          // This is a RESTORE path (a backup, or moving packs between environments), not authoring —
          // so it does not go through the review queue; putting a 200-question restore through a
          // one-by-one approval would be absurd. But broken questions must not ride in SILENTLY and
          // then go live the moment the pack is published. So: validate, import, and say plainly what
          // is wrong. (The Health page also flags these now, so they cannot hide.)
          for (const q of p.questions) {
            const v = validateQuestion(
              { template: q.template, answer: q.answer, alt_answer: q.alt_answer },
              levels || [],
              { targetLevel: q.level ?? p.level ?? 1 }
            );
            if (!v.ok) flagged++;
          }
          await db.createQuestions(p.questions.map((q, i) => ({ pack_id: newPack.id, template: q.template, answer: (q.answer || "").toUpperCase(), alt_answer: (q.alt_answer || "").toUpperCase(), status: q.status || "active", sort_order: i, level: q.level ?? null, letter_position: q.letter_position ?? null, letter_grouping: q.letter_grouping ?? null, frame_slots: (q.frame_slots && typeof q.frame_slots === "object") ? q.frame_slots : {} })));
        }
        created++;
      }
      await reloadPacks();
      notify(`Imported ${created} pack${created === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}`);
      if (flagged) {
        notify(`${flagged} imported question${flagged === 1 ? " has a problem" : "s have problems"} — check Health before publishing`, { kind: "error" });
      }
    } catch (err) { notify("Import failed: " + err.message, { kind: "error" }); }
  };

  const goNav = (id) => {
    setActive(null); setNav(id); setMenuOpen(false);
    const target = id === "dashboard" ? "#/" : "#/" + id;
    if (window.location.hash !== target) window.location.hash = target; // updates URL; hashchange keeps state in sync
  };

  // Command palette entries
  const commands = useMemo(() => {
    const base = [
      { id: "nav-dashboard", label: "Go to Overview", icon: "◈", section: "Go", keywords: ["home", "dashboard"], run: () => goNav("dashboard") },
      { id: "nav-library", label: "Go to Packs", icon: "▦", section: "Go", keywords: ["library", "packs"], run: () => goNav("library") },
      { id: "nav-questions", label: "Search all questions", icon: "⌕", section: "Go", keywords: ["find", "questions"], run: () => goNav("questions") },
      { id: "nav-generator", label: "Go to Content generator", icon: "✦", section: "Go", keywords: ["generate", "prompt", "ai", "create", "batch"], run: () => goNav("generator") },
      { id: "nav-health", label: "Go to Content health", icon: "◉", section: "Go", keywords: ["lint", "issues", "duplicates"], run: () => goNav("health") },
      { id: "nav-publish", label: "Go to Publishing", icon: "⇧", section: "Go", keywords: ["sync", "export", "profile", "feed", "game"], run: () => goNav("publish") },
      { id: "nav-activity", label: "Go to Activity log", icon: "≡", section: "Go", keywords: ["history", "changes"], run: () => goNav("activity") },
      { id: "nav-devnotes", label: "Go to Developer notes", icon: "⌘", section: "Go", keywords: ["docs", "architecture", "claude", "prompt", "readme"], run: () => goNav("devnotes") },
      { id: "nav-levels", label: "Go to Levels", icon: "▲", section: "Go", keywords: ["level", "progression", "difficulty", "stages"], run: () => goNav("levels") },
      { id: "act-newpack", label: "Create new pack", icon: "＋", section: "Action", keywords: ["add pack"], run: () => setEditPack({}) },
      { id: "act-import", label: "Import packs from JSON", icon: "⭳", section: "Action", keywords: ["upload"], run: onImportFile },
      { id: "act-export", label: "Export everything to JSON", icon: "⭱", section: "Action", keywords: ["download", "backup"], run: exportJSON },
      { id: "th-light", label: "Theme: Light", icon: "☀", section: "Theme", run: () => theme.set("light") },
      { id: "th-dark", label: "Theme: Dark", icon: "☾", section: "Theme", run: () => theme.set("dark") },
      { id: "th-system", label: "Theme: Auto (system)", icon: "◐", section: "Theme", run: () => theme.set("system") },
      { id: "act-password", label: "Change admin password", icon: "⚙", section: "Action", run: () => setChangePw(true) },
    ];
    // jump straight to any pack
    const packCmds = (packs || []).map(p => ({ id: "pack-" + p.id, label: `Open “${p.name}”`, icon: p.emoji, section: "Pack", hint: `${p.active_questions || 0} active questions`, keywords: [p.slug, ...(p.tags || [])], run: () => { setNav("library"); goPack(p); } }));
    return [...base, ...packCmds];
  }, [packs, theme]); // eslint-disable-line

  // If a token refresh fails mid-session, drop back to the login screen.
  useEffect(() => {
    authEvents.onExpire(() => { setAuthed(false); setActive(null); notify("Your session expired — please sign in again", { kind: "error" }); });
  }, []);

  // Keep the session warm: proactively refresh the short-lived access token in the
  // background (well before its ~1h expiry) and whenever the tab regains focus, so the
  // user stays logged in for the full 7-day window without ever hitting an expired token.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    const refreshNow = async () => { if (!cancelled && session.refresh) { const ok = await auth.refresh(); if (ok && !cancelled) realtime.updateToken(); } };
    refreshNow(); // refresh once on load in case the stored token is already near expiry
    const timer = setInterval(refreshNow, 45 * 60 * 1000); // every 45 min (< 60 min token life)
    const onVis = () => { if (document.visibilityState === "visible") refreshNow(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [authed]);

  // hotkeys
  useHotkey("mod+k", (e) => { e.preventDefault(); setPaletteOpen(true); }, authed);

  if (!authed) return (<><GlobalStyle /><ConfirmHost /><ToastHost /><Login onSuccess={() => { setAuthed(true); reloadPacks(); }} /></>);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink, display: "flex" }}>
      <GlobalStyle />
      <ConfirmHost />
      <ToastHost />
      <input ref={fileRef} type="file" accept="application/json,.json" onChange={handleFile} style={{ display: "none" }} />

      {/* Sidebar (desktop) */}
      {!bp.isPhone && (
        <aside style={{ width: bp.isTablet ? 76 : 232, flexShrink: 0, background: C.panel, borderRight: "1px solid " + C.line, position: "sticky", top: 0, height: "100vh", display: "flex", flexDirection: "column", padding: bp.isTablet ? "18px 12px" : "20px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: bp.isTablet ? "0 0 20px" : "0 8px 22px" }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, background: `linear-gradient(135deg, ${C.brand}, ${C.brand2})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, boxShadow: SH.brand, flexShrink: 0 }}>🧠</div>
            {!bp.isTablet && <div style={{ minWidth: 0 }}><div style={{ fontSize: 15.5, fontWeight: 800, whiteSpace: "nowrap" }}>Positive Minds</div><div style={{ fontSize: 10.5, color: C.faint, fontWeight: 700, letterSpacing: 0.3 }}>PACK MANAGER</div></div>}
          </div>
          <nav style={{ display: "grid", gap: 4 }}>
            {NAV.map(n => (
              <button key={n.id} onClick={() => goNav(n.id)} title={n.label}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: bp.isTablet ? "12px 0" : "11px 14px", justifyContent: bp.isTablet ? "center" : "flex-start",
                  borderRadius: R.md, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700,
                  background: nav === n.id && !active ? C.brandSoft : "transparent", color: nav === n.id && !active ? C.brandInk : C.sub, transition: "all .15s" }}>
                <span style={{ fontSize: 17 }}>{n.icon}</span>{!bp.isTablet && n.label}
              </button>
            ))}
          </nav>
          {!bp.isTablet && (
            <button onClick={() => setPaletteOpen(true)} style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0", padding: "9px 12px", borderRadius: R.md, border: "1px solid " + C.line, background: C.bg, cursor: "pointer", fontFamily: "inherit", color: C.sub, fontSize: 13 }}>
              <span style={{ fontSize: 14 }}>⌕</span><span style={{ flex: 1, textAlign: "left" }}>Quick actions</span><kbd style={kbdStyle}>⌘K</kbd>
            </button>
          )}
          <div style={{ flex: 1 }} />
          {!bp.isTablet && <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}><LiveBadge live={live} /></div>}
          {bp.isTablet && <div style={{ marginBottom: 8, display: "flex", justifyContent: "center" }}><span title={live ? "Live sync on" : "Reconnecting…"} style={{ width: 9, height: 9, borderRadius: 99, background: live ? C.good : C.faint, boxShadow: live ? `0 0 0 3px ${C.good}22` : "none" }} /></div>}
          {!bp.isTablet && <div style={{ marginBottom: 10 }}><ThemeToggle theme={theme} /></div>}
          <div style={{ display: "grid", gap: 4 }}>
            {bp.isTablet && <button onClick={() => setPaletteOpen(true)} title="Quick actions (⌘K)" style={sideBtn(true)}><span style={{ fontSize: 16 }}>⌕</span></button>}
            {bp.isTablet && <ThemeToggle theme={theme} mini />}
            <button onClick={() => setChangePw(true)} title="Change password" style={sideBtn(bp.isTablet)}><span style={{ fontSize: 16 }}>⚙</span>{!bp.isTablet && "Password"}</button>
            <button onClick={() => { auth.logout(); setAuthed(false); setActive(null); }} title="Sign out" style={{ ...sideBtn(bp.isTablet), color: C.danger }}><span style={{ fontSize: 16 }}>⏻</span>{!bp.isTablet && "Sign out"}</button>
          </div>
          {!bp.isTablet && <div style={{ marginTop: 8, textAlign: "center", fontSize: 9.5, color: C.faint, fontWeight: 600, letterSpacing: 0.3 }} title="App build — if this differs from the latest deploy, your browser is showing a cached version">build {CFG.build}</div>}
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {/* Mobile top bar */}
        {bp.isPhone && (
          <header style={{ background: C.panel, borderBottom: "1px solid " + C.line, position: "sticky", top: 0, zIndex: 50 }}>
            <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: `linear-gradient(135deg, ${C.brand}, ${C.brand2})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>🧠</div>
              <div style={{ fontSize: 15.5, fontWeight: 800 }}>Positive Minds</div>
              <div style={{ flex: 1 }} />
              <LiveBadge live={live} />
              <div style={{ position: "relative" }}>
                <button onClick={() => setMenuOpen(o => !o)} aria-label="Menu" style={{ background: "none", border: "1px solid " + C.line, borderRadius: R.md, padding: "8px 12px", fontSize: 18, lineHeight: 1, cursor: "pointer", color: C.ink2 }}>⋯</button>
                {menuOpen && (<>
                  <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: C.panel, borderRadius: R.md, border: "1px solid " + C.line, boxShadow: SH.lg, zIndex: 61, minWidth: 210, overflow: "hidden", maxHeight: "70vh", overflowY: "auto" }}>
                    {/* Every nav section that isn't in the bottom bar must be reachable here, or it
                        is simply unreachable on a phone. Derive it from NAV so a new page can never
                        be silently stranded again. */}
                    {NAV.filter(n => !NAV_PHONE.includes(n.id)).map((n, i) => (
                      <button key={n.id} onClick={() => { goNav(n.id); setMenuOpen(false); }}
                        style={{ ...menuItem, ...(i > 0 ? { borderTop: "1px solid " + C.line } : {}) }}>
                        {n.icon} {n.label}
                      </button>
                    ))}
                    <div style={{ padding: "10px 12px", borderTop: "1px solid " + C.line }}><ThemeToggle theme={theme} /></div>
                    <button onClick={() => { setMenuOpen(false); setChangePw(true); }} style={{ ...menuItem, borderTop: "1px solid " + C.line }}>⚙ Change password</button>
                    <button onClick={() => { setMenuOpen(false); auth.logout(); setAuthed(false); setActive(null); }} style={{ ...menuItem, borderTop: "1px solid " + C.line, color: C.danger }}>⏻ Sign out</button>
                  </div>
                </>)}
              </div>
            </div>
          </header>
        )}

        <main className="pm-main" style={{ flex: 1, paddingBottom: bp.isPhone ? 90 : 60 }}>
          {active ? (
            <PackDetail pack={active} levels={levels} onBack={closePack} refreshPacks={reloadPacks} onEditPack={setEditPack} />
          ) : nav === "dashboard" ? (
            <Dashboard packs={packs} onOpenPack={goPack} onGoLibrary={() => goNav("library")} onGoQuestions={() => goNav("questions")} onNewPack={() => setEditPack({})} />
          ) : nav === "library" ? (
            <Library packs={packs} levels={levels} loading={packsState.loading} error={packsState.error} reload={reloadPacks}
              onOpen={goPack} onNew={() => setEditPack({})} onEdit={setEditPack} onExport={exportJSON} onImportFile={onImportFile}
              onDelete={deletePack} onClone={setClonePack} onReorder={reorderPacks} />
          ) : nav === "questions" ? (
            <AllQuestions onOpenPack={openPackById} levels={levels} packs={packs} />
          ) : nav === "levels" ? (
            <LevelsView levels={levels} reload={levelsState.reload} />
          ) : nav === "generator" ? (
            <GeneratorView packs={packs} levels={levels} />
          ) : nav === "health" ? (
            <HealthView onOpenPack={openPackById} />
          ) : nav === "aireview" ? (
            <AIReviewView packs={packs} levels={levels} />
          ) : nav === "aisettings" ? (
            <AISettingsView packs={packs} levels={levels} />
          ) : nav === "connector" ? (
            <ConnectorView />
          ) : nav === "publish" ? (
            <PublishHub packs={packs} onSynced={reloadPacks} />
          ) : nav === "devnotes" ? (
            <DeveloperNotes />
          ) : (
            <ActivityView />
          )}
        </main>

        {/* Mobile bottom nav */}
        {bp.isPhone && !active && (
          <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: C.panel, borderTop: "1px solid " + C.line, display: "flex", zIndex: 50, paddingBottom: "env(safe-area-inset-bottom)" }}>
            {NAV.filter(n => NAV_PHONE.includes(n.id)).map(n => (
              <button key={n.id} onClick={() => goNav(n.id)} style={{ flex: 1, padding: "10px 0 12px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, color: nav === n.id ? C.brand : C.faint }}>
                <span style={{ fontSize: 20 }}>{n.icon}</span>
                <span style={{ fontSize: 10.5, fontWeight: 700 }}>{n.label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>

      <Modal open={editPack !== null} onClose={() => setEditPack(null)} labelledBy="pm-pack-title">
        {editPack !== null && <PackEditor pack={editPack.id ? editPack : null} levels={levels} onSave={savePack} onClose={() => setEditPack(null)} />}
      </Modal>
      <Modal open={clonePack !== null} onClose={() => setClonePack(null)}>
        {clonePack !== null && <CloneDialog pack={clonePack} onClone={doClonePack} onClose={() => setClonePack(null)} />}
      </Modal>
      <Modal open={changePw} onClose={() => setChangePw(false)} width={460}>
        {changePw && <ChangePassword onClose={() => setChangePw(false)} onDone={() => notify("Password updated")} />}
      </Modal>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}

const sideBtn = (mini) => ({ display: "flex", alignItems: "center", gap: 12, padding: mini ? "11px 0" : "10px 14px", justifyContent: mini ? "center" : "flex-start", borderRadius: R.md, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, background: "transparent", color: C.sub });
const menuItem = { display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "12px 16px", fontSize: 14, fontWeight: 600, color: C.ink, cursor: "pointer", fontFamily: "inherit" };

// ============================================================
// Global styles (responsive)
// ============================================================
function GlobalStyle() {
  return <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&display=swap');
    :root, [data-theme="light"]{ ${themeVars("light")} }
    [data-theme="dark"]{ ${themeVars("dark")} }
    *{box-sizing:border-box}

    /* ---- MOBILE FOUNDATIONS ----
       These are the things whose absence makes a page feel "broken" rather than just ugly. */

    /* 1. Never scroll sideways. One stubborn element is all it takes to shift the whole page and
          make everything feel misaligned. This is the safety net. */
    html, body{ max-width:100%; overflow-x:hidden; }

    /* 2. viewport-fit=cover lets content run under the notch and home indicator. That is only safe
          if we then pad for them. Without this, landscape content slides UNDER the notch. */
    html.pm-coarse .pm-main{
      padding-left: max(16px, env(safe-area-inset-left));
      padding-right: max(16px, env(safe-area-inset-right));
    }

    /* 3. Long words (a slug, a model name, a URL) must not force the page wider. */
    .pm-main{ overflow-wrap:anywhere; }

    /* 4. iOS momentum scrolling inside modals/scroll areas, and stop the rubber-band chaining. */
    .pm-modal-card{ -webkit-overflow-scrolling:touch; overscroll-behavior:contain; }

    /* 5. Kill the grey tap flash and the double-tap-to-zoom delay on touch. */
    html.pm-coarse *{ -webkit-tap-highlight-color:transparent; }
    html.pm-coarse button, html.pm-coarse a, html.pm-coarse [role=button]{ touch-action:manipulation; }

    html,body{margin:0;padding:0}
    html{ -webkit-text-size-adjust:100%; transition:background .2s; }
    body{ background:${C.bg}; transition:background .2s, color .2s; }
    /* Inputs: typed text is full-strength; placeholders readable but distinct. */
    input, textarea, select { color: ${C.ink}; }
    input::placeholder, textarea::placeholder { color: ${C.sub}; opacity: 1; }
    input::-webkit-input-placeholder, textarea::-webkit-input-placeholder { color: ${C.sub}; opacity: 1; }
    select:invalid, select option[value=""] { color: ${C.sub}; }
    ::selection { background: ${C.brandSoft}; color: ${C.brandInk}; }
    button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{ outline:2px solid ${C.brand}; outline-offset:2px; }

    @keyframes pm-spin{ to{ transform:rotate(360deg);} }
    @keyframes pm-pulse{ 0%,100%{ opacity:1; } 50%{ opacity:0.45; } }
    @keyframes pm-shimmer{ 0%{ background-position:200% 0;} 100%{ background-position:-200% 0;} }
    @keyframes pm-toast-in{ from{ transform:translateY(10px); opacity:0;} to{ transform:translateY(0); opacity:1;} }

    .pm-main{ max-width:1080px; margin:0 auto; width:100%; padding:32px 28px; }

    /* ---- READABLE WIDTH ----
       .pm-main caps the CONTAINER at 1080px, but nothing capped the CONTENT inside it. So a single
       form field, or a settings panel with one control, stretched the full 1080px — an input the
       width of the page, marooned in white space. That is the "white space / broken formatting"
       problem: content with no upper bound simply fills whatever room it is given.
       Forms and prose get a comfortable reading width; wide things (grids, tables, cards) opt out. */
    .pm-readable{ max-width:720px; }
    .pm-form-2{ max-width:860px; }          /* two columns of ~420px — comfortable, not sprawling */
    .pm-prose{ max-width:680px; }           /* body copy: ~75 characters per line */

    /* A single full-width control inside a panel should not span the page either. */
    .pm-panel > .pm-input,
    .pm-panel > select,
    .pm-panel > textarea{ max-width:640px; }

    .pm-modal-backdrop{ align-items:flex-start; padding:6vh 20px 20px; }
    .pm-modal-card{ border-radius:${R.xl}px; }

    .pm-stats{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
    .pm-pack-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:16px; }
    .pm-index-grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:8px; }
    .pm-form-2{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }

    .pm-toolbar{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    .pm-grow{ flex:1; }
    .pm-search{ width:230px; }
    .pm-qrow{ display:flex; align-items:center; gap:14px; padding:12px 16px; }
    .pm-qrow-check{ align-self:center; }
    .pm-qrow-main{ flex:1; min-width:0; }
    .pm-qrow-sentence{ font-size:15px; line-height:1.4; }
    .pm-qrow-meta{ display:flex; align-items:center; gap:10px; flex-shrink:0; }
    .pm-qrow-actions{ display:flex; gap:6px; flex-shrink:0; }
    .pm-qrow-pack{ flex-shrink:0; }

    /* Below desktop — driven by the DEVICE CLASS the JS stamps on <html>, not by raw width, so it
       can never disagree with the JS. (A landscape phone is still a phone.) */
    html.pm-phone .pm-main, html.pm-tablet .pm-main{ padding:24px 20px; }
    html.pm-phone .pm-pack-grid, html.pm-tablet .pm-pack-grid{ grid-template-columns:repeat(2,1fr); }
    html.pm-phone .pm-dash-2, html.pm-tablet .pm-dash-2{ grid-template-columns:1fr !important; }
    html.pm-phone .pm-qrow, html.pm-tablet .pm-qrow{ display:block; position:relative; padding:15px 16px 13px; }
    html.pm-phone .pm-qrow-check, html.pm-tablet .pm-qrow-check{ position:absolute; top:15px; right:15px; width:20px; height:20px; z-index:1; }
    html.pm-phone .pm-qrow-main, html.pm-tablet .pm-qrow-main{ padding-right:34px; }
    html.pm-phone .pm-qrow-sentence, html.pm-tablet .pm-qrow-sentence{ font-size:15.5px; }
    html.pm-phone .pm-qrow-meta, html.pm-tablet .pm-qrow-meta{ margin-top:13px; padding-top:12px; border-top:1px solid var(--lineSoft); gap:10px; }
    html.pm-phone .pm-qrow-actions, html.pm-tablet .pm-qrow-actions{ margin-top:10px; gap:8px; }
    html.pm-phone .pm-qrow-actions button, html.pm-tablet .pm-qrow-actions button{ flex:1; min-height:40px; }
    html.pm-phone .pm-qrow-search .pm-qrow-pack, html.pm-tablet .pm-qrow-search .pm-qrow-pack{ position:absolute; top:13px; right:13px; max-width:55%; }
    html.pm-phone .pm-qrow-search .pm-qrow-main, html.pm-tablet .pm-qrow-search .pm-qrow-main{ padding-right:0; margin-top:2px; }
    html.pm-phone .pm-qrow-search .pm-qrow-pack + .pm-qrow-main, html.pm-tablet .pm-qrow-search .pm-qrow-pack + .pm-qrow-main{ margin-top:34px; }

    /* Legacy width fallback — kept ONLY so the layout is sane for the split-second before React
       mounts and stamps the class. The class rules above win once it does. */
    @media (max-width:1023px){
      .pm-main{ padding:24px 20px; }
      .pm-pack-grid{ grid-template-columns:repeat(2,1fr); }
      .pm-dash-2{ grid-template-columns:1fr !important; }
      /* Question becomes a content-first card below desktop: sentence on top,
         meta + actions in a footer bar, checkbox floated to the top-right so it
         stays out of the reading flow. */
      .pm-qrow{ display:block; position:relative; padding:15px 16px 13px; }
      .pm-qrow-check{ position:absolute; top:15px; right:15px; width:20px; height:20px; z-index:1; }
      .pm-qrow-main{ padding-right:34px; }
      .pm-qrow-sentence{ font-size:15.5px; }
      .pm-qrow-meta{ margin-top:13px; padding-top:12px; border-top:1px solid var(--lineSoft); gap:10px; }
      .pm-qrow-actions{ margin-top:10px; gap:8px; }
      .pm-qrow-actions button{ flex:1; min-height:40px; }
      /* Global-search rows: pack chip moves into the footer, sentence leads. */
      .pm-qrow-search .pm-qrow-pack{ position:absolute; top:13px; right:13px; max-width:55%; }
      .pm-qrow-search .pm-qrow-main{ padding-right:0; margin-top:2px; }
      .pm-qrow-search .pm-qrow-pack + .pm-qrow-main{ margin-top:34px; }
    }
    /* PHONE — including a phone in LANDSCAPE. These are the rules that make it usable at all:
       single-column forms, modals as bottom sheets, and 16px inputs (anything smaller makes iOS
       auto-zoom on focus). They used to be locked behind max-width:639px, so a rotated phone lost
       every one of them. */
    html.pm-phone .pm-main{ padding:16px 14px; }
    html.pm-phone .pm-stats{ grid-template-columns:repeat(2,1fr); gap:10px; }
    html.pm-phone .pm-pack-grid{ grid-template-columns:1fr; gap:12px; }
    html.pm-phone .pm-index-grid{ grid-template-columns:1fr 1fr; gap:7px; }
    html.pm-phone .pm-form-2{ grid-template-columns:1fr; gap:14px; }
    html.pm-phone .pm-toolbar > *{ flex:1 1 auto; }
    html.pm-phone .pm-search{ width:100%; order:-1; flex-basis:100%; }
    html.pm-phone .pm-grow{ flex-basis:100%; height:0; }
    html.pm-phone .pm-qrow-sentence{ font-size:16px; }
    html.pm-phone .pm-about-grid{ grid-template-columns:1fr !important; }
    html.pm-phone .pm-gen-grid{ grid-template-columns:1fr !important; }
    html.pm-phone .pm-modal-backdrop{ align-items:flex-end; padding:0; }
    html.pm-phone .pm-modal-card{ max-width:100% !important; border-radius:20px 20px 0 0; max-height:94vh; overflow-y:auto; animation:pm-sheet .22s ease-out; }
    html.pm-phone .pm-input{ font-size:16px !important; }

    /* ---- A PHONE IN LANDSCAPE ----
       It has phone CHROME (bottom nav, touch targets, 16px inputs) but ~800px of WIDTH and almost
       no height. Left on the portrait rules, a single form field stretches to 812px — an enormous
       input marooned in white space. That is the "white space / broken layout" problem: content
       with no constraint simply fills whatever width exists.
       So: keep the phone chrome, but let the CONTENT use the width like a small tablet, and cap it
       so nothing stretches absurdly. */
    html.pm-phone.pm-landscape .pm-form-2{ grid-template-columns:1fr 1fr; gap:14px; }   /* was 1 huge column */
    html.pm-phone.pm-landscape .pm-pack-grid{ grid-template-columns:repeat(2,1fr); }
    html.pm-phone.pm-landscape .pm-stats{ grid-template-columns:repeat(4,1fr); }
    html.pm-phone.pm-landscape .pm-index-grid{ grid-template-columns:repeat(3,1fr); }   /* was 2 × 402px */
    html.pm-phone.pm-landscape .pm-about-grid{ grid-template-columns:1fr 1fr !important; }
    html.pm-phone.pm-landscape .pm-gen-grid{ grid-template-columns:1fr 1fr !important; }

    /* Short screen: a bottom sheet must not eat the whole viewport, and it needs to scroll. */
    html.pm-phone.pm-landscape .pm-modal-card{ max-height:92vh; }

    /* Landscape has notches on the SIDES. Pad for them (viewport-fit=cover puts content under). */
    html.pm-phone.pm-landscape .pm-main{
      padding-left: max(20px, env(safe-area-inset-left));
      padding-right: max(20px, env(safe-area-inset-right));
    }

    /* ANY touch device gets finger-sized hit targets, regardless of screen size. */
    html.pm-coarse button, html.pm-coarse .pm-input, html.pm-coarse select{ min-height:40px; }
    html.pm-coarse .pm-input, html.pm-coarse select, html.pm-coarse textarea{ font-size:16px !important; }

    @keyframes pm-sheet{ from{ transform:translateY(100%);} to{ transform:translateY(0);} }

    /* Legacy width fallback — pre-mount only. */
    @media (max-width:639px){
      .pm-main{ padding:16px 14px; }
      .pm-stats{ grid-template-columns:repeat(2,1fr); gap:10px; }
      .pm-pack-grid{ grid-template-columns:1fr; gap:12px; }
      .pm-index-grid{ grid-template-columns:1fr 1fr; gap:7px; }
      .pm-form-2{ grid-template-columns:1fr; gap:14px; }
      .pm-toolbar > *{ flex:1 1 auto; }
      .pm-search{ width:100%; order:-1; flex-basis:100%; }
      .pm-grow{ flex-basis:100%; height:0; }
      .pm-qrow-sentence{ font-size:16px; }
      .pm-about-grid{ grid-template-columns:1fr !important; }
      .pm-gen-grid{ grid-template-columns:1fr !important; }
      .pm-modal-backdrop{ align-items:flex-end; padding:0; }
      .pm-modal-card{ max-width:100% !important; border-radius:20px 20px 0 0; max-height:94vh; overflow-y:auto; animation:pm-sheet .22s ease-out; }
      @keyframes pm-sheet{ from{ transform:translateY(100%);} to{ transform:translateY(0);} }
      .pm-input{ font-size:16px !important; }
    }
    @media (prefers-reduced-motion:reduce){ *{ animation-duration:.001ms !important; scroll-behavior:auto !important; } }
  `}</style>;
}

