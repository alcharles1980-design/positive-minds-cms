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
  build: "2026.08.11-34", // bump on every deploy; shown in the sidebar so you can tell if a cached build is stale
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

  const TABLES = ["pm_packs", "pm_questions", "pm_levels", "pm_question_levels", "pm_export_profiles", "pm_sync_targets", "pm_activity", "pm_review_queue"];

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
                  <Select value={byLevel[l.level] ?? ""} aria-label={`Word for level ${l.level}`} title={`Word for level ${l.level}`} onChange={(e) => { const v = e.target.value; const nb = { ...byLevel }; if (v === "") delete nb[l.level]; else nb[l.level] = v; setSlot({ byLevel: nb }); }} style={{ padding: "5px 8px", fontSize: 12.5, flex: 1 }}>
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

function BulkImport({ packId, onDone, onClose, levels, packLevel }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [existing, setExisting] = useState([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [skipIds, setSkipIds] = useState(() => new Set()); // row indices the user chose to skip
  const [userTouched, setUserTouched] = useState(() => new Set()); // rows the user manually toggled

  // Vocabulary guidance from the pack's level (imported questions inherit the pack level). Purely
  // advisory — a word outside the band gets a soft warning, never blocks import.
  const levelDef = useMemo(() => (levels || []).find(l => l.level === (packLevel ?? 1)) || null, [levels, packLevel]);
  const bandCheck = (word) => {
    if (!levelDef) return null;
    const w = (word || "").replace(/\s+/g, "");
    const len = w.length;
    if (!len) return null;
    const wordCount = (word || "").trim().split(/\s+/).filter(Boolean).length;
    if (levelDef.min_word_len && len < levelDef.min_word_len) return `shorter than L${levelDef.level}'s ${levelDef.min_word_len}-letter minimum`;
    if (levelDef.max_word_len && len > levelDef.max_word_len) return `longer than L${levelDef.level}'s ${levelDef.max_word_len}-letter maximum`;
    if (wordCount > 1 && !levelDef.allow_multiword) return `L${levelDef.level} doesn't allow multi-word answers`;
    return null;
  };

  // Load the pack's existing questions so we can flag duplicates.
  useEffect(() => {
    let alive = true;
    setLoadingExisting(true);
    (async () => { try { const qs = await db.allQuestionsForPack(packId); if (alive) setExisting(qs || []); } catch { if (alive) setExisting([]); } finally { if (alive) setLoadingExisting(false); } })();
    return () => { alive = false; };
  }, [packId]);

  // Normalize a sentence for comparison: lowercase, blank/tokens collapsed, whitespace/punct trimmed.
  const normSentence = (t) => (t || "").toLowerCase().replace(/\{blank\}/g, "▢").replace(/\{[a-zA-Z][\w-]*\}/g, "▢").replace(/[^a-z0-9▢]+/g, " ").trim();
  // The validator needs the pack's existing content to catch duplicates and reused answer words.
  const existingForValidator = useMemo(
    () => (existing || []).map(q => ({ template: q.template, answer: q.answer, source: "live" })),
    [existing]
  );

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
      // Run the SAME validator the AI pipeline uses, against the SAME rendering engine, at EVERY
      // level. Imported content is not special — a same-length alternate breaks the puzzle whether
      // a human typed it or an AI wrote it. (BRIGHT/GENTLE reached children through this exact
      // path.)
      const validation = validateQuestion(
        { template: r.template, answer: r.answer, alt_answer: r.alt_answer },
        levels || [],
        { targetLevel: packLevel, existing: existingForValidator }
      );
      return { ...r, dup, validation, bandWarn: bandCheck(r.answer), dupInfo: dup === "exact" ? (inBatchDup ? "duplicate within this batch" : "already in this pack") : (sentenceHits.length ? "same sentence exists" : "answer word already used") };
    });
  }, [raw, existingIndex, levelDef, existingForValidator, levels, packLevel]);

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
      // EVERYTHING goes to the review queue — never straight into the pack.
      //
      // There used to be two ways content got in and only one was gated: generation via API key went
      // to the queue, but pasting AI output here went STRAIGHT INTO THE LIVE PACK. Same AI, same
      // risks, no gate. That is the exact path by which BRIGHT/GENTLE (two same-length words, so
      // both fit the blank) reached children.
      //
      // We do not try to guess whether a paste "came from AI" — we usually cannot tell, and a wrong
      // guess means unchecked content reaches a child. So it all goes through the gate.
      const res = await rpc("pm_review_enqueue", {
        p_pack_id: packId,
        p_items: toImport.map(v => ({
          template: v.template,
          answer: v.answer,
          alt_answer: v.alt_answer,
          ...(v.frame_slots ? { frame_slots: v.frame_slots } : {}),
          validation: v.validation || null,
        })),
        p_source: "import",
        p_target_level: packLevel ?? null,
      });
      const n = res?.queued ?? toImport.length;
      const flagged = toImport.filter(v => v.validation && !v.validation.ok).length;
      notify(
        flagged
          ? `${n} question${n === 1 ? "" : "s"} sent for review — ${flagged} flagged`
          : `${n} question${n === 1 ? "" : "s"} sent for review`
      );
      onDone && onDone(n);
      onClose();
    } catch (e) { setErr(friendlyError(0, String(e?.message || e))); setBusy(false); }
  };

  const dupStyle = { exact: { fg: C.danger, label: "Duplicate" }, near: { fg: C.warn, label: "Similar" }, none: null };

  return (
    <>
      <ModalHead title="Import questions" subtitle="Everything you import goes to AI Review for your approval" id="pm-imp-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.md + 2 }}>
        <div className="pm-readable" style={{ fontSize: 12.5, color: C.brandInk, background: C.brandSoft,
          padding: "10px 13px", borderRadius: R.md, lineHeight: 1.55 }}>
          <b>These go to AI Review, not straight into the pack.</b> Every question is checked against
          the real game engine first — including whether the two words are the same length, which would
          give the child <i>two correct answers</i>. Approve them from <b>AI Review</b> when you're happy.
        </div>

        <div style={{ fontSize: 12.5, color: C.sub, background: C.lineSoft, padding: "8px 12px", borderRadius: R.sm, lineHeight: 1.5 }}>
          <b>Pipe:</b> <code>Sentence with {"{blank}"} | ANSWER | ALT</code><br />
          <b>JSON:</b> <code>{'[{"template":"…{blank}…","answer":"BRAVE","alt_answer":"BOLD"}]'}</code>
          {levelDef && (levelDef.min_word_len || levelDef.max_word_len || levelDef.allow_multiword) && (
            <><br /><span style={{ color: C.faint }}>Pack level {levelDef.level} suggests {levelDef.min_word_len && levelDef.max_word_len ? `${levelDef.min_word_len}–${levelDef.max_word_len}-letter` : levelDef.min_word_len ? `${levelDef.min_word_len}+ letter` : levelDef.max_word_len ? `≤${levelDef.max_word_len}-letter` : ""} words{levelDef.allow_multiword ? ", multi-word ok" : ""}. Out-of-range words get a soft “Length” flag (still importable).</span></>
          )}
        </div>
        <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} autoFocus aria-label="Paste questions to import" placeholder={"I am {blank} when I try something new. | BRAVE | BOLD\nBeing {blank} helps me make friends. | KIND | CARING"} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
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
                  {p.ok && p.bandWarn && <span title={p.bandWarn} style={{ color: C.warn, fontWeight: 700, fontSize: 11, padding: "1px 7px", borderRadius: R.pill, border: "1px solid " + C.warn + "66", whiteSpace: "nowrap" }}>Length</span>}
                  {/* Show what the real engine found, BEFORE you commit — not after. The important
                      one is "Two answers": both words the same length, so both fit the blank. */}
                  {p.ok && p.validation && !p.validation.ok && p.validation.flags.map((fl, fi) => {
                    const hard = fl.code === "ambiguous" || fl.code === "same_word" || fl.code === "no_blank" || fl.code === "multi_blank";
                    const col = hard ? C.danger : C.warn;
                    const label = fl.code === "ambiguous" ? "Two answers"
                      : fl.code === "same_word" ? "Same word"
                      : fl.code === "no_blank" ? "No blank"
                      : fl.code === "multi_blank" ? "Too many blanks"
                      : fl.code === "duplicate" ? "Duplicate"
                      : fl.code;
                    return (
                      <span key={fi} title={fl.detail} style={{ color: col, fontWeight: 700, fontSize: 11,
                        padding: "1px 7px", borderRadius: R.pill, border: "1px solid " + col + "66", whiteSpace: "nowrap" }}>
                        {label}
                      </span>
                    );
                  })}
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
        <Btn onClick={submit} disabled={busy || !toImport.length || loadingExisting}>{busy ? "Sending…" : loadingExisting ? "Checking…" : `Send ${toImport.length} for review`}</Btn>
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
                <input type="checkbox" checked={!!spec.include_stats} onChange={(e) => setSpecField("include_stats", e.target.checked)} style={{ width: 16, height: 16, marginTop: 2, accentColor: C.brand }} />
                <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include content status<div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 2 }}>Adds a stats block: pack and question counts, review queue totals, and per-pack live/pending/approved figures. Useful for a dashboard reading the same feed as the game. A caller can override this per request with ?stats=1 or ?stats=0.</div></span>
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

// ===== devdocs.jsx =====
// ============================================================
// Developer Notes — embedded reference documents.
// These are hardcoded so they always ship with the build.
// ============================================================

const DOC_ARCHITECTURE = `# Positive Minds CMS — Site Architecture & Structure

## 0. START HERE (new developer / taking over)

**Read in this order.** This document is long because it is complete; you do not need all of it on
day one.

1. **§1 What this is** and **§2 The game mechanic** — 5 minutes. Nothing else makes sense without
   them. The single most important idea: it is a SPELLING puzzle, both words are always POSITIVE,
   and the wrong option is guaranteed wrong by being a DIFFERENT LENGTH.
2. **§0.1 Live coordinates** (just below) — where everything actually lives.
3. **§0.2 Run it / change it / ship it** — the loop.
4. **CLAUDE.md** (the second tab) — the hard rules. These are invariants learned from real bugs.
   Breaking one silently breaks the game. Read it before your first change, not after.
5. **§7d Integration Guide** — if you are building or maintaining the game client, go straight there.
   It has a complete, runnable sync implementation.
6. The rest as you need it. **§12 is the changelog** — read the top few entries to see what has been
   moving lately.

If you only remember three things:
- **The masking engine \`maskWord\` is duplicated in FIVE places and MUST stay byte-identical** (app/
  core.jsx, content-api, generate-questions, mcp, game-feed); the validator \`validateQuestion\` in three
  (core.jsx, generate-questions, mcp). If a blank renders differently in the CMS than in the game, the
  game is wrong. Change one copy → change all, same commit. NOTE: \`game-feed.buildLevelVariants\` emits a
  different OUTPUT shape on purpose (legacy \`opts\` string vs \`options\` array) — the masking is identical,
  only the serialization differs.
- **PostgREST silently caps at 1,000 rows.** No error. Always set an explicit limit or paginate.
- **The app is a PWA with an aggressive service worker.** Most "my change didn't deploy" reports are a
  cached build. The sidebar shows a build stamp — if it didn't change, you are seeing a cached build.

### 0.1 Live coordinates

| What | Where |
|---|---|
| Supabase project | \`tytrmjjucqijzcrbwjfm\` → \`https://tytrmjjucqijzcrbwjfm.supabase.co\` |
| Publishable (anon) key | \`sb_publishable_S16YFhxUtKsUYlUixYGW8g_t5nk28Ev\` — safe in the browser; RLS enforces everything |
| Repo | \`github.com/alcharles1980-design/positive-minds-cms\` |
| Hosting | Cloudflare Pages project \`positive-minds-cms\` (push to \`main\` → GitHub Actions → deploy) |
| Admin login | \`admin@positiveminds.app\` |
| **Content API (the game client calls this)** | \`https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api\` |

**Edge functions (5) — all five have committed source in \`edge-functions/*.ts\`:**
- \`content-api\` — the sync API for the game client. **Public** (verify_jwt=false). Manifest,
  full pull, incremental \`?since=\`, deletions, ETag/304. **This is the one the game uses.**
- \`generate-questions\` — AI content generation. **Auth-gated (verify_jwt=TRUE)** so only a logged-in
  admin can spend API credits. Writes ONLY to the review queue, never to live content.
- \`mcp\` — the Claude Connector (OAuth 2.1 + PKCE). Partners propose content via Claude; writes ONLY to
  the review queue. Public entry (verify_jwt=false), but every tool call requires an OAuth access token.
- \`game-feed\` — the older, profile-driven feed. **Public** (verify_jwt=false). Kept for back-compat;
  new clients should use content-api. **Carries its own engine copy** (see parity note below).
- \`pack-describe\` — small helper that asks an LLM to write a pack description. Auth-gated.

**GitHub secrets needed for deploys:** \`CLOUDFLARE_API_TOKEN\` (Account → Cloudflare Pages → Edit) and
\`CLOUDFLARE_ACCOUNT_ID\`.

### 0.2 Run it, change it, ship it

**The app you deploy is \`index.html\` — a single self-contained file. It is the OUTPUT, not the
source.** The app is authored as modular \`.jsx\` files, concatenated in a fixed dependency order by
\`assemble.cjs\`, compiled with Babel (\`@babel/preset-react\`, **classic** runtime — the automatic/dev
runtime emits an import that breaks the plain \`<script>\` and yields a blank screen), then wrapped by
\`build_html.cjs\`.

The loop:
1. Edit the modular source.
2. **Check the docs still parse BEFORE building.** They are template literals; a stray backtick or
   \`\${\` silently breaks them, and \`assemble.cjs\` will then leave the PREVIOUS compiled file in place —
   so \`node --check\` passes on a stale build and you ship nothing. This has happened repeatedly.
3. Build. Confirm the compiled file was **freshly written** and contains a string you just added.
4. Bump \`CFG.build\` (the stamp shown in the sidebar).
5. Push to \`main\`. GitHub Actions deploys to Cloudflare Pages.
6. Hard-refresh (service worker) and check the stamp changed.

**Database changes** are Postgres migrations against the Supabase project. **Edge functions** deploy
separately (\`supabase functions deploy <name> --project-ref tytrmjjucqijzcrbwjfm\`; add
\`--no-verify-jwt\` for content-api).

### 0.3 What is where

| Concern | Where it lives |
|---|---|
| Config, auth, data layer, **the masking engine**, **the validator** | \`core.jsx\` |
| UI primitives (buttons, modals, fields, toasts) | \`primitives.jsx\` |
| Packs / questions editors, bulk import | \`editors.jsx\` |
| Levels (definitions, per-question overrides, derive) | \`levels.jsx\` |
| AI review queue (approve / edit / reject) | \`aireview.jsx\` |
| AI settings (providers, keys, usage) | \`aisettings.jsx\` |
| Prompt builder (copy-paste workflow) | \`generator.jsx\` |
| Export/transform engine + publishing | \`engine.jsx\`, \`publish1/2.jsx\` |
| These three documents | \`devdocs.jsx\` |
| Routing, nav, app shell | \`shell.jsx\` |

### 0.4 Continuing this project — what runs where, and how a new person gets access

**Three services, and they are decoupled. This is the single most misunderstood thing about the setup.**

| Service | Role | How it changes | How it goes live |
|---|---|---|---|
| **GitHub** (\`alcharles1980-design/positive-minds-cms\`) | Source of truth for the FRONT-END + a copy of the edge-function source | edit \`src/\`, build, \`git push\` | — |
| **Cloudflare** | Serves the CMS website (the static \`index.html\`) | (nothing edited here directly) | \`git push\` → GitHub Actions → Cloudflare, automatic |
| **Supabase** (\`tytrmjjucqijzcrbwjfm\`) | The entire BACKEND: Postgres, auth, RLS, and the 5 edge functions | deploy edge fns / run SQL | **manual deploy — GitHub never touches Supabase** |

**The trap:** the edge functions in \`edge-functions/*.ts\` are a SAVED COPY, not a live link. Committing
and pushing them updates Cloudflare and leaves Supabase untouched. A function only changes on Supabase
when someone explicitly deploys it there. (This exact decoupling is why \`game-feed\` and \`pack-describe\`
once ran live for weeks with no source in the repo.) **Commit the source AND deploy it, every time, or
the repo and the live backend drift apart.**

**Front-end path (fully covered by GitHub):** edit \`src/\` → build → push to \`main\` → GitHub Actions →
Cloudflare updates the live site. A contributor with only GitHub access can change the website and
nothing else.

**Backend path (NOT reachable through GitHub):** to change the database, RLS, RPCs, or deploy an edge
function, a person needs access to the **Supabase project itself**. Two ways:

- **Path 1 — Supabase org membership (preferred).** In the Supabase dashboard: *Organization → Team →
  Invite member* (invite as Developer so they can build but can't delete the project or change billing).
  Once they accept, this project appears under their own Supabase account. They then connect the
  **Supabase MCP** on their own Claude account, logging in with their own Supabase credentials, and
  Claude can now deploy edge functions (\`deploy_edge_function\`) and run SQL/migrations
  (\`apply_migration\`, \`execute_sql\`) — scoped to the role granted. Revoke by removing them from the org.
- **Path 2 — a personal access token.** Dashboard → *Account → Access Tokens → Generate*. Carries your
  account access (not neatly per-project), usable via the Supabase CLI or an MCP configured with it.
  It is a bearer secret: whoever holds it acts AS you until it is revoked. Prefer Path 1 for anyone you
  want to limit.

**Key distinction:** connecting the Supabase MCP on a Claude account is only the *pipe*. It grants no
access by itself — it inherits whatever the authenticated **Supabase** account can already see.
Authorization happens on Supabase (org membership or token), never on the Claude side.

**Two kinds of working session:**
- A **chat with the Supabase MCP** connected to this project → can drive the whole BACKEND live (deploy
  edge fns, run SQL). Front-end build still needs a shell.
- A **shell/bash session** (git + Node) → can build and ship the FRONT-END (push → Actions → Cloudflare)
  and can edit edge-function source, but CANNOT deploy to Supabase or reach the DB.
- A session with **both** does everything end to end.

See \`CONTRIBUTING.md\` in the repo for the step-by-step onboarding checklist.

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
- **Hooks:** useBreakpoint — **device class, NOT raw width**. It decides on the SHORT side of the
  screen for touch devices (invariant under rotation) and on live width for a resizable desktop
  window: \`basis = coarse ? min(w,h) : w\`, then phone <640 / tablet <1024 / desktop. THE BUG THIS
  FIXED: the old version keyed purely off innerWidth (phone<640), so rotating any phone to landscape
  (667–932px) made the app think it was a TABLET — the bottom nav vanished, an icon side-rail
  appeared, two-column forms came back, modals stopped being bottom sheets, and iOS resumed
  auto-zooming on input focus. Rotating back flipped it all again. A phone is a phone in ANY
  orientation. Also: useAsync,
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
- \`pm_review_queue\` — the HUMAN APPROVAL GATE for AI content. Every AI-generated question lands
  here first; NOTHING reaches pm_questions (and therefore no child) without an explicit human
  Approve / Edit / Reject. Columns: id, batch_id, pack_id, template, answer, alt_answer, frame_slots,
  target_level, provider, model, status (pending|approved|rejected), edited, reject_reason,
  decided_at, decided_by, approved_question_id, validation (jsonb), created_at. RLS: authenticated
  only — anon has NO access (this is unreviewed content). In the realtime publication.
- \`pm_ai_config\` — **SECURITY-CRITICAL.** Stores third-party API keys (anthropic/openai/gemini).
  Unlike every other pm_ table, it has **NO select policy for anon OR authenticated** — the browser
  literally cannot read it. Verified empirically: a fully authenticated admin SELECT returns [] while
  the same token reads pm_levels fine. Writes go through SECURITY DEFINER RPCs only; the
  generate-questions edge fn reads the key with the service role, server-side. Columns: provider (PK),
  api_key, model, enabled, updated_at, updated_by.
- \`pm_ai_usage\` — one row per PROVIDER CALL (generate / repair / test), with provider, model,
  pack, batch, input_tokens, output_tokens, questions_returned, ok, error, actor, created_at.
  AI generation is the ONLY operation in this app that spends real money, and it used to leave NO
  trace whatsoever — no audit trail, no token counts, no way to notice a runaway. Readable by the
  admin (the Usage panel), written only by the edge fn (service role).
- \`pm_ai_settings\` — singleton (id=1) NON-secret settings: active_provider, batch_size,
  auto_repair. Safe for the client to read/write.
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
- Level-delete cleanup trigger \`pm_level_delete_cleanup\` (SECURITY DEFINER, BEFORE DELETE on
  pm_levels): there is no FK from pm_packs.level / pm_questions.level / pm_question_levels.level to
  pm_levels (level is a plain int), so deleting a level could leave references pointing at a level
  that no longer exists (a stale pointer — not content loss, since the engine renders every EXISTING
  level for every question regardless of the pinned level). The trigger fixes ALL THREE reference
  types atomically: PACKS pinned to the removed level are reset to the highest REMAINING level (a
  pack's level is its questions' fallback and can't be null; since the UI only deletes the highest
  level, this drops affected packs to the next-highest); QUESTIONS pinned to it are un-pinned (level
  = null → they inherit the pack default); OVERRIDE rows at that level are deleted. Verified under
  load (a test level with a pinned pack + pinned question + override → pack reset to next level,
  question nulled, override removed).

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

## 7c. AI content generation (with mandatory human review)
Two new pages — **AI Settings** (aisettings.jsx) and **AI Review** (aireview.jsx) — plus the
\`generate-questions\` edge function (verify_jwt=TRUE, so only a logged-in admin can spend your API
credits). Supports THREE providers: Anthropic, OpenAI, Gemini (three genuinely different API shapes,
one adapter each).

**The approval gate (non-negotiable):** generate-questions writes ONLY to pm_review_queue, never to
pm_questions. A human must Approve / Edit / Reject each item. Approve goes through the
\`pm_review_approve\` RPC — the single atomic path into live content (creates the question, links it,
records who decided and whether they edited it, tags the question "AI-generated — human approved").
Reject records a reason and writes nothing.

**API-key security:** keys live in pm_ai_config, which the browser CANNOT read (no RLS select policy
at all). The settings page writes keys via \`pm_ai_set_key\` and displays status ONLY —
"Configured ••••••1234" — via \`pm_ai_status\`, which returns a masked hint and never the key. Even
someone with the admin login, or an XSS in this app, cannot lift the keys. Empirically verified.
Rotate by saving a new key over the old one. \`callFn()\` in core.jsx invokes verify_jwt edge fns with

**GENERATION PARAMETERS (per provider, in pm_ai_config):** max_tokens, temperature, top_p,
system_prompt — all editable in AI Settings, each with an (i) explaining what it does FOR THIS JOB.
Originally max_tokens was HARDCODED at 4000, temperature was never sent at all (so you silently got
the default 1.0 — maximally creative, the wrong end of the dial for rule-compliant structured output),
and the game rules were stuffed into the USER turn rather than a system prompt.

**CRITICAL: temperature and top_p are NULLABLE and are OMITTED from the request when unset.** This is
not laziness — it is REQUIRED. Anthropic returns 400 for temperature on Opus 4.7+, and OpenAI rejects
it on GPT-5 reasoning models. Sending a "harmless default" would break generation ENTIRELY on those
models. Because null means "don't change" in the setter, there are explicit p_clear_temperature /
p_clear_top_p flags so a value can actually be UNSET. The UI warns about this in the Advanced section.

Per-provider mapping (they differ, and getting it wrong fails silently):
| Param | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| max tokens | max_tokens | max_completion_tokens | generationConfig.maxOutputTokens |
| temperature | temperature | temperature | generationConfig.temperature |
| top-p | top_p | top_p | generationConfig.topP |
| system prompt | \`system\` field | a system MESSAGE | \`systemInstruction\` (separate field) |

**The \`enabled\` flag is now ENFORCED.** It existed as a column and was reported by pm_ai_status,
but NOTHING ever checked it — so a provider marked "disabled" was still used. Dead config that lies is
worse than no config. The edge fn now refuses with \`provider_disabled\`, and there is a Turn on/off
button (pm_ai_set_enabled). Verified live: a disabled-but-keyed provider returns 400.

**Clearing the system prompt actually clears it.** The UI used to send null when you emptied the
textarea — but null means "don't change" in the setter, so a custom brief could NEVER be removed and
the UI lied (empty box, old prompt still in use). It now sends an empty string, which the RPC treats
as an explicit clear.

**A short batch no longer fails quietly.** If you asked for 20 and got 8, nothing said why. The
response now carries \`requested\`, \`truncated\` and a \`warning\`, and the UI shows it — naming the
likely cause (hit the token ceiling) and the fix.

**Truncation is now surfaced.** A too-low max_tokens cuts the JSON off mid-array and used to appear as
a baffling parse error. All three adapters report stop_reason/finish_reason, and the error now says
plainly: "ran out of output tokens — raise Max tokens or generate fewer questions."

**Saving params must not wipe the key.** You can never read a key back, so pm_ai_set_key accepts a
null key meaning "keep the existing one". (A previous 3-arg overload of this function had to be
DROPPED — it made the call ambiguous, "function is not unique".)

**COST + RATE CONTROL (this was completely missing):** AI generation is the ONLY operation in this app
that spends real money, and it originally had NO brake and NO audit trail at all - no run count, no
token counts, no way to notice a runaway. Now: every provider call (generate / repair / test, success
AND failure) is recorded in \`pm_ai_usage\` with token counts and the actor from the JWT; the edge fn
calls \`pm_ai_rate_check\` BEFORE any provider call and returns 429 if the limits are exceeded
(defaults 20/hour, 100/day); and the AI Settings page shows a Usage panel (runs, questions, tokens,
errors, by provider, 30 days) via \`pm_ai_usage_summary\`. Logging is best-effort so it can never break
a generation the user is waiting on.
the user's token (mirrors rpc()'s 401 refresh-and-retry).

**THE VALIDATOR (\`validateQuestion\` in core.jsx — the reason this is trustworthy):** most quality
rules for this game are MECHANICALLY DECIDABLE, so the machine catches its own errors before a human
sees them. It runs the REAL masking engine at EVERY level and flags: no/multiple {blank}; missing or
identical words; word-length band + multi-word rule for the target level; bad characters; duplicates;
and above all **ambiguous** — the alternate ALSO fits the blank at some level, so the puzzle has TWO
correct answers and a child is marked wrong for a right answer.

**REPETITION CHECKS — five distinct cases, because they mean different things.**
WHERE THEY RUN (Aug 2026): these are ADVISORY and live in pm_lint/pm_lint_details ONLY. None of
them is in validateQuestion, so the review queue will not flag them on new content — that is
deliberate, not drift. See rule 4.15 for the hard/advisory split.
NOT COVERED BY ANY OF THE FIVE: cross-role reuse, where a word is the ANSWER in one question and
the DISTRACTOR in another. \`reversed_pair\` needs the same PAIR; \`overused_alt\` only counts
distractors. It is live in the Calmness pack today — see section 11z.
- \`duplicate\` — same sentence AND same answer. A true repeat.
- \`same_sentence\` — same sentence, different answer. Repetitive phrasing.
- \`answer_reused\` — the ANSWER WORD is already taught elsewhere.
- \`reversed_pair\` — **the same two words offered as the choice, just swapped over.** CALM/PROUD and
  PROUD/CALM. Different sentences, so NOT a duplicate — but the child faces the identical two-word
  decision twice. Found by reading the LIVE feed, not by testing code: the confidence pack really had
  both. Invisible to every check before, because they all grouped by ANSWER only.
- \`overused_alt\` — the same word used as the DISTRACTOR three or more times. A predictable wrong
  option teaches the child "it is never that one" instead of teaching them to read the blank. Also
  invisible before, because nothing ever looked at the alternate.

**DUPLICATE HANDLING (the original three, for reference):**
- \`duplicate\` — same sentence AND same answer. A true repeat.
- \`same_sentence\` — same sentence, different answer. Repetitive phrasing.
- \`answer_reused\` — the ANSWER WORD is already taught elsewhere. This is the one that matters most
  and is invisible if you only compare whole questions: in a 10-20 question pack, teaching BRAVE
  twice is a real quality problem. The flag says exactly WHERE the word is already used.
The de-dup CONTEXT is deliberately wider than "live questions in this pack". It includes:
live questions (active AND inactive) + anything PENDING in the review queue + anything previously
REJECTED + the other items in the SAME BATCH (validated cumulatively, so if the model hands back
BRAVE twice, the second copy is flagged, not the first). Without the queue in scope, two generate
runs before a review would duplicate each other, and a question you rejected would be cheerfully
regenerated next time. The prompt's avoid-list is likewise uncapped (it was truncated at 40 words)
and now lists every taken answer word, calls out previously-rejected words explicitly, and shows the
sentences already used so the model varies phrasing rather than just swapping the word.
In the UI, \`answer_reused\` and \`same_sentence\` are SOFT (amber, advisory — you may still want the
question); everything else is a hard mechanical defect (red). Bulk "Approve N clean" only ever takes
rows with ZERO flags of any kind. At whole-word levels the ONLY clue is
LENGTH, so ANY same-length alternate is ambiguous there. This is not theoretical: BRIGHT/GENTLE,
SURE/GLAD and KIND/MEAN were all found broken at L7-10 in LIVE content — each looks perfectly fine to
a human eye. PARITY INVARIANT: validateQuestion must stay byte-identical between core.jsx and the
edge function (verified across 45 cases), exactly like maskWord.

**Auto-repair:** failures are sent back to the model ONCE with the exact defect ("GENTLE also fits the
blank at levels 7-10 — use a different-length alternate"), re-validated, and swapped in if fixed.
Best-effort: if repair fails, the originals are queued WITH their flags.

**What the machine can't do:** judge tone, meaning, suitability. A rejected test case proved the
point — "PERFECT" passes every mechanical check but a human rightly rejected it as an unhealthy
standard for a child. Machine catches mechanics; human catches meaning. That is why the queue exists.

## 7d. INTEGRATION GUIDE (for whoever builds/maintains the game client)

Everything a client needs to consume content. The shapes below are copied from a REAL response, not
from memory.

**Base URL**
\`\`\`
https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api
\`\`\`
Public by default (no auth). CORS is open, so it works from a browser, a mobile app, or a server.
If a \`CONTENT_API_KEY\` secret is ever set on the function, send it as \`X-API-Key: <key>\` or \`?key=\`.

### The mental model

The CMS is the source of truth. The client keeps a **cursor** (\`global_version\`) and periodically asks
"has anything changed?". If yes, it pulls only what changed, applies deletions, and advances its
cursor. **Questions arrive with every level variation ALREADY RENDERED — the client never does any
masking itself.**

### Endpoints

| Call | Use it for |
|---|---|
| \`?manifest=1\` | Cheap poll. Returns versions only, no content. |
| (no params) | Full pull of all published content. |
| \`?since=<epoch or ISO>\` | Incremental: only changed packs + a \`deletions\` array. |
| \`?packs=slug1,slug2\` | Restrict to certain packs. |
| \`?levels=1,2,3\` | Restrict which level variations are rendered. |
| \`?format=xml\` | XML instead of JSON. |
| \`?health=1\` | Liveness check. |

Every response carries an **ETag**. Send it back as \`If-None-Match\` and you get **304 Not Modified**
with no body when nothing changed.

### The manifest (poll this)

\`\`\`json
{
  "global_version": 1783810085,
  "global_updated_at": "2026-07-11T22:48:04.891Z",
  "levels_version": 1783242969,
  "pack_count": 14,
  "question_count": 12,
  "packs": [
    { "slug": "confidence", "name": "Confidence", "content_version": 56,
      "active_questions": 12, "version": 1783810085 }
  ]
}
\`\`\`
If \`global_version\` matches the cursor you stored, **there is nothing to do**. That is the whole point:
one tiny request instead of pulling all content.

### The content response

\`\`\`json
{
  "meta": {
    "mode": "full",                      // or "incremental"
    "global_version": 1783810085,        // <-- STORE THIS as your next cursor
    "levels_version": 1783242969,
    "pack_count": 14,
    "question_count": 12,
    "generated_at": "2026-07-11T23:31:04.287Z"
  },
  "levels":  [ /* the level DEFINITIONS — see below */ ],
  "packs":   [ /* each pack, with its questions */ ],
  "deletions": [ /* ONLY present when ?since= was used */ ]
}
\`\`\`

**A level definition** (use these for labels, colours, age hints — NOT for masking):
\`\`\`json
{
  "level": 1, "name": "First Words", "tagline": "Just one letter to find",
  "theme": "Simple self-affirmation", "age_hint": "Around 5", "color": "#00B894",
  "hidden_mode": "letters", "letters_hidden_default": 1,
  "letter_position": "middle", "letter_grouping": "grouped",
  "min_word_len": null, "max_word_len": null, "allow_multiword": false, "vocab_rule": ""
}
\`\`\`

**A pack:** \`slug, name, emoji, description, color, difficulty, tags, level, content_version,
updated_at, questions[]\`.

**A question — this is the important one:**
\`\`\`json
{
  "id": "d21d33cc-...",
  "template": "I am {blank} when I try new things",
  "answer": "BRAVE",
  "alt_answer": "BOLD",
  "level": 10,                      // its own level (metadata; does NOT limit the variations)
  "updated_at": "...",
  "levels": [                       // ONE ENTRY PER LEVEL — already rendered for you
    {
      "level": 1,
      "level_name": "First Words",
      "sentence": "I am BRA_E when I try new things",   // <-- SHOW THIS
      "blank": "BRA_E",                                  // <-- the masked word
      "options": ["BRAVE", "BOLD"],                      // <-- SHOW THESE TWO (shuffle them!)
      "answer": "BRAVE",                                 // <-- the correct one
      "alt_answer": "BOLD",
      "target": {
        "word": "BRAVE", "altWord": "BOLD", "blankShape": "BRA_E",
        "wholeWord": false, "lettersHidden": 1,
        "position": "random", "grouping": "spread"
      },
      "frames": {},
      "enabled": true
    }
    // ... one of these per level
  ]
}
\`\`\`

**To render a question at level N:** find the entry in \`question.levels\` where \`level === N\`, show
\`sentence\`, and offer \`options\` (shuffled). The child is right if they pick \`answer\`. That is all.

### A complete sync implementation

\`\`\`js
const BASE = 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api';

async function sync(store) {
  // store = { version: number|null, etag: string|null, packs: {...}, levels: [...] }

  // 1) Cheap poll. Nothing changed => stop here.
  const m = await (await fetch(BASE + '?manifest=1')).json();
  if (store.version && m.global_version === store.version) return { changed: false };

  // 2) First run => full pull. Otherwise => incremental.
  const url = store.version ? BASE + '?since=' + store.version : BASE;

  const res = await fetch(url, {
    headers: store.etag ? { 'If-None-Match': store.etag } : {},
  });
  if (res.status === 304) return { changed: false };   // belt and braces
  if (!res.ok) throw new Error('sync failed: ' + res.status);

  const data = await res.json();

  // 3) Apply deletions FIRST (incremental only).
  for (const d of data.deletions ?? []) {
    if (d.type === 'pack')     delete store.packs[d.slug];
    if (d.type === 'question') removeQuestionById(store, d.id);
  }

  // 4) Upsert. A returned pack always carries its FULL current question set,
  //    so replace it wholesale — do not try to merge question-by-question.
  for (const pack of data.packs) store.packs[pack.slug] = pack;

  // 5) Level definitions (labels/colours). Cheap; just take the latest.
  if (data.levels?.length) store.levels = data.levels;

  // 6) Advance the cursor. Do this LAST, only after everything applied cleanly.
  store.version = data.meta.global_version;
  store.etag    = res.headers.get('etag');

  return { changed: true, packs: data.packs.length };
}
\`\`\`

### Rules for the client (learned the hard way)

1. **Never assume 10 levels.** Levels are data and can be added (up to 100). Iterate whatever the feed
   reports. Hardcoding 10 will silently drop new content.
2. **Never do your own masking.** The blanks are pre-rendered. If the client re-implements masking it
   WILL drift from the CMS and the game will show a different puzzle than the author designed.
3. **Shuffle the two options.** The correct answer is always \`options[0]\`. Present them in random order.
4. **Apply deletions before upserts**, and **advance the cursor last** — so a crash mid-sync just means
   you redo the same window, rather than skipping it.
5. **A pack in an incremental response is complete.** Replace it wholesale rather than merging.
6. **Only published packs and active questions are ever returned.** Unpublishing a pack shows up as a
   deletion in \`?since=\`.
7. **The integer cursor is safe.** \`global_version\` is a floored epoch, so it can re-send the boundary
   row but will never skip one. Redundant, never lossy.

### Testing it

\`\`\`bash
curl 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api?health=1'
curl 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api?manifest=1'
curl 'https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/content-api?packs=confidence&levels=1'
\`\`\`

## 7e. CLAUDE CONNECTOR (MCP) — partners write content by talking to Claude

Three trusted partners connect this CMS to their OWN Claude account and propose content by simply
asking for it: "write 15 questions for Calmness about bedtime worries". Their Claude subscription pays
for the generation — no API key of ours is involved.

**WHY IT IS SAFE, and this matters more than any permission check:** a partner CANNOT reach a child.
\`pm_review_approve\` is the ONLY path into live content and it requires a human to press Approve. So
the worst a partner can do — even a compromised one — is fill the review queue with things you reject,
plus create or rename pack containers. That is the entire blast radius. There is deliberately NO tool
to DELETE a pack, and none to approve or publish a QUESTION.

**The server:** edge function \`mcp\` (verify_jwt=FALSE — partners authenticate with their own token,
not a Supabase JWT). Speaks JSON-RPC 2.0 over Streamable HTTP. Ten tools, deliberately narrow:
| Tool | Reads | Writes |
|---|---|---|
| \`list_packs\` | packs (published + draft) w/ per-pack stats, level rules, the brief | — |
| \`get_pack_content\` | existing questions, words already used, pack statistics | — |
| \`check_questions\` | — | — (pure validation, saves nothing) |
| \`propose_questions\` | — | **the review queue ONLY** |
| \`create_pack\` | — | a new pack row (published immediately) |
| \`update_pack\` | — | an existing pack's details (never its slug) |
| \`review_status\` | ALL contributors' queue rows + reject reasons | — |
| \`preview_questions\` | renders drafts/queue as a CHILD sees them | — |
| \`reject_questions\` | — | rejects PENDING queue items (never approves) |
| \`edit_queued_question\` | — | fixes a PENDING queue item, re-validated |

**PACK CREATION (Aug 2026).** \`create_pack\` mirrors the CMS's own PackEditor + \`savePack\` convention
EXACTLY — same \`slugify\` as core.jsx, \`sort_order = count + 1\`, emoji default 💪, the same pack-detail
fields (purpose / focus_areas / style_approach / example_objectives), and an activity-log row. Three
deliberate differences from the CMS form: the slug is collision-checked up front (the form does not
check), the level is validated against the real \`pm_levels\` list, and \`status\` is **published**
rather than draft.

Publishing the CONTAINER immediately is safe because the two gates are independent: a pack is only a
container, and its QUESTIONS still reach it solely through the review queue. A newly created pack is
simply EMPTY until Albert approves content into it. \`update_pack\` patches only the fields supplied;
the slug is immutable because the game and \`get_pack_content\` key on it, and changing \`level\` on a
pack that already has questions returns a WARNING (not a block) since those questions were written to
the old level's word-length band. Every create/update writes \`pm_activity\` with
\`actor = 'partner:<name>'\`, so connector-originated changes are identifiable in the CMS.

**PER-PACK STATISTICS.** \`list_packs\` returns \`stats\` for each pack (live_questions,
distinct_answer_words, awaiting_review) plus a \`how_to_start\` hint, and \`get_pack_content\` returns a
\`statistics\` summary. This exists so a contributor can SEE how full each pack is and choose where the
gaps are, instead of guessing. \`list_packs\` includes DRAFT packs as well as published (and returns
each pack's \`status\`) — otherwise a contributor could not see a pack that was not yet published.

**REVIEW STATUS (Aug 2026).** \`review_status\` closes the feedback loop: a contributor proposes into
a queue and otherwise never learns what became of it. Read-only. Optional \`pack_slug\` narrows it.

VISIBILITY IS SHARED AND EQUAL — every partner sees EVERY contributor's submissions, with
attribution. An earlier version scoped it to the caller; that was removed because the boundary did
not hold anywhere else: under the shared-admin model (option B) partners log into the CMS with the
same credentials and can already see everything. A per-caller filter on this one tool was therefore
cosmetic, and seeing each other's rejections is the fastest way for a new contributor to learn the
bar. It returns totals across all contributors, a \`by_contributor\` breakdown (incl.
approved_but_edited_first per person), \`by_pack\`, the live pending queue with who submitted each
and when, the reviewer's \`reject_reason\` for recent rejections, and a \`your_own\` convenience block.

### Preview, edit and reject — the pre-approval review surface (Aug 2026)

**\`preview_questions\` is the important one.** It renders a question EXACTLY as a child sees it —
the sentence with the masked word in place — AT EVERY LEVEL. It mirrors buildLevelVariants in
core.jsx: whole-word levels blank the entire word (min 3 underscores), otherwise maskWord hides
letters_hidden_default letters at the level's position/grouping. It works on drafts (nothing saved)
or on the pending queue, where it also returns the queue \`id\` so items can be acted on.

Why it matters: every other check is mechanical. The engine can prove two words are different
lengths; it cannot tell you whether a sentence is the right thing to teach a child. Seeing
"I feel _____ when I try." the way a seven-year-old sees it is what makes a human judgement
possible. NOTE: frame_slots are NOT resolved (connector questions never set them, and resolveSlots
would be a fifth parity copy) — rows that have slots are flagged instead of rendered wrong.

**\`preview_questions\` takes \`source\`** — "pending" (default, what is awaiting review) or "live"
(a pack's already-approved bank, requires \`pack_slug\`). The SERVER fetches and renders either. An
earlier version achieved the live case by instructing the assistant to call get_pack_content, convert
____ back to {blank} and remap fields; that worked but was the server's job done by a prompt, and it
was replaced.

**Truncation is reported, never silent.** A preview returns at most PREVIEW_CAP (40) questions, but
the TRUE total is counted separately and returned as \`total_in_pack\` / \`total_awaiting\` alongside
\`showing\` and a \`truncated\` flag, with the note saying so. Reporting only the capped length would
have quietly told the person "12 questions" when the pack had 90 — the same silent-truncation trap
that has bitten this project twice before. Not currently reachable (largest pack is 12) — fixed while
it was still latent.

**The live branch returns \`question_id\`, not \`id\`.** Deliberate: reject_questions and
edit_queued_question only ever accept PENDING review-queue ids. A field called \`id\` on a live
question invites feeding it to those tools; it would fail safely ("Review item not found") but the
naming removes the trap.

**The rendering instruction carries the CMS design tokens** (taken from core.jsx, verified to match):
background #F6F5FB, white cards with #E4E0F0 borders at 16px radius, ink #191728 / #6E6B85, brand
#6C4CE0 for the selected level tab and the masked blank, correct #DEF5F1/#0E8C7E/#0A6B60, wrong
#FDECEC/#C2352F, monospace words — so the playable card looks like part of the product rather than a
generic widget. If the palette in core.jsx changes, this instruction must change with it.

**\`reject_questions\`** rejects pending items with a required reason, via the existing
pm_review_reject RPC (which enforces status='pending' itself). GOTCHA: that RPC stamps \`decided_by\`
from a JWT email claim, which the service-role connector does not have — it would record 'admin'.
The real actor is patched in afterwards as \`partner:<name>\`. Verified live.

**\`edit_queued_question\`** fixes a PENDING item in place (the CMS edits at APPROVAL time instead,
via pm_review_approve's optional params — this is a different, additive path). The merged result is
RE-VALIDATED with the full engine and refused if it breaks a rule, so an edit can never make things
worse; verified live by trying STEADY/GENTLE (same length) and having it correctly refused with the
original left untouched. The row being edited is excluded from the dedup set or it would flag
itself. It deliberately does NOT set the \`edited\` flag — that means "the APPROVER changed it at
approval time" and is what review_status reports as approved_but_edited_first.

**WHY THIS IS ALL SAFE:** every one of these is PRE-approval. Rejecting only removes something from
the pipeline. An edited item stays pending. Nothing here can put a word in front of a child —
pm_review_approve is still the only route, and there is deliberately no tool for it.

### How the preview is rendered — BOTH paths now work

The goal was a PLAYABLE card in chat: sentence, level tabs, two tappable words going green/red.
There are two ways it can happen, and as of Aug 2026 both are live.

**Path 1 — the ARTIFACT (always available, no platform dependency).** preview_questions returns
structured data and the tool description asks the assistant to build the card as an artifact. This
is the FALLBACK and it must stay working: any host without MCP Apps support gets this, and so does
any session whose tools/list predates the widget being enabled.

**Path 2 — the MCP Apps (SEP-1865) WIDGET, verified rendering Aug 2026.** The shim serves a ui://
resource as text/html;profile=mcp-app via resources/list + resources/read, and injects
_meta.ui.resourceUri INSIDE the preview_questions tool object in tools/list (nested form; the flat
_meta["ui/resourceUri"] is deprecated in the spec and deliberately not sent). The view itself is
mcp-shim/view-app.js, raw JSON-RPC over postMessage, no SDK, because the Worker has no bundler.
(preview-app.js and overview-app.js were merged into it — see THE VIEW below.)

THE BUG THAT MADE IT LOOK IMPOSSIBLE, and it is worth knowing exactly what it was. For three
iterations the widget was described as rendering BLANK, and the file recorded a platform gap as the
likely cause. It was never blank. It was CLIPPED to about one card's header. The evidence was in the
screenshot the whole time: the diagnostic status bar read "data received — 12 question(s)" and the
first card's chips were drawing. The host had fetched the resource, the view had mounted, the data
had arrived.

The actual cause: the view never sent \`ui/notifications/size-changed\`. Per SEP-1865, when a host
uses FLEXIBLE dimensions (maxHeight, or nothing at all) the VIEW owns its height and MUST report it,
and the host resizes the iframe to match. The min-height:160px that had been added to force the issue
could never have worked — an iframe is sized from OUTSIDE, so its own stylesheet cannot make it
taller. Three further deviations were found in the same reading of the spec: ui/initialize sent the
wrong params (it wants appInfo + appCapabilities, and availableDisplayModes is what lets a host offer
fullscreen); the initialize RESULT was never read, discarding hostContext.containerDimensions, theme
and displayMode; and \`ui/notifications/context-update\` is not a method in the spec at all, so every
reviewer interaction had been posting into the void — the real one is the ui/update-model-context
REQUEST.

The lesson is not about iframes. Three sessions were spent iterating against a guess when the answer
was in the specification, and a screenshot that showed the widget half-working was read as showing it
not working at all. See rules 4.33 and 4.21.

**Regression safety.** The text content block still carries the full JSON, so path 1 stays reachable
if the widget fails or the host does not support it. The status bar in the view is permanent and
deliberate: it states its own state ("handshake sent", "NO HANDSHAKE after 5s", "12 question(s)"), so
a failure is loud rather than silent. That is rule 4.24, which this feature broke once already.

**Test:** mcp-shim/widget-test.mjs drives the view through the real lifecycle in jsdom — handshake,
capabilities, containerDimensions applied, one card per question, level tabs, correct answer not
revealed before tapping, size reported AND tracking content (2,580px for 12 cards, not 60), spec
method used for context updates, teardown answered. 15 checks. Run it with node directly; it is not
in npm test because it needs jsdom, which is not a dependency of the site build.
CAVEAT, per rule 4.20: this harness MODELS the host, so it can only catch bugs that were modelled.
It is not proof of a render. The render was confirmed by a person looking at a real client.

**If you change the widget's layout, keep reportSize() reachable.** Anything that changes height —
level taps, answer taps, theme, font loading, wrapping — must end up calling it, or the frame will
be wrong again in exactly the way that cost three sessions.

### ARRIVAL: the \`overview\` tool and the connection-time hook

A partner attaching the connector used to arrive at ten tools and no idea what was in the system.
They now get a full picture on arrival.

**THERE IS NO "ON CONNECT" EVENT IN MCP.** Nothing fires when someone attaches a connector, so there
is nowhere to push a greeting. The one thing a host reads at connection is the \`instructions\` string
from \`initialize\`. That is the hook — and it must be a DIRECTIVE TO CALL a tool, never the content
itself: instructions are a static string and would be stale the moment anyone proposed a question.

The shim PREPENDS its orientation directive rather than replacing what the mcp function returns; the
upstream instructions carry the intent-routing that stops an unconditional "always call X first"
from hijacking unrelated requests. It also fires on a greeting or "what can I do here", not only on
a literal first message, because that is when people actually ask.

**THE TOOL.** \`overview\` is read-only and declared FIRST in tools/list. Position is not decorative —
a tool listed first is the one reached for when someone opens with "what's here?". It returns every
pack with live and awaiting-review counts, totals split published/draft, how many packs are EMPTY
(rather than making the reader count fifteen entries), the review queue by pack and contributor, the
nine things a partner can do in plain language, and the one thing they cannot: approve.

**IT IS COMPOSED IN THE SHIM** from the existing list_packs and review_status reads, called with the
CALLER'S OWN token. No new credentials and no new privilege — nothing here is anything that partner
could not already read; it just saves three round trips and a lot of phrasing. It lives in the shim
because the shim deploys from the repo on push. If edge-function CI takes over deploys, this belongs
upstream in mcp.ts, and that is a deliberate trade recorded rather than left silent.

**COMPOSING TOOLS MEANS INHERITING THEIR FAILURE SEMANTICS — see rule 4.35.** Caught by testing the
DEPLOYED shim, not by reading the code: an unauthenticated call returned HTTP 200 with a cheerful
"Partial overview" instead of 401. Nothing leaked, but MCP clients start the OAuth flow off a 401
with WWW-Authenticate. Since overview is now the FIRST call of every session, an expired token would
have shown a partner an empty CMS in confident detail and never prompted them to sign in. 401/403 are
now propagated; a genuine upstream outage (503) is still a partial 200, because those are different
failures and must not be collapsed.

**Partial results are flagged.** A tool whose whole job is "here is where things stand" must never
answer with a confident zero that actually means the call failed. If either leg fails, the headline
says "Partial overview", the failing leg is named, whatever did arrive is still returned, and the
render instruction tells the presenter not to pass partial numbers off as complete.

**Test:** mcp-shim/overview-test.mjs — merge, totals, ordering (packs needing a human sort first,
empty packs sink), the menu, the invariant, tools/list declaration and position, and every failure
mode including the 401/403/503 distinction. 22 checks, no live data touched.

### THE VIEW: one file, both payloads, and the two level controls

**ONE VIEW, NOT TWO.** There were briefly two ui:// resources — a question preview and an overview
menu — each linked to its own tool via _meta.ui.resourceUri. CLAUDE WEB DOES NOT HONOUR THAT. It
loaded the question-preview resource for an \`overview\` call and then sent it nothing, so a partner
saw an idle widget beside a perfectly good answer. It picks ONE view per connector.
Proved, not guessed: each view was made to NAME ITS OWN RESOURCE in its status bar, and one
screenshot settled it (rule 4.21). Reordering resources/list would probably have fixed it and would
also have destroyed the evidence.
So mcp-shim/view-app.js is the single view; both URIs serve it and it dispatches on the SHAPE of the
payload — a \`previews\` array vs \`what_you_can_do\` + \`content_status\` — rather than on which tool
the host believes it is showing, since the host has already been wrong about exactly that. A test
asserts the lifecycle code exists EXACTLY ONCE, because a second copy would have been a fourth
parity problem waiting to happen.

**TILES: ui/message, and what to do when it is refused.** Tapping a capability posts a plain-English
request into the chat via \`ui/message\`. The spec lists NO host capability for it, so the only way to
know whether a host supports it is to send one and READ THE REPLY — and this host refuses it. Every
message now carries an id, its reply is handled, and a 2.5s timeout catches silence.
THE ORDERING MATTERS: the clipboard copy runs DURING the tap, synchronously, inside the gesture.
The first version only fell back AFTER the rejection arrived, which meant the first tap did nothing
visible and the copy needed a second — and a copy fired from an async rejection is not reliable at
all, because clipboard writes require a user gesture. One tap now always achieves something: the
tile says either "Sent" or "Copied — paste it below", keeps its label, and shows the phrase to type
if there is no clipboard.

**TWO LEVEL CONTROLS, on purpose.** The GLOBAL bar sets every question at once — "how does this pack
read at level 7?" is a property of the sitting, not of each question, and setting it twelve times
made comparison at a fixed level nearly impossible. The PER-CARD tabs stay, because the other real
job is checking ONE question ACROSS levels, which is how the same-length bug is actually felt.
A card moved on its own is marked "own level" and the global bar reports MIXED with nothing
selected, rather than highlighting a level that is only true for some of them. Question cards carry
\`.card.q\` and the header \`.card.head\`, so counting cards means counting questions.

**A MERGE HAZARD WORTH KNOWING.** Combining the two views spliced one stylesheet into the other by
cutting at \`body.dark{...}\` — which silently discarded every dark rule after that line. The visible
result was white numbers on white tiles: \`.stat\` kept its light background while \`.stat b\`, having
no colour of its own, inherited the dark-mode text colour. Only the purple stat survived, which made
it look like a design choice. ANYTHING WITH ITS OWN BACKGROUND NEEDS ITS OWN FOREGROUND.

### THE VIEW URI IS CONTENT-ADDRESSED — and why it has to be

**A HOST WILL SERVE YOU YESTERDAY'S WIDGET.** SEP-1865 explicitly allows hosts to prefetch and cache
a ui:// resource, and they key that cache on the URI. There is NO message in the protocol for "that
resource changed". So with a fixed URI, a view can be redeployed, verified live over the wire, and
the person still sees the old one — which is exactly what happened with a wording change: deployed,
confirmed by fetching resources/read, and still wrong on screen for three rounds.

**THE FIX:** \`UI_URI = "ui://positive-minds/view-" + djb2(VIEW_HTML)\`. Change one character of the
view and the URI changes, which a host cannot mistake for something it already holds. Nothing to
remember to bump — and that matters, because the failure is SILENT and looks exactly like a deploy
not working. djb2 rather than crypto.subtle because the URI is built synchronously.
The old fixed URIs stay SERVABLE (a session holding one keeps working) but are no longer advertised.

**ONLY ONE RESOURCE IS ADVERTISED.** Two entries for the same file only invited the host to pick the
"wrong" one, which it did.

**A WIDGET NEVER RE-FETCHES.** An already-rendered widget keeps the HTML it was born with, for the
life of that message. Scrolling back to an earlier preview shows the version from that moment,
permanently — which is not a cache bug and cannot be fixed. When checking whether a view change
landed, ask for a NEW preview; the status line at the top of the card names the build.

### THE VERDICT WORDING LIVES IN TWO PLACES, deliberately

Tapping a word says, exactly:
  correct → "Correct answer — you got it right! 😊"
  wrong   → "Nearly right — you're getting better every time you try 🙂 Try again…"
NEVER "wrong", "incorrect", or anything describing the child in the third person. This view exists so
a person can FEEL what a child feels, and a child using this game is never told they failed.

**THE REVIEWER CHECK SURVIVES, DEMOTED.** The old wrong-answer line ("Marked wrong. If this word ALSO
fits the blank, the question is broken.") was doing two jobs — it was also the prompt that turns a
reviewer's surprise into the same-length bug being caught, the one defect that has broken real
content. Replacing it purely for tone would have removed the check. It now appears under a wrong
answer only, in the small grey hint style, never in the child-facing verdict.

**BOTH RENDERERS CARRY THE STRINGS.** They used to live only in the view, so on a host without MCP
Apps — the documented fallback — Claude phrased the verdict itself and could reproduce the exact
sentence being removed. The wording is now also in preview_questions' render note with an explicit
"do not improvise them". Rule 4.42 applied BEFORE it bit rather than after.

### SYNCING CONTENT OUT: the two APIs, and how to choose

A developer wiring a game or a backend to this CMS needs one decision and then a handful of
parameters. The decision:

  content-api  — SYNCING. Versioning, ?since incremental, deletions, ETag/304, selectable blocks.
                 Use it for the recurring pull that keeps something in step with the CMS.
  game-feed    — SHAPING. A saved profile renames every field and picks the structure, so the
                 consumer gets ITS vocabulary rather than ours. Use it when field names must match
                 an engine you do not control.
Both read the same content, both return the same stats block, and both live at
\`{SUPABASE_URL}/functions/v1/<name>\`. Auth is OPTIONAL: set the CONTENT_API_KEY secret to require
\`X-API-Key\` (or ?key=); unset, the endpoints are public and read-only over published content.

**content-api parameters**
  ?manifest=1            versions and counts only — poll this to decide whether to pull at all
  ?since=<iso|epoch>     only what changed, plus a deletions array of tombstones
  ?include=…             packs, questions, levels, variants, stats, deletions, or all
  ?shape=                nested (default) | keyed (packs keyed by slug) | flat (one question array)
  ?packs= ?levels=       narrow by pack slug, or narrow the variant expansion to certain levels
  ?released=1            only released content (see the gate below)
  ?format=xml            XML instead of JSON

**THE BIG ONE IS \`variants\`.** The pre-rendered per-level sentences dominate the payload:
    default (with variants)     363,038 bytes
    ?include=packs,questions     18,811 bytes     — about 19x smaller
Include them if the client renders what it is given. Omit them and take \`levels\` instead if the
client masks its own words — but then its masking MUST match maskWord exactly, which is the parity
invariant in rule 4.4, and getting it wrong shows a child two correct answers.

**USE THE ETAG.** Every response carries one; send it back as If-None-Match and an unchanged pull is
a 304 with no body. The key covers every parameter, including include, shape and released — so
switching any of them refetches instead of returning a stale 304 for a different question.

**game-feed parameters**
  ?list=1                available profiles
  ?profile=<id|name>     export in that shape (default: first built-in)
  ?stats=1 | ?stats=only add the status block, or return it alone
  ?packs=                narrow — deliberately the SAME parameter name as content-api
  ?released=1 ?format=xml
Profiles are edited in the CMS under Publishing → Export profiles (ProfileBuilder): per-field
mapping (template->sentence, answer->primaryWord), value transforms, structure, root and questions
keys, filters, and include_stats.

**THE STATS BLOCK** (?include=stats, or ?stats=1) is the whole CMS content status in one call,
backed by pm_content_stats(): pack counts by state, question counts and distinct answer words,
level count, review-queue totals, and per-pack live/pending/approved/rejected with descriptions and
versions. Cheap enough for a dashboard to poll, and it short-circuits before loading any content.

**THE RELEASE GATE — off by default, and know why before you turn it on.**
\`released_version\` tracks what has been PUSHED to a configured sync target; publish2 calls
pm_mark_released after a successful Firebase sync or import. A PULL is not a release, so pulls have
never been gated. ?released=1 opts in: only packs where released_version >= content_version.
Today that returns NOTHING, because no push target has ever run — every pack has released_version 0.
If you want the gate in a pull model you must also arrange to release, or the game starves.

**WHAT A CONSUMER SHOULD ACTUALLY DO**, in order:
  1. Poll ?manifest=1 (or send your ETag). If global_version has not moved, stop.
  2. Pull ?since=<your last successful sync>. Apply packs/questions, then apply deletions.
  3. Store the new global_version and the ETag against your sync record.
  4. Never assume a 200 means changed — check the version. Never assume 304 means broken.

### DUPLICATE DETECTION, and APPROVING FROM THE CONNECTOR

**DUPLICATES — the whole database, not exact matches in one pack.** The engine's own \`duplicate\`
flag only fires when an existing question in the SAME pack has the SAME sentence AND the SAME pair.
Everything that actually happens slipped past it: the same sentence with a different pair, a reword
of three words, a question already living in another pack, and anything sitting in the queue rather
than live.
  pm_norm_template()  lowercase, {blank} removed, punctuation stripped, whitespace collapsed. This
                      is the whole trick — without it a comma hides a duplicate.
  pm_find_similar()   searches LIVE content and the PENDING queue together, via GIN trigram indexes
                      over the normalised form, and returns a reason with a severity:
                        1 exact_same_pair  identical sentence AND pair      -> BLOCKS
                        2 same_sentence    identical sentence, new pair     -> BLOCKS
                        3 near_sentence    reworded above the threshold     -> advises
                        4 same_pair        the same two words elsewhere     -> advises
Severity 1-2 block because a duplicate sentence is a defect in the content; 3-4 advise because a
reword may be deliberate and a reused pair is a variety judgement (rule 4.15 draws that line).
REPORT THE STRONGEST REASON: a reword that also reuses the pair first reported as \`same_pair\`,
which reads as a variety nudge when it is actually a near duplicate. Severity now drives both the
label and the ORDER BY so the two cannot disagree.
A FAILED SCAN NEVER BLOCKS A PROPOSAL. It is a check, not a gate.

**APPROVING.** See rule 4.19 for the reasoning and the conditions. In short: approve_question takes
ONE review-queue id plus confirm_answer (the correct word, exactly as shown on the card), and
unapprove_question undoes it by setting the question inactive and returning the row to pending.
can_approve on pm_mcp_tokens gates both, defaults TRUE, and tokens without it never see the tools.
THE INTENDED FLOW, and the reason confirm_answer exists:
    preview_questions (source: pending)   -> play the card, tap the words
    approve_question(id, confirm_answer)  -> one at a time
    unapprove_question(question_id)       -> the moment it looks wrong
Approving straight from a list without previewing defeats the point: a same-length pair or a
distractor that also fits the sentence is invisible until the question is played.

### VOCABULARY: why a word must not play both roles

**THE DEFECT.** In the Calmness pack, seven of twelve words are the ANSWER to one question and the
DISTRACTOR in another. QUIET and RELAXED are a straight swap across adjacent questions. A child is
marked wrong for a word and right for it moments later. Confidence has the same with CALM/PROUD.

**THE DEEPER PROBLEM, which cross-role reuse only makes VISIBLE:** the wrong option is often a
GENUINELY correct answer to its sentence. "I stay PROUD when things go wrong" reads perfectly well.
A child who reads carefully is punished for reading carefully. Reuse is the smell; a plausible
distractor is the disease. THE TEST: read the sentence back with the WRONG word in it. If it still
makes sense, the question has two right answers and only one of them scores.

**IT WAS A MISSING INPUT, NOT A MISSING RULE.** get_pack_content used to return
\`answer_words_already_taken\` and NOTHING about distractors — so Claude knew which words were
answers and picked wrong-options blind, landing on words that are correct two questions along.
It now also returns \`distractor_words_already_used\` and \`every_word_in_use\`, and the note directs
writers to move AWAY from that list rather than merely avoid exact duplicates.
THE BRIEF now argues for vocabulary as a goal in itself: twelve questions built from six words teach
less than twelve built from twenty-four. Calmness is 12 questions, 23 word-slots, 16 distinct words.

**check_questions and propose_questions return \`vocabulary_advice\`** per question when a draft's
wrong option is already an answer, its answer is already someone's wrong option, or the answer word
is simply reused. ADVISORY, NEVER BLOCKING (rule 4.15) — it does not break the engine, so it must
not stop a proposal, but the writer and the reviewer should both see it.
FIRST VERSION COMPUTED IT AND DID NOT RETURN IT, which is the same as not having it. Caught only by
running it over the wire against a real pack.

**The nine live instances are NOT auto-fixed.** That is content judgement.

### THE CONNECTOR LOG: what to read when a connection misbehaves

pm_connector_log records EVERY request, logged in a wrapper around the whole handler — the handler
has 22 return points and several (discovery, CORS preflight, the sign-in page, a thrown handler)
answer before any per-branch logging could run. That left the single most important question
unanswerable: when a client appears to do nothing, DID IT EVEN ASK US?

Per request: \`phase\` (discovery/register/authorize/token/mcp), method, redacted query, status,
\`had_auth\`, ua, \`cf_ray\`, \`country\` (which distinguishes Anthropic's cloud from a browser — the
two user agents in an OAuth flow come from different places), \`session_id\`, a truncated \`err\` body
on >=400, and \`ms\`. The per-branch log survives only where it knows the JSON-RPC METHOD, which the
wrapper cannot see without consuming the body.

**NEVER LOG A SECRET.** token, code, code_verifier, client_secret, access_token, refresh_token,
password and authorization become \`<redacted:N chars>\` — present, so absence is distinguishable
from omission, never valued. mcp-shim/logging-test.mjs asserts this with a real-shaped pmk token, an
auth code and a PKCE verifier. A log that quietly accumulates credentials is a breach waiting to
happen regardless of who can read the table.

**A HEALTHY CONNECT LOOKS LIKE THIS** (10 Aug 22:36, read straight off the table):
    python-httpx  POST /mcp                                401   <- correct, triggers OAuth
    python-httpx  GET  /.well-known/oauth-protected-resource     200
    python-httpx  GET  /.well-known/oauth-authorization-server/mcp  200
    python-httpx  POST /mcp/register                       201
    browser       GET  /mcp/authorize                      200   <- sign-in page
    browser       POST /mcp/authorize                      200   <- token accepted
    python-httpx  POST /mcp/token                          200   <- exchange
    Claude-User   POST /mcp  x8, had_auth=true             200/202
\`Claude-User\` rows at 200 with had_auth true mean the connector IS working, whatever any badge says.

### THE "CONNECTION HAS EXPIRED" BADGE IS AN UPSTREAM BUG — do not chase it

The Connectors page can show "Connection issue — Connection has expired" while the connector works
perfectly in chat. THIS IS NOT OUR SERVER. Established from the log above: a complete OAuth flow and
eight authenticated sessions, zero errors, and no polling of any kind afterwards — nothing we serve
feeds that badge.

It is a documented, open, unfixed bug in Anthropic's claude.ai proxy: anthropics/claude-ai-mcp#228,
with #155 (token never attached), #188 (unreachable after the Connections->Customize migration) and
#207 (token issued but never used). First-party connectors are unaffected; it is specific to custom
connectors via mcp-proxy.anthropic.com.

**OUR DATA CONTRADICTS THEIR STATED TRIGGER, which is worth reporting.** #228 says the badge appears
once the access token expires (~1 hour). Ours does not expire until 2036 and the badge appeared
within minutes. So expiry is not the cause; the proxy marks the connection stale for some other
reason.

**DO NOT "FIX" THIS.** Four separate remedies were attempted in one night — a copy-the-URL panel, a
hijack detector, a full shim revert — and every one was wrong because the premise was. Test the
connector by opening a chat and calling a tool. Never by reading the badge (rule 4.41).

### TOKEN LIFETIMES ARE EFFECTIVELY INDEFINITE, and that is deliberate

ACCESS_TTL and REFRESH_TTL are both ~10 years. The usual advice — short access tokens, frequent
refresh — assumes the client REFRESHES. The claude.ai proxy does not, ever (#228, and our own log:
one /token hit at connect, zero refresh grants). So a short expiry is not a security boundary here.
It is a SCHEDULED OUTAGE: the day it lapses the connector dies and nobody remembers why. Everyone in
those issue threads with 1-hour tokens re-authenticates DAILY.

**REVOCATION IS THE CONTROL, and it is stronger than the expiry ever was.** authenticate() re-reads
pm_mcp_tokens.active on EVERY request, so this kills every session for a partner on their next call,
mid-session, immediately:
    update pm_mcp_tokens set active = false where partner = '<name>';

**RESIDUAL RISK, stated not buried:** a leaked access token stays valid until someone revokes the
partner token. That was already true for 30 days; it is now true indefinitely. Mitigations are
revocation (instant) and pm_connector_log (every use recorded).

Ten years rather than a NULL expiry because the auth path checks expires_at unconditionally, and
adding a null branch to the hot path of AUTHENTICATION is a new way to get authentication wrong.

### CONNECTING: the four defects, and why the diagnosis took all night

An earlier version of this section blamed Claude's own OAuth flow, citing \`step=end_error\` and a
\`flow_id\` collision. THAT WAS WRONG — the end_error came from driving the flow in a headless browser
with no Claude session, which naturally fails. It is corrected here because the wrong version was
confidently written and would have sent the next person nowhere.

**THE REPORTED SYMPTOM:** the connector authenticates and the Connectors page then shows
"Connection has expired. You can reconnect to re-authenticate." Server logs full of 200s.

**FOUR REAL DEFECTS, all found, all fixed. None of them alone was "the" cause:**
1. The mcp FUNCTION issued no refresh_token. The code was in the repo and the DB columns existed;
   the hand-paste deploy had simply never happened. Fixed by the first CI deploy.
2. The SHIM kept its OWN hand-written copy of the OAuth metadata, advertising
   grant_types_supported ["authorization_code"] while the function advertised both. Clients read the
   shim's, because it is the one at the domain root. Fixed by DERIVING it from the function.
3. \`/register\` returned grant_types ["authorization_code"] hardcoded, ignoring what the client
   asked for. The registration response is what tells a client what it is ALLOWED to do, so this
   alone stops any refresh regardless of the other two.
4. \`initialize\` answered 200 to anyone, on the reasoning that "the handshake precedes the token".
   Backwards for a protected resource: the 401 with WWW-Authenticate IS the handshake.

**AND THEN THE ACTUAL ANSWER: the connector was working.** Once pm_connector_log existed, one query
settled it. Two user agents tell the whole story — \`python-httpx\` is Anthropic's backend running
the OAuth flow, \`Claude-User\` is the live MCP session:
    03:31:36  Claude-User   initialize 200 auth=true    <- already connected, BEFORE the attempt
    03:31:37  Claude-User   tools/list 200 auth=true
    03:31:40  python-httpx  initialize 401 auth=false   <- OAuth begins
    03:31:41  python-httpx  register   201
    03:31:58  python-httpx  token      200
    03:31:59  Claude-User   initialize 200 auth=true
    03:32:00  Claude-User   tools/list 200 auth=true
Three complete authenticated sessions, all 11 tools listed. The Settings card was showing a status
that did not match what its own backend was doing. THE CARD WAS NOT EVIDENCE. See rule 4.41.

**HOW TO DIAGNOSE THIS NEXT TIME — one query, not four hours:**
    select to_char(at,'HH24:MI:SS') t, path, rpc_method, status, had_auth, ua
    from pm_connector_log where at > now() - interval '20 minutes' order by at;
\`Claude-User\` rows returning 200 with had_auth true means the connector IS working, whatever any
badge says. Test it by opening a chat and using a tool, never by reading the Connectors page.

**pm_connector_log** is written from the shim, INSERT-ONLY under the anon key — it can write a line
and never read one back, so it cannot enumerate clients, partners or tokens. Capped at 2000 rows by
pm_connector_log_prune (this project has blown a storage quota once). Fire-and-forget with errors
swallowed: an observer must never be able to break the thing it observes.

### DEPLOY CHECKING: why a downloaded edge function never matches your source

\`supabase functions download\` does NOT return your source. It returns the extracted ESZIP BUNDLE:
TypeScript transpiled away, formatting re-printed, comments gone, imports resolved and hoisted. On
mcp the download came back 6,400 bytes SMALLER than the repo file.

This matters because the obvious drift check — diff deployed against repo — is a GUARANTEED FALSE
POSITIVE. The first dry run reported drift on all five functions, including ones with no reason to
have drifted. A check that always fires is worse than no check at all.

Normalising both sides (comments, type annotations, generics, non-null assertions, trailing commas,
all insignificant whitespace) narrowed mcp from 6,400 raw bytes to 190. Every remaining divergence
inspected was still an artifact: a type annotation remnant, redundant parentheses the bundler drops
(\`(a*31+b)>>>0\` vs \`a*31+b>>>0\` — identical, since >>> binds looser than +), and a hoisted import.

WHERE THIS LANDS, honestly. The dry run reliably proves the token works, that every function is
deployed, and gives sizes plus a first-divergence with context for a person to judge. It CANNOT be a
pass/fail gate, and it was not tuned until it went green — a check tuned until it passes is worth
nothing. The first-divergence view is not proof of full equality and must not be quoted as such.

THE REAL FIX IS TO STOP NEEDING THE COMPARISON. Once one \`mode: deploy\` runs, deployed == repo is
true BY CONSTRUCTION and CI keeps it true. The drift question then dies permanently, which is the
actual point of the workflow.

### The preview payload is QUESTION-FIRST, on purpose

preview_questions once returned each question with every level nested inside it. Twelve questions x
ten levels = 120 level objects, and the natural way to summarise that is level-by-level — so asking
"preview the pending questions" produced a table of level rules instead of the questions. The data
shape, not the prompt, decided the rendering.

Each preview is now ONE QUESTION: "sentence" (already masked, ready to display), "options" (the two
words), "correct", "level_shown", plus a compact "at_other_levels" of {level, sentence} for tabs, and
"n" for ordering. Only ONE level renders by default; pass "levels" for more. Keep it this way — if
levels ever outnumber questions in the payload again, the rendering will drift back.

### Routing: the instructions branch by intent

The connection instructions used to open with "ALWAYS call list_packs first". That is the WRITING
workflow, but stated unconditionally it hijacked every request, so a preview request called
list_packs and showed its level rules. The instructions now branch: PREVIEW/PLAY/REVIEW-PENDING goes
straight to preview_questions and is told explicitly not to call list_packs first; WRITING keeps the
list_packs to get_pack_content to check_questions to propose_questions chain; progress, packs and
queue-fixing each get their own line. The same warning is repeated inside preview_questions' own
description so it survives if the instructions are truncated or ignored.

**\`reject_questions\`** rejects pending items with a required reason, via the existing
pm_review_reject RPC (which enforces status='pending' itself). GOTCHA: that RPC stamps \`decided_by\`
from a JWT email claim, which the service-role connector does not have — it would record 'admin'.
The real actor is patched in afterwards as \`partner:<name>\`. Verified live.

**\`edit_queued_question\`** fixes a PENDING item in place (the CMS edits at APPROVAL time instead,
via pm_review_approve's optional params — this is a different, additive path). The merged result is
RE-VALIDATED with the full engine and refused if it breaks a rule, so an edit can never make things
worse; verified live by trying STEADY/GENTLE (same length) and having it correctly refused with the
original left untouched. The row being edited is excluded from the dedup set or it would flag
itself. It deliberately does NOT set the \`edited\` flag — that means "the APPROVER changed it at
approval time" and is what review_status reports as approved_but_edited_first.

**WHY THIS IS ALL SAFE:** every one of these is PRE-approval. Rejecting only removes something from
the pipeline. An edited item stays pending. Nothing here can put a word in front of a child —
pm_review_approve is still the only route, and there is deliberately no tool for it.

### How the preview is rendered — the MCP Apps route, and what the "dead end" really was

This section previously recorded MCP Apps as a platform-level dead end. That conclusion was WRONG,
and it is left here in corrected form because the way it went wrong is the useful part.

**The MCP Apps route (SEP-1865) works and is enabled.** The shim implements every rung to spec:
\`initialize\` declares \`resources\` and ECHOES the client's protocolVersion (the mcp function
hardcodes an older one, and a silent downgrade can stop a host offering UI at all);
\`_meta.ui.resourceUri\` is injected INSIDE the preview_questions tool object, not on the result;
\`resources/list\` and \`resources/read\` serve a CONTENT-ADDRESSED \`ui://positive-minds/view-<hash>\` as
\`text/html;profile=mcp-app\`; and tools/call returns structuredContent. All verified over the wire.

**THE FALSE CONCLUSION, and how it survived five attempts.** This file used to state that Claude Web
advertises \`io.modelcontextprotocol/ui\`, accepts the capability declaration and the tool's
\`_meta.ui\`, and then NEVER calls \`resources/list\` or \`resources/read\` — a platform gap matching a
public bug report, unfixable from here. Every part of that was mistaken. The host did fetch the
resource and did mount the view. What looked like "never reaches for the widget" was a view that
mounted, received its data, rendered, and was then CLIPPED to about one card because it never
reported its height (see the section above for the mechanism and the three other spec deviations).

Two things kept the wrong answer alive. First, a screenshot showing the widget HALF working — status
bar populated, first card drawing — was read as showing it not working. Second, a matching public bug
report made the platform explanation feel confirmed; it was pattern-matched to, not tested against.
The instrumentation that "showed" resources/read was never called was measuring the wrong thing.

**Both paths ship.** The artifact path stays as the fallback:  Claude, given the structured data, will build the interactive
card itself as an artifact. That was happening by accident, so the shim now makes it deliberate:
preview_questions results carry a \`how_to_show_this\` instruction telling Claude to render a playable
artifact and, importantly, NOT to reveal which word is correct before it is tapped. Same experience,
no platform dependency.

**The MCP Apps layer is ACTIVE, not dormant.** Earlier text here said to leave it in place because it
might light up one day. It has. Do not delete it and do not treat it as speculative.

**Where this lives, and why it is in the shim not mcp.ts:** the Worker deploys exactly, from the repo,
via CI. mcp.ts can only be deployed by transcribing ~1,300 lines inline. The shim owns "how a preview
is presented"; the mcp function owns what a preview IS. If edge-function CI deploys are ever set up,
the artifact hint belongs in the tool's own note in mcp.ts.

\`check_questions\` is the interesting one: Claude validates its OWN drafts against the real engine
before proposing, so it catches and fixes the same-length-words bug itself. Verified live — given
BRIGHT/GENTLE it correctly reported "GENTLE also fits the blank at levels 7, 8, 9, 10 — two correct
answers", AND noticed BRIGHT was already used. The queue gets BETTER content, not just more.

**AUTH: OAuth 2.1 with PKCE — and this was NOT a choice.** I first built a shared-secret bearer
token, then discovered that Claude's "Add custom connector" screen offers a URL and an OAuth client
ID/secret and NOTHING else. There is no field to paste a bearer token, so Claude would simply never
send that header. The MCP spec is unambiguous: a protected server does OAuth 2.1, or it is authless.

THE LESSON, worth writing down: ask "how will someone ACTUALLY use this?" BEFORE building, not after.
I assumed a token field existed because that is how most APIs work, built for it, and only found out
when Albert asked how partners connect.

The partner's pmk_ token was not wasted — it became the LOGIN CREDENTIAL. Because the partners are
three trusted people, the consent screen is just "paste the token you were sent". From their side:
click Connect → a sign-in page opens → paste → done.

Five endpoints, all on the \`mcp\` function:
| Endpoint | Purpose |
|---|---|
| \`/.well-known/oauth-protected-resource\` | RFC 9728 — "here is my authorization server" |
| \`/.well-known/oauth-authorization-server\` | RFC 8414 — "here are my endpoints" |
| \`POST /register\` | RFC 7591 — Claude registers itself |
| \`GET/POST /authorize\` | the partner's sign-in page |
| \`POST /token\` | code → access token, PKCE verified |
A 401 MUST carry \`WWW-Authenticate\` or Claude never starts the flow.

**THREE BUGS IN THE BASE URL**, all real, all caught by testing rather than assuming:
1. Supabase terminates TLS at the edge, so \`url.origin\` sees plain HTTP — and Claude rejects an
   insecure OAuth server outright.
2. The function is served at \`/functions/v1/mcp\`, not \`/mcp\` — so it advertised URLs that did not exist.
3. The \`host\` header INSIDE the container is Supabase's internal one (edge-runtime.supabase.com), not
   the project's domain — so it sent Claude to the wrong server entirely.
All three vanish if you derive the base from \`SUPABASE_URL\`, which is the authoritative public origin.
Every one of these returned HTTP 200 while being completely wrong: "it responded" is not "it works".

Tables (all RLS-on, ZERO policies — the browser cannot read any of them): pm_oauth_clients,
pm_oauth_codes (PKCE-bound, single-use, 10-minute), pm_oauth_tokens (30-day).

### The Cloudflare discovery shim — REQUIRED, not optional

**THE CONNECTOR URL IS THE SHIM, NOT THE SUPABASE FUNCTION:**
\`https://positive-minds-mcp.alcharles1980.workers.dev/mcp\`

**The problem it solves.** Claude's custom-connector OAuth discovery probes the ORIGIN ROOT for
\`/.well-known/oauth-protected-resource\` and \`/.well-known/oauth-authorization-server\` (bare, and in
the RFC 8414 host-inserted form). A Supabase edge function is served under \`/functions/v1/mcp\` and
CANNOT serve root \`/.well-known/*\` paths — so every probe 404s, Claude never starts the sign-in flow,
and the connector reports **"no tools available"** with no sign-in screen ever appearing. Confirmed
from logs: ZERO well-known requests reached the gateway. This is structural, not a bug in our code —
a bare Supabase function cannot host a Claude custom connector.

**The fix** (\`mcp-shim/\` in the repo — a Cloudflare Worker on its own origin, deployed by
\`.github/workflows/deploy-mcp-shim.yml\` using the existing CLOUDFLARE_* repo secrets):
1. serves both discovery documents at its ROOT (covering bare, \`/mcp\`-suffixed and OIDC forms),
   advertising its OWN URLs;
2. proxies \`/mcp\`, \`/mcp/token\`, \`/mcp/register\` to the UNCHANGED Supabase function;
3. rewrites the 401 \`WWW-Authenticate\` header to point at its own discovery doc;
4. serves its OWN sign-in page for \`GET /mcp/authorize\`, CMS-themed, and submits it via JS.

**Why the shim serves the sign-in page itself.** Proxying Supabase's login page failed twice: the
proxied response arrived as \`content-type: text/plain\` (browsers rendered raw HTML source, so there
was no form to type into), and its native \`<form method="POST">\` submit did NOTHING inside Claude's
OAuth window — the Connect button appeared dead. The shim now renders its own page and posts via
\`fetch\` with an \`X-Shim-Ajax\` header, converting Supabase's 302 into \`{ok, redirect}\` JSON that the
page then navigates to. It shows "Connecting…" and real error text instead of failing silently.
When transforming a proxied body, DROP \`content-length\`/\`content-encoding\`/\`transfer-encoding\` —
they become wrong and cause exactly this class of failure.

**THE LESSON.** The original self-test "proved" the whole OAuth flow end-to-end — but it HARD-CODED
the discovery URLs, so it never exercised the one step a real client performs first. It passed while
the connector was completely unusable. A test that skips the client's own discovery is not a test of
the client's path.

**Table \`pm_mcp_tokens\`** — same security posture as pm_ai_config: RLS on, ZERO policies, so the
browser cannot read it at all. Only sha256 HASHES are stored; the raw token is shown ONCE at creation
and is genuinely unrecoverable. Verified: an authenticated admin reading the table gets [].
RPCs: \`pm_mcp_issue_token\` (returns the raw token exactly once), \`pm_mcp_list_tokens\` (never returns
a token), \`pm_mcp_revoke_token\`.

**Page:** Claude Connector (connector.jsx). Issue a token, see usage, revoke access, and the setup
instructions to hand a partner.

**ATTACK-TESTED:** no token → 401. Forged token → 401. Forged token attempting to write → 401 and
nothing reached the database. A successful propose landed in the QUEUE tagged \`partner:...\`, and ZERO
questions reached the live pack.

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

## 11y. STARTING A NEW SESSION — everything needed to continue development

Written for a fresh assistant with no memory of this project, holding only a GitHub PAT. Follow it
top to bottom; it assumes nothing.

### 1. Get the code
The repo is PRIVATE. With a PAT (classic, \`repo\` scope):
    git clone https://x-access-token:<PAT>@github.com/alcharles1980-design/positive-minds-cms.git
    cd positive-minds-cms
    git remote set-url origin https://github.com/alcharles1980-design/positive-minds-cms.git
That last line matters: cloning with the token embeds it in .git/config. Scrub it, never commit it,
never echo it into output. Push with the token supplied on the command line instead:
    git push https://x-access-token:<PAT>@github.com/alcharles1980-design/positive-minds-cms.git main

### 2. Set up
    npm install
    node tools/workspace.cjs      # mirrors src/ -> v2/ and edge-functions/ -> the paths scripts expect
Nothing else. There is no framework, no bundler, no dev server.

THE LAYOUT, so nothing is a surprise:
  src/*.jsx              21 modules, the whole CMS. shell/core/primitives are the spine; views1,
                         views2, editors, levels, generator, aireview, aisettings, publish1,
                         publish2, realtime, features, engine, firebase, firebase2 are pages and
                         subsystems; connector.jsx is partner tokens; sysarch.jsx is the partner
                         setup guide shown in the app; devdocs.jsx is THIS document; devnotes.jsx
                         is the viewer over it plus a scratchpad backed by pm_dev_notes.
  tools/                 workspace.cjs (mirror), split.cjs (pm_cms.jsx -> src/), assemble.cjs
                         (src/ -> pm_cms.jsx), build.cjs (-> index.html), verify.cjs (proves the
                         round trip is byte-identical)
  mcp-shim/index.js      the Cloudflare Worker partners connect to; view-app.js is the MCP App UI
  edge-functions/*.ts    mcp, content-api, game-feed, pack-describe, generate-questions
  engine.js runtime.js read.js inspect.js interact.js visual.js   the six test harnesses

### 3. Read, in this order
  1. This file's section 11z — current state, what is temporary, what is outstanding.
  2. DOC_CLAUDE_MD's golden rules, 4.1-4.45. EVERY ONE EXISTS BECAUSE SOMETHING BROKE. They are
     numbered oldest-first, listed newest-first, and none is theoretical.
  3. DOC_BUILD_PROMPT if you need to understand a subsystem you have not touched.

### 4. The build pipeline — non-negotiable order
    edit src/*.jsx
    bump CFG.build in src/core.jsx        (e.g. 2026.08.10-29 -> -30)
    npm run assemble && npm run build && npm run verify
\`assemble\` concatenates src/*.jsx into pm_cms.jsx; \`build\` compiles to index.html + public/
index.html; \`verify\` proves split->assemble is byte-identical and the two HTML files match.
NEVER hand-edit pm_cms.jsx or index.html — they are generated and will be overwritten.

### 5. The test suites — run ALL of them before pushing
    npm test        # runs SIX suites: engine, runtime, interact, inspect, visual, read
There are six, not two. engine.js and runtime.js are the ones people remember; read.js, inspect.js,
interact.js and visual.js exist, do real work, and are easy to skip for a whole session without
noticing (rule 4.47). Then, after any change under mcp-shim/, run these three by hand — npm test
does NOT cover them:
    node mcp-shim/widget-test.mjs      # the MCP App view, both payload shapes, in jsdom
    node mcp-shim/overview-test.mjs    # the overview tool, failure modes, URI behaviour
    node mcp-shim/logging-test.mjs     # redaction — asserts no secret can reach the log
KNOW THE BASELINE: test:visual reports ~153 MINOR defects and 0 serious. That is steady state (touch
targets under 40px in a desktop-density UI), not a regression. Watch the SERIOUS count.
Edge function changes: compile-check before deploying, because a syntax error ships silently:
    npx esbuild edge-functions/mcp.ts --outfile=/tmp/check.js --format=esm --target=es2022

### 6. What deploys where, and how
Everything deploys from a push to main. There are three workflows:
  .github/workflows/deploy.yml               -> the SITE Worker (positive-minds-cms)
  .github/workflows/deploy-mcp-shim.yml      -> the SHIM Worker (positive-minds-mcp)
  .github/workflows/deploy-edge-functions.yml-> Supabase edge functions, on edge-functions/** only
  .github/workflows/mcp-selftest.yml         -> exercises the connector end to end against the
                                                DEPLOYED shim; run it after touching auth or the
                                                shim, since it tests the thing users actually hit
Secrets already configured: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SUPABASE_ACCESS_TOKEN.
Edge functions can also be dispatched manually with mode=dry-run (compares deployed vs repo, changes
nothing) or mode=deploy, optionally only=<slug>.
Deploys take roughly 60-90 seconds. VERIFY OVER THE WIRE AFTERWARDS — a green Action is not proof
(rule 4.26). Fetch the site and check CFG.build appears; call the shim and check the behaviour.

### 7. Services and identifiers
  Supabase project ref  tytrmjjucqijzcrbwjfm
  Site                  https://positive-minds-cms.alcharles1980.workers.dev
  Connector (the SHIM)  https://positive-minds-mcp.alcharles1980.workers.dev/mcp
  Partners connect to the SHIM's /mcp, never the Supabase function — the shim serves the discovery
  documents at the domain ROOT, which is the only place Claude looks for them.

### 8. How to verify anything
Read pm_connector_log for connector behaviour — it answers in one query what inference cannot:
    select to_char(at,'HH24:MI:SS') t, phase, method, path, status, had_auth, country, ua
    from pm_connector_log where at > now() - interval '30 minutes' order by at;
For the app, fetch the deployed site and grep for what you changed. For edge functions, call them.

### 9. Things that will bite you
- Doc text lives inside JS template literals. ESCAPE EVERY BACKTICK or the build breaks.
- NEVER verify a deploy with a WRITE tool against live data (rule 4.23). A pack description was
  overwritten and lost that way.
- The connector is in REAL USE. pm_review_approve is the only route content takes into a pack.
- The Connectors page badge lies (upstream bug). Test with a tool call, never the badge.
- On EVERY change, update ALL THREE docs in devdocs.jsx in the SAME pass.

### 10. Before you finish
Bump CFG.build, run every suite, update all three docs, push, and VERIFY THE DEPLOY OVER THE WIRE.
If you found something that surprised you, write a numbered rule — that list is the most valuable
thing in the repo.

## 11z. WHERE THINGS STAND (read this first when picking the project back up)

LIVE AND WORKING
- Connector is in real use. Questions have been proposed, approved and rejected through it.
  TOKENS (10 Aug): a shared \`beta\` token was issued for onboarding trials. SHARED IS A TRADE — every
  submission from it reads "by beta", so contributors cannot be told apart in review and rejection
  feedback cannot reach the person who wrote the question. Fine to get people through the door,
  wrong before anyone reviews volume. Switch to per-person tokens (pm_mcp_issue_token) before that.
  Multiple people CAN use one token simultaneously: pm_oauth_tokens is keyed on access_token and
  token_id has no unique constraint, so each sign-in adds a session and none evicts another.
  ACCURACY NOTE (9 Aug): three tokens are active, but the traffic is all Albert's. "albert" has
  55 calls and "albert-reconnect" 16, and those two hold the only bound OAuth tokens. "Steve",
  issued 16 Jul, shows calls_made 0, last_used_at null and no OAuth token — on the data, Steve
  has never completed a connection. Confirm before treating him as an active contributor, and
  before clearing anything of his in the token cleanup.
- Ten tools: list_packs, get_pack_content, check_questions, propose_questions, create_pack,
  update_pack, review_status, preview_questions, reject_questions, edit_queued_question.
- Connector URL is the Cloudflare shim: positive-minds-mcp.alcharles1980.workers.dev/mcp
  (NOT the Supabase function — see the discovery-shim section).
- Preview returns question-first data; the assistant renders it as a playable artifact.
- Site deploys automatically on push (wrangler deploy, Worker + static assets from ./public).
  The shim deploys automatically on push to mcp-shim/.

EDGE FUNCTIONS — CI IS LIVE AND HAS DEPLOYED. deployed == repo is now true by construction.
- First real deploy 10 Aug, and it immediately fixed a production defect: the mcp function had been
  running without refresh-token support for weeks because the code was in the repo and the
  hand-paste never happened. That is exactly the failure the workflow existed to prevent.
- \`only: <slug>\` WORKS. An earlier note here claimed it did not, on the evidence of five functions
  showing fresh timestamps right after an only:pack-describe dispatch. Wrong: a PUSH-triggered run
  forty seconds earlier had deployed everything, which is correct behaviour — push deploys all
  changed functions and sets no filter. The canary log reads ONLY="pack-describe" and
  "Deployed Functions: pack-describe", exactly as intended.
  Two runs seconds apart, and the effect was attributed to the wrong one. When timestamps cluster,
  check WHICH run produced them before writing down a bug (rule 4.40 — read the instrument).
- WHAT ACTUALLY DEPLOYED THE REFRESH-TOKEN FIX: commit a1ca5a8, "OAuth: issue refresh tokens and
  support the refresh_token grant", which had been sitting in the repo UNDEPLOYED from an earlier
  session. The first push through the new CI shipped it automatically. The hand-paste gap closed
  itself the moment CI existed, which is a better argument for the workflow than any written here.
(historical note below)
EDGE FUNCTIONS — the state before 10 Aug
- SUPABASE_ACCESS_TOKEN was added 9 Aug 2026. deploy-edge-functions.yml runs, authenticates and can
  download every deployed function. Verified, not assumed.
- WHAT HAS NOT HAPPENED: no automated deploy has run. Until one does, the live functions are still
  whatever was last hand-pasted, and the hand-paste risk is armed but not yet retired. The first
  \`mode: deploy\` run makes the REPO authoritative and ends this whole class of problem permanently.
  Suggested order: \`only: pack-describe\` first as a canary (smallest, nothing depends on it), verify
  over the wire, then the full run.
- DRIFT, as far as it can be determined: NONE behaviourally. See the dry-run section for why that
  sentence has a caveat in it and cannot be made unconditional.

TEMPORARY THINGS STILL IN PLACE (remove when convenient)
- The SYNC API is documented for developers in two places, kept in step: the CMS itself
  (Publishing -> Channels & sync -> API reference, with per-endpoint parameter tables and copyable
  recipes) and the SYNCING CONTENT OUT section of this document. Change one, change the other.
- pm_connector_log records every connector request (capped at 2000 rows, self-pruning). KEEP IT. It
  is the thing that made connection failures readable, and it settled in one query what four hours
  of theorising could not. See THE CONNECTOR LOG section for how to read it.
- THE "CONNECTION HAS EXPIRED" BADGE IS AN UPSTREAM BUG (anthropics/claude-ai-mcp#228). The
  connector works; the badge lies. Do not chase it — four separate remedies were attempted in one
  night and every one was wrong because the premise was. Test with a tool call in a chat.
- TOKENS DO NOT EXPIRE in any practical sense (~10 years, and all 31 existing sessions were extended
  to Aug 2036 on 10 Aug). Deliberate: the proxy never refreshes, so a short expiry is a scheduled
  outage rather than a boundary. Revocation is the control — pm_mcp_tokens.active is re-read on
  every request. See rule 4.44 before shortening this.
- CROSS-ROLE WORD REUSE: still nine live instances (7 Calmness, 2 Confidence). Detection now exists
  as ADVICE on new drafts (vocabulary_advice) and the inputs were fixed so it should stop recurring,
  but the existing content has NOT been corrected — that is content judgement. Confidence's
  CALM/PROUD swap is the clearest and worth fixing first.
- OAuth clutter from 10 Aug troubleshooting: ~20 extra pm_oauth_clients rows (every Connect
  registers a fresh client) and 27 \`beta\` sessions in pm_oauth_tokens, plus a few clients named
  diagnostic/browser-test/textcheck from testing the flow by hand.
  DELIBERATELY LEFT: deleting a client cascades to its tokens, and \`beta\`'s live sessions are spread
  across these clients — tidying would cut working connections for no gain. Harmless where it is.
- TOKENS ALL LEFT ACTIVE by decision (10 Aug): albert (55 calls), albert-reconnect (47), beta (131,
  in daily use), Steve (0, never connected). Nothing is revoked.
- (pm_tool_log and toolLog() are GONE — dropped 10 Aug, superseded by pm_connector_log, which
  records strictly more and prunes itself.)
- (The MCP Apps widget is no longer here. It is ACTIVE and verified rendering — see the widget
  section. It is not temporary and must not be removed.)

KNOWN OUTSTANDING (not bugs in the code)
- Admin password is weak, and Supabase leaked-password protection is off. One shared admin account is
  used by all partners; that account can approve, edit and delete children's content.
- A GitHub PAT was used throughout development and should be rotated.
- The Calmness pack's description was overwritten during a smoke test (pm_activity id 8, actor
  partner:albert-reconnect, 9 Aug 09:36, detail "updated via Claude connector (description)").
  The original text is still UNRECOVERABLE — there is no history table, pm_activity records only
  WHICH field changed and never its previous value, and the repo holds no copy. The fixture in
  inspect.js is NOT a witness: it is hand-written test data and disagrees with production on other
  packs. On 9 Aug the smoke-test value "Find your calm." was replaced with a reconstruction,
  "Find your calm and stay steady when things feel big.", written to match the two-clause house
  pattern every other pack follows and the pack's own surviving purpose/focus_areas/style_approach.
  It is a reconstruction, not the original. See rule 4.23.
- Five stale OAuth client registrations and two debug tokens ("albert", "albert-reconnect") can be
  cleared; keep Steve's.
- Twelve published packs currently have no approved questions. Harmless given the separate CMS-to-game
  sync gate, but worth knowing.
- CROSS-ROLE WORD REUSE is LIVE and unchecked. In the Calmness pack SEVEN of twelve words are the
  ANSWER in one question and the DISTRACTOR in another — QUIET and RELAXED are a straight swap across
  two adjacent questions, so a child is marked wrong for QUIET and then right for it. The same shape
  is in the pending Focus Pack batch (CALM and PLAN each play both roles). No check sees it: see rule
  4.15 for why, and for the test that says it ought to. The mechanics are fine in both packs — every
  pair differs in length, so nothing is \`ambiguous\` at any level. This is the same family of defect as
  the original CALM/PROUD find in rule 4.16, one level up.

## 12. Recent hardening & changes (most recent first)
- **Aug 2026 — CONNECTOR MADE ACTUALLY USABLE + pack creation.** Four related changes:
  1. **The Cloudflare discovery shim** (\`mcp-shim/\`). The connector had NEVER worked from a real
     Claude client: a Supabase edge function cannot serve root \`/.well-known/*\`, which is where
     custom-connector OAuth discovery probes, so Claude reported "no tools available" and no sign-in
     screen ever appeared. A Worker now serves the discovery docs at its own root, proxies the rest to
     the unchanged Supabase function, and serves its OWN CMS-themed sign-in page (the proxied Supabase
     page rendered as text/plain and its native form submit did nothing inside Claude's OAuth window).
     **The connector URL is now the shim**, not the Supabase function. Full OAuth verified end-to-end
     through it — register, sign-in, token exchange, authenticated tool calls.
  2. **create_pack / update_pack.** Partners can create a themed pack and edit pack details, following
     the CMS PackEditor+savePack convention exactly. Packs are created PUBLISHED; questions still go
     only to the review queue, so a new pack is empty until approved into. No delete tool. Attributed
     in pm_activity as \`partner:<name>\`.
  3. **Per-pack statistics** in list_packs/get_pack_content, so a contributor sees how full each pack
     is; list_packs now includes draft packs and returns status. Plus **review_status**, which tells
     a contributor what happened to what they sent — counts by state, per pack, and the reviewer's
     reject reasons so Claude can avoid repeating a rejected mistake.
  7. **Preview tidied + latent truncation bug fixed.** preview_questions gained source pending|live
     so the server does the work instead of the assistant reshaping data; tool descriptions and
     connection instructions moved back out of the shim into mcp.ts where they belong; the render
     instruction now carries the CMS design tokens. Fixed while latent: previews reported the CAPPED
     length as the total, which would have under-reported once any pack passed 40 — now total/showing/
     truncated are all returned. Renamed the live branch's \`id\` to \`question_id\` so it cannot be
     mistaken for a review-queue id. Corrected a stale "THE TOOLS. Four of them" comment (ten).
  8. **Preview made usable, then the widget rolled back.** preview_questions gained source
     pending|live; instructions now route by intent rather than opening with "ALWAYS call list_packs
     first" (which was hijacking preview requests into showing level rules); the payload was
     restructured QUESTION-FIRST after the level-shaped version kept being summarised as levels; the
     render instruction carries the CMS design tokens. The MCP Apps widget was enabled, appeared to
     render blank three times, was found to be DISPLACING the working artifact path, and was disabled
     by removing the _meta.ui link. Also fixed while latent: capped reads now report the true total.
     [SUPERSEDED — see item 9. It was never blank; it was clipped, because the view never reported
     its height. The widget is now enabled and confirmed rendering.]
  6. **Playable preview.** Tried MCP Apps (SEP-1865) for a real interactive widget — implemented
     correctly and verified over the wire, but concluded Claude Web never fetches the resource for a
     CUSTOM connector (platform gap, matching an open anthropics/claude-ai-mcp issue). Shipped
     instead by having the tool result ask Claude to render a playable artifact.
     [SUPERSEDED — see item 9. The platform-gap conclusion was WRONG; the host does fetch and render.
     The artifact path remains as the fallback, which is why it was worth building.]
  5. **preview_questions / reject_questions / edit_queued_question** — a pre-approval review surface
     in chat. Preview renders a question as a CHILD sees it at every level, which is the one thing
     no automated check can do (it lets a person judge tone). Reject and edit act only on PENDING
     items; edits are re-validated and refused if they would break a rule. APPROVAL was deliberately
     NOT added — see the note in DOC_CLAUDE_MD rule 4.19.
  4. **Strict-dedup alignment.** The BRIEF and tool descriptions used to tell Claude to avoid word
     reuse and reversed pairs — things the validator no longer flags. Variety is now stated as a
     PREFERENCE; the only hard rule is the exact-triple duplicate.
  Also fixed in the same period: the SITE DEPLOY had been failing silently for days because
  deploy.yml ran \`wrangler pages deploy\` against what is actually a Static-Assets WORKER — switched
  to \`wrangler deploy\`, which uses the existing wrangler.toml.
- **NEW: Claude Connector (MCP) — partners write content by talking to Claude.** Three trusted
  partners add this CMS as a custom connector in their OWN Claude account and simply ask for content.
  Their subscription pays for it. New edge fn \`mcp\` (JSON-RPC 2.0, verify_jwt=false), new table
  \`pm_mcp_tokens\`, new page **Claude Connector** (connector.jsx), three new RPCs.
  FOUR TOOLS, deliberately narrow: list_packs, get_pack_content, check_questions (pure validation —
  saves nothing), propose_questions (writes to the REVIEW QUEUE only). No publish. No delete. No pack
  editing.
  [SUPERSEDED Aug 2026 — see the top entry: there are now SEVEN tools; create_pack, update_pack and
  review_status were added. The question-side invariant below is UNCHANGED and still holds.]
  THE POINT: a partner cannot reach a child. pm_review_approve is still the only path into live
  content. The worst they can do — even compromised — is fill the queue with things you reject.
  \`check_questions\` means Claude catches its OWN mistakes before proposing. Verified live: given
  BRIGHT/GENTLE it reported "GENTLE also fits the blank at levels 7, 8, 9, 10 — two correct answers"
  AND noticed BRIGHT was already taken. The queue gets better content, not just more.
  AUTH: a token per partner, NOT OAuth (with three trusted people that would be ceremony). Stored as a
  sha256 hash; the raw token is shown once and is genuinely unrecoverable. Queued rows are tagged
  \`partner:sarah\` so you know whose work you're reviewing.
  ATTACK-TESTED: no token → 401; forged token → 401; forged token trying to WRITE → 401 with nothing
  reaching the DB; an authenticated admin reading pm_mcp_tokens from the browser → []. A successful
  propose landed in the QUEUE and ZERO questions reached the live pack.
- **Deep audit after the restructure — five real bugs, two of them found by reading the LIVE feed.**
  I had just restructured a page, deleted a component and redeployed the edge function. That is exactly
  when things break in ways the existing tests cannot see, because those tests were written BEFORE the
  change. So I went looking specifically for what I had broken.
  FOUND BY READING THE LIVE GAME FEED (not by testing code):
  (1) **\`CALM/PROUD\` and \`PROUD/CALM\` are both live** — the same two-word choice, just swapped over.
  Different sentences, so not a "duplicate", but the child faces the identical decision twice. EVERY
  check was blind to it, because they all grouped by ANSWER only: they saw CALM once and PROUD once and
  reported nothing.
  (2) **\`KIND\` is the distractor in several questions.** Nothing had ever looked at the ALTERNATE word.
  A wrong option that keeps reappearing becomes predictable — the child learns "it is never KIND"
  rather than reading the blank.
  Both are now caught: \`reversed_pair\` and \`overused_alt\` in pm_lint/pm_lint_details, AND in BOTH
  copies of validateQuestion (so the AI cannot generate one and have the review queue call it clean).
  [SUPERSEDED Aug 2026 — the strict-dedup alignment later REMOVED both from validateQuestion and
  restated variety as a preference. They remain in pm_lint/pm_lint_details only. That is intended;
  see rule 4.15, which was rewritten because this entry and the code had been contradicting each
  other. The rest of this entry still stands.]
  FOUND WHILE FIXING:
  (3) **A bug in my own fix.** The reversed-pair message said "(PROUD / PROUD)" instead of
  "(CALM / PROUD)" — I had wrapped max() INSIDE least()/greatest(), so it took the max across the group
  first and both sides collapsed to the same word. The GROUPING expressions are already the two words.
  (4) **Three literal \`\\u2014\` escape sequences** ended up in the edge function's source instead of real
  em-dashes — users would have seen a backslash-u in the middle of a sentence.
  (5) **A LATENT bug, surfaced by the new check:** the queued-questions query was selecting
  \`template,answer,status\` but NOT \`alt_answer\`. So the reversed-pair check would have been completely
  blind to anything already sitting in the review queue. It only came to light because the new check
  needs both words.
  ALSO HARDENED: the Generate page's "default to API if a key exists" effect was only correct BY
  ACCIDENT — it worked because keyReady happens not to change again. If it ever did (a key added in
  another tab, a realtime refresh) it would have yanked the user out of the mode they deliberately
  picked. Now guarded with a ref, so an explicit choice is never overridden.
  VERIFIED: all four edge functions healthy; every one of the 11 live questions confirmed safe in what
  the GAME actually receives (BRIGHT/CURIOUS 6v7, SURE/CONFIDENT 4v9); client↔edge validator parity
  restored and re-verified across 24 cases; all six test layers pass.
- **Generation restructured: ONE page, ONE set of options, TWO ways to run it.**
  THE PROBLEM: generation lived in two places and they disagreed. The Generator page built a prompt
  to copy (with pack, levels, themes, count, format, frames, avoid-existing). AI Settings had a
  SECOND, stripped-down generate panel buried under key management — same idea, but missing themes and
  frame words for no reason. So (a) generation was hidden inside a SETTINGS page, which is the wrong
  home — settings should CONFIGURE, a content page should CREATE; and (b) the API path was a poor
  relation of the manual one.
  THE FIX: the page (renamed \`Generate\`) now leads with a method switch — **Use my API key** or
  **Copy a prompt** — and the options below are IDENTICAL either way. How you run it must not change
  what you're allowed to ask for. Only the right-hand column differs: the API route shows a plain
  summary of what's about to happen plus a Generate button; the prompt route shows the prompt, ready
  to copy. Both end in the same place: the review queue.
  The API option is offered but DISABLED with a reason when no key is saved, rather than failing when
  pressed; and the page defaults to whichever method can actually run.
  Prompt-only options (output format, background context, avoid-existing) are HIDDEN in API mode —
  the edge fn always returns structured JSON, always carries the brief in its system prompt, and
  always avoids existing words. Showing those controls in API mode would be controls that do nothing.
  ALSO: the edge function now accepts \`themes\` and \`with_frames\`, which were manual-prompt-only. The
  two paths are now genuinely equivalent.
  AI Settings now only CONFIGURES: providers, keys, parameters, usage. GeneratePanel deleted (dead
  code rots), with a clear signpost to the Generate page in its place.
- **Visual pass — actually READ the pages, and found three bugs nothing else had caught.**
  HONEST LIMIT FIRST: I cannot take true screenshots here (no browser in the sandbox, and Chrome's
  CDN is unreachable — I tried puppeteer, resvg and sharp). So instead of pretending, I did two things
  that ARE rigorous: computed the real layout boxes from the real evaluated stylesheet, and RENDERED
  EACH PAGE TO READABLE TEXT so I could read what it actually says. The second is what found the bugs.
  BUGS FOUND BY READING:
  (1) **The Health page showed "(untitled)" on every issue row.** The UI read \`d.label\` and \`d.issue\`,
  but pm_lint_details returns \`answer\` and \`code\`. The field names never matched, so every row showed
  "(untitled)" with no issue type. It had been broken the whole time and NO automated check caught it —
  the markup was perfectly valid, it just said nothing useful. Only reading the page revealed it.
  (2) **HelpField had an EMPTY label.** My previous fix wrapped the control in a second \`<label>\` — which
  made it "associated", so my checker passed it — but that label had no text, so a screen reader
  announced an unnamed field. An empty label is worse than none: it defeats the check. Now ONE label
  containing both the text and the control. The inspector now requires a label to have actual TEXT, not
  merely to exist.
  (3) **The AI Review page's copy was wrong** after routing imports through the queue: it said "Every
  AI-generated question waits here", but the queue now also holds hand-written imports. Someone pasting
  their own lines would be confused. Now: "Nothing becomes a real question until you approve it —
  whether an AI wrote it or you imported it yourself."
  Also fixed: Pack detail skipped h1→h3 (heading-level gap).
  ALL SIX TEST LAYERS PASS: DOM inspection, interaction (41 clicks / 55 input changes), runtime mount
  (no React warnings), visual layout (computed boxes, 44 page×device combinations), structural checks,
  and engine parity (1,725 cases identical across all three copies).
  A viewable .html file per page/device is now written to /visual — so a human CAN look at them.
- **ALL imported content now goes through the human review queue.** There were TWO ways content got
  into a pack and only ONE was gated:
    generate-questions (API key) → review queue → human approval  ✓
    Bulk Import (paste)          → STRAIGHT INTO THE LIVE PACK    ✗
  Same AI, same risks, no gate. That is the exact path by which BRIGHT/GENTLE reached children.
  DESIGN DECISION: everything imported goes to the queue — we do NOT try to guess whether a paste
  "came from AI". We usually cannot tell, and a wrong guess means unchecked content reaches a child.
  The gate protects children regardless of where the content came from, so there is no bypass and no
  judgement call.
  WHAT CHANGED:
  • New RPC \`pm_review_enqueue(pack_id, items, source, target_level)\` — pushes a batch into
    pm_review_queue with source 'import' or 'ai-paste'.
  • BulkImport now runs the REAL validator (same engine, every level) on every pasted row and shows
    the flags BEFORE you commit — "Two answers", "Same word", "No blank", "Word reused". You see a
    broken pair in the preview, not after it is live.
  • BulkImport no longer writes to pm_questions at all (verified: zero \`createQuestions\` calls
    remain in editors.jsx). The ONLY path into live content is still pm_review_approve.
  • The review queue labels the source: "Imported" / "Pasted from AI" / the provider name.
  PACK-FILE IMPORT (restore a backup / move packs between environments) is deliberately NOT queued —
  putting a 200-question restore through one-by-one approval would be absurd, and those packs land as
  DRAFTS so nothing reaches a child until you publish. But it no longer imports silently: every
  question is validated and you get a clear warning ("N imported questions have problems — check Health
  before publishing"). Defence in depth without making a restore unusable.
  VERIFIED END-TO-END: mounted BulkImport, pasted three questions including the exact BRIGHT/GENTLE
  pair that reached children, and confirmed — flagged "Two answers" in the preview; button reads "Send
  3 for review"; on submit it calls pm_review_enqueue and makes ZERO direct writes to pm_questions.
- **Comprehensive audit — found TWO BROKEN QUESTIONS LIVE IN A PUBLISHED PACK, and the systemic hole
  that let them sit there.**
  THE SERIOUS ONE: \`BRIGHT/GENTLE\` and \`SURE/GLAD\` were live in the published \`confidence\` pack and
  being served to children by the content API. Both same-length pairs — so at levels 7-10, where the
  whole word is hidden, the child sees \`______\` and BOTH options fit. Pick the "wrong" one and you
  are marked wrong for a right answer. In a therapy app for children's self-esteem that is the worst
  possible failure. Verified against the LIVE API (the game really was receiving them), then fixed:
  GENTLE→CURIOUS (7 letters) and GLAD→CONFIDENT (9 letters) — both still genuinely positive words, both
  now a different length. Published packs now have ZERO ambiguous questions.
  THE SYSTEMIC HOLE: **pm_lint never checked for this.** It checked missing-alt, duplicates, thin packs
  and bad templates — but not the one defect that actually breaks the game. So the app's own health
  check reported everything was fine while two broken questions were live. The AI validator catches
  this for NEW content; nothing was catching it for EXISTING content. pm_lint and pm_lint_details now
  check: ambiguous (ERROR — the headline), same_word, multi_blank, bad_chars, reused_word. The Health
  page leads with "Two correct answers" as its first stat and shows a red banner explaining, in plain
  words, why it harms a child.
  NEW TEST LAYERS (the previous audits could not see any of this):
  • RUNTIME MOUNT — actually mounts every page in a real DOM and captures React's warnings. SSR shows
    none of these. Result: 12/12 pages clean, no key warnings, no controlled/uncontrolled switches.
  • INTERACTION — actually CLICKS things. 41 buttons clicked, 55 inputs changed across every page.
    Nothing broke. (Nothing in any previous audit had ever clicked a button.)
  • ENGINE STRESS — 1,725 cases across all three copies of maskWord: byte-identical, and every
    invariant holds (length preserved, characters uncorrupted, blank count exact, deterministic).
  • SECURITY — attack-tested the newest tables. Anon reading pm_review_queue → [], reading pm_ai_usage
    → [], INJECTING into pm_review_queue → 401 RLS violation (they cannot smuggle content into the
    approval pipeline hoping you bulk-approve it).
  ALSO: hardened DeriveLevelDialog's array guard (\`|| []\` only catches null/undefined; an object still
  throws and white-screens the page — Array.isArray is the correct guard).
  NOTED, NOT CHANGED: devdocs.jsx is 29% of the source (162KB of prose every user downloads for one
  page). It gzips well and the total is 160KB, so it is a deliberate trade-off — the docs living inside
  the app is what stops them going stale.
- **Real-DOM inspection pass — stopped auditing the source and started inspecting the RESULT.** My
  previous passes read the code and grepped for suspicious patterns. That is not inspection. This pass
  renders every page and modal into a real DOM (jsdom) with the real EVALUATED stylesheet, then walks
  the tree checking computed styles.
  FIRST I HAD TO FIX MY OWN ORACLE — twice. (a) I extracted the CSS by regexing the source, which left
  \`\${themeVars(...)}\` template placeholders unevaluated; jsdom silently rejected the whole stylesheet
  and EVERY computed style was a lie. Now it RENDERS GlobalStyle to get the real CSS and aborts if any
  \`\${\` remains. (b) My label check only looked for aria-label/for=, so it flagged every field built
  with our <Field> primitive — but a control WRAPPED IN A <label> is programmatically associated
  (implicit association) and screen readers announce it. Those were false positives. A broken oracle is
  worse than no oracle.
  REAL DEFECTS FOUND AND FIXED:
  (1) **19 unlabelled form controls** — the bare filter dropdowns (status, level, date, pack, sort) had
  no label of any kind. A screen-reader user heard "combo box" with no idea what it filtered. All now
  carry aria-label + title.
  (2) **HelpField provided NO label association at all.** I built it with a <div>+<span> instead of a
  <label>. It looked identical but left every control inside it completely unlabelled to assistive
  tech. Now uses a real <label> (with the (i) button OUTSIDE it, so it can't swallow clicks meant for
  the field).
  (3) **The colour-swatch buttons in LevelEditor were unlabelled** — a coloured square with no text.
  Now aria-label + aria-pressed.
  ALSO: I mangled 12 lines with a careless regex (it inserted attributes INSIDE arrow functions:
  \`onChange={(e) = aria-label="x"> setFoo(...)}\`). Only the BUILD caught it. Repaired, and worth
  recording: never regex-edit JSX.
  VERIFIED: all 11 pages × 4 device classes and all 9 modals — no overflow, no invisible text, no
  illegible fonts, no unlabelled controls, no unlabelled buttons. WCAG contrast checked on the real
  theme colours: every text colour passes AA (warn is 3.86:1, large-text only, and is used only on
  small badges).
- **Layout audit: fixed the white space and stretched formatting.** The previous pass fixed the
  NAVIGATION flipping but only verified pages "render without throwing" — a very low bar that catches
  nothing about layout. This pass rendered every page in its LOADED state (stubbing useAsync, since
  SSR otherwise only ever shows skeletons) and measured the actual column widths.
  WHAT WAS WRONG:
  (1) **Nothing capped the CONTENT.** \`.pm-main\` capped the container at 1080px, but inside it a
  single form field, a settings panel with one control, or a page subtitle simply filled the whole
  1080px. A text input the width of the page, a line of body copy ~150 characters long, and a lot of
  dead space beside it. That IS the "white space / broken formatting". Fixed with readable-width
  constraints: \`.pm-readable\` (720px) on panels, \`.pm-form-2\` capped at 860px, \`.pm-prose\` (680px,
  ~75 chars/line) on every page subtitle and intro. aisettings.jsx, levels.jsx and editors.jsx had
  ZERO maxWidth constraints anywhere.
  (2) **A landscape phone was the worst case.** It gets phone chrome but ~800px of width, and the
  portrait single-column rules stretched one form field to **812px**. Landscape now gets two columns
  (399px each), a 3-col index grid, and side safe-area padding (viewport-fit=cover was letting
  content slide under the notch in landscape).
  (3) Pack detail had an \`<h2>\` as its top heading and no \`<h1>\` — a heading-level skip. Fixed.
  VERIFIED: computed real column widths across 7 device sizes — everything now lands in a sensible
  150–423px range, with nothing over 700px (the "too wide" threshold) and nothing under 80px. All 12
  pages render on all 4 device classes with real data loaded (48 combinations, zero failures).
- **Fixed the mobile layout flipping between different navigations (reported: "flipping in different
  layouts with different menus from the side").** ROOT CAUSE: useBreakpoint keyed purely off
  window.innerWidth (phone < 640). Rotate ANY phone to landscape and its width becomes 667–932px, so
  the app decided it was a TABLET: the bottom nav disappeared, an icon-only side rail appeared, and —
  because the CSS had its OWN parallel breakpoints (@media max-width:639px) — the phone rules were
  lost too, so two-column forms came back, modals stopped being bottom sheets, and iOS resumed
  AUTO-ZOOMING on every input focus. Rotating back flipped everything again.
  THE FIX (three parts):
  (1) useBreakpoint now decides on DEVICE CLASS, not raw width: for a touch device it keys off the
  SHORT side of the screen (invariant under rotation), for a resizable desktop window off live width.
  A phone stays a phone in any orientation; an iPad stays a tablet in any orientation. Verified across
  15 real devices: rotating NEVER rearranges the navigation now.
  (2) Killed the two-parallel-breakpoint-systems problem. The JS now stamps a device class on <html>
  (pm-phone / pm-tablet / pm-desktop / pm-coarse / pm-landscape) and the CSS keys off THAT, so the two
  can never drift apart again. (The old width media queries remain only as a pre-mount fallback.)
  (3) Added the mobile foundations that were missing and whose absence makes a page feel broken rather
  than merely ugly: a global overflow-x guard (one stubborn element shifts the whole page), safe-area
  padding for left/right (viewport-fit=cover was letting landscape content slide UNDER the notch),
  overflow-wrap for long slugs/model names, momentum scrolling + overscroll containment in modals,
  and tap-highlight/touch-action fixes. Coarse-pointer devices get 40px minimum hit targets and 16px
  inputs regardless of screen size.
  VERIFIED: all 12 pages render on all 4 device classes (48 combinations, zero failures), and the full
  App renders correctly at every real device size with the expected layout.
- **Review of the AI-parameters work — three real bugs found and fixed.**
  (1) **Clearing the system prompt did nothing.** Emptying the textarea sent null, and null means
  "don't change" in the setter — so a custom brief could NEVER be removed, and the UI actively lied to
  you (empty box, old prompt still driving the AI). Now sends an empty string, which the RPC already
  treated as an explicit clear. Found by tracing the round-trip, not by reading the code.
  (2) **The \`enabled\` flag was dead config that lied.** The column existed and pm_ai_status reported
  it, but NOTHING ever checked it — a provider you had "disabled" would still be used. Now enforced in
  the edge fn (400 \`provider_disabled\`) with a Turn on/off button and a pm_ai_set_enabled RPC.
  Verified live: a disabled-but-keyed provider is refused.
  (3) **A short batch failed quietly.** Ask for 20, get 8, and nothing told you why. The response now
  returns \`requested\`, \`truncated\` and a \`warning\`, and the UI surfaces it — naming the likely cause
  (hit the token ceiling) and how to fix it.
  Also verified (not assumed): the client→RPC contract works over REST with the exact 9-param payload
  the browser sends (PostgREST resolves by argument name — 200 OK); numeric params serialise as JSON
  NUMBERS not strings, so the UI and edge fn handle them correctly; an untouched save preserves every
  value; a params-only save still does not wipe the key. Prod restored (no keys, active=anthropic, 12
  questions, empty queue).
- **Exposed the generation parameters (they were hardcoded or missing entirely), each with an (i)
  explaining what it does.** Before: max_tokens was HARDCODED at 4000; temperature was NEVER SENT (so
  you silently got the default 1.0 — maximally creative, which is the wrong end of the dial for
  rule-compliant structured output and meant more broken questions); the game rules were stuffed into
  the USER turn instead of a system prompt (models follow system prompts far more reliably); and the
  model list was a static array that would rot. Now per-provider in pm_ai_config: max_tokens,
  temperature, top_p, system_prompt, plus a free-text model box so a new model doesn't need a redeploy.
  THE IMPORTANT PART: temperature and top_p are OMITTED when unset, because Anthropic returns 400 for
  temperature on Opus 4.7+ and OpenAI rejects it on GPT-5 reasoning models — a naive "sensible default"
  slider would have broken generation entirely on those models. The Advanced section warns about
  exactly this. Each of the seven settings has an (i) explaining what it is, why it matters FOR THIS
  JOB, a suggested value, and (for the two dangerous ones) a warning.
  Also: truncation is now surfaced — a too-low max_tokens cut the JSON off mid-array and appeared as a
  baffling parse error; all three adapters now report it and the message says to raise Max tokens.
  Also: saving params must not wipe the key (you can never read one back), so the setter accepts a null
  key meaning "keep the existing one" — and the old 3-arg overload had to be DROPPED because it made
  the call ambiguous ("function is not unique"), which I hit while testing.
- **Deep audit of the AI feature — found what we hadn't thought about.** Verified the one integration
  nobody had tested: approving an AI question DOES bump the pack's content_version and the sync
  manifest's global_version, so Firebase actually pulls it (proved live end-to-end; without that the
  whole pipeline would have been a dead end).
  FOUND AND FIXED:
  (1) **AI pages were unreachable on mobile.** The phone drawer had a HARDCODED list (health, levels,
  activity, devnotes) that never included AI Review, AI Settings — or even Generator. On a phone you
  simply could not approve queued content. The drawer is now DERIVED from NAV, so a new page can never
  be silently stranded again.
  (2) **No cost control or audit trail at all.** Generation is the only thing here that spends real
  money and it was completely invisible and unbounded — no run count, no token counts, no brake. Added
  pm_ai_usage (a row per provider call incl. failures and connection tests, with token counts and the
  actor from the JWT), pm_ai_rate_check (checked BEFORE any provider call; 429 with a clear message;
  defaults 20/hour, 100/day), pm_ai_usage_summary, and a Usage panel on AI Settings. Logging is
  best-effort so it can never break a generation you're waiting on.
  (3) **Approve/reject had a race window.** The RPCs read the row, checked status, then updated — two
  truly simultaneous calls could both see 'pending'. Now SELECT ... FOR UPDATE, so the second blocks
  and then correctly sees 'approved'. Also added a guard for the pack having been deleted between
  generating and approving.
  (4) **The queue counts downloaded up to 10,000 rows to the browser just to count them** — wasteful,
  and silently WRONG past the cap. Replaced with a cheap server-side pm_review_counts() RPC.
  (5) Added a **pack filter** to the review queue (it was one undifferentiated list across all packs)
  and a **"Reject N broken"** bulk action — which deliberately only sweeps up HARD mechanical defects,
  never the soft advisory flags (a reused word may still be a question you want).
  Confirmed already-correct: pm_review_queue cascades on pack delete; double-approve is rejected;
  bulk-approve only takes zero-flag rows. Prod left pristine (12 questions, 15 packs, empty queue).
- **Duplicate handling rebuilt — four real gaps closed.** The original check only caught an EXACT
  duplicate (same sentence AND same answer), which missed the cases that actually matter. Now three
  distinct flags: \`duplicate\` (true repeat), \`same_sentence\` (repetitive phrasing), and
  \`answer_reused\` — the ANSWER WORD is already taught elsewhere, which is invisible if you only
  compare whole questions and is a real quality problem in a 10-20 question pack (BRAVE taught twice).
  GAPS CLOSED: (1) same answer word in a new sentence was NOT flagged; (2) the review queue was
  invisible to de-dup, so two generate runs before a review could duplicate each other; (3) REJECTED
  items were invisible, so a question you rejected got cheerfully regenerated; (4) the avoid-list sent
  to the model was capped at 40 words, so past ~40 questions the model stopped being told about the
  older ones. The de-dup context now spans live questions (active AND inactive) + pending + rejected
  queue items + the other items in the SAME BATCH (validated cumulatively — if the model returns BRAVE
  twice, the SECOND copy is flagged, not the first; verified). The repair pass is seeded with the
  batch's already-good items so a "fix" can't collide with them. The prompt now lists every taken
  answer word (uncapped), calls out previously-rejected words explicitly, and shows the sentences
  already used so the model varies phrasing rather than just swapping the word. UI: answer_reused and
  same_sentence are SOFT (amber, advisory — you may still want the question); mechanical defects stay
  red. Bulk "Approve N clean" still only takes rows with ZERO flags. Validator parity re-verified
  (client ↔ deployed edge fn identical across 22 cases including every duplicate type).
- **NEW: AI content generation with a mandatory human review queue (two new pages, existing pages
  untouched).** Pages: **AI Settings** (aisettings.jsx — pick provider, save keys, generate) and
  **AI Review** (aireview.jsx — the approve/edit/reject queue). New edge fn \`generate-questions\`
  (verify_jwt=TRUE) supporting Anthropic, OpenAI AND Gemini. New tables: pm_review_queue,
  pm_ai_config, pm_ai_settings. New RPCs: pm_review_approve/reject, pm_ai_set_key/clear_key/status.
  New in core.jsx (pure additions): \`validateQuestion\` + \`altFitsBlank\` (the shared validator) and
  \`callFn\` (auth'd edge-fn caller).
  THE GATE: generated questions go ONLY to pm_review_queue — never to pm_questions. A human must
  Approve / Edit / Reject each one. Approve is the single atomic RPC path into live content and tags
  the question "AI-generated — human approved". Reject writes nothing.
  KEY SECURITY: pm_ai_config has NO select policy for anon OR authenticated, so the browser cannot
  read the keys at all. Attack-tested: an authenticated admin SELECT returns [] while the SAME token
  reads pm_levels fine; a direct anon INSERT returns 401 RLS violation. The UI shows only
  "Configured ••••••1234". Even the admin login (or an XSS) cannot lift the keys.
  THE VALIDATOR: runs the REAL masking engine at EVERY level. Its headline flag, "ambiguous", catches
  the defect a human eye cannot — an alternate that ALSO fits the blank, giving the puzzle TWO correct
  answers. Found REAL bugs in LIVE content this way (BRIGHT/GENTLE, SURE/GLAD, KIND/MEAN all broken at
  L7-10 — each looks fine to a human). Byte-identical between core.jsx and the edge fn (verified, 45
  cases) — a parity invariant like maskWord. Auto-repair sends failures back to the model once with
  the exact defect.
  BUG FOUND AND FIXED WHILE TESTING: pm_questions.frame_slots is NOT NULL but queued AI rows have it
  null, so EVERY approve failed until the RPC coalesced it to '{}'. Caught by running the real path.
  All three decisions verified live (approve / approve-with-edit / reject), and a reject test proved
  why humans are still needed: "PERFECT" passes every mechanical check but is an unhealthy standard
  for a child — the machine cannot see that, a person can. Test data cleaned up; prod untouched.
- **Deeper audit pass — one real gap fixed, one enhancement added.** GAP (fixed): the
  pm_level_delete_cleanup trigger handled questions and override rows pinned to a deleted level, but
  NOT packs — a pack pinned to the deleted level was left as a stale pointer (a pack's level can't be
  null, it's the question fallback). Extended the trigger to also reset such packs to the highest
  REMAINING level (verified: a test level with a pinned pack + pinned question + override → pack
  reset to the next level, question nulled, override dropped, all atomically). ENHANCEMENT: Bulk
  import now surfaces the pack level's vocabulary rules — imported answer words outside the level's
  length band (or multi-word when the level disallows it) get a soft “Length” flag and a guidance
  line, so the new per-level vocab rules are actionable at import time. It's advisory only (never
  blocks import; imported questions still inherit the pack level). Band-check logic unit-tested (7/7:
  too-short / in-range / too-long / multiword-not-allowed / multiword-allowed / empty / no-level).
  Also confirmed clean this pass: game-feed's buildLevelVariants is level-count-agnostic like
  content-api (maps over all pm_levels rows, no hardcoded 10) and its masking logic is identical to
  content-api's (the only intentional difference is the output field shape — game-feed emits opts as
  a joined string, content-api emits options as an array); levels are consistently ordered by
  level.asc everywhere; PlayMode renders a chip per real level (no 10-cap); no pack/question is
  currently mis-pinned to a nonexistent level; RLS + grant posture unchanged. Prod left pristine (10
  levels, 14 packs, 11 questions, 0 overrides, 0 tombstones).
- **Audit pass over the expandable-levels work — four real bugs fixed, three improvements, all
  verified live.** (1) DANGLING LEVEL REFS: deleting a level left pm_questions.level and
  pm_question_levels rows pointing at a gone level (there's no FK — level is a plain int), leaving a
  stale effective_level pointer. Fixed with a SECURITY DEFINER BEFORE DELETE trigger
  pm_level_delete_cleanup that un-pins affected questions (→ null → pack default) and drops override
  rows at that level; verified it cleaned 11 derived override rows when a test level was removed.
  (2) DERIVE URL OVERFLOW: db_qlevels.overridesForPackLevel put every question id in one in.(...)
  URL — a large pack would exceed URL-length limits. Now chunked at 150 ids/request (the upsert was
  already chunked at 200). (3) DERIVE FROZE WORD-LEVEL LETTER COUNT: for a whole-word level, derive
  pinned letters_hidden = answer.length, which would silently stop being whole-word if the word was
  later edited (pm_question_levels has no hidden_mode column). Fixed: word-level derived rows leave
  letters_hidden/position/grouping null (the level already forces whole-word); only letters-level
  derives pin concrete values. (4) ADD-LEVEL AT CEILING: the "Add level" button wasn't disabled at
  100, so clicking would try to create 101 and hit a raw CHECK error — now disabled with a tooltip.
  Improvements: (5) LevelsView fetched its own levels copy separate from the shell's realtime-backed
  shared state (a staleness gap where another device's level edit wouldn't refresh this page); it now
  uses the shared levels + reload passed from the shell, so all views share one source of truth.
  (6) Added a friendly client-side min<=max word-length guard before the DB CHECK. (7) Refined the
  CMS "edited" flag (hasOv) so a no-op enabled-only override row (e.g. a word-level derive handle)
  no longer reads as edited. Confirmed clean: maskWord parity client↔edge still byte-identical (720
  cases, 0 mismatches); a real letters-mode Level 11 derived across the confidence pack rendered
  B___E / P_T_E_T / S_R__G etc. through the live feed, then cleaned up; RLS still enforced; grant
  posture clean (new triggers are inert, only pm_content_manifest is callable and anon can't); prod
  left pristine (10 levels, 11 questions, 0 overrides, 0 tombstones).
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
    only kept rows import. It also soft-flags answer words that fall outside the PACK LEVEL's
    vocabulary rules (length band / multi-word) with a “Length” badge + a guidance line — advisory
    only, never blocks import (imported questions inherit the pack level). All verified against real
    pack data.
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
- **Three decoupled services:** GitHub (front-end source + edge-fn source copy) → Cloudflare (serves
  the static site; push to main → GitHub Actions → deploy) ; Supabase (the backend — DB, auth, RLS,
  edge functions — **deployed MANUALLY, GitHub never touches it**). See Architecture §0.4.
- Supabase project ref: tytrmjjucqijzcrbwjfm
- GitHub: alcharles1980-design/positive-minds-cms
- Live: positive-minds-cms (Cloudflare; also appears as a Worker of that name)
- **Edge functions (5):** content-api (public), generate-questions (JWT), mcp (public entry, OAuth per
  call), game-feed (public, legacy), pack-describe (JWT). All five have source in edge-functions/*.ts.

## Golden rules (do not break these)

NUMBERING: rules are listed NEWEST FIRST but numbered OLDEST FIRST, so 4.1 is at the bottom of
the list and the highest number is at the top. A new rule takes the next number and goes on top;
no existing number ever shifts. (Letters were used until Aug 2026 and had collided six times —
there were two 4t, two 4u, two 4r, two 4s, two 4v and two 4d, so "see rule 4t" was ambiguous.)
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
4. **Client/server engine parity.** The RENDERING engine is duplicated across FIVE copies that must
   stay byte-identical: core.jsx (the client) and FOUR edge functions — content-api, generate-questions,
   mcp, and game-feed. \`maskWord\` is identical in all five (verified); \`validateQuestion\` lives in
   core.jsx, generate-questions and mcp. This covers \`maskWord\`, \`resolveSlots\`, \`resolveFrameMap\`,
   \`buildLevelVariants\` AND the TRANSFORM engine (\`buildOutput\`/\`projectRow\`/\`applyTransform\`/\`mapValue\`/
   \`toXml\`). Any change to one MUST be mirrored in ALL copies, same commit, or a feed diverges from what
   the CMS shows. ONE deliberate exception: \`game-feed.buildLevelVariants\` emits the legacy \`opts\`
   string ("A / B") instead of content-api's \`options\` array — the masking is identical, only that
   output field differs; keep it that way unless retiring game-feed. (\`engine.js\` currently parity-tests
   only 3 of the 5 maskWord copies — it predates mcp and game-feed being in the repo; verify those two
   by hand or extend the test.)
   Watch the PRECEDENCE CHAIN specifically: buildLevelVariants resolves position/grouping as
   \`override(pm_question_levels) ?? question.own ?? level.default ?? hard-default\` — this exact
   order must match in both files. (A past bug: the client gained the \`question.own\` step but
   the edge function didn't, so a question with its own letter_position rendered differently
   in-game than in the CMS.) After any engine edit, diff the two by fetching the deployed edge
   function and comparing, or run a parity test with a question that has its own overrides.
4.47. **Run the whole test target, not the commands you happen to remember.** This project has SIX
   test suites wired into \`npm test\` — engine, runtime, read, inspect, interact, visual — plus three
   more under mcp-shim/. I learned \`node engine.js\` and \`node runtime.js\` early and ran only those
   for an entire session, across dozens of commits, without once opening package.json. read.js,
   inspect.js, interact.js and visual.js were sitting there doing real work: inspect checks computed
   styles in a real DOM, interact CLICKS 42 buttons and changes 52 inputs, visual renders 27
   page/device combinations. None of them ran.
   Nothing broke, which is luck, not vindication.
   THE RULE: read package.json scripts before you decide what "the tests" are, prefer the aggregate
   target over remembered incantations, and WRITE DOWN THE HEALTHY BASELINE for any suite that
   reports non-zero by design — test:visual always shows ~153 minor touch-target advisories, and a
   suite whose normal output looks like failure will be quietly ignored by the next person too.
4.46. **A handover is only true if you FOLLOW IT from a clean clone.** The new-session instructions
   in 11y were written from memory of what works — and every command in them passed on the first
   run, which proved nothing, because they were passing on the machine that had been building this
   project all day. Cloning fresh and following the steps literally found that the jsdom tests
   imported \`/home/claude/node_modules/jsdom/lib/api.js\` by ABSOLUTE PATH. That resolves here by
   coincidence and would fail on any other machine, so the test suite a new session is told to run
   would not have run. jsdom was even a declared dependency — the import just never used it.
   THE RULE: documentation of a process is a claim, and claims get tested. Clone into a new
   directory, follow your own instructions word for word, and treat every step that only works
   because of ambient state on your machine as a bug in the code, not in the instructions.
4.45. **Test the question a CLIENT asks, not the property you just implemented.** The
   content-addressed view URI shipped with four passing checks: the current URI resolves, the hash
   matches the content, a changed view yields a changed URI, the URI reads back. All true, all
   beside the point. Not one asked the question a real client asks — "I am holding YESTERDAY'S URI,
   does it still work?" — and the answer was no, so every deploy served a red "Failed to load the
   MCP app" to anyone with a cached tool list.
   The tests were written from inside the change, asserting the thing I had just built rather than
   the thing that had to remain true. Before calling a feature tested, write down what the CLIENT
   holds, does and remembers across time — stale references, old sessions, cached lists — and test
   from there. A suite that only exercises the happy path of the code you just wrote will pass
   forever and catch nothing.
4.44. **A short token expiry is only a security boundary if something REFRESHES it. Otherwise it is
   a scheduled outage.** The claude.ai proxy never calls /token again after the initial exchange
   (anthropics/claude-ai-mcp#228, and our own log agrees exactly). With a 1-hour token that means
   re-authenticating daily, which is what everyone in those threads suffers; with our 30-day token
   it meant a dead connector on a date already in the diary and no memory of why.
   So lifetimes here are ~10 years, and the control moved to REVOCATION — which is stronger anyway,
   because authenticate() re-reads pm_mcp_tokens.active on EVERY request and active=false takes
   effect on the next call, mid-session. Expiry could never do that.
   THE GENERAL FORM: work out which half of a protocol the other party actually performs before
   relying on it. A boundary the counterparty never enforces is not a boundary; it is a timer.
   And state the residual risk rather than burying it — a leaked token now lives until revoked.
4.43. **If a client may cache your artefact, put its identity in the URI — and remember a rendered
   widget never re-fetches.** A wording change was deployed, verified live by fetching the resource
   over the wire, and STILL wrong on screen. Not a deploy failure: SEP-1865 lets hosts prefetch and
   cache a ui:// resource keyed on its URI, and the protocol has no "that resource changed" message.
   With a fixed URI you cannot invalidate anything, and the failure is SILENT — it looks precisely
   like the deploy not working, which is where three rounds went.
   FIX: content-address it — ui://.../view-<hash of the content>. Change a character, get a new URI,
   which the host cannot mistake for what it holds. Nothing to remember to bump; anything requiring a
   human to bump a version will eventually not be bumped.
   AND KEEP SERVING THE OLD ADDRESSES. Content-addressing invalidates the host's cache of the
   RESOURCE — but the host also caches TOOLS/LIST, which is where it reads the URI from, so it will
   keep asking for the hash it saw THERE. Serving only the current hash turned every shim deploy
   into "Failed to load the MCP app" for anyone holding a stale tool list. Any past URI must resolve,
   and to the CURRENT content: an old address should not pin old content, it should simply keep
   working. Fixing a cache while breaking old references is not a fix.
   AND THE PART THAT IS NOT A CACHE AT ALL: an already-rendered widget keeps the HTML it was born
   with, forever. Scrollback shows the build from that moment and cannot be updated. When checking
   whether a view change landed, ask for a NEW one — and have the view NAME ITS OWN BUILD so a
   screenshot settles it (rule 4.21).
4.42. **A capability implemented ONCE but advertised in several places fails silently if ANY of the
   advertisements says no.** Refresh tokens were broken in three independent ways at once: the
   function did not issue them (undeployed), the shim's hand-copied metadata did not advertise the
   grant, and /register returned a hardcoded grant list ignoring what the client asked for. Fixing
   each one changed nothing visible, because any single "no" is enough for a client to never try.
   The implementation was correct and reachable throughout — it was purely a false advertisement,
   which is the most expensive kind of wrong, because everything you inspect looks right.
   WHEN A CAPABILITY IS DECLARED, ENUMERATE EVERY PLACE THAT DECLARES IT and check them together:
   server metadata, per-client registration response, the runtime behaviour, and any proxy that
   fronts them. If two of them are hand-maintained copies, that is the bug waiting to happen —
   derive, do not duplicate (the shim now fetches the function's metadata instead of restating it).
4.41. **A status badge is not the system. Test the capability, not the indicator.** The Connectors
   page said "Connection has expired" for hours while the connector was working: three complete
   authenticated MCP sessions, all 11 tools listed, one of them BEFORE the reconnect that was
   supposedly needed. I took a screenshot of a status card as evidence of the connection state and
   went looking for a failure that was, by then, partly imaginary.
   Ask what the thing is FOR and test that: open a chat and call a tool. A green light proves the
   light works. Applies to our own UI too — the Health page once showed "(untitled)" on every row
   while the data was fine (rule 4.14), which is the same error seen from the other side.
4.40. **Build the instrument before the theories.** Four hours went into Android link handling, plan
   limits, stale OAuth flows and a headless-browser end_error — all of it inference from status codes
   and screenshots. Then a small log table (rpc method, status, had_auth, user agent) answered it in
   ONE query, and would have answered it at any point that night.
   Supabase's function logs give a URL and a status: "POST 200 /mcp" four times is a handshake you
   have to guess at. The missing fields were cheap to add and decisive once present.
   THE RULE: when a second round of diagnosis begins, stop theorising and add the missing
   observation. If you cannot see which method was called, whether credentials were present, or who
   called it, you are not debugging — you are guessing with extra steps. Instrument first; it is
   almost always faster than the third theory, let alone the fifth.
4.39. **Do not ship a remedy built on an unconfirmed diagnosis. A wrong instruction in the product is
   worse than none.** When a partner could not connect, I concluded Android was hijacking the OAuth
   callback and shipped guidance into the SIGN-IN PAGE telling people to paste the callback URL into
   their address bar. It was wrong twice over: pasting that URL starts another transient add rather
   than completing the original flow, so it walked people round the loop — and the diagnosis itself
   was wrong, since the same failure happened with the shim reverted to known-good code.
   A second attempt tried to DETECT the hijack: navigate, and if the page is still visible 1.8s
   later, show a fallback. It never fired. When the app takes the foreground the browser tab is
   backgrounded, so \`document.hidden\` goes true — and the guard added to avoid false positives
   suppressed the only true positive. You cannot observe an app switch from inside the tab that the
   switch backgrounds.
   THE RULE: a theory you have not tested is not a fix, and putting it in front of users multiplies
   it by everyone who reads it. Confirm the cause first; if you cannot, say what is known and what is
   not. Both changes were removed and the page went back to what it had when it worked.
4.38. **"It worked before" is not proof you broke it — and checking the part you think matters is not
   proof you did not. BISECT.** A connector stopped attaching. I diffed the auth path, found it
   untouched, and treated that as exoneration — then spent four rounds blaming the phone, the OS
   link settings and the account plan. The auth path is not the only thing a client needs in order to
   persist a connector, and I never questioned the parts I HAD changed.
   The move that settled it in one step: revert the whole component to the last state that
   demonstrably worked, deploy, and test. It still failed, which proved the cause was elsewhere and
   let everything be restored at once instead of unpicking ten commits. Had it succeeded, the same
   revert would have bounded the search to that set.
   A revert costs minutes and is fully reversible in git. Defending a change costs a session and
   convinces nobody, least of all the person whose thing is broken.
4.37. **When a client and a server disagree, get a real client and record what it does.** The
   connector authenticated and then reported itself disconnected, with clean server logs. Reading
   code could not settle it. Driving the actual sign-in page in a real Chromium with request and
   navigation logging settled it in one run: our side returned 200 throughout, the browser reached
   the callback with a valid code, and CLAUDE'S flow ended at \`step=end_error\`.
   That is the difference between "the server looks fine" and "the server IS fine and the failure is
   downstream of it" — and only the second one lets you stop changing the server. Installing a
   browser to answer it took ten minutes; guessing had already taken hours.
4.36. **A check tuned until it passes is worth nothing — and a check that always fires is worse than
   no check.** The edge-function dry run compares deployed against repo. Its first version reported
   drift on all five functions, including ones that had no reason to have drifted, because
   \`supabase functions download\` returns the extracted ESZIP BUNDLE, not your source: transpiled,
   re-printed, comments gone, imports hoisted. mcp came back 6,400 bytes SMALLER than the repo file.
   Normalising both sides narrowed that to 190 bytes, and the remainder was STILL artifacts —
   redundant parentheses the bundler drops, a type-annotation remnant, a hoisted import.
   THE DISCIPLINE: at that point the temptation is to keep loosening the normaliser until it goes
   green. Do not. A comparison tuned until it agrees with you has stopped being evidence. Say what
   the check can and cannot establish, and then go and remove the NEED for it — here, one deploy
   from the repo makes deployed == repo true by construction and the question dies permanently.
   ALSO: never quote a first-divergence as proof of full equality. It is the first difference, not
   the only one.
4.35. **When you COMPOSE tools, you inherit their failure semantics — and it is easy to flatten them
   into success. Auth failure is not a partial result.** The \`overview\` tool merges two existing
   reads. Unauthenticated, it answered HTTP 200 with a cheerful "Partial overview" showing zeros,
   because both legs had failed and it treated that as missing data. Nothing leaked, but MCP clients
   start the OAuth flow off a 401 with WWW-Authenticate — so a partner with an expired token would
   have been shown an empty CMS, in confident detail, and never prompted to sign in. The tool built
   to say where things stand would have said everything was gone.
   Distinguish the failures: 401/403 propagate with the right status and header; a genuine outage
   stays a partial 200 and says which leg failed. Never let a composed tool report a confident zero
   that actually means "the call failed".
   Found by testing the DEPLOYED shim over the wire. Reading the code would not have shown it.
4.34. **There is no "on connect" event — an orientation must be a DIRECTIVE, not a payload.** Nothing
   fires when a partner attaches a connector. The only thing a host reads at connection is the
   \`instructions\` string from initialize, and it is STATIC: any counts written into it are stale the
   moment someone proposes a question. So instructions must tell the assistant to CALL a tool, and
   the tool carries the live state. PREPEND to the upstream instructions rather than replacing them —
   the routing rules that stop "always call X first" from hijacking unrelated requests live there.
4.33. **Read the specification before diagnosing, and believe a screenshot over a theory.**
   The preview widget was called "blank" for three sessions. It was never blank. It was CLIPPED to
   about one card, and the proof was sitting in a screenshot the whole time: the diagnostic status
   bar read "data received — 12 question(s)" and the first card's chips were drawing. A view that
   mounts, receives data and renders is not a view the host refused to fetch. The reported symptom
   ("it's blank") was accepted as an observation when it was already an interpretation.
   THE ACTUAL CAUSE, found by reading SEP-1865 rather than iterating: a view must send
   \`ui/notifications/size-changed\`. Under flexible dimensions the VIEW owns its height and the host
   resizes the iframe to what it reports. Ours never sent it once. The min-height:160px added to
   force the issue could never have worked — an iframe is sized from OUTSIDE, so its own stylesheet
   cannot make it taller. Reading the spec properly turned up three more deviations in the same pass:
   wrong ui/initialize params, the initialize RESULT never read (discarding containerDimensions,
   theme, displayMode), and a \`ui/notifications/context-update\` method that does not exist, so every
   reviewer interaction had been going nowhere.
   THE RULE: when integrating against a published spec, the cost of reading it is one session and the
   cost of not reading it was three. Before iterating on a symptom, (a) go to the primary
   specification, not blog posts or an issue tracker; (b) re-read the evidence you already have and
   ask what it PROVES rather than what it suggests; (c) distrust any hypothesis that conveniently
   makes the problem someone else's. See also 4.21.
4.32. **Questions are never pre-rendered — level rules propagate live.** A question row stores only
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
   Because level is a plain int (no FK to pm_levels), deleting a level MUST clean up ALL references
   via the pm_level_delete_cleanup BEFORE DELETE trigger: reset pinned PACKS to the highest remaining
   level (a pack's level can't be null), un-pin QUESTIONS (→ null), drop OVERRIDE rows at that level.
   Never remove or narrow that trigger or you leave stale pointers.
4.31. **AI content NEVER bypasses human review.** generate-questions writes ONLY to pm_review_queue.
   The single path into pm_questions is the pm_review_approve RPC, which requires an explicit human
   decision. Never add a "publish straight through" path, an auto-approve, or a direct insert from a
   generator - a child must never see a question no person approved.
4.30. **GitHub does NOT deploy Supabase. The two are decoupled.** Pushing to the repo updates ONLY the
   Cloudflare-hosted front-end. The edge functions in edge-functions/*.ts are a SAVED COPY — committing
   them does NOT deploy them. A function changes on Supabase only when someone explicitly deploys it
   (MCP \`deploy_edge_function\`, or CLI \`supabase functions deploy <name> --project-ref
   tytrmjjucqijzcrbwjfm\`; add --no-verify-jwt for content-api and game-feed). SAME for DB/RLS/RPC —
   apply via migration/SQL, never via a push. When you edit an edge function: commit the source AND
   deploy it in the same unit of work, and say so in the commit — otherwise the repo and the live
   backend silently drift (this is exactly how game-feed and pack-describe ran live for weeks with no
   source in the repo). Before editing any edge function, diff the repo copy against the deployed one
   (\`get_edge_function\`); if they differ, the DEPLOYED version is source of truth until reconciled.
   **DEPLOYING BY TRANSCRIPTION IS THE RISKIEST THING IN THIS REPO.** deploy_edge_function takes the
   file CONTENT inline, so deploying mcp.ts means re-emitting ~1,300 lines by hand. That has already
   caused a real incident: a 1-line PLACEHOLDER was deployed over the live mcp function, breaking it
   until it was recovered. It also causes benign-looking drift — comments get condensed in transit, so
   the deployed copy and the repo copy stop matching even when behaviour is identical. Rules: after
   ANY inline deploy, fetch the deployed copy back and compare; and never treat "it deployed" as "it
   works" — exercise the changed tool over the wire before moving on.
   **CI IS LIVE: .github/workflows/deploy-edge-functions.yml.** It stages the flat
edge-functions/<slug>.ts into the supabase/functions/<slug>/index.ts layout the CLI wants and deploys
byte-for-byte, with --no-verify-jwt for the functions that authenticate their own callers (mcp,
content-api, game-feed, pack-describe) and the JWT gate left on for generate-questions.
SUPABASE_ACCESS_TOKEN was added 9 Aug 2026 and is confirmed working. NOTE it is a PERSONAL ACCESS
TOKEN (account level, starts sbp_, from the account Access Tokens page) — NOT a project API key.
Those are different credentials and the naming misleads: project keys authenticate requests TO the
database and cannot deploy anything, and the service_role key must never go near CI because it
bypasses every RLS policy.
TWO GUARDS were added before it was ever run for real. The workflow used to list ITS OWN FILE in its
push paths, so editing the deploy script deployed the live mcp function as a side effect — editing
CI must never ship code. And \`mode: dry-run\` (the default for manual dispatch) downloads what is
actually deployed and compares, deploying nothing.

**THE REAL FIX IS CI.** The repo has CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, which is why the
   site and the mcp-shim Worker deploy automatically and exactly. There is NO SUPABASE_ACCESS_TOKEN,
   which is the only reason edge functions cannot. Adding that one secret would let a workflow run
   supabase functions deploy straight from edge-functions/*.ts, making deployed == repo true by
   construction and removing this whole class of error. Strongly recommended.
   ACCESS: a contributor with only GitHub access can change the website and nothing else. To touch the
   backend they need access to the Supabase PROJECT — invited to the Supabase org (preferred) or a
   personal access token — then the Supabase MCP on their own Claude account inherits that access. The
   MCP connector is only the pipe; authorization lives on Supabase, not on the Claude side. Full
   onboarding steps: Architecture §0.4 and CONTRIBUTING.md.
4.29. **API keys must never be readable by the browser.** pm_ai_config deliberately has NO RLS select
   policy for anon OR authenticated. The CMS is a browser app with a shared admin login, so anything
   the client can SELECT is effectively public to anyone with that login (or any XSS). Keys are
   written via pm_ai_set_key and read ONLY server-side by the edge function (service role). The UI
   reads pm_ai_status, which returns a masked hint and NEVER the key. Never add a select policy to
   pm_ai_config, never return api_key from an RPC, never send a key to the client "just to show it".
4.28. **Settings configure; content pages create.** Generation was buried inside AI Settings as a
   stripped-down panel — which put it in two places at once, and made the API path a poor relation of
   the manual one (no themes, no frame words). One page, one set of options, two ways to run it. How
   you run something must never change what you're allowed to ask for. And never show a control that
   does nothing in the current mode: hide it.
4.27. **Ask "how will someone ACTUALLY use this?" BEFORE building the auth model.** I built the MCP
   connector with a shared-secret bearer token, because that is how most APIs work. Claude's connector
   screen has no field for one — it does OAuth or nothing — so the whole auth model was unusable, and
   I only found out when Albert asked how partners connect. Check the actual UI the user will face
   before designing for it.
4.26. **"It returned 200" is not "it works".** All three base-URL bugs in the OAuth server (http instead
   of https, wrong path, Supabase's INTERNAL hostname) returned a perfectly healthy 200 while telling
   Claude to go somewhere that did not exist. Read what the response SAYS, not just its status code.
4.25. **The SHAPE of a tool's output decides how it gets rendered — more than any instruction does.**
   preview_questions returned each question with all ten levels nested inside it. Twelve questions x
   ten levels meant the payload was overwhelmingly level-shaped, so it was summarised level-by-level,
   and no amount of "show the questions, not the levels" wording fixed that — the wording was fighting
   the data. Restructuring it question-first fixed it immediately. When output is being presented
   wrongly, look at what dominates the payload before writing another instruction.
4.24. **Do not let a nicer version regress a working one, and make failure visible if you try.**
   The preview already worked: the assistant built a playable card from the data. Adding an MCP Apps
   widget made the host render the widget INSTEAD — and the assistant still reported success, because
   from its side the widget had rendered. A working feature was replaced by a broken-looking one and
   the failure was invisible from the inside. If you layer a new renderer over a working path, keep
   the old path reachable and make the new one fail loudly.
   (The widget was later found to be CLIPPED, not blank — see rule 4.33. That does not weaken this
   rule, it vindicates it: the rollback kept a working preview available for three sessions while the
   real cause was still misdiagnosed. The widget now ships WITH this rule satisfied — the text content
   block still carries the full JSON so the artifact path stays reachable, and the view's status bar
   announces its own state, so a failure is loud rather than silent.)
4.23. **NEVER smoke-test with a WRITE tool against live data.** Verifying the connector after a deploy,
   I called update_pack on the real Calmness pack to prove the handler worked. It did — and it
   overwrote that pack's description, which no table records the previous value of, so it was simply
   gone. The check itself caused the damage. Exercise READ tools (list_packs, get_pack_content,
   review_status, preview_questions, check_questions) to prove a deploy landed; they cover the same
   code paths for the purpose of "did the transcription survive". If a write path genuinely must be
   tested, create a throwaway row first and act on that, or read the current value and put it back.
   Note the asymmetry: this project has no history table, so an overwrite is unrecoverable while a
   bad read costs nothing.
4.22. **Any capped read must report the true total.** A tool that returns \`limit(40)\` rows and then
   reports \`count: rows.length\` is lying by omission the moment there are 41. Count separately with a
   head/exact query and return total + showing + truncated, and say so in the note. This project has
   now hit the silent-truncation class three times (PostgREST's 1,000-row cap, Alpaca's ~2,000-row
   cap, and this one) — the pattern is always the same: the response looks healthy and the number is
   simply wrong. Assume every cap will be reached eventually and fix it while it is still latent.
   Related: name identifiers for what they are. A live-question \`id\` sitting next to tools that take
   review-queue ids is a trap even when the wrong id fails safely.
4.21. **Instrument the negotiation, not just your own code — and do not let a plausible external
   explanation end the investigation.**
   ORIGINAL FORM: this rule said MCP Apps was implemented to spec but Claude Web never asks a custom
   connector for the UI resource, so no amount of correct implementation would open it. THAT WAS
   FALSE, and it was believed for three sessions. The host did fetch the resource and did render the
   view; it was clipped because the view never reported its height (rule 4.33).
   WHAT ACTUALLY WENT WRONG is worth more than the original advice. An open bug report existed that
   matched the symptom, so the symptom was pattern-matched to it and treated as confirmed. A
   screenshot showing the widget HALF working — status bar populated, first card drawing — was read
   as showing it not working at all. The rung-logging that supposedly proved resources/read was never
   called was measuring the wrong thing, and its result was never sanity-checked against the
   screenshot sitting in the same conversation.
   THE RULE: instrumenting each rung is still right. But an external cause (platform gap, upstream
   bug, someone else's issue tracker) is the most comfortable answer available and therefore the one
   to distrust most. Before accepting it, state what you would expect to see if the cause were LOCAL,
   and go and check that. Here the local hypothesis predicted exactly what the screenshot showed.
   AND: ship the fallback that works today anyway. That part held up — the artifact path is why there
   was something usable throughout, and it is still the fallback for hosts without MCP Apps.
4.20. **A self-test that hard-codes what the CLIENT discovers is not a test.** The MCP self-test drove
   the OAuth flow by calling /register, /authorize and /token at URLs it already knew — so it passed,
   green, repeatedly, while the connector was completely unusable from a real Claude client. The step
   it skipped (root /.well-known discovery) was the ONLY step that was broken. When a client does
   discovery, routing or negotiation on its own, the test must start where the CLIENT starts, or it
   proves nothing about the path that matters. When you cannot drive the real client, INSTRUMENT the
   server and read what it actually receives: adding request logging to the shim is what finally
   located this, and each stage of an OAuth flow leaves a row (pm_oauth_clients → codes → tokens),
   so a count of those tables tells you exactly how far the real client got.
4.19. **The MCP connector must never gain a write path to LIVE QUESTIONS — except approval, which
   was built Aug 2026 under conditions this rule set.** The invariant is that pm_review_approve stays
   the only route a question takes into a pack. propose_questions writes to the queue and nowhere
   else. Never let a tool write pm_questions directly.
   create_pack and update_pack DO write, and that is acceptable, because a pack is a CONTAINER, not
   content — a connector-created pack is EMPTY until questions are approved into it.
   preview_questions is READ-ONLY; reject_questions and edit_queued_question write only to PENDING
   queue rows — rejecting removes from the pipeline and an edited row stays pending, so neither can
   reach a child. An edit is re-validated and refused if it breaks a rule.
   APPROVE, BUILT 11 Aug 2026, meeting the three conditions this rule named when it withheld it:
   • PER-TOKEN. can_approve on pm_mcp_tokens. Tokens without it never SEE approve_question or
     unapprove_question — tools/list filters them out, because a capability that is absent cannot be
     attempted or argued with. DEFAULT IS TRUE by Albert's explicit decision: a partner approving is
     still a HUMAN approving, which is what this invariant protects. The cost, recorded plainly, is
     that the writer and the reviewer may now be the same person, so the queue is a checkpoint the
     author passes through rather than a second pair of eyes. Withdraw it per token with one UPDATE;
     authenticate() re-reads the row every request, so it bites immediately.
   • ONE AT A TIME, NO BULK. A same-length pair, or a wrong option that also fits the sentence, is
     invisible in a list and only surfaces when the question is PLAYED. Bulk approval is one tap that
     puts unexamined questions in front of children. The friction is the feature.
   • confirm_answer MUST MATCH the correct word, exactly as shown on the card. Statelessly we cannot
     verify a preview happened; requiring the word back proves the caller SAW the question rather
     than approving an id off a list. It is a weak proof and an honest one — a speed bump, not
     security.
   • AND AN UNDO, which is what makes approval a tap rather than a commitment. unapprove_question
     sets the question inactive (feeds serve active only, so it leaves the game next poll) and
     returns the row to pending. Nothing is deleted. It only ever REMOVES content from children —
     the same reasoning that has always permitted reject_questions.
   review_status is READ-ONLY and its visibility is deliberately SHARED (all partners see all
   submissions), matching the shared-admin model rather than inventing a boundary the CMS does not
   enforce.
   Deliberately still absent: DELETE for packs (destructive — it takes the questions with it), and
   any edit to a live question's CONTENT. Removing is safe; changing is not.

4.18. **EVERY content-entry path goes through the review queue.** Not just AI generation — imports
   too. There were two ways in and only one was gated, and the ungated one (Bulk Import) is how
   BRIGHT/GENTLE reached children. Do NOT try to detect whether content "came from AI": you usually
   cannot tell, and a wrong guess means unchecked content reaches a child. The ONLY path into
   pm_questions is pm_review_approve. If you add a new way to create content, it goes through the gate
   or it does not ship. (The one deliberate exception is whole-pack file RESTORE, which lands as a
   DRAFT and is validated with a loud warning — but it must never be published unchecked.)
4.17. **The lint must check the defect that actually breaks the game.** pm_lint checked four cosmetic
   things and missed the ONE that harms a child: an alternate the same length as the answer. Two
   broken questions sat LIVE in a published pack while the health check said all was well. Any check
   the AI validator performs on new content, the lint must perform on existing content — above all
   \`ambiguous\`. A health page that cannot see the worst defect is worse than none: it is false comfort.
4.16. **Read the LIVE FEED, not just the code.** Two real content defects (a reversed pair, an
   overused distractor) were invisible to every automated check AND to reading the pages — they only
   showed up when I looked at what the GAME actually receives. The checks were all grouped by ANSWER,
   so a repeated PAIR and a repeated ALTERNATE were structurally invisible. Periodically pull the real
   feed and look at it as a child would.
4.15. **If a check can make a question WRONG FOR A CHILD, the lint and the validator must both have
   it. Advisory checks may live in the lint alone — but say which is which.**
   ORIGINALLY this rule read "if the lint catches it, the validator must too", full stop, after the
   Health lint flagged reversed pairs that validateQuestion passed as clean. The Aug 2026 strict-dedup
   alignment then deliberately removed the repetition checks from the validator and restated variety
   as a PREFERENCE — which left the rule and the code contradicting each other, and the contradiction
   sat undetected because nothing tests one against the other.
   REVISED Aug 2026, and this is the actual invariant:
   • HARD checks — the ones where the child is shown two correct answers or is marked wrong for a good
     word — must exist in the lint AND in every copy of validateQuestion. \`ambiguous\` above all.
   • ADVISORY checks — variety, repetition, predictability — may live in pm_lint/pm_lint_details only.
     They describe a pack getting stale, not a question that is broken.
   CURRENT STATE, verified against the live function bodies: pm_lint and pm_lint_details carry
   \`reversed_pair\` and \`overused_alt\`; validateQuestion carries neither, in any of its four copies.
   That is now INTENDED, not drift. If you re-add them to the validator you are changing policy, not
   fixing a bug — update this rule in the same pass.
   KNOWN GAP, caught neither side: CROSS-ROLE WORD REUSE, where a word is the ANSWER in one question
   and the DISTRACTOR in another. \`reversed_pair\` groups on the same PAIR so it cannot see it, and
   \`overused_alt\` only counts repeated distractors. This is a HARD defect by the test above — the
   child is marked wrong for a word and then right for it — so it belongs in both, and is in neither.
4.14. **READ the page, don't just inspect it.** A page can be structurally perfect and still say
   nothing useful. The Health page showed "(untitled)" on every row for weeks — valid markup, correct
   layout, every automated check green — because the UI read \`d.label\`/\`d.issue\` while the RPC returned
   \`answer\`/\`code\`. No structural test can catch that. Render the page to text and READ it.
4.13. **An empty label is worse than no label.** A control wrapped in a text-less \`<label>\` counts as
   "associated" and will pass a naive check, while announcing an unnamed field to a screen reader.
   Always require the label to have TEXT.
4.12. **Inspect the RESULT, not the source.** Grepping code for suspicious patterns is not a UI audit.
   Render into a real DOM with the real evaluated stylesheet and walk the computed styles. And VALIDATE
   YOUR ORACLE FIRST: extracting CSS by regex left \`\${...}\` placeholders that jsdom silently rejected,
   so every computed style was a lie; and a naive label check flagged every correctly-built field,
   because a control wrapped in a <label> IS associated (implicit association). A broken oracle is worse
   than none.
4.11. **Never regex-edit JSX.** A careless pattern inserted attributes inside arrow functions
   (\`onChange={(e) = aria-label="x"> setFoo(...)}\`) across 12 lines. Only the build caught it. Use
   targeted, structure-aware edits.
4.10. **Cap the CONTENT, not just the container.** A max-width on the page wrapper does nothing for a
   lone form field or a paragraph inside it — they will happily fill all 1080px, leaving a giant
   input marooned in white space and body copy ~150 characters wide. Every form gets a readable cap
   (\`.pm-form-2\` 860px), every panel \`.pm-readable\` (720px), every paragraph \`.pm-prose\` (680px).
   This is the difference between "responsive" and "actually looks designed".
4.9. **Device class is decided on the SHORT side, never on raw width.** A phone in landscape is
   667–932px wide — wider than many tablets. Keying layout off innerWidth alone made rotating a phone
   swap the entire navigation and drop every phone-specific rule (including the 16px inputs that stop
   iOS auto-zooming). Decide on min(w,h) for touch devices; only a resizable desktop window should key
   off live width. And there must be ONE breakpoint system: the JS stamps a class on <html> and the
   CSS keys off it. Never reintroduce parallel width media queries — they WILL drift.
4.8. **Config must never lie.** If a flag exists and is reported to the UI, something must ENFORCE
   it. \`pm_ai_config.enabled\` sat unchecked for a while: you could "disable" a provider and it would
   still be used. Either enforce a flag or delete it — dead config that lies is worse than none.
4.7. **"Null means don't change" needs an escape hatch for every field.** The setter treats null as
   "leave it alone", which is right for a key you can't read back — but it means an empty value cannot
   be expressed. Temperature/top_p have explicit clear flags; the system prompt uses an empty string.
   Any new nullable setting needs one or the other, or users will be unable to UNSET it and the UI
   will silently lie.
4.6. **NEVER send temperature/top_p unconditionally.** Anthropic returns 400 for them on Opus 4.7+;
   OpenAI rejects them on GPT-5 reasoning models. They must be nullable and OMITTED from the request
   body when unset. A "sensible default" here breaks generation entirely on those models. Because null
   means "don't change" in the setter, keep the explicit clear flags so a value can actually be unset.
4.5. **A params-only save must never wipe the API key.** The key can never be read back, so the setter
   takes a null key to mean "keep the existing one". Never add an overload of pm_ai_set_key — two
   signatures make the call ambiguous and every save fails.
4.4. **Anything that spends money must be logged and rate-limited.** AI generation is the only
   operation in this app with a real cost. Every provider call (generate/repair/test, success AND
   failure) goes to pm_ai_usage with token counts and the actor; the edge fn checks pm_ai_rate_check
   BEFORE calling a provider. Never add a new paid call without both. Logging must be best-effort so
   it can't break the request.
4.3. **Mobile nav must be DERIVED from NAV, never hardcoded.** The phone drawer once had a hardcoded
   list, which left three whole pages (AI Review, AI Settings, Generator) unreachable on a phone. It
   now renders NAV.filter(n => !NAV_PHONE.includes(n.id)). Never hardcode that list again.
4.2. **De-dup context must include the review queue and the current batch.** Comparing only against
   live questions is not enough: two generate runs before a review will duplicate each other, and a
   question you REJECTED will be regenerated. Always seed the validator's \`existing\` with live
   questions + pending + rejected queue rows, and validate a batch CUMULATIVELY (each item sees the
   ones before it) so a word repeated within one batch is caught. Also: an answer WORD reused in a
   different sentence is a real defect (a 10-20 question pack teaching BRAVE twice) - never collapse
   duplicate detection back to "same sentence AND same answer".
4.1. **validateQuestion is a PARITY INVARIANT** (like maskWord). The copy in core.jsx and the copy in
   the generate-questions edge fn must stay byte-identical - the CMS and the generator must agree on
   what "valid" means. Its headline check, "ambiguous", runs the REAL engine at EVERY level: if the
   alternate ALSO fits the blank anywhere, the puzzle has TWO correct answers. At whole-word levels
   the only clue is LENGTH, so ANY same-length alternate is broken there. This is not hypothetical -
   BRIGHT/GENTLE, SURE/GLAD and KIND/MEAN all shipped broken in live content and all look fine to a
   human eye. Never weaken or skip this check.
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

### THE TEST SUITES — there are SIX, and \`npm test\` runs them all
Run \`npm test\`. Do not run the two you remember (rule 4.47).
  npm run test:engine    engine.js    1725 cases — maskWord parity across EVERY copy of it
  npm run test:runtime   runtime.js   renders each page headless, fails on any warning or crash
  npm run test:read      read.js      reads each page as a human would: the words, in order
  npm run test:inspect   inspect.js   real DOM + real stylesheet, inspects COMPUTED styles
  npm run test:interact  interact.js  actually CLICKS things — 42 buttons, 52 inputs
  npm run test:visual    visual.js    layout across 27 page/device combinations
Plus three the npm target does NOT cover, run them by hand after touching mcp-shim/:
  node mcp-shim/widget-test.mjs     the MCP App view, both payload shapes, in jsdom
  node mcp-shim/overview-test.mjs   the overview tool, its failure modes, the view URI rules
  node mcp-shim/logging-test.mjs    redaction — asserts no secret can reach pm_connector_log

### What a HEALTHY run looks like, so you can tell a regression from the baseline
  engine    "1725 cases across 3 implementations — ALL IDENTICAL"
  runtime   "No runtime warnings or errors."
  inspect   "No defects found."
  interact  "42 buttons clicked, 52 inputs changed. Nothing broke."
  visual    ~153 MINOR defects, 0 serious — every one a control under the 40px comfortable touch
            target. That is the STEADY STATE for a desktop-density admin UI, not a regression.
            Watch the SERIOUS count; if it is not 0, something actually broke.
  visual also writes browsable HTML to /home/claude/bt/visual/ — open it rather than guessing.

### Edge functions: compile before you deploy
A syntax error in edge-functions/*.ts ships silently and the function 500s in production:
  npx esbuild edge-functions/mcp.ts --outfile=/tmp/check.js --format=esm --target=es2022

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
- pm_question_levels(question_id FK, level, per-level override of letters_hidden / letter_position /
  letter_grouping) — the exception layer over pm_levels, for a question that needs different masking
  at one level only.
- pm_levels(level 1..10, letters_hidden, letter_position, letter_grouping, whole_word, label, …) —
  the level ladder. Editing a row here changes EVERY question at that level immediately, because
  questions are never pre-rendered.
- pm_review_queue(id, pack_id, template, answer, alt_answer, status [pending/approved/rejected],
  provider, validation jsonb, target_level, reason, timestamps) — the ONLY way partner content
  enters a pack, via pm_review_approve.
- pm_activity (audit log), pm_export_profiles(spec jsonb, is_builtin), pm_sync_log,
  pm_sync_targets(config jsonb), pm_dev_notes (singleton id=1)
- AI: pm_ai_config (provider keys, model, temperature — keys written ONLY through
  pm_ai_set_key/pm_ai_clear_key, never selected back), pm_ai_settings, pm_ai_usage (per-call token
  and cost accounting, feeding pm_ai_rate_check).
- CONNECTOR / OAUTH — these are what let partners in, and a rebuild without them has no connector:
  pm_mcp_tokens(id, partner, token_hash [sha256 hex of the pmk_ token, never the token],
    active, created_at, created_by, last_used_at, calls_made). RLS on, ZERO policies: only the
    service role touches it. active is re-read on EVERY request, so revocation is immediate.
  pm_oauth_clients(client_id, client_name, redirect_uris, created_at) — dynamic registration,
    RFC 7591. One row per Connect press; expect many.
  pm_oauth_codes(code, client_id, token_id, code_challenge, redirect_uri, used, expires_at) —
    single-use PKCE authorization codes.
  pm_oauth_tokens(access_token PK, token_id FK, client_id, expires_at, refresh_token,
    refresh_expires_at, last_used_at) — NO unique constraint on token_id, deliberately: one partner
    token supports many simultaneous sessions.
  pm_connector_log(at, phase, method, path, query, status, had_auth, client_id, partner, ua,
    cf_ray, country, session_id, err, ms, note) — insert-only under anon (a policy for INSERT and
    no read policy), capped by pm_connector_log_prune.
- The FULL RPC surface is larger than the list below: pm_ai_set_key / pm_ai_clear_key /
  pm_ai_set_enabled / pm_ai_status / pm_ai_usage_summary / pm_ai_rate_check, pm_content_manifest,
  pm_review_enqueue / pm_review_approve / pm_review_reject / pm_review_counts,
  pm_mcp_issue_token / pm_mcp_list_tokens / pm_mcp_revoke_token, pm_oauth_cleanup,
  pm_connector_log_prune, pm_bump_pack_version, pm_level_delete_cleanup, plus the tombstone and
  touch triggers. The SECURITY DEFINER ones are exactly those that must act beyond the caller's
  RLS: the AI key handling, token issuing, the connector log prune, and the tombstone triggers.
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
6c. **AI content generation + MANDATORY human review (two dedicated pages).**
   Build an edge function \`generate-questions\` with verify_jwt=TRUE (only a logged-in admin may
   spend API credits). It must support THREE providers - Anthropic (/v1/messages, x-api-key header),
   OpenAI (/v1/chat/completions, Bearer, max_completion_tokens) and Gemini
   (generativelanguage .../:generateContent?key=, contents[].parts[].text) - one adapter each,
   returning raw text; share the JSON-array parsing (strip code fences, slice from first [ to last ]).

   THE APPROVAL GATE (non-negotiable): the function writes ONLY to a \`pm_review_queue\` table, NEVER
   to pm_questions. Columns: id, batch_id, pack_id, template, answer, alt_answer, frame_slots,
   target_level, provider, model, status(pending|approved|rejected), edited, reject_reason,
   decided_at, decided_by, approved_question_id, validation jsonb, created_at. RLS authenticated-only
   (anon must NOT see unreviewed content); add it to the realtime publication. The ONLY path into
   live content is a \`pm_review_approve\` RPC (atomic: insert the question, mark the row approved,
   link them, flag edited if the human changed anything, note it as AI-generated+approved). CAUTION:
   pm_questions.frame_slots is NOT NULL - coalesce null to '{}' or every approve fails.
   \`pm_review_reject(id, reason)\` records the decision and writes nothing.

   API-KEY SECURITY: store keys in \`pm_ai_config\` (provider PK, api_key, model, enabled) with RLS
   enabled and DELIBERATELY NO SELECT POLICY for anon or authenticated - the browser must not be able
   to read keys at all (this CMS has a shared admin login, so a client-readable key is a public key).
   Write via SECURITY DEFINER \`pm_ai_set_key\`/\`pm_ai_clear_key\`; expose status via
   \`pm_ai_status()\` which returns {configured, hint: masked last 4, model, updated_at} and NEVER the
   key. The edge fn reads the key with the service role. Non-secret settings (active_provider,
   batch_size, auto_repair) go in a separate client-readable \`pm_ai_settings\` singleton. Add a
   \`callFn()\` helper in core.jsx to invoke verify_jwt edge fns with the user's token (mirror rpc()'s
   401 refresh-and-retry).

   THE VALIDATOR (the reason any of this is trustworthy): a \`validateQuestion(q, levels, opts)\` in
   core.jsx, MIRRORED byte-identically in the edge fn (a parity invariant like maskWord). It runs the
   REAL masking engine at EVERY level and flags: no/multiple {blank}; missing/identical words; the
   level's word-length band + multi-word rule; non-letter characters; duplicates; and above all
   AMBIGUOUS - the alternate ALSO fits the blank at some level, so the puzzle has TWO correct answers
   and a child is marked wrong for a right answer.

   REPETITION needs FIVE distinct flags, not one — and two of them are easy to miss entirely:
   \`duplicate\` (same sentence AND same answer), \`same_sentence\` (same sentence, different answer),
   \`answer_reused\` (the ANSWER WORD is already taught elsewhere), \`reversed_pair\` (THE SAME TWO WORDS
   offered as the choice, just swapped over — CALM/PROUD and PROUD/CALM: different sentences, so not a
   duplicate, but the child faces the identical decision twice), and \`overused_alt\` (the same word used
   as the DISTRACTOR 3+ times — a predictable wrong option teaches the child "it is never that one"
   instead of teaching them to read the blank).
   The last two are the ones you will miss: every naive check groups by ANSWER, so a repeated PAIR and
   a repeated ALTERNATE are structurally invisible. Both were live in real content and no check saw
   them. When you group, group by the SORTED PAIR, and separately by the ALTERNATE.
   And CRUCIALLY: every check the Health lint performs on EXISTING content, validateQuestion must
   perform on NEW content — in BOTH copies. They were inconsistent (the lint caught reversed pairs, the
   validator did not), which meant the AI could generate one and the review queue would call it clean.
   The de-dup context must therefore carry BOTH words (template, answer, AND alt_answer) — a query that
   selects only the answer makes the pair checks silently blind.
   DUPLICATES — the original three, for reference: \`duplicate\` (same sentence AND same answer),
   \`same_sentence\` (same sentence, different answer), and \`answer_reused\` (the ANSWER WORD is
   already taught elsewhere - the case that matters most, and the one you miss if you only compare
   whole questions; in a 10-20 question pack, teaching BRAVE twice is a real defect). The de-dup
   CONTEXT must be wider than "live questions in this pack": include live questions (active AND
   inactive) + PENDING queue items + REJECTED queue items + the other items in the SAME BATCH
   (validate cumulatively so the second copy of a repeated word is flagged, not the first; seed the
   repair pass with the batch's already-good items too). Without the queue in scope, two generate runs
   before a review duplicate each other and rejected questions get regenerated. Do NOT cap the
   avoid-list sent to the model - list every taken answer word, call out previously-rejected words,
   and show the sentences already used so it varies phrasing instead of just swapping the word.
   In the UI, treat answer_reused/same_sentence as SOFT (advisory) and the mechanical defects as HARD;
   bulk-approve must only take rows with ZERO flags of any kind. At whole-word levels the ONLY clue is LENGTH, so
   ANY same-length alternate is ambiguous there. Auto-repair: send failures back to the model ONCE
   with the exact defect text, re-validate, swap in the fixes (best-effort; on failure queue the
   originals WITH flags).

   PAGE 1 - AI Settings: a card per provider showing Configured/not with a MASKED hint only, the
   model, "Use this one", "Add/Replace key" (a write-only password field - never render a key back),
   "Test" (a tiny round-trip via the edge fn), "Remove". Plus generation defaults and a Generate panel
   (pack, target level, count, notes) whose output goes to the review queue.
   PAGE 2 - AI Review: tabs pending/approved/rejected; each row shows the sentence, both words WITH
   their letter counts, the pack, level, provider, and any validation flags with plain-English
   reasons; per-row Approve / Edit / Reject; bulk "Approve N clean"; a reject dialog capturing an
   optional reason. The Edit modal must RE-VALIDATE LIVE as you type (same validateQuestion) and show
   the blank shape at every level, highlighting the levels that are ambiguous - so you can see the
   moment a fix actually clears the problem.

   GENERATION PARAMETERS: expose max_tokens, temperature, top_p and system_prompt per provider
   (store them in pm_ai_config), plus a free-text model box so a new model doesn't need a redeploy.
   CRITICAL: temperature and top_p must be NULLABLE and OMITTED from the request body when unset -
   Anthropic returns 400 for temperature on Opus 4.7+ and OpenAI rejects it on GPT-5 reasoning models,
   so a "sensible default" slider BREAKS generation on those models. Since null means "don't change"
   in the setter, add explicit clear flags so a value can actually be unset, and warn about this in
   the UI. Per-provider mapping differs and silently fails if you get it wrong: max tokens is
   max_tokens / max_completion_tokens / generationConfig.maxOutputTokens; the system prompt is a
   top-level 'system' field (Anthropic) / a system MESSAGE (OpenAI) / a separate 'systemInstruction'
   (Gemini). Put the game's rules in the SYSTEM prompt, not the user turn - models follow them more
   reliably. Detect truncation (stop_reason/finish_reason) and say so plainly, or a too-low max_tokens
   just looks like a baffling JSON parse error. A params-only save must NOT wipe the API key (it can
   never be read back) - accept a null key meaning "keep the existing one", and never create a second
   overload of the setter or the call becomes ambiguous.
   ENFORCE WHAT YOU EXPOSE: if the config has an \`enabled\` flag (or any flag the UI shows), the edge
   fn MUST check it. A flag that is reported but never enforced is config that lies. Give it a Turn
   on/off control and refuse with a clear error when it's off.
   EVERY NULLABLE SETTING NEEDS A WAY TO UNSET IT: the setter treats null as "don't change" (correct
   for a key you can't read back), so an empty value cannot otherwise be expressed. Use explicit clear
   flags (temperature/top_p) or an empty string (the system prompt). Without this, users can never
   remove a value and the UI silently lies to them.
   SURFACE A SHORT BATCH: if the model returns fewer questions than asked, say so and name the likely
   cause (usually the token ceiling). Return 'requested', 'truncated' and a 'warning' and show it.
   EXPLAIN EVERY SETTING: each field gets an (i) that opens a plain-English explanation - what it is,
   why it matters FOR THIS JOB (writing children's puzzle content), a suggested value, and a warning
   where one is warranted. Do not write generic API documentation; write what it does HERE.
   COST + RATE CONTROL (do not skip this): generation is the only paid operation. Log EVERY provider
   call (generate/repair/test, success AND failure) to a pm_ai_usage table with provider, model, pack,
   batch, input/output tokens, questions returned, ok, error and the actor (read the email out of the
   verified JWT). Check a pm_ai_rate_check RPC BEFORE any provider call and return 429 with a clear
   message when over the limit (sensible defaults: 20/hour, 100/day). Surface a Usage panel on the
   settings page (runs, questions, tokens, errors, by provider). Make the logging best-effort so it can
   never break a generation the user is waiting on.
   CONCURRENCY: the approve/reject RPCs must SELECT ... FOR UPDATE, or two simultaneous approvals of
   the same queue row can both see 'pending' and create two questions. Also guard against the pack
   having been deleted between generating and approving.
   COUNTS: never download the whole queue to the browser to count it - use a server-side counts RPC.
   MOBILE: the phone drawer MUST be derived from NAV (NAV.filter(n => !NAV_PHONE.includes(n.id))), or
   new pages end up unreachable on a phone.
   EVERY CONTENT-ENTRY PATH GOES THROUGH THE QUEUE — not just the API-key generator. Bulk Import
   (pasting AI output, or your own lines) must ALSO enqueue, never write to pm_questions directly.
   Do NOT try to detect whether a paste "came from AI": you usually cannot tell, and a wrong guess
   means unchecked content reaches a child. Validate every imported row with the SAME validator and
   show the flags BEFORE the user commits. The single exception is whole-pack file RESTORE (a backup,
   or moving packs between environments) — queueing a 200-question restore one-by-one would be absurd,
   so it lands as a DRAFT instead, but it must still be validated and warn loudly.
   REMEMBER WHY THE HUMAN IS THERE: the machine judges mechanics; only a person judges tone and
   meaning. "PERFECT" passes every automated check and is still the wrong word to teach a child.
6d. **CLAUDE CONNECTOR (MCP) — let trusted partners write content by talking to Claude.**
   An edge fn \`mcp\` (verify_jwt=FALSE — partners use their OWN token, not a Supabase JWT) speaking
   JSON-RPC 2.0 over Streamable HTTP. Handle \`initialize\` (return protocolVersion, capabilities.tools,
   serverInfo, and instructions telling Claude the order to call things), \`notifications/initialized\`
   (202, no body), \`tools/list\` and \`tools/call\`.
   GIVE THE PARTNER AN ARRIVAL. There is no "on connect" event in MCP — nothing fires when someone
   attaches a connector. The only thing a host reads at connection is the \`instructions\` string from
   initialize, so build an \`overview\` tool and make instructions a DIRECTIVE TO CALL IT. Never write
   the counts into instructions: it is a static string and goes stale the moment a question is
   proposed. overview returns every pack with live/awaiting counts, how many packs are EMPTY, the
   review queue by pack and contributor, what the partner can do in plain language, and the one thing
   they cannot (approve). Declare it FIRST in tools/list — a tool listed first is the one reached for
   when someone opens with "what's here?". Compose it from the existing reads using the CALLER'S own
   token, so it needs no new privilege. Prepend the directive to the upstream instructions rather
   than replacing them, or you lose the intent-routing.
   IF YOU COMPOSE TOOLS, PROPAGATE 401/403 rather than reporting an empty system. A composed tool
   that swallows an auth failure into a cheerful "everything is zero" will show a signed-out partner
   an empty CMS and never prompt them to sign in. A genuine outage is a different thing from an auth
   failure and should stay a partial result.
   TEN TOOLS in the edge function (the shim adds overview on top, making eleven the partner sees):
   list_packs (packs + level rules + THE BRIEF so the rules are always in context, each
   pack carrying stats: live_questions / distinct_answer_words / awaiting_review, and INCLUDING draft
   packs with their status), get_pack_content (existing questions + words already taken + a statistics
   summary), check_questions (validate drafts, SAVE NOTHING — this is what lets Claude fix its own
   mistakes before proposing), propose_questions (writes to the REVIEW QUEUE ONLY), create_pack and
   update_pack, review_status, preview_questions, reject_questions and edit_queued_question.
   BUILD preview_questions EARLY — it renders a question exactly as a child sees it, at every level,
   mirroring the CMS's own level-variant builder. It is the only way a human can judge TONE, which is
   the thing every automated check misses and the reason the human reviewer exists at all.
   reject and edit act ONLY on pending rows; re-validate every edit with the full engine and refuse
   it if it would break a rule. Do NOT build an approve tool unless tokens carry a role flag.
   Give preview_questions a \`source\` of pending|live so the SERVER decides what to fetch; do not push
   that onto the assistant by telling it to re-shape another tool's output. Cap how many you return,
   but ALWAYS count the true total separately and return total/showing/truncated — returning only the
   capped length is silent truncation and it will mislead. Name ids for what they are: a live question
   id must not be called \`id\` when another tool takes review-queue ids.
   SHAPE THE PREVIEW PAYLOAD QUESTION-FIRST: one entry per question carrying its ready-to-display
   masked sentence, its two options, which is correct, and only a compact list of other levels. Do
   NOT nest every level inside every question — the payload becomes level-dominated and gets rendered
   as a table of level rules no matter what the instructions say. Default to ONE level.
   ROUTE INSTRUCTIONS BY INTENT, not as one chain. An unconditional "always call X first" will hijack
   every unrelated request; say what to do for previewing, for writing, for progress, separately.
   RENDERING THE PREVIEW: the useful form is a PLAYABLE card — sentence, level tabs, two tappable
   words, green/red on tap, and never reveal which is correct before it is tapped. BUILD TWO ROUTES
   TO IT, in this order.
   ROUTE 1, always: return the structured data plus an explicit instruction telling the assistant to
   build the interactive card as an artifact, carrying the CMS design tokens. This has no platform
   dependency and is the fallback forever — build it FIRST and never remove it.
   ROUTE 2, the MCP Apps widget (SEP-1865): the tool declares _meta.ui.resourceUri (NESTED under
   _meta.ui, inside the TOOL object in tools/list, not on the result; the flat _meta["ui/resourceUri"]
   is deprecated), and the shim serves a ui:// HTML resource as text/html;profile=mcp-app via
   resources/list and resources/read. The view speaks raw JSON-RPC over postMessage — no SDK, the
   Worker has no bundler.
   THE ONE THING THAT WILL WASTE YOUR TIME IF YOU MISS IT: the view MUST send
   ui/notifications/size-changed (ResizeObserver, debounced through rAF). Under flexible dimensions
   the VIEW owns its height and the host resizes the iframe to what it reports. A view that does not
   report will render correctly and be CLIPPED to its initial frame, which looks exactly like "the
   widget is blank" and is not. CSS min-height cannot fix it — the iframe is sized from outside.
   Also: send appInfo + appCapabilities.availableDisplayModes on ui/initialize; READ the result
   (hostContext carries containerDimensions, theme, displayMode) and apply it; send
   ui/notifications/initialized only on the MATCHING request id, because the host must not send
   anything before it; use the ui/update-model-context REQUEST for reviewer interactions (there is no
   ui/notifications/context-update — it is not a method, and sending it does nothing).
   CONTENT-ADDRESS THE ui:// URI: ui://<app>/view-<hash of the HTML>. Hosts cache a ui:// resource
   keyed on its URI and the protocol has no way to say "that changed", so a FIXED URI means a
   redeployed view can keep rendering the old one — silently, looking exactly like a failed deploy.
   Hash the view itself so nobody has to remember to bump anything. Keep serving any older URI so a
   live session does not break. And know that an already-rendered widget NEVER re-fetches: scrollback
   is not a current view.
   THE SYNC API IS TWO ENDPOINTS, and keep them distinct: one for SYNCING (versions, ?since
   incremental, deletions, ETag/304, selectable blocks) and one for SHAPING (saved profiles that
   rename fields and choose structure for a specific engine). Give the sync one ?include= so a
   caller takes only the blocks it needs — the pre-rendered level variants are ~19x the rest of the
   payload, so a client that masks its own words must be able to decline them. Give it
   ?shape=nested|keyed|flat, because a keyed object is what Firestore wants and a flat array is what
   a SQL import wants. PUT EVERY PARAMETER IN THE ETAG KEY: a 304 promises the body the client holds
   is still correct, and a key that ignores ?include or ?shape answers "unchanged" to a client asking
   a different question.
   Expose the CMS's own status through the same API (counts, review-queue totals, per-pack figures)
   from ONE database function, so a dashboard and the game cannot get different numbers.
   LOG EVERY REQUEST IN A WRAPPER around the whole handler, not per-branch: discovery probes, CORS
   preflight and error paths answer early, and those are exactly the requests you need when a client
   appears to do nothing. Record the phase, method, status, whether credentials were present, the
   user agent and the country (which tells the vendor's cloud from a browser). REDACT tokens, codes
   and verifiers to <redacted:N chars> and TEST that with real-shaped secrets — a log that
   accumulates credentials is a breach regardless of who can read it.
   TOKEN LIFETIMES: find out whether the client actually refreshes before choosing one. If it does
   not, a short expiry is a scheduled outage, not a boundary — make lifetimes long and make
   REVOCATION the control, re-checked on every request.
   MAKE THE VIEW STATE ITS OWN STATE. A permanent status line ("handshake sent", "NO HANDSHAKE after
   5s", "12 question(s)") is what turns a silent failure into a diagnosable one, and is the difference
   between one session and three. Have it NAME THE RESOURCE IT IS — one screenshot then tells you
   which view the host actually loaded, which you will need (see below).
   BUILD ONE VIEW, NOT ONE PER TOOL. The host picks ONE view per connector and does NOT honour
   per-tool _meta.ui.resourceUri: it will load the wrong resource for a tool and then send it
   nothing. Serve the same HTML from every ui:// URI and dispatch on the SHAPE of the payload that
   arrives. Two views also means two copies of the lifecycle code, which is a parity problem waiting
   to happen — assert in a test that the size-changed handling exists exactly once.
   TILES THAT POST INTO THE CHAT use \`ui/message\`, but the spec defines NO host capability for it and
   some hosts refuse it. Send it with an id, handle the reply, and time out on silence. Copy the text
   to the clipboard DURING the tap — synchronously, inside the gesture — not after a rejection
   arrives, because clipboard writes need a user gesture. One tap must always achieve something.
   LEVEL CONTROLS: build BOTH. A global bar that sets every question at once answers "how does this
   pack read at level 7?"; per-card tabs answer "is this one question sound all the way up?", which
   is how the same-length bug is felt. Show divergence rather than hiding it — mark a card that has
   been moved on its own, and report MIXED on the global bar instead of a value true for only some.
   THE INVARIANT: pm_review_approve must remain the ONLY route a QUESTION can take into a pack. Never
   add a tool that approves, publishes or edits a live question, or writes pm_questions directly.
   review_status is READ-ONLY and closes the feedback loop that a queue otherwise breaks: a
   contributor proposes and never finds out what happened. Report the CALLER's own submissions
   (awaiting / approved / rejected, plus how many were approved only AFTER the reviewer edited them),
   a per-pack breakdown, and the reviewer's reject_reason for recent rejections — that last part is
   what stops the same mistake being made again. Make visibility SHARED AND EQUAL: every contributor
   sees every other contributor's submissions, with attribution. Do NOT scope it per-caller unless
   contributors also have separate CMS logins — otherwise the filter is cosmetic (they can see it all
   in the CMS anyway) and it hides the rejection feedback that helps everyone.
   Pack tools are allowed because a pack is a CONTAINER, not content: a connector-created pack is
   EMPTY until the reviewer approves questions into it. NEVER add a pack DELETE tool.
   create_pack must mirror the CMS's own PackEditor + savePack convention exactly — the SAME slugify
   (lowercase, non-alphanumerics -> '-', trimmed) derived from the name, sort_order = count + 1, emoji
   default, and the pack-detail fields (purpose / focus_areas / style_approach / example_objectives).
   Add what the CMS form lacks: check the slug for collisions up front and validate the level against
   the real pm_levels rows. Create it as status='published' (the container is live in the CMS at once
   so the contributor can write into it; questions remain gated). update_pack patches ONLY supplied
   fields, must NEVER change the slug (the game keys on it), and should WARN rather than block when
   the level changes on a pack that already has questions. Log both to the activity table with
   actor='partner:<name>'.
   AUTH: OAuth 2.1 with PKCE — this is NOT optional and NOT ceremony. Claude's "Add custom connector"
   screen offers a URL and an OAuth client ID/secret and nothing else; there is no field for a bearer
   token, so a shared-secret header would never be sent. Implement /.well-known/oauth-protected-resource
   (RFC 9728), /.well-known/oauth-authorization-server (RFC 8414), POST /register (RFC 7591, dynamic
   client registration), GET+POST /authorize, POST /token. PKCE S256 mandatory, codes single-use and
   short-lived, and a 401 MUST carry WWW-Authenticate or the client never starts the flow.
   The partner's pmk_ token becomes the LOGIN CREDENTIAL on the sign-in page rather than a header.
   Store only a sha256 HASH; show the raw token ONCE. Put the token table under the same lockdown as
   the API keys (RLS on, ZERO policies). Tag every queued row \`partner:<name>\`.
   YOU ALSO NEED A DISCOVERY SHIM, or none of the above works. If the MCP server is hosted on a path
   prefix (e.g. a Supabase edge function at /functions/v1/mcp), it CANNOT serve the root
   /.well-known/* documents that Claude's discovery probes — every probe 404s and the connector shows
   "no tools available" with no sign-in screen. Put a tiny Worker on its own origin that serves both
   discovery documents at the ROOT (bare, path-suffixed and OIDC forms), proxies everything else to
   the unchanged server, rewrites the 401 WWW-Authenticate to its own discovery doc, and SERVES ITS
   OWN SIGN-IN PAGE submitted via fetch (a proxied login page arrives with the wrong content-type and
   its native form POST does nothing inside the OAuth window). The connector URL is the SHIM's /mcp.
   When transforming a proxied body, drop content-length/content-encoding/transfer-encoding.
   TEST IT THE WAY THE CLIENT DOES: a self-test that hard-codes the discovery URLs will pass while the
   connector is unusable. Start where the client starts, and instrument the server to see what it
   actually receives.
   The validator in the MCP server is a FOURTH copy — it must stay byte-identical to core.jsx,
   content-api and generate-questions.
   DEPLOYMENT: wire edge-function deploys into CI from day one. Keep the function source in the repo
   AND give the CI a provider access token so a workflow can deploy it. If you instead deploy by
   pasting file contents into a tool call, you WILL eventually paste something truncated over a
   working function — it has happened here — and the repo will silently drift from what is live.
   Whatever the method: after deploying, fetch the deployed copy back and compare, then exercise the
   changed tool over the wire. A successful deploy call is not evidence the tool works.
7. **Activity log:** every mutation recorded (who/what/when) via pm_log.
8. **Developer Notes page:** hardcoded architecture doc + CLAUDE.md + this build prompt,
   each viewable with copy + download, plus an editable scratchpad saved to pm_dev_notes.
   These docs MUST be kept in sync with the app on every subsequent change.
8b. **RESPONSIVE — get this right or the app is broken on a phone.** Decide the DEVICE CLASS on the
   SHORT side of the screen for touch devices (min(w,h)) and on live width only for a resizable
   desktop window. Keying off innerWidth alone is the classic bug: a phone in landscape is 667–932px,
   so it gets treated as a tablet and the whole navigation swaps on rotation. Phone <640 / tablet
   <1024 / desktop. Have the JS stamp the class onto <html> (pm-phone/pm-tablet/pm-desktop/pm-coarse/
   pm-landscape) and make the CSS key off THAT — never run parallel width media queries, they drift.
   ACCESSIBILITY IS NOT OPTIONAL: every form control needs a programmatic label. A control wrapped in
   a <label> gets it implicitly — but a <div>+<span> that merely LOOKS like a label gives nothing. Bare
   filter dropdowns need an explicit aria-label. Icon-only buttons (colour swatches, close buttons)
   need aria-label. Verify by rendering into a real DOM and checking el.labels, not by reading the code.
   CAP THE CONTENT, NOT JUST THE CONTAINER: a max-width on the page wrapper is not enough. A single
   form field or paragraph inside it will fill the whole width — an input the width of the page and a
   line of text ~150 characters long, with dead space beside it. Give forms a readable cap (~860px),
   panels ~720px, and prose ~680px (~75 chars/line). A landscape phone is the worst case: phone
   chrome but ~800px of width, so the portrait single-column rules stretch one field to 812px — give
   landscape two columns.
   Non-negotiable mobile foundations: overflow-x hidden on html/body (one stubborn element shifts the
   whole page); safe-area padding left/right if you use viewport-fit=cover, or landscape content slides
   under the notch; 16px inputs on touch (anything smaller makes iOS auto-zoom on focus); 40px minimum
   hit targets; modals as bottom sheets on phone; single-column forms on phone; overflow-wrap for long
   slugs. Three nav patterns is the maximum: bottom bar + drawer (phone), icon rail (tablet), full
   sidebar (desktop) — and every one must be DERIVED from the nav list so a new page cannot be
   stranded.
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
   BOTH the existence-check query — ids in in.(...) at ~150/request to stay under URL limits — AND
   the upserts at ~200/request), for when concrete per-question rows are wanted to hand-tune. IMPORTANT
   derive nuance: pm_question_levels has NO hidden_mode column, so for a WORD-mode level leave
   letters_hidden/position/grouping null (the level already forces whole-word; pinning a number would
   freeze to the word's current length and break if the word is later edited); only for a LETTERS-mode
   level pin the computed letters_hidden/position/grouping. DELETING a level: there is no FK from
   pm_packs.level / pm_questions.level / pm_question_levels.level to pm_levels, so a BEFORE DELETE
   trigger on pm_levels MUST fix ALL THREE: reset PACKS pinned to the level to the highest REMAINING
   level (a pack's level can't be null — it's the question fallback), un-pin QUESTIONS at that level
   (set level = null), and delete OVERRIDE rows at that level, or you leave stale pointers. Guard the
   delete UI so only the highest level is removable and disable the "Add level" control at the 100
   ceiling. STATE: the Levels page must use the app's shared levels state (the same realtime-backed
   source the pack/generator views use) rather than its own fetch, so an edit on one device refreshes
   every view consistently. Validate min<=max word length client-side before the DB CHECK. The CMS
   "edited" indicator must treat a lone
   enabled=true override as a no-op (not edited).
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
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>Reference documentation and a shared scratchpad for this project.</p>
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
  // Chunk the id list so a large pack doesn't blow past URL-length limits.
  overridesForPackLevel: async (questionIds, level) => {
    const out = [];
    for (let i = 0; i < questionIds.length; i += 150) {
      const list = questionIds.slice(i, i + 150).join(",");
      if (!list) continue;
      const r = await rest(`pm_question_levels?level=eq.${level}&question_id=in.(${list})&select=question_id&limit=10000`);
      out.push(...(r.data || []));
    }
    return out;
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
function LevelsView({ levels: levelsProp, reload: reloadProp }) {
  // Prefer the shell's shared levels state (kept fresh via the pm_levels realtime subscription) so
  // this page never diverges from what PackDetail/Generator see. Fall back to a local fetch only if
  // rendered standalone without props. (useAsync always runs its fn, so when props are supplied the
  // fn returns them directly instead of hitting the network.)
  const usingShared = Array.isArray(levelsProp);
  const local = useAsync(() => usingShared ? Promise.resolve(levelsProp) : db_levels.list(), [usingShared]);
  const loading = usingShared ? false : local.loading;
  const error = usingShared ? null : local.error;
  const levels = usingShared ? levelsProp : (local.data || []);
  const reload = usingShared ? (reloadProp || (() => {})) : local.reload;
  const [edit, setEdit] = useState(null);      // an existing level being edited
  const [creating, setCreating] = useState(null); // a new (unsaved) level draft
  if (error) return <ErrorState error={error} onRetry={reload} />;
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
          <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>The game's progression structure. Each level defines how words are hidden, which words to use, and its theme. Add levels above the current top to extend the ladder.</p>
        </div>
        <Btn onClick={startCreate} disabled={nextLevel > 100} title={nextLevel > 100 ? "Maximum of 100 levels reached" : ""}>+ Add level {nextLevel <= 100 ? nextLevel : ""}</Btn>
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
      const minV = f.min_word_len === "" || f.min_word_len == null ? null : parseInt(f.min_word_len);
      const maxV = f.max_word_len === "" || f.max_word_len == null ? null : parseInt(f.max_word_len);
      if (minV != null && maxV != null && minV > maxV) {
        setBusy(false);
        notify("Min word length can't be greater than max word length.", "error");
        return;
      }
      await onSave(level.level, {
        name: f.name, tagline: f.tagline, letters_rule: f.letters_rule, word_rule: f.word_rule,
        theme: f.theme, age_hint: f.age_hint, hidden_mode: f.hidden_mode,
        letters_hidden_default: f.letters_hidden_default, letter_position: f.letter_position,
        letter_grouping: f.letter_grouping, color: f.color,
        min_word_len: minV, max_word_len: maxV,
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
              <button key={c} onClick={() => set("color", c)}
                aria-label={`Use colour ${c}`} title={c}
                aria-pressed={f.color === c}
                style={{ width: 30, height: 30, borderRadius: R.sm, cursor: "pointer", background: c, border: "3px solid " + (f.color === c ? C.ink : "transparent") }} />
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

  // Array.isArray, not `|| []` — the latter only catches null/undefined. If this prop ever arrives
  // as an object (a shape change upstream), .filter() throws and the whole page goes white.
  const activeQs = (Array.isArray(questions) ? questions : []).filter(q => q.status === "active");
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
      const isWordLevel = lvlDef.hidden_mode === "word";
      // Build override rows. For a LETTERS level we pin the computed letter count/position/grouping
      // so the row is concrete and editable. For a WORD level we intentionally leave letters_hidden
      // null (the level already forces whole-word); pinning a fixed number would freeze to the
      // word's current length and silently break if the word is later edited. template/answer/alt
      // stay null so the concept's own text still flows through.
      const rows = targets.map(q => {
        const v = buildLevelVariants(q, [lvlDef], {})[0];
        return {
          question_id: q.id, level: targetLevel,
          template: null, answer: null, alt_answer: null,
          letters_hidden: isWordLevel ? null : (v?.letters ?? lvlDef.letters_hidden_default ?? 1),
          letter_position: isWordLevel ? null : (lvlDef.letter_position || null),
          letter_grouping: isWordLevel ? null : (lvlDef.letter_grouping || null),
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

// ===== aireview.jsx =====
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

// ===== aisettings.jsx =====
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

// ===== connector.jsx =====
// ============================================================
// Claude Connector — let partners write content by talking to Claude.
//
// A partner adds this CMS as a connector in their own Claude account, then simply says
// "write 15 questions for Calmness about bedtime worries". Claude reads the pack, checks its own
// drafts against the real game engine, and sends them to the AI Review queue.
//
// WHY THIS IS SAFE, and it matters more than any permission check:
//   A partner CANNOT reach a child. pm_review_approve is the only path into live content and it
//   requires a human to press Approve. The worst a partner can do — even a compromised one — is
//   fill the review queue with things you reject. That is the entire blast radius.
//   Partners CAN (since Aug 2026) create/rename packs and preview, edit or reject items still
//   WAITING in the queue — all pre-approval, so none of it can reach a child. There is deliberately
//   no tool to APPROVE anything, and none to delete a pack or touch a live question.
//
// TOKENS: shown ONCE at creation, then only ever stored as a sha256 hash. Not even an authenticated
// admin can read them back from the browser (verified: the table has RLS on and zero policies).
// ============================================================

// The connector URL a partner pastes into Claude. This is the Cloudflare Worker "discovery shim"
// (positive-minds-mcp.…workers.dev/mcp), NOT the Supabase function directly: Claude's custom-connector
// OAuth discovery probes the origin ROOT for /.well-known/* metadata, which a Supabase edge function
// (served under /functions/v1/…) cannot provide, so a bare Supabase URL connects but shows no tools.
// The shim serves that metadata at its root and proxies everything else to the unchanged MCP function.
const MCP_URL = "https://positive-minds-mcp.alcharles1980.workers.dev/mcp";

const db_mcp = {
  list: () => rpc("pm_mcp_list_tokens"),
  issue: (partner) => rpc("pm_mcp_issue_token", { p_partner: partner }),
  revoke: (id) => rpc("pm_mcp_revoke_token", { p_id: id }),
};

function ConnectorView() {
  const { loading, error, data, reload } = useAsync(() => db_mcp.list(), []);
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState(null);   // the one-time reveal
  const [copiedUrl, setCopiedUrl] = useState(false);

  const tokens = data || [];
  const active = tokens.filter(t => t.active);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 1800);
      notify("Connector URL copied");
    } catch { notify("Couldn't copy — select and copy manually", "error"); }
  };

  const revoke = async (t) => {
    const ok = await confirmDialog({
      title: `Revoke ${t.partner}'s access?`,
      body: "Their Claude connector will stop working immediately. Anything they've already sent for review stays in the queue.",
      confirmText: "Revoke", tone: "danger",
    });
    if (!ok) return;
    try { await db_mcp.revoke(t.id); await reload(); notify(`${t.partner}'s access revoked`); }
    catch (e) { notify(friendlyError(0, String(e?.message || e)), "error"); }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Claude Connector</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5, lineHeight: 1.55 }}>
          Let a partner write content just by talking to Claude. Everything they produce comes to you
          for approval first — they can't publish anything.
        </p>
      </div>

      {/* What a partner can and cannot do. Say it plainly — this is the whole security story.
          KEEP THIS HONEST: it must match the tools the mcp function actually exposes. */}
      <div className="pm-readable" style={{ background: C.brandSoft, borderRadius: R.lg, padding: "14px 17px",
        marginBottom: S.lg, fontSize: 13.5, color: C.brandInk, lineHeight: 1.65 }}>
        <b>A partner can never put a question in front of a child.</b> They can read your packs, propose
        questions to <b>AI Review</b>, create and rename packs, and preview, edit or reject items that are
        still <i>waiting</i> in the queue. They <b>cannot approve anything</b> — approving is only possible
        here in the CMS, and it stays the only route into live content. They also cannot delete a pack or
        touch a question that's already live. The worst they can do is fill your review queue with things
        you then reject.
      </div>

      {/* The URL partners need */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.lg }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Connector URL</div>
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ flex: "1 1 300px", fontSize: 12.5, fontFamily: "ui-monospace, monospace",
            background: C.bg, padding: "9px 12px", borderRadius: R.sm, color: C.ink2,
            overflowWrap: "anywhere", border: "1px solid " + C.line }}>{MCP_URL}</code>
          <Btn size="sm" variant="soft" onClick={copyUrl} icon={copiedUrl ? "✓" : "⧉"}>
            {copiedUrl ? "Copied" : "Copy"}
          </Btn>
        </div>
        <div style={{ fontSize: 12, color: C.faint, marginTop: 7, lineHeight: 1.5 }}>
          The same for everyone. What identifies a partner is their token.
        </div>
      </div>

      {/* Partners */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: S.md, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.ink }}>Partners</h2>
        {active.length > 0 && <Pill tone="muted">{active.length} with access</Pill>}
        <div style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => setAdding(true)}>Add a partner</Btn>
      </div>

      {loading ? (
        <div style={{ display: "grid", gap: 10 }}>{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} h={74} r={12} />)}</div>
      ) : tokens.length === 0 ? (
        <EmptyState
          icon="◇"
          title="No partners yet"
          body="Add one and you'll get a token to send them. They paste it into Claude, and can start writing straight away."
        />
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {tokens.map(t => (
            <div key={t.id} style={{ background: C.panel, borderRadius: R.lg, padding: S.lg,
              border: "1px solid " + C.line,
              borderLeft: "4px solid " + (t.active ? C.ok : C.faint),
              opacity: t.active ? 1 : 0.62 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: S.md, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15.5, fontWeight: 800, color: C.ink }}>{t.partner}</span>
                    {!t.active && <Pill tone="muted">Revoked</Pill>}
                  </div>
                  <div style={{ fontSize: 12.5, color: C.sub, marginTop: 4, lineHeight: 1.6 }}>
                    {t.last_used_at
                      ? <>Last used {relativeTime(t.last_used_at)} · {t.calls_made} call{t.calls_made === 1 ? "" : "s"}</>
                      : <span style={{ color: C.faint }}>Hasn't connected yet</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>
                    Added {relativeTime(t.created_at)}
                  </div>
                </div>
                {t.active && (
                  <button onClick={() => revoke(t)}
                    style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 13px", borderRadius: 8, cursor: "pointer",
                      border: "1px solid " + C.line, background: "transparent", color: C.danger }}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* How it works for them */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg,
        padding: S.lg, marginTop: S.xl }} className="pm-readable">
        <h2 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 800, color: C.ink }}>What your partner does</h2>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: C.ink2, lineHeight: 1.85 }}>
          <li>On a computer — <b>claude.ai (web) or the desktop app</b>, not the phone app — go to
            <b> Settings → Connectors → Add custom connector</b>. (Once added there it appears on their phone too.)</li>
          <li>They paste <b>just the URL</b> above and click Add. (Nothing goes in the OAuth boxes.)</li>
          <li>They click <b>Connect</b>. A Positive Minds sign-in page opens — they paste their token there.</li>
          <li>Then they simply talk to it: <i>"Write me 15 questions for the Calmness pack about worries at bedtime."</i></li>
          <li>They can also ask it to <b>show how a question looks to a child</b> at each level, start a <b>new pack</b>, or go through what's <b>waiting in review</b> and fix or reject items. Approving stays with you, here.</li>
        </ol>
        <div style={{ fontSize: 13, color: C.sub, marginTop: 12, lineHeight: 1.65, paddingTop: 12, borderTop: "1px solid " + C.lineSoft }}>
          Behind the scenes, Claude reads the pack so it doesn't repeat words you've already used,
          checks its own drafts against the real game engine — including whether the two words are the
          same length, which would give the child two correct answers — fixes anything it got wrong,
          and only then sends them to you. <b>You'll see them in AI Review, tagged with who wrote them.</b>
        </div>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} width={480}>
        {adding && (
          <AddPartner
            onClose={() => setAdding(false)}
            onIssued={async (result) => { setAdding(false); setIssued(result); await reload(); }}
          />
        )}
      </Modal>

      <Modal open={issued !== null} onClose={() => setIssued(null)} width={540}>
        {issued && <TokenReveal result={issued} onClose={() => setIssued(null)} />}
      </Modal>
    </div>
  );
}

function AddPartner({ onClose, onIssued }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n) { notify("Give them a name — you'll want to know whose work you're reviewing", "error"); return; }
    setBusy(true);
    try {
      const res = await db_mcp.issue(n);
      onIssued(res);
    } catch (e) {
      setBusy(false);
      notify(friendlyError(0, String(e?.message || e)), "error");
    }
  };

  return (
    <>
      <ModalHead title="Add a partner" subtitle="They'll get a token to paste into Claude" />
      <div style={{ padding: S.xl, display: "grid", gap: S.md }}>
        <Field label="Their name" hint="Shown against every question they send, so you know whose work you're reviewing">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            placeholder="e.g. Sarah" onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
        <div style={{ fontSize: 12.5, color: C.faint, lineHeight: 1.55 }}>
          You'll see the token once, on the next screen. It isn't stored, so it can't be shown again —
          if they lose it, just add them afresh.
        </div>
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create token"}</Btn>
      </ModalFoot>
    </>
  );
}

// The one-time reveal. This is the ONLY moment the raw token exists anywhere — we store a hash, so
// it genuinely cannot be shown again. Say so plainly rather than letting them find out later.
function TokenReveal({ result, onClose }) {
  const [copied, setCopied] = useState(false);
  const token = result?.token || "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
      notify("Token copied");
    } catch { notify("Couldn't copy — select the text and copy it manually", "error"); }
  };

  return (
    <>
      <ModalHead title={`${result.partner}'s token`} subtitle="Copy it now — you won't see it again" />
      <div style={{ padding: S.xl, display: "grid", gap: S.md }}>
        <div style={{ background: C.warn + "12", border: "1px solid " + C.warn + "44", borderRadius: R.md,
          padding: "11px 14px", fontSize: 13, color: C.ink2, lineHeight: 1.6 }}>
          <b style={{ color: C.warn }}>This is the only time you'll see this.</b> We store it as a
          one-way hash, so it genuinely can't be recovered — not by you, not by anyone. Send it to{" "}
          {result.partner} now. If it's lost, just add them again.
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Token</div>
          <div style={{ display: "flex", gap: 9, alignItems: "stretch", flexWrap: "wrap" }}>
            <code style={{ flex: "1 1 260px", fontSize: 13, fontFamily: "ui-monospace, monospace",
              background: C.bg, padding: "12px 14px", borderRadius: R.sm, color: C.ink,
              border: "1px solid " + C.line, overflowWrap: "anywhere", userSelect: "all" }}>{token}</code>
            <Btn onClick={copy} icon={copied ? "✓" : "⧉"}>{copied ? "Copied" : "Copy"}</Btn>
          </div>
        </div>

        <div style={{ background: C.bg, borderRadius: R.md, padding: "12px 15px" }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: C.faint, letterSpacing: .3,
            textTransform: "uppercase", marginBottom: 7 }}>Send them this</div>
          <div style={{ fontSize: 13, color: C.ink2, lineHeight: 1.75 }}>
            1. On a computer (<b>claude.ai web or desktop app — not the phone</b>): <b>Settings → Connectors → Add custom connector</b><br />
            2. Paste this URL and click Add:<br />
            <code style={{ fontSize: 11.5, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{MCP_URL}</code><br />
            3. Click <b>Connect</b> — a sign-in page opens.<br />
            4. Paste the token above into it. (The connector then works on their phone too.)
          </div>
        </div>
      </div>
      <ModalFoot>
        <Btn onClick={onClose}>Done — I've copied it</Btn>
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
  // HOW to run it. The options are identical either way — the method must not change what you're
  // allowed to ask for. (Previously the API path lived in Settings as a stripped-down panel with no
  // themes and no frame words: a poor relation of the manual one, for no good reason.)
  const [method, setMethod] = useState("prompt");

  // Is an API key actually usable? If not, the API option is offered but disabled with a reason,
  // rather than silently failing when you press Generate.
  const keyState = useAsync(() => rpc("pm_ai_status").catch(() => []), []);
  const providers = keyState.data || [];
  const settingsState = useAsync(() => rest("pm_ai_settings?id=eq.1&limit=1").then(r => (r.data || [])[0] || null), []);
  const activeProvider = settingsState.data?.active_provider || "anthropic";
  const active = providers.find(p => p.provider === activeProvider);
  const keyReady = !!(active?.configured && active?.enabled !== false);

  // Default to whichever method can actually run — but ONCE, and never after the user has chosen.
  // (Without the ref this is only correct by accident: it works because keyReady happens not to
  // change again. If it ever did — a key added in another tab, a realtime refresh — the effect would
  // yank the user out of the mode they deliberately picked.)
  const methodChosen = useRef(false);
  useEffect(() => {
    if (!methodChosen.current && keyReady) setMethod("api");
  }, [keyReady]);
  const chooseMethod = (m) => { methodChosen.current = true; setMethod(m); };

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

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

  // Run it through the API. Uses the SAME options as the prompt path — that is the whole point.
  const runApi = async () => {
    if (!packId) { notify("Pick a pack first", "error"); return; }
    setRunning(true); setResult(null);
    try {
      const res = await callFn("generate-questions", {
        pack_id: packId,
        // The API takes ONE target level. If several are ticked, use the lowest — the level system
        // renders every other level from the same question anyway, so nothing is lost.
        target_level: selectedLevels.length ? Math.min(...selectedLevels) : null,
        count: Math.min(30, Math.max(1, parseInt(count) || 10)),
        notes: extraNotes.trim(),
        themes: themes.trim(),
        with_frames: !!withFrames,
      });
      if (res?.error === "rate_limited") { notify(res.message || "Rate limit reached", "error"); return; }
      if (res?.error === "no_key") { notify("No API key saved — add one in AI Settings", "error"); return; }
      if (res?.error === "provider_disabled") { notify(res.message || "That provider is turned off", "error"); return; }
      if (res?.error) throw new Error(res.message || res.error);
      setResult(res);
      notify(res.message || "Queued for review");
    } catch (e) {
      notify(friendlyError(0, String(e?.message || e)), "error");
    } finally { setRunning(false); }
  };

  const copyPrompt = async () => {    try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1800); notify("Prompt copied"); }
    catch { notify("Couldn't copy — select and copy manually", { kind: "error" }); }
  };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Generate questions</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5, lineHeight: 1.5 }}>
          Describe what you want, then either let your own AI key write it, or copy a prompt to paste
          into any AI tool. Either way it lands in <b>AI Review</b> for your approval first.
        </p>
      </div>

      {/* HOW to run it. The options below are the SAME either way — the method should not change
          what you're allowed to ask for. (Before this, API generation was a stripped-down panel
          buried in Settings, missing themes and frame words entirely.) */}
      <div className="pm-readable" style={{ display: "flex", gap: 10, marginBottom: S.lg, flexWrap: "wrap" }}>
        {[
          { id: "api", title: "Use my API key", sub: keyReady ? "Writes them for you, straight into review" : "No key saved yet", icon: "⚡", disabled: !keyReady },
          { id: "prompt", title: "Copy a prompt", sub: "Paste into ChatGPT, Claude, anything", icon: "⎘", disabled: false },
        ].map(m => {
          const on = method === m.id;
          return (
            <button key={m.id} onClick={() => !m.disabled && chooseMethod(m.id)} disabled={m.disabled}
              aria-pressed={on} aria-label={`${m.title} — ${m.sub}`}
              style={{ flex: "1 1 240px", textAlign: "left", padding: "13px 16px", borderRadius: R.lg,
                cursor: m.disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
                border: "2px solid " + (on ? C.brand : C.line),
                background: on ? C.brandSoft : C.panel,
                opacity: m.disabled ? 0.55 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontSize: 17 }}>{m.icon}</span>
                <span style={{ fontSize: 14.5, fontWeight: 800, color: on ? C.brandInk : C.ink }}>{m.title}</span>
              </div>
              <div style={{ fontSize: 12.5, color: on ? C.brandInk : C.sub, marginTop: 3, opacity: .85 }}>{m.sub}</div>
            </button>
          );
        })}
      </div>

      {method === "api" && !keyReady && (
        <div className="pm-readable" style={{ background: C.warn + "12", border: "1px solid " + C.warn + "44",
          borderRadius: R.md, padding: "11px 14px", marginBottom: S.lg, fontSize: 13, color: C.ink2, lineHeight: 1.55 }}>
          You haven't saved an API key yet, so this option can't run. Add one in <b>AI Settings</b> — or
          use <b>Copy a prompt</b>, which works with any AI tool and needs no key.
        </div>
      )}

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

            {/* "Output format" only means something for the copy-a-prompt path — the API always
                returns structured JSON. Showing it in API mode would be a control that does nothing. */}
            <div className={method === "prompt" ? "pm-form-2" : ""}>
              <Field label="How many">
                <Input type="number" min={1} max={100} value={count} aria-label="How many questions" onChange={(e) => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))} />
              </Field>
              {method === "prompt" && (
                <Field label="Output format" hint={OUTPUT_FORMATS[format]?.hint}>
                  <Select value={format} onChange={(e) => setFormat(e.target.value)}>
                    {Object.entries(OUTPUT_FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </Select>
                </Field>
              )}
            </div>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
              <input type="checkbox" checked={withFrames} onChange={(e) => setWithFrames(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include frame-word variations
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Teach the AI the swappable {"{token}"} system so higher levels can differ.</div>
              </span>
            </label>

            {method === "prompt" && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include background context
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Prepend a short "why this matters" so the AI writes on-model. (Full doc below.)</div>
              </span>
            </label>
            )}

            {method === "prompt" && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: pack ? "pointer" : "not-allowed", opacity: pack ? 1 : 0.55 }}>
              <input type="checkbox" checked={avoidExisting} disabled={!pack} onChange={(e) => setAvoidExisting(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Avoid existing questions
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>
                  {!pack ? "Pick a pack first." : loadingQs ? "Loading this pack's questions…" : `Tell the AI not to repeat the ${existingQuestions.length} question${existingQuestions.length === 1 ? "" : "s"} already in this pack.`}
                </div>
              </span>
            </label>
            )}

            {method === "api" && (
              <div style={{ fontSize: 12.5, color: C.faint, lineHeight: 1.55, paddingTop: 2 }}>
                The API route always avoids words already used and always writes on-model — no need to
                ask for either.
              </div>
            )}

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
                <Textarea readOnly value={MASTER_CONTEXT} rows={12} aria-label="Master context (read only)" onFocus={(e) => e.target.select()}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.55, background: C.bg, resize: "vertical" }} />
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN — this is the ONLY part that differs by method. */}
        {method === "api" ? (
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg,
            padding: S.lg, position: "sticky", top: S.lg, display: "grid", gap: S.md }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Generate with your API key</div>
              <div style={{ fontSize: 13, color: C.sub, marginTop: 3, lineHeight: 1.55 }}>
                {active ? <>Using <b>{active.model || activeProvider}</b>.</> : null} Each question is checked
                against the real game engine, then waits in <b>AI Review</b> for you to approve.
              </div>
            </div>

            {/* A plain summary of what is about to happen — no surprises. */}
            <div style={{ background: C.bg, borderRadius: R.md, padding: "12px 14px", fontSize: 13, color: C.ink2, lineHeight: 1.7 }}>
              <div><b>{count}</b> question{count === 1 ? "" : "s"}</div>
              <div>for <b>{pack ? `${pack.emoji || ""} ${pack.name}` : "— pick a pack"}</b></div>
              <div>at <b>{selectedLevels.length ? `level${selectedLevels.length > 1 ? "s" : ""} ${selectedLevels.join(", ")}` : `the pack's level`}</b></div>
              {themes.trim() && <div>on <b>{themes.trim()}</b></div>}
              {withFrames && <div>with frame words</div>}
            </div>

            <Btn onClick={runApi} disabled={running || !packId || !keyReady}>
              {running ? "Generating…" : `Generate ${count} question${count === 1 ? "" : "s"}`}
            </Btn>

            {result && (
              <>
                <div style={{ background: C.ok + "10", border: "1px solid " + C.ok + "44", borderRadius: R.md,
                  padding: "12px 14px", fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
                  <b>{result.generated}</b> question{result.generated === 1 ? "" : "s"} queued —{" "}
                  <b style={{ color: C.ok }}>{result.clean}</b> passed every check
                  {result.flagged > 0 && <> · <b style={{ color: C.danger }}>{result.flagged}</b> flagged</>}
                  {result.repaired > 0 && <> · {result.repaired} auto-fixed</>}.
                  <div style={{ marginTop: 6 }}>Go to <b>AI Review</b> to approve them.</div>
                </div>
                {result.warning && (
                  <div style={{ background: C.warn + "12", border: "1px solid " + C.warn + "44", borderRadius: R.md,
                    padding: "11px 14px", fontSize: 12.5, color: C.ink2, lineHeight: 1.55 }}>
                    <b style={{ color: C.warn }}>Heads up.</b> {result.warning}
                  </div>
                )}
              </>
            )}

            <div style={{ fontSize: 12, color: C.faint, lineHeight: 1.5 }}>
              Nothing reaches a pack until you approve it. Model, temperature and spend limits are in{" "}
              <b>AI Settings</b>.
            </div>
          </div>
        ) : (
        /* Prompt output */
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden", position: "sticky", top: S.lg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: `${S.md}px ${S.lg}px`, borderBottom: "1px solid " + C.line }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Generated prompt</span>
            <span style={{ fontSize: 12, color: C.faint }}>{prompt.length.toLocaleString()} chars</span>
            <div style={{ flex: 1 }} />
            <Btn size="sm" onClick={copyPrompt} icon={copied ? "✓" : "⧉"}>{copied ? "Copied" : "Copy"}</Btn>
          </div>
          <Textarea readOnly value={prompt} rows={22} aria-label="Generated prompt (read only)"
            onFocus={(e) => e.target.select()}
            style={{ border: "none", borderRadius: 0, fontFamily: "ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.55, resize: "vertical", background: C.bg }} />
          <div style={{ padding: `${S.sm + 2}px ${S.lg}px`, borderTop: "1px solid " + C.line, fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
            Paste this into your AI tool, then bring the result back via <b>a pack → Import</b>{format === "table" ? " (convert the table to pipe/JSON first)" : ""}.
          </div>
        </div>
        )}
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

// ===== sysarch.jsx =====
// System Architecture — an at-a-glance reference of the three services this project runs on,
// with the live links, IDs, and dashboards for each. Reference-only page (no writes).
//
// SECURITY: this page shows IDENTIFIERS and DASHBOARD LINKS only — never secrets. The CMS is a
// shared-admin browser app, so anything rendered here is visible to anyone with the admin login.
// IDs and dashboard URLs are safe (they still require separate authentication to actually use);
// credentials (service-role key, Cloudflare API token, DB password, provider API keys) must NEVER
// be placed on this page. They live only in GitHub Actions secrets and each service's own console.

// The self-contained prompt a content contributor pastes into a FRESH Claude chat (which has no
// memory of this project). It never contains a token or any secret — only instructions. Everything
// concrete (pack names, counts, existing questions) is fetched from the connector at run time, so
// this text never goes stale. Kept as a template literal so it copies out verbatim.
const CONTRIB_PROMPT = `You're helping me write content for **Positive Minds**, a therapeutic spelling game for children (roughly ages 5–12). I've connected you to it through a tool connector in this chat — you'll see tools called list_packs, get_pack_content, check_questions and propose_questions.

HOW THE GAME WORKS (this is a SPELLING puzzle, not a meaning one):
A short, warm, first-person sentence appears with one word partly hidden, e.g. "I feel PR_UD when I try." The child is shown TWO words and picks the one whose spelling fits the blank.

TWO RULES THAT NEVER BEND:
1. BOTH words are always POSITIVE. Never put a negative word about a child in front of them. (This is therapy content — "KIND / MEAN" is forbidden; MEAN must never appear.)
2. The two words MUST be DIFFERENT LENGTHS. At higher levels the whole word is hidden, so length is the only clue — two same-length words would both fit and the puzzle breaks. E.g. PROUD (5) / CALM (4) is good; BRIGHT (6) / GENTLE (6) is broken.

WHAT I'D LIKE YOU TO DO:
1. Start by calling **list_packs**. It returns a full brief plus every pack and how full each one is (how many questions it has, how many distinct words, how many are already awaiting review).
2. Show me the packs as a **numbered list with those stats**, and ask me which ONE I'd like to add to. Wait for my answer — don't pick for me. If I want to write about a theme that doesn't exist yet, you can make a new pack with **create_pack** (and **update_pack** edits a pack's details). A new pack appears in the CMS straight away — its questions still go to the review queue like everything else.
3. Once I choose, call **get_pack_content** for that pack. Show me its current statistics and a sense of what's already in it. Then we'll write new questions together for that pack.
4. Before proposing anything, ALWAYS call **check_questions** on our drafts. It checks them against the real game engine AND the pack's existing content, so we never send a duplicate or a broken puzzle. Fix anything it flags, then check again.
5. Before proposing, call **preview_questions** and then build me a little interactive card I can actually play — the sentence, tabs to switch level, and the two words as buttons that go green or red when I tap. Don't tell me which is right until I tap. That's how I judge whether the words are right, not just valid — that's how I judge whether the words are right, not just valid. Then when they're clean, call **propose_questions**. That sends them to a human review queue — nothing goes live on its own; a person approves, edits or rejects every one.
6. If I ask about progress or what's pending, call **review_status** — it shows everything across all contributors. To go through the pending queue with me, call **preview_questions** (it gives each item's id): I can then reject any with **reject_questions**, or fix one with **edit_queued_question**. Approving happens in the CMS, not here.

Keep sentences warm, simple and first-person ("I am…", "I feel…"). Prefer fresh words and sentences for variety, but the only hard repetition rule is: don't reproduce an existing question exactly (same sentence AND the same two words).

Start now by calling list_packs and showing me the packs to choose from.`;

// A copyable multi-line prompt block (mirrors ArchRow's copy affordance, sized for a paragraph).
function PromptBlock({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div style={{ border: "1px solid " + C.line, borderRadius: R.md, overflow: "hidden", background: C.bgDeep }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid " + C.lineSoft, background: C.bg }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 }}>Paste into a fresh Claude chat</span>
        <button onClick={copy} title="Copy prompt"
          style={{ background: copied ? C.goodSoft : C.brand, border: "none", borderRadius: R.sm, color: copied ? C.goodInk : "#fff", fontSize: 12, fontWeight: 800, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}>
          {copied ? "✓ Copied" : "Copy prompt"}
        </button>
      </div>
      <pre style={{ margin: 0, padding: "14px 16px", fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12, lineHeight: 1.65, color: C.ink2, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 340, overflowY: "auto" }}>{text}</pre>
    </div>
  );
}

// A single copyable coordinate row.
function ArchRow({ label, value, href, mono = true, hint }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!value) return;
    navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const missing = !value;
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: S.md, padding: S.md + "px 0", borderBottom: "1px solid " + C.lineSoft }}>
      <div style={{ flex: "0 0 148px", fontSize: 12.5, fontWeight: 700, color: C.sub, paddingTop: 2 }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {missing ? (
          <span style={{ fontSize: 13.5, color: C.warnInk, background: C.warnSoft, padding: "3px 9px", borderRadius: R.sm, fontWeight: 600 }}>
            ⚠ fill this in
          </span>
        ) : href ? (
          <a href={href} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: mono ? "ui-monospace,Menlo,monospace" : "inherit", fontSize: 13.5, color: C.brand, wordBreak: "break-all", textDecoration: "none", fontWeight: 600 }}>
            {value}
          </a>
        ) : (
          <span style={{ fontFamily: mono ? "ui-monospace,Menlo,monospace" : "inherit", fontSize: 13.5, color: C.ink2, wordBreak: "break-all" }}>{value}</span>
        )}
        {hint && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 3 }}>{hint}</div>}
      </div>
      {!missing && (
        <button onClick={copy} title="Copy"
          style={{ flex: "0 0 auto", background: copied ? C.goodSoft : C.bgDeep, border: "1px solid " + C.line, borderRadius: R.sm, color: copied ? C.goodInk : C.sub, fontSize: 11.5, fontWeight: 700, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit" }}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

function ArchCard({ icon, title, accent, tagline, children }) {
  return (
    <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden", marginBottom: S.lg }}>
      <div style={{ display: "flex", alignItems: "center", gap: S.md, padding: S.lg, borderBottom: "1px solid " + C.line, background: accent }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 16.5, fontWeight: 800, color: C.ink, letterSpacing: -0.2 }}>{title}</div>
          <div style={{ fontSize: 12.5, color: C.sub, marginTop: 1 }}>{tagline}</div>
        </div>
      </div>
      <div style={{ padding: "2px " + S.lg + "px " + S.md + "px" }}>{children}</div>
    </div>
  );
}

// Per-service "how to get access and connect" block, rendered inside a card below its coordinates.
function AccessNote({ children }) {
  return (
    <div style={{ marginTop: S.md, background: C.bgDeep, border: "1px solid " + C.lineSoft, borderRadius: R.md, padding: S.md + "px " + S.lg + "px" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: C.brandInk, marginBottom: 6 }}>🔑 Access &amp; connect</div>
      <div className="pm-prose" style={{ fontSize: 12.8, color: C.ink2, lineHeight: 1.65 }}>{children}</div>
    </div>
  );
}

// A single numbered step in the partner quick-start. Big number, title, body, optional inline extra
// (a copyable row, a prompt block, a callout).
function Step({ n, title, children, extra }) {
  return (
    <div style={{ display: "flex", gap: S.md, alignItems: "flex-start" }}>
      <div style={{ flex: "0 0 auto", width: 30, height: 30, borderRadius: 999, background: C.brand, color: "#fff",
        fontSize: 15, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{n}</div>
      <div style={{ flex: 1, minWidth: 0, paddingBottom: S.md }}>
        <div style={{ fontSize: 14.5, fontWeight: 800, color: C.ink, marginBottom: 3 }}>{title}</div>
        <div className="pm-prose" style={{ fontSize: 13, color: C.ink2, lineHeight: 1.65 }}>{children}</div>
        {extra && <div style={{ marginTop: S.sm }}>{extra}</div>}
      </div>
    </div>
  );
}

function SystemArchitectureView() {
  const SB_REF = "tytrmjjucqijzcrbwjfm";
  const GH = "https://github.com/alcharles1980-design/positive-minds-cms";
  const CF_URL = "https://positive-minds-cms.alcharles1980.workers.dev";
  const CF_WORKER_ID = "95a06f3cafaa40908af725ab5347695e";
  const CF_ACCOUNT_ID = "bdb27846cbf6226edde4fa0f6d530ffa";  // Cloudflare dashboard → Workers & Pages → Account ID (also the CLOUDFLARE_ACCOUNT_ID GH Actions secret)
  const SB_URL = "https://" + SB_REF + ".supabase.co";
  const SB_DASH = "https://supabase.com/dashboard/project/" + SB_REF;
  const SB_DB_HOST = "db." + SB_REF + ".supabase.co";
  const SB_FUNCS = SB_URL + "/functions/v1";
  // The MCP connector URL partners paste into Claude. This is the Cloudflare Worker "discovery shim"
  // (positive-minds-mcp.…workers.dev), NOT the Supabase function directly — Claude's custom-connector
  // OAuth discovery probes the origin root for /.well-known/* metadata, which a Supabase edge function
  // (served under /functions/v1/…) cannot provide. The shim serves that metadata at its root and
  // proxies everything else to the unchanged Supabase MCP function.
  const MCP_CONNECTOR = "https://positive-minds-mcp.alcharles1980.workers.dev/mcp";

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>System architecture</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5 }}>
          Everything you need to connect Claude and start writing questions — step by step below. Technical service
          details (GitHub, Cloudflare, Supabase) follow underneath, for developers.
        </p>
      </div>

      {/* ============ PARTNER QUICK-START — the main event ============ */}
      <div style={{ background: C.panel, border: "2px solid " + C.brand, borderRadius: R.lg, overflow: "hidden", marginBottom: S.xl }}>
        <div style={{ padding: S.lg, borderBottom: "1px solid " + C.line, background: C.brandSoft }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.brandInk, letterSpacing: -0.2 }}>✍️ Write questions with Claude — start here</div>
          <div style={{ fontSize: 13, color: C.sub, marginTop: 3 }}>
            Six steps, about five minutes. You'll make your own access token, connect it to your own Claude, and start
            proposing questions. Everything you propose goes to a review queue first — nothing goes live on its own.
          </div>
        </div>
        <div style={{ padding: S.lg + "px " + S.lg + "px " + S.sm + "px" }}>

          <Step n={1} title="Sign in to this CMS">
            You're already here, so you're in. If you ever need to sign in again, use the <strong>username and password
            Albert sent you</strong> (they're shared privately — never shown on this page). That login is what lets you
            make your own token in the next step.
          </Step>

          <Step n={2} title="Make your access token"
            extra={
              <div style={{ background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.sm, padding: S.sm + "px " + S.md + "px", fontSize: 12, color: C.warnInk, lineHeight: 1.55 }}>
                <strong>Copy the token the moment it appears</strong> — it's shown only once and can't be recovered. If you
                lose it, just make another. Keep it private; it's a key, like a password.
              </div>
            }>
            Open the <strong>Claude Connector</strong> page (◇ in the left menu). Type <strong>your own name</strong> in the
            box (e.g. "Sarah") and click <strong>Create token</strong>. You'll get a <code>pmk_…</code> token — your name
            on it is how Albert can tell your proposals apart in review.
          </Step>

          <Step n={3} title="Add the connector to your Claude"
            extra={<ArchRow label="Connector URL" value={MCP_CONNECTOR} href={MCP_CONNECTOR} hint="Copy this — it's the address your Claude connects to." />}>
            <strong>Do this on a computer (claude.ai web or the desktop app) — you can't add a custom connector
            from the phone app.</strong> Once added there, it shows up on your phone automatically. Go to
            <strong> Settings → Connectors → Add custom connector</strong>, name it "Positive Minds", and paste the
            <strong> Connector URL</strong> below. Save it.
          </Step>

          <Step n={4} title="Sign in with your token">
            Start a new chat and turn the Positive Minds connector on. Click <strong>Connect</strong> — Claude opens a
            small <strong>Connect to Positive Minds</strong> sign-in screen. Paste your <code>pmk_…</code> token there and
            continue. (Claude handles the rest of the security handshake automatically; there are no codes to copy.) You
            only do this once per Claude.
          </Step>

          <Step n={5} title="Paste the starter prompt"
            extra={<PromptBlock text={CONTRIB_PROMPT} />}>
            Your chat has no idea what this project is yet, so paste the block below into it. It tells Claude everything —
            the game, the rules, and the exact steps to follow. Copy it with the button, paste, and send.
          </Step>

          <Step n={6} title="Pick a pack and write">
            Claude will show you the packs as a numbered list with their current stats (how many questions each has), and
            ask which one you want to add to. Choose one, then just talk: <em>"let's write 8 for level 2 about bedtime
            worries."</em> Claude checks every draft against what's already there so you never make a duplicate, then sends
            them to the review queue. <strong>Albert approves, edits, or rejects each one</strong> on the AI Review page —
            that's the only way anything reaches a child.
          </Step>

        </div>
      </div>

      {/* what happens to proposals + revoke */}
      <div style={{ display: "grid", gap: S.md, marginBottom: S.xl }}>
        <div style={{ background: C.goodSoft, border: "1px solid " + C.line, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.8, color: C.ink2, lineHeight: 1.65 }}>
          <strong style={{ color: C.goodInk }}>Nothing you propose goes live by itself.</strong> Every question is validated
          by the same engine the CMS uses and written <strong>only</strong> to the review queue. It reaches the game only
          when a human approves it on the <strong>AI Review</strong> page. Through the connector you can propose, preview,
          edit and reject things that are still <em>waiting</em> — but <strong>approving is not possible there</strong>, and
          nothing can touch a question that's already live.
        </div>
        <div style={{ background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.5, color: C.warnInk, lineHeight: 1.6 }}>
          <strong>Lost or leaked a token?</strong> Go to the <strong>Claude Connector</strong> page and revoke it — that
          disables it instantly — then make a new one. Never paste your token anywhere public or commit it to code.
        </div>
      </div>

      {/* ============ TECHNICAL REFERENCE (for developers) ============ */}
      <div style={{ borderTop: "2px solid " + C.line, margin: S.xl + "px 0 " + S.lg + "px", paddingTop: S.lg }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.ink, letterSpacing: -0.2 }}>Technical reference</div>
        <p className="pm-prose" style={{ margin: "3px 0 0", color: C.sub, fontSize: 13.5 }}>
          The services this project runs on, with their live links and IDs — for a developer working on the code or backend.
          A content contributor (above) needs none of this. GitHub holds the source and deploys the front-end; Cloudflare
          serves the site; Supabase is the backend. GitHub and Supabase are decoupled — a push never touches the backend.
        </p>
      </div>

      {/* how they fit together */}
      <div style={{ background: C.brandSoft, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.lg }}>
        <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.7 }}>
          <strong style={{ color: C.brandInk }}>Front-end:</strong> edit <code>src/</code> → build → <code>git push</code> → GitHub Actions → Cloudflare updates the live site.<br />
          <strong style={{ color: C.brandInk }}>Backend:</strong> the database, auth, and edge functions live in Supabase and are deployed manually (MCP or CLI) — <em>GitHub never deploys them</em>.
        </div>
      </div>

      {/* development partner access */}
      <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, marginBottom: S.xl }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: 4 }}>🛠 Development partner — builds the app</div>
        <div className="pm-prose" style={{ fontSize: 12.8, color: C.ink2, marginBottom: 0, lineHeight: 1.6 }}>
          Different from a content contributor: works on the code and backend, so needs <em>real</em> access —
          <strong> GitHub</strong> (collaborator, Write) and a <strong>Supabase org invitation</strong>. Cloudflare usually
          not needed. Full mechanics are in each service card below and in <code>CONTRIBUTING.md</code>.
        </div>
      </div>

      <ArchCard icon="⎇" title="GitHub" accent={C.bgDeep} tagline="Source of truth · deploy trigger for the front-end">
        <ArchRow label="Repository" value={GH} href={GH} />
        <ArchRow label="Owner / account" value="alcharles1980-design" mono={false} />
        <ArchRow label="Default branch" value="main" hint="Push here → GitHub Actions → Cloudflare deploy." />
        <AccessNote>
          You need to be a <strong>repository collaborator with Write access</strong>. The owner adds you at
          <strong> repo → Settings → Collaborators → Add people</strong> (using your GitHub username) and grants
          <strong> Write</strong>. Once added: clone the repo, then follow <code>CONTRIBUTING.md</code> — edit
          <code> src/</code>, build, and <code>git push</code> to <code>main</code>. A push auto-deploys the
          front-end. GitHub access alone lets you change only the website — the backend is separate (see Supabase).
        </AccessNote>
      </ArchCard>

      <ArchCard icon="☁" title="Cloudflare" accent={C.infoSoft} tagline="Serves the CMS website (the static index.html)">
        <ArchRow label="Live site" value={CF_URL} href={CF_URL} hint="This is where the CMS loads." />
        <ArchRow label="Dashboard" value="Workers & Pages → positive-minds-cms" href="https://dash.cloudflare.com" mono={false} />
        <ArchRow label="Project name" value="positive-minds-cms" mono={false} />
        <ArchRow label="Worker ID" value={CF_WORKER_ID} />
        <ArchRow label="Account ID" value={CF_ACCOUNT_ID} hint="Dashboard → Workers & Pages → right sidebar → Account ID. Also stored as the CLOUDFLARE_ACCOUNT_ID GitHub Actions secret." />
        <AccessNote>
          <strong>Usually no access needed.</strong> The site deploys automatically through GitHub Actions using the
          owner's stored secrets — you never touch Cloudflare to ship a front-end change; you just push to GitHub.
          Direct access is only required to manage hosting itself (DNS, the Worker, cache), via an invite as a
          <strong> Member</strong> at <strong>dash → Manage Account → Members</strong> (use a scoped role, not
          Super Administrator). The Account ID above is an identifier, not a credential — acting on the account still
          needs the Cloudflare API <em>token</em>, which stays in GitHub Actions secrets and is never shown here.
        </AccessNote>
      </ArchCard>

      <ArchCard icon="◆" title="Supabase" accent={C.goodSoft} tagline="The entire backend — Postgres, auth, RLS, edge functions">
        <ArchRow label="Project" value="positive-minds-cms" mono={false} />
        <ArchRow label="Project ID (ref)" value={SB_REF} />
        <ArchRow label="Dashboard" value={SB_DASH} href={SB_DASH} />
        <ArchRow label="API URL" value={SB_URL} href={SB_URL} />
        <ArchRow label="Database host" value={SB_DB_HOST} hint="Region us-east-1 · Postgres 17. Connecting still requires the DB credentials (not shown here)." />
        <ArchRow label="Edge functions" value={SB_FUNCS} href={SB_FUNCS} hint="content-api · generate-questions · mcp · game-feed · pack-describe" />
        <ArchRow label="Content API (game)" value={SB_FUNCS + "/content-api"} href={SB_FUNCS + "/content-api"} hint="The endpoint the game client pulls from." />
        <AccessNote>
          <strong>You need an invitation to the Supabase organization</strong> — GitHub access does not reach the
          backend. The owner invites you at <strong>Supabase dashboard → Organization → Team → Invite member</strong>,
          using your email and a role (choose a role below Owner if offered, so an accidental delete/billing change
          is prevented). <strong>Accept the emailed invitation</strong>, and this project appears under your own
          Supabase account.<br /><br />
          <strong>To connect and work:</strong> connect the <strong>Supabase MCP</strong> on your own Claude account,
          signing in with <em>your own</em> Supabase login — it inherits whatever the org role grants. You can then
          deploy edge functions and run database changes directly from a chat. (Or use the <strong>Supabase CLI</strong>
          with your own credentials.) The MCP connector is only the pipe; authorization comes from your Supabase org
          membership, not from Claude.<br /><br />
          <strong>Note:</strong> this org is on the free plan, so membership spans <em>all</em> projects in it, not just
          this one. Deploying edge functions / running SQL is manual (MCP or CLI) — a GitHub push never touches Supabase.
        </AccessNote>
      </ArchCard>

      {/* content contributor setup guide */}
      <div style={{ background: C.bgDeep, border: "1px solid " + C.lineSoft, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", marginBottom: S.lg, fontSize: 12.5, color: C.ink2, lineHeight: 1.65 }}>
        <strong style={{ color: C.brandInk }}>Content contributor?</strong> You don't need any of the service access above —
        the full, step-by-step connect flow is at the top of this page (<em>“Write questions with Claude — start here”</em>).
        The connector reads packs and proposes to the review queue; it touches nothing else.
      </div>

      <div style={{ marginTop: S.lg, background: C.warnSoft, border: "1px solid " + C.warn, borderRadius: R.md, padding: S.md + "px " + S.lg + "px", fontSize: 12.5, color: C.warnInk, lineHeight: 1.65 }}>
        <strong>No secrets on this page.</strong> These are identifiers and dashboard links only — they still require each
        service's own login to use. Credentials (Supabase service-role key, Cloudflare API token, database password, AI
        provider keys) are deliberately excluded and live only in GitHub Actions secrets and each service's console.
      </div>
    </div>
  );
}

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
  { id: "generator", label: "Generate", icon: "✦" },
  { id: "levels", label: "Levels", icon: "▲" },
  { id: "aireview", label: "AI Review", icon: "◎" },
  { id: "aisettings", label: "AI Settings", icon: "✧" },
  { id: "connector", label: "Claude Connector", icon: "◇" },
  { id: "health", label: "Health", icon: "◉" },
  { id: "publish", label: "Publishing", icon: "⇧" },
  { id: "activity", label: "Activity", icon: "≡" },
  { id: "sysarch", label: "System Architecture", icon: "❖" },
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
  const VALID_NAV = ["dashboard", "library", "questions", "generator", "levels", "aireview", "aisettings", "connector", "health", "publish", "activity", "sysarch", "devnotes"];
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
          ) : nav === "sysarch" ? (
            <SystemArchitectureView />
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


const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
