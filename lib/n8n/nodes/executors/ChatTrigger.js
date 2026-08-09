function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export function execute(node, input, _context) {
  const items = normaliseInput(input)
  const first = items[0]?.json ?? {}
  // The webhook handler places chatInput and sessionId on the trigger data.
  // Pass them through as a single item so downstream nodes can access $json.chatInput.
  const chatInput = first.chatInput ?? first.input ?? first.text ?? first.message ?? ''
  const sessionId = first.sessionId ?? ''
  return [[{ json: { chatInput, sessionId, ...first } }]]
}
