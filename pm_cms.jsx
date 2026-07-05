const { useState, useEffect, useMemo, useCallback, useRef } = React;

// ===== core.jsx =====

// ============================================================
// Positive Minds — Pack CMS  ·  v2 (rebuilt core)
// Content management for the CBMT word-game pack library.
//
// Architecture:
//   - config + data layer (Supabase REST + RPC, paginated)
//   - design token system (color / space / radius / shadow / type)
//   - hooks (breakpoint, toast, hotkeys, focus-trap, async)
//   - primitives (Button, Badge, Field, inputs, Modal, Confirm…)
//   - feature views (Dashboard, Library, PackDetail, AllQuestions)
//   - App shell (auth gate, routing via history, command surface)
// ============================================================

// ---------- config ----------
const CFG = {
  build: "2026.07.05-02", // bump on every deploy; shown in the sidebar so you can tell if a cached build is stale
  url: "https://tytrmjjucqijzcrbwjfm.supabase.co",
  key: "sb_publishable_S16YFhxUtKsUYlUixYGW8g_t5nk28Ev",
  adminEmail: "admin@positiveminds.app",
  sessionStore: "pm_admin_session_v2",
  sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // keep users logged in for 7 days
  pageSize: 40,
};

// ============================================================
// Session + Auth
// ============================================================
const session = {
  token: null, refresh: null, savedAt: 0,
  // Persist across tab/browser restarts (localStorage, not sessionStorage) and keep the
  // session for a week. We store when it was saved so we can enforce the 7-day window and
  // proactively refresh the short-lived access token in the background.
  load() {
    try {
      // Read from localStorage; migrate any legacy sessionStorage entry.
      let r = localStorage.getItem(CFG.sessionStore);
      if (!r) { const legacy = sessionStorage.getItem(CFG.sessionStore); if (legacy) { r = legacy; localStorage.setItem(CFG.sessionStore, legacy); sessionStorage.removeItem(CFG.sessionStore); } }
      if (r) {
        const s = JSON.parse(r);
        // Enforce the 7-day window from first login.
        if (s.savedAt && Date.now() - s.savedAt > CFG.sessionMaxAgeMs) { this.clear(); return null; }
        this.token = s.access_token; this.refresh = s.refresh_token; this.savedAt = s.savedAt || Date.now();
      }
    } catch {}
    return this.token;
  },
  // On a fresh login, reset the 7-day clock. On a background token refresh, keep the original
  // login time (so the week is measured from login, not from each refresh).
  save(a, r, resetClock = false) {
    this.token = a; this.refresh = r;
    if (resetClock || !this.savedAt) this.savedAt = Date.now();
    try { localStorage.setItem(CFG.sessionStore, JSON.stringify({ access_token: a, refresh_token: r, savedAt: this.savedAt })); } catch {}
  },
  clear() { this.token = null; this.refresh = null; this.savedAt = 0; try { localStorage.removeItem(CFG.sessionStore); sessionStorage.removeItem(CFG.sessionStore); } catch {} },
};

const auth = {
  async login(password) {
    const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: CFG.key, "Content-Type": "application/json" },
      body: JSON.stringify({ email: CFG.adminEmail, password }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error_description || d.msg || "Incorrect password");
    session.save(d.access_token, d.refresh_token, true); return true;
  },
  // Exchange the refresh token for a fresh access token. Returns true on success.
  async refresh() {
    if (!session.refresh) return false;
    try {
      const res = await fetch(`${CFG.url}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST", headers: { apikey: CFG.key, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh }),
      });
      if (!res.ok) return false;
      const d = await res.json();
      if (!d.access_token) return false;
      session.save(d.access_token, d.refresh_token || session.refresh);
      return true;
    } catch { return false; }
  },
  async changePassword(pw) {
    const res = await fetch(`${CFG.url}/auth/v1/user`, {
      method: "PUT", headers: { apikey: CFG.key, Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error_description || d.msg || "Could not change password");
    return true;
  },
  logout() { session.clear(); },
};

// Notify the app when the session dies so it can show the login screen.
const authEvents = (() => { let fn = null; return { onExpire: (f) => { fn = f; }, expire: () => fn && fn() }; })();

// ============================================================
// Data layer — REST + RPC with a paginating helper
// ============================================================
const rest = async (path, opts = {}, _retried = false) => {
  const { method = "GET", body, headers = {}, range } = opts;
  const bearer = session.token || CFG.key;
  const h = {
    apikey: CFG.key, Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json", Prefer: "return=representation", ...headers,
  };
  if (range) { h.Range = `${range[0]}-${range[1]}`; h.Prefer = "count=exact"; }
  const res = await fetch(`${CFG.url}/rest/v1/${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    // Token likely expired — try one silent refresh + retry before giving up.
    if (res.status === 401 && session.token && !_retried) {
      const ok = await auth.refresh();
      if (ok) return rest(path, opts, true);
      session.clear(); authEvents.expire();
    }
    const t = await res.text();
    throw new Error(friendlyError(res.status, t));
  }
  const total = res.headers.get("content-range");
  if (res.status === 204) return { data: null, total: null };
  const t = await res.text();
  const data = t ? JSON.parse(t) : null;
  return { data, total: total ? parseInt(total.split("/")[1]) : (Array.isArray(data) ? data.length : null) };
};

const rpc = async (fn, args = {}, _retried = false) => {
  const bearer = session.token || CFG.key;
  const res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: CFG.key, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    if (res.status === 401 && session.token && !_retried) {
      const ok = await auth.refresh();
      if (ok) return rpc(fn, args, true);
      session.clear(); authEvents.expire();
    }
    const t = await res.text();
    throw new Error(friendlyError(res.status, t));
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};

// Fetch ALL rows for a table path, paging past the PostgREST 1000-row cap.
const restAll = async (pathBase) => {
  const out = []; const size = 1000; let from = 0;
  for (let i = 0; i < 1000; i++) { // hard safety ceiling
    const { data } = await rest(pathBase, { range: [from, from + size - 1] });
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return out;
};

const friendlyError = (status, raw) => {
  if (status === 401) return "Your session expired — please sign in again.";
  if (status === 403) return "You don't have permission for that. Sign in as admin to make changes.";
  if (status === 409 || /duplicate/i.test(raw)) return "That already exists (a pack with this slug is taken).";
  if (status >= 500) return "The server had a problem. Please try again in a moment.";
  try { const j = JSON.parse(raw); return j.message || j.hint || raw; } catch { return raw || `Request failed (${status})`; }
};

// Domain API — every function here is the ONLY way features touch data.
const db = {
  packsOverview: () => restAll("pm_pack_overview?order=sort_order.asc"),
  dashboard: () => rpc("pm_dashboard_stats"),
  createPack: (p) => rest("pm_packs", { method: "POST", body: p }).then(r => r.data?.[0]),
  updatePack: (id, p) => rest(`pm_packs?id=eq.${id}`, { method: "PATCH", body: p }).then(r => r.data?.[0]),
  deletePack: (id) => rest(`pm_packs?id=eq.${id}`, { method: "DELETE" }),
  clonePack: (src, slug, name) => rpc("pm_clone_pack", { src, new_slug: slug, new_name: name }),
  reorderPacks: (updates) => Promise.all(updates.map(u => rest(`pm_packs?id=eq.${u.id}`, { method: "PATCH", body: { sort_order: u.sort_order } }))),

  questions: (packId, { page = 0, size = CFG.pageSize, fromDate = null, toDate = null, level = null, packLevel = null, sort = "order" } = {}) => {
    let path = `pm_questions?pack_id=eq.${packId}`;
    if (fromDate) path += `&created_at=gte.${encodeURIComponent(fromDate)}`;
    if (toDate) path += `&created_at=lt.${encodeURIComponent(toDate)}`;
    if (level != null) {
      // A question's effective level = its own level, or the pack's level if null.
      // So "level X" must include inheritors (level IS NULL) when X equals the pack's level.
      path += (packLevel != null && level === packLevel)
        ? `&or=(level.eq.${level},level.is.null)`
        : `&level=eq.${level}`;
    }
    const order = sort === "recent" ? "created_at.desc" : sort === "oldest" ? "created_at.asc" : "sort_order.asc,created_at.asc";
    path += `&order=${order}`;
    return rest(path, { range: [page * size, page * size + size - 1] });
  },
  // All questions for a pack (paginated past the 1000-row cap) — for the generator avoid-list
  // and import de-duplication. Returns the full array.
  allQuestionsForPack: (packId) => restAll(`pm_questions?pack_id=eq.${packId}&order=sort_order.asc`),
  searchQuestions: (args) => rpc("pm_search_questions", args),
  // args: { q, pack, stat, lvl, lim, off } — lvl filters by effective level
  createQuestion: (q) => rest("pm_questions", { method: "POST", body: q }).then(r => r.data?.[0]),
  createQuestions: (rows) => rest("pm_questions", { method: "POST", body: rows }).then(r => r.data),
  updateQuestion: (id, q) => rest(`pm_questions?id=eq.${id}`, { method: "PATCH", body: q }).then(r => r.data?.[0]),
  deleteQuestion: (id) => rest(`pm_questions?id=eq.${id}`, { method: "DELETE" }),
  deleteQuestions: (ids) => ids?.length ? rest(`pm_questions?id=in.(${ids.join(",")})`, { method: "DELETE" }) : Promise.resolve({ data: null }),
  setQuestionsStatus: (ids, status) => ids?.length ? rest(`pm_questions?id=in.(${ids.join(",")})`, { method: "PATCH", body: { status } }) : Promise.resolve({ data: null }),

  exportAll: async () => {
    const packs = await restAll("pm_packs?order=sort_order.asc");
    const qs = await restAll("pm_questions?order=sort_order.asc");
    return { packs, questions: qs };
  },
};

// ============================================================
// Design tokens
// ============================================================
// Colors reference CSS variables so a `data-theme` swap re-skins instantly.
const V = (name) => `var(--${name})`;
const C = {
  bg: V("bg"), bgDeep: V("bgDeep"), panel: V("panel"),
  ink: V("ink"), ink2: V("ink2"), sub: V("sub"), faint: V("faint"),
  line: V("line"), lineSoft: V("lineSoft"),
  brand: V("brand"), brand2: V("brand2"), brandSoft: V("brandSoft"), brandInk: V("brandInk"),
  good: V("good"), goodSoft: V("goodSoft"), goodInk: V("goodInk"),
  warn: V("warn"), warnSoft: V("warnSoft"), warnInk: V("warnInk"),
  danger: V("danger"), dangerSoft: V("dangerSoft"), dangerInk: V("dangerInk"),
  info: V("info"), infoSoft: V("infoSoft"),
};
// The actual values, per theme — injected as CSS vars in GlobalStyle.
const THEMES = {
  light: {
    bg: "#F6F5FB", bgDeep: "#EEEBF7", panel: "#FFFFFF",
    ink: "#191728", ink2: "#4A4763", sub: "#6E6B85", faint: "#726E88",
    line: "#E4E0F0", lineSoft: "#EFECF7",
    brand: "#6C4CE0", brand2: "#8A6EF0", brandSoft: "#EEE9FD", brandInk: "#4A32B0",
    good: "#0E8C7E", goodSoft: "#DEF5F1", goodInk: "#0A6B60",
    warn: "#C06D18", warnSoft: "#FBEEDD", warnInk: "#9C5B14",
    danger: "#D83A3F", dangerSoft: "#FCE9E9", dangerInk: "#B02A2E",
    info: "#4C82E0", infoSoft: "#E5EDFB",
  },
  dark: {
    bg: "#131120", bgDeep: "#0D0B16", panel: "#1C1930",
    ink: "#F3F1FB", ink2: "#C9C5DC", sub: "#9995B0", faint: "#8A87A3",
    line: "#332F4C", lineSoft: "#28243E",
    brand: "#9B7BF0", brand2: "#B49CF6", brandSoft: "#2A2350", brandInk: "#C7B5FA",
    good: "#2CC7B4", goodSoft: "#123B37", goodInk: "#7EE8DA",
    warn: "#F0A54C", warnSoft: "#3A2A12", warnInk: "#F5C58A",
    danger: "#F0666B", dangerSoft: "#3A1618", dangerInk: "#F7A0A3",
    info: "#6D9BF0", infoSoft: "#1A2540",
  },
};
const themeVars = (name) => Object.entries(THEMES[name]).map(([k, v]) => `--${k}:${v};`).join("");
const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
const R = { sm: 8, md: 11, lg: 14, xl: 18, pill: 999 };
const SH = {
  sm: `0 1px 2px ${V("shadow1")}`,
  md: `0 4px 14px ${V("shadow2")}`,
  lg: `0 12px 32px ${V("shadow2")}`,
  xl: `0 24px 60px ${V("shadow3")}`,
  brand: "0 6px 18px rgba(108,76,224,0.30)",
};
// shadow strengths per theme
THEMES.light.shadow1 = "rgba(25,23,40,0.06)"; THEMES.light.shadow2 = "rgba(25,23,40,0.10)"; THEMES.light.shadow3 = "rgba(25,23,40,0.18)";
THEMES.dark.shadow1 = "rgba(0,0,0,0.4)"; THEMES.dark.shadow2 = "rgba(0,0,0,0.5)"; THEMES.dark.shadow3 = "rgba(0,0,0,0.65)";
const FONT = "'Nunito', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// Theme controller: system | light | dark, persisted.
const themeCtl = {
  key: "pm_theme",
  get() { try { return localStorage.getItem(this.key) || "system"; } catch { return "system"; } },
  resolved(pref) { const p = pref || this.get(); if (p === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; return p; },
  set(pref) { try { localStorage.setItem(this.key, pref); } catch {}; this.apply(pref); },
  apply(pref) { document.documentElement.setAttribute("data-theme", this.resolved(pref)); },
};
const useTheme = () => {
  const [pref, setPref] = useState(themeCtl.get());
  useEffect(() => {
    themeCtl.apply(pref);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => { if (themeCtl.get() === "system") themeCtl.apply("system"); };
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [pref]);
  const set = (p) => { themeCtl.set(p); setPref(p); };
  return { pref, resolved: themeCtl.resolved(pref), set };
};

const STATUS = {
  published: { bg: C.goodSoft, fg: C.goodInk, label: "Published", dot: C.good },
  draft: { bg: C.lineSoft, fg: C.sub, label: "Draft", dot: C.faint },
  archived: { bg: C.warnSoft, fg: C.warnInk, label: "Archived", dot: C.warn },
  active: { bg: C.goodSoft, fg: C.goodInk, label: "Active", dot: C.good },
  inactive: { bg: C.lineSoft, fg: C.sub, label: "Inactive", dot: C.faint },
};

// ============================================================
// Utilities
// ============================================================
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const cx = (...a) => a.filter(Boolean).join(" ");
const uid = () => Math.random().toString(36).slice(2, 9);

// Render a question the way a child sees it.
// Mask a word by hiding `letters` characters, controlling WHERE they sit
// (start/middle/end/random) and whether multiple hidden letters are grouped
// together or spread apart.
// Compact relative time for "added" stamps: "just now", "5m", "3h", "2d", "3w", or a date.
const relativeTime = (iso) => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
  const w = Math.floor(d / 7); if (w < 5) return w + "w ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const maskWord = (word, letters, position = "end", grouping = "grouped") => {
  word = (word || "____").toUpperCase();
  const n = word.length;
  letters = Math.max(0, Math.min(letters, n));
  if (letters === 0) return word;
  if (letters >= n) return "_".repeat(Math.max(3, n));

  let idx = [];
  if (grouping === "spread" && letters >= 2) {
    // Distribute hidden letters as evenly as possible across the word.
    const step = (n - 1) / letters;
    const picks = new Set();
    for (let k = 0; k < letters; k++) {
      let p = Math.round(step * (k + 0.5));
      p = Math.max(0, Math.min(n - 1, p));
      while (picks.has(p)) p = (p + 1) % n;
      picks.add(p);
    }
    idx = [...picks].sort((a, b) => a - b);
  } else {
    // Grouped: a contiguous block placed by position.
    let start;
    if (position === "start") start = 0;
    else if (position === "end") start = n - letters;
    else if (position === "middle") start = Math.floor((n - letters) / 2);
    else {
      // "random" — but DETERMINISTIC per word so the blank is stable across renders
      // and matches what the game will compute. Seed from the word's char codes.
      let seed = 0;
      for (let i = 0; i < word.length; i++) seed = (seed * 31 + word.charCodeAt(i)) >>> 0;
      start = seed % (n - letters + 1);
    }
    for (let k = 0; k < letters; k++) idx.push(start + k);
  }
  const chars = word.split("");
  for (const i of idx) chars[i] = "_";
  return chars.join("");
};

// Resolve the effective blank-shape settings for a question:
// question override → its level's default → pack's level default → fallback.
// Resolve frame-word slots for a given level. A slot is any {token} in the template other
// than {blank} (the selectable target). Each slot may define a `pool` of variations and an
// optional per-level pick in `byLevel`. Resolution: byLevel[level] wins; else a deterministic
// pick from the pool (seeded by token+level so it's stable across renders AND matches the
// game/edge exactly); else the token name itself as a plain fallback word.
const resolveSlots = (template, frameSlots, level) => {
  if (!template) return "";
  return template.replace(/\{([a-zA-Z][\w-]*)\}/g, (m, token) => {
    if (token === "blank") return m; // target blank is handled separately
    const slot = frameSlots && frameSlots[token];
    if (!slot) return token; // no config → show the bare word (strip braces)
    const byLevel = slot.byLevel || {};
    if (byLevel[level] != null && byLevel[level] !== "") return byLevel[level];
    const pool = Array.isArray(slot.pool) ? slot.pool.filter(Boolean) : [];
    if (pool.length === 0) return token;
    if (pool.length === 1) return pool[0];
    let seed = level | 0;
    for (let i = 0; i < token.length; i++) seed = (seed * 31 + token.charCodeAt(i)) >>> 0;
    return pool[seed % pool.length];
  });
};

// Like resolveSlots but returns a structured map { token: resolvedWord } for a given level,
// instead of the rendered string. Lets the export expose exactly which frame words were used.
const resolveFrameMap = (template, frameSlots, level) => {
  const map = {};
  if (!template) return map;
  for (const m of template.matchAll(/\{([a-zA-Z][\w-]*)\}/g)) {
    const token = m[1];
    if (token === "blank") continue;
    const slot = frameSlots && frameSlots[token];
    if (!slot) { map[token] = token; continue; }
    const byLevel = slot.byLevel || {};
    if (byLevel[level] != null && byLevel[level] !== "") { map[token] = byLevel[level]; continue; }
    const pool = Array.isArray(slot.pool) ? slot.pool.filter(Boolean) : [];
    if (pool.length === 0) { map[token] = token; continue; }
    if (pool.length === 1) { map[token] = pool[0]; continue; }
    let seed = level | 0;
    for (let i = 0; i < token.length; i++) seed = (seed * 31 + token.charCodeAt(i)) >>> 0;
    map[token] = pool[seed % pool.length];
  }
  return map;
};

// Build the per-level variants for a question — the SINGLE shared rendering engine used by the
// editor preview, the question-list rows, Play mode, the export, and (mirrored) the game feed.
// Each level's hidden_mode decides letters-vs-whole-word; per-level overrides win over the level
// default, which wins over the question's own placement.
const buildLevelVariants = (q, levels, overrides = {}) => {
  return (levels || []).map(lvl => {
    const ov = overrides[lvl.level] || {};
    const hasOv = Object.keys(ov).filter(k => !["question_id", "level", "updated_at"].includes(k) && ov[k] != null).length > 0;
    const template = ov.template ?? q.template;
    const answer = ov.answer ?? q.answer;
    const alt = ov.alt_answer ?? q.alt_answer;
    const word = (answer || "").toUpperCase();
    const isWord = lvl.hidden_mode === "word";
    const letters = ov.letters_hidden ?? (isWord ? word.length : Math.min(lvl.letters_hidden_default || 2, Math.max(1, word.length - 1)));
    const position = ov.letter_position ?? q.letter_position ?? lvl.letter_position ?? "end";
    const grouping = ov.letter_grouping ?? q.letter_grouping ?? lvl.letter_grouping ?? "grouped";
    const blank = (isWord || letters >= word.length) ? "_".repeat(Math.max(3, word.length)) : maskWord(word, letters, position, grouping);
    const withSlots = resolveSlots(template, q.frame_slots, lvl.level);
    const sentence = withSlots.replace(/\{blank\}/g, blank);
    const frames = resolveFrameMap(template, q.frame_slots, lvl.level);
    return {
      level: lvl.level, name: lvl.name, color: lvl.color,
      sentence, blank, letters, position, grouping,
      target: {
        word: (answer || "").toUpperCase(), altWord: (alt || "").toUpperCase(), blankShape: blank,
        wholeWord: isWord || letters >= word.length,
        lettersHidden: (isWord || letters >= word.length) ? word.length : letters,
        position, grouping,
      },
      frames,
      opts: [answer, alt].filter(Boolean).map(w => w.toUpperCase()).join(" / "),
      isOverride: hasOv, enabled: ov.enabled !== false, override: ov,
    };
  });
};

// Preview a question as the child sees it AT A GIVEN LEVEL, using the shared engine above so the
// list rows / Play mode match the editor and the game exactly. Falls back to a bare level def
// when the full level list isn't handy.
const previewAtLevel = (q, levels, packLevel) => {
  const lvlNum = q?.level ?? packLevel ?? 1;
  let def = (levels || []).find(l => l.level === lvlNum);
  // Fallback only when the full level list isn't loaded yet. Neutral default (letters mode) —
  // never infer whole-word from the number, since levels/rules are fully data-driven now.
  if (!def) def = { level: lvlNum, hidden_mode: "letters", letters_hidden_default: 2, letter_position: "end", letter_grouping: "grouped" };
  const v = buildLevelVariants(q, [def], {})[0];
  return v ? { sentence: v.sentence, opts: v.opts, blank: v.blank, letters: v.letters } : { sentence: q?.template || "", opts: "" };
};

// ============================================================
// Hooks
// ============================================================
const useBreakpoint = () => {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    let raf; const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setW(window.innerWidth)); };
    window.addEventListener("resize", on); window.addEventListener("orientationchange", on);
    return () => { window.removeEventListener("resize", on); window.removeEventListener("orientationchange", on); cancelAnimationFrame(raf); };
  }, []);
  return { w, isPhone: w < 640, isTablet: w >= 640 && w < 1024, isDesktop: w >= 1024 };
};

// Toast system via a tiny event bus
const toastBus = (() => {
  let listeners = [];
  return {
    emit: (t) => listeners.forEach(l => l(t)),
    sub: (fn) => { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
  };
})();
const notify = (message, opts = {}) => toastBus.emit({ id: uid(), message, kind: opts.kind || "success", action: opts.action, duration: opts.duration ?? 3200 });

const useHotkey = (key, handler, active = true) => {
  useEffect(() => {
    if (!active) return;
    const on = (e) => {
      const k = e.key.toLowerCase();
      const combo = (e.metaKey || e.ctrlKey ? "mod+" : "") + k;
      if (combo === key || k === key) { handler(e); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [key, handler, active]);
};

// Focus trap + Escape for modals/sheets
const useFocusTrap = (ref, active, onClose) => {
  useEffect(() => {
    if (!active || !ref.current) return;
    const node = ref.current;
    const sel = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';
    const first = node.querySelectorAll(sel)[0];
    first && first.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose && onClose(); return; }
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const f = items[0], l = items[items.length - 1];
      if (e.shiftKey && document.activeElement === f) { e.preventDefault(); l.focus(); }
      else if (!e.shiftKey && document.activeElement === l) { e.preventDefault(); f.focus(); }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [active, ref, onClose]);
};

// generic async runner with loading/error
const useAsync = (fn, deps = []) => {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const run = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try { const data = await fn(); setState({ loading: false, error: null, data }); return data; }
    catch (e) { setState({ loading: false, error: e.message, data: null }); }
  }, deps); // eslint-disable-line
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d) => setState(s => ({ ...s, data: typeof d === "function" ? d(s.data) : d })) };
};

// ===== primitives.jsx =====
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

// ===== realtime.jsx =====
// ============================================================
// Realtime — live sync via Supabase Realtime (Postgres changes).
// Lean websocket client (no Supabase SDK): connects to the Realtime
// endpoint, subscribes to postgres_changes on our tables, and emits
// events so open sessions refresh when anyone edits data.
// ============================================================
const realtime = (() => {
  let ws = null;
  let ref = 0;
  let heartbeat = null;
  let reconnectTimer = null;
  let connected = false;
  let intentionalClose = false;
  const listeners = new Set();       // fns called on any relevant change: (payload) => {}
  const statusListeners = new Set(); // fns called on connection status change: (isConnected) => {}
  const TOPIC = "realtime:pm";

  const TABLES = ["pm_packs", "pm_questions", "pm_levels", "pm_question_levels", "pm_export_profiles", "pm_sync_targets", "pm_activity"];

  const nextRef = () => String(++ref);

  const send = (event, payload, joinRef) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ topic: TOPIC, event, payload, ref: nextRef(), join_ref: joinRef }));
  };

  const emitStatus = (val) => { connected = val; statusListeners.forEach(fn => { try { fn(val); } catch {} }); };

  const join = () => {
    const joinRef = nextRef();
    // Subscribe to all our tables via postgres_changes config.
    const changes = TABLES.map(t => ({ event: "*", schema: "public", table: t }));
    ws.send(JSON.stringify({
      topic: TOPIC,
      event: "phx_join",
      payload: { config: { postgres_changes: changes, broadcast: { self: false }, presence: { key: "" } }, access_token: session.token || CFG.key },
      ref: nextRef(), join_ref: joinRef,
    }));
    // Heartbeat every 25s keeps the socket alive.
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() }));
    }, 25000);
  };

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    // If a previous socket is still CLOSING, tear it down cleanly before opening a new one
    // so we never end up with two live sockets (and two heartbeats).
    if (ws && ws.readyState === WebSocket.CLOSING) { try { ws.onclose = null; ws.close(); } catch {} ws = null; clearInterval(heartbeat); }
    intentionalClose = false;
    const wsUrl = CFG.url.replace(/^http/, "ws") + `/realtime/v1/websocket?apikey=${encodeURIComponent(CFG.key)}&vsn=1.0.0`;
    try { ws = new WebSocket(wsUrl); } catch { scheduleReconnect(); return; }

    ws.onopen = () => { join(); };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "phx_reply" && msg.payload?.status === "ok" && !connected) emitStatus(true);
      if (msg.event === "postgres_changes") {
        const data = msg.payload?.data;
        if (data) {
          const info = { table: data.table, type: data.type, record: data.record, old: data.old_record };
          listeners.forEach(fn => { try { fn(info); } catch {} });
        }
      }
      if (msg.event === "phx_error" || msg.event === "phx_close") { emitStatus(false); }
    };
    ws.onerror = () => { emitStatus(false); };
    ws.onclose = () => { emitStatus(false); clearInterval(heartbeat); if (!intentionalClose) scheduleReconnect(); };
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { if (!intentionalClose) connect(); }, 3000);
  };

  const disconnect = () => {
    intentionalClose = true;
    clearInterval(heartbeat); clearTimeout(reconnectTimer);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    emitStatus(false);
  };

  // Push a refreshed access token to the live socket so long-lived connections keep
  // authorizing correctly after a background token refresh (no need to wait for reconnect).
  const updateToken = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ topic: TOPIC, event: "access_token", payload: { access_token: session.token || CFG.key }, ref: nextRef() }));
    }
  };

  return {
    connect, disconnect, updateToken,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    onStatus: (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    isConnected: () => connected,
  };
})();

// Hook: manage the realtime connection lifecycle + a live status flag.
function useRealtime(authed) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!authed) { realtime.disconnect(); setLive(false); return; }
    const offStatus = realtime.onStatus(setLive);
    realtime.connect();
    // Reconnect when the tab becomes visible again (mobile/browsers suspend sockets).
    const onVis = () => { if (document.visibilityState === "visible") realtime.connect(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { offStatus(); document.removeEventListener("visibilitychange", onVis); realtime.disconnect(); };
  }, [authed]);
  return live;
}

// Hook: subscribe to changes on specific tables and run a (debounced) refresh.
// `tables` is an array of table names; `onRelevant` is called when any fires.
function useRealtimeRefresh(tables, onRelevant, deps = []) {
  const savedCb = useRef(onRelevant);
  savedCb.current = onRelevant;
  useEffect(() => {
    let timer = null;
    const off = realtime.onChange((info) => {
      if (!tables.includes(info.table)) return;
      clearTimeout(timer);
      timer = setTimeout(() => savedCb.current && savedCb.current(info), 350); // debounce bursts
    });
    return () => { off(); clearTimeout(timer); };
    // eslint-disable-next-line
  }, deps);
}

// Small "Live" pill for the header.
function LiveBadge({ live }) {
  return (
    <span title={live ? "Live sync on — changes from other devices appear automatically" : "Reconnecting…"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, padding: "3px 10px", borderRadius: R.pill, background: live ? C.goodSoft : C.lineSoft, color: live ? C.goodInk : C.faint, whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: live ? C.good : C.faint, boxShadow: live ? `0 0 0 3px ${C.good}22` : "none", animation: live ? "pm-pulse 2s ease-in-out infinite" : "none" }} />
      {live ? "Live" : "Offline"}
    </span>
  );
}

// ===== engine.jsx =====
// ============================================================
// Transformation Engine (client) — identical logic to the edge fn.
// Turns internal packs+questions into a customizable external shape.
// ============================================================
const TRANSFORMS = [
  { v: "none", label: "None" },
  { v: "upper", label: "UPPERCASE" },
  { v: "lower", label: "lowercase" },
  { v: "trim", label: "Trim spaces" },
];

const xf = (val, t) => {
  if (val == null) return val;
  if (typeof val === "object") return val; // never stringify objects/arrays (e.g. frame_slots, tags)
  switch (t) { case "upper": return String(val).toUpperCase(); case "lower": return String(val).toLowerCase(); case "trim": return String(val).trim(); default: return val; }
};
const mapVal = (field, val, vm) => {
  const m = vm?.[field];
  if (!m) return val;
  const key = (typeof val === "object" || val == null) ? null : val; // only primitives can key a value_map
  return (key != null && key in m) ? m[key] : val;
};
const projectRow = (row, fields, vm) => {
  const out = {};
  for (const f of fields || []) { if (!f.to) continue; let v = xf(row[f.from], f.transform || "none"); v = mapVal(f.to, v, vm); out[f.to] = v; }
  return out;
};

// Convert a built output object/array into pretty XML. Keys become tags;
// arrays repeat a singularized item tag; primitives become text nodes.
const XML_ESC = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const singular = (k) => k === "levels" ? "levelVariant" : k.endsWith("ies") ? k.slice(0, -3) + "y" : k.endsWith("s") ? k.slice(0, -1) : k;
const safeTag = (k) => /^[a-zA-Z_][\w.-]*$/.test(k) ? k : "item";
const toXmlNode = (key, val, indent) => {
  const pad = "  ".repeat(indent);
  const tag = safeTag(key);
  if (val === null || val === undefined) return `${pad}<${tag}/>`;
  if (Array.isArray(val)) {
    const item = singular(tag);
    if (val.length === 0) return `${pad}<${tag}/>`;
    return `${pad}<${tag}>\n` + val.map(v => toXmlNode(item, v, indent + 1)).join("\n") + `\n${pad}</${tag}>`;
  }
  if (typeof val === "object") {
    const inner = Object.entries(val).map(([k, v]) => toXmlNode(k, v, indent + 1)).join("\n");
    return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${XML_ESC(val)}</${tag}>`;
};
const toXml = (obj, rootTag = "gameContent") => {
  const body = Array.isArray(obj)
    ? obj.map(v => toXmlNode("item", v, 1)).join("\n")
    : Object.entries(obj).map(([k, v]) => toXmlNode(k, v, 1)).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n${body}\n</${rootTag}>`;
};

// packs: array; byPack: { [packId or slug]: questions[] }; keyField tells which key byPack uses
const buildOutput = (spec, packs, byPack, keyField = "id") => {
  const vm = spec.value_maps || {};
  const qKey = spec.questions_key || "questions";
  const projectQ = (q) => { const base = projectRow(q, spec.question_fields, vm); if (spec.expand_levels && q.levels) base.levels = q.levels; if (spec.include_frames && q.frame_slots && Object.keys(q.frame_slots).length) base.frameSlots = q.frame_slots; return base; };
  const k = (p) => p[keyField];

  if (spec.structure === "flat") {
    const arr = [];
    for (const p of packs) { const pp = projectRow(p, spec.pack_fields, vm); for (const q of byPack[k(p)] || []) arr.push({ ...pp, ...projectQ(q) }); }
    return spec.root_key ? { [spec.root_key]: arr } : arr;
  }
  if (spec.structure === "keyed") {
    const obj = {}; const keyBy = spec.key_by || "slug";
    for (const p of packs) obj[p[keyBy]] = { ...projectRow(p, spec.pack_fields, vm), [qKey]: (byPack[k(p)] || []).map(projectQ) };
    return spec.root_key ? { [spec.root_key]: obj } : obj;
  }
  const arr = packs.map((p) => ({ ...projectRow(p, spec.pack_fields, vm), [qKey]: (byPack[k(p)] || []).map(projectQ) }));
  return spec.root_key ? { [spec.root_key]: arr } : arr;
};

const withMeta = (spec, body, counts) => {
  if (spec.include_meta === false) return body;
  const meta = { generated_at: new Date().toISOString(), profile: spec.__name || "", pack_count: counts.packs, question_count: counts.questions };
  return Array.isArray(body) ? { meta, data: body } : { meta, ...body };
};

// Field names available to map from
const PACK_SOURCE_FIELDS = ["slug", "name", "emoji", "description", "color", "difficulty", "status", "is_custom", "tags", "level", "purpose", "focus_areas", "style_approach", "example_objectives"];
const QUESTION_SOURCE_FIELDS = ["template", "base_sentence", "answer", "alt_answer", "status", "notes", "level", "effective_level", "letter_position", "letter_grouping", "frame_slots"];

const emptySpec = () => ({
  structure: "nested", root_key: "packs", questions_key: "questions", key_by: "slug",
  include_meta: true, filters: { status: "published", question_status: "active" },
  pack_fields: [{ from: "slug", to: "id", transform: "none" }, { from: "name", to: "name", transform: "none" }],
  question_fields: [{ from: "template", to: "template", transform: "none" }, { from: "answer", to: "answer", transform: "none" }],
  value_maps: {},
});

const db_profiles = {
  list: () => rest("pm_export_profiles?order=created_at.asc&limit=1000").then(r => r.data || []),
  create: (p) => rest("pm_export_profiles", { method: "POST", body: p }).then(r => r.data?.[0]),
  update: (id, p) => rest(`pm_export_profiles?id=eq.${id}`, { method: "PATCH", body: p }).then(r => r.data?.[0]),
  remove: (id) => rest(`pm_export_profiles?id=eq.${id}`, { method: "DELETE" }),
};
const db_sync = {
  log: (row) => rest("pm_sync_log", { method: "POST", body: row }).catch(() => {}),
  history: () => rest("pm_sync_log?order=created_at.desc&limit=100").then(r => r.data || []),
  // Advance released_version = content_version so "pending changes" clears. null = all published.
  markReleased: (packIds = null) => rpc("pm_mark_released", { pack_ids: packIds }),
};

// Fetch all content for building an export (paginated — no silent 1000 cap).
const fetchAllContent = async (filters = {}, opts = {}) => {
  let pQ = "pm_packs?order=sort_order.asc";
  if (filters.status) pQ += `&status=eq.${filters.status}`;
  const packs = await restAll(pQ);
  let qQ = "pm_questions?order=sort_order.asc";
  if (filters.question_status) qQ += `&status=eq.${filters.question_status}`;
  const questions = await restAll(qQ);

  const packLevelById = {};
  for (const p of packs) packLevelById[p.id] = p.level || 1;

  // Attach the effective level to every question (question override → pack default).
  // Also add a resolved base sentence (frame words filled at the base level) alongside the
  // raw template, so a consumer reading the base question sees real words, not {tokens}.
  for (const q of questions) {
    q.effective_level = q.level ?? packLevelById[q.pack_id] ?? 1;
    q.base_sentence = resolveSlots(q.template || "", q.frame_slots, q.effective_level).replace(/\{blank\}/g, (q.answer || "").toUpperCase());
  }

  // If the profile wants per-level variants, fetch level defs + overrides and expand.
  if (opts.expandLevels) {
    const levels = await restAll("pm_levels?order=level.asc");
    const overrideRows = await restAll("pm_question_levels?order=level.asc");
    const ovByQ = {};
    for (const r of overrideRows) { (ovByQ[r.question_id] = ovByQ[r.question_id] || {})[r.level] = r; }
    for (const q of questions) {
      q.levels = buildLevelVariants(q, levels, ovByQ[q.id] || {})
        .filter(v => v.enabled)
        .map(v => ({ level: v.level, level_name: v.name, sentence: v.sentence, blank: v.blank, target: v.target, frames: v.frames, opts: v.opts }));
    }
  }

  const byPack = {};
  for (const q of questions) (byPack[q.pack_id] = byPack[q.pack_id] || []).push(q);
  const packList = packs.filter(p => (byPack[p.id]?.length || 0) > 0 || filters.include_empty);
  return { packs: packList, byPack, questionCount: questions.length };
};

// ===== firebase.jsx =====
// ============================================================
// Firebase Transport — writes transformed content into Firebase.
// Supports: Realtime DB (REST), Firestore (REST), Cloud Function (POST).
// Layout is fully configurable via path templates.
// ============================================================

// Resolve a path template like "packs/{slug}" or "content/all"
const resolvePath = (tpl, ctx) => (tpl || "").replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "");

// Convert a plain JS value into Firestore's typed REST format.
const toFirestoreValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFirestoreValue(x)])) } };
  return { stringValue: String(v) };
};
const toFirestoreDoc = (obj) => ({ fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toFirestoreValue(v)])) });

// Given the built output and a target config, produce a list of write ops.
// Each op: { path, data }  (data is a JS object/array)
const planWrites = (cfg, packs, byPack, buildFn, spec) => {
  const layout = cfg.layout || "per-pack";
  const ops = [];
  if (layout === "single-doc") {
    const body = buildFn(spec, packs, byPack, "id");
    ops.push({ path: cfg.singlePath || "content/all", data: body });
  } else if (layout === "per-question") {
    // one entry per question at questionPath/{id}
    for (const p of packs) {
      for (const q of byPack[p.id] || []) {
        const one = buildFn({ ...spec, structure: "flat", root_key: null }, [p], { [p.id]: [q] }, "id");
        const row = Array.isArray(one) ? one[0] : one;
        ops.push({ path: resolvePath(cfg.questionPath || "questions/{id}", { id: q.id, slug: p.slug }), data: row });
      }
    }
  } else {
    // per-pack (default): one doc per pack at packPath/{slug}
    for (const p of packs) {
      const one = buildFn({ ...spec, structure: "nested", root_key: null }, [p], byPack, "id");
      const row = Array.isArray(one) ? one[0] : one;
      ops.push({ path: resolvePath(cfg.packPath || "packs/{slug}", { slug: p.slug, id: p.id }), data: row });
    }
  }
  return ops;
};

// --- writers ---
const fbWriters = {
  // Realtime Database via REST. cfg: { rtdbUrl, secret }
  async rtdb(cfg, ops) {
    const base = (cfg.rtdbUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("Realtime DB URL is required");
    let ok = 0;
    for (const op of ops) {
      const auth = cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : "";
      const res = await fetch(`${base}/${op.path}.json${auth}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op.data) });
      if (!res.ok) throw new Error(`RTDB write failed at ${op.path}: HTTP ${res.status}`);
      ok++;
    }
    return { written: ok };
  },

  // Firestore via REST. cfg: { projectId, apiKey?, bearer? }
  async firestore(cfg, ops) {
    if (!cfg.projectId) throw new Error("Firestore projectId is required");
    const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;
    let ok = 0;
    for (const op of ops) {
      // path like "packs/confidence" -> collection/doc
      const parts = op.path.split("/").filter(Boolean);
      const docId = parts.pop();
      const collection = parts.join("/");
      const key = cfg.apiKey ? `?key=${cfg.apiKey}` : "";
      const url = `${base}/${collection}?documentId=${encodeURIComponent(docId)}${key}`;
      const headers = { "Content-Type": "application/json" };
      if (cfg.bearer) headers.Authorization = `Bearer ${cfg.bearer}`;
      // Firestore create; if exists, PATCH instead
      let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(toFirestoreDoc(op.data)) });
      if (res.status === 409) {
        const patchUrl = `${base}/${collection}/${encodeURIComponent(docId)}${key}`;
        res = await fetch(patchUrl, { method: "PATCH", headers, body: JSON.stringify(toFirestoreDoc(op.data)) });
      }
      if (!res.ok) throw new Error(`Firestore write failed at ${op.path}: HTTP ${res.status}`);
      ok++;
    }
    return { written: ok };
  },

  // Cloud Function (or any endpoint): POST the whole payload once. cfg: { fnUrl, secret, header }
  async cloudFn(cfg, ops, fullPayload) {
    if (!cfg.fnUrl) throw new Error("Cloud Function URL is required");
    const headers = { "Content-Type": "application/json" };
    if (cfg.secret) headers[cfg.header || "Authorization"] = cfg.secret;
    const res = await fetch(cfg.fnUrl, { method: "POST", headers, body: JSON.stringify({ writes: ops, payload: fullPayload }) });
    if (!res.ok) throw new Error(`Cloud Function returned HTTP ${res.status}`);
    return { written: ops.length };
  },
};

// Orchestrate a Firebase sync for a target.
const runFirebaseSync = async (target, profile) => {
  const cfg = target.config || {};
  const content = await fetchAllContent(profile.spec.filters || {}, { expandLevels: !!profile.spec.expand_levels });
  const spec = { ...profile.spec, __name: profile.name };
  const ops = planWrites(cfg, content.packs, content.byPack, buildOutput, spec);
  const fullBody = buildOutput(spec, content.packs, content.byPack, "id");
  const fullPayload = withMeta(spec, fullBody, { packs: content.packs.length, questions: content.questionCount });

  let result;
  if (cfg.mode === "firestore") result = await fbWriters.firestore(cfg, ops);
  else if (cfg.mode === "cloudfn") result = await fbWriters.cloudFn(cfg, ops, fullPayload);
  else result = await fbWriters.rtdb(cfg, ops);

  return { ...result, packCount: content.packs.length, questionCount: content.questionCount, opCount: ops.length };
};

const db_targets = {
  list: () => rest("pm_sync_targets?order=created_at.asc&limit=1000").then(r => r.data || []),
  create: (t) => rest("pm_sync_targets", { method: "POST", body: t }).then(r => r.data?.[0]),
  update: (id, t) => rest(`pm_sync_targets?id=eq.${id}`, { method: "PATCH", body: t }).then(r => r.data?.[0]),
  remove: (id) => rest(`pm_sync_targets?id=eq.${id}`, { method: "DELETE" }),
};

// ===== editors.jsx =====
// ============================================================
// Editors
// ============================================================
const EMOJIS = ["💪","😊","🧘","🎯","🎓","💡","🛡️","🤝","🫶","🌟","🗣️","👨‍👩‍👧","🌈","🕊️","❤️","🌱","✨","🧠","🔆","🦋","🌞","🏆","🎨","🚀"];
const COLORS = ["#F39C12","#E84393","#00B894","#0984E3","#6C4CE0","#FDCB6E","#D63031","#00CEC9","#E17055","#FAB1A0","#74B9FF","#A29BFE","#55EFC4","#81ECEC"];
const PACK_TAG_SUGGESTIONS = ["emotions","confidence","social","calm","focus","resilience","gratitude","school-ready","ages-5-7","ages-8-10","starter","advanced"];

function PackEditor({ pack, levels, onSave, onClose }) {
  const isNew = !pack?.id;
  const [f, setF] = useState({
    name: pack?.name || "", slug: pack?.slug || "", emoji: pack?.emoji || "💪",
    description: pack?.description || "", color: pack?.color || C.brand,
    difficulty: pack?.difficulty || "basic", status: pack?.status || "draft", is_custom: pack?.is_custom || false,
    level: pack?.level || 1,
    purpose: pack?.purpose || "", focus_areas: pack?.focus_areas || "",
    style_approach: pack?.style_approach || "", example_objectives: pack?.example_objectives || "",
    tags: pack?.tags || [],
  });
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState({});
  const [aiBusy, setAiBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const suggestDetails = async () => {
    setAiBusy(true);
    try {
      const words = pack?.id ? "" : ""; // words come from questions; the fn can work from name/theme alone
      const res = await fetch(`${CFG.url}/functions/v1/pack-describe`, {
        method: "POST",
        headers: { apikey: CFG.key, Authorization: `Bearer ${session.token || CFG.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: f.name, emoji: f.emoji, difficulty: f.difficulty, words, templates: "" }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        notify(d.error === "no_key" ? "AI drafting isn't configured yet (server needs an Anthropic API key)." : "Couldn't draft details: " + (d.message || res.status), { kind: "error" });
        return;
      }
      setF(p => ({ ...p, purpose: d.purpose || p.purpose, focus_areas: d.focus_areas || p.focus_areas, style_approach: d.style_approach || p.style_approach, example_objectives: d.example_objectives || p.example_objectives }));
      notify("Draft filled in — review and edit as needed");
    } catch (e) { notify("Couldn't reach the drafting service", { kind: "error" }); }
    finally { setAiBusy(false); }
  };

  const submit = async () => {
    const e = {};
    if (!f.name.trim()) e.name = "Give the pack a name.";
    if (!f.slug.trim()) e.slug = "Slug can't be empty.";
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    try { await onSave(f, pack?.id); onClose(); }
    catch (err) { setErrs({ form: err.message }); setBusy(false); }
  };
  useHotkey("mod+enter", submit, true);

  return (
    <>
      <ModalHead emoji={f.emoji} title={isNew ? "New pack" : "Edit pack"} subtitle={isNew ? "Add a themed category to the library" : f.name} id="pm-pack-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.lg + 2, maxHeight: "62vh", overflowY: "auto" }}>
        <Field label="Pack name" error={errs.name}>
          <Input value={f.name} onChange={(e) => { set("name", e.target.value); if (!slugTouched) set("slug", slugify(e.target.value)); }} placeholder="e.g. Confidence Pack" autoFocus />
        </Field>
        <div className="pm-form-2">
          <Field label="Slug" hint="URL-safe id used by the game" error={errs.slug}>
            <Input value={f.slug} onChange={(e) => { setSlugTouched(true); set("slug", slugify(e.target.value)); }} placeholder="confidence" />
          </Field>
          <Field label="Difficulty">
            <Select value={f.difficulty} onChange={(e) => set("difficulty", e.target.value)}>
              <option value="basic">Basic</option><option value="advanced">Advanced</option><option value="mixed">Mixed</option>
            </Select>
          </Field>
        </div>
        <Field label="Default level" hint="The starting level for questions in this pack (each question can override)">
          <Select value={f.level} onChange={(e) => set("level", parseInt(e.target.value))}>
            {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
              <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
            ))}
          </Select>
        </Field>
        <Field label="Description" hint="Short blurb shown on the pack card">
          <Textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={2} placeholder="Believe in yourself and take pride in what you do." />
        </Field>

        {/* Structured pack description */}
        <div style={{ borderTop: "1px solid " + C.line, paddingTop: S.md, marginTop: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: S.sm }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.ink, letterSpacing: 0.2, textTransform: "uppercase" }}>Pack details</span>
            <span style={{ fontSize: 12, color: C.sub }}>· purpose, focus, approach & objectives</span>
            <div style={{ flex: 1 }} />
            <Btn variant="soft" size="sm" disabled={aiBusy || !f.name} onClick={suggestDetails} icon="✦">{aiBusy ? "Drafting…" : "AI draft"}</Btn>
          </div>
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Purpose" hint="What this pack is for — its objective">
              <Textarea value={f.purpose} onChange={(e) => set("purpose", e.target.value)} rows={2} placeholder="Help children build a stable sense of self-belief…" />
            </Field>
            <Field label="Focus areas" hint="Key themes and skills it covers">
              <Textarea value={f.focus_areas} onChange={(e) => set("focus_areas", e.target.value)} rows={2} placeholder="Self-worth, personal strengths, trying new things" />
            </Field>
            <Field label="Style & approach" hint="Tone and how it teaches">
              <Textarea value={f.style_approach} onChange={(e) => set("style_approach", e.target.value)} rows={2} placeholder="Warm and encouraging; every word choice is a positive trait…" />
            </Field>
            <Field label="Example objectives" hint="Concrete goals a child works toward">
              <Textarea value={f.example_objectives} onChange={(e) => set("example_objectives", e.target.value)} rows={2} placeholder="A child can name two of their own strengths; feels able to try something new…" />
            </Field>
          </div>
        </div>
        <Field label="Tags" hint="Enter or comma to add — for cross-cutting organization">
          <TagInput tags={f.tags} onChange={(t) => set("tags", t)} suggestions={PACK_TAG_SUGGESTIONS} />
        </Field>
        <Field label="Icon">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {EMOJIS.map(e => (
              <button key={e} onClick={() => set("emoji", e)} style={{ fontSize: 20, width: 40, height: 40, borderRadius: R.md, cursor: "pointer", border: "2px solid " + (f.emoji === e ? C.brand : C.line), background: f.emoji === e ? C.brandSoft : "#fff" }}>{e}</button>
            ))}
          </div>
        </Field>
        <Field label="Accent color">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {COLORS.map(c => (
              <button key={c} onClick={() => set("color", c)} title={c} style={{ width: 30, height: 30, borderRadius: R.sm, cursor: "pointer", background: c, border: "3px solid " + (f.color === c ? C.ink : "transparent"), boxShadow: f.color === c ? "0 0 0 2px #fff inset" : "none" }} />
            ))}
          </div>
        </Field>
        <div className="pm-form-2" style={{ alignItems: "end" }}>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => set("status", e.target.value)}>
              <option value="draft">Draft (hidden from game)</option>
              <option value="published">Published (live)</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={f.is_custom} onChange={(e) => set("is_custom", e.target.checked)} style={{ width: 17, height: 17, accentColor: C.brand }} />
            <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Custom / AI-generated</span>
          </label>
        </div>
        {errs.form && <ErrorState error={errs.form} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Create pack" : "Save changes"}</Btn>
      </ModalFoot>
    </>
  );
}

// Editor for one frame-word slot: a pool of variations + optional per-level pins.
function FrameSlotEditor({ token, slot, setSlot, levels }) {
  const [showLevels, setShowLevels] = useState(false);
  const pool = slot.pool || [];
  const byLevel = slot.byLevel || {};
  const levelList = (levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" })));
  const pinnedCount = Object.values(byLevel).filter(v => v != null && v !== "").length;
  return (
    <div style={{ background: C.bg, borderRadius: R.md, padding: "12px 14px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code style={{ background: C.brandSoft, color: C.brandInk, padding: "2px 8px", borderRadius: 6, fontSize: 13, fontWeight: 800 }}>{`{${token}}`}</code>
        <span style={{ fontSize: 12.5, color: C.sub }}>variations for this word</span>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, marginBottom: 5 }}>Pool of alternatives (the game varies among these)</div>
        <TagInput tags={pool} onChange={(t) => setSlot({ pool: t })} suggestions={[]} />
      </div>
      {pool.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowLevels(v => !v)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: C.brandInk, fontSize: 12.5, fontWeight: 700 }}>
            {showLevels ? "▾" : "▸"} Pin a specific word per level {pinnedCount > 0 ? `(${pinnedCount} pinned)` : "(optional)"}
          </button>
          {showLevels && (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
              {levelList.map(l => (
                <div key={l.level} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: C.sub, minWidth: 26 }}>L{l.level}</span>
                  <Select value={byLevel[l.level] ?? ""} onChange={(e) => { const v = e.target.value; const nb = { ...byLevel }; if (v === "") delete nb[l.level]; else nb[l.level] = v; setSlot({ byLevel: nb }); }} style={{ padding: "5px 8px", fontSize: 12.5, flex: 1 }}>
                    <option value="">(vary)</option>
                    {pool.map(w => <option key={w} value={w}>{w}</option>)}
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionEditor({ question, packId, packLevel, levels, onSave, onClose }) {
  const isNew = !question?.id;
  const levelList = (levels && levels.length) ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "", hidden_mode: i >= 6 ? "word" : "letters" }));
  const [f, setF] = useState({
    template: question?.template || "I am {blank} when …",
    answer: question?.answer || "", alt_answer: question?.alt_answer || "",
    level: question?.level ?? null,
    letter_position: question?.letter_position ?? null,
    letter_grouping: question?.letter_grouping ?? null,
    status: question?.status || "active", notes: question?.notes || "",
    frame_slots: question?.frame_slots || {},
  });
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState({});
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const hasBlank = f.template.includes("{blank}");

  // The question's own base level (its override, or the pack's level).
  const baseLevel = f.level ?? packLevel ?? 1;
  // Which level to PREVIEW as (defaults to the base level; user can flip through any).
  const [previewLevel, setPreviewLevel] = useState(baseLevel);
  // Keep the preview level valid/sensible as the base level changes.
  useEffect(() => { setPreviewLevel(f.level ?? packLevel ?? 1); }, [f.level, packLevel]);

  const previewLvlDef = levelList.find(l => l.level === previewLevel) || levelList[0] || {};
  const previewHidesLetters = previewLvlDef.hidden_mode !== "word";

  // Build the real per-level variant for the previewed level, using the SAME engine the game
  // uses — so the editor preview matches exactly what the child will see.
  const previewVariant = useMemo(() => {
    const qForBuild = { template: f.template, answer: f.answer, alt_answer: f.alt_answer, frame_slots: f.frame_slots,
      letter_position: f.letter_position, letter_grouping: f.letter_grouping };
    const variants = buildLevelVariants(qForBuild, [previewLvlDef], {});
    return variants[0] || null;
  }, [f.template, f.answer, f.alt_answer, f.frame_slots, f.letter_position, f.letter_grouping, previewLvlDef]);

  // Detect frame-word tokens in the template ({token} where token !== blank).
  const frameTokens = [...new Set([...f.template.matchAll(/\{([a-zA-Z][\w-]*)\}/g)].map(m => m[1]).filter(t => t !== "blank"))];

  const submit = async () => {
    const e = {};
    if (!hasBlank) e.template = "Template must contain a {blank} token.";
    if (!f.answer.trim()) e.answer = "Enter the answer word.";
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    // Only persist slots whose token still appears in the template.
    const cleanedSlots = {};
    for (const t of frameTokens) if (f.frame_slots[t]) cleanedSlots[t] = f.frame_slots[t];
    try {
      await onSave({ ...f, frame_slots: cleanedSlots, pack_id: packId,
        answer: f.answer.toUpperCase().trim(), alt_answer: f.alt_answer.toUpperCase().trim() }, question?.id);
      onClose();
    }
    catch (err) { setErrs({ form: err.message }); setBusy(false); }
  };
  useHotkey("mod+enter", submit, true);

  return (
    <>
      <ModalHead title={isNew ? "New question" : "Edit question"} subtitle="A fill-in-the-blank sentence with a positive answer" id="pm-q-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.lg + 2, maxHeight: "64vh", overflowY: "auto" }}>
        <Field label="Sentence template" hint="Use {blank} for the word to guess. Add other {words} to make them swappable (e.g. …when things get {hard})." error={errs.template}>
          <Textarea value={f.template} onChange={(e) => set("template", e.target.value)} rows={2} placeholder="I am {blank} when I try something new." autoFocus
            style={{ borderColor: hasBlank ? C.line : C.danger }} />
        </Field>
        <div className="pm-form-2">
          <Field label="Answer (primary)" hint="Auto-uppercased" error={errs.answer}>
            <Input value={f.answer} onChange={(e) => set("answer", e.target.value)} placeholder="BRAVE" />
          </Field>
          <Field label="Second option" hint="The alternative positive word">
            <Input value={f.alt_answer} onChange={(e) => set("alt_answer", e.target.value)} placeholder="BOLD" />
          </Field>
        </div>

        <Field label="Level" hint="Sets how this question is hidden. Each level controls letters-vs-whole-word; you can override the pack's default here.">
          <Select value={f.level ?? ""} onChange={(e) => set("level", e.target.value === "" ? null : parseInt(e.target.value))}>
            <option value="">Inherit pack{packLevel ? ` (Level ${packLevel})` : ""}</option>
            {levelList.map(l => (
              <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}{l.hidden_mode === "word" ? " (whole word)" : ""}</option>
            ))}
          </Select>
        </Field>

        {/* Preview — how the child actually sees it, at a level you can flip through */}
        <div style={{ background: C.brandSoft, borderRadius: R.lg, padding: `${S.lg}px ${S.lg + 2}px` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: C.brandInk, letterSpacing: 0.5 }}>HOW THE CHILD SEES IT</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: C.brandInk, opacity: 0.75 }}>Preview level:</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {levelList.map(l => {
                const on = l.level === previewLevel;
                const isBase = l.level === baseLevel;
                return (
                  <button key={l.level} type="button" onClick={() => setPreviewLevel(l.level)} title={`${l.name || "Level " + l.level}${isBase ? " · this question's level" : ""}${l.hidden_mode === "word" ? " · whole word" : ""}`}
                    style={{ padding: "3px 8px", borderRadius: R.pill, fontSize: 11.5, fontWeight: 800, cursor: "pointer", position: "relative",
                      border: "1px solid " + (on ? C.brand : (isBase ? C.brand + "88" : "transparent")),
                      background: on ? C.brand : "transparent", color: on ? "#fff" : C.brandInk }}>
                    {l.level}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize: 17, color: C.ink, fontWeight: 500, lineHeight: 1.4 }}>{previewVariant?.sentence || "…"}</div>
          {previewVariant?.opts && <div style={{ fontSize: 14, color: C.brandInk, fontWeight: 800, marginTop: 8 }}>→ {previewVariant.opts}</div>}
          <div style={{ fontSize: 11.5, color: C.brandInk, opacity: 0.7, marginTop: 8 }}>
            {previewHidesLetters
              ? `This level hides ${previewVariant?.letters ?? "some"} letter${(previewVariant?.letters ?? 2) === 1 ? "" : "s"}.`
              : "This level hides the whole word."}
            {previewLevel === baseLevel ? " (this question's level)" : ""}
          </div>
        </div>

        {/* Per-question overrides of the level's letter placement — only relevant when the
            previewed level hides letters (not the whole word). */}
        {previewHidesLetters && (
          <div className="pm-form-2">
            <Field label="Missing letters position" hint="Override the level's placement for this question">
              <Select value={f.letter_position ?? ""} onChange={(e) => set("letter_position", e.target.value === "" ? null : e.target.value)}>
                <option value="">Inherit level ({previewLvlDef.letter_position || "end"})</option>
                <option value="start">Towards the start</option>
                <option value="middle">Towards the middle</option>
                <option value="end">Towards the end</option>
                <option value="random">Random</option>
              </Select>
            </Field>
            <Field label="When 2+ hidden" hint="Override the level's grouping for this question">
              <Select value={f.letter_grouping ?? ""} onChange={(e) => set("letter_grouping", e.target.value === "" ? null : e.target.value)}>
                <option value="">Inherit level ({previewLvlDef.letter_grouping || "grouped"})</option>
                <option value="grouped">Grouped together</option>
                <option value="spread">Spread apart</option>
              </Select>
            </Field>
          </div>
        )}

        {frameTokens.length > 0 && (
          <div style={{ border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, display: "grid", gap: S.md }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Frame word variations</div>
              <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2, lineHeight: 1.45 }}>These are swappable words in the sentence — <b>not</b> the word the child guesses. Give each a pool of alternatives, and optionally pin a specific one per level (useful for levels 7–10 where the blank stops changing).</div>
            </div>
            {frameTokens.map(token => {
              const slot = f.frame_slots[token] || { pool: [], byLevel: {} };
              const setSlot = (patch) => set("frame_slots", { ...f.frame_slots, [token]: { pool: slot.pool || [], byLevel: slot.byLevel || {}, ...patch } });
              return (
                <FrameSlotEditor key={token} token={token} slot={slot} setSlot={setSlot} levels={levels} />
              );
            })}
          </div>
        )}
        <Field label="Internal notes" hint="Optional — not shown to players">
          <Input value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
          <input type="checkbox" checked={f.status === "active"} onChange={(e) => set("status", e.target.checked ? "active" : "inactive")} style={{ width: 17, height: 17, accentColor: C.brand }} />
          <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Active (included in the game)</span>
        </label>
        {errs.form && <ErrorState error={errs.form} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Add question" : "Save changes"}</Btn>
      </ModalFoot>
    </>
  );
}

// Bulk import — supports both the pipe format and pasted JSON
// Sanitize AI/user-supplied frame_slots from an import so only clean shapes reach the DB:
// { token: { pool: [strings], byLevel: { "level": "string" } } }. Returns null if nothing valid.
function sanitizeFrameSlots(fs) {
  if (!fs || typeof fs !== "object" || Array.isArray(fs)) return null;
  const out = {};
  for (const [token, slotRaw] of Object.entries(fs)) {
    if (!/^[a-zA-Z][\w-]*$/.test(token) || token === "blank") continue;
    const slot = (slotRaw && typeof slotRaw === "object" && !Array.isArray(slotRaw)) ? slotRaw : {};
    const pool = Array.isArray(slot.pool) ? slot.pool.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()) : [];
    const byLevel = {};
    if (slot.byLevel && typeof slot.byLevel === "object" && !Array.isArray(slot.byLevel)) {
      for (const [lvl, w] of Object.entries(slot.byLevel)) {
        if (/^\d+$/.test(String(lvl)) && (typeof w === "string" || typeof w === "number") && String(w).trim()) byLevel[String(lvl)] = String(w).trim();
      }
    }
    if (pool.length || Object.keys(byLevel).length) out[token] = { pool, byLevel };
  }
  return Object.keys(out).length ? out : null;
}

function BulkImport({ packId, onDone, onClose }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [existing, setExisting] = useState([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [skipIds, setSkipIds] = useState(() => new Set()); // row indices the user chose to skip
  const [userTouched, setUserTouched] = useState(() => new Set()); // rows the user manually toggled

  // Load the pack's existing questions so we can flag duplicates.
  useEffect(() => {
    let alive = true;
    setLoadingExisting(true);
    (async () => { try { const qs = await db.allQuestionsForPack(packId); if (alive) setExisting(qs || []); } catch { if (alive) setExisting([]); } finally { if (alive) setLoadingExisting(false); } })();
    return () => { alive = false; };
  }, [packId]);

  // Normalize a sentence for comparison: lowercase, blank/tokens collapsed, whitespace/punct trimmed.
  const normSentence = (t) => (t || "").toLowerCase().replace(/\{blank\}/g, "▢").replace(/\{[a-zA-Z][\w-]*\}/g, "▢").replace(/[^a-z0-9▢]+/g, " ").trim();
  const existingIndex = useMemo(() => {
    const bySentence = new Map(); const byAnswer = new Map();
    for (const q of existing) {
      const ns = normSentence(q.template);
      if (!bySentence.has(ns)) bySentence.set(ns, []);
      bySentence.get(ns).push(q);
      for (const a of [q.answer, q.alt_answer].filter(Boolean)) {
        const k = a.toUpperCase(); if (!byAnswer.has(k)) byAnswer.set(k, []); byAnswer.get(k).push(q);
      }
    }
    return { bySentence, byAnswer };
  }, [existing]);

  const parsed = useMemo(() => {
    const txt = raw.trim();
    let rows = [];
    if (!txt) return [];
    if (txt.startsWith("[") || txt.startsWith("{")) {
      try {
        const j = JSON.parse(txt);
        const arr = Array.isArray(j) ? j : (j.questions || []);
        rows = arr.map(o => ({
          template: o.template || "", answer: (o.answer || "").toUpperCase(),
          alt_answer: (o.alt_answer || o.alt || "").toUpperCase(),
          frame_slots: sanitizeFrameSlots(o.frame_slots),
          ok: (o.template || "").includes("{blank}") && !!o.answer,
        }));
      } catch { return [{ template: "Invalid JSON", answer: "", alt_answer: "", ok: false, dup: "none" }]; }
    } else {
      rows = txt.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
        const [t, a, alt] = line.split("|").map(s => (s || "").trim());
        return { template: t || "", answer: (a || "").toUpperCase(), alt_answer: (alt || "").toUpperCase(), ok: (t || "").includes("{blank}") && !!a };
      });
    }
    // Tag duplicates: exact = same sentence shape AND same answer word; near = same sentence OR same answer.
    const seenInBatch = new Set();
    return rows.map(r => {
      if (!r.ok) return { ...r, dup: "none" };
      const ns = normSentence(r.template);
      const ans = (r.answer || "").toUpperCase();
      const sentenceHits = existingIndex.bySentence.get(ns) || [];
      const answerHits = existingIndex.byAnswer.get(ans) || [];
      const exactExisting = sentenceHits.some(q => (q.answer || "").toUpperCase() === ans || (q.alt_answer || "").toUpperCase() === ans);
      const batchKey = ns + "|" + ans;
      const inBatchDup = seenInBatch.has(batchKey);
      seenInBatch.add(batchKey);
      let dup = "none";
      if (exactExisting || inBatchDup) dup = "exact";
      else if (sentenceHits.length || answerHits.length) dup = "near";
      return { ...r, dup, dupInfo: dup === "exact" ? (inBatchDup ? "duplicate within this batch" : "already in this pack") : (sentenceHits.length ? "same sentence exists" : "answer word already used") };
    });
  }, [raw, existingIndex]);

  // Default skip: exact duplicates are skipped unless the user un-skips them.
  useEffect(() => {
    setSkipIds(prev => {
      const next = new Set(prev);
      parsed.forEach((p, i) => { if (!userTouched.has(i)) { if (p.dup === "exact") next.add(i); else next.delete(i); } });
      return next;
    });
  }, [parsed, userTouched]);

  const toggleSkip = (i) => { setUserTouched(t => new Set(t).add(i)); setSkipIds(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); };

  const valid = parsed.filter(p => p.ok);
  const toImport = parsed.filter((p, i) => p.ok && !skipIds.has(i));
  const exactCount = parsed.filter(p => p.dup === "exact").length;
  const nearCount = parsed.filter(p => p.dup === "near").length;

  const submit = async () => {
    if (!toImport.length) { setErr("Nothing selected to import."); return; }
    setBusy(true); setErr("");
    try {
      // Imported questions inherit the pack's level (level=null). The level system drives
      // rendering — there are no per-question difficulty/letters fields.
      await onDone(toImport.map((v, i) => ({ pack_id: packId, template: v.template, answer: v.answer, alt_answer: v.alt_answer, status: "active", sort_order: 100 + i, ...(v.frame_slots ? { frame_slots: v.frame_slots } : {}) })));
      onClose();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const dupStyle = { exact: { fg: C.danger, label: "Duplicate" }, near: { fg: C.warn, label: "Similar" }, none: null };

  return (
    <>
      <ModalHead title="Bulk import questions" subtitle="Paste pipe-format lines or a JSON array" id="pm-imp-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.md + 2 }}>
        <div style={{ fontSize: 12.5, color: C.sub, background: C.lineSoft, padding: "8px 12px", borderRadius: R.sm, lineHeight: 1.5 }}>
          <b>Pipe:</b> <code>Sentence with {"{blank}"} | ANSWER | ALT</code><br />
          <b>JSON:</b> <code>{'[{"template":"…{blank}…","answer":"BRAVE","alt_answer":"BOLD"}]'}</code>
        </div>
        <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} autoFocus placeholder={"I am {blank} when I try something new. | BRAVE | BOLD\nBeing {blank} helps me make friends. | KIND | CARING"} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
        {raw.trim() && (
          <div style={{ background: C.bg, borderRadius: R.md, padding: S.md + 2, maxHeight: 260, overflowY: "auto" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span>{toImport.length} to import · {valid.length - toImport.length} skipped · {parsed.length - valid.length} invalid</span>
              {loadingExisting ? <span style={{ color: C.faint }}>● checking for duplicates…</span> : <>
                {exactCount > 0 && <span style={{ color: C.danger }}>● {exactCount} duplicate{exactCount === 1 ? "" : "s"}</span>}
                {nearCount > 0 && <span style={{ color: C.warn }}>● {nearCount} similar</span>}
              </>}
            </div>
            {parsed.map((p, i) => {
              const ds = dupStyle[p.dup];
              const skipped = skipIds.has(i);
              return (
                <div key={i} style={{ fontSize: 13, padding: "6px 0", color: !p.ok ? C.faint : skipped ? C.faint : C.ink, display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid " + C.line, opacity: skipped ? 0.6 : 1 }}>
                  <span style={{ color: p.ok ? C.good : C.danger, fontWeight: 800 }}>{p.ok ? "✓" : "✕"}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: skipped ? "line-through" : "none" }}>{p.template.replace(/\{blank\}/g, "___").replace(/\{([a-zA-Z][\w-]*)\}/g, "$1") || <em>empty</em>}</span>
                  {p.ok && <span style={{ color: C.brandInk, fontWeight: 700, fontSize: 12 }}>{[p.answer, p.alt_answer].filter(Boolean).join(" / ")}</span>}
                  {ds && <span title={p.dupInfo} style={{ color: ds.fg, fontWeight: 700, fontSize: 11, padding: "1px 7px", borderRadius: R.pill, border: "1px solid " + ds.fg + "66", whiteSpace: "nowrap" }}>{ds.label}</span>}
                  {p.ok && p.dup !== "none" && (
                    <button type="button" onClick={() => toggleSkip(i)} style={{ background: "none", border: "1px solid " + C.line, borderRadius: R.sm, padding: "2px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", color: C.sub, whiteSpace: "nowrap" }}>
                      {skipped ? "Keep" : "Skip"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {err && <ErrorState error={err} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || !toImport.length || loadingExisting}>{busy ? "Importing…" : loadingExisting ? "Checking…" : `Import ${toImport.length} question${toImport.length === 1 ? "" : "s"}`}</Btn>
      </ModalFoot>
    </>
  );
}

// ===== features.jsx =====
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
  const issueLabel = { invalid_template: "Invalid template", missing_alt: "Missing 2nd option", duplicate: "Duplicate", revealed_answer: "Answer revealed", empty_answer: "Empty answer" };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Content health</h1>
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Automated checks across your whole library.</p>
      </div>
      <div className="pm-stats" style={{ marginBottom: S.lg }}>
        <HealthStat n={loading ? "…" : totalIssues} label="Total issues" color={totalIssues ? C.warn : C.good} />
        <HealthStat n={loading ? "…" : (s.invalid_template || 0)} label="Invalid templates" color={s.invalid_template ? C.danger : C.faint} />
        <HealthStat n={loading ? "…" : (s.missing_alt || 0)} label="Missing 2nd option" color={s.missing_alt ? C.warn : C.faint} />
        <HealthStat n={loading ? "…" : (s.duplicates || 0)} label="Duplicates" color={s.duplicates ? C.warn : C.faint} />
      </div>
      {loading ? <div style={{ display: "grid", gap: 10 }}>{[0,1,2].map(i => <Skeleton key={i} h={56} r={12} />)}</div>
        : totalIssues === 0 ? <EmptyState icon="✅" title="Everything looks healthy" body="No invalid templates, missing options, or duplicates found. Nice work." />
        : (
          <div style={{ display: "grid", gap: 10 }}>
            {details.map((d, idx) => {
              const sev = sevStyle[d.severity] || sevStyle.warning;
              return (
                <div key={idx} style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.md, padding: "14px 16px", display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: sev.dot, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{d.label || "(untitled)"} <span style={{ fontSize: 12, fontWeight: 600, color: sev.fg, background: sev.bg, padding: "1px 7px", borderRadius: 5, marginLeft: 6 }}>{issueLabel[d.issue] || d.issue}</span></div>
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
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>A running history of every change.</p>
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

// ===== publish1.jsx =====
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

// ===== firebase2.jsx =====
// ============================================================
// Firebase Target Editor
// ============================================================
function FirebaseTargetEditor({ target, profiles, sampleContent, onSave, onClose }) {
  const isNew = !target?.id;
  const [name, setName] = useState(target?.name || "Firebase");
  const [profileId, setProfileId] = useState(target?.profile_id || profiles[0]?.id || "");
  const [cfg, setCfg] = useState(target?.config || { mode: "rtdb", layout: "per-pack", packPath: "packs/{slug}", questionPath: "questions/{id}", singlePath: "content/all" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [testMsg, setTestMsg] = useState(null);
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  const profile = profiles.find(p => p.id === profileId);

  // preview the planned writes (paths only, with sample data)
  const plan = useMemo(() => {
    if (!profile || !sampleContent.packs.length) return [];
    try {
      const spec = { ...profile.spec, __name: profile.name };
      const ops = planWrites(cfg, sampleContent.packs.slice(0, 3), sampleContent.byPack, buildOutput, spec);
      return ops.slice(0, 6);
    } catch { return []; }
  }, [cfg, profile, sampleContent]);

  const submit = async () => {
    if (!profileId) { setErr("Choose an export profile."); return; }
    setBusy(true); setErr("");
    try { await onSave({ name, channel: "firebase", profile_id: profileId, config: cfg }, target?.id); onClose(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  const test = async () => {
    setTestMsg({ kind: "info", text: "Testing connection…" });
    try {
      if (cfg.mode === "rtdb") {
        if (!cfg.rtdbUrl) throw new Error("Enter the Realtime DB URL first");
        const base = cfg.rtdbUrl.replace(/\/$/, "");
        const auth = cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : "";
        const res = await fetch(`${base}/.settings/rules.json${auth}`).catch(() => null);
        // a reachable RTDB returns 200 or 401/403; anything is "reachable"
        setTestMsg(res ? { kind: "success", text: `Reached Realtime DB (HTTP ${res.status}). Ready to write.` } : { kind: "error", text: "Could not reach that URL." });
      } else if (cfg.mode === "firestore") {
        if (!cfg.projectId) throw new Error("Enter the Firestore project ID first");
        setTestMsg({ kind: "success", text: `Firestore target set for project “${cfg.projectId}”. A real write will confirm access.` });
      } else {
        if (!cfg.fnUrl) throw new Error("Enter the Cloud Function URL first");
        setTestMsg({ kind: "success", text: "Cloud Function URL set. Push will POST there." });
      }
    } catch (e) { setTestMsg({ kind: "error", text: e.message }); }
  };

  return (
    <>
      <ModalHead emoji="🔥" title={isNew ? "New Firebase target" : "Edit Firebase target"} subtitle="Configure how content writes into Firebase" />
      <div style={{ padding: S.xl, display: "grid", gap: S.lg, maxHeight: "62vh", overflowY: "auto" }}>
        <div className="pm-form-2">
          <Field label="Target name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Export profile" hint="Which format to send">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Firebase database & write method">
          <div style={{ display: "grid", gap: 8 }}>
            {[["rtdb", "Realtime Database (REST)", "Direct writes from the CMS. Only needs the database URL + secret. Works today."],
              ["firestore", "Firestore (REST)", "Direct writes via Firestore REST. Needs project ID + an API key or token."],
              ["cloudfn", "Cloud Function (POST)", "CMS posts the payload to your Firebase Function, which writes with the Admin SDK. Most secure."]].map(([v, l, d]) => (
              <label key={v} style={{ display: "flex", gap: 11, alignItems: "flex-start", padding: 11, borderRadius: R.md, border: "1px solid " + (cfg.mode === v ? C.brand : C.line), background: cfg.mode === v ? C.brandSoft : C.panel, cursor: "pointer" }}>
                <input type="radio" checked={cfg.mode === v} onChange={() => set("mode", v)} style={{ marginTop: 2, accentColor: C.brand }} />
                <div><div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{l}</div><div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>{d}</div></div>
              </label>
            ))}
          </div>
        </Field>

        {/* mode-specific credentials */}
        {cfg.mode === "rtdb" && (
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Realtime Database URL" hint="From Firebase console → Realtime Database"><Input value={cfg.rtdbUrl || ""} onChange={(e) => set("rtdbUrl", e.target.value)} placeholder="https://your-app-default-rtdb.firebaseio.com" /></Field>
            <Field label="Database secret / auth token" hint="Optional if rules allow writes; else a DB secret or ID token"><Input type="password" value={cfg.secret || ""} onChange={(e) => set("secret", e.target.value)} placeholder="secret or token" /></Field>
          </div>
        )}
        {cfg.mode === "firestore" && (
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Firestore project ID"><Input value={cfg.projectId || ""} onChange={(e) => set("projectId", e.target.value)} placeholder="my-game-project" /></Field>
            <div className="pm-form-2">
              <Field label="Web API key" hint="Optional"><Input value={cfg.apiKey || ""} onChange={(e) => set("apiKey", e.target.value)} placeholder="AIza…" /></Field>
              <Field label="Bearer token" hint="Optional OAuth/ID token"><Input type="password" value={cfg.bearer || ""} onChange={(e) => set("bearer", e.target.value)} placeholder="ya29.…" /></Field>
            </div>
          </div>
        )}
        {cfg.mode === "cloudfn" && (
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Cloud Function URL"><Input value={cfg.fnUrl || ""} onChange={(e) => set("fnUrl", e.target.value)} placeholder="https://us-central1-you.cloudfunctions.net/ingestContent" /></Field>
            <div className="pm-form-2">
              <Field label="Auth header name" hint="Optional"><Input value={cfg.header || ""} onChange={(e) => set("header", e.target.value)} placeholder="Authorization" /></Field>
              <Field label="Auth value / secret" hint="Optional"><Input type="password" value={cfg.secret || ""} onChange={(e) => set("secret", e.target.value)} placeholder="Bearer …" /></Field>
            </div>
            <div style={{ fontSize: 12, color: C.infoSoft ? C.sub : C.sub, background: C.infoSoft, padding: "10px 12px", borderRadius: R.sm }}>
              Your function receives <code>{`{ writes: [{path,data}], payload }`}</code>. A ready-to-deploy sample function is in the docs button below.
            </div>
          </div>
        )}

        {/* layout (skip for cloudfn since the function decides) */}
        {cfg.mode !== "cloudfn" && (
          <Field label="Content layout" hint="Where documents/nodes are written. {slug} and {id} are placeholders.">
            <Select value={cfg.layout || "per-pack"} onChange={(e) => set("layout", e.target.value)} style={{ marginBottom: 8 }}>
              <option value="per-pack">One document per pack</option>
              <option value="per-question">One document per question</option>
              <option value="single-doc">Single document holding everything</option>
            </Select>
            {cfg.layout === "per-pack" && <Input value={cfg.packPath || "packs/{slug}"} onChange={(e) => set("packPath", e.target.value)} placeholder="packs/{slug}" style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }} />}
            {cfg.layout === "per-question" && <Input value={cfg.questionPath || "questions/{id}"} onChange={(e) => set("questionPath", e.target.value)} placeholder="questions/{id}" style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }} />}
            {cfg.layout === "single-doc" && <Input value={cfg.singlePath || "content/all"} onChange={(e) => set("singlePath", e.target.value)} placeholder="content/all" style={{ fontFamily: "ui-monospace,monospace", fontSize: 13 }} />}
          </Field>
        )}

        {/* write plan preview */}
        {cfg.mode !== "cloudfn" && plan.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.ink2, letterSpacing: 0.3, marginBottom: 8, textTransform: "uppercase" }}>Write plan (sample)</div>
            <div style={{ background: C.bg, borderRadius: R.md, padding: 12, display: "grid", gap: 5 }}>
              {plan.map((op, i) => (
                <div key={i} style={{ fontSize: 12.5, fontFamily: "ui-monospace,monospace", color: C.ink2, display: "flex", gap: 8 }}>
                  <span style={{ color: C.brand, fontWeight: 700 }}>PUT</span>
                  <span style={{ color: C.faint }}>{cfg.mode === "firestore" ? "firestore:" : "rtdb:"}</span>
                  <span>{op.path}</span>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: C.faint, marginTop: 4 }}>…one write per {cfg.layout === "single-doc" ? "everything" : cfg.layout === "per-question" ? "question" : "pack"}.</div>
            </div>
          </div>
        )}

        {testMsg && <div style={{ fontSize: 13, fontWeight: 600, padding: "10px 14px", borderRadius: R.md, background: testMsg.kind === "error" ? C.dangerSoft : testMsg.kind === "success" ? C.goodSoft : C.infoSoft, color: testMsg.kind === "error" ? C.dangerInk : testMsg.kind === "success" ? C.goodInk : C.ink2 }}>{testMsg.text}</div>}
        {err && <ErrorState error={err} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="soft" onClick={test}>Test connection</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Create target" : "Save target"}</Btn>
      </ModalFoot>
    </>
  );
}

// Sample Cloud Function docs modal
function CloudFnDocs({ onClose }) {
  const code = `// Firebase Cloud Function — receives content from the CMS.
// Deploy with: firebase deploy --only functions:ingestContent
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.ingestContent = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods", "POST"); return res.status(204).send(""); }

  // OPTIONAL: check a shared secret
  // if (req.get("Authorization") !== "Bearer YOUR_SECRET") return res.status(401).send("no");

  const { writes } = req.body; // [{ path, data }]
  const db = admin.firestore();          // or admin.database() for RTDB
  const batch = db.batch();
  for (const w of writes) {
    const parts = w.path.split("/").filter(Boolean);
    const id = parts.pop();
    const col = parts.join("/") || "content";
    batch.set(db.collection(col).doc(id), w.data, { merge: true });
  }
  await batch.commit();
  res.json({ ok: true, written: writes.length });
});`;
  const copy = () => navigator.clipboard?.writeText(code);
  return (
    <>
      <ModalHead emoji="⚡" title="Sample Firebase Cloud Function" subtitle="Deploy this, then point the target's URL at it" />
      <div style={{ padding: S.xl }}>
        <pre style={{ background: C.bgDeep, borderRadius: R.md, padding: 16, fontSize: 12, lineHeight: 1.55, overflowX: "auto", color: C.ink2, margin: 0, maxHeight: 400, fontFamily: "ui-monospace,monospace" }}>{code}</pre>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
        <Btn onClick={copy} icon="⧉">Copy code</Btn>
      </ModalFoot>
    </>
  );
}

// ===== publish2.jsx =====
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
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Shape content with profiles, then sync to the game via file, feed, or push.</p>
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

function ChannelsPanel({ profiles }) {
  const [cfg, setCfg] = useState(getPushCfg());
  const [mode, setMode] = useState(cfg.mode || "manual");
  const save = (next) => { const merged = { ...cfg, ...next }; setCfg(merged); setPushCfg(merged); };

  return (
    <div style={{ display: "grid", gap: S.lg }}>
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

// ===== devdocs.jsx =====
// ============================================================
// Developer Notes — embedded reference documents.
// These are hardcoded so they always ship with the build.
// ============================================================

const DOC_ARCHITECTURE = `# Positive Minds CMS — Site Architecture & Structure

## 1. What this is
A content management system for the **Positive Minds** children's word game
(CBMT — Cognitive Bias Modification Therapy). The game is a SPELLING puzzle: it shows a
short, warm first-person sentence with one word partly hidden — some letters revealed, the
rest shown as blanks (e.g. "I feel PR_UD of the things I do") — and the child chooses between
two positive words. BOTH words are positive (there is never a negative option — the
therapeutic core), and the child's job is to pick the one whose SPELLING fits the revealed
letters + blank shape. The primary word (\`answer\`) spells into the pattern; the alternate
(\`alt_answer\`) is another genuinely-positive word that does NOT fit that letter pattern
(easiest to guarantee when it's a different length, so it can never match the fixed blanks).
It is NOT a meaning/comprehension test — both words can make sense in the sentence; the
LETTERS decide. How much of the word is hidden is controlled by the question's level. This
CMS is the **authoring source of truth**:
content is created, organized, reviewed, and version-tracked here, then published to
a separate game backend through a customizable, multi-channel sync pipeline.

The CMS is a **content production + publishing layer**, not the game's live database.

## 2. Tech stack
- **Frontend:** React 18.3.1 (single self-contained \`index.html\`, no runtime build step).
  JSX is **pre-compiled to plain JS** via Babel *classic* runtime (React.createElement) —
  NOT the automatic/dev runtime (which emits \`import jsxDEV\` and breaks a plain <script>).
- **No in-browser Babel.** React + ReactDOM load from unpkg (pinned to 18.3.1 UMD).
- **Backend:** Supabase (Postgres + PostgREST + Edge Functions + Auth).
  Project ref: \`tytrmjjucqijzcrbwjfm\`.
- **Hosting:** Cloudflare (Worker) at \`positive-minds-cms.<subdomain>.workers.dev\`,
  auto-deploying from GitHub \`main\` via Cloudflare's Git integration.
- **Repo:** GitHub \`alcharles1980-design/positive-minds-cms\` (private).
- **Styling:** inline styles + a small CSS-variable theme system (light/dark). No CSS framework.

## 3. Source layout (authoring → build)
The app is authored as modular \`.jsx\` files in \`/v2/\`, then concatenated and compiled
into one file. **Assembly order matters** (const helpers must precede their consumers;
all cross-file components are \`function\` declarations so they hoist):

    core.jsx        config (incl CFG.build stamp), session/auth, data layer (rest/rpc/restAll),
                    tokens, hooks, AND the shared rendering engine (maskWord, resolveSlots,
                    resolveFrameMap, buildLevelVariants, previewAtLevel)
    primitives.jsx  Btn, Badge, Pill, Field, inputs, Modal, Confirm, Toasts, states
    realtime.jsx    lean realtime sync (raw websocket, no SDK): connect/reconnect + useRealtime hooks
    engine.jsx      transformation engine (buildOutput), profiles/sync/targets data, fetchAllContent
    firebase.jsx    Firebase transport (RTDB/Firestore/CloudFn writers), planWrites
    editors.jsx     PackEditor, QuestionEditor, FrameSlotEditor, BulkImport (with duplicate detection)
    features.jsx    CommandPalette, PlayMode, HealthView, ActivityView, TagInput, ThemeToggle
    publish1.jsx    ProfileBuilder (visual + JSON + preview), ValueMapEditor, FieldMapRow
    firebase2.jsx   FirebaseTargetEditor, CloudFnDocs
    publish2.jsx    PublishHub, ChannelsPanel, SyncHistory, FeedRow
    devdocs.jsx     the three embedded docs as template-literal strings (this Architecture doc, CLAUDE.md, Build Prompt)
    devnotes.jsx    Developer Notes page — renders the three docs + an editable scratchpad
    generator.jsx   Content Generator (AI prompt builder): GeneratorView, buildGeneratorPrompt, buildAvoidList, OUTPUT_FORMATS, MASTER_CONTEXT
    levels.jsx      LevelsView, LevelEditor, LevelChip, QuestionLevelsPanel, QuestionLevelEditor (the 10-level UI + per-question level overrides)
    views1.jsx      Dashboard, Library, PackCard
    views2.jsx      PackDetail, AllQuestions, Pager
    shell.jsx       Login, ChangePassword, CloneDialog, App (nav/routing/state), GlobalStyle

Build pipeline (\`/v2/\`):
- \`assemble.cjs\` — strips React imports, converts \`export default function App\`→\`function App\`,
  concatenates in order, adds React globals + mount, compiles via @babel/preset-react
  (runtime: classic, development: false) → \`app.compiled.js\`.
- \`build_html.cjs\` — wraps compiled JS in the HTML shell (unpkg React, PWA manifest+SW,
  CDN-failure fallback, viewport-fit=cover) → \`index.html\`.
- Final outputs copied to \`/repo/\` (git) and pushed; Cloudflare auto-builds.

## 4. Architecture layers (in the app)
config → data layer → design tokens → hooks → primitives → feature views → app shell.

- **Data layer (core.jsx):** the \`db\` object is the ONLY place features touch data.
  \`rest()\` and \`rpc()\` wrap PostgREST; both auto-refresh the auth token and retry once
  on 401, then drop to login if refresh fails (via \`authEvents\`). \`restAll()\` paginates
  in 1000-row batches to defeat the PostgREST cap.
- **Live sync (realtime.jsx):** a lean websocket client subscribes to postgres_changes on
  the UI tables; \`useRealtimeRefresh(tables, cb)\` debounce-refreshes affected lists. Any
  table a feature reads and expects to stay live must be in the Realtime publication AND in
  realtime.jsx's TABLES list. On background token refresh, call \`realtime.updateToken()\`.
- **Design tokens:** \`C\` (colors, as CSS variables), \`S\` (spacing), \`R\` (radius),
  \`SH\` (shadows), \`FONT\`. Colors resolve to \`var(--name)\`; \`THEMES\` holds the light/dark
  values injected by GlobalStyle. \`data-theme\` on <html> flips the palette instantly.
  All text colors are WCAG-checked: 'faint' is #726E88 light / #8A87A3 dark (≥4.5 on
  their backgrounds). Inputs use the panel token (never hardcoded white — that broke dark
  mode), 1.5px borders, and an explicit ::placeholder color (the 'sub' token) so search
  fields stay legible while typing.
- **Hooks:** useBreakpoint (phone<640/tablet 640–1024/desktop>1024), useAsync,
  useHotkey, useFocusTrap, useDebounced, useTheme; toast bus (notify), confirm bus.

## 5. Data model (Supabase, all with RLS)
**Tables:**
- \`pm_packs\` — id, slug (unique), name, emoji, description, color, difficulty
  (basic/advanced/mixed), status (draft/published/archived), sort_order, is_custom,
  tags text[], content_version, released_version, released_at, level, and structured
  descriptive fields: purpose, focus_areas, style_approach, example_objectives. timestamps.
- \`pm_questions\` — id, pack_id (FK cascade), template (with \`{blank}\` for the target, plus
  optional \`{token}\` frame-word slots), answer, alt_answer, status (active/inactive),
  sort_order, notes, level (nullable = inherit pack), letter_position, letter_grouping,
  frame_slots (jsonb: per-token {pool, byLevel}), timestamps. (There are NO per-question
  difficulty or letters_hidden columns — the old derived-legacy ones were dropped; rendering
  is driven entirely by the level + any pm_question_levels overrides.)
- \`pm_activity\` — audit log: entity, entity_id, entity_name, action, actor, detail, created_at.
- \`pm_export_profiles\` — id, name, description, spec (jsonb transform config), is_builtin.
- \`pm_sync_log\` — profile/target/channel/mode/status/counts/detail, created_at.
- \`pm_sync_targets\` — id, name, channel, profile_id, config (jsonb), enabled.
- \`pm_dev_notes\` — singleton row (id=1) holding the editable Developer-Notes scratchpad.
- \`pm_deletions\` — deletion tombstones for incremental sync (a "changed since" query can't see
  rows that no longer exist). Columns: id, entity_type ('pack'|'question'), entity_id, pack_id,
  slug, deleted_at. Written ONLY by SECURITY DEFINER triggers — trg_tombstone_pack/
  trg_tombstone_question (before DELETE) AND trg_pack_status_tombstone/
  trg_question_status_tombstone (after status change: leaving published/active writes a
  tombstone, re-entering clears it). anon/authenticated may SELECT, nobody may write directly.
  Consumed by the content-api's \`?since=\` deletions array.
- \`pm_levels\` — the game's progression structure (levels 1–100, editable; ships with 1–10
  but you can add more above the top): level (PK, CHECK 1..100), name, tagline, letters_rule,
  word_rule, theme, age_hint, hidden_mode (letters/word), letters_hidden_default,
  letter_position (start/middle/end/random), letter_grouping (grouped/spread), color, sort_order,
  plus VOCABULARY-RULE columns that shape which ANSWER words a level uses (they drive the
  generator + show intent; the masking engine ignores them): min_word_len (int, nullable),
  max_word_len (int, nullable), allow_multiword (bool, default false), vocab_rule (free text).
  CHECK pm_levels_wordlen_band ensures min<=max when both set. The LEVEL NUMBER is the difficulty
  — no separate basic/advanced tier (removed as redundant). Packs have a \`level\` (default);
  questions have nullable \`level\`, \`letter_position\`, \`letter_grouping\` (null = inherit).
  The blank SHAPE is computed by maskWord(word, letters, position, grouping) and the effective
  settings resolve question-override → level-default (via buildLevelVariants). Adding a level row
  is enough for it to render everywhere (CMS previews + both feeds) — nothing is pre-materialized.
  pm_questions.level and pm_question_levels.level share the same 1..100 CHECK.
- \`pm_question_levels\` — per-question, per-level OVERRIDES. Every question is a single
  "concept" that auto-renders every level (buildLevelVariants derives each level's blank
  from the question + the level rules). A row exists here ONLY when a specific level's
  version was hand-edited (override template/answer/alt_answer/letters_hidden/letter_position/
  letter_grouping, or \`enabled=false\` to hide that level). In the question bank, each row has
  a "Levels" expand toggle showing all 10 variants.

**View:** \`pm_pack_overview\` — packs + active_questions + total_questions +
has_pending_changes (= content_version > released_version). MUST be created with
\`security_invoker = true\` so it respects the caller's RLS — otherwise anon can read
draft/unpublished packs through the public API. Because it uses \`p.*\`, adding a column to
pm_packs shifts positions — DROP+recreate, never CREATE OR REPLACE.

**Realtime:** publication \`supabase_realtime\` includes pm_packs, pm_questions, pm_levels,
pm_question_levels, pm_export_profiles, pm_sync_targets, pm_activity. pm_questions and
pm_question_levels are set to REPLICA IDENTITY FULL so realtime DELETE events carry the full
old row (pack_id / question_id) — otherwise the client can't route a delete to the right pack.

**Triggers:** \`pm_touch_updated_at\` (updated_at maintenance); \`pm_bump_pack_version\`
(bumps pack content_version on any question insert/update/delete).

**Functions (RPC):** (all SECURITY INVOKER — they respect the caller's RLS; anon EXECUTE
was revoked on the admin/write ones, so these are authenticated-only in practice)
- \`pm_dashboard_stats()\` — aggregate counts for the Overview: total/published/draft packs,
  total/active questions, distinct_levels_used (how many of the 10 levels have questions),
  questions_by_level (a {level: count} map for the distribution), empty_packs, and
  avg_questions_per_pack. No tier/difficulty counts (those concepts were removed).
- \`pm_search_questions(q,pack,stat,lvl,lim,off,from_date,to_date,sort)\` — global paginated
  question search. Returns the effective level + resolved letter_position/letter_grouping +
  frame_slots + created_at/updated_at. from_date/to_date filter by created_at (a [from, to)
  window); sort = 'recent' | 'oldest' | null (default keeps pack order).
- \`pm_clone_pack(src,new_slug,new_name)\` — duplicate a pack + its questions (as draft).
- \`pm_lint()\` / \`pm_lint_details()\` — content health checks (invalid templates,
  missing 2nd option, duplicates, thin packs, revealed answer [the effective LEVEL hides 0
  letters], empty answer).
- \`pm_log(...)\` — append an activity row.
- \`pm_mark_released(pack_ids uuid[])\` — set released_version = content_version
  (null = all published) so "pending changes" clears after a sync.
- \`pm_content_manifest()\` — (SECURITY DEFINER, published-only) the lightweight sync manifest
  for the content-api: global_version (epoch of newest change across packs/questions/levels +
  deletions), levels_version, pack_count, question_count, and per-pack version rows. Lets a
  client check what changed without transferring content.
- Tombstone triggers \`pm_tombstone_pack\` / \`pm_tombstone_question\` (SECURITY DEFINER,
  before-delete) write to pm_deletions so incremental sync can report removals. Companion
  status-transition triggers \`pm_pack_status_tombstone\` / \`pm_question_status_tombstone\`
  (SECURITY DEFINER, after UPDATE OF status) handle the softer case: a pack leaving 'published'
  (or a question leaving 'active') writes a tombstone AND advances global_version, while
  re-entering the live set deletes the stale tombstone so a resync doesn't both add and remove
  it. Without these, unpublishing/deactivating would be invisible to sync (the manifest's
  global_version is computed only over published/active rows).

**RLS model:** anon = READ-ONLY (published/active content, profiles, logs, targets, notes);
authenticated = full write. Anon write policies were dropped and the lockdown verified.

## 6. Auth
Single shared admin password. Auth user \`admin@positiveminds.app\` in Supabase Auth.
Login uses the password grant → access + refresh tokens stored in localStorage (persists
across tab/browser restarts) with a 7-day window from login. The access token is refreshed
proactively in the background (timer + on tab refocus) and reactively on a 401, so the user
stays signed in until they log out or the 7 days elapse.
Writes send the access token as Bearer. Tokens expire ~1hr; the data layer refreshes
transparently. Sign-out + change-password built in. Anon (publishable) key is safe to
embed publicly and authorizes only reads.

## 7. The transformation engine (customizable output)
Content lives in a stable internal shape; **export profiles** project it into whatever
a consumer needs. A profile's \`spec\` (jsonb) describes:
- \`structure\`: "nested" (packs with questions) | "flat" (one question array) | "keyed" (dict by slug)
- \`root_key\`, \`questions_key\`, \`key_by\`
- \`include_meta\` (envelope with counts/timestamp)
- \`filters\`: { status, question_status }
- \`pack_fields\` / \`question_fields\`: [{ from, to, transform }] — rename + include/exclude
  + per-field transform (none/upper/lower/trim)
- \`value_maps\`: { outputField: { fromValue: toValue } } — e.g. status:active → state:1

\`buildOutput(spec, packs, byPack, keyField)\` runs the projection; \`withMeta\` adds the
envelope. The engine exists in TWO places that MUST stay in sync: the client (engine.jsx)
and the \`game-feed\` edge function (server-side mirror).

Four seeded starter profiles: **Firebase (nested)**, **Flat API (question list)**,
**Unity (keyed dictionary)** — all now include the real \`effective_level\` — and
**Full game export (with levels)**, which turns on \`expand_levels\` to emit the complete
10-level structure per question (the reference profile to point the game at).
Output is available as JSON or XML: the file download offers both buttons, and the
game-feed accepts \`?format=xml\` (mirrored toXml on client + edge).

## 7b. Sync API for external backends (content-api edge function)
A dedicated \`content-api\` edge function (separate from game-feed; verify_jwt=false) is the
full sync API for an external backend (e.g. Firebase) to pull content on demand. One clean,
well-designed shape (NOT the profile-projection system) plus everything needed to sync efficiently:
- \`?manifest=1\` — lightweight version manifest: global_version (epoch of the newest change
  anywhere, incl. deletions), levels_version, per-pack {slug, content_version, active_questions,
  version}. A client polls this and only pulls content when global_version changed.
- (default) — full published content: levels (definitions/rules — including the vocabulary-rule
  fields min_word_len/max_word_len/allow_multiword/vocab_rule) + packs, each with its questions,
  each question carrying its 10 rendered level-variations (same engine as game-feed).
- \`?since=<iso|epoch>\` — INCREMENTAL: only packs that changed (a pack counts as changed if it OR
  any of its questions changed since the cursor; returns that pack's full current question set for a
  wholesale replace) PLUS a \`deletions\` array (from pm_deletions) so the client knows what to remove.
- \`?packs=slug1,slug2\` and \`?levels=1,2,3\` — filter the payload.
- \`?format=xml\` — XML instead of JSON. \`?health=1\` — liveness.
- ETag on every response (hash of global_version + the exact query shape); \`If-None-Match\` →
  304 Not Modified. The match is tolerant of the platform's weak-validator \`W/\` prefix.
- Optional auth: set the CONTENT_API_KEY secret to require a key (X-API-Key header or ?key=);
  unset = public. Works both server-to-server and from the client (CORS *).
Backed by the \`pm_content_manifest()\` RPC (SECURITY DEFINER, published-only) and the pm_deletions
tombstone table. Source lives in the repo at edge-functions/content-api.ts.

## 8. Publishing channels
All emit through a chosen profile:
- **File** — download the transformed JSON bundle.
- **Feed (pull):** \`game-feed\` edge function serves content at a stable URL per profile.
  Endpoints: \`?profile=<name|uuid>\`, \`?list=1\`, \`?health=1\`. verify_jwt disabled;
  pages past 1000 rows; ~60s cache.
- **Push:** POST the payload to a configurable target (Channels tab), CORS permitting.
- **Firebase targets:** saved destinations pairing a profile with a database + layout.
  Modes: Realtime DB (REST direct), Firestore (REST direct w/ typed-value conversion),
  Cloud Function (POST \`{writes,payload}\`). Layouts: per-pack / per-question / single-doc,
  with \`{slug}\`/\`{id}\` path templates. planWrites() builds the op list; fbWriters do the writing.

**Control modes:** manual / auto-on-publish / scheduled (stored in push config).
**Release state:** content_version vs released_version → "pending changes"; a successful
sync calls pm_mark_released to clear it.

## 9. Navigation & views
Sidebar (desktop) / icon rail (tablet) / bottom-tab bar (phone). Routes:
Overview (Dashboard, incl. an at-a-glance one-line index of every pack), Packs (Library),
Questions (AllQuestions global search), Generator (Content Generator — builds a paste-ready
AI prompt), Levels (the 10-level progression structure — view/edit each level's rules),
Health (lint), Publishing (profiles/targets/channels/history), Activity, Developer (three
embedded docs + editable scratchpad).
URL-HASH ROUTING: the current view is encoded in the URL hash (#/questions, #/levels,
#/pack/<id>, empty/#/ = dashboard). On load the app reads location.hash to set the initial
section (so a REFRESH keeps you where you were, and pack URLs are deep-linkable/shareable);
goNav writes the hash; a hashchange listener keeps state in sync so browser Back/Forward and
manual hash edits all work. A pack id from the URL is resolved to the open pack once packs
load (shows the library skeleton in the meantime). The browser tab title also tracks the
current section/pack (document.title).
Command palette (⌘/Ctrl-K): fuzzy nav/actions/theme/jump-to-pack.

## 10. Responsive & PWA
Breakpoints 640 / 1024. Question rows are compact single-lines on desktop and
content-first CARDS below desktop (sentence hero on top, meta+actions footer,
checkbox floated to the corner). 16px inputs (no iOS zoom), bottom-sheet modals on phone,
prefers-reduced-motion respected. Installable PWA (inline manifest blob + service worker
that network-first caches GETs).

## 11. Key gotchas (learned the hard way)
- **PostgREST 1000-row cap:** a big \`limit=\` does NOT defeat it (server max-rows=1000).
  Use \`restAll()\` pagination. Applies to the edge function too.
- **Babel runtime:** must be classic; automatic runtime emits imports that break the <script>.
- **Assembly/hoisting:** cross-file components must be \`function\` declarations; const
  helpers must be defined in a file that loads before consumers.
- **Session expiry:** refresh the token; don't leave the UI "logged in" on 401.
- **Client/server engine parity:** any change to the rendering engine (maskWord, resolveSlots,
  resolveFrameMap, buildLevelVariants) OR the transform engine (buildOutput/projectRow/toXml)
  must be mirrored in the game-feed edge function. Watch the position/grouping PRECEDENCE:
  \`override ?? question.own ?? level.default ?? hard-default\` — must match in both. (A real bug
  lived here: the client gained the question.own step, the edge fn didn't.)
- **View column order:** adding a column to pm_packs shifts \`p.*\` in the view — drop &
  recreate pm_pack_overview rather than CREATE OR REPLACE.
- **PWA service-worker caching:** the deployed app registers an aggressive service worker, so
  after a deploy the browser can keep serving the OLD build — a new feature (e.g. the editor
  preview) looks "missing" when it's actually live. Confirm a change shipped by grepping the
  deployed index.html; tell the user to hard-refresh / clear site data / use incognito. It is
  almost never a code bug when "the thing I just deployed isn't showing".
- **npm prune breaks the build toolchain:** /home/claude/bt has NO lockfile, so a bare
  \`npm install <pkg> --no-save\` PRUNES the "extraneous" @babel packages and silently breaks
  assemble.cjs (which needs @babel/core + @babel/preset-react). Keep a package.json in
  /home/claude/bt pinning @babel/core, @babel/preset-react, react@18.3.1, react-dom@18.3.1 and
  run \`npm install\` (no args) so nothing gets pruned. This package.json lives in the build
  workspace only — it is NOT part of the deployed repo.

## 12. Recent hardening & changes (most recent first)
- **Expandable levels: add new levels above the current top with their own rules, generate/derive
  questions for them, and have them flow through publish/export/both feeds automatically.** Schema:
  raised the level CHECK from 1..20 to 1..100 on pm_levels, pm_questions, and pm_question_levels;
  added vocabulary-rule columns to pm_levels — min_word_len, max_word_len, allow_multiword,
  vocab_rule (free text) — that shape which ANSWER words a level uses (they drive the generator and
  display intent; the masking engine ignores them; CHECK ensures min<=max). Levels page: an "Add
  level N" button creates the next level pre-filled from the current top level's rules via the full
  rule editor (now including the vocab fields), and the top level (highest only) can be deleted to
  keep the ladder contiguous; cards show word-band / multi-word badges. Engine: the shared
  buildLevelVariants already derives every level on demand from pm_levels, so a new level renders
  everywhere (CMS previews + game-feed + content-api) with ZERO per-question work and nothing
  pre-materialized — proven live by creating a real Level 11 (whole-word, spread, 8–14 letter band,
  multiword) and confirming the content-api returned 11 level definitions with the vocab fields and
  BRAVE rendered 11 variations (L11 blank _____), then removing it cleanly. Fixed a latent
  number-based assumption: previewAtLevel's fallback used "level>=7 ⇒ whole word"; now neutral
  (letters) — levels are fully data-driven, never inferred from the number. Generator: the prompt
  now includes each target level's word-length band, multi-word allowance, and vocab_rule, plus a
  reminder that both answers stay in-band yet differ in length, and rule #3 relaxes to allow
  two-word answers when a selected level permits them. Derive: a new "Derive level" pack action
  (DeriveLevelDialog, loads all active questions via db.allQuestionsForPack) materializes editable
  pm_question_levels override rows for a chosen level across the pack — applying that level's masking
  rule to each word, skip-or-overwrite existing, chunked upserts — for when concrete per-question
  rows are wanted to hand-tune. content-api redeployed (v3) to expose the new level fields. All
  three docs updated. NOTE: adding a level is purely additive; the game client must handle however
  many levels the feed reports.
- **Full pre-production audit of the content-api + sync layer; one real bug found and fixed.**
  BUG: unpublishing a pack (published→draft/archived) or deactivating a question (active→inactive)
  was invisible to sync — no tombstone was written (those triggers only fired on hard DELETE), and
  the manifest computes global_version only over published/active rows, so the change could fail to
  advance global_version. A client would keep serving now-unpublished content and never learn to
  remove it. FIX: added SECURITY DEFINER after-UPDATE-OF-status triggers
  (pm_pack_status_tombstone / pm_question_status_tombstone) — leaving the live set writes a
  tombstone (which advances global_version via max(deleted_at) and shows up in ?since deletions);
  re-entering the live set deletes the stale tombstone so a resync doesn't both add and remove the
  item. Verified live: unpublish→global_version advanced + tombstone appeared; republish→
  global_version advanced again + tombstone cleared; original state restored. Everything else
  audited clean: incremental ?since boundary is safe (int cursor floors to before the change, so the
  boundary row is re-sent, never missed); deactivation is covered because a question edit cascades
  to bump the pack's updated_at (verified); RLS empirically enforced (anon cannot read drafts, anon
  INSERT into pm_deletions returns 401 RLS violation, content-api hides drafts); grant posture clean
  (only inert trigger fns are anon-executable, every callable RPC incl. pm_content_manifest is
  authenticated-only); route==menu parity intact (9 nav ids, activity is fallthrough); the 1000-row
  PostgREST cap is handled by restAll pagination; the assemble 'jsxDEV present' warning is the known
  false alarm (only doc-string text, zero real jsxDEV imports/calls; output uses React.createElement);
  all 12 major components render headless. NOTE: pg_net misreports XML Content-Type as text/plain,
  but game-feed (long in production, identical xmlResp) reports the same via pg_net, so this is a
  test-harness artifact, not an API bug — the code sets application/xml. NOTE: pm_deletions grows
  unbounded (pg_cron unavailable on this project to auto-prune); harmless at CMS mutation rates.
- **New content-api edge function: a full sync API for external backends (Firebase).** Separate
  from game-feed; verify_jwt=false. Endpoints: \`?manifest=1\` (version manifest — global +
  per-pack), default (full published content with levels expanded), \`?since=<iso|epoch>\`
  (incremental — only changed packs + a deletions array), \`?packs=\`/\`?levels=\` filters,
  \`?format=xml\`, \`?health=1\`. ETag on every response with \`If-None-Match\`→304 (tolerant of the
  platform's \`W/\` weak-validator prefix — a bug caught and fixed during testing: our bare ETag
  was wrapped as W/"..." so the first 304 attempt returned 200). Optional API-key auth via the
  CONTENT_API_KEY secret (X-API-Key header or ?key=); unset = public. Added the pm_deletions
  tombstone table + before-delete triggers (so deletions are reportable) and the
  pm_content_manifest() RPC (global/per-pack versions). Verified live end-to-end: health, manifest
  (+ETag), full content, 304 on unchanged, incremental since-now returns 0 packs, since-past
  returns changed + deletions, pack filter returns just that pack, and a create→delete→sync cycle
  surfaced the tombstone in the deletions array; BRAVE renders BRA_E→_____ identically to the game
  feed (engine parity preserved across all three consumers). Source: edge-functions/content-api.ts.
- **Full audit pass (no bugs found; one architectural invariant documented).** Rendered all 20
  components (the single "failure" was a wrong-props test artifact — QuestionLevelEditor takes a
  \`variant\` prop, which its real caller passes correctly). Verified: no duplicate component/const
  definitions (the apparent dups were prefix-match false positives — DOC_*, NAV/NAV_PHONE,
  PACK_SOURCE_FIELDS/PACK_TAG_SUGGESTIONS are distinct); no leftover console.log/debugger/TODO in
  shipped code; all RPCs work; only the 2 inert trigger fns are anon-callable; 0 tables without RLS;
  0 dropped columns lingering; client/edge maskWord parity holds (304 cases, 0 mismatches); the live
  game feed renders BRAVE L1 BRA_E → L4 B___E → L10 _____ (confirming earlier live level-sync tests
  were fully reverted — data untouched). Documented a previously-implicit invariant (#4a in
  CLAUDE.md): questions are never pre-rendered — their level-variations are computed on demand
  from pm_levels every render/request, so a level edit propagates live to every inheriting question
  in the CMS and the game; never add a cached per-question variation store.
- **Audit-pass UX fixes on the global Questions page:** (1) the empty-state was misleading — it
  said "Start typing to search…" even when a non-text filter (pack/level/status/date) had matched
  zero, implying nothing was happening; now it's filter-aware ("No questions match these filters"
  vs "No questions yet"). (2) Added a "Clear filters" button that appears whenever any of the six
  filters is active and resets them all — with pack + level + status + date + sort + text it's easy
  to narrow to nothing, so one-click reset matters. Verified via full audit: all 18 components
  render; RLS confirmed live (a draft pack's active question returns [] to the anon API — no leak);
  security posture intact (only the 2 inert trigger fns are anon-callable); client/edge maskWord
  parity holds (504 cases incl. edge-case words, 0 mismatches); game feed renders BRAVE L1→L10; no
  service-role key/PAT in the shipped client (only the safe publishable key).
- **Questions page: added a PACK filter (the one filter it was missing).** The global Questions
  page could filter by text, level, status, when-added, and sort — but not by pack, which made no
  sense for finding a specific pack's questions. Added an "All packs" dropdown (every pack,
  alphabetised, with emoji) wired to the search RPC's existing \`pack\` param — so no backend change
  was needed, just the frontend control + passing the packs list into AllQuestions. Verified the
  RPC discriminates (an empty pack returns 0, Confidence returns 11).
- **Levels page: the rules for each level are now legible at a glance (+ live preview).** The
  cards previously showed only the free-text rule prose; now each card also shows a plain-English
  summary of the ACTUAL mechanical rule (derived from hidden_mode/letters_hidden_default/
  letter_position/letter_grouping via a new describeLevelRule helper — e.g. "Hides 3 letters
  toward the middle, spread apart" / "Hides the whole word") and a live "Looks like" sample word
  masked through the real maskWord engine (sampleMask helper), so you see the true shape without
  opening the editor. Intro reworded to make clear the rules are LIVE (they drive the game) and
  editable via the per-level Edit button (which already exposes every field). Full editing was
  already available; this is about visibility. (Also fixed a stale "Basic ≈ 1–6 / Advanced ≈ 7–10"
  tier reference in the Architecture levels section — the tier concept was removed.)
- **Doc verification pass (all three docs checked against the live system).** Confirmed all 9
  tables, 9 functions (exact signatures), and the view are documented; the pm_questions /
  pm_levels / pm_question_levels schemas match reality (no dropped columns claimed, live override
  columns present); the nav section lists all 9 pages incl. Generator and describes the URL-hash
  routing; and the RPC/feature specs are current. Filled two real gaps found in the golden-rules +
  build docs: (1) the RPC-grant footgun — DROP+CREATE on a function silently restores the PUBLIC
  execute grant, so anon regains call access unless you revoke from PUBLIC (added to CLAUDE.md
  invariants + the Build Prompt's grant instruction); (2) the URL-hash routing invariant — don't
  revert nav to plain constant-initialised state or you reintroduce the refresh-loses-your-place
  bug (added to CLAUDE.md).
- **Fixed: refreshing the page always dumped you back on the dashboard (URL now reflects the
  view).** nav was plain React state initialised to "dashboard" and never written to the URL, so
  every reload lost your place. Added URL-hash routing: the current section (and open pack) live in
  location.hash (#/questions, #/levels, #/pack/<id>, #/ = dashboard). On mount the app parses the
  hash to seed the initial section; goNav/goPack write the hash; a hashchange listener re-derives
  state so browser Back/Forward and manual edits work. A pack id from the URL resolves once packs
  load (library skeleton shows meanwhile), which also makes pack views deep-linkable/shareable.
  Verified: the App's initial nav state now derives from the hash for every route (#/questions →
  "questions", etc.). Bonus: document.title now tracks the current section/pack, so browser tabs
  and history are meaningful. (The old pushState back-button logic was replaced by this.)
- **Comprehensive audit fixes (two real issues found + fixed):**
  · **Pack header count bug (introduced by the server-side pack filters):** the header showed the
    QUERY total, which is now the FILTERED count — so applying a date/level filter made it read
    e.g. "3 questions" for an 11-question pack. Fixed: the header now shows the pack's true count
    (pack.total_questions from pm_pack_overview) and, when a filter is active, appends "· N match
    filter". Added an isFiltered flag (datePreset !== 'all' || level !== 'all').
  · **RPC grant posture drift:** recreating pm_search_questions (and earlier pm_clone_pack) via
    DROP+CREATE silently restored the PUBLIC execute grant, so anon could CALL pm_search_questions,
    pm_clone_pack, pm_dashboard_stats, pm_lint, pm_lint_details, pm_log, pm_mark_released. No breach
    (all are SECURITY INVOKER, so writes were still RLS-blocked and reads were published-scoped), but
    it contradicted the intended model. Revoked execute from PUBLIC + anon on all of them (the fix
    that had been missed needed to target PUBLIC, not just anon); authenticated retains execute. Now
    only the two trigger functions are anon-executable, and those can't be called as RPCs anyway.
  Audit also verified (no change needed): all 16 components render; client/edge maskWord parity
  (384 cases, 0 mismatches) + buildLevelVariants override handling; all RPCs execute; the live
  game-feed renders BRAVE correctly L1→L10; created_at auto-populates and updated_at trigger fires;
  db.questions builds valid URLs for every filter combo (verified the full combined query live).
- **Pack-detail filters moved SERVER-SIDE (span the whole pack, not just the loaded page).** The
  per-pack "when added" / level / sort filters were initially client-side (page-only). db.questions
  now takes fromDate/toDate/level/packLevel/sort and builds the PostgREST query, so filtering +
  sorting cover every question in the pack and the count/pagination stay correct. The level filter
  correctly includes inheritors: when the chosen level equals the pack's own level it uses
  or=(level.eq.X,level.is.null); otherwise a plain level=eq.X. Verified the exact queries against
  the live REST endpoint (incl. the or=() syntax → 200 with the right rows). Quick text search
  stays client-side over the loaded page (a debounced nicety). The global Questions page already
  did server-side date filtering; the two pages are now consistent.
- **Pack-detail question bank: same "when added" filter, sort, and timestamps as the global
  Questions page.** The global page got these last change; the per-pack view (PackDetail) was
  missing them. Added a "when added" dropdown (any / 24h / 7d / 30d), a sort dropdown (default
  order / newest / oldest), and a relative "added" stamp on every row (full timestamp on hover).
  db.questions already selects created_at, so no data-layer change was needed. Note: like the
  existing text/level filters here, these operate client-side on the loaded page (the global
  Questions page does true server-side date filtering across everything).
- **Questions page: filter & sort by when a question was added.** pm_questions already had a
  populated created_at (every question is timestamped on insert), so this was purely surfacing +
  filtering it. pm_search_questions gained from_date/to_date (a [from, to) window on created_at)
  and a sort param ('recent' newest-first / 'oldest' / null keeps pack order), and now returns
  created_at + updated_at. The All-questions page got a "when added" dropdown (last 24h / 7d /
  30d / custom range with two date pickers) and a sort dropdown, and each row shows a compact
  relative "added" stamp (relativeTime helper in core.jsx: "just now" / "5m" / "3h" / "2d" /
  "3w" / date), full timestamp on hover.
- **Leftover cleanup pass (full app sweep for old-model remnants):**
  · Dropped the two dead per-question columns \`pm_questions.difficulty\` and
    \`pm_questions.letters_hidden\` — they were written on every save/clone and returned by the
    search RPC, but NOTHING read them (rendering is driven by the level + pm_question_levels
    overrides). Removed the derive-and-save code in the question editor, took them out of
    \`pm_search_questions\`' return signature, and stopped \`pm_clone_pack\` from copying them.
    (The pack-level \`difficulty\` tag and the live \`pm_question_levels.letters_hidden\` OVERRIDE are
    unaffected — those stay.)
  · Fixed a latent clone bug found on the way: \`pm_clone_pack\` wasn't copying \`frame_slots\`, so a
    cloned pack lost its frame-word slots — now copied.
  · Play-mode tip reworded from the old "only the primary word is the correct fill for this
    sentence" (meaning framing) to the spelling framing ("the correct one is the word whose
    spelling fits the revealed letters").
  Verified: all affected components (QuestionEditor, PackEditor, BulkImport, PackDetail,
  AllQuestions, PlayMode) render; search RPC still returns rows; columns confirmed dropped.
  Remaining "difficulty" in the codebase is all legit pack-level difficulty or general help text.
- **Overview: dropped the "Levels in use / of 10" box — it was measuring the wrong thing.** It
  counted the distinct DEFAULT levels questions are assigned to, but every question renders at ALL
  10 levels (that's the point of the level system), so "2 of 10" wrongly implied only 2 levels'
  worth of content existed. Replaced it with a "Published packs · live in the game" box (a
  genuinely operational number). The level DISTRIBUTION is still shown correctly by the "questions
  by level" mini bar-chart in the Library-health card, which conveys the spread without the
  misleading "of 10" framing. (The RPC's now-unused distinct_levels_used field was left in place;
  harmless.)
- **Removed the basic/advanced TIER concept entirely — the level number is the difficulty.**
  Tier was a redundant leftover from the old model (like the purged difficulty field): the app
  already has a clean 1–10 level progression, so classifying levels into basic/advanced added
  nothing. Removed everywhere: the two "Basic-tier / Advanced-tier levels" Overview boxes (replaced
  with "Levels in use" + "Empty packs" boxes and a "questions by level" mini bar-chart in the
  Library-health card); the Tier <Select> in the Level editor and the tier Pill in the level list
  (now shows the hidden-mode: "whole word" / "N letters"); the tier field in buildLevelVariants
  output and the export projection; the tier branch in the derived-legacy difficulty (now keys off
  hidden_mode only). Fixed a latent bug found on the way: the QuestionLevelEditor preview used
  \`variant.tier === "advanced"\` to decide whole-word rendering — now uses \`variant.target.wholeWord\`.
  DB: pm_dashboard_stats rewritten to return distinct_levels_used + questions_by_level instead of
  tier counts; game-feed edge fn redeployed (v11) without tier; and the \`pm_levels.tier\` COLUMN was
  dropped. Verified no functions/views referenced it before dropping.
- **Play mode level filter:** added a level selector at the top of Play mode. Default "each own
  level" plays every question at its own effective level; picking a specific level forces the whole
  pack to render at that level's blank difficulty (via previewAtLevel with an overridden q.level —
  same shared engine, parity preserved), so you can feel how the pack plays at any difficulty.
  Changing the filter restarts the run and the active level shows in the header.
- **CRITICAL — the build was silently broken; recent "deploys" shipped a STALE bundle.** The
  earlier pack-undo edit (preserving all pack fields on Undo) left a brace mismatch — the onClick
  arrow closed with a stray \`}\` and the \`action\`/\`notify\` closers were dropped — so assemble.cjs's
  Babel compile threw and never rewrote app.compiled.js. build_html.cjs kept wrapping the OLD
  compiled file, and \`node --check app.compiled.js\` passed because it was checking the old valid
  file — so several commits (docs, generator mechanic, Play-mode fixes) never actually reached the
  deployed bundle. Fixed the braces; assemble now compiles and writes a fresh bundle (index.html
  jumped ~388KB→399KB, confirming how far behind it was). LESSON: after every build, verify
  assemble.cjs printed its success summary AND that app.compiled.js was newly written (check its
  mtime / grep a just-added string) — do NOT trust \`node --check app.compiled.js\` alone, since a
  failed assemble leaves a stale-but-valid file.
- **Added a visible build stamp** (CFG.build, shown small in the sidebar footer) so a stale cached
  build is obvious at a glance — bump it on every deploy.
- **Game mechanic corrected — it's a SPELLING puzzle, not a meaning test:** earlier docs/prompt
  said "both words positive but only the primary FITS THE MEANING of the sentence". That was
  wrong. The real mechanic: the sentence shows a word with some letters revealed and some blank;
  the child picks the positive word whose SPELLING fits the revealed letters + blank shape. Both
  words are positive (therapeutic core intact); the primary spells into the pattern, the alternate
  is another positive word that does NOT — reliably guaranteed by giving it a DIFFERENT LENGTH
  (a different-length word can never match the fixed blanks at any level). Updated the intros of
  the Architecture doc + Build Prompt, the Play-mode spec (why the primary is correct), the
  Content Generator spec, AND the live generator (generator.jsx: MASTER_CONTEXT + the AI prompt
  lines) so generated questions come out spelling-valid, not meaning-based. First real content
  (10 Confidence questions) was authored/validated under this rule — every distractor is a
  different length from its answer, verified against the actual maskWord pattern at every level.
- **Full audit — several real bugs found & fixed:**
  · **Client/edge PARITY bug (important):** the client buildLevelVariants precedence was changed to
    \`ov ?? q.letter_position ?? lvl ?? default\` during the editor rebuild, but the game-feed edge
    function still used \`ov ?? lvl ?? default\`. A question with its OWN letter_position/grouping
    rendered differently in the game than in the CMS (proven: "start" → __AVE in CMS, BRA__ in
    game). Fixed the edge function to the same precedence and redeployed (game-feed v10). Parity
    invariant restored.
  · **PlayMode silent 100-row cap:** Play mode fetched only the first 100 active questions
    (size:100), so packs with >100 questions were truncated and the "X of Y" count was wrong.
    Switched to db.allQuestionsForPack (paginated). 
  · **Pack-delete Undo dropped fields:** restoring a deleted pack via the Undo toast recreated
    only the basics — it silently lost level, purpose, focus_areas, style_approach,
    example_objectives. Now restores all pack fields (the overview view exposes them).
  · **Stale lint check:** pm_lint_details' \`revealed_answer\` rule keyed off the dead
    difficulty/letters_hidden columns; rewrote it to use the effective LEVEL's hidden_mode +
    letters_hidden_default. pm_lint (summary) was already clean.
  · **RPC grant hygiene:** revoked anon EXECUTE on the admin/write RPCs (pm_dashboard_stats,
    pm_search_questions, pm_lint, pm_lint_details, pm_mark_released, pm_log) — they already failed
    for anon via RLS/INVOKER, but the grants were misleading. Public game feed (service_role via
    edge fn) unaffected.
  Verified: all major components render headlessly without crashing; maskWord "random" is
  deterministic; whole-word levels hide the whole word; transform engine still guards objects on
  both client and edge; RLS confirmed published-only for anon.
- **Play mode scoring fixed + game rule clarified:** Play mode treated BOTH answer words as
  correct (picking either said "Great choice!" and scored a point), so a wrong pick was reported
  as correct. Clarified rule: both words are positive, but only the PRIMARY word (\`answer\`) is
  the correct fill for the sentence; the alternate is positive-but-wrong-here (a distractor, not
  a synonym). Play mode now checks the pick against the primary answer, shows "Correct! ✓" vs
  "Not quite — the answer is X", colours the buttons green/red and reveals the right answer, and
  scores only correct picks (done screen shows "X of Y correct"). The MASTER_CONTEXT doc and the
  generator PROMPT were rewritten to teach this (the alternate must be a plausible positive word
  that does NOT fit the blank — never a synonym). Also purged the word "affirmation(s)" as a name
  for the items across the UI (editor subtitle, empty state, levels caption, Play mode) — they're
  "questions"; only genuine CBMT adjective usage ("self-affirming") remains in the therapy blurb.
- **Dashboard stats fixed to use level tiers (was counting dead difficulty):** pm_dashboard_stats
  computed its basic/advanced question split from the derived-legacy difficulty column. It now
  counts by the effective LEVEL's tier (question level → pack level → pm_levels.tier), which is
  the meaningful measure; the Overview cards were relabelled "Basic-tier / Advanced-tier levels".
  Also swept the three developer docs for stale old-model teaching (outside the changelog):
  removed the "difficulty→level" value-map examples, and expanded the Build Prompt's question-
  editor + dashboard + JSON-backup descriptions to match the current level-based reality.
- **Search RPC signature scrubbed:** pm_search_questions dropped its legacy \`diff\` (question
  difficulty) parameter and filter clause — signature is now (q, pack, stat, lvl, lim, off).
  The client call and its doc comment were updated to match. Verified 200 OK through the actual
  PostgREST endpoint with the client's exact payload. (Returned columns still include the
  derived-legacy difficulty/letters_hidden so nothing reading them breaks.)
- **Old difficulty/letters model purged from the app (follow-through cleanup):** after the
  editor was reconciled with levels, a full sweep removed the remaining old-model residue.
  Per-question difficulty is now DERIVED from the level (never authored), so: the question-list
  and global-search "difficulty" filters and the per-question difficulty pills were removed
  (a LevelChip shows the meaningful axis instead); difficulty/letters_hidden were dropped from
  the exportable QUESTION_SOURCE_FIELDS; the built-in export profiles had their stale
  level→difficulty value-map and redundant difficulty fields stripped (DB); the dead
  packDifficulty prop was removed from QuestionEditor; the bulk importer stopped hard-coding
  difficulty/letters_hidden (they fall to DB defaults, questions inherit the pack level). The
  whole-CMS JSON backup was also MODERNIZED (v3): it now exports/imports level, letter_position,
  letter_grouping, frame_slots and the pack's purpose/focus/style fields (previously it carried
  the dead letters_hidden/difficulty and silently DROPPED levels + frame words on restore).
  NOTE: pack-level difficulty (basic/advanced/mixed) is a real pack tag and was kept. (The
  per-question letters_hidden/difficulty columns were left as derived-legacy at the time of this
  change, then fully dropped in a later cleanup — see the top of this changelog.)
- **Question editor reconciled with the level system (bug fix):** the editor still exposed the
  OLD model — a per-question "Difficulty" (basic/advanced) toggle and a "Letters hidden" number
  — but rendering has long been driven by the LEVEL (hidden_mode, letters_hidden_default,
  position, grouping), so those controls did nothing (you literally couldn't change how many
  letters were hidden). Removed both. The editor now: sets the question's Level (which controls
  letters-vs-whole-word), shows position/grouping overrides only when the previewed level hides
  letters, and — crucially — the "how the child sees it" preview now renders through the SAME
  engine as the game (buildLevelVariants) with a level picker so you can flip through every
  level and see exactly what the child sees. On save, difficulty/letters_hidden are DERIVED from
  the question's level (so filters, pack pills and exports stay coherent) rather than edited.
- **One shared preview engine:** buildLevelVariants moved to core.jsx (single source), and a new
  previewAtLevel() helper now powers the editor, the question-list rows, the search-result rows,
  and Play mode — all previously used a separate previewQuestion() path that could drift from the
  game. previewQuestion and effectiveMask (both now unused) were removed. buildLevelVariants also
  now honors the question's own letter_position/grouping at the base level (was ignored before).
  Verified the editor/rows/game render identically across levels.
- **Audit pass on the generator/import loop:**
  · Import now sanitizes AI/user-supplied frame_slots before it reaches the DB
    (sanitizeFrameSlots): pool coerced to a clean string array, byLevel keys must be numeric
    and values become strings, junk/blank tokens dropped, returns null if nothing valid. The
    resolver was already crash-proof against malformed shapes; this keeps the DB clean too.
  · Import duplicate-check now has a loading state — the Import button is disabled and shows
    "Checking…" until the pack's existing questions have loaded, so you can't accidentally
    import past an un-loaded dedup check.
  · Generator: applyPack fetches are guarded by a ref (latestPackReq) so rapidly switching
    packs can't leave a stale pack's questions in the avoid-list (out-of-order response race).
  · Generator: the avoid-list sentence signatures are capped (120) with an "…and N more" note
    so a large pack can't bloat the prompt or bury the instructions (a 250-question pack was
    ~17.7K chars); the compact answer-word list is always included in full.
  Verified: sanitizer across 10 malformed shapes; resolver crash-proof across 9; dedup
  classification (exact/similar/new/in-batch) across 6; normSentence collision behavior
  reviewed (frame-word-only differences surface as "similar" for review — intended).
- **Generator: background context + duplicate avoidance (belt & suspenders):**
  · A standalone, reusable MASTER_CONTEXT document (the full CBMT "why", who the child is, what
    good/bad looks like) lives on the Generator page with copy — paste it once at the top of a
    fresh AI chat, then paste generated prompts after it. An "Include background context" toggle
    also folds a compact version into the prompt itself.
  · An "Avoid existing questions" toggle loads the selected pack's questions (new
    db.allQuestionsForPack, paginated) and appends an "ALREADY COVERED — do not repeat" list
    (answer words already used + existing sentence signatures) so the AI steers away from dupes.
  · The Bulk importer now flags duplicates against the pack's existing questions: EXACT (same
    normalized sentence + same answer, punctuation-insensitive; also catches repeats within the
    pasted batch) and SIMILAR (same sentence OR same answer word). Exact defaults to skip,
    similar defaults to keep-but-flagged; every flagged row has a per-row Skip/Keep toggle, and
    only kept rows import. All verified against real pack data.
- **Content Generator page (prompt builder):** a new "Generator" nav page (generator.jsx,
  GeneratorView) that assembles a ready-to-paste AI prompt for authoring a batch of questions
  in our format. Controls: pack picker (pre-fills themes from the pack's focus_areas/purpose,
  all editable), a multi-select of target levels (chips), a themes field, a count, an
  output-format picker (JSON import-ready / pipe / markdown table — chosen each time), an
  optional "include frame-word variations" toggle (teaches the AI the {token} pool + byLevel
  system), and an extra-instructions field. The generated prompt teaches the CBMT philosophy,
  the {blank}-target + both-positive-words rules, level context, and the exact output shape
  with a concrete example; it live-updates and has a copy button. Also: the Bulk importer now
  carries frame_slots from imported JSON (was dropping it), so the generate → import loop works
  end-to-end for frame-word questions. Prompt output verified valid + importable.
- **Export now carries the target word + frame structure explicitly (self-describing):**
  each per-level variant gained a \`target\` object (word, altWord, blankShape, wholeWord,
  lettersHidden, position, grouping) so the game never parses the sentence to find the guess
  word, plus a \`frames\` map (token -> resolved word) showing exactly which frame words were
  used. Questions now expose BOTH a raw \`template\` (with {tokens}) and a resolved
  \`base_sentence\` (real words at the base level). A new optional per-profile flag
  \`include_frames\` attaches the raw frameSlots config (pools + per-level pins) so the game can
  vary the swappable words itself. base_sentence is a pickable field; the ProfileBuilder has
  the new toggle; the Full export profile turns include_frames on. Client engine + game-feed
  edge fn kept byte-identical (added resolveFrameMap). Verified end-to-end via the feed.
- **Polymath audit pass:**
  · TRANSFORM ENGINE (xf/mapVal + edge applyTransform/mapValue): guarded against object/array
    values — an accidental upper/lower/trim on frame_slots or tags would have produced
    "[object Object]"; now objects pass through untouched, and value_maps only key on
    primitives (the \`in\` operator on an object was fragile). Client + edge kept identical.
  · REALTIME: connect() now tears down a socket still in CLOSING state before opening a new
    one (a tab-refocus during close could otherwise create two live sockets + double
    heartbeats). Set REPLICA IDENTITY FULL on pm_questions/pm_question_levels so DELETE events
    carry pack_id (the PackDetail live-refresh filter needs it; before, deletes reloaded
    every open pack view).
  · LINT: added two checks — "revealed_answer" (a basic question hiding 0 letters shows the
    child the answer) and "empty_answer"; the health total now counts actual detail rows so
    new rules always reflect in the count. New issue labels added to the UI.
  Verified safe-but-noted (no live bug): {Blank}/{BLANK} as a target is caught by the
  {blank}-required save validation; byLevel numeric/string key coercion is correct; optimistic
  pack delete doesn't race the realtime refresh; localStorage access is exception-safe.
  Verified clean: frame-word feed render across L1–10 after the changes; feed 200 OK.
- **Frame-word variations:** the sentence template can now contain swappable {token} words
  (other than {blank}, which stays the selectable target). Each such token gets a \`frame_slots\`
  config on pm_questions: a \`pool\` of alternatives + optional per-level pins (\`byLevel\`). This
  lets levels 7–10 differ even when the blank is a whole word (e.g. "…when things get {hard}"
  → difficult / stressful / challenging / problematic per level). resolveSlots (in core.jsx,
  mirrored in the game-feed edge fn) resolves them deterministically: byLevel wins, else a
  seeded pick from the pool (stable + identical client/edge), else the bare token. The question
  editor auto-detects tokens and shows a pool editor + per-level pin grid (FrameSlotEditor).
  frame_slots is exportable and the search RPC returns it. Verified end-to-end via the feed.
- **Full audit pass — security + robustness fixes:**
  · SECURITY: pm_pack_overview was SECURITY DEFINER, so anon could read draft/unpublished
    packs' metadata through the public API. Set security_invoker=true — anon now only sees
    published packs (verified: a test draft was invisible to anon via the view).
  · SECURITY (defense in depth): revoked the unused insert/update/delete/truncate grants from
    anon on all pm_ tables (RLS already blocked writes, now the grant surface matches intent).
  · DARK MODE BUG: toasts used background:C.ink, which flips to near-white in dark mode,
    making the pale accent colors + white text invisible. Fixed to a permanent dark bg.
  · ROBUSTNESS: guarded bulk delete/status against empty id arrays (an empty in.() query
    would be malformed) — the UI already prevented it, but the data layer now does too.
  · REALTIME: on background token refresh, push the new token to the live socket
    (realtime.updateToken) so long-lived connections stay authorized without waiting for a
    reconnect.
  · ERROR HANDLING: the question action handlers (toggle status, bulk delete/status, import,
    single delete) had no try/catch — a failed operation vanished silently with no feedback.
    They now surface a clear error toast. (Editors, pack delete/clone/reorder already caught.)
  Verified clean: maskWord client/edge parity (624 combos, identical), data integrity (zero
  orphans/broken refs), all db.* calls resolve, all components resolve, feed still 200 OK.
- **Stay logged in for 7 days:** the session was being lost on tab/browser close (it used
  sessionStorage) and the access token was only refreshed reactively. Fixed: the session now
  persists in localStorage with a 7-day window measured from login, the short-lived access
  token is refreshed proactively in the background (every 45 min and on tab refocus, plus the
  existing on-401 retry), and a legacy sessionStorage entry is migrated on load. Users now
  stay signed in across restarts until they log out or the 7 days elapse.
- **Live sync (realtime):** open sessions now update automatically when anyone edits data,
  so multiple people on multiple devices don't work off stale views. A lean websocket client
  (realtime.jsx, no Supabase SDK) connects to Supabase Realtime and subscribes to
  postgres_changes on the 7 UI tables; a debounced refresh reloads the affected lists
  (packs, questions, per-pack question list, global search, levels). A "Live" badge in the
  header shows connection status; it auto-reconnects and re-subscribes on tab focus. Realtime
  is enabled on the publication for pm_packs, pm_questions, pm_levels, pm_question_levels,
  pm_export_profiles, pm_sync_targets, pm_activity. (Note: auth is still a single shared
  account — per-user accounts are a separate future step.)
- **Pack purpose at a glance:** Library pack cards reveal the pack's Purpose + Focus areas
  on hover (desktop) or via an ⓘ toggle (touch), without opening the pack; the Overview
  pack-index tooltip also includes the purpose.
- **Structured pack descriptions:** each pack now has purpose, focus_areas, style_approach,
  and example_objectives (shown as an "About this pack" panel on the pack page, editable in
  the pack editor, exportable via the field mapper). An AI "draft" button calls a new
  pack-describe edge function (Anthropic; needs ANTHROPIC_API_KEY server secret) to fill a
  first draft the user then edits. All 14 existing packs were seeded with grounded drafts.
- **Export pipeline reviewed for levels + XML added:** the 3 starter profiles were updated
  to carry the real effective_level (Flat API had mislabeled difficulty as "level"); a new
  "Full game export (with levels)" starter emits the complete 10-level structure
  (expand_levels on) — verified via the live feed. Added XML output everywhere: a toXml
  serializer (client + edge, kept identical), JSON/XML buttons on the file download, and
  ?format=xml on the game-feed. All four channels (file, feed, push, Firebase) carry level
  data because they share fetchAllContent(expandLevels) + buildOutput.
- **Level filters + audit:** the question bank (global search), the in-pack question list,
  and the Library now all have a Level filter (pm_search_questions gained an \`lvl\` param
  matching effective level). Fixed three mislabeled "All levels" dropdowns that were really
  difficulty filters. Fixed a real bug: maskWord "random" position used Math.random() so the
  blank flickered every render and wouldn't match the game — it's now deterministic (seeded
  from the word), stable across renders and identical client/edge.
- **Audit fixes:** (1) level data now reaches the game — the export engine + game-feed
  (v4) attach effective_level to every question and, when a profile enables "Expand levels",
  add a \`levels\` array with the sentence + blank for all 10 levels (client and edge kept in
  sync; verified via the feed). (2) pm_clone_pack now copies the pack level, question-level
  overrides, and pm_question_levels rows (was silently dropping them). (3) NaN guard on the
  per-level editor's letters_hidden.
- **Questions are multi-level concepts:** each question auto-renders every level (same
  affirmation, blank difficulty derived per level via buildLevelVariants). The question bank
  keeps flat rows with a "Levels" expand toggle that reveals every level's version. Any level
  can be individually edited (override sentence/word/letters/position/grouping or disabled),
  stored in pm_question_levels; un-edited levels stay auto-generated. Reset returns a level
  to auto.
- **Blank shape control:** levels now also define WHERE missing letters sit
  (letter_position: start/middle/end/random) and whether multiple hidden letters are
  grouped or spread (letter_grouping). maskWord() generates the actual blank; the "how the
  child sees it" preview, the question rows, PlayMode, and search all reflect it.
  Question-level overrides fall back to the level default (in buildLevelVariants). Defaults were
  seeded to match the concept deck (b__ve style = middle/grouped for the gentle levels).
- **Expandable level progression (1–100):** a \`pm_levels\` table defines the levels (ships with
  1–10; you can add more above the top, up to a CHECK ceiling of 100). Each level has letter-hiding
  rules (hidden_mode letters/word, letters_hidden_default, letter_position, letter_grouping), a
  color/theme/age hint, AND vocabulary rules — min_word_len, max_word_len, allow_multiword, and a
  free-text vocab_rule — that shape which ANSWER words the level uses (they feed the generator and
  display intent; the masking engine ignores them). The level NUMBER is the difficulty; no separate
  basic/advanced tier. Packs carry a default \`level\`; questions can override (null = inherit).
  The Levels page lets you view/edit each definition AND add a new level above the current top
  ("Add level N", pre-filled from the current top level's rules) or delete the top level (only the
  highest, to keep the ladder contiguous). Each level card shows a plain-English summary of the
  ACTUAL mechanical rule plus a live "Looks like" sample masked through the real engine, and word-band
  / multi-word badges. Adding a level row is sufficient for it to render everywhere (CMS previews and
  BOTH feeds) with zero per-question work — nothing is pre-materialized; the shared engine derives
  every level on demand. Questions for a new level come two ways: (1) the AI generator prompt now
  includes each target level's word-length band, multi-word allowance, and vocab_rule (plus a
  reminder that both answers stay in-band yet differ in length); (2) a "Derive level" action on a
  pack materializes editable pm_question_levels override rows for a chosen level across all active
  questions (applying that level's masking rule to each word; skip-or-overwrite existing), for when
  you want concrete per-question rows to hand-tune. LevelChip shows the level on cards and question
  rows; the pack/question editors have level selectors. pm_search_questions returns the effective
  level (coalesce question→pack).
- **Contrast/accessibility pass:** every text color WCAG-checked; 'faint' darkened
  (2.57 → 4.88 on white) and brightened in dark mode; inputs now use the panel token
  (fixed dark-mode white inputs), 1.5px borders, explicit readable ::placeholder.
- **Developer Notes page** added (this page): 3 hardcoded docs (Architecture, CLAUDE.md,
  Build Prompt) with copy+download, plus an autosaved scratchpad (pm_dev_notes table).
- **Overview pack index:** compact one-line, tap-to-open list of every pack at the bottom
  of the dashboard (responsive grid; 2 cols on phone).
- **Mobile question cards:** below desktop, question rows became content-first cards
  (sentence hero on top, meta+actions footer, checkbox floated to the corner) instead of
  a folded desktop row that buried the sentence.
- **Audit fixes:** (1) session token refresh + retry on 401, with fallback to login
  (tokens expire ~1hr and the UI used to silently break); (2) release-state lifecycle —
  pm_mark_released clears "pending changes" after a sync (was never advancing); (3)
  restAll() pagination on client AND edge function to defeat the 1000-row cap; (4) command
  palette closes on Escape; (5) confirmDialog fails safe if opened before host mount.
- **Firebase channel + keyless-ish feed:** Firebase targets (RTDB/Firestore/CloudFn),
  configurable path layouts; game-feed edge function with health probe (v3, paginated).

IMPORTANT: keep this section and the CLAUDE.md/Build-Prompt docs updated on EVERY change.
`;

const DOC_CLAUDE_MD = `# CLAUDE.md — Positive Minds CMS

Guidance for AI assistants (and humans) working on this codebase.

## Project
Content management system for the Positive Minds children's word game (CBMT
fill-in-the-blank affirmations). This is the **authoring + publishing** layer; a
separate game backend reads the content. Single-file React app, Supabase backend,
Cloudflare Worker hosting, GitHub Actions/Cloudflare Git auto-deploy.

## Stack & identifiers
- React 18.3.1, single self-contained index.html, **NO runtime build** (JSX pre-compiled).
- Supabase project ref: tytrmjjucqijzcrbwjfm
- GitHub: alcharles1980-design/positive-minds-cms
- Live: positive-minds-cms.<subdomain>.workers.dev
- Feed edge function: /functions/v1/game-feed

## Golden rules (do not break these)
1. **Babel classic runtime only.** Compile with @babel/preset-react { runtime: "classic",
   development: false }. The automatic/dev runtime emits \`import jsxDEV\` which breaks a
   plain <script> and causes a blank "Loading…" screen. Verify the compiled output has
   React.createElement and NO jsxDEV / NO top-level import.
2. **PostgREST 1000-row cap.** Never rely on \`limit=10000\`; the server caps at 1000.
   Use restAll() (paginate in 1000-row batches) for any list that can exceed 1000 rows.
   The game-feed edge function must paginate too.
3. **Assembly order + hoisting.** The app is concatenated from /v2/*.jsx in a fixed order
   (see assemble.cjs). Cross-file COMPONENTS must be \`function\` declarations (hoisted).
   Cross-file \`const\` helpers must be defined in a file that loads BEFORE their consumers.
4. **Client/server engine parity.** TWO engines must stay byte-identical: the one in the
   client (core.jsx + engine.jsx) and the one in the game-feed edge function. This covers the
   RENDERING engine — \`maskWord\`, \`resolveSlots\`, \`resolveFrameMap\`, \`buildLevelVariants\` — AND
   the TRANSFORM engine — \`buildOutput\`/\`projectRow\`/\`applyTransform\`/\`mapValue\`/\`toXml\`. Any
   change to one MUST be mirrored in the other or the feed diverges from what the CMS shows.
   Watch the PRECEDENCE CHAIN specifically: buildLevelVariants resolves position/grouping as
   \`override(pm_question_levels) ?? question.own ?? level.default ?? hard-default\` — this exact
   order must match in both files. (A past bug: the client gained the \`question.own\` step but
   the edge function didn't, so a question with its own letter_position rendered differently
   in-game than in the CMS.) After any engine edit, diff the two by fetching the deployed edge
   function and comparing, or run a parity test with a question that has its own overrides.
4a. **Questions are never pre-rendered — level rules propagate live.** A question row stores only
   its template + answer/alt + optional own overrides. Its level-variations (masked blanks, one per pm_levels row) are
   COMPUTED ON DEMAND by buildLevelVariants from the current pm_levels rows every time — in the CMS
   (previews recompute on each render from the levels prop, which the shell keeps fresh via the
   pm_levels realtime subscription) AND in the game feed (the edge fn fetches pm_levels per request).
   So editing a level's rule on the Levels page instantly changes that level's variation for EVERY
   inheriting question, everywhere, with no re-save/republish. Do NOT introduce a cached/materialised
   per-question variation store — it would break this and desync the game from the CMS. Precedence
   still applies: a per-question pm_question_levels override wins over the level default (intended).
   Corollary: the level ladder is DATA-DRIVEN and expandable (1..100). Adding a pm_levels row is
   enough for that level to render everywhere; NEVER infer a level's mode/difficulty from its NUMBER
   (no "level>=N ⇒ whole word" shortcuts anywhere, including preview fallbacks) — always read the
   level row. The game client must handle however many levels the feed reports, not assume 10.
5. **View column order.** pm_pack_overview uses \`p.*\`. Adding a column to pm_packs shifts
   positions and CREATE OR REPLACE VIEW will error — DROP and recreate the view instead.
6. **Auth/session.** Access tokens expire ~1hr. rest()/rpc() auto-refresh + retry once on
   401 and fall back to the login screen. Don't remove that; don't leave the UI logged-in
   on a dead token.
7. **Keep the docs current.** On EVERY change/feature/fix, update the three embedded docs
   in devdocs.jsx (DOC_ARCHITECTURE incl. its §12 changelog, DOC_CLAUDE_MD, DOC_BUILD_PROMPT)
   in the SAME pass, so the Developer Notes page never drifts from the real build.
8. **Accessibility/tokens.** All text must meet WCAG AA on its background — use the C tokens
   (faint is already the minimum readable grey; don't go lighter for text). Never hardcode
   a hex where a token exists (dark mode + contrast depend on it). Inputs use C.panel bg and
   the ::placeholder rule — don't reintroduce white input backgrounds.
9. **URL-hash routing (don't break refresh-persistence).** The current view lives in
   location.hash (#/questions, #/pack/<id>, #/ = dashboard). nav state is SEEDED from parseHash()
   at mount, goNav/goPack WRITE the hash, and a hashchange listener re-derives state. If you add a
   nav section, add its id to VALID_NAV and give it a hash. Never revert nav to plain state
   initialised to a constant — that reintroduces the "refresh always dumps you on the dashboard" bug.

## Data access
- The \`db\` object (core.jsx) is the ONLY way to touch data. Add new queries there.
- RPCs live in Supabase: pm_dashboard_stats, pm_search_questions, pm_clone_pack, pm_lint,
  pm_lint_details, pm_log, pm_mark_released.
- Levels: pm_levels holds the 10 editable level definitions. Packs have a default \`level\`;
  questions have a nullable \`level\` (null = inherit pack). Effective level = coalesce(
  question.level, pack.level). Levels also define blank SHAPE: letter_position (start/
  middle/end/random) and letter_grouping (grouped/spread), overridable per question.
  maskWord(word, letters, position, grouping) generates the blank; buildLevelVariants(q, levels,
  overrides) resolves the chain override(pm_question_levels) → question's own → level default →
  hard-default, and previewAtLevel wraps it for single rows. If you change how blanks render,
  update maskWord/buildLevelVariants in ONE place — every view (editor preview, rows, PlayMode,
  export) and the game feed mirror it.
- Multi-level concepts: every question renders every level via buildLevelVariants (question
  + level rules → per-level blank). Overrides live in pm_question_levels (one row per edited
  level; absent = auto-generated). The question-bank row expands to show all variants. Don't
  duplicate a question into 10 rows — it's ONE row, derived. To send levels to the game, a
  profile sets spec.expand_levels → fetchAllContent({...},{expandLevels:true}) attaches a
  \`levels\` array; the game-feed edge function mirrors this. If you touch buildLevelVariants or
  the expand logic, update BOTH engine.jsx and the edge function (parity invariant). Same for
  maskWord AND resolveSlots AND resolveFrameMap (frame-word slots + the token->word map): the
  client (core.jsx) and edge fn must stay byte-identical, including the deterministic seeded
  pool-pick, or the CMS preview and the exported target/frames won't match what the game renders.
  If you add a column to pm_packs, DROP+recreate pm_pack_overview (it uses p.*).
- RLS: anon read-only, authenticated full write. Never add anon write policies.
- RPC grant footgun: recreating a function with DROP+CREATE (needed when its signature/return
  changes) silently RESTORES the default PUBLIC execute grant — so anon regains the ability to CALL
  it. After any such recreate, \`revoke execute on function fn(exact_sig) from public, anon;\` (revoke
  from PUBLIC, not just anon — the grant flows through PUBLIC) and \`grant ... to authenticated;\`.
  Intended posture: ONLY the two trigger functions (pm_bump_pack_version, pm_touch_updated_at) are
  anon-executable, and those are inert (trigger fns can't be called as RPCs). All real RPCs are
  authenticated-only. (Because every RPC is SECURITY INVOKER, a stray grant is posture-not-breach —
  RLS still blocks writes and scopes reads — but keep the posture correct.)

## Editing / build workflow
- Edit the modular files in /v2/, NOT the compiled output.
- Rebuild: \`node assemble.cjs && node build_html.cjs\`.
- Validate before deploy: \`node --check app.compiled.js\`; confirm all JSX components
  resolve to definitions; confirm all db.* / rpc names resolve; parse each inline <script>.
- Test DB changes against the live project (RPCs, RLS) before shipping — verify, don't assume.
- Deploy: copy index.html + source into /repo/, commit, push to main; Cloudflare auto-builds.
- Always sync final files to the outputs directory and present them.

## Conventions
- Formatting: inline styles using the C/S/R/SH tokens; keep the CSS-variable theme intact
  (don't hardcode hex where a token exists — dark mode depends on it).
- Responsive: question rows are compact rows on desktop, content-first cards below desktop.
  Use the pm-qrow / pm-qrow-main / pm-qrow-meta / pm-qrow-actions classes.
- Every mutation should call logActivity(...) so the Activity log stays complete.
- After a successful sync to the game, call db_sync.markReleased(null) to clear pending flags.
- Keep responses/docs truthful to the actual schema (query pg_proc / pg_tables to confirm).

## Testing capabilities
This environment cannot reach *.supabase.co / *.workers.dev / *.pages.dev / Firebase hosts
directly from bash. Work around it:
- **DB / SQL:** use the Supabase tools (execute_sql, apply_migration, etc.).
- **HTTP round-trips (game feed, push, any endpoint):** trigger them FROM the database with
  pg_net — \`select net.http_get('https://…/functions/v1/game-feed?health=1')\` then, after a
  few seconds, read \`select status_code, content from net._http_response where id = <n>\`. This
  lets you verify the live edge function / REST endpoints without the user. Also good for
  confirming an RPC through the real PostgREST \`/rpc\` path with the client's exact payload.
- **Rendering the app headless (yes, this works):** install react@18.3.1 + react-dom@18.3.1 +
  @babel/core + @babel/preset-react locally (KEEP a package.json in /home/claude/bt pinning
  them — a bare \`npm install X\` with no lockfile PRUNES the others and breaks the build), then
  compile the .jsx with preset-react {runtime:'classic'} and render a component with
  react-dom/server \`renderToString\` inside a vm sandbox (stub window/document/fetch/localStorage).
  This catches real runtime crashes and lets you assert on the output HTML — it found several
  bugs a grep never would.
- **Confirm the build actually rebuilt (learned the hard way):** the assemble step Babel-compiles
  the combined source; if it THROWS, it leaves the old compiled file and the HTML builder wraps the
  STALE bundle. \`node --check app.compiled.js\` still passes (checking the old valid file), so it
  does NOT catch this — a broken build can ship silently for several commits. After every build,
  verify assemble printed its success summary AND the compiled file was freshly written (mtime, or
  grep a just-added string / the bumped build stamp) before trusting anything downstream.
- Everything else: verify deterministically (component/db/rpc reference resolution, running engine
  logic in Node against real data pulled via SQL, parse each inline script via vm.Script,
  babel-parse the doc template literals to confirm they're balanced).

## Known-safe "do not touch"
- The four seeded builtin export profiles (is_builtin=true) unless explicitly asked: "Flat API
  (question list)", "Firebase (nested)", "Unity (keyed dictionary)" — the three simple ones that
  key off level/effective_level — plus "Full game export (with levels)", the reference profile
  (expand_levels + include_frames; exports template + base_sentence + per-level target + frames).
- pm_dev_notes is a singleton (id=1) — don't insert extra rows.
`;

const DOC_BUILD_PROMPT = `# Build Prompt — recreate Positive Minds CMS from scratch

Use this as a single instruction to Claude (with code execution + a fresh Supabase
project + a GitHub repo) to rebuild the entire app.

---

Build a content management web app called "Positive Minds" — a CMS for a children's
word game based on CBMT (Cognitive Bias Modification Therapy). The game is a SPELLING
puzzle: it shows a warm first-person sentence with one word partly hidden (some letters
revealed, the rest blank — e.g. "I feel PR_UD of the things I do") and offers TWO positive
words. Both words are positive (never a negative option — the therapeutic core); the child
picks the one whose SPELLING fits the revealed letters + blank shape. The primary word
(\`answer\`) fits the letter pattern; the alternate (\`alt_answer\`) is another positive word
that does NOT fit it (make it a DIFFERENT LENGTH so it can never match the fixed blanks). It
is NOT a meaning test — the letters decide which word is correct. How much is hidden is set by
the question's level. This CMS
is the authoring + publishing layer; a separate game backend consumes the content.

## Architecture requirements
- Single self-contained index.html. React 18.3.1 from unpkg (pinned UMD). NO runtime
  build step and NO in-browser Babel: author modular .jsx, then pre-compile to plain JS
  with @babel/preset-react { runtime: "classic", development: false } and concatenate.
  Cross-file components must be function declarations (hoisting); const helpers precede use.
- Backend: Supabase (Postgres + PostgREST + Edge Functions + Auth).
- Host on Cloudflare (Worker) auto-deploying from GitHub main.
- Styling: inline styles + a CSS-variable theme system for light/dark. No CSS framework.
- Include a CDN-failure fallback message and PWA (inline manifest + service worker).

## Data model (Supabase, all RLS: anon read-only, authenticated full write)
- pm_packs(id, slug unique, name, emoji, description, color, difficulty
  [basic/advanced/mixed], status [draft/published/archived], sort_order, is_custom,
  tags text[], content_version int default 1, released_version int default 0, released_at,
  timestamps)
- pm_questions(id, pack_id FK cascade, template with {blank} + optional {token} frame slots,
  answer, alt_answer, status [active/inactive], sort_order, notes, level, letter_position,
  letter_grouping, frame_slots jsonb, timestamps). No per-question difficulty or letters_hidden
  columns — the level (+ any pm_question_levels override) fully drives how much is hidden.
- pm_activity (audit log), pm_export_profiles(spec jsonb, is_builtin), pm_sync_log,
  pm_sync_targets(config jsonb), pm_dev_notes (singleton id=1)
- View pm_pack_overview: packs + active_questions + total_questions + has_pending_changes
  (content_version > released_version). Create it with security_invoker=true so it respects
  the caller's RLS (otherwise anon can read draft packs via the public API).
- Triggers: touch updated_at; bump pack content_version on any question change
- RPCs: pm_dashboard_stats, pm_search_questions(q,pack,stat,lvl,lim,off,from_date,to_date,sort) [paginated, date-filter+sort],
  pm_clone_pack(src,slug,name), pm_lint + pm_lint_details, pm_log, pm_mark_released(uuid[])
- All RPCs SECURITY INVOKER. Grants: REVOKE EXECUTE ... FROM public, anon on every real RPC and
  GRANT ... TO authenticated (only the two trigger functions stay anon-executable, and they're inert).
  Note: DROP+CREATE on a function re-grants PUBLIC by default, so re-revoke after any recreate.
- CRITICAL: paginate all list reads in 1000-row batches (restAll) — PostgREST caps at 1000.

## Auth
Single shared admin password (Supabase Auth user). Password grant → access+refresh tokens
persisted in localStorage (survives tab/browser restarts) with a 7-day window from login;
Bearer on writes; refresh the access token proactively in the background (timer + on tab
refocus) AND reactively on a 401 with one retry, falling back to login only if the refresh
token is genuinely dead or the 7 days elapse. Anon publishable key authorizes reads only.

## Features to build
1. **Dashboard/Overview:** four headline stat boxes — total packs (published/draft in subtitle),
   questions (active in subtitle), published packs (live in the game), and empty packs (need
   content) — plus a "questions by level" mini bar-chart showing the distribution across the 10
   levels in the Library-health card. Do NOT add a "levels in use / of 10" box: every question
   renders at every level, so counting distinct assigned levels is misleading. All via one RPC;
   quick actions; and a compact at-a-glance index of ALL pack names (one line each, tap to open).
2. **Library:** pack cards (emoji, color accent, status, question counts); search + status/
   difficulty filters; drag-to-reorder; clone (duplicate pack + questions); delete with
   optimistic Undo; JSON import/export that round-trips the FULL model (pack level + purpose/
   focus/style, and per-question level/position/grouping/frame_slots).
3. **Pack detail:** paginated question bank. Filters: level, WHEN-ADDED (any / 24h / 7d / 30d),
   and a sort (default order / newest first / oldest first) — all applied SERVER-SIDE in the
   question query so they span the whole pack and paginate correctly (the level filter includes
   inheritors via or=(level.eq.X,level.is.null) when X is the pack's own level). A quick text
   search stays client-side over the loaded page. Each row shows a level chip, a compact relative
   "added" stamp (full timestamp on hover), and a per-question "Levels" expander. Add/edit
   questions. The question editor is LEVEL-BASED —
   it has NO difficulty or letters-hidden controls (those are derived from the level). It offers
   the sentence template, the two positive words, a Level selector (controls letters-vs-whole-
   word), position/grouping overrides that appear only when the previewed level hides letters,
   and a "how the child sees it" preview that renders through the real level engine with a
   level-chip picker so you can flip through every level. Also: bulk import (pipe OR JSON, with
   duplicate detection); multi-select bulk activate/deactivate/delete; and **Play mode** — an
   author preview that plays the pack like a child: for each active question it renders the
   sentence at the effective level (through the shared engine) and shows the two words shuffled.
   The PRIMARY word (answer) is the correct one because its SPELLING fits the revealed letters
   (the alternate is positive too but doesn't match the blank pattern). Picking the primary shows
   "Correct! ✓" and scores a point; picking the alternate shows "Not quite — the answer is X" and
   reveals the right word (green/red button states). The done screen shows "X of Y correct". Load
   ALL active questions (paginate — do NOT cap at 100). A LEVEL FILTER at the top plays the whole
   pack at one chosen level (forcing every question to that level's blank difficulty) or "each own
   level" (default); changing it restarts the run.
4. **All questions:** server-side global search across every pack, paginated, click-through
   to the source pack. Filters: text, PACK (a dropdown of every pack, alphabetised, "All packs"
   default → the \`pack\` param on the search RPC), status, level, and WHEN-ADDED (created_at) —
   presets (last 24h / 7d / 30d) or a custom date range — plus a sort (newest first / oldest
   first / group by pack). Each row shows a compact relative "added" stamp (e.g. "3h ago",
   "2w ago", or a date), full timestamp on hover. A "Clear filters" button appears whenever any
   filter is active (resets all six). Empty state is filter-aware: distinguishes "no questions
   match these filters" (when any filter is set) from "no questions yet" (a genuinely empty library).
5. **Content health:** lint flags invalid templates (no {blank}), missing 2nd option,
   duplicates, thin packs (1–2 questions); links to fix.
6. **Publishing pipeline — the core differentiator:**
   - A **transformation engine** with user-defined "export profiles" whose spec (jsonb)
     controls output shape: structure (nested/flat/keyed), root/questions keys, field
     rename+include/exclude, per-field transforms (upper/lower/trim), value maps
     (e.g. status→a numeric code), filters, meta envelope.
   - A **profile builder** UI: visual field-mapper + raw JSON editor + live preview, all synced.
   - Seed 3 starter profiles: Firebase (nested), Flat API (flat), Unity (keyed).
   - Three channels, all emitting through a chosen profile: **File** download;
     **Feed (pull)** via a game-feed edge function serving per-profile content at a stable
     public URL (endpoints: ?profile, ?list, ?health; paginate; verify_jwt off; ~60s cache);
     **Push** POST to a configurable target.
   - **Firebase targets:** saved destinations (a table) pairing a profile with a database +
     layout. Support Realtime DB (REST), Firestore (REST with typed-value conversion), and
     Cloud Function (POST {writes,payload}). Configurable layouts (per-pack/per-question/
     single-doc) with {slug}/{id} path templates. Provide a sample Cloud Function in-app.
   - Control modes: manual / auto-on-publish / scheduled. Release state: content_version vs
     released_version → "pending changes"; a successful sync calls pm_mark_released to clear it.
   - Sync history log of every file/feed/push.
   - IMPORTANT: mirror the transform engine in the edge function; keep them identical.
6b. **Sync API for external backends (content-api edge function):** a SEPARATE edge function
   (verify_jwt off) that is the on-demand sync API for a Firebase-style backend. ONE clean shape
   (not the profile projection). Endpoints: \`?manifest=1\` (global_version + levels_version +
   per-pack version rows — a client polls this and only pulls when global_version changed);
   default (full published content: level definitions + packs with questions, each question's 10
   variations rendered by the SAME engine); \`?since=<iso|epoch>\` (incremental — packs where the
   pack OR any question changed since, returning that pack's full current questions for wholesale
   replace, PLUS a \`deletions\` array); \`?packs=\`/\`?levels=\` filters; \`?format=xml\`; \`?health=1\`.
   Put an ETag (hash of global_version + query shape) on every response and honour If-None-Match →
   304 — normalise the weak-validator \`W/\` prefix when comparing (the platform wraps bare ETags).
   Optional API-key auth via a CONTENT_API_KEY secret (X-API-Key header or ?key=); unset = public;
   CORS *. Requires: (a) a \`pm_deletions\` tombstone table (entity_type/entity_id/pack_id/slug/
   deleted_at; anon+authenticated SELECT only) written by SECURITY DEFINER triggers — before-DELETE
   on pm_packs + pm_questions AND after-UPDATE-OF-status (a pack leaving 'published' / question
   leaving 'active' writes a tombstone + bumps global_version; re-entering clears its tombstone).
   This status-transition path is REQUIRED: global_version is computed only over published/active
   rows, so without it an unpublish/deactivate would never reach a synced client. (b) a
   \`pm_content_manifest()\` SECURITY DEFINER RPC (published-only) returning the global/per-pack
   versions. The rendering engine (maskWord/resolveSlots/
   resolveFrameMap/buildLevelVariants) MUST stay byte-identical to the client and game-feed.
7. **Activity log:** every mutation recorded (who/what/when) via pm_log.
8. **Developer Notes page:** hardcoded architecture doc + CLAUDE.md + this build prompt,
   each viewable with copy + download, plus an editable scratchpad saved to pm_dev_notes.
   These docs MUST be kept in sync with the app on every subsequent change.
9. **Levels (progression structure, EXPANDABLE 1–100):** a pm_levels table defining the levels
   (ship with 1–10; support adding more above the top, CHECK ceiling 100 on pm_levels.level AND
   pm_questions.level AND pm_question_levels.level). Each level has a name, tagline, letter-hiding
   rule, word-length/complexity rule, emotional theme, age hint, hidden_mode (hide some letters vs
   the whole word), letters_hidden_default, letter_position, letter_grouping, color, AND vocabulary
   rules — min_word_len, max_word_len, allow_multiword, vocab_rule (free text) — that shape which
   ANSWER words the level uses (they drive the generator + display intent; the masking engine
   ignores them; CHECK min<=max when both set). The LEVEL NUMBER itself is the difficulty — do NOT
   add a separate basic/advanced tier. Packs carry a default \`level\`; questions have a nullable
   \`level\` override (null = inherit the pack). Build a dedicated Levels page to view/edit each
   definition AND to ADD a new level above the current top (button "Add level N", pre-filled from
   the current top level's rules) and DELETE the top level (highest only, to keep the ladder
   contiguous; guard with a confirm noting pinned questions/overrides should be moved first). Each
   level card must make the rule LEGIBLE: a plain-English summary derived from the actual mechanical
   fields AND a live "Looks like" sample word masked through the real maskWord engine, plus
   word-band / multi-word badges. CRUCIAL INVARIANT: adding a level row is sufficient for it to
   render everywhere (CMS previews + BOTH feeds) — nothing is pre-materialized; the shared engine
   derives every level on demand from pm_levels, so a new level instantly applies to every question.
   Never infer a level's mode from its number (no "level>=7 ⇒ whole word" shortcuts anywhere,
   including preview fallbacks). Also a level chip on pack cards and question rows, and level
   selectors in the pack and question editors. The question-search RPC returns the effective level
   (coalesce question→pack). Add a Level filter to the question bank, the in-pack list, and the pack
   library. GENERATING questions for a level: the AI generator prompt must include each target
   level's word-length band, multi-word allowance, and vocab_rule (and a reminder both answers stay
   in-band yet differ in length so only one fits). DERIVING for existing content: a "Derive level"
   pack action materializes editable pm_question_levels rows for a chosen level across all active
   questions (apply that level's masking rule to each word; skip-or-overwrite existing rows; chunk
   the upserts), for when concrete per-question rows are wanted to hand-tune.
10. **Blank-shape control:** each level (and per-question override) also controls WHERE the
   missing letters sit (letter_position: start/middle/end/random) and whether multiple hidden
   letters are grouped or spread (letter_grouping). A single maskWord(word, letters, position,
   grouping) generates the actual blank and MUST be the one source of truth used by every
   preview, row, PlayMode, and the export/feed. "random" must be DETERMINISTIC (seed from the
   word) so it's stable across renders and matches the game. Every preview ("how the child
   sees it") reflects the real shape.
11. **Questions are multi-level concepts:** every question auto-renders every level (one per pm_levels row) — the
   same question at each level's blank difficulty (buildLevelVariants derives them from the
   question + level rules; no row duplication). The question bank keeps flat rows with a
   "Levels" expand toggle revealing all 10 variants. Any individual level can be edited
   (override sentence/word/letters/position/grouping, or disabled for that concept), stored in
   a pm_question_levels table (a row exists only where edited; absent = auto). A Reset returns
   a level to auto. Cloning a pack must copy level data + these overrides.
12. **Export must carry levels, in JSON and XML:** the transform engine's field mapper must
   expose level, effective_level, letter_position, letter_grouping. A profile flag
   \`expand_levels\` attaches a \`levels\` array to each question — for every level: the resolved
   sentence, the blank shape, an explicit \`target\` object (the guess word: word, altWord,
   blankShape, wholeWord, lettersHidden, position, grouping) so the game never parses the
   sentence, and a \`frames\` map (token -> resolved word). Questions expose BOTH a raw
   \`template\` (with {tokens}) and a resolved \`base_sentence\`. An optional flag
   \`include_frames\` attaches the raw frame config so the game can vary swappable words itself.
   Provide a ready-made "Full game export (with levels)" starter profile. Offer BOTH JSON and
   XML output (a toXml serializer with sane singular tags + escaping); the pull-feed accepts
   ?format=xml. The client engine and the edge function must stay byte-identical (maskWord,
   resolveSlots, resolveFrameMap, buildLevelVariants, toXml, the expand logic) — hard invariant.
13. **Structured pack descriptions:** each pack has purpose, focus_areas, style_approach,
   and example_objectives (beyond the short card blurb). Show them as an "About this pack"
   panel on the pack page, edit them in the pack editor, and expose them in the field mapper
   so they can be exported to the game. Offer an AI "draft" button (via a server-side edge
   function proxying Anthropic) that generates a first draft grounded in the pack's name,
   theme, and words, which the user then edits. Surface the purpose at a glance on the Library
   pack cards too — reveal Purpose + Focus areas on hover (desktop) or via an ⓘ toggle (touch),
   without opening the pack; keep the card compact by default.
14. **Live sync (realtime):** open sessions across devices/browsers must update automatically
   when anyone edits data — no manual refresh, so simultaneous editors don't work off stale
   views or duplicate effort. Connect to Supabase Realtime (a lean websocket client is fine;
   no SDK required) and subscribe to postgres_changes on the content tables; on a change,
   debounce and reload the affected lists (pack overview, the open pack's question list, the
   global question search, levels). Show a "Live/Offline" status badge in the header, and
   auto-reconnect (and re-subscribe) when the tab regains focus. Enable the Realtime
   publication on those tables server-side.
15. **Frame-word variations:** the sentence template may contain swappable {token} words other
   than {blank} (which stays the word the child guesses). Store a \`frame_slots\` jsonb on the
   question: per token, a \`pool\` of alternatives + an optional \`byLevel\` pin map. Render per
   level: a pinned word wins, else a DETERMINISTIC seeded pick from the pool (stable + identical
   client/edge), else the bare token. This lets levels 7–10 differ even when the blank is a
   whole word (e.g. "…things get {hard}" → difficult/stressful/challenging across levels). The
   question editor auto-detects {tokens} and offers a pool editor + per-level pin grid. Keep
   the resolver byte-identical between the client engine and the game-feed edge function.
16. **Content Generator (AI prompt builder):** a page that assembles a ready-to-paste prompt
   for an external AI tool to author a batch of questions in the app's format. The user picks a
   pack (which pre-fills themes from the pack's focus/purpose, all editable), selects which
   levels to target, describes themes, sets a count, chooses the output format each time (an
   import-ready JSON, a simple pipe format, or a review table), and optionally toggles
   frame-word instructions on. The generated prompt must teach the CBMT philosophy, the
   {blank}-target rule, and — critically — the SPELLING-PUZZLE rule for the two words: both must
   be genuinely positive, but only the primary spells into the revealed letters; the alternate
   is a positive word that must NOT fit the blank's letter pattern. The reliable way to guarantee
   that is to make the alternate a DIFFERENT LENGTH from the primary (a different-length word can
   never match the fixed blank shape at any level). It must NOT be a meaning test and the two
   words must NOT be near-synonyms that both fit — the letters decide. The prompt also teaches
   the chosen level context, the frame-word
   {token} system (when toggled), and end with the exact output shape plus a concrete example.
   It live-updates as controls change and offers one-click copy. The bulk importer must accept
   the same JSON shape (including frame_slots) so the generate → paste-into-AI → import loop is
   closed. The generator should also (a) offer a standalone, reusable "master context" document
   — the full CBMT background — with copy, plus a toggle to fold a compact version into the
   prompt; and (b) help avoid regenerating existing content: a toggle that loads the selected
   pack's questions and appends an "already covered — do not repeat" list (answer words +
   sentence signatures) to the prompt. As a second line of defense, the bulk importer must flag
   duplicates against the pack's existing questions — exact (same normalized sentence + answer,
   punctuation-insensitive, and repeats within the pasted batch) vs similar (same sentence or
   same answer word) — defaulting exact to skip and similar to keep-but-flagged, with a per-row
   skip/keep control so the user decides.

## UX / cross-cutting
- Dark mode (light/dark/system, persisted, CSS variables). Command palette (⌘/Ctrl-K):
  fuzzy nav/actions/theme/jump-to-pack. Styled confirm dialogs (no native confirm()).
  Focus trap + Escape on modals, ARIA dialog roles, visible focus rings. Toasts with
  actions, skeletons, empty/error states. URL-HASH ROUTING (encode the current section +
  open pack in location.hash; read it on load so a refresh restores the view and pack URLs
  are deep-linkable; a hashchange listener drives Back/Forward). Sync document.title to the view.
- **Accessibility:** every text color must meet WCAG AA against its background (don't use a
  grey lighter than ~4.5:1 for text). Inputs use the panel background (not hardcoded white,
  which breaks dark mode) with an explicit readable ::placeholder color so search fields are
  legible while typing.
- Responsive: sidebar (desktop) / icon rail (tablet) / bottom-tab bar (phone). Question
  rows are compact single-lines on desktop and content-first CARDS below desktop (sentence
  hero on top, meta+actions footer, checkbox in the corner). 16px inputs, bottom-sheet
  modals on phone, prefers-reduced-motion respected. A small BUILD STAMP (from a bumped
  CFG.build constant) sits in the sidebar footer so a stale cached build is obvious at a glance.

## Build & verify discipline
Edit modular files, not compiled output. Rebuild with the assemble + build-html scripts.
CRITICAL: the assemble step Babel-compiles the combined source — if it throws, it leaves the
OLD compiled file in place and the HTML builder happily wraps the stale bundle. \`node --check\`
on the compiled JS will still PASS (it's checking the old valid file), so it will NOT catch a
broken build. After every build you MUST confirm assemble printed its success summary AND that
the compiled output was freshly written (check its mtime, or grep for a string you just added,
or bump+grep the build stamp). Only then: confirm every JSX component/db call/RPC resolves;
parse each inline <script>; babel-parse the doc template literals to confirm they're balanced
(raw backticks inside a doc string must be escaped). Test DB (RPCs, RLS) against the live
project; test HTTP endpoints via pg_net → net._http_response; render components headless with
react-dom/server to catch runtime crashes. Deploy by pushing to main (Cloudflare auto-builds);
bump CFG.build each deploy. Verify empirically — never assert a capability works without
testing it.
`;

// ===== devnotes.jsx =====
// ============================================================
// Developer Notes page — three reference docs + editable scratchpad
// ============================================================
const db_notes = {
  get: () => rest("pm_dev_notes?id=eq.1&limit=1").then(r => r.data?.[0]?.content ?? ""),
  save: (content) => rest("pm_dev_notes?id=eq.1", { method: "PATCH", body: { content, updated_at: new Date().toISOString() } }),
};

const DEV_DOCS = [
  { id: "architecture", label: "Architecture & Structure", file: "ARCHITECTURE.md", icon: "🗂", body: DOC_ARCHITECTURE, desc: "Complete technical reference: modules, data model, engine, channels, build." },
  { id: "claude_md", label: "CLAUDE.md", file: "CLAUDE.md", icon: "📘", body: DOC_CLAUDE_MD, desc: "Conventions & rules for AI assistants working on this codebase." },
  { id: "build_prompt", label: "Build Prompt", file: "BUILD_PROMPT.md", icon: "🛠", body: DOC_BUILD_PROMPT, desc: "A single prompt to recreate this entire app from scratch in Claude." },
];

const downloadText = (filename, text) => {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

function DeveloperNotes() {
  const [active, setActive] = useState("architecture");
  const [copied, setCopied] = useState(false);

  // scratchpad
  const [notes, setNotes] = useState(null);
  const [saved, setSaved] = useState(true);
  const [savingState, setSavingState] = useState("");
  const saveTimer = useRef(null);

  useEffect(() => { db_notes.get().then(c => setNotes(c)).catch(() => setNotes("")); }, []);

  const onNotesChange = (val) => {
    setNotes(val); setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSavingState("saving");
      try { await db_notes.save(val); setSaved(true); setSavingState("saved"); setTimeout(() => setSavingState(""), 1500); }
      catch { setSavingState("error"); }
    }, 800);
  };

  const doc = active === "scratchpad" ? null : DEV_DOCS.find(d => d.id === active);
  const copy = () => { if (doc) { navigator.clipboard?.writeText(doc.body); setCopied(true); setTimeout(() => setCopied(false), 1500); } };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Developer notes</h1>
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Reference documentation and a shared scratchpad for this project.</p>
      </div>

      {/* doc tabs */}
      <div className="pm-dev-tabs" style={{ display: "flex", gap: 8, marginBottom: S.lg, flexWrap: "wrap" }}>
        {DEV_DOCS.map(d => (
          <button key={d.id} onClick={() => setActive(d.id)} style={docTabStyle(active === d.id)}>
            <span style={{ fontSize: 16 }}>{d.icon}</span>{d.label}
          </button>
        ))}
        <button onClick={() => setActive("scratchpad")} style={docTabStyle(active === "scratchpad")}>
          <span style={{ fontSize: 16 }}>✎</span>Scratchpad
        </button>
      </div>

      {doc ? (
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: `${S.md + 2}px ${S.lg}px`, borderBottom: "1px solid " + C.line, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink }}>{doc.file}</div>
              <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>{doc.desc}</div>
            </div>
            <Btn variant="ghost" size="sm" onClick={copy}>{copied ? "Copied ✓" : "⧉ Copy"}</Btn>
            <Btn variant="soft" size="sm" onClick={() => downloadText(doc.file, doc.body)}>⭳ Download</Btn>
          </div>
          <pre style={{ margin: 0, padding: S.lg, fontSize: 12.5, lineHeight: 1.6, color: C.ink2, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", maxHeight: "62vh", overflowY: "auto" }}>{doc.body}</pre>
        </div>
      ) : (
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: `${S.md + 2}px ${S.lg}px`, borderBottom: "1px solid " + C.line }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink }}>Shared scratchpad</div>
              <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>Free-form notes, saved automatically. Visible to anyone with access.</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: savingState === "error" ? C.danger : savingState === "saving" ? C.faint : saved ? C.good : C.faint }}>
              {savingState === "error" ? "Save failed" : savingState === "saving" ? "Saving…" : saved ? "Saved" : "Unsaved"}
            </span>
          </div>
          {notes === null ? <div style={{ padding: S.xl }}><Spinner label="Loading notes…" /></div> : (
            <>
              <Textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} rows={16}
                placeholder="Jot down TODOs, decisions, credentials to rotate, ideas…"
                style={{ border: "none", borderRadius: 0, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.6 }} />
              {savingState === "error" && <div style={{ padding: "8px 16px" }}><Btn variant="ghost" size="sm" onClick={() => onNotesChange(notes)}>Retry save</Btn></div>}
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: S.md, fontSize: 12, color: C.faint }}>
        Docs are embedded in the build (always current with this version). The scratchpad is stored in the database.
      </div>
    </div>
  );
}

const docTabStyle = (on) => ({
  display: "flex", alignItems: "center", gap: 8, padding: "9px 15px", borderRadius: R.md,
  border: "1px solid " + (on ? C.brand : C.line), background: on ? C.brandSoft : C.panel,
  color: on ? C.brandInk : C.ink2, cursor: "pointer", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700,
});

// ===== levels.jsx =====
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
  overridesForPackLevel: (questionIds, level) => {
    if (!questionIds.length) return Promise.resolve([]);
    const list = questionIds.join(",");
    return rest(`pm_question_levels?level=eq.${level}&question_id=in.(${list})&select=question_id&limit=10000`).then(r => r.data || []);
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
function LevelsView() {
  const { loading, error, data, reload } = useAsync(() => db_levels.list(), []);
  const [edit, setEdit] = useState(null);      // an existing level being edited
  const [creating, setCreating] = useState(null); // a new (unsaved) level draft
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const levels = data || [];
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
          <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>The game's progression structure. Each level defines how words are hidden, which words to use, and its theme. Add levels above the current top to extend the ladder.</p>
        </div>
        <Btn onClick={startCreate}>+ Add level {nextLevel <= 100 ? nextLevel : ""}</Btn>
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
      await onSave(level.level, {
        name: f.name, tagline: f.tagline, letters_rule: f.letters_rule, word_rule: f.word_rule,
        theme: f.theme, age_hint: f.age_hint, hidden_mode: f.hidden_mode,
        letters_hidden_default: f.letters_hidden_default, letter_position: f.letter_position,
        letter_grouping: f.letter_grouping, color: f.color,
        min_word_len: f.min_word_len === "" || f.min_word_len == null ? null : parseInt(f.min_word_len),
        max_word_len: f.max_word_len === "" || f.max_word_len == null ? null : parseInt(f.max_word_len),
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
              <button key={c} onClick={() => set("color", c)} style={{ width: 30, height: 30, borderRadius: R.sm, cursor: "pointer", background: c, border: "3px solid " + (f.color === c ? C.ink : "transparent") }} />
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

  const activeQs = (questions || []).filter(q => q.status === "active");
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
      // Build override rows: pin the computed letters/position/grouping so the row is concrete
      // and editable, but leave template/answer/alt null so they still inherit the concept.
      const rows = targets.map(q => {
        const v = buildLevelVariants(q, [lvlDef], {})[0];
        const whole = v?.target?.wholeWord;
        return {
          question_id: q.id, level: targetLevel,
          template: null, answer: null, alt_answer: null,
          letters_hidden: whole ? (q.answer || "").length : (v?.letters ?? lvlDef.letters_hidden_default ?? 1),
          letter_position: lvlDef.letter_position || null,
          letter_grouping: lvlDef.letter_grouping || null,
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

// ===== generator.jsx =====
// ============================================================
// Content Generator — builds a ready-to-paste AI prompt for creating
// a batch of questions in our exact format, based on the selected
// pack, levels, themes, output format, and options.
// ============================================================

const miniLink = { background: "none", border: "none", padding: "2px 4px", cursor: "pointer", color: C.brandInk, fontSize: 12, fontWeight: 700 };

// The standalone, reusable background document. Gives an AI the full "why" behind the game so
// it authors on-model content rather than pattern-matching. Paste once alongside any prompt.
const MASTER_CONTEXT = `# Positive Minds — Background & Authoring Context

## What this is
Positive Minds is a word game for children (roughly ages 5–12) built on **Cognitive Bias Modification Therapy (CBMT)**. The premise of CBMT is simple but powerful: the thoughts a child rehearses shape the thoughts that come automatically. By having children repeatedly complete warm, self-affirming sentences, the game gently trains a more positive, resilient internal voice — building the habit of thinking well of themselves and the world.

## The core mechanic
Each question is a short, first-person sentence with one word partly hidden — some of its letters are revealed and the rest are shown as blanks (e.g. "I feel PR_UD of the things I do"). The child chooses between **two words. Both are positive** — there is never a negative or "wrong feeling" option — and the child's job is to pick the word whose **spelling fits the revealed letters and the blank shape**. The primary word (the answer) spells into the pattern; the second word is another warm, positive word that does **not** fit those letters. This is a SPELLING / word-recognition puzzle, NOT a meaning test — both words can make sense in the sentence; the LETTERS are what decide which is correct. Example: shown "I feel PR_UD…", the options might be PROUD and GLAD — both lovely, but only PROUD spells into P-R-_-U-D.

## Why both words are positive (spelling decides, not meaning)
This is the therapeutic heart of the design and must never be broken. Every word on screen is something good, so even a wrong guess never rehearses a harmful thought. What makes it a real game is the SPELLING: only one word matches the letters revealed in the blank. The reliable way to make the second word clearly wrong is to give it a **different length** from the primary — a different-length word can never fit the fixed blanks at any level. Do NOT rely on meaning to separate them and do NOT use near-synonyms of the same length: if both could spell into the pattern, the puzzle has two answers. So "wrong" only ever means "that positive word isn't spelled the way the blanks are" — never "you had a bad feeling" or "you failed."

## Who the child is
Assume a child who may be shy, anxious, still building confidence, or simply learning emotional vocabulary. The tone is warm, safe, and encouraging — like a kind adult who believes in them. Never clinical, never scary, never shaming. Nothing that references the child doing something wrong, being in danger, or failing. Language is simple and concrete; words are ones a child that age would recognise and be able to spell.

## Developmental progression (levels)
Content spans developmental levels, from very simple self-affirmations for the youngest ("I am {blank}" → HAPPY / GLAD) up to more nuanced emotional regulation for older children ("I can stay {blank} even when things feel unfair" → CALM / STEADY). Early levels use short, common words and the simplest feelings (confidence, kindness, happiness). Later levels introduce resilience, gratitude, empathy, moral reasoning, and self-regulation. The **game itself** controls how much of the word is hidden at each level — so an author does not need to vary the blank's difficulty, only to write sentences and word-pairs appropriate to the level's theme and age.

## Themes worth covering
Confidence and self-worth · kindness and caring for others · courage and trying new things · honesty · friendship and belonging · gratitude · patience · resilience and coping with hard feelings · respect · empathy · calm and self-regulation · hope and optimism. Each pack usually centres on one theme.

## What makes a GOOD question
- A warm, natural, first-person sentence ("I am…", "I feel…", "Being…", "I can…").
- Exactly one {blank}, placed where a feeling/quality word belongs.
- Two positive answer words that BOTH fit naturally and are genuinely age-appropriate.
- Answer words: single words, uppercase, spellable, common for the age.
- Emotionally true — a child could mean it and feel good saying it.

## What to AVOID
- Any negative, frightening, sad, or clinical framing.
- Any implication the child did something wrong or is at fault.
- Obscure or hard-to-spell words; multi-word answers.
- Two words where one is clearly better than the other (both should be valid).
- Repeating a question the pack already covers (see the "already covered" list when provided).

## Optional: frame words
Some sentences include a second braced word besides {blank} — e.g. "…when things are {hard}". These "frame words" are NOT guessed; they exist so the sentence can be varied for freshness or made gently more advanced at higher levels (hard → difficult → challenging). They are always neutral-to-mild and never undo the positivity of the sentence.

Keep all of the above in mind when authoring. The goal is not just correct puzzles — it is small, repeated moments that leave a child feeling a little braver, kinder, and more capable.`;

// Output-format templates. Each returns the instruction text + a concrete example
// so the AI knows precisely what to emit. Import-ready formats mirror BulkImport.
const OUTPUT_FORMATS = {
  json: {
    label: "JSON (import-ready)",
    hint: "A JSON array — paste straight into Bulk import.",
    instruct: (withFrames) => withFrames
      ? `Return ONLY a JSON array (no prose, no markdown fences). Each item:
{
  "template": "sentence with {blank} for the guess word, and optional {token} words to vary",
  "answer": "PRIMARYWORD",
  "alt_answer": "SECONDWORD",
  "frame_slots": {
    "token": { "pool": ["word1","word2","word3"], "byLevel": { "7": "word1", "8": "word2" } }
  }
}
Omit "frame_slots" for questions with no swappable words.`
      : `Return ONLY a JSON array (no prose, no markdown fences). Each item:
{ "template": "sentence with {blank} where the guess word goes", "answer": "PRIMARYWORD", "alt_answer": "SECONDWORD" }`,
    example: (withFrames) => withFrames
      ? `[
  {
    "template": "I stay {blank} even when things are {hard}.",
    "answer": "CALM",
    "alt_answer": "CENTERED",
    "frame_slots": { "hard": { "pool": ["hard","difficult","stressful","challenging"], "byLevel": { "7":"difficult","8":"stressful","9":"challenging" } } }
  },
  { "template": "I am {blank} when I try new things.", "answer": "BRAVE", "alt_answer": "BOLD" }
]`
      : `[
  { "template": "I am {blank} when I try new things.", "answer": "BRAVE", "alt_answer": "BOLD" },
  { "template": "Being {blank} helps me make friends.", "answer": "KIND", "alt_answer": "CARING" }
]`,
  },
  pipe: {
    label: "Pipe (simple)",
    hint: "One line each: sentence | ANSWER | ALT. Easiest to read; import-ready.",
    instruct: () => `Return ONLY plain lines, one question per line, in this exact shape:
Sentence with {blank} | PRIMARYWORD | SECONDWORD
No numbering, no bullet points, no extra prose.`,
    example: () => `I am {blank} when I try new things. | BRAVE | BOLD
Being {blank} helps me make friends. | KIND | CARING
It feels good to be {blank} to others. | HELPFUL | HONEST`,
  },
  table: {
    label: "Table (review-friendly)",
    hint: "A markdown table you can eyeball before converting.",
    instruct: () => `Return ONLY a markdown table with columns: Sentence | Primary word | Second word.
The Sentence must contain {blank} where the guess word goes.`,
    example: () => `| Sentence | Primary word | Second word |
|---|---|---|
| I am {blank} when I try new things. | BRAVE | BOLD |
| Being {blank} helps me make friends. | KIND | CARING |`,
  },
};

// The core: assemble the full prompt from the chosen options.
// Build a compact "already covered — avoid these" section from the pack's existing questions,
// so the AI steers away from duplicates. We give the answer words (the concepts already used)
// plus a short signature of each sentence, rather than the full objects, to keep it light.
function buildAvoidList(existingQuestions) {
  const qs = existingQuestions || [];
  if (!qs.length) return "";
  const answers = new Set();
  const sigs = [];
  for (const q of qs) {
    if (q.answer) answers.add(q.answer.toUpperCase());
    if (q.alt_answer) answers.add(q.alt_answer.toUpperCase());
    // A readable signature: the sentence with the blank shown as ___, trimmed.
    const sig = (q.template || "").replace(/\{blank\}/g, "___").replace(/\{([a-zA-Z][\w-]*)\}/g, "$1").trim();
    if (sig) sigs.push(sig);
  }
  const lines = [];
  lines.push(`ALREADY COVERED — DO NOT REPEAT THESE:`);
  lines.push(`This pack already contains ${qs.length} question${qs.length === 1 ? "" : "s"}. Do NOT reproduce any of them, and avoid trivial rewordings. Produce genuinely new sentences and, where possible, fresh answer words.`);
  if (answers.size) lines.push(`Answer words already used (prefer different words): ${[...answers].sort().join(", ")}.`);
  if (sigs.length) {
    // Cap the sentence list so a large pack doesn't bloat the prompt or bury the instructions.
    // The answer-word list above is the compact, high-value dedup signal; sentences are a bonus.
    const SIG_CAP = 120;
    const shown = sigs.slice(0, SIG_CAP);
    lines.push(`Existing sentences${sigs.length > SIG_CAP ? ` (showing ${SIG_CAP} of ${sigs.length})` : ""} (do not duplicate these):`);
    for (const s of shown) lines.push(`- ${s}`);
    if (sigs.length > SIG_CAP) lines.push(`- …and ${sigs.length - SIG_CAP} more. Avoid close variations of any sentence in this pack.`);
  }
  return lines.join("\n");
}

function buildGeneratorPrompt({ pack, levels, selectedLevels, themes, count, format, withFrames, extraNotes, existingQuestions, includeContext, avoidExisting }) {
  const fmt = OUTPUT_FORMATS[format] || OUTPUT_FORMATS.json;
  const levelDefs = (levels || []).filter(l => selectedLevels.includes(l.level)).sort((a, b) => a.level - b.level);

  const lines = [];
  lines.push(`You are helping author content for "Positive Minds", a Cognitive Bias Modification Therapy (CBMT) word game for children roughly aged 5–12.`);
  lines.push("");
  if (includeContext) {
    lines.push(`BACKGROUND (why this matters): CBMT works on the principle that the thoughts a child rehearses become the thoughts that come automatically. Every question shows a warm, first-person sentence with one word partly hidden (some letters shown, the rest blank) and offers TWO positive words — so even a wrong guess never rehearses a harmful thought. It is a SPELLING puzzle: the child picks the word whose letters fit the revealed pattern. Only the primary word spells into the blanks; the other is positive too but does not match the letters. The tone is warm and encouraging, never shaming; a wrong pick just means "that word isn't spelled like the blanks", never that the child failed. Words are simple, common, and spellable for the age.`);
    lines.push("");
  }
  lines.push(`THE GAME MECHANIC: each question is a short, positive first-person sentence with one word partly hidden — some letters revealed, the rest shown as blanks. The child picks, from TWO positive words, the one whose SPELLING fits the revealed letters + blank shape. BOTH words are positive (never a negative option); only the PRIMARY word spells into the pattern. The second word is positive too but must NOT fit the letters. This is a spelling/word-recognition puzzle, NOT a meaning test. Write the target word normally; the {blank} token marks where it goes.`);
  lines.push("");

  // Pack context
  lines.push(`PACK: ${pack?.name || "(unspecified)"}`);
  if (pack?.emoji) lines.push(`Theme emoji: ${pack.emoji}`);
  if (themes?.trim()) lines.push(`Focus / themes to cover: ${themes.trim()}`);
  if (pack?.purpose) lines.push(`Pack purpose: ${pack.purpose}`);
  if (pack?.style_approach) lines.push(`Tone & approach: ${pack.style_approach}`);
  lines.push("");

  // Level guidance
  if (levelDefs.length) {
    lines.push(`TARGET LEVELS: write questions suitable across these developmental levels:`);
    for (const l of levelDefs) {
      const bits = [`Level ${l.level}${l.name ? ` (${l.name})` : ""}`];
      if (l.theme) bits.push(l.theme);
      if (l.age_hint) bits.push(`ages ${l.age_hint}`);
      lines.push(`- ${bits.join(" — ")}`);
      // Per-level word constraints so generated words actually fit the level's rules.
      const wc = [];
      if (l.min_word_len && l.max_word_len) wc.push(`answer words ${l.min_word_len}–${l.max_word_len} letters long`);
      else if (l.min_word_len) wc.push(`answer words at least ${l.min_word_len} letters`);
      else if (l.max_word_len) wc.push(`answer words at most ${l.max_word_len} letters`);
      if (l.allow_multiword) wc.push(`two-word answers or short phrases are allowed`);
      else wc.push(`single words only`);
      if (l.vocab_rule) wc.push(l.vocab_rule);
      if (wc.length) lines.push(`    · words for L${l.level}: ${wc.join("; ")}.`);
      // Remind that BOTH answer words must obey the band AND differ in length from each other.
      if (l.min_word_len || l.max_word_len) lines.push(`    · both the primary AND the alternate for L${l.level} must fall in that length band, while still differing in length from EACH OTHER so only one fits the blanks.`);
    }
    lines.push(`The same question can work across levels; the game itself controls how much of the word is hidden per level. Focus on writing sentences and word-pairs that match each level's theme, age, and the word constraints above.`);
    lines.push("");
  }

  // Rules
  lines.push(`RULES (important):`);
  lines.push(`1. Every sentence must contain exactly one {blank}.`);
  lines.push(`2. Provide TWO answer words, both genuinely positive and age-appropriate. The FIRST (primary) word is the correct answer — it is the word the sentence is really about. The SECOND word must be another positive word whose SPELLING does NOT fit the primary's blank pattern — the simplest reliable way is to make it a DIFFERENT LENGTH from the primary (a different-length word can never match the fixed blanks at any level). Do NOT make them the same length near-synonyms; if both could spell into the pattern the question has two answers. Example: primary PROUD (5) with alternate GLAD (4) — both positive, different lengths, so only PROUD fits "PR_UD".`);
  const anyMultiword = levelDefs.some(l => l.allow_multiword);
  lines.push(anyMultiword
    ? `3. Answer words are UPPERCASE, no punctuation. Single words by default; where a level's rules allow it, a two-word answer or short phrase is fine (still make the primary and alternate different lengths so only one fits the blanks). Prefer words a child at that level would know.`
    : `3. Answer words are single words, UPPERCASE, no punctuation. Prefer common words a child would know; keep them short enough to spell.`);
  lines.push(`4. Sentences are warm, simple, first-person ("I am…", "I feel…", "Being…"), and self-affirming.`);
  lines.push(`5. Avoid anything scary, negative, clinical, or that references the child doing something wrong.`);
  lines.push(`6. No duplicates; vary the sentence structure.`);

  if (withFrames) {
    lines.push("");
    lines.push(`FRAME WORDS (optional variation): besides {blank}, a sentence may include other words in braces, like {hard}, that are NOT guessed but can be swapped for variety. For any such word, provide a "frame_slots" entry: a "pool" of positive-appropriate alternatives, and optionally a "byLevel" map pinning a specific alternative to specific levels (useful so higher levels feel more advanced). Example: "…when things are {hard}" with pool ["hard","difficult","stressful","challenging"]. Only add frame words where they genuinely add value; most questions won't need them.`);
  }

  if (extraNotes?.trim()) {
    lines.push("");
    lines.push(`ADDITIONAL INSTRUCTIONS: ${extraNotes.trim()}`);
  }

  if (avoidExisting) {
    const avoid = buildAvoidList(existingQuestions);
    if (avoid) { lines.push(""); lines.push(avoid); }
  }

  lines.push("");
  lines.push(`HOW MANY: produce ${count} questions.`);
  lines.push("");
  lines.push(`OUTPUT FORMAT:`);
  lines.push(fmt.instruct(withFrames));
  lines.push("");
  lines.push(`EXAMPLE OF THE EXACT OUTPUT SHAPE:`);
  lines.push(fmt.example(withFrames));

  return lines.join("\n");
}

function GeneratorView({ packs, levels }) {
  const realLevels = (levels && levels.length) ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }));
  const [packId, setPackId] = useState("");
  const pack = (packs || []).find(p => p.id === packId) || null;

  const [selectedLevels, setSelectedLevels] = useState([]);
  const [themes, setThemes] = useState("");
  const [count, setCount] = useState(15);
  const [format, setFormat] = useState("json");
  const [withFrames, setWithFrames] = useState(false);
  const [extraNotes, setExtraNotes] = useState("");
  const [copied, setCopied] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [avoidExisting, setAvoidExisting] = useState(true);
  const [existingQuestions, setExistingQuestions] = useState([]);
  const [loadingQs, setLoadingQs] = useState(false);
  const [showContextDoc, setShowContextDoc] = useState(false);
  const [ctxCopied, setCtxCopied] = useState(false);

  // When a pack is chosen, pre-fill themes from its focus areas (editable) and load its
  // existing questions so we can build an "avoid these" list. A ref guards against
  // out-of-order responses when the user switches packs quickly.
  const latestPackReq = useRef(null);
  const applyPack = async (id) => {
    setPackId(id);
    const p = (packs || []).find(x => x.id === id);
    if (p) {
      setThemes(p.focus_areas || p.purpose || "");
      if (selectedLevels.length === 0 && p.level) setSelectedLevels([p.level]);
    }
    setExistingQuestions([]);
    latestPackReq.current = id;
    if (!id) { setLoadingQs(false); return; }
    setLoadingQs(true);
    try { const qs = await db.allQuestionsForPack(id); if (latestPackReq.current === id) setExistingQuestions(qs || []); }
    catch { if (latestPackReq.current === id) setExistingQuestions([]); }
    finally { if (latestPackReq.current === id) setLoadingQs(false); }
  };

  const toggleLevel = (lvl) => setSelectedLevels(s => s.includes(lvl) ? s.filter(x => x !== lvl) : [...s, lvl].sort((a, b) => a - b));
  const allLevels = () => setSelectedLevels(realLevels.map(l => l.level));
  const noLevels = () => setSelectedLevels([]);

  const prompt = useMemo(
    () => buildGeneratorPrompt({ pack, levels: realLevels, selectedLevels, themes, count, format, withFrames, extraNotes, existingQuestions, includeContext, avoidExisting }),
    [pack, realLevels, selectedLevels, themes, count, format, withFrames, extraNotes, existingQuestions, includeContext, avoidExisting]
  );

  const copyContextDoc = async () => {
    try { await navigator.clipboard.writeText(MASTER_CONTEXT); setCtxCopied(true); setTimeout(() => setCtxCopied(false), 1800); notify("Context document copied"); }
    catch { notify("Couldn't copy — select and copy manually", { kind: "error" }); }
  };

  const copyPrompt = async () => {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1800); notify("Prompt copied"); }
    catch { notify("Couldn't copy — select and copy manually", { kind: "error" }); }
  };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Content generator</h1>
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5, lineHeight: 1.5, maxWidth: 640 }}>
          Build a ready-to-paste prompt for an AI tool. Pick a pack, choose levels and themes, and copy the prompt — the AI returns a batch of questions in a format you can bulk-import.
        </p>
      </div>

      <div className="pm-gen-grid" style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: S.lg, alignItems: "start" }}>
        {/* Controls */}
        <div style={{ display: "grid", gap: S.lg }}>
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, display: "grid", gap: S.md }}>
            <Field label="Pack" hint="Pre-fills themes and context from the pack">
              <Select value={packId} onChange={(e) => applyPack(e.target.value)}>
                <option value="">Choose a pack…</option>
                {(packs || []).map(p => <option key={p.id} value={p.id}>{p.emoji ? p.emoji + " " : ""}{p.name}</option>)}
              </Select>
            </Field>

            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink2 }}>Levels to target</span>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={allLevels} style={miniLink}>All</button>
                <button type="button" onClick={noLevels} style={miniLink}>None</button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {realLevels.map(l => {
                  const on = selectedLevels.includes(l.level);
                  return (
                    <button key={l.level} type="button" onClick={() => toggleLevel(l.level)} title={l.name || `Level ${l.level}`}
                      style={{ padding: "5px 11px", borderRadius: R.pill, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                        border: "1px solid " + (on ? (l.color || C.brand) : C.line),
                        background: on ? (l.color || C.brand) + "1E" : "transparent",
                        color: on ? (l.color || C.brandInk) : C.sub }}>
                      L{l.level}
                    </button>
                  );
                })}
              </div>
              {selectedLevels.length === 0 && <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>No levels selected — the prompt will target the pack generally.</div>}
            </div>

            <Field label="Themes / focus" hint="What these questions should be about — edit freely">
              <Textarea value={themes} onChange={(e) => setThemes(e.target.value)} rows={2} placeholder="e.g. self-worth, trying new things, personal strengths" />
            </Field>

            <div className="pm-form-2">
              <Field label="How many">
                <Input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))} />
              </Field>
              <Field label="Output format" hint={OUTPUT_FORMATS[format]?.hint}>
                <Select value={format} onChange={(e) => setFormat(e.target.value)}>
                  {Object.entries(OUTPUT_FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              </Field>
            </div>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
              <input type="checkbox" checked={withFrames} onChange={(e) => setWithFrames(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include frame-word variations
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Teach the AI the swappable {"{token}"} system so higher levels can differ.</div>
              </span>
            </label>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include background context
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Prepend a short "why this matters" so the AI writes on-model. (Full doc below.)</div>
              </span>
            </label>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: pack ? "pointer" : "not-allowed", opacity: pack ? 1 : 0.55 }}>
              <input type="checkbox" checked={avoidExisting} disabled={!pack} onChange={(e) => setAvoidExisting(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Avoid existing questions
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>
                  {!pack ? "Pick a pack first." : loadingQs ? "Loading this pack's questions…" : `Tell the AI not to repeat the ${existingQuestions.length} question${existingQuestions.length === 1 ? "" : "s"} already in this pack.`}
                </div>
              </span>
            </label>

            <Field label="Extra instructions" hint="Optional — anything specific to add to the prompt">
              <Textarea value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} rows={2} placeholder="e.g. avoid words with silent letters; keep answers under 6 letters" />
            </Field>
          </div>

          {/* Master context document — standalone, reusable */}
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
            <button type="button" onClick={() => setShowContextDoc(v => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: S.lg, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{showContextDoc ? "▾" : "▸"} Master context document</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: C.faint }}>reusable</span>
            </button>
            {showContextDoc && (
              <div style={{ padding: `0 ${S.lg}px ${S.lg}px`, display: "grid", gap: S.md }}>
                <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
                  The full background on the game's purpose and CBMT model. Paste this once at the top of a fresh AI chat, then paste the generated prompt after it — the AI keeps the context for every batch you ask for in that chat.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn size="sm" onClick={copyContextDoc} icon={ctxCopied ? "✓" : "⧉"}>{ctxCopied ? "Copied" : "Copy document"}</Btn>
                </div>
                <Textarea readOnly value={MASTER_CONTEXT} rows={12} onFocus={(e) => e.target.select()}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.55, background: C.bg, resize: "vertical" }} />
              </div>
            )}
          </div>
        </div>

        {/* Prompt output */}
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden", position: "sticky", top: S.lg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: `${S.md}px ${S.lg}px`, borderBottom: "1px solid " + C.line }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Generated prompt</span>
            <span style={{ fontSize: 12, color: C.faint }}>{prompt.length.toLocaleString()} chars</span>
            <div style={{ flex: 1 }} />
            <Btn size="sm" onClick={copyPrompt} icon={copied ? "✓" : "⧉"}>{copied ? "Copied" : "Copy"}</Btn>
          </div>
          <Textarea readOnly value={prompt} rows={22}
            onFocus={(e) => e.target.select()}
            style={{ border: "none", borderRadius: 0, fontFamily: "ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.55, resize: "vertical", background: C.bg }} />
          <div style={{ padding: `${S.sm + 2}px ${S.lg}px`, borderTop: "1px solid " + C.line, fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
            Paste this into your AI tool, then bring the result back via <b>a pack → Import</b>{format === "table" ? " (convert the table to pipe/JSON first)" : ""}.
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== views1.jsx =====
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
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Your content library at a glance.</p>
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
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>{loading ? "Loading…" : `${order.length} pack${order.length === 1 ? "" : "s"}`}{canReorder && order.length > 1 ? " · drag cards to reorder" : ""}</p>
      </div>

      <div className="pm-toolbar" style={{ marginBottom: S.lg + 2 }}>
        <SearchBox value={search} onChange={setSearch} placeholder="Search packs…" />
        <Select value={statusF} onChange={(e) => setStatusF(e.target.value)} style={{ minWidth: 140, padding: "8px 12px" }}>
          <option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option>
        </Select>
        <Select value={diffF} onChange={(e) => setDiffF(e.target.value)} style={{ minWidth: 130, padding: "8px 12px" }}>
          <option value="all">All difficulty</option><option value="basic">Basic</option><option value="advanced">Advanced</option><option value="mixed">Mixed</option>
        </Select>
        <Select value={lvlF} onChange={(e) => setLvlF(e.target.value)} style={{ minWidth: 130, padding: "8px 12px" }}>
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

// ===== views2.jsx =====
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
  const importQ = async (r) => { try { await db.createQuestions(r); await afterChange(); notify(`${r.length} questions imported`); } catch (e) { notify("Import failed: " + e.message, { kind: "error" }); } };
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
            <h2 style={{ margin: 0, fontSize: 23, fontWeight: 800, color: C.ink }}>{pack.name}</h2>
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
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>Question bank</h3>
          <div className="pm-grow" />
          <SearchBox value={search} onChange={setSearch} placeholder="Search…" />
          <Select value={lvlF} onChange={(e) => setLvlF(e.target.value)} style={{ minWidth: 130, padding: "8px 12px" }}>
            <option value="all">All levels</option>
            {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
              <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
            ))}
          </Select>
          <Select value={datePreset} onChange={(e) => setDatePreset(e.target.value)} style={{ minWidth: 130, padding: "8px 12px" }} title="Filter by when the question was added">
            <option value="all">Any time added</option>
            <option value="24h">Added last 24h</option>
            <option value="7d">Added last 7 days</option>
            <option value="30d">Added last 30 days</option>
          </Select>
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ minWidth: 120, padding: "8px 12px" }} title="Sort order">
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
        {bulk && <BulkImport packId={pack.id} onDone={importQ} onClose={() => setBulk(false)} />}
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
        <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Search across every pack{total ? ` · ${total} match${total === 1 ? "" : "es"}` : ""}</p>
      </div>
      <div className="pm-toolbar" style={{ marginBottom: S.lg }}>
        <SearchBox value={q} onChange={setQ} placeholder="Search all questions…" autoFocus />
        <Select value={packF} onChange={(e) => setPackF(e.target.value)} style={{ minWidth: 160, padding: "8px 12px" }} title="Filter by pack">
          <option value="all">All packs</option>
          {[...(packs || [])].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(p => (
            <option key={p.id} value={p.id}>{p.emoji ? p.emoji + " " : ""}{p.name}</option>
          ))}
        </Select>
        <Select value={lvl} onChange={(e) => setLvl(e.target.value)} style={{ minWidth: 140, padding: "8px 12px" }}>
          <option value="all">All levels</option>
          {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
            <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
          ))}
        </Select>
        <Select value={stat} onChange={(e) => setStat(e.target.value)} style={{ minWidth: 130, padding: "8px 12px" }}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </Select>
        <Select value={datePreset} onChange={(e) => setDatePreset(e.target.value)} style={{ minWidth: 140, padding: "8px 12px" }} title="Filter by when the question was added">
          <option value="all">Any time added</option>
          <option value="24h">Added last 24 hours</option>
          <option value="7d">Added last 7 days</option>
          <option value="30d">Added last 30 days</option>
          <option value="custom">Custom date range…</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value)} style={{ minWidth: 130, padding: "8px 12px" }} title="Sort order">
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
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ width: 160, padding: "7px 10px" }} />
          <span style={{ fontSize: 12.5, color: C.faint }}>and</span>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ width: 160, padding: "7px 10px" }} />
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

// ===== shell.jsx =====
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
  { id: "generator", label: "Generator", icon: "✦" },
  { id: "levels", label: "Levels", icon: "▲" },
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
  const [authed, setAuthed] = useState(() => !!session.load());
  // URL-hash routing so a refresh keeps you where you were (e.g. #/questions, #/pack/<id>).
  const VALID_NAV = ["dashboard", "library", "questions", "generator", "levels", "health", "publish", "activity", "devnotes"];
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
      let created = 0, skipped = 0;
      for (const p of arr) {
        if (existing.has(p.slug)) { skipped++; continue; }
        const newPack = await db.createPack({ slug: p.slug, name: p.name, emoji: p.emoji || "💡", description: p.description || "", color: p.color || C.brand, difficulty: p.difficulty || "basic", status: "draft", is_custom: !!p.is_custom, sort_order: (packs?.length || 0) + created + 1, level: p.level ?? 1, purpose: p.purpose || null, focus_areas: p.focus_areas || null, style_approach: p.style_approach || null, example_objectives: p.example_objectives || null });
        if (newPack && p.questions?.length) {
          await db.createQuestions(p.questions.map((q, i) => ({ pack_id: newPack.id, template: q.template, answer: (q.answer || "").toUpperCase(), alt_answer: (q.alt_answer || "").toUpperCase(), status: q.status || "active", sort_order: i, level: q.level ?? null, letter_position: q.letter_position ?? null, letter_grouping: q.letter_grouping ?? null, frame_slots: (q.frame_slots && typeof q.frame_slots === "object") ? q.frame_slots : {} })));
        }
        created++;
      }
      await reloadPacks();
      notify(`Imported ${created} pack${created === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}`);
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
                  <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: C.panel, borderRadius: R.md, border: "1px solid " + C.line, boxShadow: SH.lg, zIndex: 61, minWidth: 210, overflow: "hidden" }}>
                    <button onClick={() => { goNav("health"); }} style={menuItem}>◉ Content health</button>
                    <button onClick={() => { goNav("levels"); }} style={{ ...menuItem, borderTop: "1px solid " + C.line }}>▲ Levels</button>
                    <button onClick={() => { goNav("activity"); }} style={{ ...menuItem, borderTop: "1px solid " + C.line }}>≡ Activity log</button>
                    <button onClick={() => { goNav("devnotes"); }} style={{ ...menuItem, borderTop: "1px solid " + C.line }}>⌘ Developer notes</button>
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
            <LevelsView />
          ) : nav === "generator" ? (
            <GeneratorView packs={packs} levels={levels} />
          ) : nav === "health" ? (
            <HealthView onOpenPack={openPackById} />
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


const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
