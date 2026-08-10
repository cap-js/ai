import { callLlm } from './llm.js'
import cds from '@sap/cds'

const log = cds.log('n8n:capAi')

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

const CODE_FENCE_RE = /```json?\n?([\s\S]*?)\n?```/

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const model = params.model || undefined
  const inputField = params.inputField || 'text'
  const fields = params.fields ?? []
  const mergeIntoItem = params.mergeIntoItem !== false

  const extraSystem = params.systemPrompt ? params.systemPrompt + '\n\n' : ''
  const fieldList = fields
    .map(f => `- ${f.name} (${f.type}): ${f.description}`)
    .join('\n')
  const systemContent =
    extraSystem +
    'You are a data extraction assistant. Extract fields from text and return valid JSON only.'

  const items = normaliseInput(input)
  const outputItems = []

  for (const item of items) {
    const text = inputField in item.json
      ? String(item.json[inputField])
      : JSON.stringify(item.json)

    const userContent =
      `Extract the following fields from the text and return them as a valid JSON object.\n` +
      `Only return the JSON object, nothing else.\n\n` +
      `Fields to extract:\n${fieldList}\n\nText: ${text}`

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ]

    try {
      const response = await callLlm(ctxCds, messages, { model, service: context?.llmService })
      const fenceMatch = response.match(CODE_FENCE_RE)
      const jsonStr = fenceMatch ? fenceMatch[1] : response.trim()
      const parsed = JSON.parse(jsonStr)

      const coerced = {}
      for (const f of fields) {
        const val = parsed[f.name]
        if (val === undefined) { coerced[f.name] = val; continue }
        if (f.type === 'number') {
          coerced[f.name] = Number(val)
        } else if (f.type === 'boolean') {
          coerced[f.name] = val === 'true' ? true : val === 'false' ? false : Boolean(val)
        } else {
          coerced[f.name] = val
        }
      }

      outputItems.push({
        json: mergeIntoItem ? { ...item.json, ...coerced } : coerced,
      })
    } catch (err) {
      log.warn(`CapAiExtract "${node.name}": failed to parse LLM response as JSON: ${err.message}`)
      outputItems.push({ json: { ...item.json, _extractionError: err.message } })
    }
  }

  return [outputItems]
}
