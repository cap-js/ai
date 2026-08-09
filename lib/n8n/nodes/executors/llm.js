/**
 * llm.js — shared LLM caller for CAP n8n executor nodes
 *
 * Uses the same `cds.requires.llm` service that @cap-js/agents uses,
 * so all nodes share a single LLM configuration (no per-node provider lists).
 *
 * The `llm` service is a LangChain BaseChatModel — it has `.invoke(messages)`.
 * Messages: [{ role: 'system'|'user'|'assistant', content: string }]
 * Returns: message object with `.content` string.
 */

/**
 * Call the configured LLM with a messages array.
 * Returns the response text as a string.
 *
 * @param {object} cds                  - The CDS instance from context
 * @param {Array}  messages             - [{ role, content }]
 * @param {object} [opts]               - options
 * @param {string} [opts.model]         - optional model name override
 * @param {string} [opts.service]       - optional cds.requires service name (default: 'llm')
 * @returns {Promise<string>}
 */
export async function callLlm(cds, messages, { model, service } = {}) {
  const lcMessages = messages.map(m => ({ role: m.role, content: m.content }))

  // Primary: @cap-js/agents llm service (BaseChatModel with .invoke())
  try {
    const serviceName = service ?? 'llm'
    const { kind, impl: directImpl, ...options } = cds.requires[serviceName] ?? {}
    const impl = directImpl ?? cds.requires.kinds[kind]?.impl
    if (impl) {
      const { default: LLMProvider } = await import(impl)
      const llmInstance = new LLMProvider(serviceName, { ...options, ...(model ? { model } : {}) })
      const result = await llmInstance.invoke(lcMessages)
      return extractContent(result)
    }
  } catch (e) {
    // fall through to AICore
    cds.log('n8n:llm').debug('llm service unavailable, falling back to AICore:', e.message)
  }

  // Fallback: AICore chat action
  try {
    const svc = await cds.connect.to('AICore')
    const result = await svc.send('chat', { model, messages })
    return extractContent(result)
  } catch (e) {
    cds.log('n8n:llm').debug('AICore fallback failed:', e.message)
    throw new Error(`callLlm: no LLM backend available. Configure cds.requires.llm. Last error: ${e.message}`)
  }
}

function extractContent(result) {
  if (typeof result === 'string') return result
  // LangChain message object
  if (result?.content !== undefined) return String(result.content)
  // OpenAI-style choices
  if (result?.choices?.[0]?.message?.content) return result.choices[0].message.content
  return JSON.stringify(result)
}
