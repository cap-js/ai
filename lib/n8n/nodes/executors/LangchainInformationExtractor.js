import { resolveValue } from './resolve.js'
import { callLlm } from './llm.js'
import cds from '@sap/cds'

const log = cds.log('n8n:informationExtractor')

const CODE_FENCE_RE = /```json?\n?([\s\S]*?)\n?```/

const DEFAULT_SYSTEM_PROMPT =
  'You are an expert extraction algorithm. ' +
  'Only extract relevant information from the text. ' +
  'If you do not know the value of an attribute asked to extract, ' +
  'return null for the attribute\'s value.'

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

/**
 * Build a JSON Schema from the attributes fixedCollection array.
 * Each attribute: { name, type, description, required }
 */
function buildSchemaFromAttributes(attributes) {
  const properties = {}
  const requiredFields = []

  for (const attr of attributes) {
    const prop = { description: attr.description }
    switch (attr.type) {
      case 'number':
        prop.type = 'number'
        break
      case 'boolean':
        prop.type = 'boolean'
        break
      case 'date':
        prop.type = 'string'
        prop.format = 'date'
        break
      default:
        prop.type = 'string'
    }
    properties[attr.name] = prop
    if (attr.required) requiredFields.push(attr.name)
  }

  const schema = { type: 'object', properties }
  if (requiredFields.length) schema.required = requiredFields
  return schema
}

/**
 * Build a JSON Schema from a JSON example object (schemaType == fromJson).
 * All fields are required in v1.2+.
 */
function buildSchemaFromExample(example) {
  const properties = {}
  for (const [key, val] of Object.entries(example)) {
    if (val === null || val === undefined) {
      properties[key] = {}
    } else if (typeof val === 'number') {
      properties[key] = { type: 'number' }
    } else if (typeof val === 'boolean') {
      properties[key] = { type: 'boolean' }
    } else if (Array.isArray(val)) {
      properties[key] = { type: 'array' }
    } else if (typeof val === 'object') {
      properties[key] = { type: 'object' }
    } else {
      properties[key] = { type: 'string' }
    }
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(example),
  }
}

/**
 * Coerce parsed values to their declared types based on schema properties.
 */
function coerceValues(parsed, properties) {
  const result = {}
  for (const [key, prop] of Object.entries(properties)) {
    const val = parsed[key]
    if (val === undefined || val === null) {
      result[key] = val
      continue
    }
    switch (prop.type) {
      case 'number':
        result[key] = Number(val)
        break
      case 'boolean':
        if (typeof val === 'boolean') result[key] = val
        else result[key] = val === 'true' ? true : val === 'false' ? false : Boolean(val)
        break
      default:
        result[key] = val
    }
  }
  return result
}

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const options = params.options ?? {}

  const schemaType = params.schemaType ?? 'fromAttributes'
  const systemPrompt = options.systemPromptTemplate ?? DEFAULT_SYSTEM_PROMPT

  // Resolve schema and field properties for coercion
  let schema
  let schemaProperties = {}

  if (schemaType === 'fromAttributes') {
    const attrEntries = params.attributes?.attributes ?? []
    schema = buildSchemaFromAttributes(attrEntries)
    schemaProperties = schema.properties ?? {}
  } else if (schemaType === 'fromJson') {
    let example = params.jsonSchemaExample ?? {}
    if (typeof example === 'string') {
      try { example = JSON.parse(example) } catch { example = {} }
    }
    schema = buildSchemaFromExample(example)
    schemaProperties = schema.properties ?? {}
  } else {
    // manual — use inputSchema directly
    let inputSchema = params.inputSchema ?? {}
    if (typeof inputSchema === 'string') {
      try { inputSchema = JSON.parse(inputSchema) } catch { inputSchema = {} }
    }
    schema = inputSchema
    schemaProperties = schema.properties ?? {}
  }

  const schemaStr = JSON.stringify(schema, null, 2)

  // Batching options (version >= 1.1)
  const batching = options.batching ?? {}
  const batchSize = batching.batchSize ?? 5
  const delayBetweenBatches = batching.delayBetweenBatches ?? 0

  const items = normaliseInput(input)
  const outputItems = []

  // Process in batches
  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
    if (batchStart > 0 && delayBetweenBatches > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches))
    }

    const batch = items.slice(batchStart, batchStart + batchSize)

    const promises = batch.map(async (item) => {
      // Resolve text — params.text may be an n8n expression like ={{ $json.body }}
      let text
      const rawText = params.text ?? ''
      if (rawText === '' || rawText === null || rawText === undefined) {
        text = JSON.stringify(item.json)
      } else {
        const resolved = resolveValue(rawText, item, context.nodeOutputs ?? {})
        text = (resolved !== undefined && resolved !== null) ? String(resolved) : JSON.stringify(item.json)
      }

      const userContent =
        `Extract information from the following text according to this JSON Schema.\n` +
        `Return ONLY a valid JSON object matching the schema, nothing else.\n\n` +
        `Schema:\n${schemaStr}\n\nText:\n${text}`

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]

      try {
        const response = await callLlm(ctxCds, messages, { service: context.llmService })
        const fenceMatch = response.match(CODE_FENCE_RE)
        const jsonStr = fenceMatch ? fenceMatch[1] : response.trim()
        const parsed = JSON.parse(jsonStr)
        const coerced = coerceValues(parsed, schemaProperties)
        return { json: { ...item.json, ...coerced } }
      } catch (err) {
        log.warn(`informationExtractor "${node.name}": failed to parse LLM response as JSON: ${err.message}`)
        return { json: { ...item.json, _extractionError: err.message } }
      }
    })

    const batchResults = await Promise.all(promises)
    outputItems.push(...batchResults)
  }

  return [outputItems]
}
