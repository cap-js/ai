function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export function execute(node, input, context) {
  const items = normaliseInput(input)
  const first = items[0]?.json ?? {}

  // If the input already carries error context (passed from the engine), use it.
  if (first.execution || first.error) {
    return [items]
  }

  // Otherwise wrap in the standard n8n ErrorTrigger envelope shape.
  const errorItem = {
    json: {
      execution: {
        id: context?.executionId ?? 'unknown',
        mode: 'trigger',
        url: '',
      },
      workflow: {
        id: context?.workflowId ?? '',
        name: '',
      },
      error: {
        message: first.error?.message ?? first.message ?? 'Unknown error',
        stack: first.error?.stack ?? '',
      },
    },
  }
  return [[errorItem]]
}
