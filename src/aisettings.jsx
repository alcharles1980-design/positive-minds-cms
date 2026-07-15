// ============================================================
// AI Settings — choose the provider, save API keys, generate content.
//
// SECURITY: keys are stored in pm_ai_config, a table the browser CANNOT read (RLS has no select
// policy for anon OR authenticated — verified empirically). Keys are written via the
// pm_ai_set_key RPC and read ONLY server-side by the generate-questions edge function.
// This page can never display a key back to you: it shows "Configured ••••••1234" and nothing
// more. That means even someone with your login (or an XSS bug in this app) cannot lift them.
// ============================================================

const PROVIDERS = [
  {
    id: "anthropic", name: "Anthropic (Claude)", emoji: "◆",
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-opus-4-1", "claude-haiku-4-5"],
    keyHint: "Starts with sk-ant-",
    where: "console.anthropic.com → API Keys",
  },
  {
    id: "openai", name: "OpenAI (GPT)", emoji: "◇",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    keyHint: "Starts with sk-",
    where: "platform.openai.com → API keys",
  },
  {
    id: "gemini", name: "Google (Gemini)", emoji: "◈",
    defaultModel: "gemini-2.0-flash",
    models: ["gemini-2.0-flash", "gemini-1.5-pro"],
    keyHint: "A long alphanumeric key",
    where: "aistudio.google.com → Get API key",
  },
];

// What each setting actually DOES — explained for THIS job (writing children's puzzle content),
// not as generic API documentation. Shown behind an (i) on each field.
const SETTING_HELP = {
  model: {
    title: "Model",
    what: "Which version of the AI writes your content.",
    why: "Bigger models follow the rules more reliably and need fewer repair rounds; smaller ones are cheaper and faster. For this job — short sentences with strict constraints — a mid-tier model is usually plenty.",
    tip: "If you're seeing a lot of flagged questions, try a stronger model before fiddling with anything else.",
  },
  max_tokens: {
    title: "Max tokens",
    what: "A hard ceiling on how much the AI may write in one reply.",
    why: "This is a safety limit, not a target — it doesn't make the AI write more. But if it's too LOW the reply gets cut off mid-sentence, the JSON is broken, and the whole batch fails.",
    tip: "Roughly 150 tokens per question. 20 questions ≈ 3,000. Leave headroom. If a batch fails with 'ran out of output tokens', raise this or ask for fewer questions.",
  },
  temperature: {
    title: "Temperature",
    what: "How adventurous the AI is. 0 = careful and repetitive. 1 = creative and unpredictable.",
    why: "Your content has strict mechanical rules (different-length words, exactly one blank). Lower temperatures follow rules more faithfully. Higher ones write more varied sentences but break the rules more often — which means more flagged questions to fix.",
    tip: "0.3–0.6 is a good range here: varied enough to be interesting, disciplined enough to stay valid. Leave it BLANK to use the model's default.",
    warn: "Some newer models (Claude Opus 4.7+, OpenAI's reasoning models) REJECT this parameter outright and will error. If generation suddenly fails after you set it, clear it.",
  },
  top_p: {
    title: "Top-p",
    what: "An alternative way to control randomness, by limiting the pool of words the AI chooses from.",
    why: "It does a similar job to temperature. Adjust one or the other — not both.",
    tip: "Most people should leave this blank and just use temperature.",
    warn: "Like temperature, some newer models reject this outright.",
  },
  system_prompt: {
    title: "System prompt",
    what: "The standing instructions the AI is given before it sees your request — its brief.",
    why: "This is where the game's rules live: both words must be positive, they must be different lengths, output only JSON. Models follow system instructions far more reliably than the same words buried in a request.",
    tip: "Leave blank to use the built-in brief (recommended). Only edit if you want to permanently change how the AI approaches every batch — e.g. a house style, or a reading age.",
  },
  batch_size: {
    title: "Questions per batch",
    what: "How many questions to ask for in one go.",
    why: "Bigger batches are more efficient, but a large batch is more likely to hit the token ceiling and more likely to repeat itself.",
    tip: "10–15 is a comfortable size. If batches keep failing, come down.",
  },
  auto_repair: {
    title: "Auto-fix flagged questions",
    what: "When a question fails the automatic checks, send it straight back to the AI with the exact problem and ask it to fix it.",
    why: "It catches most mechanical mistakes (same-length words, a missing blank) without you doing anything — you just see fewer flagged rows to deal with.",
    tip: "Costs one extra request per batch. Worth it. The human review gate is unaffected — you still approve everything either way.",
  },
};

// An (i) that opens a plain-English explanation of a setting.
function InfoDot({ setting }) {
  const [open, setOpen] = useState(false);
  const h = SETTING_HELP[setting];
  if (!h) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} title={`What is ${h.title}?`} aria-label={`What is ${h.title}?`}
        style={{ width: 16, height: 16, borderRadius: "50%", border: "1px solid " + C.line, background: C.bg,
          color: C.faint, fontSize: 10.5, fontWeight: 800, cursor: "pointer", lineHeight: 1, padding: 0,
          display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          fontFamily: "inherit", marginLeft: 5, verticalAlign: "middle" }}>i</button>
      <Modal open={open} onClose={() => setOpen(false)} width={460}>
        <ModalHead title={h.title} subtitle={h.what} />
        <div style={{ padding: S.xl, display: "grid", gap: S.md }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: .3, textTransform: "uppercase", marginBottom: 5 }}>Why it matters here</div>
            <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.6 }}>{h.why}</div>
          </div>
          <div style={{ background: C.brandSoft, borderRadius: R.md, padding: "11px 14px" }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: C.brandInk, letterSpacing: .3, textTransform: "uppercase", marginBottom: 5 }}>Suggested</div>
            <div style={{ fontSize: 13.5, color: C.brandInk, lineHeight: 1.6 }}>{h.tip}</div>
          </div>
          {h.warn && (
            <div style={{ background: C.danger + "10", border: "1px solid " + C.danger + "33", borderRadius: R.md, padding: "11px 14px" }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: C.danger, letterSpacing: .3, textTransform: "uppercase", marginBottom: 5 }}>Careful</div>
              <div style={{ fontSize: 13.5, color: C.danger, lineHeight: 1.6 }}>{h.warn}</div>
            </div>
          )}
        </div>
        <ModalFoot><Btn onClick={() => setOpen(false)}>Got it</Btn></ModalFoot>
      </Modal>
    </>
  );
}

// A Field with an (i) next to its label.
//
// TWO bugs lived here, both caught by actually reading the rendered page:
//   1. The first version used a <div>+<span> — no programmatic label association at all.
//   2. The fix wrapped the control in a SECOND, EMPTY <label>. It was "associated", so my check
//      passed — but the label had no text, so a screen reader announced an unnamed field.
// The correct shape: ONE label that contains BOTH the text and the control. The (i) button sits
// outside it, because a button inside a label swallows clicks meant for the field.
function HelpField({ setting, label, hint, children, style }) {
  const h = SETTING_HELP[setting];
  const text = label || h?.title;
  return (
    <div style={style}>
      <label style={{ display: "block" }}>
        <span style={{ display: "inline-flex", alignItems: "center", marginBottom: 5,
          fontSize: 12, fontWeight: 700, color: C.ink2 }}>{text}</span>
        {children}
      </label>
      {/* Outside the label on purpose — see above. Pulled up to sit beside the label text. */}
      <span style={{ float: "right", marginTop: -26 }}><InfoDot setting={setting} /></span>
      {hint && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4, lineHeight: 1.4, clear: "both" }}>{hint}</div>}
    </div>
  );
}

const db_ai = {
  status: () => rpc("pm_ai_status"),
  usage: () => rpc("pm_ai_usage_summary"),
  // Params can be saved WITHOUT a key (you can never read a key back, so a params-only save must
  // not wipe it). Pass p_key = null to keep the existing one.
  save: (provider, o = {}) => rpc("pm_ai_set_key", {
    p_provider: provider,
    p_key: o.key || null,
    p_model: o.model || null,
    p_max_tokens: o.max_tokens ?? null,
    p_temperature: o.temperature ?? null,
    p_top_p: o.top_p ?? null,
    p_system_prompt: o.system_prompt ?? null,
    p_clear_temperature: !!o.clear_temperature,
    p_clear_top_p: !!o.clear_top_p,
  }),
  clearKey: (provider) => rpc("pm_ai_clear_key", { p_provider: provider }),
  setEnabled: (provider, enabled) => rpc("pm_ai_set_enabled", { p_provider: provider, p_enabled: enabled }),
  settings: () => rest("pm_ai_settings?id=eq.1&limit=1").then(r => (r.data || [])[0] || null),
  saveSettings: (patch) => rest("pm_ai_settings?id=eq.1", { method: "PATCH", body: patch }).then(r => r.data?.[0]),
  test: (provider) => callFn("generate-questions", { test_only: true, provider }),
  generate: (payload) => callFn("generate-questions", payload),
};

function AISettingsView({ packs, levels }) {
  const statusState = useAsync(() => db_ai.status(), []);
  const settingsState = useAsync(() => db_ai.settings(), []);
  const [editKey, setEditKey] = useState(null);   // provider id being edited
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState({});

  const status = statusState.data || [];
  const settings = settingsState.data || { active_provider: "anthropic", batch_size: 10, auto_repair: true };
  const byProvider = useMemo(() => Object.fromEntries(status.map(s => [s.provider, s])), [status]);

  const reloadAll = async () => { await statusState.reload(); await settingsState.reload(); };

  const setActive = async (id) => {
    try { await db_ai.saveSettings({ active_provider: id, updated_at: new Date().toISOString() }); await settingsState.reload(); notify(`Using ${PROVIDERS.find(p => p.id === id)?.name}`); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  const saveSetting = async (patch) => {
    try { await db_ai.saveSettings({ ...patch, updated_at: new Date().toISOString() }); await settingsState.reload(); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  const toggleEnabled = async (p, on) => {
    try { await db_ai.setEnabled(p.id, on); await statusState.reload(); notify(on ? `${p.name} turned on` : `${p.name} turned off`); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  const clearKey = async (p) => {
    const ok = await confirmDialog({
      title: `Remove the ${p.name} key?`,
      body: "Generation with this provider will stop working until you add a new key.",
      confirmText: "Remove key", tone: "danger",
    });
    if (!ok) return;
    try { await db_ai.clearKey(p.id); await statusState.reload(); notify("Key removed"); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  const testConn = async (p) => {
    setTesting(p.id);
    setTestResult(r => ({ ...r, [p.id]: null }));
    try {
      const res = await db_ai.test(p.id);
      setTestResult(r => ({ ...r, [p.id]: res?.ok ? { ok: true, model: res.model } : { ok: false, error: res?.error || res?.message || "Failed" } }));
      if (res?.ok) notify(`${p.name} is working`);
    } catch (e) {
      const msg = String(e?.message || e);
      setTestResult(r => ({ ...r, [p.id]: { ok: false, error: msg } }));
    } finally { setTesting(null); }
  };

  const loading = statusState.loading || settingsState.loading;

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>AI Settings</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>
          Choose which AI writes your content and save its API key. Keys are stored on the server and shared by everyone who logs in.
        </p>
      </div>

      {/* Security note — earned, not decorative */}
      <div className="pm-readable" style={{ background: C.brandSoft, borderRadius: R.md, padding: "12px 16px", marginBottom: S.lg,
        fontSize: 13, color: C.brandInk, lineHeight: 1.55 }}>
        <b>Your keys stay on the server.</b> Once saved, a key can never be read back — not by this page, not by anyone logged in, not by a script running in your browser. You'll only ever see whether it's set, plus its last four characters. To change one, save a new key over it.
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: 12 }}>{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} h={120} r={12} />)}</div>
      ) : (
        <>
          {/* Providers */}
          <div style={{ display: "grid", gap: 12, marginBottom: S.xl }}>
            {PROVIDERS.map(p => {
              const st = byProvider[p.id] || {};
              const configured = !!st.configured;
              const isActive = settings.active_provider === p.id;
              const tr = testResult[p.id];
              return (
                <div key={p.id} style={{ background: C.panel, border: "1px solid " + (isActive ? C.brand + "77" : C.line),
                  borderLeft: "4px solid " + (isActive ? C.brand : C.line),
                  borderRadius: R.lg, padding: S.lg }}>

                  <div style={{ display: "flex", alignItems: "flex-start", gap: S.md, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 18 }}>{p.emoji}</span>
                        <span style={{ fontSize: 16, fontWeight: 800, color: C.ink }}>{p.name}</span>
                        {isActive && <Pill tone="brand">In use</Pill>}
                        {configured
                          ? <span style={{ fontSize: 12, fontWeight: 700, color: C.ok }}>✓ Key saved <span style={{ fontFamily: "ui-monospace, monospace", color: C.faint }}>{st.hint}</span></span>
                          : <span style={{ fontSize: 12, fontWeight: 700, color: C.faint }}>No key yet</span>}
                        {configured && st.enabled === false && <Pill tone="danger">Turned off</Pill>}
                      </div>

                      {configured && st.updated_at && (
                        <div style={{ fontSize: 12, color: C.faint, marginTop: 4 }}>
                          Saved {relativeTime(st.updated_at)}{st.updated_by && st.updated_by !== "unknown" ? ` by ${st.updated_by}` : ""}
                        </div>
                      )}

                      {/* What it's actually configured to do */}
                      {configured && (
                        <div style={{ marginTop: 9, display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                          <Pill tone="muted">{st.model || p.defaultModel}</Pill>
                          <Pill tone="muted">{(st.max_tokens ?? 4000).toLocaleString()} max tokens</Pill>
                          {st.temperature != null
                            ? <Pill tone="muted">temp {Number(st.temperature).toFixed(2)}</Pill>
                            : <span style={{ fontSize: 11.5, color: C.faint }}>default temperature</span>}
                          {st.top_p != null && <Pill tone="muted">top-p {Number(st.top_p).toFixed(2)}</Pill>}
                          {st.system_prompt && <Pill tone="muted">custom brief</Pill>}
                        </div>
                      )}

                      {/* Test result */}
                      {tr && (
                        <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.5,
                          color: tr.ok ? C.ok : C.danger, fontWeight: 600 }}>
                          {tr.ok ? `✓ Connected — ${tr.model} responded.` : `✗ ${tr.error}`}
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 130 }}>
                      {!isActive && configured && st.enabled !== false && <Btn size="sm" variant="soft" onClick={() => setActive(p.id)}>Use this one</Btn>}
                      {configured && (
                        <Btn size="sm" variant="ghost" onClick={() => toggleEnabled(p, st.enabled === false)}>
                          {st.enabled === false ? "Turn on" : "Turn off"}
                        </Btn>
                      )}
                      <Btn size="sm" variant={configured ? "ghost" : "primary"} onClick={() => setEditKey(p.id)}>
                        {configured ? "Settings" : "Add key"}
                      </Btn>
                      {configured && (
                        <Btn size="sm" variant="ghost" onClick={() => testConn(p)} disabled={testing === p.id}>
                          {testing === p.id ? "Testing…" : "Test"}
                        </Btn>
                      )}
                      {configured && (
                        <button onClick={() => clearKey(p)}
                          style={{ fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 8, cursor: "pointer",
                            border: "1px solid " + C.line, background: "transparent", color: C.danger }}>Remove</button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Generation defaults */}
          <div className="pm-readable" style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.xl }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: S.md }}>Generation defaults</div>
            <div className="pm-form-2">
              <HelpField setting="batch_size" hint="1–30. Around 10–15 is comfortable.">
                <Input type="number" min={1} max={30} value={settings.batch_size ?? 10}
                  onChange={(e) => saveSetting({ batch_size: Math.min(30, Math.max(1, parseInt(e.target.value) || 10)) })} />
              </HelpField>
              <div>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 5 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.ink2 }}>Auto-fix flagged questions</span>
                  <InfoDot setting="auto_repair" />
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 13.5, color: C.ink2, paddingTop: 6 }}>
                  <input type="checkbox" checked={settings.auto_repair !== false}
                    onChange={(e) => saveSetting({ auto_repair: e.target.checked })}
                    style={{ width: 16, height: 16 }} />
                  Send failures back to the AI once
                </label>
              </div>
            </div>
          </div>

          {/* Generation moved to the Generate page.
              Settings should CONFIGURE; a content page should CREATE. Having a stripped-down
              generate panel buried in here meant generation lived in two places — and the version
              here was missing themes and frame words for no reason. */}
          <div className="pm-readable" style={{ background: C.brandSoft, borderRadius: R.lg,
            padding: "16px 18px", marginTop: S.xl, fontSize: 13.5, color: C.brandInk, lineHeight: 1.6 }}>
            <b>Looking to generate questions?</b> That now lives on the <b>Generate</b> page, where you
            can either use this key or copy a prompt for any AI tool — with the same options either way.
          </div>

          {/* Usage — AI generation is the one thing here that spends real money. Until now it left
              no trace at all. */}
          <UsagePanel />
        </>
      )}

      <Modal open={editKey !== null} onClose={() => setEditKey(null)} width={520}>
        {editKey !== null && (
          <KeyEditor
            provider={PROVIDERS.find(p => p.id === editKey)}
            existing={byProvider[editKey]}
            onClose={() => setEditKey(null)}
            onSaved={async () => { setEditKey(null); await reloadAll(); notify("Key saved"); }}
          />
        )}
      </Modal>
    </div>
  );
}

// Usage + spend visibility. AI generation is the ONLY operation in this app that costs real money,
// and it used to leave no audit trail whatsoever — no run count, no token counts, no way to notice a
// runaway. Every provider call is now recorded (including failures and connection tests).
function UsagePanel() {
  const { loading, data, reload } = useAsync(() => db_ai.usage(), []);
  const u = data || {};
  const byProv = u.by_provider || [];
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());

  return (
    <div className="pm-readable" style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginTop: S.xl }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: S.md, gap: S.md, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Usage</div>
          <div style={{ fontSize: 12.5, color: C.sub }}>Last 30 days. Generation is rate-limited to 20/hour and 100/day as a spend brake.</div>
        </div>
        <Btn size="sm" variant="ghost" onClick={reload}>Refresh</Btn>
      </div>

      {loading ? <Skeleton h={70} r={10} /> : (
        <>
          <div style={{ display: "flex", gap: S.lg, flexWrap: "wrap", marginBottom: byProv.length ? S.md : 0 }}>
            {[
              ["Runs today", u.runs_today],
              ["Runs (30d)", u.runs_30d],
              ["Questions made", u.questions_30d],
              ["Input tokens", u.input_tokens_30d],
              ["Output tokens", u.output_tokens_30d],
              ["Errors", u.errors_30d],
            ].map(([label, val]) => (
              <div key={label}>
                <div style={{ fontSize: 19, fontWeight: 800, color: label === "Errors" && val > 0 ? C.danger : C.ink }}>{fmt(val)}</div>
                <div style={{ fontSize: 11.5, color: C.faint, fontWeight: 600 }}>{label}</div>
              </div>
            ))}
          </div>

          {byProv.length > 0 && (
            <div style={{ borderTop: "1px solid " + C.line, paddingTop: S.md }}>
              {byProv.map(p => (
                <div key={p.provider} style={{ display: "flex", alignItems: "center", gap: S.md, fontSize: 12.5, color: C.sub, padding: "3px 0" }}>
                  <span style={{ fontWeight: 700, color: C.ink2, minWidth: 80 }}>{p.provider}</span>
                  <span>{p.runs} run{p.runs === 1 ? "" : "s"}</span>
                  <span style={{ color: C.faint }}>·</span>
                  <span>{fmt(p.input_tokens)} in / {fmt(p.output_tokens)} out</span>
                </div>
              ))}
            </div>
          )}

          {!u.runs_30d && (
            <div style={{ fontSize: 12.5, color: C.faint, marginTop: 4 }}>
              No generation runs yet.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Provider settings: the key (write-only — never read back) plus every generation parameter.
// Each field has an (i) explaining what it does FOR THIS JOB.
function KeyEditor({ provider, existing, onClose, onSaved }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(existing?.model || provider.defaultModel);
  const [customModel, setCustomModel] = useState(
    existing?.model && !provider.models.includes(existing.model) ? existing.model : ""
  );
  const [maxTokens, setMaxTokens] = useState(existing?.max_tokens ?? "");
  const [temperature, setTemperature] = useState(existing?.temperature ?? "");
  const [topP, setTopP] = useState(existing?.top_p ?? "");
  const [systemPrompt, setSystemPrompt] = useState(existing?.system_prompt || "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const isNew = !existing?.configured;
  const effectiveModel = customModel.trim() || model;

  const submit = async () => {
    if (isNew && (!key.trim() || key.trim().length < 8)) { notify("That key looks too short", "error"); return; }
    const mt = maxTokens === "" ? null : parseInt(maxTokens);
    const tp = temperature === "" ? null : parseFloat(temperature);
    const pp = topP === "" ? null : parseFloat(topP);
    if (mt != null && (mt < 256 || mt > 64000)) { notify("Max tokens must be between 256 and 64,000", "error"); return; }
    if (tp != null && (tp < 0 || tp > 1)) { notify("Temperature must be between 0 and 1", "error"); return; }
    if (pp != null && (pp <= 0 || pp > 1)) { notify("Top-p must be between 0 and 1", "error"); return; }

    setBusy(true);
    try {
      await db_ai.save(provider.id, {
        key: key.trim() || null,          // blank => keep the existing key
        model: effectiveModel,
        max_tokens: mt,
        temperature: tp,
        top_p: pp,
        // Empty string means "clear it". Sending null would mean "don't change" — so clearing the
        // textarea would silently do nothing and you'd be stuck with a custom brief you can't remove.
        system_prompt: systemPrompt.trim(),
        // null means "don't change", so an explicit clear is needed to actually UNSET these.
        clear_temperature: temperature === "" && existing?.temperature != null,
        clear_top_p: topP === "" && existing?.top_p != null,
      });
      setKey("");                          // never keep it in memory
      onSaved();
    } catch (e) {
      setBusy(false);
      notify(friendlyError(0, String(e?.message || e)), "error");
    }
  };

  // Warn when the token ceiling looks too low for the batch size the user is likely to ask for.
  const mtNum = maxTokens === "" ? null : parseInt(maxTokens);
  const tokenWarning = mtNum != null && mtNum < 2500
    ? "That's tight. Around 150 tokens per question — this may cut off larger batches."
    : null;

  return (
    <>
      <ModalHead title={`${isNew ? "Set up" : "Settings for"} ${provider.name}`}
        subtitle={isNew ? `Get a key from ${provider.where}` : "Change the key, model, or how it writes"} />
      <div style={{ padding: S.xl, display: "grid", gap: S.md, maxHeight: "64vh", overflowY: "auto" }}>

        {existing?.configured && (
          <div style={{ background: C.bg, borderRadius: R.md, padding: "10px 13px", fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
            A key is saved <span style={{ fontFamily: "ui-monospace, monospace" }}>{existing.hint}</span>. It can never be shown again — leave the box blank to keep it, or paste a new one to replace it.
          </div>
        )}

        <Field label={existing?.configured ? "Replace API key (optional)" : "API key"} hint={provider.keyHint}>
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)}
            autoFocus={isNew} placeholder={existing?.configured ? "Leave blank to keep the current key" : "Paste the key here"}
            autoComplete="off" spellCheck={false} />
        </Field>

        <HelpField setting="model" hint={customModel.trim() ? "Using your custom model name" : "Or type a model name below if it's not listed"}>
          <Select value={model} onChange={(e) => { setModel(e.target.value); setCustomModel(""); }} disabled={!!customModel.trim()}>
            {provider.models.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
          <Input value={customModel} onChange={(e) => setCustomModel(e.target.value)} aria-label="Custom model name" title="Custom model name"
            placeholder="Custom model name (optional)" spellCheck={false}
            style={{ marginTop: 6, fontSize: 13 }} />
        </HelpField>

        <HelpField setting="max_tokens" hint={tokenWarning || `Blank = default (${4000}). About 150 tokens per question.`}>
          <Input type="number" min={256} max={64000} step={256} value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)} placeholder="4000 (default)" />
        </HelpField>
        {tokenWarning && (
          <div style={{ fontSize: 12.5, color: C.warn, marginTop: -8, lineHeight: 1.5 }}>⚠ {tokenWarning}</div>
        )}

        {/* Advanced — collapsed by default. Most people never need these, and two of them can
            actively BREAK generation on newer models. */}
        <button onClick={() => setShowAdvanced(v => !v)}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
            fontSize: 12.5, fontWeight: 700, color: C.brand, textAlign: "left" }}>
          {showAdvanced ? "− Hide" : "+ Show"} advanced settings
        </button>

        {showAdvanced && (
          <div style={{ display: "grid", gap: S.md, borderLeft: "2px solid " + C.line, paddingLeft: S.md }}>
            <div style={{ background: C.danger + "0D", border: "1px solid " + C.danger + "33", borderRadius: R.md,
              padding: "10px 13px", fontSize: 12.5, color: C.danger, lineHeight: 1.55 }}>
              <b>Read this first.</b> Some newer models (Claude Opus 4.7+, OpenAI's reasoning models) <b>reject</b> Temperature and Top-p outright and every request will fail with an error. If generation stops working right after you set one, clear it. Blank is safe.
            </div>

            <HelpField setting="temperature" hint="Blank = the model's own default. 0.3–0.6 works well here.">
              <Input type="number" min={0} max={1} step={0.05} value={temperature}
                onChange={(e) => setTemperature(e.target.value)} placeholder="Leave blank (recommended)" />
            </HelpField>

            <HelpField setting="top_p" hint="Blank = unused. Adjust this OR temperature, not both.">
              <Input type="number" min={0.01} max={1} step={0.05} value={topP}
                onChange={(e) => setTopP(e.target.value)} placeholder="Leave blank (recommended)" />
            </HelpField>

            <HelpField setting="system_prompt" hint="Blank = the built-in brief (recommended). This is the AI's standing instructions.">
              <Textarea rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={"Leave blank to use the built-in brief, which already covers:\n• both words must be positive\n• the two words must be different lengths\n• output only JSON"}
                style={{ fontSize: 12.5, fontFamily: "ui-monospace, Menlo, monospace" }} />
            </HelpField>
          </div>
        )}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || (isNew && !key.trim())}>
          {busy ? "Saving…" : isNew ? "Save key" : "Save settings"}
        </Btn>
      </ModalFoot>
    </>
  );
}
