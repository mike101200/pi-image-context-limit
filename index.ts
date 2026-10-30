/**
 * image-context-limit — Pi extension
 * ─────────────────────────────────────────────────────────────────────────
 * Keeps the live LLM context below a hard image ceiling (default: 9 images,
 * i.e. it compacts before the 10th image is processed).
 *
 * "Live context" = the session branch after the most recent compaction
 * entry — i.e. exactly what the model will see on the next request.
 *
 * Flow A — user-attached images (intercepted before the run starts):
 *   `input` fires while the session is idle, before the message is
 *   appended. If `liveImages + attachedImages > MAX_IMAGES` the input is
 *   consumed (`action: "handled"`), a compaction is triggered through
 *   Pi's normal compaction pipeline (pi-vcc takes it over via its
 *   `session_before_compact` hook, selected by the `__pi_vcc__`
 *   instruction marker), and the prompt + images are re-injected
 *   afterwards. Text context is not dropped: compaction summarizes the
 *   history and the re-injected prompt lands in the kept tail.
 *
 * Flow B — images introduced by tool results (e.g. `read` on a .png):
 *   `tool_result` fires mid-run, where compacting is unsafe (a manual
 *   compaction aborts the active run). A flag is raised instead; when
 *   the run settles (`agent_settled`, session idle) the same
 *   compaction runs, and an invisible follow-up message resumes the
 *   agent from the summary (the same pattern pi-vcc uses).
 *
 * If pi-vcc is not installed, the triggered compaction simply falls back
 * to Pi's default (LLM) summarizer — this extension only triggers the
 * pipeline, it never writes the summary itself.
 *
 * All handlers fail open: any unexpected error inside a handler leaves
 * the normal Pi flow untouched, so the tool-use sequence can never be
 * broken by this extension.
 * ─────────────────────────────────────────────────────────────────────────
 */
import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

// ── Configuration ─────────────────────────────────────────────────────────
const MAX_IMAGES = 9; // hard ceiling for images in the live context
const PI_VCC_MARKER = "__pi_vcc__"; // pi-vcc compact-instruction marker
const AUTO_CONTINUE_CUSTOM_TYPE = "image-ctx-limit-auto-continue";
const COMPACT_TIMEOUT_MS = 120_000; // safety timeout for one compaction
const COUNT_IMAGE_URLS_IN_TEXT = false; // opt-in: also count image URLs in text blocks

// ── Types (structural, so we don't depend on pi-ai re-exports) ───────────
interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
interface TextBlock {
  type: "text";
  text: string;
}
interface QueuedInput {
  text: string;
  images: ImageBlock[];
}

// ── Session-scoped state ──────────────────────────────────────────────────
let reinjectDepth = 0; // >0 while we are re-injecting our own queued input
let compacting = false; // a compaction triggered by this extension is in flight
let pendingSettleCompact = false; // tool results pushed the count over; compact at settle
const pendingQueue: QueuedInput[] = [];

// ── Image counting ────────────────────────────────────────────────────────
const IMAGE_URL_RE = /https?:\/\/[^\s"'<>)\]]+\.(?:png|jpe?g|gif|webp|bmp|svg)(?::\d+(?:x\d+)?)?(?:\?[^\s"'<>)\]]*)?/gi;

function countUrls(text: string): number {
  return (text.match(IMAGE_URL_RE) ?? []).length;
}

function countImagesInContent(content: unknown): number {
  if (typeof content === "string") return COUNT_IMAGE_URLS_IN_TEXT ? countUrls(content) : 0;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image") n += 1; // base64 image block (user attach, tool result, …)
    else if (COUNT_IMAGE_URLS_IN_TEXT && block.type === "text" && typeof block.text === "string") {
      n += countUrls(block.text);
    }
  }
  return n;
}

/**
 * Count image blocks in the live context window: every branch entry after
 * the last compaction entry. This is what the model will actually see.
 */
function countLiveImages(ctx: ExtensionContext): number {
  const entries: any[] = ctx.sessionManager.getBranch();
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") {
      start = i + 1; // everything before belongs to the summarized past
      break;
    }
  }
  let n = 0;
  for (let i = start; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type === "message" && e.message) n += countImagesInContent(e.message.content);
    else if (e?.type === "custom_message") n += countImagesInContent(e.content);
  }
  return n;
}

// ── Compaction helper ─────────────────────────────────────────────────────
function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  } catch {
    /* non-interactive mode — ignore */
  }
}

/**
 * Trigger a compaction through Pi's normal pipeline (pi-vcc's
 * `session_before_compact` hook produces the summary) and resolve when it
 * finishes. Resolves `false` on failure/timeout — the caller always
 * continues the flow afterwards.
 */
function compactViaPiVcc(ctx: ExtensionContext): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    const timer = setTimeout(() => finish(false), COMPACT_TIMEOUT_MS);
    try {
      ctx.compact({
        customInstructions: PI_VCC_MARKER,
        onComplete: () => {
          clearTimeout(timer);
          finish(true);
        },
        onError: (err: Error) => {
          clearTimeout(timer);
          const benign = /nothing to compact|already compacted|compaction cancelled/i.test(err?.message ?? "");
          if (!benign) notify(ctx, `image-ctx-limit: compaction failed: ${err?.message ?? err}`, "warning");
          // Even a "nothing to compact" outcome is fine: re-inject the input.
          finish(benign);
        },
      });
    } catch (err: any) {
      clearTimeout(timer);
      notify(ctx, `image-ctx-limit: compaction error: ${err?.message ?? err}`, "error");
      finish(false);
    }
  });
}

// ── Re-injection ──────────────────────────────────────────────────────────
async function requeue(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  while (pendingQueue.length > 0 && reinjectDepth === 0) {
    const item = pendingQueue.shift()!;
    const content: string | (TextBlock | ImageBlock)[] =
      item.images.length > 0
        ? item.text
          ? ([{ type: "text", text: item.text } as TextBlock, ...item.images] as (TextBlock | ImageBlock)[])
          : item.images
        : item.text;
    reinjectDepth++;
    try {
      await pi.sendUserMessage(content, { expandPromptTemplates: true });
    } catch (err: any) {
      notify(ctx, `image-ctx-limit: could not re-send prompt after compaction: ${err?.message ?? err}`, "error");
    } finally {
      reinjectDepth--;
    }
  }
}

async function compactThenRequeue(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  compacting = true;
  try {
    const ok = await compactViaPiVcc(ctx);
    notify(
      ctx,
      ok
        ? `image-ctx-limit: context compacted before the ${MAX_IMAGES + 1}th image (pi-vcc)`
        : `image-ctx-limit: compaction skipped; continuing without it`,
      ok ? "info" : "warning",
    );
  } finally {
    compacting = false;
  }
  try {
    await requeue(ctx, pi);
  } catch (err: any) {
    notify(ctx, `image-ctx-limit: re-injection failed: ${err?.message ?? err}`, "error");
    // Last resort: drop the queue rather than wedge the session.
    pendingQueue.length = 0;
  }
}

// ── Extension factory ─────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // Flow A: intercept incoming user input while the session is idle.
  pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
    try {
      if (reinjectDepth > 0) return; // our own re-injection — never consume it
      const incoming = event.images?.length ?? 0;
      const live = countLiveImages(ctx);
      if (live + incoming <= MAX_IMAGES) return;

      if (event.streamingBehavior !== undefined) {
        // Mid-run steer/follow-up: compacting now would abort the active
        // run. Let the input through; compact when the run settles.
        pendingSettleCompact = true;
        return;
      }
      if (compacting) {
        // A compaction is already in flight; queue this input for the drain.
        pendingQueue.push({ text: event.text, images: event.images ?? [] });
        return { action: "handled" };
      }
      // Idle session: consume, compact, then re-inject.
      pendingQueue.push({ text: event.text, images: event.images ?? [] });
      void compactThenRequeue(ctx, pi);
      return { action: "handled" };
    } catch {
      return; // fail open — normal input processing
    }
  });

  // Flow B, step 1: watch tool results for image blocks introduced mid-run.
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    try {
      const imgs = event.content?.filter((c: any) => c?.type === "image").length ?? 0;
      if (imgs === 0) return;
      // The result may or may not be in the branch yet — counting it again
      // here only makes the trigger conservative (compact one image early).
      if (countLiveImages(ctx) + imgs > MAX_IMAGES) pendingSettleCompact = true;
    } catch {
      /* fail open */
    }
  });

  // Flow B, step 2: when the run has settled (session idle), compact and
  // resume the agent from the summary with an invisible follow-up.
  pi.on("agent_settled", (event: AgentSettledEvent, ctx: ExtensionContext) => {
    if (!pendingSettleCompact) return;
    pendingSettleCompact = false;
    void (async () => {
      try {
        // Re-check: by settle time the flagged results are in the branch.
        if (countLiveImages(ctx) <= MAX_IMAGES) return;
        const ok = await compactViaPiVcc(ctx);
        notify(
          ctx,
          ok
            ? `image-ctx-limit: compacted after tool results crossed the ${MAX_IMAGES}-image limit`
            : `image-ctx-limit: settle compaction skipped`,
          ok ? "info" : "warning",
        );
        if (ok && !event.aborted) {
          // Invisible auto-continue (pi-vcc pattern): resumes the agent from
          // the compaction summary without adding visible user noise.
          try {
            await pi.sendMessage(
              { customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [], display: false, details: undefined },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch {
            /* agent stays idle; the next user prompt starts clean */
          }
        }
      } catch {
        /* fail open */
      }
    })();
  });

  // Keep the invisible auto-continue marker out of the LLM payload: the
  // model simply continues from the compaction summary.
  pi.on("context", (event: any) => {
    try {
      const messages = event.messages.filter(
        (m: any) => !(m?.role === "custom" && m.customType === AUTO_CONTINUE_CUSTOM_TYPE),
      );
      if (messages.length !== event.messages.length) return { messages };
      return undefined;
    } catch {
      return undefined;
    }
  });

  // Safety net: custom-message-triggered runs (pi.sendMessage) bypass the
  // `input` event; flag a settle compaction if their images would exceed.
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    try {
      if (event.messageType !== "custom") return;
      const imgs = countImagesInContent((event as any).message?.content);
      if (imgs > 0 && countLiveImages(ctx) + imgs > MAX_IMAGES) pendingSettleCompact = true;
    } catch {
      /* fail open */
    }
  });

  // State hygiene across session switches / reloads.
  const resetState = () => {
    reinjectDepth = 0;
    compacting = false;
    pendingSettleCompact = false;
    pendingQueue.length = 0;
  };
  pi.on("session_start", resetState);
  pi.on("session_shutdown", resetState);

  // ── Manual controls (also useful for testing) ───────────────────────────
  pi.registerCommand("image-count", {
    description: "Show how many images are in the live context",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const n = countLiveImages(ctx);
      const status = n > MAX_IMAGES ? " OVER LIMIT" : n >= MAX_IMAGES ? " AT LIMIT" : "";
      ctx.ui.notify(`image-ctx-limit: live images ${n}/${MAX_IMAGES}${status}`, "info");
    },
  });

  pi.registerCommand("image-compact", {
    description: "Force an image-threshold compaction now (runs pi-vcc)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const n = countLiveImages(ctx);
      ctx.ui.notify(`image-ctx-limit: compacting now (live images: ${n})…`, "info");
      ctx.compact({
        customInstructions: PI_VCC_MARKER,
        onComplete: () => ctx.ui.notify("image-ctx-limit: compacted", "info"),
        onError: (err: Error) => ctx.ui.notify(`image-ctx-limit: ${err.message}`, "warning"),
      });
    },
  });
}
