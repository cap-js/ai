import { callLlm } from './llm.js'
import cds from '@sap/cds'

const log = cds.log('n8n:summarization')

// Default prompt templates
const DEFAULT_MAP_CHUNK_PROMPT = 'Summarize the following text:\n{text}'
const DEFAULT_COMBINE_PROMPT = 'Write a concise summary of the following summaries:\n{text}'
const DEFAULT_REFINE_PROMPT = 'Here is the current summary: {existing_answer}\nRefine it with this additional context:\n{text}'

/**
 * Fill template variables in a prompt string.
 * Supports {text} and {existing_answer}.
 */
function fillPrompt(template, vars) {
  return template
    .replace(/\{text\}/g, vars.text ?? '')
    .replace(/\{existing_answer\}/g, vars.existing_answer ?? '')
}

/**
 * Split text into chunks of chunkSize characters with chunkOverlap overlap.
 */
function splitIntoChunks(text, chunkSize, chunkOverlap) {
  if (!text) return []
  if (chunkSize <= 0) return [text]

  const chunks = []
  let start = 0
  while (start < text.length) {
    const end = start + chunkSize
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = end - chunkOverlap
    if (start <= 0) start = end  // guard against zero/negative step
  }
  return chunks
}

/**
 * Execute a single LLM prompt call and return the response text.
 */
async function prompt(ctxCds, model, userContent, llmService) {
  const messages = [{ role: 'user', content: userContent }]
  return callLlm(ctxCds, messages, { model, service: llmService })
}

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const model = params.model || undefined

  // Operation mode — only nodeInputJson is supported; others are skipped
  const operationMode = params.operationMode ?? 'nodeInputJson'
  if (operationMode !== 'nodeInputJson') {
    log.warn(`LangchainSummarization "${node.name}": operationMode "${operationMode}" is not supported; skipping`)
    return [[]]
  }

  // Chunking mode — only simple is supported; advanced requires a sub-node
  const chunkingMode = params.chunkingMode ?? 'simple'
  if (chunkingMode !== 'simple') {
    log.warn(`LangchainSummarization "${node.name}": chunkingMode "${chunkingMode}" is not supported; skipping`)
    return [[]]
  }

  const chunkSize = params.chunkSize ?? 1000
  const chunkOverlap = params.chunkOverlap ?? 200

  // Summarization method and prompts
  const methodConfig = params.options?.summarizationMethodAndPrompts ?? {}
  const summarizationMethod = methodConfig.summarizationMethod ?? 'map_reduce'

  const combineMapPrompt = methodConfig.combineMapPrompt || DEFAULT_MAP_CHUNK_PROMPT
  const combinePrompt = methodConfig.prompt || DEFAULT_COMBINE_PROMPT
  const refinePrompt = methodConfig.refinePrompt || DEFAULT_REFINE_PROMPT

  // Collect all input items and concatenate their JSON as text
  const items = Array.isArray(input) ? input : (input ? [input] : [])
  const textParts = items.map(item => {
    const json = item?.json ?? item ?? {}
    return JSON.stringify(json)
  })
  const fullText = textParts.join('\n')

  if (!fullText.trim()) {
    log.warn(`LangchainSummarization "${node.name}": no input text`)
    return [[{ json: { text: '', output: '' } }]]
  }

  // Split into chunks
  const chunks = splitIntoChunks(fullText, chunkSize, chunkOverlap)
  log.debug(`LangchainSummarization "${node.name}": ${chunks.length} chunk(s), method=${summarizationMethod}`)

  let finalSummary

  try {
    if (summarizationMethod === 'stuff') {
      // Send all text in one prompt
      const userContent = fillPrompt(combinePrompt, { text: fullText })
      finalSummary = await prompt(ctxCds, model, userContent, context.llmService)

    } else if (summarizationMethod === 'map_reduce') {
      if (chunks.length === 1) {
        // Single chunk — skip the map step, go straight to combine
        const userContent = fillPrompt(combinePrompt, { text: chunks[0] })
        finalSummary = await prompt(ctxCds, model, userContent, context.llmService)
      } else {
        // Map: summarize each chunk individually
        const chunkSummaries = []
        for (const chunk of chunks) {
          const userContent = fillPrompt(combineMapPrompt, { text: chunk })
          const summary = await prompt(ctxCds, model, userContent, context.llmService)
          chunkSummaries.push(summary.trim())
        }
        // Reduce: combine chunk summaries
        const combined = chunkSummaries.join('\n\n')
        const userContent = fillPrompt(combinePrompt, { text: combined })
        finalSummary = await prompt(ctxCds, model, userContent, context.llmService)
      }

    } else if (summarizationMethod === 'refine') {
      if (chunks.length === 0) {
        finalSummary = ''
      } else {
        // Summarize the first chunk
        const firstContent = fillPrompt(combineMapPrompt, { text: chunks[0] })
        let currentSummary = await prompt(ctxCds, model, firstContent, context.llmService)
        currentSummary = currentSummary.trim()

        // Iteratively refine with each subsequent chunk
        for (let i = 1; i < chunks.length; i++) {
          const userContent = fillPrompt(refinePrompt, {
            existing_answer: currentSummary,
            text: chunks[i],
          })
          currentSummary = (await prompt(ctxCds, model, userContent, context.llmService)).trim()
        }
        finalSummary = currentSummary
      }

    } else {
      log.warn(`LangchainSummarization "${node.name}": unknown summarizationMethod "${summarizationMethod}", falling back to stuff`)
      const userContent = fillPrompt(combinePrompt, { text: fullText })
      finalSummary = await prompt(ctxCds, model, userContent, context.llmService)
    }

  } catch (err) {
    log.error(`LangchainSummarization "${node.name}": LLM call failed: ${err.message}`)
    throw err
  }

  const result = (finalSummary ?? '').trim()
  return [[{ json: { text: result, output: result } }]]
}
