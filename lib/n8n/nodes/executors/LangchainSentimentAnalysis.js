import { callLlm } from './llm.js'
import { resolveValue } from './resolve.js'
import cds from '@sap/cds'

const log = cds.log('n8n:sentimentAnalysis')

const SYSTEM_PROMPT =
  'You are a sentiment analysis assistant. Classify the sentiment of the text as exactly one of: Positive, Negative, or Neutral. Respond with ONLY the single word.'

// Output port indices
const PORT_POSITIVE = 0
const PORT_NEGATIVE = 1
const PORT_NEUTRAL  = 2

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const model = params.model || undefined

  const items = normaliseInput(input)
  // outputs: [positiveItems, negativeItems, neutralItems]
  const outputs = [[], [], []]

  for (const item of items) {
    // Resolve inputText via expression or fall back to common field names
    let text = resolveValue(params.inputText, item, context.nodeOutputs ?? {})
    if (text == null || text === '') {
      text = item.json.text ?? item.json.input ?? item.json.chatInput ?? ''
    }
    text = String(text)

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: text },
    ]

    let portIndex = PORT_NEUTRAL
    let sentiment = 'Neutral'

    try {
      const response = (await callLlm(ctxCds, messages, { model, service: context.llmService })).trim()
      const lower = response.toLowerCase()

      if (lower === 'positive') {
        portIndex = PORT_POSITIVE
        sentiment = 'Positive'
      } else if (lower === 'negative') {
        portIndex = PORT_NEGATIVE
        sentiment = 'Negative'
      } else if (lower === 'neutral') {
        portIndex = PORT_NEUTRAL
        sentiment = 'Neutral'
      } else {
        log.warn(`sentimentAnalysis "${node.name}": unrecognized LLM response "${response}", routing to Neutral`)
        portIndex = PORT_NEUTRAL
        sentiment = 'Neutral'
      }
    } catch (err) {
      log.error(`sentimentAnalysis "${node.name}": ${err.message}`)
      // fall through: route to Neutral on error
    }

    outputs[portIndex].push({ json: { ...item.json, _sentiment: sentiment } })
  }

  return outputs
}
