/**
 * Filter.js — n8n-nodes-base.filter executor (FilterV2)
 *
 * Keeps only the items that match the configured conditions.
 * Unlike If, Filter only has a single meaningful output port — items that
 * pass the conditions. (The real n8n FilterV2 returns [keptItems, discardedItems]
 * internally, but in practice only output 0 is wired downstream.)
 *
 * Parameters:
 *   node.parameters.conditions — n8n filter/condition block (see conditions.js)
 *   node.parameters.options.ignoreCase — boolean (default true)
 *
 * Output ports: 1 (kept items on outputs[0])
 *
 * Matches the behaviour of FilterV2.execute() in n8n-nodes-base.
 */

import { evaluateConditions } from './conditions.js'

/**
 * @param {object} node
 * @param {Array}  input   - Items [{ json: {...} }, ...]
 * @param {object} context - { executionId, workflowId, nodeOutputs }
 * @returns {Array[]}  [ keptItems ]
 */
export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const conditions = params.conditions ?? {}
  const options = params.options ?? {}
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  // n8n default: ignoreCase=true → caseSensitive=false
  const mergedConditions = mergeConditionsOptions(conditions, options)

  const keptItems = []

  for (const item of items) {
    try {
      if (evaluateConditions(mergedConditions, item, nodeOutputs)) {
        keptItems.push(item)
      }
      // Items that don't match are silently discarded (no second output port in practice)
    } catch {
      // On error, discard the item (matches n8n continueOnFail behaviour)
    }
  }

  return [keptItems]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

/**
 * Merge the node-level options (ignoreCase) into the conditions.options block.
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
