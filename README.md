# pi-image-context-limit

Pi-CLI extension that automates **pi-vcc-based context compaction driven by image
count**. It keeps at most **9 images** in the live LLM context and compacts
*before* the 10th image is processed.

## How it works

- **Live context** = session branch entries after the last `compaction` entry
  (exactly what the model sees). Images are counted as `type:"image"` content
  blocks (base64) in user messages, tool results, and custom messages.
- **User-attached images** — intercepted at the `input` event (session idle,
  before the run starts): the input is consumed (`action:"handled"`), a
  compaction runs through Pi's normal pipeline (pi-vcc takes it over via its
  `session_before_compact` hook, selected by the `__pi_vcc__` marker), and the
  prompt + images are re-injected afterwards. Nothing is lost: history becomes
  a pi-vcc summary, your new prompt lands in the kept tail.
- **Images from tool results** (e.g. `read` on a `.png`) — a manual compaction
  mid-run would abort the active run, so a flag is raised at `tool_result` and
  the compaction runs at `agent_settled` (session idle), followed by an
  invisible auto-continue message so the agent resumes from the summary.
- **Fail-open everywhere**: any internal error leaves the normal Pi flow
  untouched; the tool-use sequence can never be broken by this extension.
- If pi-vcc is not installed, compactions fall back to Pi's default LLM
  summarizer (this extension only triggers the pipeline).

## Files

- `index.ts` — the extension (single file, no dependencies beyond Pi itself)
- `smoke-test.mjs` — offline functional test (mock ExtensionAPI)

## Install

Pi loads extensions from:

- **global**: `~/.pi/agent/extensions/` → `C:\Users\mihai\.pi\agent\extensions\`
- **project**: `<project>/.pi/extensions/`

Place the file as a direct `.ts` file or in a subdirectory with `index.ts`:

```powershell
# global (recommended — applies to every project)
copy index.ts "$env:USERPROFILE\.pi\agent\extensions\image-context-limit\index.ts"

# or per-project
# copy index.ts <project>\.pi\extensions\image-context-limit\index.ts
```

No compilation step — Pi loads TypeScript directly via jiti.

## Register / verify

Extensions in the directories above are loaded automatically on next start.
For a one-off run without installing:

```bash
pi --extension ./index.ts
```

## Test

1. **Offline smoke test** (no model needed):

   ```bash
   node smoke-test.mjs
   ```

   Exercises: threshold interception at 9+1, below-threshold pass-through,
   tool-result → settle compaction, mid-run steer pass-through.

2. **Live test in Pi** (needs pi-vcc installed: `pi install npm:@sting8k/pi-vcc`):

   ```
   /image-count                 → "live images 0/9"
   ```

   Then send 9 messages each attaching one image (or have the agent `read`
   nine `.png` files), then send one more prompt with an image:

   - you should see the toast `image-ctx-limit: context compacted before the
     10th image (pi-vcc)` and the prompt being processed right after,
   - `/image-count` afterwards reports `1/9` (only the new image is live;
     the 9 old ones are in the pi-vcc summary, recoverable via `vcc_recall`).

3. **Manual controls**:

   - `/image-count` — current live image count
   - `/image-compact` — force a pi-vcc compaction right now

## Configuration

Edit the constants at the top of `index.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `MAX_IMAGES` | `9` | hard ceiling for images in the live context |
| `COMPACT_TIMEOUT_MS` | `120000` | safety timeout per compaction |
| `COUNT_IMAGE_URLS_IN_TEXT` | `false` | also count image URLs found in text blocks |

## Notes / limits

- If your Pi setting `compaction.keepRecentTokens` is so large that a
  10-image session still "fits" in the always-kept recent part, Pi refuses to
  compact at all (`Nothing to compact`) and the 10th image will be let through
  — that guard belongs to Pi core.
- `pi-vcc-config.json` → `overrideDefaultCompaction: true` (the default) means
  pi-vcc handles every compaction; the explicit `__pi_vcc__` marker sent by
  this extension makes it work even if that setting is `false`.
