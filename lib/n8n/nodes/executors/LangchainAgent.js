import { callLlm } from './llm.js'
import { resolveValue } from './resolve.js'

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}
  const model = params.options?.model
  const systemPrompt = params.options?.systemMessage ?? params.systemMessage ?? ''
  const promptType = params.promptType ?? 'auto'

  const output = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const rv = (val) => resolveValue(val, item, nodeOutputs)

    // Resolve the user message
    let userText
    if (promptType === 'define') {
      userText = rv(params.text ?? '') || JSON.stringify(item.json)
    } else {
      // auto: use chatInput field if present, else serialise the whole item
      userText = item.json?.chatInput ?? item.json?.input ?? item.json?.text ?? item.json?.message ?? JSON.stringify(item.json)
    }

    const messages = []
    if (systemPrompt) messages.push({ role: 'system', content: rv(systemPrompt) })
    messages.push({ role: 'user', content: String(userText) })

    const response = await callLlm(context?.cds, messages, { model, service: context?.llmService })

    output.push({ json: { output: response, ...item.json }, pairedItem: { item: i } })
  }

  return [output]
}
