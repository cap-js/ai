import { resolveValue } from './resolve.js'

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

/**
 * Executor for n8n-nodes-base.respondToWebhook
 *
 * In a CAP-native execution there is no live HTTP request to respond to.
 * Instead, this node's output IS the response — it marks the items that
 * the chat trigger route will read as the reply text.
 *
 * Supported respondWith values:
 *   'firstIncomingItem'  — pass first input item (default for chat)
 *   'allIncomingItems'   — pass all input items
 *   'text'               — literal responseBody string
 *   'json'               — parse responseBody as JSON
 *   'noData'             — output empty item, used for side-effect-only flows
 *
 * The chat route looks for output ?? text ?? message on the first item.json.
 */
export function execute(node, input, context) {
  const items = normaliseInput(input)
  const params = node.parameters ?? {}
  const respondWith = params.respondWith ?? 'firstIncomingItem'
  const nodeOutputs = context?.nodeOutputs ?? {}
  const firstItem = items[0] ?? { json: {} }

  switch (respondWith) {
    case 'text': {
      const raw = params.responseBody ?? ''
      const text = String(resolveValue(raw, firstItem, nodeOutputs) ?? raw)
      return [[{ json: { output: text } }]]
    }
    case 'json': {
      const raw = params.responseBody ?? '{}'
      const resolved = resolveValue(raw, firstItem, nodeOutputs) ?? raw
      let parsed
      try { parsed = typeof resolved === 'string' ? JSON.parse(resolved) : resolved }
      catch { parsed = { output: String(resolved) } }
      return [[{ json: parsed }]]
    }
    case 'noData':
      return [[{ json: {} }]]
    case 'allIncomingItems':
      return [items]
    default: // 'firstIncomingItem' and anything else
      return [[firstItem]]
  }
}
