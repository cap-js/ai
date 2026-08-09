export function execute(node, input, _context) {
  const params = node.parameters ?? {}
  const maxItems = Number(params.maxItems ?? 1)
  const keep = params.keep ?? 'firstItems'
  const items = normaliseInput(input)

  if (maxItems >= items.length) return [items]

  if (keep === 'lastItems') {
    return [items.slice(items.length - maxItems)]
  }
  // default: firstItems
  return [items.slice(0, maxItems)]
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}
