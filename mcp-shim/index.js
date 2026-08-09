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
import { PREVIEW_APP_HTML } from "./preview-app.js";

// TEMPORARY diagnostic: which tool is the client actually calling? Remove once resolved.
const TOOL_LOG_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5dHJtamp1Y3FpanpjcmJ3amZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTMyNDgsImV4cCI6MjA5ODY2OTI0OH0.KlFsPm7M015tflKE-jDjIstD_ZoCaz0jROUAoksJxOs";
function toolLog(ctx, entry) {
  try {
    ctx.waitUntil(fetch(SUPABASE + "/rest/v1/pm_tool_log", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: TOOL_LOG_KEY, Authorization: "Bearer " + TOOL_LOG_KEY, Prefer: "return=minimal" },
      body: JSON.stringify(entry),
    }).catch(() => {}));
  } catch (_) { /* never break the request */ }
}

const UI_URI = "ui://positive-minds/question-preview";
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
      showErr((d && d.error) || 'That token was not recognised, or access has been revoked.');
    } catch (e) {
      showErr('Something went wrong — please try again.');
    }
  }
  btn.addEventListener('click', connect);
  tk.addEventListener('keydown', function(e){ if (e.key === 'Enter') connect(); });
</script>
</body></html>`;
}

export default {
  async fetch(request, env, ctx) {
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
      return jsonRes({
        issuer: PUBLIC_MCP,
        authorization_endpoint: PUBLIC_MCP + "/authorize",
        token_endpoint: PUBLIC_MCP + "/token",
        registration_endpoint: PUBLIC_MCP + "/register",
        response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
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
      // 200 back from Supabase = it re-rendered the login page with an error (bad/expired token).
      return jsonRes({ ok: false, error: "That token was not recognised, or access has been revoked. Check it and try again, or issue a fresh one." });
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

      if (rpc && rpc.jsonrpc === "2.0") {
        const rpcRes = (result) => new Response(
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result }),
          { headers: { ...CORS, "Content-Type": "application/json" } },
        );

        // resources/list — declare the UI resource. The Supabase function knows nothing about this.
        if (rpc.method === "resources/list") {
          return rpcRes({
            resources: [{
              uri: UI_URI,
              name: "Question preview",
              description: "Play a question exactly as a child sees it, at any level.",
              mimeType: UI_MIME,
            }],
          });
        }

        // resources/read — hand over the app itself.
        if (rpc.method === "resources/read") {
          const want = rpc.params && rpc.params.uri;
          if (want === UI_URI) {
            return rpcRes({
              contents: [{
                uri: UI_URI,
                mimeType: UI_MIME,
                text: PREVIEW_APP_HTML,
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
        if (rpc.method === "tools/call") {
          toolLog(ctx, {
            tool: (rpc.params && rpc.params.name) || "?",
            args: JSON.stringify((rpc.params && rpc.params.arguments) || {}).slice(0, 300),
            ua: request.headers.get("user-agent") || "",
          });
        }
        if (rpc.method === "initialize") {
          toolLog(ctx, { tool: "(initialize)", args: "", ua: request.headers.get("user-agent") || "" });
        }
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

          return new Response(JSON.stringify(payload), { status: up.status, headers: outH });
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

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};
