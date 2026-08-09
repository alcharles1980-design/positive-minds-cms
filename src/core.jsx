
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
  build: "2026.07.15-13", // bump on every deploy; shown in the sidebar so you can tell if a cached build is stale
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

// Call a Supabase Edge Function with the logged-in user's token. Used for functions deployed with
// verify_jwt=true (e.g. generate-questions), so only an authenticated admin can invoke them.
// Mirrors rpc()'s auth handling: one silent refresh+retry on 401.
const callFn = async (name, payload = {}, _retried = false) => {
  const bearer = session.token || CFG.key;
  const res = await fetch(`${CFG.url}/functions/v1/${name}`, {
    method: "POST",
    headers: { apikey: CFG.key, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401 && session.token && !_retried) {
    const ok = await auth.refresh();
    if (ok) return callFn(name, payload, true);
    session.clear(); authEvents.expire();
  }
  const t = await res.text();
  let parsed = null;
  try { parsed = t ? JSON.parse(t) : null; } catch { parsed = { error: "bad_response", message: t.slice(0, 300) }; }
  // Edge functions signal problems in the BODY (e.g. {error:'no_key'}) as well as via status —
  // hand the whole thing back so the caller can show the real message.
  if (!res.ok && parsed && !parsed.error) parsed.error = `http_${res.status}`;
  return parsed;
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

// ============================================================
// THE QUESTION VALIDATOR — shared truth about what makes a question sound.
//
// MUST stay identical to the copy in the generate-questions edge function (parity invariant, same
// as maskWord). It runs the REAL masking engine at EVERY level, because most quality rules for
// this game are mechanically decidable — and the worst defect is invisible to the eye:
//
//   "ambiguous" — the ALTERNATE word ALSO fits the blank at some level, so the puzzle has TWO
//   correct answers and a child is marked wrong for a right answer. At whole-word levels the only
//   clue is LENGTH, so ANY same-length alternate is ambiguous there. (This is a real defect that
//   shipped in live content: BRIGHT/GENTLE, SURE/GLAD — both fine to a human eye, both broken.)
//
// The human still decides everything the machine can't judge (tone, meaning, suitability).
// ============================================================

// Does `alt` ALSO satisfy this blank pattern? If so, two words are correct.
const altFitsBlank = (blank, alt) => {
  alt = (alt || "").toUpperCase();
  if (alt.length !== blank.length) return false;
  for (let i = 0; i < blank.length; i++) {
    if (blank[i] !== "_" && blank[i] !== alt[i]) return false;
  }
  return true;
};

const validateQuestion = (q, levels, opts = {}) => {
  const flags = [];
  const tpl = q.template || "";
  const ans = (q.answer || "").toUpperCase().trim();
  const alt = (q.alt_answer || "").toUpperCase().trim();

  const blanks = (tpl.match(/\{blank\}/g) || []).length;
  if (blanks === 0) flags.push({ code: "no_blank", detail: "Sentence has no {blank} placeholder." });
  else if (blanks > 1) flags.push({ code: "multi_blank", detail: `Sentence has ${blanks} {blank} placeholders — must have exactly one.` });

  if (!ans) flags.push({ code: "no_answer", detail: "Missing the primary answer word." });
  if (!alt) flags.push({ code: "no_alt", detail: "Missing the alternate word." });
  if (ans && alt && ans === alt) flags.push({ code: "same_word", detail: "The two options are the same word." });

  // The big one: ambiguity at EVERY level.
  if (ans && alt && ans !== alt && blanks === 1) {
    const bad = [];
    for (const lvl of levels || []) {
      const isWord = lvl.hidden_mode === "word";
      let blank;
      if (isWord) blank = "_".repeat(Math.max(3, ans.length));
      else {
        const letters = Math.min(lvl.letters_hidden_default || 2, Math.max(1, ans.length - 1));
        blank = maskWord(ans, letters, lvl.letter_position || "end", lvl.letter_grouping || "grouped");
      }
      if (altFitsBlank(blank, alt)) bad.push(lvl.level);
    }
    if (bad.length) {
      flags.push({
        code: "ambiguous", levels: bad,
        detail: `"${alt}" also fits the blank at level${bad.length > 1 ? "s" : ""} ${bad.join(", ")} — two correct answers. The alternate must be a DIFFERENT length from "${ans}".`,
      });
    }
  }

  // Level vocabulary rules (word-length band, multi-word)
  const lvl = (levels || []).find(l => l.level === opts.targetLevel);
  if (lvl && ans) {
    const letters = ans.replace(/\s+/g, "").length;
    const words = ans.trim().split(/\s+/).filter(Boolean).length;
    if (lvl.min_word_len && letters < lvl.min_word_len) flags.push({ code: "too_short", level: lvl.level, detail: `"${ans}" is ${letters} letters; level ${lvl.level} wants at least ${lvl.min_word_len}.` });
    if (lvl.max_word_len && letters > lvl.max_word_len) flags.push({ code: "too_long", level: lvl.level, detail: `"${ans}" is ${letters} letters; level ${lvl.level} allows at most ${lvl.max_word_len}.` });
    if (words > 1 && !lvl.allow_multiword) flags.push({ code: "multiword", level: lvl.level, detail: `Level ${lvl.level} doesn't allow multi-word answers.` });
  }

  if (ans && /[^A-Z\s'-]/.test(ans)) flags.push({ code: "bad_chars", detail: `"${ans}" contains characters other than letters.` });
  if (alt && /[^A-Z\s'-]/.test(alt)) flags.push({ code: "bad_chars_alt", detail: `"${alt}" contains characters other than letters.` });

  const norm = (s) => (s || "").toLowerCase().replace(/\{blank\}/g, "___").replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  // DUPLICATE — the ONE dedup condition. A question is a duplicate ONLY when an existing question
  // (in this pack) has the SAME sentence AND the SAME right/wrong combination, order-sensitive:
  //   same template  AND  same answer  AND  same alt_answer.
  // Deliberately strict (decided 2026-07): a reversed pair (answer/alt swapped), the same sentence
  // with a different word pair, or a reused answer word are all DIFFERENT questions and pass cleanly.
  // `existing` must include live questions AND anything pending or rejected in the review queue —
  // otherwise two generate runs before a review can duplicate each other, and a rejected question
  // gets cheerfully regenerated. Scope is the pack (generation is always pack-level).
  if (ans) {
    const tplN = norm(tpl);
    const isDup = (opts.existing || []).some(e =>
      norm(e.template) === tplN &&
      (e.answer || "").toUpperCase() === ans &&
      (e.alt_answer || "").toUpperCase() === alt
    );
    if (isDup) flags.push({ code: "duplicate", detail: "This exact question already exists (same sentence and same right/wrong pair)." });
  }

  return { ok: flags.length === 0, flags };
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
    // "Edited" means the override actually changes something. A row that only carries the default
    // enabled=true (e.g. a derived word-level handle) is a no-op and should NOT read as edited.
    const hasOv = Object.keys(ov).filter(k => {
      if (["question_id", "level", "updated_at"].includes(k)) return false;
      if (ov[k] == null) return false;
      if (k === "enabled" && ov[k] === true) return false; // default value, not a customization
      return true;
    }).length > 0;
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
// Device class, NOT raw width.
//
// THE BUG THIS FIXES: the old version keyed purely off window.innerWidth (phone < 640). Rotate any
// phone to landscape and its width becomes 667-932px — so the app decided it was a TABLET, swapped
// the bottom nav for an icon side-rail, dropped the phone CSS (two-column forms came back, modals
// stopped being bottom sheets, and iOS started auto-zooming on every input focus). Rotating back
// flipped it all again. That is the "flipping between layouts with menus appearing from the side".
//
// A phone is a phone in ANY orientation. Two signals make that stable:
//   • the SHORT side of the screen — a phone's short side is always small, rotated or not
//   • pointer:coarse — a touch device rather than a mouse
// Width alone is not a device class; it never was.
const useBreakpoint = () => {
  const read = () => {
    if (typeof window === "undefined") return { w: 1200, h: 800, coarse: false };
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      // Touch device (no fine pointer). Guard matchMedia — older/embedded webviews may lack it.
      coarse: typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false,
    };
  };

  const [s, setS] = useState(read);

  useEffect(() => {
    let raf;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setS(read())); };
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("orientationchange", on);
      cancelAnimationFrame(raf);
    };
  }, []);

  const { w, h, coarse } = s;
  const shortSide = Math.min(w, h);

  // THE PRINCIPLE: pick a layout the device can support in EITHER orientation, then keep it.
  // Rotating a device should change how much you can see — never rearrange the navigation.
  // So the decision is made on the SHORT side, which is invariant under rotation.
  //
  // For a non-touch window (a desktop browser you can freely resize) there is no "device" to speak
  // of — the live width IS the constraint, so we key off that instead.
  const basis = coarse ? shortSide : w;

  const isPhone   = basis < 640;                  // any phone, either way up
  const isTablet  = !isPhone && basis < 1024;     // tablet, or a narrow desktop window
  const isDesktop = !isPhone && !isTablet;        // iPad Pro-class and up: room for the full sidebar

  return { w, h, shortSide, coarse, isPhone, isTablet, isDesktop, landscape: w > h };
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
