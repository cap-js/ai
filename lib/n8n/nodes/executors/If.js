/**
 * If.js — n8n-nodes-base.if executor
 *
 * Routes each item to the "true" (port 0) or "false" (port 1) output port
 * based on whether the configured conditions pass.
 *
 * Parameters:
 *   node.parameters.conditions — n8n filter/condition block (see conditions.js)
 *   node.parameters.options.ignoreCase — boolean (default true, so caseSensitive=false)
 *
 * Output ports: 2  →  [trueItems, falseItems]
 *
 * Matches the behaviour of IfV2.execute() in n8n-nodes-base:
 *   - Items that pass conditions go to outputs[0]
 *   - Items that fail conditions go to outputs[1]
 *   - On error, item is pushed to falseItems (continueOnFail behaviour)
 */

import { evaluateConditions } from './conditions.js'

/**
 * @param {object} node
 * @param {Array}  input   - Items [{ json: {...} }, ...]
 * @param {object} context - { executionId, workflowId, nodeOutputs }
 * @returns {Array[]}  [ trueItems, falseItems ]
 */
export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const conditions = params.conditions ?? {}
  const options = params.options ?? {}
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  // n8n default: ignoreCase=true → caseSensitive=false
  // We propagate this into the conditions options so evaluateConditions uses it
  const mergedConditions = mergeConditionsOptions(conditions, options)

  const trueItems  = []
  const falseItems = []

  for (const item of items) {
    try {
      if (evaluateConditions(mergedConditions, item, nodeOutputs)) {
        trueItems.push(item)
      } else {
        falseItems.push(item)
      }
    } catch {
      // On error, item goes to false branch (matches n8n continueOnFail default)
      falseItems.push(item)
    }
  }

  return [trueItems, falseItems]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}

/**
 * Merge the node-level options (ignoreCase) into the conditions.options block
 * so that the condition evaluator sees a consistent options object.
 *
 * The n8n filter parameter type uses caseSensitive in conditions.options.
 * The node-level options.ignoreCase overrides that.
 */
function mergeConditionsOptions(conditions, nodeOptions) {
  if (!conditions || typeof conditions !== 'object') return conditions
  if (!Array.isArray(conditions.conditions)) return conditions

  const ignoreCase = nodeOptions.ignoreCase !== false  // default true
  return {
    ...conditions,
    options: {
      ...conditions.options,
      caseSensitive: !ignoreCase,
    },
  }
}
