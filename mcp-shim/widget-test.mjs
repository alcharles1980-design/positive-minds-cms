// Drives the preview widget through the SEP-1865 lifecycle exactly as a host does, and asserts the
// things that were actually broken: that it handshakes, renders every question, and REPORTS ITS
// HEIGHT. The height report is the whole point — the widget looked "blank" because it rendered
// correctly into a frame nobody ever resized.
//
// Run: node mcp-shim/widget-test.mjs
import { JSDOM } from "/home/claude/node_modules/jsdom/lib/api.js";
import { PREVIEW_APP_HTML } from "./preview-app.js";

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

console.log(fail === 0 ? "\nALL WIDGET CHECKS PASS\n" : "\n" + fail + " CHECK(S) FAILED\n");
process.exit(fail === 0 ? 0 : 1);
