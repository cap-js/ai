/**
 * SplitInBatches.js — n8n-nodes-base.splitInBatches executor
 *
 * Splits input items into batches and yields one batch at a time.
 *
 * In real n8n this is a stateful loop: the workflow is re-executed from this
 * node on each iteration, looping back via the "loop" output until all items
 * are consumed, then firing the "done" output.
 *
 * In the CAP engine we emulate this with `context.stepState`, a plain object
 * that the engine persists between successive invocations of this node within
 * the same workflow execution.
 *
 * Output ports differ by typeVersion:
 *   V1:  1 output — only a "loop" port (single pass, no done signal)
 *   V2:  port 0 = "loop", port 1 = "done"
 *   V3+: port 0 = "done", port 1 = "loop"  (outputNames flipped in v3)
 *
 * Parameters:
 *   parameters.batchSize          — items per batch (default 1, min 1)
 *   parameters.options.reset      — restart from beginning on this call
 *
 * Return shape (extended executor contract):
 *   { outputs: Array[], nextStepState: object | null }
 */

export function execute(node, input, context) {
  const params = node.parameters ?? {}
  const batchSize = Math.max(1, parseInt(params.batchSize ?? 1, 10))
  const options = params.options ?? {}
  const reset = options.reset === true
  const typeVersion = node.typeVersion ?? 3

  const stepState = (!reset && context?.stepState) ? context.stepState : null
  const items = normaliseInput(input)

  // Helper: pack [doneItems, loopItems] into correct port order for this version
  function pack(doneItems, loopItems) {
    if (typeVersion <= 1) return [loopItems]           // V1: single port
    if (typeVersion === 2) return [loopItems, doneItems] // V2: loop=0, done=1
    return [doneItems, loopItems]                        // V3+: done=0, loop=1
  }

  // ── First invocation (or reset) ──────────────────────────────────────────
  if (!stepState) {
    if (items.length === 0) {
      return { outputs: pack([], []), nextStepState: null }
    }

    const batch = items.slice(0, batchSize)
    const remaining = items.slice(batchSize)

    return {
      outputs: pack([], batch),
      nextStepState: {
        remainingItems: remaining,
        processedItems: [],
        allItems: items,
      },
    }
  }

  // ── Subsequent invocations ───────────────────────────────────────────────
  const remaining = stepState.remainingItems ?? []
  const processedItems = stepState.processedItems ?? []
  const allItems = stepState.allItems ?? items
  const nowProcessed = [...processedItems, ...items]

  if (remaining.length === 0) {
    return {
      outputs: pack(nowProcessed.length ? nowProcessed : allItems, []),
      nextStepState: null,
    }
  }

  const batch = remaining.slice(0, batchSize)
  const afterBatch = remaining.slice(batchSize)

  return {
    outputs: pack([], batch),
    nextStepState: {
      remainingItems: afterBatch,
      processedItems: nowProcessed,
      allItems,
    },
  }
}

function normaliseInput(input) {
  if (!input) return []
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}
