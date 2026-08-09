// Positive Minds — MCP OAuth discovery shim (Cloudflare Worker)
//
// WHY THIS EXISTS
// The MCP server itself lives in a Supabase edge function at
//   https://tytrmjjucqijzcrbwjfm.supabase.co/functions/v1/mcp
// Supabase serves functions only under the /functions/v1/<name> path prefix, so it CANNOT serve
// the OAuth discovery documents at the domain ROOT (/.well-known/...). Claude's custom-connector
// OAuth flow discovers the authorization server by probing the ORIGIN ROOT
// (/.well-known/oauth-protected-resource[/mcp] and /.well-known/oauth-authorization-server[/mcp])
// and by constructing the RFC 8414 host-inserted metadata URL. Against a bare Supabase function
// every one of those 404s, so Claude never starts the sign-in flow and reports "no tools available."
//
// This Worker sits in front on its own origin (…workers.dev), where it CAN serve /.well-known/* at
// the root. It:
//   1. serves the two discovery documents itself, advertising THIS worker's URLs; and
//   2. transparently proxies /mcp, /mcp/authorize, /mcp/token, /mcp/register (and the login form's
//      POST) through to the unchanged Supabase function.
// It also rewrites the 401 WWW-Authenticate header to point at its own discovery doc, and rewrites
// the login page's form action so the browser posts back through this origin. The Supabase function
// — including all the OAuth 2.1 + PKCE logic — is left exactly as it is.
//
// Connector URL for Claude:  https://<this-worker>.workers.dev/mcp

const SUPABASE = "https://tytrmjjucqijzcrbwjfm.supabase.co";

// Fire-and-forget diagnostic logging so the Worker's own traffic (esp. discovery-doc fetches, which
// never reach Supabase) is visible. Temporary; remove once the connector flow is confirmed.
const SHIM_LOG_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR5dHJtamp1Y3FpanpjcmJ3amZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwOTMyNDgsImV4cCI6MjA5ODY2OTI0OH0.KlFsPm7M015tflKE-jDjIstD_ZoCaz0jROUAoksJxOs";
function shimLog(ctx, entry) {
  try {
    ctx.waitUntil(fetch(SUPABASE + "/rest/v1/pm_shim_log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SHIM_LOG_KEY,
        Authorization: "Bearer " + SHIM_LOG_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(entry),
    }).catch(() => {}));
  } catch (_) { /* never break the request */ }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ORIGIN = url.origin;            // https://positive-minds-mcp.<sub>.workers.dev
    const PUBLIC_MCP = ORIGIN + "/mcp";   // the URL a user enters into Claude as the connector
    const ua = request.headers.get("user-agent") || "";
    shimLog(ctx, { method: request.method, path, ua, status: 0 });

    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: CORS });
    }

    const jsonRes = (obj) =>
      new Response(JSON.stringify(obj), { headers: { ...CORS, "Content-Type": "application/json" } });

    // ---- 1. OAuth discovery documents, served at the ORIGIN ROOT (the whole reason this exists) ----
    // Cover the root form, the RFC-8414 host-inserted form (…/mcp), and the OIDC path-appended form.
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/oauth-protected-resource/mcp" ||
      path === "/mcp/.well-known/oauth-protected-resource"
    ) {
      return jsonRes({
        resource: PUBLIC_MCP,
        authorization_servers: [PUBLIC_MCP],
        scopes_supported: ["mcp:tools"],
        bearer_methods_supported: ["header"],
      });
    }
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/oauth-authorization-server/mcp" ||
      path === "/mcp/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration" ||
      path === "/.well-known/openid-configuration/mcp"
    ) {
      return jsonRes({
        issuer: PUBLIC_MCP,
        authorization_endpoint: PUBLIC_MCP + "/authorize",
        token_endpoint: PUBLIC_MCP + "/token",
        registration_endpoint: PUBLIC_MCP + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"], // OAuth 2.1 / MCP requires PKCE S256
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:tools"],
      });
    }

    // ---- 2. Proxy everything else to the Supabase edge function ----
    let targetPath;
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      targetPath = "/functions/v1" + path;      // /mcp -> /functions/v1/mcp, /mcp/token -> …/mcp/token
    } else if (path.startsWith("/functions/v1/mcp")) {
      targetPath = path;                        // passthrough (belt-and-suspenders for the form action)
    } else {
      targetPath = "/functions/v1/mcp";         // root or anything else behaves like the MCP endpoint
    }
    const targetUrl = SUPABASE + targetPath + url.search;

    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete("host"); // let fetch set the correct Host for Supabase
    const method = request.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

    const upstream = await fetch(targetUrl, { method, headers: fwdHeaders, body, redirect: "manual" });

    // Is this the login page (HTML we must render + rewrite)? Detect by path — reliable regardless of
    // what content-type the upstream/proxy reports — as well as by an html content-type.
    const upstreamCT = upstream.headers.get("content-type") || "";
    const isAuthorizePage = method === "GET" && path.endsWith("/authorize");
    const isHtml = isAuthorizePage || upstreamCT.includes("text/html");

    // Copy headers, but DROP the ones that become wrong once we read/transform the body
    // (content-length, content-encoding, transfer-encoding). Re-add CORS.
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-length");
    outHeaders.delete("content-encoding");
    outHeaders.delete("transfer-encoding");
    if (outHeaders.has("www-authenticate")) {
      outHeaders.set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
      );
    }
    for (const [k, v] of Object.entries(CORS)) outHeaders.set(k, v);

    if (isHtml) {
      let html = await upstream.text();
      // The Supabase login page posts to /functions/v1/mcp/authorize; rewrite to our /mcp/authorize
      // so the browser stays on this origin.
      html = html.split("/functions/v1/mcp/authorize").join("/mcp/authorize");
      outHeaders.set("Content-Type", "text/html; charset=utf-8"); // force correct rendering
      return new Response(html, { status: upstream.status, headers: outHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  },
};
