// Drives the shim's `overview` tool with a stubbed upstream, so the merge, the ordering and — most
// importantly — the FAILURE behaviour are exercised without touching live data.
//
// The failure case is the point. A tool whose whole job is "here is where things stand" must never
// report a confident zero that actually means "the call failed" (rule 4.22).
//
// Run: node mcp-shim/overview-test.mjs
import worker from "./index.js";

const PACKS = {
  packs: [
    { slug: "calmness", name: "Calmness Pack", emoji: "🧘", status: "published",
      description: "Find your calm.", stats: { live_questions: 12, distinct_answer_words: 12, awaiting_review: 0 } },
    { slug: "focus", name: "Focus Pack", emoji: "🎯", status: "published",
      description: "Pay attention.", stats: { live_questions: 0, distinct_answer_words: 0, awaiting_review: 12 } },
    { slug: "kindness", name: "Kindness Pack", emoji: "😊", status: "published",
      description: "Be kind.", stats: { live_questions: 0, distinct_answer_words: 0, awaiting_review: 0 } },
    { slug: "confidence", name: "Confidence Pack", emoji: "💪", status: "published",
      description: "Believe.", stats: { live_questions: 11, distinct_answer_words: 11, awaiting_review: 0 } },
    { slug: "test-pack", name: "Test Pack", emoji: "💪", status: "draft",
      description: "", stats: { live_questions: 1, distinct_answer_words: 1, awaiting_review: 0 } },
  ],
};
const STATUS = {
  visibility: "Shared — every partner sees every contributor's submissions.",
  totals_all_contributors: { total: 24, awaiting_review: 12, approved: 12, rejected: 0 },
  by_contributor: { albert: { pending: 12, approved: 12, rejected: 0 } },
  by_pack: { focus: { pack: "Focus Pack", pending: 12, approved: 0, rejected: 0 } },
  your_own: { pending: 0, approved: 0, rejected: 0 },
};

let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + label + (detail ? "  \u2014 " + detail : ""));
  if (!cond) fail++;
};

function stubFetch({ packsOk = true, statusOk = true, status = 503 } = {}) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const tool = body.params.name;
    if (tool === "list_packs") {
      if (!packsOk) return new Response("nope", { status });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(PACKS) }] } });
    }
    if (tool === "review_status") {
      if (!statusOk) return new Response("nope", { status });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(STATUS) }] } });
    }
    throw new Error("unexpected upstream tool: " + tool);
  };
}

async function callOverview() {
  const req = new Request("https://shim.example/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "overview", arguments: {} } }),
  });
  const res = await worker.fetch(req, {}, { waitUntil() {} });
  const j = await res.json();
  return { res, j, o: j.result && j.result.structuredContent };
}

console.log("\nHappy path");
stubFetch();
let o = (await callOverview()).o;
check("counts the packs", o.content_status.packs_total === 5, o.content_status.packs_total + " packs");
check("separates published from draft",
  o.content_status.published === 4 && o.content_status.draft === 1);
check("totals live questions across packs",
  o.content_status.live_questions_total === 24, o.content_status.live_questions_total + " live");
check("totals awaiting review",
  o.content_status.awaiting_review_total === 12, o.content_status.awaiting_review_total + " awaiting");
check("counts empty packs rather than making the reader count",
  o.content_status.packs_empty === 1, o.content_status.packs_empty + " empty");
check("puts the pack that needs a human FIRST",
  o.packs[0].slug === "focus", "first = " + o.packs[0].slug);
check("empty packs sink to the bottom",
  o.packs[o.packs.length - 1].live_questions === 0 && o.packs[o.packs.length - 1].awaiting_review === 0,
  "last = " + o.packs[o.packs.length - 1].slug);
check("headline leads with what needs doing",
  /^12 question\(s\) waiting/.test(o.headline), o.headline);
check("carries the action menu", Array.isArray(o.what_you_can_do) && o.what_you_can_do.length >= 8,
  o.what_you_can_do.length + " actions");
check("states the approval invariant", /pm_review_approve/.test(o.what_you_cannot_do));
check("no problems flagged when both legs succeed", o.problems === undefined);
check("passes the review queue through", o.review_queue.by_pack.focus.pending === 12);

console.log("\nUpstream failure — the case that matters");
stubFetch({ statusOk: false });
o = (await callOverview()).o;
check("flags the failure instead of reporting a confident zero",
  Array.isArray(o.problems) && o.problems.length === 1, JSON.stringify(o.problems));
check("headline says PARTIAL, so it cannot be read as complete",
  /^Partial overview/.test(o.headline), o.headline);
check("still returns the half it DID get",
  o.content_status.packs_total === 5 && o.content_status.live_questions_total === 24);
check("tells the presenter not to pass partial numbers off as complete",
  /do not present partial numbers as complete/.test(o.how_to_show_this));

stubFetch({ packsOk: false, statusOk: false });
o = (await callOverview()).o;
check("both legs failing is reported as two problems", o.problems && o.problems.length === 2);
check("does not invent packs when the pack list is gone", o.packs.length === 0);

console.log("\nAuth failure must not look like an empty CMS");
stubFetch({ packsOk: false, statusOk: false, status: 401 });
let r = await callOverview();
check("propagates 401 rather than a 200 partial", r.res.status === 401, "HTTP " + r.res.status);
check("sends WWW-Authenticate so the client re-runs OAuth",
  /resource_metadata/.test(r.res.headers.get("WWW-Authenticate") || ""),
  r.res.headers.get("WWW-Authenticate") || "(none)");
check("returns an error, not a result", !!r.j.error && !r.j.result);
check("says something a person can act on", /sign in/i.test(r.j.error.message), r.j.error.message);
stubFetch({ packsOk: false, statusOk: false, status: 403 });
r = await callOverview();
check("403 is treated the same way", r.res.status === 403);
stubFetch({ statusOk: false, status: 503 });
r = await callOverview();
check("a genuine outage is still a PARTIAL 200, not a 401",
  r.res.status === 200 && /^Partial overview/.test(r.o.headline), "HTTP " + r.res.status);

console.log("\nDiscovery fallback — capabilities must not depend on instructions being obeyed");
globalThis.fetch = async () => Response.json({
  jsonrpc: "2.0", id: 1,
  result: { content: [{ type: "text", text: '{"ok":true}' }] },
});
async function callTool(name) {
  const res = await worker.fetch(new Request("https://shim.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }),
  }), {}, { waitUntil() {} });
  return (await res.json()).result;
}
let r2 = await callTool("propose_questions");
check("an ordinary tool result carries the capability menu", !!r2.also_available);
check("it lists what else is possible",
  Array.isArray(r2.also_available.you_can_also) && r2.also_available.you_can_also.length >= 6,
  (r2.also_available.you_can_also || []).length + " capabilities");
check("it points at the full picture", /overview/.test(r2.also_available.full_picture));
check("it restates the approval limit", /approves it in the CMS/.test(r2.also_available.cannot));
check("no tool names in the plain-language list",
  !/propose_questions|preview_questions|check_questions/.test(r2.also_available.you_can_also.join(" ")));
r2 = await callTool("preview_questions");
check("preview results carry it too, and keep their widget link",
  !!r2.also_available && !!r2._meta.ui.resourceUri);

console.log("\nView URI is content-addressed (host cache busting)");
{
  const listRes = await worker.fetch(new Request("https://shim.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/list" }),
  }), {}, { waitUntil() {} });
  const res = (await listRes.json()).result.resources;
  check("exactly ONE view is advertised", res.length === 1, res.length + " resources");
  const uri = res[0].uri;
  check("its URI carries a content hash", /^ui:\/\/positive-minds\/view-[a-z0-9]+$/.test(uri), uri);

  // The point of the hash: change the view, get a different URI, so a cached copy cannot be reused.
  const { VIEW_HTML } = await import("./view-app.js");
  const djb2 = (str) => { let h = 5381;
    for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36); };
  check("the hash is OF the view actually served", uri.endsWith(djb2(VIEW_HTML)));
  check("a different view would produce a different URI", djb2(VIEW_HTML) !== djb2(VIEW_HTML + " "));

  const readCur = await worker.fetch(new Request("https://shim.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri } }),
  }), {}, { waitUntil() {} });
  check("the advertised URI is readable", !!(await readCur.json()).result?.contents?.[0]?.text);

  // A STALE HASH must still resolve. The host caches tools/list, so after a shim deploy it keeps
  // asking for the hash it saw there — and serving only the current one produced "Failed to load
  // the MCP app" in production.
  for (const stale of ["ui://positive-minds/view-oxes5j", "ui://positive-minds/view-deadbeef"]) {
    const r = await worker.fetch(new Request("https://shim.example/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: stale } }),
    }), {}, { waitUntil() {} });
    const body = (await r.json()).result?.contents?.[0];
    check("a stale view hash still resolves: " + stale.split("-").pop(),
      !!body?.text && body.text === (await import("./view-app.js")).VIEW_HTML,
      body ? "served current html" : "NOT FOUND");
  }

  // Something that is not a view at all must still 404, or the check means nothing.
  {
    const r = await worker.fetch(new Request("https://shim.example/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "resources/read", params: { uri: "ui://somewhere/else" } }),
    }), {}, { waitUntil() {} });
    const j = await r.json();
    check("an unrelated ui:// URI is still refused", !!j.error, JSON.stringify(j.error || j.result).slice(0, 50));
  }

  // An in-flight session holding an old URI must not break when the view changes.
  for (const legacy of ["ui://positive-minds/question-preview", "ui://positive-minds/overview"]) {
    const r = await worker.fetch(new Request("https://shim.example/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: legacy } }),
    }), {}, { waitUntil() {} });
    check("legacy URI still served: " + legacy.split("/").pop(),
      !!(await r.json()).result?.contents?.[0]?.text);
  }
}

console.log("\nDeclaration");
globalThis.fetch = async () => Response.json({
  jsonrpc: "2.0", id: 1,
  result: { tools: [{ name: "preview_questions", description: "x", inputSchema: { type: "object" } }] },
});
const listRes = await worker.fetch(new Request("https://shim.example/mcp", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
}), {}, { waitUntil() {} });
const tools = (await listRes.json()).result.tools;
check("overview is declared", tools.some((t) => t.name === "overview"));
check("and is declared FIRST", tools[0].name === "overview", "first = " + tools[0].name);
check("marked read-only", tools.find((t) => t.name === "overview").annotations.readOnlyHint === true);
check("the widget link still gets injected too",
  !!tools.find((t) => t.name === "preview_questions")._meta.ui.resourceUri);

console.log(fail === 0 ? "\nALL OVERVIEW CHECKS PASS\n" : "\n" + fail + " CHECK(S) FAILED\n");
process.exit(fail === 0 ? 0 : 1);
