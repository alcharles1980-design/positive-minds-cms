// ============================================================
// UI Primitives
// ============================================================

const Btn = ({ children, onClick, variant = "primary", size = "md", disabled, title, icon, full, style, type }) => {
  const [hover, setHover] = useState(false);
  const sizes = {
    xs: { padding: "5px 10px", fontSize: 12.5, gap: 5 },
    sm: { padding: "7px 13px", fontSize: 13, gap: 6 },
    md: { padding: "10px 17px", fontSize: 14, gap: 7 },
    lg: { padding: "12px 22px", fontSize: 15, gap: 8 },
  };
  const V = {
    primary: { background: hover ? C.brandInk : C.brand, color: "#fff", border: "1px solid transparent", boxShadow: hover ? SH.brand : "none" },
    soft: { background: hover ? "#E4DCFB" : C.brandSoft, color: C.brandInk, border: "1px solid transparent" },
    ghost: { background: hover ? C.lineSoft : "transparent", color: C.ink2, border: "1px solid " + C.line },
    danger: { background: hover ? C.dangerSoft : "#fff", color: C.danger, border: "1px solid " + (hover ? C.danger : C.dangerSoft) },
    dangerFill: { background: hover ? C.dangerInk : C.danger, color: "#fff", border: "1px solid transparent" },
    dim: { background: "transparent", color: hover ? C.ink : C.sub, border: "1px solid transparent" },
  };
  return (
    <button type={type || "button"} onClick={onClick} disabled={disabled} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...sizes[size], ...V[variant], ...style,
        borderRadius: R.md, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, transition: "all .15s", fontFamily: "inherit",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        gap: sizes[size].gap, lineHeight: 1, width: full ? "100%" : undefined, whiteSpace: "nowrap" }}>
      {icon && <span style={{ fontSize: "1.05em" }}>{icon}</span>}{children}
    </button>
  );
};

const Badge = ({ kind, dot }) => {
  const s = STATUS[kind] || STATUS.draft;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700,
      padding: "3px 9px", borderRadius: R.pill, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>
      {dot !== false && <span style={{ width: 6, height: 6, borderRadius: 99, background: s.dot }} />}{s.label}
    </span>
  );
};

const Pill = ({ children, tone = "brand" }) => {
  const t = { brand: { bg: C.brandSoft, fg: C.brandInk }, muted: { bg: C.lineSoft, fg: C.sub }, info: { bg: C.infoSoft, fg: C.info } }[tone];
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: R.sm, background: t.bg, color: t.fg, textTransform: "capitalize", whiteSpace: "nowrap" }}>{children}</span>;
};

const Field = ({ label, children, hint, error, style }) => (
  <label style={{ display: "block", ...style }}>
    {label && <div style={{ fontSize: 12, fontWeight: 700, color: C.ink2, marginBottom: 6, letterSpacing: 0.2 }}>{label}</div>}
    {children}
    {error ? <div style={{ fontSize: 11.5, color: C.danger, marginTop: 5, fontWeight: 600 }}>{error}</div>
      : hint ? <div style={{ fontSize: 11.5, color: C.faint, marginTop: 5 }}>{hint}</div> : null}
  </label>
);

const inputBase = { width: "100%", padding: "10px 13px", borderRadius: R.md, border: "1.5px solid " + C.line, fontSize: 14, fontFamily: "inherit", color: C.ink, background: C.panel, boxSizing: "border-box", outline: "none", transition: "border-color .15s, box-shadow .15s" };
const focusOn = (e) => { e.target.style.borderColor = C.brand; e.target.style.boxShadow = "0 0 0 3px " + C.brandSoft; };
const focusOff = (e) => { e.target.style.borderColor = C.line; e.target.style.boxShadow = "none"; };
const Input = (p) => <input {...p} className={cx("pm-input", p.className)} style={{ ...inputBase, ...p.style }} onFocus={(e) => { focusOn(e); p.onFocus?.(e); }} onBlur={(e) => { focusOff(e); p.onBlur?.(e); }} />;
const Textarea = (p) => <textarea {...p} className={cx("pm-input", p.className)} style={{ ...inputBase, resize: "vertical", lineHeight: 1.5, ...p.style }} onFocus={focusOn} onBlur={focusOff} />;
const Select = (p) => <select {...p} className={cx("pm-input", p.className)} style={{ ...inputBase, appearance: "none", cursor: "pointer",
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='10' height='6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236E6B85' fill='none' stroke-width='1.5'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat", backgroundPosition: "right 12px center", paddingRight: 32, ...p.style }} onFocus={focusOn} onBlur={focusOff}>{p.children}</select>;

const SearchBox = ({ value, onChange, placeholder, className, autoFocus }) => (
  <div className={cx("pm-search", className)} style={{ position: "relative" }}>
    <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: C.faint, pointerEvents: "none" }}>⌕</span>
    <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} style={{ paddingLeft: 32, padding: "8px 12px 8px 32px" }} />
    {value && <button onClick={() => onChange("")} aria-label="Clear" style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: C.lineSoft, border: "none", borderRadius: 99, width: 20, height: 20, cursor: "pointer", color: C.sub, fontSize: 12, lineHeight: 1 }}>×</button>}
  </div>
);

// Modal with focus trap + Escape; bottom-sheet on phones (via CSS)
const Modal = ({ open, onClose, children, width = 560, labelledBy }) => {
  const ref = useRef(null);
  useFocusTrap(ref, open, onClose);
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="pm-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={labelledBy}
      style={{ position: "fixed", inset: 0, background: "rgba(25,23,40,0.5)", zIndex: 100, display: "flex", justifyContent: "center", backdropFilter: "blur(3px)", overflowY: "auto" }}>
      <div ref={ref} className="pm-modal-card" onClick={(e) => e.stopPropagation()}
        style={{ background: C.panel, width: "100%", maxWidth: width, boxShadow: SH.xl, overflow: "hidden" }}>{children}</div>
    </div>
  );
};

const ModalHead = ({ emoji, title, subtitle, id }) => (
  <div style={{ padding: `${S.xl}px ${S.xl + 2}px`, borderBottom: "1px solid " + C.line, display: "flex", alignItems: "center", gap: S.md }}>
    {emoji && <div style={{ fontSize: 28, lineHeight: 1 }}>{emoji}</div>}
    <div style={{ minWidth: 0 }}>
      <div id={id} style={{ fontSize: 18, fontWeight: 800, color: C.ink }}>{title}</div>
      {subtitle && <div style={{ fontSize: 13, color: C.sub, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subtitle}</div>}
    </div>
  </div>
);

const ModalFoot = ({ children }) => (
  <div style={{ padding: `${S.lg}px ${S.xl + 2}px`, borderTop: "1px solid " + C.line, display: "flex", justifyContent: "flex-end", gap: S.sm + 2, background: C.bg, flexWrap: "wrap" }}>{children}</div>
);

// Imperative confirm dialog (replaces native confirm())
const ConfirmHost = () => {
  const [state, setState] = useState(null);
  useEffect(() => { confirmBus.register(setState); }, []);
  if (!state) return null;
  const { title, message, confirmLabel, danger, resolve } = state;
  const done = (v) => { resolve(v); setState(null); };
  return (
    <Modal open onClose={() => done(false)} width={440} labelledBy="pm-confirm-title">
      <div style={{ padding: `${S.xl + 2}px ${S.xl + 2}px ${S.lg}px` }}>
        <div id="pm-confirm-title" style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, color: C.sub, lineHeight: 1.55 }}>{message}</div>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={() => done(false)}>Cancel</Btn>
        <Btn variant={danger ? "dangerFill" : "primary"} onClick={() => done(true)}>{confirmLabel || "Confirm"}</Btn>
      </ModalFoot>
    </Modal>
  );
};
const confirmBus = (() => {
  let setter = null;
  return {
    register: (fn) => { setter = fn; },
    ask: (opts) => new Promise((resolve) => {
      if (!setter) { resolve(false); return; } // host not mounted — fail safe rather than hang
      setter({ ...opts, resolve });
    }),
  };
})();
const confirmDialog = (opts) => confirmBus.ask(opts);

// Toast host
const ToastHost = () => {
  const [items, setItems] = useState([]);
  useEffect(() => toastBus.sub((t) => {
    setItems((cur) => [...cur, t]);
    if (t.duration) setTimeout(() => setItems((cur) => cur.filter(x => x.id !== t.id)), t.duration);
  }), []);
  const dismiss = (id) => setItems((cur) => cur.filter(x => x.id !== id));
  const tone = { success: { fg: "#7CE7D4", i: "✓" }, error: { fg: "#FF9AA0", i: "!" }, info: { fg: "#9DBEFF", i: "i" } };
  return (
    <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 300, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", width: "calc(100% - 32px)", maxWidth: 440, pointerEvents: "none" }}>
      {items.map((t) => (
        <div key={t.id} style={{ pointerEvents: "auto", background: "#1F1B33", color: "#fff", padding: "12px 16px", borderRadius: R.md, fontSize: 14, fontWeight: 600, boxShadow: SH.lg, display: "flex", alignItems: "center", gap: 10, width: "fit-content", maxWidth: "100%", animation: "pm-toast-in .2s ease-out", border: "1px solid rgba(255,255,255,0.08)" }}>
          <span style={{ color: (tone[t.kind] || tone.success).fg, fontWeight: 800 }}>{(tone[t.kind] || tone.success).i}</span>
          <span style={{ flex: 1 }}>{t.message}</span>
          {t.action && <button onClick={() => { t.action.onClick(); dismiss(t.id); }} style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", fontWeight: 700, fontSize: 13, padding: "4px 10px", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
};

// Empty / error / loading states
const EmptyState = ({ icon, title, body, action }) => (
  <div style={{ background: C.panel, borderRadius: R.lg, padding: `${S.xxxl}px ${S.xl}px`, textAlign: "center", border: "1px dashed " + C.line }}>
    <div style={{ fontSize: 34, marginBottom: 12 }}>{icon}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{title}</div>
    {body && <div style={{ fontSize: 13.5, color: C.sub, margin: "6px auto 0", maxWidth: 360, lineHeight: 1.5 }}>{body}</div>}
    {action && <div style={{ marginTop: S.xl }}>{action}</div>}
  </div>
);

const ErrorState = ({ error, onRetry }) => (
  <div style={{ background: C.dangerSoft, border: "1px solid " + C.danger, borderRadius: R.lg, padding: S.xl, color: C.dangerInk }}>
    <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 6 }}>Something went wrong</div>
    <div style={{ fontSize: 13.5, lineHeight: 1.5 }}>{error}</div>
    {onRetry && <div style={{ marginTop: S.md }}><Btn variant="ghost" size="sm" onClick={onRetry}>↻ Try again</Btn></div>}
  </div>
);

const Spinner = ({ label = "Loading…" }) => (
  <div style={{ padding: S.xxxl, textAlign: "center", color: C.faint }}>
    <div style={{ width: 26, height: 26, margin: "0 auto 12px", border: "3px solid " + C.line, borderTopColor: C.brand, borderRadius: 99, animation: "pm-spin .7s linear infinite" }} />
    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
  </div>
);

const Skeleton = ({ h = 16, w = "100%", r = 8, style }) => (
  <div style={{ height: h, width: w, borderRadius: r, background: `linear-gradient(90deg, ${C.lineSoft} 25%, ${C.line} 50%, ${C.lineSoft} 75%)`, backgroundSize: "200% 100%", animation: "pm-shimmer 1.3s infinite", ...style }} />
);
