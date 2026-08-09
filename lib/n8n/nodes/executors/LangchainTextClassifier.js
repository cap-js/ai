import { callLlm } from './llm.js'
import { resolveValue } from './resolve.js'
import cds from '@sap/cds'

const log = cds.log('n8n:textClassifier')

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

/**
 * Build the system prompt for the LLM.
 */
function buildSystemPrompt(categories, multiClass, systemPromptTemplate) {
  if (systemPromptTemplate) return systemPromptTemplate

  const list = categories.map(c =>
    c.description ? `${c.category} (${c.description})` : c.category
  ).join(', ')

  if (multiClass) {
    return `Classify the following text into all applicable categories from this list: ${list}. Respond with a JSON array of category names, e.g. ["Category1","Category2"]. Include only categories that clearly apply.`
  }
  return `Classify the following text into one of these categories: ${list}. Respond with ONLY the category name.`
}

/**
 * Parse the LLM response into an array of matched category names.
 * Returns [] if nothing matches.
 */
function parseResponse(response, categories, multiClass) {
  const categoryNames = categories.map(c => c.category)

  if (multiClass) {
    // Expect JSON array
    try {
      const parsed = JSON.parse(response.trim())
      if (Array.isArray(parsed)) {
        return parsed.filter(r =>
          categoryNames.some(n => n.toLowerCase() === String(r).toLowerCase())
        ).map(r =>
          categoryNames.find(n => n.toLowerCase() === String(r).toLowerCase())
        )
      }
    } catch {
      // fall through to line-by-line / comma-split fallback
    }
    // Fallback: comma-separated or newline-separated
    const parts = response.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
    return parts
      .map(p => categoryNames.find(n => n.toLowerCase() === p.toLowerCase()))
      .filter(Boolean)
  }

  // Single class: match the trimmed response to a category name
  const trimmed = response.trim()
  const match = categoryNames.find(n => n.toLowerCase() === trimmed.toLowerCase())
  return match ? [match] : []
}

/**
 * Execute a batch of items, calling the LLM once per item.
 */
async function processBatch(items, categories, multiClass, fallback, systemPrompt, outputs, ctxCds, llmService, nodeOutputs) {
  const fallbackPortIndex = fallback === 'other' ? outputs.length - 1 : -1

  for (const item of items) {
    const text = resolveValue('={{ $json.text }}', item, nodeOutputs) ?? JSON.stringify(item.json)

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(text) },
    ]

    let matched = []
    try {
      const response = await callLlm(ctxCds, messages, { service: llmService })
      matched = parseResponse(response, categories, multiClass)
    } catch (err) {
      log.error(`textClassifier: LLM call failed: ${err.message}`)
    }

    if (matched.length === 0) {
      if (fallback === 'other') {
        outputs[fallbackPortIndex].push({ json: { ...item.json, _category: 'Other' } })
      }
      // fallback === 'discard' (or unrecognised): drop the item
      continue
    }

    for (const categoryName of matched) {
      const idx = categories.findIndex(c => c.category === categoryName)
      if (idx === -1) continue
      outputs[idx].push({ json: { ...item.json, _category: categoryName } })
    }
  }
}

/**
 * Executor for @n8n/n8n-nodes-langchain.textClassifier
 *
 * Params used:
 *   inputText               — expression for the text to classify (resolveValue)
 *   categories.categories   — [{ category, description }]
 *   options.multiClass      — boolean (allow multiple matches per item)
 *   options.fallback        — 'discard' | 'other'
 *   options.systemPromptTemplate — optional override
 *   options.batching        — { batchSize, delayBetweenBatches } (v1.1)
 */
export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}

  const categories = params.categories?.categories ?? []
  const multiClass = params.options?.multiClass ?? false
  const fallback   = params.options?.fallback ?? 'discard'
  const systemPromptTemplate = params.options?.systemPromptTemplate ?? null
  const batchSize          = params.options?.batching?.batchSize ?? 5
  const delayBetweenBatches = params.options?.batching?.delayBetweenBatches ?? 0

  const rawItems = normaliseInput(input)
  const nodeOutputs = context.nodeOutputs ?? {}

  // Resolve inputText expression for each item (replace item.json.text field if needed)
  const items = rawItems.map(item => {
    if (params.inputText) {
      const resolved = resolveValue(params.inputText, item, nodeOutputs)
      return { json: { ...item.json, text: resolved ?? item.json.text } }
    }
    return item
  })

  // Build outputs array: one slot per category + optional fallback slot
  const outputCount = categories.length + (fallback === 'other' ? 1 : 0)
  const outputs = Array.from({ length: outputCount }, () => [])

  if (categories.length === 0) {
    log.warn(`textClassifier "${node.name}": no categories defined, all items discarded`)
    return outputs
  }

  const systemPrompt = buildSystemPrompt(categories, multiClass, systemPromptTemplate)

  // Process in batches
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    await processBatch(batch, categories, multiClass, fallback, systemPrompt, outputs, ctxCds, context.llmService, nodeOutputs)

    if (delayBetweenBatches > 0 && i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches))
    }
  }

  return outputs
}
