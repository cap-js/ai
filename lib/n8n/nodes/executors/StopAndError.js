/**
 * StopAndError.js — n8n-nodes-base.stopAndError executor
 *
 * Throws a workflow error, halting execution.
 *
 * Parameters:
 *   parameters.errorType     — 'errorMessage' | 'errorObject'
 *   parameters.errorMessage  — plain string message (for errorType='errorMessage')
 *   parameters.errorObject   — JSON object with { message, description, ... }
 *                              (for errorType='errorObject')
 *
 * Output ports: none (node always throws)
 */

import { resolveValue } from './resolve.js'

/**
 * @param {object} node
 * @param {Array}  input
 * @param {object} context
 * @throws {Error} Always throws
 */
export function execute(node, input, context) {
  const params = node.parameters ?? {}
  const errorType = params.errorType ?? 'errorMessage'

  // Get the first item for expression resolution
  const items = normaliseInput(input)
  const item = items[0] ?? { json: {} }
  const nodeOutputs = context?.nodeOutputs ?? {}

  if (errorType === 'errorObject') {
    const raw = params.errorObject
    let obj
    try {
      const resolved = resolveValue(raw, item, nodeOutputs)
      obj = typeof resolved === 'string' ? JSON.parse(resolved) : (resolved ?? {})
    } catch {
      obj = { message: String(raw) }
    }
    const msg = obj.message ?? obj.error ?? JSON.stringify(obj)
    const err = new Error(msg)
    if (obj.description) err.description = obj.description
    if (obj.code)        err.code = obj.code
    throw err
  }

  // errorMessage (default)
  const raw = params.errorMessage ?? 'An error occurred'
  const message = resolveValue(raw, item, nodeOutputs) ?? raw
  throw new Error(String(message))
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}
