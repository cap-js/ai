import { resolveValue } from './resolve.js'

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

/**
 * Executor for @n8n/n8n-nodes-langchain.chat
 *
 * In a live n8n session this node sends a message into the chat UI and
 * optionally waits for a reply.  In our CAP-native engine there is no
 * live session to interact with, so we handle the two operations:
 *
 *   send          — set the message as the output so _extractChatOutput
 *                   picks it up as the chat response.
 *   sendAndWait   — same as send; waiting for a reply is not supported
 *                   (we pass the items through so execution can continue).
 *
 * The node is the authoritative "this is the chat reply" signal —
 * _extractChatOutput prefers this node's output over all others.
 */
export function execute(node, input, context) {
  const items = normaliseInput(input)
  const params = node.parameters ?? {}
  const operation = params.operation ?? 'send'
  const nodeOutputs = context?.nodeOutputs ?? {}
  const firstItem = items[0] ?? { json: {} }

  const messageRaw = params.message ?? ''
  const message = String(resolveValue(messageRaw, firstItem, nodeOutputs) ?? messageRaw)

  // Wrap as { output: message } so _extractChatOutput finds it via the
  // standard output field priority, and the chat widget renders it as markdown.
  const responseItem = { json: { output: message } }

  if (operation === 'sendAndWait') {
    // In CAP engine we can't suspend and wait for user input — treat identically
    // to 'send' so _extractChatOutput finds responseItem without corrupting the
    // downstream data stream with extra items.
    return [[responseItem]]
  }

  // send
  return [[responseItem]]
}
