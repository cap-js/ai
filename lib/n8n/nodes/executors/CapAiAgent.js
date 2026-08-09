import { resolveValue } from './resolve.js'
import { callLlm } from './llm.js'
import cds from '@sap/cds'

const log = cds.log('n8n:capAi')

function extractJsonObject(str, startIndex) {
  let depth = 0
  let i = startIndex
  while (i < str.length) {
    if (str[i] === '{') depth++
    else if (str[i] === '}') {
      depth--
      if (depth === 0) return str.slice(startIndex, i + 1)
    }
    i++
  }
  return null
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export async function execute(node, input, context) {
  const { cds: ctxCds } = context
  const params = node.parameters ?? {}
  const model = params.model || undefined
  const maxIterations = params.maxIterations ?? 5
  const outputField = params.outputField || 'agentResult'
  const tools = params.tools ?? []

  const baseSystemPrompt = params.systemPrompt || 'You are a helpful AI agent. Use the available tools to complete the task.'

  const toolsSection = tools.length
    ? '\n\nAvailable tools:\n' +
      tools.map(t => {
        const paramSig = (t.parameters ?? [])
          .map(p => `${p.name}: ${p.type}`)
          .join(', ')
        return `- ${t.name}(${paramSig}): ${t.description}`
      }).join('\n') +
      '\n\nTo call a tool, respond with:\nTOOL_CALL: toolName\nPARAMS: {"param1": "value1"}\n\nWhen you have the final answer, respond with:\nFINAL_ANSWER: your answer here'
    : '\n\nWhen you have the final answer, respond with:\nFINAL_ANSWER: your answer here'

  const systemContent = baseSystemPrompt + toolsSection

  const items = normaliseInput(input)
  const outputItems = []

  for (const item of items) {
    const userPromptRaw = params.userPrompt ?? ''
    const userPrompt = resolveValue(userPromptRaw, item, context?.nodeOutputs ?? {})

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: String(userPrompt) },
    ]

    let finalAnswer = null

    for (let iter = 0; iter < maxIterations; iter++) {
      let response
      try {
        response = await callLlm(ctxCds, messages, { model, service: context?.llmService })
      } catch (err) {
        log.error(`CapAiAgent "${node.name}" iter ${iter}: ${err.message}`)
        finalAnswer = `Error: ${err.message}`
        break
      }

      messages.push({ role: 'assistant', content: response })

      if (response.includes('FINAL_ANSWER:')) {
        finalAnswer = response.split('FINAL_ANSWER:').pop().trim()
        break
      }

      if (response.includes('TOOL_CALL:')) {
        const toolNameMatch = response.match(/TOOL_CALL:\s*(\S+)/)
        const toolName = toolNameMatch?.[1]?.trim()
        const paramsStart = response.indexOf('PARAMS:')
        let toolParams = {}
        if (paramsStart !== -1) {
          const braceStart = response.indexOf('{', paramsStart)
          if (braceStart !== -1) {
            const jsonStr = extractJsonObject(response, braceStart)
            if (jsonStr) {
              try { toolParams = JSON.parse(jsonStr) } catch { /* use empty */ }
            }
          }
        }

        const toolDef = tools.find(t => t.name === toolName)
        if (!toolDef) {
          messages.push({ role: 'user', content: `Tool result: Error — unknown tool "${toolName}"` })
          continue
        }

        let toolResult
        try {
          const svc = await ctxCds.connect.to(toolDef.service)
          toolResult = await svc.send(toolDef.action, toolParams)
        } catch (err) {
          log.warn(`CapAiAgent "${node.name}": tool "${toolName}" failed: ${err.message}`)
          toolResult = { error: err.message }
        }

        messages.push({ role: 'user', content: `Tool result: ${JSON.stringify(toolResult)}` })
        continue
      }

      // No recognised pattern — treat the entire response as the final answer
      finalAnswer = response.trim()
      break
    }

    if (finalAnswer === null) {
      log.warn(`CapAiAgent "${node.name}": reached maxIterations (${maxIterations}) without a FINAL_ANSWER`)
      finalAnswer = messages.at(-1)?.content ?? ''
    }

    outputItems.push({ json: { ...item.json, [outputField]: finalAnswer } })
  }

  return [outputItems]
}
