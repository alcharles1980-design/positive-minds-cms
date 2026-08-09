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

function stubFetch({ packsOk = true, statusOk = true } = {}) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const tool = body.params.name;
    if (tool === "list_packs") {
      if (!packsOk) return new Response("nope", { status: 503 });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(PACKS) }] } });
    }
    if (tool === "review_status") {
      if (!statusOk) return new Response("nope", { status: 503 });
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
  return j.result.structuredContent;
}

console.log("\nHappy path");
stubFetch();
let o = await callOverview();
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
o = await callOverview();
check("flags the failure instead of reporting a confident zero",
  Array.isArray(o.problems) && o.problems.length === 1, JSON.stringify(o.problems));
check("headline says PARTIAL, so it cannot be read as complete",
  /^Partial overview/.test(o.headline), o.headline);
check("still returns the half it DID get",
  o.content_status.packs_total === 5 && o.content_status.live_questions_total === 24);
check("tells the presenter not to pass partial numbers off as complete",
  /do not present partial numbers as complete/.test(o.how_to_show_this));

stubFetch({ packsOk: false, statusOk: false });
o = await callOverview();
check("both legs failing is reported as two problems", o.problems && o.problems.length === 2);
check("does not invent packs when the pack list is gone", o.packs.length === 0);

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
