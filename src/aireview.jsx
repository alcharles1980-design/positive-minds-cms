// ============================================================
// AI Review — the human approval gate.
//
// EVERY AI-generated question lands in pm_review_queue and MUST get an explicit human decision
// (Approve / Edit / Reject) before it can become a real question. Nothing here is live content.
//
// Each row carries machine VALIDATION computed by running the REAL masking engine at EVERY level
// (see validateQuestion in core.jsx). The machine catches the mechanical defects a human eye
// misses — above all "ambiguous": an alternate word that ALSO fits the blank, meaning the puzzle
// has two correct answers. The human catches what the machine can't (tone, meaning, suitability).
// ============================================================

const db_review = {
  list: (status = "pending") =>
    rest(`pm_review_queue?status=eq.${status}&order=created_at.desc&limit=1000`).then(r => r.data || []),
  // Server-side counts. (This used to download every row to the browser just to count them, which
  // was wasteful AND silently wrong past the 10,000-row cap.)
  counts: () => rpc("pm_review_counts"),
  approve: (id, patch = {}) =>
    rpc("pm_review_approve", {
      p_id: id,
      p_template: patch.template ?? null,
      p_answer: patch.answer ?? null,
      p_alt_answer: patch.alt_answer ?? null,
      p_level: patch.level ?? null,
    }),
  reject: (id, reason) => rpc("pm_review_reject", { p_id: id, p_reason: reason || null }),
  purge: (status) => rest(`pm_review_queue?status=eq.${status}`, { method: "DELETE" }),
};

// A short human label for each validation flag code.
const FLAG_LABEL = {
  ambiguous: "Two answers",
  no_blank: "No blank",
  multi_blank: "Too many blanks",
  no_answer: "No answer",
  no_alt: "No alternate",
  same_word: "Same word twice",
  too_short: "Too short",
  too_long: "Too long",
  multiword: "Multi-word",
  bad_chars: "Bad characters",
  bad_chars_alt: "Bad characters",
  duplicate: "Duplicate",
};

// Every remaining flag is a HARD defect (a strict duplicate, or a mechanical problem). There are no
// soft/advisory flags any more — the old repetition nudges (same_sentence/answer_reused/reversed_pair)
// were removed when "duplicate" was tightened to an exact sentence + right/wrong-pair match.
const SOFT_FLAGS = new Set([]);

function FlagPill({ flag }) {
  const label = FLAG_LABEL[flag.code] || flag.code;
  const soft = SOFT_FLAGS.has(flag.code);
  const col = soft ? C.warn : C.danger;
  return (
    <span title={flag.detail}
      style={{ display: "inline-block", fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: R.pill,
        background: col + "14", color: col, border: "1px solid " + col + "44", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function AIReviewView({ packs, levels }) {
  const [tab, setTab] = useState("pending");
  const [packFilter, setPackFilter] = useState("");
  const { loading, error, data, reload } = useAsync(() => db_review.list(tab), [tab]);
  const countsState = useAsync(() => db_review.counts(), []);
  const [editing, setEditing] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  useRealtimeRefresh(["pm_review_queue"], () => { reload(); countsState.reload(); }, [reload, countsState.reload]);

  const allRows = data || [];
  const rows = packFilter ? allRows.filter(r => r.pack_id === packFilter) : allRows;
  const counts = countsState.data || { pending: 0, approved: 0, rejected: 0 };
  const packById = useMemo(() => Object.fromEntries((packs || []).map(p => [p.id, p])), [packs]);
  // Only offer packs that actually have rows in this tab — a filter full of empty options is noise.
  const packsInTab = useMemo(() => {
    const ids = [...new Set(allRows.map(r => r.pack_id))];
    return ids.map(id => packById[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }, [allRows, packById]);

  const refreshAll = async () => { await reload(); await countsState.reload(); };

  const doApprove = async (row, patch) => {
    setBusyId(row.id);
    try {
      await db_review.approve(row.id, patch || {});
      notify(patch ? "Approved with your edits" : "Approved");
      await refreshAll();
    } catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
    finally { setBusyId(null); }
  };

  const doReject = async (row) => setRejecting(row);

  const confirmReject = async (reason) => {
    const row = rejecting;
    setRejecting(null);
    if (!row) return;
    setBusyId(row.id);
    try {
      await db_review.reject(row.id, reason);
      notify("Rejected");
      await refreshAll();
    } catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
    finally { setBusyId(null); }
  };

  // Bulk: approve every row the machine says is clean.
  const approveAllClean = async () => {
    const clean = rows.filter(r => r.validation?.ok);
    if (!clean.length) { notify("No clean questions to approve", "error"); return; }
    const ok = await confirmDialog({
      title: `Approve ${clean.length} clean question${clean.length === 1 ? "" : "s"}?`,
      body: "These passed every automated check. They'll become real questions in their pack. Flagged ones are left for you to review individually.",
      confirmText: "Approve them",
    });
    if (!ok) return;
    setBulkBusy(true);
    let done = 0;
    for (const r of clean) {
      try { await db_review.approve(r.id, {}); done++; } catch { /* keep going */ }
    }
    setBulkBusy(false);
    notify(`Approved ${done} of ${clean.length}`);
    await refreshAll();
  };

  // Bulk: reject everything the machine flagged as mechanically broken. (Soft flags like a reused
  // word are advisory — they are NOT swept up here, because you may still want those questions.)
  const rejectAllBroken = async () => {
    const broken = rows.filter(r => (r.validation?.flags || []).some(f => !SOFT_FLAGS.has(f.code)));
    if (!broken.length) { notify("Nothing is mechanically broken", "error"); return; }
    const ok = await confirmDialog({
      title: `Reject ${broken.length} broken question${broken.length === 1 ? "" : "s"}?`,
      body: "These have real defects (e.g. two correct answers, or a missing blank). Questions flagged only for a reused word are left alone — you may still want those.",
      confirmText: "Reject them", tone: "danger",
    });
    if (!ok) return;
    setBulkBusy(true);
    let done = 0;
    for (const r of broken) {
      try { await db_review.reject(r.id, "Failed automated checks"); done++; } catch { /* keep going */ }
    }
    setBulkBusy(false);
    notify(`Rejected ${done} of ${broken.length}`);
    await refreshAll();
  };

  const clearDecided = async () => {
    const ok = await confirmDialog({
      title: `Clear ${tab} history?`,
      body: "This only removes the review records. Approved questions stay in their packs.",
      confirmText: "Clear", tone: "danger",
    });
    if (!ok) return;
    try { await db_review.purge(tab); notify("Cleared"); await refreshAll(); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  const cleanCount = rows.filter(r => r.validation?.ok).length;
  const flaggedCount = rows.length - cleanCount;
  // "Broken" = has at least one HARD (mechanical) defect. A row flagged only for a reused word is
  // advisory, not broken — don't sweep it into a bulk reject.
  const brokenCount = rows.filter(r => (r.validation?.flags || []).some(f => !SOFT_FLAGS.has(f.code))).length;

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>AI Review</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>
          Nothing becomes a real question until you approve it — whether an AI wrote it or you imported it yourself.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: S.lg, flexWrap: "wrap" }}>
        {[
          { id: "pending", label: "Pending", n: counts.pending },
          { id: "approved", label: "Approved", n: counts.approved },
          { id: "rejected", label: "Rejected", n: counts.rejected },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: "7px 14px", borderRadius: R.pill, cursor: "pointer", fontFamily: "inherit",
              fontSize: 13, fontWeight: 700, border: "1px solid " + (tab === t.id ? C.brand : C.line),
              background: tab === t.id ? C.brandSoft : "transparent",
              color: tab === t.id ? C.brandInk : C.sub }}>
            {t.label}{t.n ? ` · ${t.n}` : ""}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {packsInTab.length > 1 && (
          <Select value={packFilter} onChange={(e) => setPackFilter(e.target.value)} aria-label="Filter by pack" title="Filter by pack"
            style={{ maxWidth: 200, fontSize: 13, padding: "6px 10px" }}>
            <option value="">All packs ({allRows.length})</option>
            {packsInTab.map(p => (
              <option key={p.id} value={p.id}>
                {p.emoji ? p.emoji + " " : ""}{p.name} ({allRows.filter(r => r.pack_id === p.id).length})
              </option>
            ))}
          </Select>
        )}
        {tab === "pending" && rows.length > 0 && (
          <Btn size="sm" onClick={approveAllClean} disabled={bulkBusy || !cleanCount}>
            {bulkBusy ? "Working…" : `Approve ${cleanCount} clean`}
          </Btn>
        )}
        {tab === "pending" && brokenCount > 0 && (
          <button onClick={rejectAllBroken} disabled={bulkBusy}
            style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 13px", borderRadius: R.pill, cursor: "pointer",
              border: "1px solid " + C.danger + "55", background: "transparent", color: C.danger }}>
            Reject {brokenCount} broken
          </button>
        )}
        {tab !== "pending" && rows.length > 0 && (
          <Btn size="sm" variant="ghost" onClick={clearDecided}>Clear history</Btn>
        )}
      </div>

      {tab === "pending" && rows.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: S.md, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, color: C.sub }}>
            <b style={{ color: C.ok }}>{cleanCount}</b> passed every automated check
            {flaggedCount > 0 && <> · <b style={{ color: C.danger }}>{flaggedCount}</b> need your attention</>}
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ display: "grid", gap: 10 }}>{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={92} r={12} />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="✓"
          title={tab === "pending" ? "Nothing waiting for review" : `No ${tab} questions`}
          body={tab === "pending"
            ? "Anything you generate or import appears here first, for you to approve, edit or reject."
            : `Questions you ${tab === "approved" ? "approve" : "reject"} will be listed here.`}
        />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map(r => {
            const v = r.validation || {};
            const flags = v.flags || [];
            const clean = !!v.ok;
            const pack = packById[r.pack_id];
            const decided = r.status !== "pending";
            // Only genuinely mechanical defects get the alarming red treatment. "Word reused" and
            // "sentence reused" are advisory — you may still want the question.
            const hardBroken = flags.some(f => !SOFT_FLAGS.has(f.code));
            const edge = decided ? (r.status === "approved" ? C.ok : C.faint) : clean ? C.ok : hardBroken ? C.danger : C.warn;
            return (
              <div key={r.id} style={{ background: C.panel, border: "1px solid " + (clean || decided || !hardBroken ? C.line : C.danger + "55"),
                borderLeft: "4px solid " + edge,
                borderRadius: R.lg, padding: S.lg }}>

                <div style={{ display: "flex", gap: S.md, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    {/* Sentence */}
                    <div style={{ fontSize: 15, color: C.ink, lineHeight: 1.5 }}>
                      {String(r.template || "").split("{blank}").map((part, i, arr) => (
                        <React.Fragment key={i}>
                          {part}
                          {i < arr.length - 1 && (
                            <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 800, color: C.brand,
                              background: C.brandSoft, padding: "1px 8px", borderRadius: 5, letterSpacing: 1 }}>____</span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>

                    {/* The two options */}
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13.5, fontWeight: 800, color: C.ok, background: C.ok + "14",
                        padding: "3px 10px", borderRadius: R.sm }}>
                        {r.answer} <span style={{ fontWeight: 600, opacity: .7 }}>({(r.answer || "").length})</span>
                      </span>
                      <span style={{ fontSize: 12, color: C.faint }}>vs</span>
                      <span style={{ fontSize: 13.5, fontWeight: 700, color: C.sub, background: C.bg,
                        padding: "3px 10px", borderRadius: R.sm }}>
                        {r.alt_answer || "—"} <span style={{ fontWeight: 600, opacity: .7 }}>({(r.alt_answer || "").length})</span>
                      </span>
                      {pack && <Pill tone="muted">{pack.emoji} {pack.name}</Pill>}
                      {r.target_level != null && <LevelChip level={r.target_level} levels={levels} />}
                      {r.provider && (
                        <Pill tone="muted">
                          {r.provider.startsWith("partner:")
                            ? `${r.provider.slice(8)} (via Claude)`   // a partner wrote this
                            : r.provider === "import" ? "Imported"
                            : r.provider === "ai-paste" ? "Pasted from AI"
                            : r.provider}
                        </Pill>
                      )}
                      {r.edited && <Pill tone="muted">edited by you</Pill>}
                    </div>

                    {/* Validation flags */}
                    {flags.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                          {flags.map((f, i) => <FlagPill key={i} flag={f} />)}
                        </div>
                        {flags.map((f, i) => (
                          <div key={i} style={{ fontSize: 12.5, color: SOFT_FLAGS.has(f.code) ? C.warn : C.danger, lineHeight: 1.5 }}>{f.detail}</div>
                        ))}
                      </div>
                    )}
                    {clean && !decided && (
                      <div style={{ marginTop: 8, fontSize: 12.5, color: C.ok, fontWeight: 600 }}>
                        ✓ Passed every automated check — still your call.
                      </div>
                    )}

                    {/* Decision record */}
                    {decided && (
                      <div style={{ marginTop: 9, fontSize: 12.5, color: C.faint }}>
                        {r.status === "approved" ? "Approved" : "Rejected"}
                        {r.decided_by ? ` by ${r.decided_by}` : ""}
                        {r.decided_at ? ` · ${relativeTime(r.decided_at)}` : ""}
                        {r.reject_reason ? ` · “${r.reject_reason}”` : ""}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {!decided && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 108 }}>
                      <Btn size="sm" onClick={() => doApprove(r)} disabled={busyId === r.id}>
                        {busyId === r.id ? "…" : "Approve"}
                      </Btn>
                      <Btn size="sm" variant="ghost" onClick={() => setEditing(r)} disabled={busyId === r.id}>Edit</Btn>
                      <button onClick={() => doReject(r)} disabled={busyId === r.id}
                        style={{ fontSize: 12.5, fontWeight: 700, padding: "6px 10px", borderRadius: 8, cursor: "pointer",
                          border: "1px solid " + C.line, background: "transparent", color: C.danger }}>
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} width={620}>
        {editing !== null && (
          <ReviewEditor
            row={editing}
            levels={levels}
            onCancel={() => setEditing(null)}
            onApprove={async (patch) => { const row = editing; setEditing(null); await doApprove(row, patch); }}
          />
        )}
      </Modal>

      <Modal open={rejecting !== null} onClose={() => setRejecting(null)} width={480}>
        {rejecting !== null && (
          <RejectDialog row={rejecting} onCancel={() => setRejecting(null)} onConfirm={confirmReject} />
        )}
      </Modal>
    </div>
  );
}

// Capture an optional reason when rejecting, so you remember why later.
function RejectDialog({ row, onCancel, onConfirm }) {
  const [reason, setReason] = useState("");
  return (
    <>
      <ModalHead title="Reject this question?" subtitle="It won't become a real question" />
      <div style={{ padding: S.xl, display: "grid", gap: S.md }}>
        <div style={{ background: C.bg, borderRadius: R.md, padding: "11px 14px", fontSize: 13.5, color: C.ink2 }}>
          “{String(row.template || "").replace(/\{blank\}/g, "____")}” — <b>{row.answer}</b> vs {row.alt_answer || "—"}
        </div>
        <Field label="Reason (optional)" hint="Helps you remember why, and improves future batches">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
            placeholder="e.g. tone is off for young children" />
        </Field>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => onConfirm(reason)} tone="danger">Reject</Btn>
      </ModalFoot>
    </>
  );
}

// Edit-then-approve. Re-validates LIVE as you type, using the same engine the game uses, so you can
// see the moment a fix actually clears the problem.
function ReviewEditor({ row, levels, onCancel, onApprove }) {
  const [f, setF] = useState({
    template: row.template || "",
    answer: row.answer || "",
    alt_answer: row.alt_answer || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const live = useMemo(
    () => validateQuestion(
      { template: f.template, answer: f.answer, alt_answer: f.alt_answer },
      levels || [],
      { targetLevel: row.target_level }
    ),
    [f, levels, row.target_level]
  );

  const submit = async () => {
    setBusy(true);
    await onApprove({
      template: f.template,
      answer: (f.answer || "").toUpperCase().trim(),
      alt_answer: (f.alt_answer || "").toUpperCase().trim(),
    });
    setBusy(false);
  };

  return (
    <>
      <ModalHead title="Edit & approve" subtitle="Fix it here, then approve — it re-checks as you type" />
      <div style={{ padding: S.xl, display: "grid", gap: S.md, maxHeight: "60vh", overflowY: "auto" }}>
        <Field label="Sentence" hint="Must contain exactly one {blank}">
          <Textarea rows={2} value={f.template} onChange={(e) => set("template", e.target.value)} autoFocus />
        </Field>
        <div className="pm-form-2">
          <Field label="Answer (correct)" hint={`${(f.answer || "").replace(/\s+/g, "").length} letters`}>
            <Input value={f.answer} onChange={(e) => set("answer", e.target.value.toUpperCase())} />
          </Field>
          <Field label="Alternate (wrong)" hint={`${(f.alt_answer || "").replace(/\s+/g, "").length} letters — must differ`}>
            <Input value={f.alt_answer} onChange={(e) => set("alt_answer", e.target.value.toUpperCase())} />
          </Field>
        </div>

        {/* Live validation */}
        <div style={{ background: live.ok ? C.ok + "12" : C.danger + "10",
          border: "1px solid " + (live.ok ? C.ok + "44" : C.danger + "44"),
          borderRadius: R.md, padding: "11px 14px" }}>
          {live.ok ? (
            <div style={{ fontSize: 13, fontWeight: 700, color: C.ok }}>✓ Passes every automated check</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.danger, textTransform: "uppercase",
                letterSpacing: .3, marginBottom: 6 }}>Still a problem</div>
              {live.flags.map((fl, i) => (
                <div key={i} style={{ fontSize: 12.5, color: C.danger, lineHeight: 1.5 }}>• {fl.detail}</div>
              ))}
            </>
          )}
        </div>

        {/* How it will look at each level */}
        {f.answer && (
          <div style={{ background: C.bg, borderRadius: R.md, padding: "11px 14px" }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: .3,
              textTransform: "uppercase", marginBottom: 7 }}>How the blank looks at each level</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(levels || []).map(l => {
                const isWord = l.hidden_mode === "word";
                const w = (f.answer || "").toUpperCase();
                const letters = Math.min(l.letters_hidden_default || 2, Math.max(1, w.length - 1));
                const blank = isWord ? "_".repeat(Math.max(3, w.length))
                  : maskWord(w, letters, l.letter_position || "end", l.letter_grouping || "grouped");
                const bad = (live.flags || []).some(fl => fl.code === "ambiguous" && (fl.levels || []).includes(l.level));
                return (
                  <span key={l.level} title={`Level ${l.level}`}
                    style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, fontWeight: 800, letterSpacing: 1.5,
                      padding: "3px 8px", borderRadius: R.sm,
                      background: bad ? C.danger + "18" : C.panel,
                      color: bad ? C.danger : C.ink2,
                      border: "1px solid " + (bad ? C.danger + "55" : C.line) }}>
                    {l.level}: {blank}
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || !f.template || !f.answer}>
          {busy ? "Approving…" : live.ok ? "Approve" : "Approve anyway"}
        </Btn>
      </ModalFoot>
    </>
  );
}
