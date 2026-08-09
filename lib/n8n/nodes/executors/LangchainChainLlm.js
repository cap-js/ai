import { resolveValue } from './resolve.js'
import { callLlm } from './llm.js'
import cds from '@sap/cds'

const log = cds.log('n8n:chainLlm')

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

function resolvePrompt(params, item, nodeOutputs) {
  const promptType = params.promptType ?? 'auto'
  if (promptType === 'define') {
    return resolveValue(params.text ?? '', item, nodeOutputs)
  }
  if (promptType === 'guardrails') {
    return item.json.guardrailsInput ?? item.json.chatInput ?? item.json.text ?? item.json.input ?? JSON.stringify(item.json)
  }
  // auto (default): pull from chatInput, falling back through common field names
  return item.json.chatInput ?? item.json.text ?? item.json.input ?? JSON.stringify(item.json)
}

function buildPrefixMessages(params, item, nodeOutputs) {
  // messages is a fixedCollection with multipleValues; n8n stores it as
  // { messageValues: [...] } but fall back gracefully for other shapes.
  const raw = params.messages
  if (!raw) return []

  let msgArray
  if (Array.isArray(raw)) {
    msgArray = raw
  } else if (Array.isArray(raw.messageValues)) {
    msgArray = raw.messageValues
  } else {
    const firstVal = Object.values(raw)[0]
    msgArray = Array.isArray(firstVal) ? firstVal : []
  }

  const typeToRole = {
    SystemMessagePromptTemplate: 'system',
    HumanMessagePromptTemplate: 'user',
    AIMessagePromptTemplate: 'assistant',
  }

  return msgArray
    .map(m => {
      const role = typeToRole[m.type] ?? 'user'
      const content = String(resolveValue(m.message ?? '', item, nodeOutputs) ?? '')
      return { role, content }
    })
    .filter(m => m.content)
}

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const model = params.model || undefined
  const batchSize = params.batching?.batchSize ?? 5

  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}
  const allOutputItems = []

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(async item => {
      const prompt = resolvePrompt(params, item, nodeOutputs)
      const prefixMessages = buildPrefixMessages(params, item, nodeOutputs)

      const messages = [
        ...prefixMessages,
        { role: 'user', content: String(prompt ?? '') },
      ]

      let response
      try {
        response = await callLlm(ctxCds, messages, { model, service: context.llmService })
      } catch (err) {
        log.error(`chainLlm "${node.name}": ${err.message}`)
        throw err
      }

      return { json: { ...item.json, text: response, output: response } }
    }))

    allOutputItems.push(...batchResults)
  }

  return [allOutputItems]
}
