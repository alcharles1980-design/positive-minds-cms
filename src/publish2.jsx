// ============================================================
// Publishing Hub — profiles, channels, controls, history
// ============================================================
const FEED_BASE = `${CFG.url}/functions/v1/game-feed`;
const PUSH_CFG_KEY = "pm_push_config";
const getPushCfg = () => { try { return JSON.parse(localStorage.getItem(PUSH_CFG_KEY) || "{}"); } catch { return {}; } };
const setPushCfg = (c) => { try { localStorage.setItem(PUSH_CFG_KEY, JSON.stringify(c)); } catch {} };

function PublishHub({ packs, onSynced }) {
  const profilesState = useAsync(() => db_profiles.list(), []);
  const profiles = profilesState.data || [];
  const targetsState = useAsync(() => db_targets.list(), []);
  const targets = targetsState.data || [];
  const [editProfile, setEditProfile] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [showFnDocs, setShowFnDocs] = useState(false);
  const [sample, setSample] = useState({ packs: [], byPack: {}, questionCount: 0 });
  const [sub, setSub] = useState("profiles"); // profiles | targets | channels | history
  const [busyId, setBusyId] = useState(null);

  useEffect(() => { fetchAllContent({ status: "published", question_status: "active" }, { expandLevels: true }).then(setSample).catch(() => {}); }, []);

  const pendingCount = (packs || []).filter(p => p.has_pending_changes && p.status === "published").length;

  const saveProfile = async (payload, id) => {
    if (id) await db_profiles.update(id, payload); else await db_profiles.create(payload);
    await profilesState.reload(); notify(id ? "Profile saved" : "Profile created");
  };
  const deleteProfile = async (p) => {
    const ok = await confirmDialog({ title: `Delete "${p.name}"?`, message: "This removes the export profile. Content is unaffected.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await db_profiles.remove(p.id); await profilesState.reload(); notify("Profile deleted");
  };

  const saveTarget = async (payload, id) => {
    if (id) await db_targets.update(id, payload); else await db_targets.create(payload);
    await targetsState.reload(); notify(id ? "Target saved" : "Target created");
  };
  const deleteTarget = async (t) => {
    const ok = await confirmDialog({ title: `Delete "${t.name}"?`, message: "Removes this sync target. Content is unaffected.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    await db_targets.remove(t.id); await targetsState.reload(); notify("Target deleted");
  };
  const syncTarget = async (t) => {
    const profile = profiles.find(p => p.id === t.profile_id);
    if (!profile) { notify("This target's profile is missing", { kind: "error" }); return; }
    setBusyId(t.id);
    try {
      const r = await runFirebaseSync(t, profile);
      await db_sync.markReleased(null); // clear pending-changes on published packs
      await db_sync.log({ profile_id: profile.id, profile_name: profile.name, target_name: t.name, channel: "push", mode: "manual", status: "success", pack_count: r.packCount, question_count: r.questionCount, detail: `${r.opCount} writes → Firebase` });
      logActivity("target", t.id, t.name, "import", `synced ${r.packCount} packs to Firebase`);
      onSynced && onSynced();
      notify(`Synced ${r.opCount} writes to ${t.name}`);
    } catch (e) {
      await db_sync.log({ profile_id: t.profile_id, target_name: t.name, channel: "push", mode: "manual", status: "error", detail: e.message });
      notify("Sync failed: " + e.message, { kind: "error", duration: 6000 });
    } finally { setBusyId(null); }
  };

  // Build + download a file through a profile
  const exportFile = async (profile, format = "json") => {
    setBusyId(profile.id);
    try {
      const content = await fetchAllContent(profile.spec.filters || {}, { expandLevels: !!profile.spec.expand_levels });
      const spec = { ...profile.spec, __name: profile.name };
      const body = buildOutput(spec, content.packs, content.byPack, "id");
      const out = withMeta(spec, body, { packs: content.packs.length, questions: content.questionCount });
      const isXml = format === "xml";
      const text = isXml ? toXml(out, "gameContent") : JSON.stringify(out, null, 2);
      const blob = new Blob([text], { type: isXml ? "application/xml" : "application/json" });
      const url = URL.createObjectURL(blob); const a = document.createElement("a");
      a.href = url; a.download = `game-content-${slugify(profile.name)}-${Date.now()}.${isXml ? "xml" : "json"}`; a.click(); URL.revokeObjectURL(url);
      await db_sync.log({ profile_id: profile.id, profile_name: profile.name, channel: "file", mode: "manual", status: "success", pack_count: content.packs.length, question_count: content.questionCount, detail: format.toUpperCase() });
      logActivity("profile", profile.id, profile.name, "import", `exported ${content.packs.length} packs to ${format.toUpperCase()} file`);
      notify(`Exported ${content.packs.length} packs (${format.toUpperCase()})`);
    } catch (e) { notify("Export failed: " + e.message, { kind: "error" }); }
    finally { setBusyId(null); }
  };

  // Push to configured game backend
  const pushToGame = async (profile) => {
    const cfg = getPushCfg();
    if (!cfg.url) { notify("Set a push target URL in Channels first", { kind: "error" }); setSub("channels"); return; }
    setBusyId(profile.id);
    try {
      const content = await fetchAllContent(profile.spec.filters || {}, { expandLevels: !!profile.spec.expand_levels });
      const spec = { ...profile.spec, __name: profile.name };
      const body = buildOutput(spec, content.packs, content.byPack, "id");
      const out = withMeta(spec, body, { packs: content.packs.length, questions: content.questionCount });
      const headers = { "Content-Type": "application/json" };
      if (cfg.secret) headers[cfg.header || "Authorization"] = cfg.secret;
      const res = await fetch(cfg.url, { method: cfg.method || "POST", headers, body: JSON.stringify(out) });
      const okay = res.ok;
      await db_sync.log({ profile_id: profile.id, profile_name: profile.name, channel: "push", mode: "manual", status: okay ? "success" : "error", pack_count: content.packs.length, question_count: content.questionCount, detail: `HTTP ${res.status}` });
      if (okay) { await db_sync.markReleased(null); logActivity("profile", profile.id, profile.name, "import", `pushed to game (${content.packs.length} packs)`); onSynced && onSynced(); notify(`Pushed ${content.packs.length} packs to game`); }
      else notify(`Push returned HTTP ${res.status}`, { kind: "error" });
    } catch (e) {
      await db_sync.log({ profile_id: profile.id, profile_name: profile.name, channel: "push", mode: "manual", status: "error", detail: e.message });
      notify("Push failed: " + e.message + " (CORS or unreachable target?)", { kind: "error", duration: 6000 });
    } finally { setBusyId(null); }
  };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Publishing</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Shape content with profiles, then sync to the game via file, feed, or push.</p>
      </div>

      {pendingCount > 0 && (
        <div style={{ background: C.warnSoft, borderRadius: R.md, padding: "12px 16px", marginBottom: S.lg, fontSize: 13.5, color: C.warnInk, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 16 }}>⚡</span><b>{pendingCount}</b> published pack{pendingCount === 1 ? " has" : "s have"} changes not yet synced to the game.
        </div>
      )}

      {/* sub-tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: S.lg, borderBottom: "1px solid " + C.line, flexWrap: "wrap" }}>
        {[["profiles", "Export profiles"], ["targets", "🔥 Firebase targets"], ["channels", "Channels & sync"], ["history", "Sync history"]].map(([v, l]) => (
          <button key={v} onClick={() => setSub(v)} style={{ padding: "10px 16px", border: "none", borderBottom: "2px solid " + (sub === v ? C.brand : "transparent"), background: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 700, color: sub === v ? C.ink : C.sub, marginBottom: -1 }}>{l}</button>
        ))}
      </div>

      {sub === "profiles" && (
        <div>
          <div className="pm-toolbar" style={{ marginBottom: S.lg }}>
            <div style={{ fontSize: 13.5, color: C.sub }}>{profiles.length} profile{profiles.length === 1 ? "" : "s"} — each defines a target format</div>
            <div className="pm-grow" />
            <Btn size="sm" onClick={() => setEditProfile({})} icon="＋">New profile</Btn>
          </div>
          {profilesState.loading ? <div style={{ display: "grid", gap: 10 }}>{[0,1,2].map(i => <Skeleton key={i} h={72} r={12} />)}</div>
            : profiles.length === 0 ? <EmptyState icon="🧩" title="No profiles yet" body="Create a profile to define how your content maps to a game backend's format." action={<Btn onClick={() => setEditProfile({})} icon="＋">Create profile</Btn>} />
            : (
              <div style={{ display: "grid", gap: 12 }}>
                {profiles.map(p => (
                  <div key={p.id} style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>{p.name}</span>
                          {p.is_builtin && <Pill tone="info">starter</Pill>}
                          <Pill tone="muted">{p.spec?.structure || "nested"}</Pill>
                        </div>
                        {p.description && <div style={{ fontSize: 13, color: C.sub, marginTop: 4 }}>{p.description}</div>}
                        <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>
                          {(p.spec?.pack_fields?.length || 0)} pack fields · {(p.spec?.question_fields?.length || 0)} question fields · {p.spec?.filters?.status || "all"} packs
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Btn variant="ghost" size="sm" onClick={() => setEditProfile(p)}>Edit</Btn>
                        <Btn variant="ghost" size="sm" disabled={busyId === p.id} onClick={() => exportFile(p, "json")} icon="⭱">JSON</Btn>
                        <Btn variant="ghost" size="sm" disabled={busyId === p.id} onClick={() => exportFile(p, "xml")} icon="⭱">XML</Btn>
                        <Btn variant="soft" size="sm" disabled={busyId === p.id} onClick={() => pushToGame(p)} icon="⇧">{busyId === p.id ? "…" : "Push"}</Btn>
                        {!p.is_builtin && <Btn variant="danger" size="sm" onClick={() => deleteProfile(p)}>Delete</Btn>}
                      </div>
                    </div>
                    {/* feed URL for this profile */}
                    <FeedRow profile={p} />
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {sub === "channels" && <ChannelsPanel profiles={profiles} />}
      {sub === "history" && <SyncHistory />}

      {sub === "targets" && (
        <div>
          <div className="pm-toolbar" style={{ marginBottom: S.lg }}>
            <div style={{ fontSize: 13.5, color: C.sub }}>Saved Firebase destinations — each pairs a profile with a database + layout</div>
            <div className="pm-grow" />
            <Btn variant="ghost" size="sm" onClick={() => setShowFnDocs(true)} icon="⚡">Function sample</Btn>
            <Btn size="sm" onClick={() => setEditTarget({})} icon="＋">New target</Btn>
          </div>
          {targetsState.loading ? <div style={{ display: "grid", gap: 10 }}>{[0,1].map(i => <Skeleton key={i} h={80} r={12} />)}</div>
            : targets.length === 0 ? <EmptyState icon="🔥" title="No Firebase targets yet" body="Add a target to write content into Firestore or Realtime Database — directly or via a Cloud Function." action={<Btn onClick={() => setEditTarget({})} icon="＋">Add Firebase target</Btn>} />
            : (
              <div style={{ display: "grid", gap: 12 }}>
                {targets.map(t => {
                  const prof = profiles.find(p => p.id === t.profile_id);
                  const modeLabel = { rtdb: "Realtime DB", firestore: "Firestore", cloudfn: "Cloud Function" }[t.config?.mode] || "Firebase";
                  return (
                    <div key={t.id} style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                        <div style={{ fontSize: 26 }}>🔥</div>
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>{t.name}</span>
                            <Pill tone="info">{modeLabel}</Pill>
                            {prof ? <Pill tone="muted">{prof.name}</Pill> : <Pill tone="muted">⚠ no profile</Pill>}
                          </div>
                          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 5, fontFamily: "ui-monospace,monospace" }}>
                            {t.config?.mode === "cloudfn" ? (t.config?.fnUrl || "no URL set")
                              : t.config?.mode === "firestore" ? `project: ${t.config?.projectId || "—"} · ${t.config?.layout || "per-pack"}`
                              : `${t.config?.rtdbUrl || "no URL set"} · ${t.config?.layout || "per-pack"}`}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <Btn variant="ghost" size="sm" onClick={() => setEditTarget(t)}>Edit</Btn>
                          <Btn size="sm" disabled={busyId === t.id || !prof} onClick={() => syncTarget(t)} icon="🔥">{busyId === t.id ? "Syncing…" : "Sync now"}</Btn>
                          <Btn variant="danger" size="sm" onClick={() => deleteTarget(t)}>Delete</Btn>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      )}

      <Modal open={editProfile !== null} onClose={() => setEditProfile(null)} width={720}>
        {editProfile !== null && <ProfileBuilder profile={editProfile.id ? editProfile : null} sampleContent={sample} onSave={saveProfile} onClose={() => setEditProfile(null)} />}
      </Modal>
      <Modal open={editTarget !== null} onClose={() => setEditTarget(null)} width={640}>
        {editTarget !== null && <FirebaseTargetEditor target={editTarget.id ? editTarget : null} profiles={profiles} sampleContent={sample} onSave={saveTarget} onClose={() => setEditTarget(null)} />}
      </Modal>
      <Modal open={showFnDocs} onClose={() => setShowFnDocs(false)} width={640}>
        {showFnDocs && <CloudFnDocs onClose={() => setShowFnDocs(false)} />}
      </Modal>
    </div>
  );
}

function FeedRow({ profile }) {
  const url = `${FEED_BASE}?profile=${encodeURIComponent(profile.name)}`;
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid " + C.lineSoft }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: C.faint, whiteSpace: "nowrap" }}>PULL FEED</span>
      <code style={{ flex: 1, fontSize: 11.5, color: C.ink2, background: C.bg, padding: "6px 10px", borderRadius: R.sm, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</code>
      <Btn variant="ghost" size="xs" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</Btn>
    </div>
  );
}

// A compact API reference, on the page a developer is already on when they wonder how to pull.
// Written to answer the question people actually arrive with — "which endpoint, and how do I ask
// for only what I need" — rather than to enumerate every parameter alphabetically.
function ApiRow({ param, children, eg }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(150px,190px) 1fr", gap: S.md, padding: "9px 0", borderTop: `1px solid ${C.line}`, alignItems: "start" }}>
      <code style={{ fontSize: 12, fontWeight: 700, color: C.brandInk, fontFamily: "ui-monospace,Menlo,monospace", wordBreak: "break-all" }}>{param}</code>
      <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55 }}>
        {children}
        {eg && <div style={{ marginTop: 4, fontSize: 11.5, color: C.faint, fontFamily: "ui-monospace,Menlo,monospace" }}>{eg}</div>}
      </div>
    </div>
  );
}

function ApiReference() {
  const SYNC = `${CFG.url}/functions/v1/content-api`;
  const FEED = `${CFG.url}/functions/v1/game-feed`;
  const [tab, setTab] = useState("sync");
  const Code = ({ children }) => (
    <code style={{ display: "block", fontSize: 11.5, color: C.ink2, background: C.bg, padding: "9px 11px",
      borderRadius: R.sm, overflowX: "auto", whiteSpace: "pre", fontFamily: "ui-monospace,Menlo,monospace", marginTop: 6 }}>{children}</code>
  );

  return (
    <Channel icon="⚙" title="API reference" desc="Two endpoints. One keeps a backend in step; the other reshapes content for a specific engine.">
      <div style={{ display: "flex", gap: 6, marginBottom: S.md, flexWrap: "wrap" }}>
        {[["sync", "content-api — syncing"], ["feed", "game-feed — shaping"], ["recipes", "Recipes"]].map(([id, label]) => (
          <Btn key={id} size="sm" variant={tab === id ? "primary" : "ghost"} onClick={() => setTab(id)}>{label}</Btn>
        ))}
      </div>

      {tab === "sync" && (
        <div>
          <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.6, marginBottom: S.sm }}>
            For the recurring pull that keeps a backend in step. Versioned, incremental, cacheable.
            Everything below is optional — with no parameters you get all published packs, their
            active questions, the level definitions, and every pre-rendered level variant.
          </div>
          <Code>{SYNC}</Code>
          <ApiRow param="?manifest=1">Versions only — global version, per-pack versions, counts. Cheap enough to poll on a timer to decide whether a real pull is needed.</ApiRow>
          <ApiRow param="?since=<iso|epoch>" eg="?since=2026-08-01T00:00:00Z">Only what changed since that moment, plus a <code>deletions</code> array of tombstones so you can remove what was withdrawn.</ApiRow>
          <ApiRow param="?include=…" eg="?include=packs,questions">Choose blocks: <b>packs</b>, <b>questions</b>, <b>levels</b>, <b>variants</b>, <b>stats</b>, <b>deletions</b>, or <b>all</b>. Omitting <b>variants</b> shrinks the payload roughly 19x (363KB → 19KB) — do that if your client masks its own words.</ApiRow>
          <ApiRow param="?include=stats">Content status only, no content: pack and question counts, review-queue totals, and per-pack live/pending/approved/rejected with descriptions and versions.</ApiRow>
          <ApiRow param="?shape=nested|keyed|flat">nested (default) nests questions in packs; <b>keyed</b> returns packs as an object keyed by slug, which is what Firestore wants; <b>flat</b> returns one array of questions each carrying pack_slug.</ApiRow>
          <ApiRow param="?packs= / ?levels=" eg="?packs=calmness,focus&levels=1,2,3">Narrow to specific packs by slug, or to specific levels in the variant expansion.</ApiRow>
          <ApiRow param="?released=1">Only content that has been deliberately released (released_version ≥ content_version). Off by default — see the note below.</ApiRow>
          <ApiRow param="?format=xml">XML instead of JSON, for any of the above.</ApiRow>
          <div style={{ marginTop: S.md, padding: "10px 12px", background: C.bg, borderRadius: R.sm, fontSize: 12.5, color: C.ink2, lineHeight: 1.6 }}>
            <b>Use the ETag.</b> Every response carries one. Send it back as <code>If-None-Match</code> and
            an unchanged pull returns <b>304</b> with no body. The ETag covers every parameter above, so
            switching <code>include</code> or <code>shape</code> always fetches fresh rather than
            returning a stale 304 for a different question.
          </div>
        </div>
      )}

      {tab === "feed" && (
        <div>
          <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.6, marginBottom: S.sm }}>
            For when the consumer needs <i>its</i> vocabulary rather than ours. A profile renames every
            field, transforms values, and picks the structure — edit them under Export profiles.
          </div>
          <Code>{FEED}</Code>
          <ApiRow param="?list=1">Every available profile, with id and description.</ApiRow>
          <ApiRow param="?profile=<id|name>" eg="?profile=Firebase (nested)">Export in that profile's shape. Defaults to the first built-in.</ApiRow>
          <ApiRow param="?stats=1 | ?stats=only">Add the content-status block, or return it alone. A profile can set this permanently; the parameter overrides it per request.</ApiRow>
          <ApiRow param="?packs=" eg="?packs=calmness,focus">Narrow to specific packs — same parameter name as content-api, on purpose.</ApiRow>
          <ApiRow param="?released=1">Only released content, as above.</ApiRow>
          <ApiRow param="?format=xml">XML instead of JSON.</ApiRow>
          <div style={{ marginTop: S.md, padding: "10px 12px", background: C.bg, borderRadius: R.sm, fontSize: 12.5, color: C.ink2, lineHeight: 1.6 }}>
            <b>Which one do I want?</b> If you are keeping a backend in step, use <b>content-api</b> —
            only it has versioning, <code>?since</code>, deletions and 304s. If you need field names to
            match an existing game, use <b>game-feed</b> with a profile. Both read the same content and
            both can return the same stats block.
          </div>
        </div>
      )}

      {tab === "recipes" && (
        <div style={{ display: "grid", gap: S.md }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Firebase / Firestore</div>
            <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55, marginTop: 3 }}>Packs keyed by slug drop straight into a document collection with no client-side reindexing.</div>
            <Code>{`${SYNC}?shape=keyed&include=packs,questions`}</Code>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>A game that masks its own words</div>
            <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55, marginTop: 3 }}>Skip the pre-rendered variants and carry the level rules instead. About 19x smaller.</div>
            <Code>{`${SYNC}?include=packs,questions,levels`}</Code>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Polling for changes, cheaply</div>
            <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55, marginTop: 3 }}>Check the manifest; pull only when global_version moves. Or send your ETag and act on a 200.</div>
            <Code>{`${SYNC}?manifest=1\n${SYNC}?since=<last successful sync>`}</Code>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>A status dashboard</div>
            <div style={{ fontSize: 12.5, color: C.ink2, lineHeight: 1.55, marginTop: 3 }}>Counts and per-pack figures without loading a single question.</div>
            <Code>{`${SYNC}?include=stats`}</Code>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>A SQL import or a plain table</div>
            <Code>{`${SYNC}?shape=flat&include=packs,questions`}</Code>
          </div>
        </div>
      )}
    </Channel>
  );
}

function ChannelsPanel({ profiles }) {
  const [cfg, setCfg] = useState(getPushCfg());
  const [mode, setMode] = useState(cfg.mode || "manual");
  const save = (next) => { const merged = { ...cfg, ...next }; setCfg(merged); setPushCfg(merged); };

  return (
    <div style={{ display: "grid", gap: S.lg }}>
      <ApiReference />
      {/* Feed */}
      <Channel icon="🔗" title="Pull feed (game fetches on its own)" desc="A stable public URL that returns transformed content. The game backend polls this on its schedule. Most robust — works with any backend.">
        <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 6 }}>Base endpoint:</div>
        <code style={{ display: "block", fontSize: 12, color: C.ink2, background: C.bg, padding: "10px 12px", borderRadius: R.sm, overflowX: "auto" }}>{FEED_BASE}?profile=&lt;name&gt;</code>
        <div style={{ fontSize: 12, color: C.faint, marginTop: 8 }}>Add <code>?list=1</code> to enumerate profiles. Content is cached ~60s. Uses each profile's filters (published/active).</div>
      </Channel>

      {/* Push */}
      <Channel icon="⇧" title="Push (CMS sends to game on publish)" desc="The CMS POSTs the transformed payload to your game backend endpoint. Configure the target below.">
        <div style={{ display: "grid", gap: S.md }}>
          <Field label="Target URL" hint="Your game backend endpoint (Firebase function, custom API, etc.)">
            <Input value={cfg.url || ""} onChange={(e) => save({ url: e.target.value })} placeholder="https://your-game-backend.com/ingest" />
          </Field>
          <div className="pm-form-2">
            <Field label="Method"><Select value={cfg.method || "POST"} onChange={(e) => save({ method: e.target.value })}><option>POST</option><option>PUT</option></Select></Field>
            <Field label="Auth header name" hint="Optional"><Input value={cfg.header || ""} onChange={(e) => save({ header: e.target.value })} placeholder="Authorization" /></Field>
          </div>
          <Field label="Auth header value / secret" hint="Optional — sent with each push">
            <Input type="password" value={cfg.secret || ""} onChange={(e) => save({ secret: e.target.value })} placeholder="Bearer …" />
          </Field>
          <div style={{ fontSize: 12, color: C.warnInk, background: C.warnSoft, padding: "8px 12px", borderRadius: R.sm }}>
            Note: the target must allow browser (CORS) requests, or run pushes from a server. Since the game backend isn't finalized, this is ready to point at it once decided.
          </div>
        </div>
      </Channel>

      {/* Control mode */}
      <Channel icon="⚙" title="Sync control" desc="How and when content flows to the game.">
        <div style={{ display: "grid", gap: 8 }}>
          {[["manual", "Manual", "You click Push / export a file when you're ready. Full control."],
            ["auto", "Auto on publish", "Pushes automatically whenever a pack is published or edited. (Requires push target.)"],
            ["scheduled", "Scheduled", "Batched syncs on an interval. (Runs via a scheduled job — set up server-side.)"]].map(([v, l, d]) => (
            <label key={v} style={{ display: "flex", gap: 11, alignItems: "flex-start", padding: 12, borderRadius: R.md, border: "1px solid " + (mode === v ? C.brand : C.line), background: mode === v ? C.brandSoft : C.panel, cursor: "pointer" }}>
              <input type="radio" name="syncmode" checked={mode === v} onChange={() => { setMode(v); save({ mode: v }); }} style={{ marginTop: 2, accentColor: C.brand }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{l}</div>
                <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>{d}</div>
              </div>
            </label>
          ))}
        </div>
        {mode === "auto" && <div style={{ fontSize: 12, color: C.sub, marginTop: 10, background: C.infoSoft, padding: "8px 12px", borderRadius: R.sm }}>Auto-push fires from the app when you're signed in and make a change. For guaranteed delivery even when the CMS is closed, pair with the pull feed.</div>}
      </Channel>
    </div>
  );
}
function Channel({ icon, title, desc, children }) {
  return (
    <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.xl }}>
      <div style={{ display: "flex", gap: 12, marginBottom: S.md }}>
        <div style={{ fontSize: 22 }}>{icon}</div>
        <div><div style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>{title}</div><div style={{ fontSize: 13, color: C.sub, marginTop: 2, lineHeight: 1.5 }}>{desc}</div></div>
      </div>
      {children}
    </div>
  );
}

function SyncHistory() {
  const { loading, error, data, reload } = useAsync(() => db_sync.history(), []);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const rows = data || [];
  const chIcon = { file: "⭱", feed: "🔗", push: "⇧" };
  const rel = (iso) => { const d = (Date.now() - new Date(iso)) / 1000; if (d < 60) return "just now"; if (d < 3600) return Math.floor(d / 60) + "m ago"; if (d < 86400) return Math.floor(d / 3600) + "h ago"; return Math.floor(d / 86400) + "d ago"; };
  return loading ? <div style={{ display: "grid", gap: 8 }}>{[0,1,2].map(i => <Skeleton key={i} h={52} r={10} />)}</div>
    : rows.length === 0 ? <EmptyState icon="🕓" title="No syncs yet" body="Every file export, feed pull, and push to the game will be logged here." />
    : (
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
        {rows.map((r, i) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderTop: i ? "1px solid " + C.lineSoft : "none" }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: r.status === "error" ? C.dangerSoft : C.brandSoft, color: r.status === "error" ? C.dangerInk : C.brandInk, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>{chIcon[r.channel] || "•"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, color: C.ink }}><b style={{ fontWeight: 700, textTransform: "capitalize" }}>{r.channel}</b> · {r.profile_name || "—"} {r.status === "error" && <span style={{ color: C.danger, fontWeight: 700 }}>· failed</span>}</div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 1 }}>{r.pack_count} packs · {r.question_count} questions{r.detail ? ` · ${r.detail}` : ""}</div>
            </div>
            <div style={{ fontSize: 12, color: C.faint, whiteSpace: "nowrap" }}>{rel(r.created_at)}</div>
          </div>
        ))}
      </div>
    );
}
