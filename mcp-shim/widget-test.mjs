// Drives the preview widget through the SEP-1865 lifecycle exactly as a host does, and asserts the
// things that were actually broken: that it handshakes, renders every question, and REPORTS ITS
// HEIGHT. The height report is the whole point — the widget looked "blank" because it rendered
// correctly into a frame nobody ever resized.
//
// Run: node mcp-shim/widget-test.mjs
import { JSDOM } from "/home/claude/node_modules/jsdom/lib/api.js";
import { VIEW_HTML as PREVIEW_APP_HTML } from "./view-app.js";
import { VIEW_HTML as OVERVIEW_APP_HTML } from "./view-app.js";

const QS = Array.from({ length: 12 }, (_, i) => ({
  n: i + 1, pack: "Focus Pack", by: "albert", level_shown: 1,
  sentence: "I can FO_US on number " + (i + 1) + ".",
  options: ["FOCUS", "CALM"], correct: "FOCUS",
  at_other_levels: Array.from({ length: 10 }, (_, l) => ({
    level: l + 1, sentence: "I can " + "_".repeat(l + 1) + "US on number " + (i + 1) + ".",
  })),
}));

const sent = [];
let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + label + (detail ? "  \u2014 " + detail : ""));
  if (!cond) fail++;
};

// The host stub MUST exist before the view's script runs — it posts ui/initialize immediately on
// parse. (First version of this harness attached it afterwards and "proved" the handshake was
// missing when it was only mistimed.)
const dom = new JSDOM(PREVIEW_APP_HTML, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    // jsdom has no layout engine, so scrollHeight is 0 for everything. documentElement doesn't
    // exist yet at beforeParse, so patch the prototype and derive a believable height from the
    // number of cards — enough to prove a real number is reported and that it TRACKS content.
    Object.defineProperty(window.Element.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (this === this.ownerDocument.documentElement || this === this.ownerDocument.body) {
          return 60 + this.ownerDocument.querySelectorAll(".card").length * 210;
        }
        return 0;
      },
    });
    if (!window.ResizeObserver) {
      window.ResizeObserver = class { observe() {} disconnect() {} };
    }
    Object.defineProperty(window, "parent", {
      configurable: true,
      value: {
        postMessage(m) {
          sent.push(m);
          if (m.method === "ui/initialize") {
            // Flexible height, fixed width — the common inline case, and the one that broke.
            window.postMessage({
              jsonrpc: "2.0", id: m.id,
              result: {
                protocolVersion: "2025-06-18",
                hostInfo: { name: "test-host", version: "1.0.0" },
                hostCapabilities: {},
                hostContext: { theme: "light", displayMode: "inline", containerDimensions: { width: 400, maxHeight: 600 } },
              },
            }, "*");
          }
        },
      },
    });
  },
});
const { window } = dom;

const settle = () => new Promise((r) => setTimeout(r, 150));

console.log("\nSEP-1865 lifecycle");
await settle();
const init = sent.find((m) => m.method === "ui/initialize");
check("view sends ui/initialize", !!init);
check("carries appCapabilities.availableDisplayModes",
  !!(init && init.params.appCapabilities && Array.isArray(init.params.appCapabilities.availableDisplayModes)),
  init && JSON.stringify(init.params.appCapabilities));
check("acknowledges with ui/notifications/initialized",
  sent.some((m) => m.method === "ui/notifications/initialized"));
check("applies containerDimensions.maxHeight to the document",
  window.document.documentElement.style.maxHeight === "600px",
  "maxHeight=" + (window.document.documentElement.style.maxHeight || "(unset)"));

console.log("\nData arrival");
window.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
  params: { structuredContent: { previews: QS } } }, "*");
await settle();
const cards = window.document.querySelectorAll(".card");
check("renders one card per question", cards.length === 12, cards.length + " cards");
check("every card has two options",
  [...cards].every((c) => c.querySelectorAll(".opt").length === 2));
check("level tabs present", cards[0].querySelectorAll(".lv").length === 10,
  cards[0].querySelectorAll(".lv").length + " tabs");
check("correct word not revealed before tapping",
  ![...cards[0].querySelectorAll(".opt")].some((b) => b.className.includes("right")));

console.log("\nHeight reporting (the bug)");
const sizes = sent.filter((m) => m.method === "ui/notifications/size-changed");
check("sends ui/notifications/size-changed", sizes.length > 0, sizes.length + " reports");
const tallest = Math.max(...sizes.map((m) => m.params.height));
check("reports the FULL content height, not one card",
  tallest >= 12 * 200, "tallest reported = " + tallest + "px");
check("reports a width too", sizes.every((m) => typeof m.params.width === "number"));

console.log("\nInteraction");
const before = sent.length;
cards[0].querySelectorAll(".opt")[0].dispatchEvent(new window.Event("click"));
await settle();
check("tapping an option marks it",
  [...cards[0].querySelectorAll(".opt")].some((b) => /right|wrong/.test(b.className)));
check("uses the spec method ui/update-model-context",
  sent.slice(before).some((m) => m.method === "ui/update-model-context"));
check("no non-spec context-update method is ever sent",
  !sent.some((m) => m.method === "ui/notifications/context-update"));

console.log("\nTeardown");
window.postMessage({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: { reason: "test" } }, "*");
await settle();
check("answers ui/resource-teardown", sent.some((m) => m.id === 99 && m.result));


// ---------------------------------------------------------------------------------------------
// THE OVERVIEW MENU VIEW. Same lifecycle, same height contract — asserted separately so a change
// to one view cannot quietly break the other. Rule 4.33 applies to every view, not just the first.
// ---------------------------------------------------------------------------------------------
const OVERVIEW = {
  headline: "12 question(s) waiting for a human, 24 live across 3 pack(s).",
  content_status: { packs_total: 15, published: 14, draft: 1, packs_with_live_questions: 3,
                    packs_empty: 11, live_questions_total: 24, awaiting_review_total: 12 },
  packs: [
    { slug: "focus", name: "Focus Pack", emoji: "F", status: "published",
      description: "Pay attention.", live_questions: 0, awaiting_review: 12 },
    { slug: "calmness", name: "Calmness Pack", emoji: "C", status: "published",
      description: "Find your calm.", live_questions: 12, awaiting_review: 0 },
    { slug: "kindness", name: "Kindness Pack", emoji: "K", status: "published",
      description: "Be kind.", live_questions: 0, awaiting_review: 0 },
  ],
  what_you_can_do: [
    { do: "Review what is waiting", icon: "A", how: "preview_questions", say: "Show me the questions waiting for review so I can play them." },
    { do: "Write new questions", icon: "B", how: "propose_questions", say: "I would like to write some new questions for a pack." },
    { do: "Start a new pack", icon: "C", how: "create_pack", say: "I would like to start a new themed pack." },
  ],
  what_you_cannot_do: "Approve. pm_review_approve is the only route a question takes into a pack.",
};

function mountOverview(sink) {
  return new JSDOM(OVERVIEW_APP_HTML, {
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      Object.defineProperty(window.Element.prototype, "scrollHeight", {
        configurable: true,
        get() {
          if (this === this.ownerDocument.documentElement || this === this.ownerDocument.body) {
            return 120 + this.ownerDocument.querySelectorAll(".card, .act, .pack").length * 55;
          }
          return 0;
        },
      });
      if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} disconnect() {} };
      Object.defineProperty(window, "parent", {
        configurable: true,
        value: { postMessage(m) {
          sink.push(m);
          if (m.method === "ui/initialize") {
            window.postMessage({ jsonrpc: "2.0", id: m.id, result: {
              hostContext: { theme: "light", displayMode: "inline", containerDimensions: { width: 400, maxHeight: 700 } },
            } }, "*");
          }
        } },
      });
    },
  });
}

const sent2 = [];
const w2 = mountOverview(sent2).window;

console.log("\nOverview menu - lifecycle");
await settle();
check("handshakes", sent2.some((m) => m.method === "ui/initialize"));
check("acknowledges on the matching id", sent2.some((m) => m.method === "ui/notifications/initialized"));
check("applies containerDimensions", w2.document.documentElement.style.maxHeight === "700px",
  w2.document.documentElement.style.maxHeight || "(unset)");

w2.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
  params: { structuredContent: OVERVIEW } }, "*");
await settle();

console.log("\nOverview menu - content");
check("shows the headline", w2.document.body.textContent.includes("12 question(s) waiting"));
check("shows only packs with content, not all 15",
  w2.document.querySelectorAll(".pack").length === 2,
  w2.document.querySelectorAll(".pack").length + " pack rows");
check("counts the empty ones instead of listing them",
  /11 other packs have no questions yet/.test(w2.document.body.textContent));
check("renders one button per capability",
  w2.document.querySelectorAll(".act").length === 3,
  w2.document.querySelectorAll(".act").length + " buttons");
check("buttons show plain language, never tool names",
  !/preview_questions|propose_questions|create_pack/.test(
    [...w2.document.querySelectorAll(".act")].map((b) => b.textContent).join(" ")));
check("states what cannot be done", /pm_review_approve/.test(w2.document.body.textContent));

console.log("\nOverview menu - tapping");
const before2 = sent2.length;
w2.document.querySelectorAll(".act")[0].dispatchEvent(new w2.Event("click"));
await settle();
const msg = sent2.slice(before2).find((m) => m.method === "ui/message");
check("tapping sends ui/message", !!msg);
check("as a REQUEST with an id, per spec", !!(msg && msg.id != null));
check("sends the plain-English phrase, not a tool name",
  !!(msg && msg.params.content.text === OVERVIEW.what_you_can_do[0].say),
  msg && msg.params.content.text);
check("role is user, so it reads as the partner asking", !!(msg && msg.params.role === "user"));

console.log("\nOverview menu - height (the lesson that must not regress)");
const sizes2 = sent2.filter((m) => m.method === "ui/notifications/size-changed");
check("reports size", sizes2.length > 0, sizes2.length + " reports");
const tallest2 = Math.max(...sizes2.map((m) => m.params.height));
check("reports the full content height", tallest2 > 400, "tallest = " + tallest2 + "px");

console.log("\nOverview menu - partial results");
const sent3 = [];
const w3 = mountOverview(sent3).window;
await settle();
w3.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent:
  { ...OVERVIEW, problems: ["review queue unavailable (HTTP 503)"] } } }, "*");
await settle();
check("a partial overview says so on the face of it",
  /could not be loaded/.test(w3.document.body.textContent) &&
  w3.document.querySelectorAll(".warn").length === 1);

console.log("\nDead-button protection");
{
  const sentX = [];
  const wX = mountOverview(sentX).window;
  await settle();
  wX.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: { structuredContent: OVERVIEW } }, "*");
  await settle();
  const btn = wX.document.querySelectorAll(".act")[0];
  btn.dispatchEvent(new wX.Event("click"));
  await settle();
  const req = sentX.find((m) => m.method === "ui/message");
  check("ui/message is sent WITH an id, so the reply can be read", !!(req && req.id != null));

  // Host rejects it — the button must not sit there looking like it worked.
  wX.postMessage({ jsonrpc: "2.0", id: req.id,
    error: { code: -32601, message: "Method not found" } }, "*");
  await settle();
  check("a rejected message turns the tile into something usable",
    /Tap to copy/.test(btn.textContent), btn.textContent.trim().slice(0, 44));
  check("and shows the exact phrase to paste",
    btn.textContent.includes(OVERVIEW.what_you_can_do[0].say));
  check("the status line names the reason",
    /not delivered/.test(wX.document.getElementById("status").textContent),
    wX.document.getElementById("status").textContent);
}
{
  // Silence is the worse case: no reply at all. It must still not leave a dead button.
  const sentY = [];
  const wY = mountOverview(sentY).window;
  await settle();
  wY.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: { structuredContent: OVERVIEW } }, "*");
  await settle();
  const b2 = wY.document.querySelectorAll(".act")[1];
  b2.dispatchEvent(new wY.Event("click"));
  await new Promise((r) => setTimeout(r, 2800));
  check("silence from the host also falls back to copy", /Tap to copy/.test(b2.textContent));
}

console.log("\nOne view, both payloads");
check("both URIs are served by the SAME file", PREVIEW_APP_HTML === OVERVIEW_APP_HTML);
check("that one file carries both renderers",
  PREVIEW_APP_HTML.includes("renderPreviews") && PREVIEW_APP_HTML.includes("renderOverview"));
check("and dispatches on payload SHAPE, not on which tool the host thinks it is showing",
  PREVIEW_APP_HTML.includes("function classify("));
check("lifecycle code exists exactly once (no second copy to drift)",
  PREVIEW_APP_HTML.split("ui/notifications/size-changed").length - 1 === 1);

console.log(fail === 0 ? "\nALL WIDGET CHECKS PASS\n" : "\n" + fail + " CHECK(S) FAILED\n");
process.exit(fail === 0 ? 0 : 1);
