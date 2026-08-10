import worker from "./index.js";

const logged = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes("pm_connector_log")) { logged.push(JSON.parse(init.body)); return new Response("", { status: 201 }); }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const ctx = { waitUntil(p) { return p; } };
let fail = 0;
const check = (l, c, d) => { console.log((c ? "  ✓ " : "  ✗ ") + l + (d ? "  — " + d : "")); if (!c) fail++; };

// A sign-in GET carrying every kind of secret a real flow can contain.
const SECRET = "pmk_SUPERSECRETVALUE12345";
await worker.fetch(new Request(
  "https://shim.test/mcp/authorize?client_id=cli_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb" +
  "&code_challenge=CHAL&state=st&token=" + SECRET + "&code=cod_LEAKME&code_verifier=VER_LEAKME",
  { method: "GET", headers: { "user-agent": "Mozilla/5.0", "cf-ray": "abc123", "cf-ipcountry": "GB" } }
), {}, ctx);
await new Promise(r => setTimeout(r, 30));

const rec = logged[logged.length - 1] || {};
const blob = JSON.stringify(logged);
console.log("\nRedaction");
check("no pmk token anywhere in the log", !blob.includes(SECRET));
check("no authorization code", !blob.includes("cod_LEAKME"));
check("no PKCE verifier", !blob.includes("VER_LEAKME"));
check("secrets are noted as present, not dropped silently",
  /token=<redacted:\d+ chars>/.test(rec.query || ""), (rec.query || "").slice(0, 90));
check("non-secret params ARE kept", /client_id=cli_abc/.test(rec.query || ""));

console.log("\nContext captured");
check("phase classified", rec.phase === "authorize", rec.phase);
check("http method", rec.method === "GET", rec.method);
check("cf-ray for cross-referencing", rec.cf_ray === "abc123");
check("country, to tell a browser from Anthropic's cloud", rec.country === "GB");
check("timing", typeof rec.ms === "number", rec.ms + "ms");

// Discovery: previously invisible, and the whole reason for this change.
logged.length = 0;
await worker.fetch(new Request("https://shim.test/.well-known/oauth-authorization-server",
  { headers: { "user-agent": "python-httpx/0.28.1" } }), {}, ctx);
await new Promise(r => setTimeout(r, 30));
console.log("\nDiscovery is now visible");
check("a discovery probe is logged at all", logged.length > 0);
check("classified as discovery", logged[0]?.phase === "discovery", logged[0]?.phase);
check("with its status", logged[0]?.status === 200, String(logged[0]?.status));

console.log(fail === 0 ? "\nALL LOGGING CHECKS PASS\n" : "\n" + fail + " FAILED\n");
process.exit(fail ? 1 : 0);
