// Positive Minds — MCP OAuth discovery shim (Cloudflare Worker)
//
// WHY THIS EXISTS
// The MCP server itself is a Supabase edge function at
//   https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/mcp
// Supabase serves functions only under /functions/v1/<name>, so it cannot serve the OAuth discovery
// documents at the domain ROOT (/.well-known/...), which is where Claude's custom-connector OAuth
// discovery probes. This Worker sits in front on its own origin (…workers.dev) and:
//   1. serves the discovery documents at the root (advertising this worker's URLs);
//   2. serves its OWN sign-in page for the authorize step (CMS-themed, JS submit) so it renders and
//      submits reliably inside Claude's OAuth window; and
//   3. proxies everything else (/mcp, /mcp/token, /mcp/register, and the authorize POST) through to
//      the UNCHANGED Supabase function, which still does all the OAuth 2.1 + PKCE work.

const SUPABASE = "https://tytrmjjucqijzcrbwjfm.supabase.co";

// ---- MCP Apps (SEP-1865) UI layer — SPEC-CORRECT BUT DORMANT -------------------------------------------------------------
// The UI is served from HERE rather than the Supabase function for one practical reason: this Worker
// deploys exactly, via CI, from the repo. The mcp function can only be deployed by transcribing its
// ~1,300 lines inline, which has already put a placeholder over the live function once. If this
// proof works, the right home for it is mcp.ts.
//
// STATUS (Aug 2026): Claude Web does NOT render MCP App widgets for CUSTOM connectors. Verified
// over five real attempts: the host negotiates io.modelcontextprotocol/ui, receives our resources
// capability and the _meta.ui.resourceUri, then NEVER calls resources/list or resources/read — it
// does not even ask for the widget. Matches a known platform-level gap (anthropics/claude-ai-mcp
// #471); interactive UI is currently a reviewed, DIRECTORY-connector feature. Left in place because
// it is spec-correct and costs nothing: if that changes, it lights up on its own.
// What delivers the interactive card TODAY is the rendering instruction carried in the tool's own
// description and result note in mcp.ts, which makes Claude build the same card as an artifact.
//
// What the host does (and what we therefore have to answer):
//   initialize      → client advertises io.modelcontextprotocol/ui; we must declare `resources`
//   tools/list      → the tool must carry _meta.ui.resourceUri  (INSIDE the tool object)
//   resources/list  → declare the ui:// resource
//   resources/read  → return the HTML with mimeType text/html;profile=mcp-app
//   tools/call      → return content AND structuredContent
import { VIEW_HTML } from "./view-app.js";

// CONNECTOR LOG. Added after a connection failure that took hours to diagnose because every piece
// of evidence had to be inferred: Supabase's function logs show a status and a URL, but not WHICH
// JSON-RPC method was called, whether a token was present, or which client sent it. Reconstructing
// a handshake from "POST 200 /mcp" four times in a row is guesswork.
// This records what a person actually needs to read a failure: the rpc method, the status we
// returned, whether the request carried credentials, and the client. INSERT-ONLY from the shim's
// anon key — it can write a line and can never read one back. Capped at 2000 rows.
// It never blocks or breaks a request: fire and forget, errors swallowed.
// The project ANON key. Public by design (it is in every browser bundle); it can INSERT a log line
// and nothing else, because pm_connector_log has RLS with an insert-only policy and no read policy.
const LOG_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5dHJtamp1Y3FpanpjcmJ3amZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTMyNDgsImV4cCI6MjA5ODY2OTI0OH0.KlFsPm7M015tflKE-jDjIstD_ZoCaz0jROUAoksJxOs";
function connLog(ctx, entry) {
  try {
    ctx.waitUntil(fetch(SUPABASE + "/rest/v1/pm_connector_log", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: LOG_KEY, Authorization: "Bearer " + LOG_KEY, Prefer: "return=minimal" },
      body: JSON.stringify(entry),
    }).catch(() => {}));
  } catch (_) { /* a diagnostic must never be able to break the thing it observes */ }
}

// Wrap a Response so the status that was ACTUALLY returned gets logged — not the one we intended.
function logged(ctx, res, entry) {
  try { connLog(ctx, { ...entry, status: res.status }); } catch (_) {}
  return res;
}

// CONTENT-ADDRESSED VIEW URI — this is a cache fix, not decoration.
// Hosts MAY prefetch and cache a ui:// resource (SEP-1865 says so explicitly), and they key that
// cache on the URI. With a FIXED URI a host will happily keep serving a view from hours ago: a
// wording change was deployed, verified live over the wire, and the user still saw the old text.
// Nothing in the protocol lets a server say "that resource changed".
// So the URI now carries a hash of the view itself. Change one character of the view and the URI
// changes, which the host cannot mistake for the thing it already has. Nothing to remember to bump.
function viewHash(str) {
  // djb2 — no crypto needed, and crypto.subtle is async which this is not.
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const VIEW_VERSION = viewHash(VIEW_HTML);
const UI_URI = "ui://positive-minds/view-" + VIEW_VERSION;
// The old fixed URIs stay SERVABLE so a session holding one keeps working; they are simply no
// longer advertised, so nothing new binds to them.
const LEGACY_URIS = ["ui://positive-minds/question-preview", "ui://positive-minds/overview"];
const OVERVIEW_TOOL = "overview";
const OVERVIEW_URI = UI_URI;
const UI_MIME = "text/html;profile=mcp-app";
const UI_TOOL = "preview_questions";

// NOTE: tool descriptions and connection instructions live in mcp.ts, where they belong. The shim
// deliberately does NOT rewrite them any more.


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, x-shim-ajax",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// CMS palette (light theme) — keep in sync with core.jsx.
const T = {
  bg: "#F6F5FB", panel: "#FFFFFF", ink: "#191728", ink2: "#4A4763", sub: "#6E6B85",
  line: "#E4E0F0", lineSoft: "#EFECF7", brand: "#6C4CE0", brand2: "#8A6EF0",
  brandSoft: "#EEE9FD", brandInk: "#4A32B0", good: "#0E8C7E", warnSoft: "#FBEEDD",
  warn: "#C06D18", warnInk: "#9C5B14", errBg: "#FDECEC", errLine: "#F3C7C7", errInk: "#C2352F",
};

// Our own sign-in page. `p` holds the OAuth params pulled from the authorize URL. The Connect button
// submits via fetch (reliable inside Claude's OAuth window, unlike a native form POST) and then
// navigates to the callback the server returns.
function loginPage(p) {
  const data = JSON.stringify(p).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Positive Minds</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    background:radial-gradient(1200px 600px at 50% -10%, ${T.brandSoft} 0%, ${T.bg} 55%);color:${T.ink}}
  .card{background:${T.panel};border:1px solid ${T.line};border-radius:20px;padding:32px 30px;
    max-width:430px;width:100%;box-shadow:0 18px 50px rgba(25,23,40,.12)}
  .badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:800;
    letter-spacing:.3px;color:${T.brandInk};background:${T.brandSoft};border:1px solid ${T.line};
    padding:6px 12px;border-radius:999px;margin-bottom:18px}
  .dot{width:8px;height:8px;border-radius:999px;background:${T.brand}}
  h1{margin:0 0 7px;font-size:22px;font-weight:800;letter-spacing:-.3px}
  .lead{margin:0 0 22px;color:${T.sub};font-size:14px;line-height:1.6}
  label{display:block;font-size:12px;font-weight:800;color:${T.ink2};margin-bottom:7px;
    text-transform:uppercase;letter-spacing:.4px}
  input{width:100%;padding:14px 15px;border:1.5px solid ${T.line};border-radius:12px;font-size:16px;
    font-family:ui-monospace,Menlo,monospace;background:#FBFAFE;color:${T.ink};transition:border-color .15s,box-shadow .15s}
  input::placeholder{color:#B7B2CC}
  input:focus{outline:none;border-color:${T.brand};box-shadow:0 0 0 4px rgba(108,76,224,.14)}
  button{width:100%;margin-top:18px;padding:14px;border:none;border-radius:12px;background:${T.brand};
    color:#fff;font-size:15.5px;font-weight:800;cursor:pointer;font-family:inherit;
    box-shadow:0 6px 18px rgba(108,76,224,.30);transition:background .15s,transform .05s,opacity .15s}
  button:hover{background:#5B3FCC}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.65;cursor:default;box-shadow:none}
  .err{display:none;background:${T.errBg};border:1px solid ${T.errLine};color:${T.errInk};
    padding:12px 14px;border-radius:11px;font-size:13.5px;margin-bottom:18px;line-height:1.5}
  .note{margin-top:20px;padding-top:18px;border-top:1px solid ${T.lineSoft};font-size:12.5px;
    color:${T.sub};line-height:1.6}
  .note b{color:${T.ink2}}
</style></head><body>
<div class="card">
  <span class="badge"><span class="dot"></span>Positive Minds</span>
  <h1>Connect your account</h1>
  <p class="lead">Paste the access token you were sent. Once connected, you can write question content just by asking Claude.</p>
  <div class="err" id="err"></div>
  <label for="tk">Your access token</label>
  <input id="tk" type="password" placeholder="pmk_…" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
  <button id="btn" type="button">Connect</button>
  <div class="note"><b>Everything you write goes to a review queue for approval first</b> — nothing you send goes live on its own.</div>
</div>
<script>
  var P = ${data};
  var tk = document.getElementById('tk'), btn = document.getElementById('btn'), err = document.getElementById('err');
  function showErr(m){ err.textContent = m; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Connect'; }
  async function connect(){
    var token = (tk.value || '').trim();
    err.style.display = 'none';
    if (!token){ showErr('Please paste your token.'); tk.focus(); return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      var params = new URLSearchParams();
      params.set('token', token);
      params.set('client_id', P.client_id || '');
      params.set('redirect_uri', P.redirect_uri || '');
      params.set('code_challenge', P.code_challenge || '');
      params.set('state', P.state || '');
      var r = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Shim-Ajax': '1' },
        body: params.toString(),
      });
      var d = await r.json();
      if (d && d.ok && d.redirect){ window.location.href = d.redirect; return; }
      showErr((d && d.error) || 'That sign-in could not be completed. Check the token, or ask for a fresh one.');
    } catch (e) {
      showErr('Something went wrong — please try again.');
    }
  }
  btn.addEventListener('click', connect);
  tk.addEventListener('keydown', function(e){ if (e.key === 'Enter') connect(); });
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// REQUEST LOGGING WRAPPER.
// The handler has 22 return points, several of which (discovery, CORS preflight, the sign-in page)
// answer BEFORE any per-branch logging ran. That left the single most important question
// unanswerable: when a client appears to do nothing, did it even ASK us for the discovery document?
// So every request is logged here, around the whole handler, and nothing can slip out unlogged.
//
// NEVER LOG A SECRET. Tokens, codes, verifiers and client secrets are stripped by redact() below.
// This table is insert-only under the anon key, but a log that quietly accumulates credentials is a
// breach waiting to happen regardless of who can read it.
const SECRET_PARAMS = ["token", "code", "code_verifier", "client_secret", "access_token",
                       "refresh_token", "password", "authorization"];

function redact(params) {
  const out = [];
  for (const [k, v] of params) {
    if (SECRET_PARAMS.indexOf(k.toLowerCase()) !== -1) {
      out.push(k + "=<redacted:" + String(v).length + " chars>");
    } else {
      out.push(k + "=" + String(v).slice(0, 60));
    }
  }
  return out.join("&").slice(0, 400);
}

function phaseOf(path) {
  if (path.indexOf("/.well-known/") !== -1) return "discovery";
  if (path.endsWith("/register")) return "register";
  if (path.endsWith("/authorize")) return "authorize";
  if (path.endsWith("/token")) return "token";
  if (path === "/mcp" || path.startsWith("/mcp/")) return "mcp";
  return "other";
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url0 = new URL(request.url);
    let res;
    try {
      res = await handleRequest(request, env, ctx);
    } catch (e) {
      // A thrown handler used to produce a bare 500 with nothing recorded anywhere.
      connLog(ctx, {
        phase: phaseOf(url0.pathname), path: url0.pathname, method: request.method,
        status: 500, err: String((e && e.stack) || e).slice(0, 400),
        ua: (request.headers.get("user-agent") || "").slice(0, 120),
        cf_ray: request.headers.get("cf-ray"), country: request.headers.get("cf-ipcountry"),
        ms: Date.now() - started,
      });
      throw e;
    }
    try {
      // Read the error body from a CLONE — consuming the real one would empty the response.
      let err = null;
      if (res.status >= 400) {
        try { err = (await res.clone().text()).slice(0, 400); } catch (_) {}
      }
      connLog(ctx, {
        phase: phaseOf(url0.pathname),
        path: url0.pathname,
        method: request.method,
        status: res.status,
        query: redact(url0.searchParams),
        had_auth: !!request.headers.get("authorization"),
        ua: (request.headers.get("user-agent") || "").slice(0, 120),
        cf_ray: request.headers.get("cf-ray"),
        country: request.headers.get("cf-ipcountry"),
        session_id: request.headers.get("mcp-session-id"),
        err,
        ms: Date.now() - started,
      });
    } catch (_) { /* logging must never break the response */ }
    return res;
  },
};

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ORIGIN = url.origin;
    const PUBLIC_MCP = ORIGIN + "/mcp";

    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });

    const jsonRes = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

    // ---- 1. OAuth discovery documents at the ORIGIN ROOT ----
    if (path === "/.well-known/oauth-protected-resource" ||
        path === "/.well-known/oauth-protected-resource/mcp" ||
        path === "/mcp/.well-known/oauth-protected-resource") {
      return jsonRes({ resource: PUBLIC_MCP, authorization_servers: [PUBLIC_MCP], scopes_supported: ["mcp:tools"], bearer_methods_supported: ["header"] });
    }
    if (path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/oauth-authorization-server/mcp" ||
        path === "/mcp/.well-known/oauth-authorization-server" ||
        path === "/.well-known/openid-configuration" ||
        path === "/.well-known/openid-configuration/mcp") {
      // A SECOND COPY OF THIS DOCUMENT IS HOW THE CONNECTOR BROKE. The mcp function advertises
      // grant_types_supported ['authorization_code','refresh_token']; this hand-written copy said
      // ['authorization_code'] only. Clients read THIS one (it is the one at the domain root), so
      // Claude was told the connection could never be refreshed — and reported exactly that:
      // "Connection has expired." The token endpoint was issuing refresh tokens the whole time;
      // nothing ever asked for one.
      // The fix is not to correct the copy. It is to STOP KEEPING A COPY: fetch the function's own
      // metadata and rewrite only the URLs, so the two can never disagree again. Falls back to a
      // literal if the fetch fails, because discovery going down would break every new connection.
      try {
        const upstreamMeta = await fetch(SUPABASE + "/functions/v1/mcp/.well-known/oauth-authorization-server");
        if (upstreamMeta.ok) {
          const m = await upstreamMeta.json();
          return jsonRes({
            ...m,
            issuer: PUBLIC_MCP,
            authorization_endpoint: PUBLIC_MCP + "/authorize",
            token_endpoint: PUBLIC_MCP + "/token",
            registration_endpoint: PUBLIC_MCP + "/register",
          });
        }
      } catch (_) { /* fall through to the literal below */ }
      return jsonRes({
        issuer: PUBLIC_MCP,
        authorization_endpoint: PUBLIC_MCP + "/authorize",
        token_endpoint: PUBLIC_MCP + "/token",
        registration_endpoint: PUBLIC_MCP + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:tools"],
      });
    }

    // ---- 2a. Sign-in page: serve OUR OWN (GET /mcp/authorize) ----
    if (request.method === "GET" && path.endsWith("/mcp/authorize")) {
      const p = {
        client_id: url.searchParams.get("client_id") || "",
        redirect_uri: url.searchParams.get("redirect_uri") || "",
        code_challenge: url.searchParams.get("code_challenge") || "",
        state: url.searchParams.get("state") || "",
      };
      return new Response(loginPage(p), { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
    }

    // ---- 2b. Sign-in submit from our page (POST /mcp/authorize + X-Shim-Ajax) → JSON ----
    if (request.method === "POST" && path.endsWith("/mcp/authorize") && request.headers.get("x-shim-ajax")) {
      const body = await request.arrayBuffer();
      const up = await fetch(SUPABASE + "/functions/v1/mcp/authorize", {
        method: "POST",
        headers: { "Content-Type": request.headers.get("content-type") || "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
      });
      if (up.status >= 300 && up.status < 400) {
        const loc = up.headers.get("location");
        if (loc) return jsonRes({ ok: true, redirect: loc });
        return jsonRes({ ok: false, error: "The sign-in server did not return a destination. Please try again." });
      }
      // A 200 here means Supabase re-rendered the login page instead of redirecting. USUALLY a bad
      // token — but not always: an unknown client_id or a mismatched redirect_uri lands here too.
      // The old wording blamed the token unconditionally, and there is a 400 in the logs that would
      // have told a partner their perfectly valid token was rejected, sending them to ask for a
      // replacement they did not need. Say what is actually known.
      return jsonRes({ ok: false, error: "That sign-in could not be completed. Most often the token is wrong or has been revoked \u2014 check it, or ask for a fresh one. If the token is definitely right, remove the connector in Claude and add it again." });
    }

    // ---- 3. Proxy everything else to the Supabase edge function ----
    let targetPath;
    if (path === "/mcp" || path.startsWith("/mcp/")) targetPath = "/functions/v1" + path;
    else if (path.startsWith("/functions/v1/mcp")) targetPath = path;
    else targetPath = "/functions/v1/mcp";
    const targetUrl = SUPABASE + targetPath + url.search;

    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("host");
    const method = request.method;
    const reqBody = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

    // ---- MCP Apps interception -----------------------------------------------------------------
    // Only for JSON-RPC POSTs to the MCP endpoint. Everything else passes through untouched.
    if (method === "POST" && (path === "/mcp" || path === "/functions/v1/mcp")) {
      let rpc = null;
      try { rpc = JSON.parse(new TextDecoder().decode(reqBody)); } catch (_) { /* not JSON — pass through */ }

      // One place, so every branch below logs the same facts.
      const logBase = {
        path,
        rpc_method: (rpc && rpc.method) || null,
        had_auth: !!request.headers.get("authorization"),
        client_id: (rpc && rpc.params && rpc.params.client_id) || null,
        ua: (request.headers.get("user-agent") || "").slice(0, 120),
      };

      if (rpc && rpc.jsonrpc === "2.0") {
        const rpcRes = (result) => new Response(
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }),
          { headers: { ...CORS, "Content-Type": "application/json" } },
        );

        // ---- overview — the orientation a partner gets when they arrive -----------------------
        // Composed IN THE SHIM from two existing read tools, called with the CALLER'S OWN token.
        // No new credentials, no new privilege, nothing this partner could not already read; it
        // just saves them three round trips and a lot of phrasing. The shim can do this because it
        // deploys from the repo on push — mcp.ts is a hand-paste (rule 4.30) and this needed to be
        // changeable. If edge-function CI ever lands, this belongs upstream in mcp.ts.
        if (rpc.method === "tools/call" && rpc.params && rpc.params.name === OVERVIEW_TOOL) {
          const callUpstream = async (toolName) => {
            const h = new Headers(fwdHeaders);
            h.set("Content-Type", "application/json");
            const r = await fetch(SUPABASE + "/functions/v1/mcp", {
              method: "POST",
              headers: h,
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: {} } }),
            });
            if (!r.ok) return { __error: "HTTP " + r.status, __status: r.status };
            const j = await r.json().catch(() => null);
            if (!j || j.error) return { __error: (j && j.error && j.error.message) || "no result" };
            const blocks = (j.result && j.result.content) || [];
            const t = blocks.find((c) => c && c.type === "text");
            if (!t) return { __error: "no text block" };
            try { return JSON.parse(t.text); } catch (_) { return { __error: "unparseable" }; }
          };

          // One at a time is fine here — two small reads, and it keeps the failure attributable.
          const packsRes = await callUpstream("list_packs");
          const statusRes = await callUpstream("review_status");

          // AUTH FAILURE IS NOT A PARTIAL RESULT. Every other tool answers an unauthenticated call
          // with 401 + WWW-Authenticate, and that is what makes an MCP client start the OAuth flow.
          // Composing two reads would otherwise turn a 401 into a cheerful 200 "everything is empty"
          // — and since overview is now the FIRST call of a session, an expired token would show a
          // partner an empty CMS and never prompt them to sign in. Propagate the 401 instead.
          if (packsRes.__status === 401 || statusRes.__status === 401 ||
              packsRes.__status === 403 || statusRes.__status === 403) {
            const status = packsRes.__status || statusRes.__status;
            return new Response(
              JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null,
                error: { code: -32001, message: "Not authorised — sign in to the connector again." } }),
              { status, headers: { ...CORS, "Content-Type": "application/json",
                "WWW-Authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"` } },
            );
          }

          // If either leg fails, SAY SO rather than quietly reporting zeros. A confident "0 questions
          // awaiting review" that actually means "the call failed" is the worst possible output for
          // a tool whose entire job is to tell someone where things stand (rule 4.22).
          const problems = [];
          if (packsRes.__error) problems.push("pack list unavailable (" + packsRes.__error + ")");
          if (statusRes.__error) problems.push("review queue unavailable (" + statusRes.__error + ")");

          const packs = Array.isArray(packsRes.packs) ? packsRes.packs : [];
          const totals = statusRes.totals_all_contributors || {};
          const byPack = statusRes.by_pack || {};

          const shaped = packs.map((p) => {
            const st = p.stats || {};
            return {
              slug: p.slug,
              name: p.name,
              emoji: p.emoji,
              status: p.status,
              description: p.description || null,
              live_questions: st.live_questions || 0,
              awaiting_review: st.awaiting_review || 0,
              distinct_answer_words: st.distinct_answer_words || 0,
            };
          });
          // Packs a person can actually act on come first: things waiting, then things with content,
          // then the empty ones. Alphabetical order buries the 12 pending questions in the middle.
          const rank = (p) => (p.awaiting_review > 0 ? 0 : p.live_questions > 0 ? 1 : 2);
          shaped.sort((a, b) => rank(a) - rank(b) || b.awaiting_review - a.awaiting_review ||
                                b.live_questions - a.live_questions || a.name.localeCompare(b.name));

          const withLive = shaped.filter((p) => p.live_questions > 0).length;
          const liveTotal = shaped.reduce((n, p) => n + p.live_questions, 0);
          const awaitingTotal = shaped.reduce((n, p) => n + p.awaiting_review, 0);

          const payload = {
            headline: problems.length
              ? "Partial overview — " + problems.join("; ")
              : awaitingTotal + " question(s) waiting for a human, " + liveTotal +
                " live across " + withLive + " pack(s).",
            problems: problems.length ? problems : undefined,
            content_status: {
              packs_total: shaped.length,
              published: shaped.filter((p) => p.status === "published").length,
              draft: shaped.filter((p) => p.status !== "published").length,
              packs_with_live_questions: withLive,
              packs_empty: shaped.filter((p) => p.live_questions === 0 && p.awaiting_review === 0).length,
              live_questions_total: liveTotal,
              awaiting_review_total: awaitingTotal,
              approved_all_time: totals.approved,
              rejected_all_time: totals.rejected,
            },
            packs: shaped,
            review_queue: {
              total_awaiting: awaitingTotal,
              by_pack: byPack,
              by_contributor: statusRes.by_contributor,
              your_own: statusRes.your_own,
              visibility: statusRes.visibility,
            },
            // `say` is what a menu BUTTON sends into the chat, so it has to read like something a
            // person would actually type. `how` is the tool chain, for the assistant's benefit only —
            // never show tool names to a partner.
            what_you_can_do: [
              { do: "Review what is waiting", icon: "\u23F3",
                how: "preview_questions (source: pending)",
                say: "Show me the questions waiting for review so I can play them." },
              { do: "Play a pack as a child sees it", icon: "\u25B6",
                how: "preview_questions (source: live, pack_slug)",
                say: "Let me play the live questions in one of the packs." },
              { do: "Write new questions", icon: "\u270D",
                how: "get_pack_content, then check_questions, then propose_questions",
                say: "I would like to write some new questions for a pack." },
              { do: "Test drafts without saving", icon: "\u2713",
                how: "check_questions",
                say: "I have some draft questions I want checked against the engine before proposing them." },
              { do: "Fix something in the queue", icon: "\u270E",
                how: "edit_queued_question",
                say: "I want to fix a question that is already waiting for review." },
              { do: "Take something out of the queue", icon: "\u2716",
                how: "reject_questions",
                say: "I want to remove a question from the review queue and give a reason." },
              { do: "See progress and rejections", icon: "\u25F4",
                how: "review_status",
                say: "How is the review queue doing, and what has been rejected and why?" },
              { do: "Start a new pack", icon: "\u2726",
                how: "create_pack",
                say: "I would like to start a new themed pack." },
              { do: "Sharpen a pack's definition", icon: "\u2699",
                how: "update_pack",
                say: "I want to refine the purpose, focus or style of an existing pack." },
              // Approval is real now. It is listed LAST deliberately: reviewing comes before
              // approving, and a menu that offers approve first invites approving from a list.
              { do: "Approve a question into a pack", icon: "\u2714",
                how: "preview_questions first, then approve_question(id, confirm_answer)",
                say: "Let me review the questions waiting, one at a time, so I can approve them." },
              { do: "Audit what is already live and list what is wrong with it", icon: "\u26A0",
                how: "audit_content — read-only; scope defaults to what a child can actually reach",
                say: "Audit the questions and tell me what is broken." },
              { do: "Undo an approval", icon: "\u21A9",
                how: "unapprove_question",
                say: "I want to take back a question I approved." },
              // Sending is listed LAST because it IS last: approving puts a question in a pack, and
              // the game does not have it until a sync. Leaving this off the menu is what made the
              // line below claim approval was the final gate (rule 4.42, second time).
              // Delete sits AFTER undo deliberately: the reversible option should be read first.
              { do: "Permanently delete a question, or an empty pack", icon: "\u2716",
                how: "delete_question (deactivate it first — it refuses while active) or delete_pack " +
                     "(empty and unpublished only). No undo, one at a time, and neither reaches the game",
                say: "I want to permanently delete a question." },
              { do: "Send approved content to the game", icon: "\u2601",
                how: "sync_to_game with no confirm (dry run), show the packs and counts, then only " +
                     "sync_to_game(confirm: true) once the person has said yes",
                say: "I want to send the approved content to the game." },
            ],
            // WAS: "Approve. Nothing written here reaches a child until a human approves it in the
            // CMS." That stayed true-sounding and became false the moment approve_question shipped,
            // and the assistant read it out as fact in a fresh session while holding the tool.
            // A capability is declared in several places and every one that says NO wins (rule 4.42).
            what_you_cannot_do: "Nothing you write goes live on its own, and there are TWO human gates, not " +
              "one. First a HUMAN approves the question — in the CMS, or here with approve_question after " +
              "previewing it. Approving puts it in a PACK; the game still does not have it. It reaches a " +
              "child only when the content is SENT, and sync_to_game sends nothing until a person has seen " +
              "the dry run and said yes. There is no bulk approve on purpose: a same-length pair, or a " +
              "wrong word that also fits the sentence, only shows itself when you PLAY the question. " +
              "Approving and sending are available only to tokens granted them; if you do not see the " +
              "tool, you do not have it. DELETING is the one thing here that cannot be undone, and it " +
              "still does not reach the game: Firebase keeps whatever it was last sent until a sync " +
              "says otherwise.",
            how_to_show_this: "Give the person a SHORT orientation, not this JSON. In this order:\n" +
              "1. The headline.\n" +
              "2. A bulleted list of the packs that have something in them (live or awaiting) with their " +
              "counts, then one line saying how many of the rest are empty — do not list all fifteen.\n" +
              "3. A NUMBERED LIST of EVERY item in what_you_can_do, using its \"do\" text. This list is " +
              "REQUIRED and must be complete — do not summarise it, do not fold it into a sentence, and do " +
              "not offer two or three options as prose. Never show tool names — the \"how\" field is for " +
              "you, not for them.\n" +
              "   PRINT IT EVEN IF A VISUAL CARD IS ALSO SHOWN. A card may be rendered above your reply " +
              "with the same options on it. That is NOT a reason to leave the list out, and the two are " +
              "not in conflict: the card does not appear in every client, does not survive being scrolled " +
              "past or exported, and cannot be read back later. The text list is the durable copy. If you " +
              "find yourself deciding the list would be redundant, print it anyway.\n" +
              "4. what_you_cannot_do, once, plainly, so nobody assumes their questions are live.\n" +
              "5. Close by asking which number they want.\n" +
              "If problems is present, say so up front and do not present partial numbers as complete.",
          };

          return rpcRes({
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            structuredContent: payload,
            _meta: { ui: { resourceUri: OVERVIEW_URI } },
          });
        }

        // resources/list — declare the UI resource. The Supabase function knows nothing about this.
        if (rpc.method === "resources/list") {
          return rpcRes({
            // ONE resource now: the single view renders whichever payload arrives, so advertising
            // it twice only invited the host to pick the "wrong" one (which it did).
            resources: [{
              uri: UI_URI,
              name: "Positive Minds",
              description: "Play questions as a child sees them, or see where the content stands.",
              mimeType: UI_MIME,
              _meta: { ui: { prefersBorder: false } },
            }],
          });
        }

        // resources/read — hand over the app itself.
        if (rpc.method === "resources/read") {
          const want = rpc.params && rpc.params.uri;
          // Both URIs serve the SAME view — the host picks one per connector and does not honour the
          // per-tool link, so the view dispatches on payload shape instead. See view-app.js.
          // SERVE ANY VERSION OF THE VIEW, not just the current hash.
          // Content-addressing invalidates a host's cache, which is the point — but the host also
          // caches tools/list, so it will keep asking for the hash it saw THERE, which may be an
          // older one. Serving only the current hash turns every shim deploy into "Failed to load
          // the MCP app" for anyone holding a stale tool list. Content-addressing without serving
          // the old addresses is just breakage with extra steps.
          // Any ui://positive-minds/view-* resolves, and always to the CURRENT html — an old URI
          // should not pin old content, it should simply keep working.
          const isViewUri = want === UI_URI ||
            (typeof want === "string" && want.indexOf("ui://positive-minds/view-") === 0) ||
            LEGACY_URIS.indexOf(want) !== -1;
          if (isViewUri) {
            return rpcRes({
              contents: [{
                uri: want,
                mimeType: UI_MIME,
                text: VIEW_HTML,
                _meta: { ui: { prefersBorder: false } },
              }],
            });
          }
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32002, message: "Resource not found" } }),
            { headers: { ...CORS, "Content-Type": "application/json" } },
          );
        }

        // resources/templates/list — some hosts probe this; answer rather than 404.
        if (rpc.method === "resources/templates/list") {
          return rpcRes({ resourceTemplates: [] });
        }

        // initialize / tools/list / tools/call — forward, then patch the response.
        if (rpc.method === "initialize" || rpc.method === "tools/list" || rpc.method === "tools/call") {
          const up = await fetch(targetUrl, { method, headers: fwdHeaders, body: reqBody, redirect: "manual" });
          const outH = new Headers(up.headers);
          outH.delete("content-length"); outH.delete("content-encoding"); outH.delete("transfer-encoding");
          for (const [k, v] of Object.entries(CORS)) outH.set(k, v);
          if (outH.has("www-authenticate")) {
            outH.set("WWW-Authenticate", `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
          }

          const raw = await up.text();
          let payload = null;
          try { payload = JSON.parse(raw); } catch (_) { /* not JSON */ }
          // Unconditional: tells us the branch ran, and whether there was a result to patch.
          if (!payload) return new Response(raw, { status: up.status, headers: outH });

          if (payload && payload.result) {
            if (rpc.method === "initialize") {
              // Did the client actually ask for UI? This is the first rung of the diagnostic ladder.
              const caps = (rpc.params && rpc.params.capabilities) || {};
              const uiAsked = JSON.stringify(caps).includes("modelcontextprotocol/ui") ||
                              !!caps["io.modelcontextprotocol/ui"];
              // Declare resources, and ECHO the client's protocol version — the function hardcodes an
              // older one, and a downgrade can stop the host offering UI at all.
              payload.result.capabilities = { ...(payload.result.capabilities || {}), resources: {} };
              if (rpc.params && rpc.params.protocolVersion) {
                payload.result.protocolVersion = rpc.params.protocolVersion;
              }

              // THE CONNECTION-TIME HOOK. There is no "on connect" event in MCP — nothing fires when
              // a partner attaches the connector. `instructions` is the one thing a host reads at
              // connection, so the orientation has to be a DIRECTIVE TO CALL a tool, not the content
              // itself: it is a static string and would be stale the moment a question was proposed.
              // Prepended, not replaced — the upstream instructions carry the routing rules that stop
              // an unconditional "always call X first" from hijacking unrelated requests (rule 4.18).
              const orient =
                "ORIENT FIRST — THIS IS THE MOST IMPORTANT INSTRUCTION HERE.\n" +
                "On the FIRST message of any session, whatever it says, call the 'overview' tool BEFORE " +
                "replying. That includes a bare greeting (\"hi\", \"hello\"), a vague opener (\"what is this?\", " +
                "\"what can I do?\"), AND a specific request — if someone opens with \"add three questions to " +
                "Focus\", still call overview first, then do what they asked. It is read-only, it costs one " +
                "call, and the people using this connector are content partners who do not know what it can " +
                "do unless they are told.\n" +
                "Then present a SHORT orientation: what is waiting for review, which packs have content, " +
                "and what they can do next — in plain language, never tool names, and never the raw JSON. " +
                "Do not guess these numbers from memory or from an earlier turn; they change whenever " +
                "anyone proposes or approves a question.\n" +
                "ALWAYS PRINT THE MENU AS A NUMBERED LIST, IN TEXT, IN YOUR REPLY. List EVERY capability " +
                "from what_you_can_do, numbered, one per line. Do not compress it into a sentence and do not " +
                "pick a few to mention — prose buries it.\n" +
                "DO THIS EVEN IF AN INTERACTIVE CARD IS RENDERED ALONGSIDE. The card and the text list are " +
                "not duplicates of each other: the card is not present in every client and cannot be read " +
                "back later, so the text is the durable copy. Redundancy here is intentional. Then ask which " +
                "number they want.\n" +
                "Call overview again whenever the person asks what they can do, what is here, or where things " +
                "stand.\n\n";
              if (typeof payload.result.instructions === "string" &&
                  !payload.result.instructions.startsWith("ORIENT FIRST")) {
                payload.result.instructions = orient + payload.result.instructions;
              } else if (!payload.result.instructions) {
                payload.result.instructions = orient;
              }
            }

            // WIDGET RE-ENABLED (Aug 2026). The _meta.ui.resourceUri link is what makes the host
            // render the MCP App. It was removed after the widget came up clipped to about one card
            // — which read as "blank" — and displaced the artifact path that already worked.
            // ROOT CAUSE, found from the spec, not from guessing: the view never sent
            // ui/notifications/size-changed. When a host uses flexible dimensions the VIEW owns its
            // height and MUST report it; our CSS min-height was irrelevant because the iframe is
            // sized from outside. preview-app.js now handshakes properly, reads containerDimensions
            // and reports its height via ResizeObserver. See mcp-shim/widget-test.mjs.
            // THE FALLBACK STAYS REACHABLE (rule 4.24): the text content block below still carries
            // the full JSON, so a host without MCP Apps — or with a broken widget — still gets the
            // playable artifact. The widget's status bar makes its own failure loud rather than
            // silent. Nested _meta.ui is the current form; flat _meta["ui/resourceUri"] is
            // deprecated in the spec and deliberately not sent.
            if (rpc.method === "tools/list" && Array.isArray(payload.result.tools)) {
              for (const t of payload.result.tools) {
                if (t && t.name === UI_TOOL) {
                  t._meta = { ...(t._meta || {}), ui: { resourceUri: UI_URI, visibility: ["model", "app"] } };
                }
              }
              // Declare overview FIRST. Position is not decorative — a tool listed first is the one
              // reached for when someone opens with "what's here?", which is exactly the intent.
              if (!payload.result.tools.some((t) => t && t.name === OVERVIEW_TOOL)) {
                payload.result.tools.unshift({
                  name: OVERVIEW_TOOL,
                  description:
                    "START HERE. Where the content stands right now and what you can do with it: every pack " +
                    "with its live and awaiting-review counts, the size and shape of the review queue, and the " +
                    "list of actions available to you. Call this FIRST in a session, before answering anything " +
                    "about packs, questions or progress, and present the result as a short orientation rather " +
                    "than raw data. Read-only — it changes nothing.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                  annotations: { readOnlyHint: true, title: "Overview" },
                  _meta: { ui: { resourceUri: OVERVIEW_URI, visibility: ["model", "app"] } },
                });
              }
            }

            // DISCOVERY FALLBACK. `instructions` is ADVISORY — the host reads it at connection, but
            // nothing fires until the person speaks and nothing guarantees the model acts on it. A
            // partner who opens with a specific request ("add three questions to Focus") may never
            // see the orientation at all, and then has no idea what else is possible.
            // So every tool result carries a compact menu. It is stateless (the shim has no session
            // store), it costs a few hundred bytes, and it makes the capability list impossible to
            // miss whatever the partner happens to do first. The full picture still lives in
            // `overview`; this is the pointer to it.
            if (rpc.method === "tools/call" && payload.result && rpc.params &&
                rpc.params.name !== OVERVIEW_TOOL) {
              payload.result.also_available = {
                note: "If the person has not yet been shown the full menu in this conversation, print " +
                      "this as a NUMBERED LIST after answering what they asked. They cannot see a menu " +
                      "anywhere else. Plain language only, never tool names.",
                you_can_also: [
                  "See or play the questions waiting for review",
                  "Play a pack's live questions as a child sees them",
                  "Write new questions for a pack",
                  "Test drafts against the real engine without saving",
                  "Fix or remove a question already in the queue",
                  "Check progress and see why things were rejected",
                  "Start a new pack, or sharpen an existing one's definition",
                  "Audit the saved questions and list what is wrong with them (changes nothing)",
                  "Review and approve a question into a pack, one at a time (and undo it)",
                  "Permanently delete a question, or an empty pack — no undo, and it does not reach the game",
                  "Send approved content to the game, once a human has seen what would go and said yes",
                ],
                full_picture: "Call the 'overview' tool for live counts and the complete menu.",
                cannot: "Nothing goes live on its own. A human approves the question, which puts it in " +
                        "a pack — and a human then has to send it before the game has it.",
              };
            }

            if (rpc.method === "tools/call" && rpc.params && rpc.params.name === UI_TOOL) {
              // Hosts render from structuredContent; our function returns text content. The rendering
              // guidance itself lives in the tool's description and note in mcp.ts, not here.
              const blocks = payload.result.content || [];
              const textBlock = blocks.find((c) => c && c.type === "text");
              if (textBlock) {
                try { payload.result.structuredContent = JSON.parse(textBlock.text); } catch (_) { /* leave as text */ }
              }
              payload.result._meta = { ...(payload.result._meta || {}), ui: { resourceUri: UI_URI } };
            }
          }

          // Kept alongside the wrapper: only here do we know the JSON-RPC METHOD, which the
          // wrapper cannot see without consuming the request body.
          return logged(ctx, new Response(JSON.stringify(payload), { status: up.status, headers: outH }), logBase);
        }
      }
    }

    const upstream = await fetch(targetUrl, { method, headers: fwdHeaders, body: reqBody, redirect: "manual" });

    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.delete("transfer-encoding");
    if (outHeaders.has("www-authenticate")) {
      outHeaders.set("WWW-Authenticate", `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    }
    for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);

    // (The fall-through no longer logs here — the wrapper around handleRequest logs every request,
    // including this one, and duplicating it only made the flow harder to read.)
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
