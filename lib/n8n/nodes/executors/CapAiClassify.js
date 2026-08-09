import { resolveValue } from './resolve.js'
import { callLlm } from './llm.js'
import cds from '@sap/cds'

const log = cds.log('n8n:capAi')

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const model = params.model || undefined
  const systemPrompt = params.systemPrompt || 'You are a classification assistant.'
  const inputField = params.inputField || 'text'
  const categories = params.categories ?? []
  const includeCategory = params.includeCategory !== false

  const items = normaliseInput(input)
  const outputs = Array.from({ length: categories.length || 1 }, () => [])

  const categoryList = categories
    .map(c => `- ${c.name}${c.description ? ': ' + c.description : ''}`)
    .join('\n')

  for (const item of items) {
    const text = inputField in item.json
      ? String(item.json[inputField])
      : JSON.stringify(item.json)

    const userContent =
      `Classify the following text into exactly one of these categories:\n${categoryList}\n\n` +
      `Respond with ONLY the category name, nothing else.\n\nText: ${text}`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]

    let portIndex = 0
    try {
      const response = (await callLlm(ctxCds, messages, { model, service: context?.llmService })).trim()
      const idx = categories.findIndex(
        c => c.name.toLowerCase() === response.toLowerCase()
      )
      if (idx === -1) {
        log.warn(`CapAiClassify "${node.name}": LLM returned unrecognized category "${response}", routing to port 0`)
        const fallbackPort = params.fallback != null ? params.fallback : 0
        const outItem = includeCategory
          ? { json: { ...item.json, _category: response } }
          : item
        outputs[fallbackPort].push(outItem)
      } else {
        portIndex = idx
        const outItem = includeCategory
          ? { json: { ...item.json, _category: categories[portIndex].name } }
          : item
        outputs[portIndex].push(outItem)
      }
    } catch (err) {
      log.error(`CapAiClassify "${node.name}": ${err.message}`)
      outputs[0].push(item)
    }
  }

  return outputs
}
