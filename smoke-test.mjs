// Smoke test: load the extension with jiti (Pi's loader) against a mock
// ExtensionAPI, then exercise image counting and the interception flows.
// Resolve jiti from Pi's managed install (no local node_modules needed).
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? "C:/Users/mihai/.pi/agent/install";
const releases = readdirSync(`${installRoot}/releases`).sort();
const jitiPath = `${installRoot}/releases/${releases[releases.length - 1]}/node_modules/jiti`;
const { createJiti } = require(jitiPath);

const jiti = createJiti(import.meta.url, { tryNative: false });
const mod = await jiti.import("./index.ts");
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

const handlers = {};
const commands = {};
const sent = [];
const compactCalls = [];

const pi = {
  on: (name, fn) => { handlers[name] = fn; return () => { delete handlers[name]; }; },
  registerCommand: (name, opts) => { commands[name] = opts; },
  registerTool: () => {},
  registerShortcut: () => {},
  registerFlag: () => {},
  sendMessage: async () => {},
  sendUserMessage: async (content, opts) => { sent.push({ content, opts }); },
  events: { on: () => {}, emit: async () => undefined },
};

factory(pi);
console.log("registered handlers:", Object.keys(handlers).join(", "));
console.log("registered commands:", Object.keys(commands).join(", "));
if (!handlers.input || !handlers.tool_result || !handlers.agent_settled) throw new Error("missing core handlers");

// ── mock session: one compaction, then 9 messages with 1 image each ──
const img = (i) => ({ type: "image", data: `data:image/png;base64,AAA${i}`, mimeType: "image/png" });
const branch = [
  { id: "e0", type: "message", message: { role: "user", content: [{ type: "image", data: "old", mimeType: "image/png" }] } },
  { id: "c1", type: "compaction", summary: "old summary", firstKeptEntryId: "e2" },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `e${i + 2}`,
    type: "message",
    message: { role: "user", content: [{ type: "text", text: `msg ${i}` }, img(i)] },
  })),
];

let compactResult;
const ctx = {
  hasUI: false,
  ui: { notify: (m, k) => console.log(`  [notify:${k}] ${m}`) },
  sessionManager: { getBranch: () => branch },
  compact: (options) => {
    compactCalls.push(options);
    // simulate completion on next tick
    queueMicrotask(() => options?.onComplete?.({ ok: true }));
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Case 1: 9 live + 1 incoming = 10 → intercepted, compacted, re-injected
let result = handlers.input({ type: "input", text: "here is the 10th", images: [img(99)], source: "interactive" }, ctx);
if (JSON.stringify(result) !== JSON.stringify({ action: "handled" })) throw new Error(`case1: expected handled, got ${JSON.stringify(result)}`);
await wait(20);
console.log("case1: input intercepted ✓");
if (compactCalls.length !== 1 || compactCalls[0].customInstructions !== "__pi_vcc__") throw new Error("case1: compact not called with pi-vcc marker");
if (sent.length !== 1) throw new Error(`case1: expected re-injection, got ${sent.length}`);
const re = sent[0].content;
if (!Array.isArray(re) || re.length !== 2 || re[0].type !== "text" || re[1].type !== "image") throw new Error("case1: bad re-injected content");
console.log("case1: compacted via pi-vcc marker + prompt re-injected ✓");

// Case 2: 3 live + 1 incoming = 4 → passes through
branch.length = 4; // compaction + 3 messages (rebuild simple)
const smallBranch = [
  { id: "c1", type: "compaction", summary: "s", firstKeptEntryId: "e2" },
  ...Array.from({ length: 3 }, (_, i) => ({ id: `e${i + 2}`, type: "message", message: { role: "user", content: [{ type: "text", text: `m${i}` }, img(i)] } })),
];
ctx.sessionManager.getBranch = () => smallBranch;
result = handlers.input({ type: "input", text: "no images", images: [img(5)], source: "interactive" }, ctx);
if (result !== undefined) throw new Error(`case2: expected pass-through, got ${JSON.stringify(result)}`);
console.log("case2: below threshold passes through ✓");

// Case 3: tool result pushes over → settle compaction
const before = compactCalls.length;
handlers.tool_result({ type: "tool_result", toolCallId: "t1", input: {}, content: [img(1), img(2), img(3), img(4), img(5), img(6), img(7)] }, ctx); // 3+7=10
// by settle time the tool result IS in the branch (real sessions persist it)
smallBranch.push({ id: "tr1", type: "message", message: { role: "toolResult", content: [img(1), img(2), img(3), img(4), img(5), img(6), img(7)] } });
handlers.agent_settled({ type: "agent_settled", aborted: false }, ctx);
await wait(20);
if (compactCalls.length !== before + 1) throw new Error(`case3: expected settle compaction (${compactCalls.length} vs ${before + 1})`);
console.log("case3: tool-result threshold → settle compaction ✓");

// Case 4: mid-run input (steer) does NOT consume
let consumed = false;
const r4 = handlers.input({ type: "input", text: "steer with image", images: [img(1)], source: "interactive", streamingBehavior: "steer" }, ctx);
consumed = r4?.action === "handled";
if (consumed) throw new Error("case4: mid-run input must not be consumed");
console.log("case4: mid-run steer input passes through (flag set for settle) ✓");

console.log("\nALL SMOKE TESTS PASSED");
