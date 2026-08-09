function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export function execute(node, input, context) {
  const items = normaliseInput(input)
  return [items]
}
