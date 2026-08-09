/**
 * Switch.js — n8n-nodes-base.switch executor (SwitchV3)
 *
 * Routes each item to one of N output ports based on evaluated rules or an expression.
 *
 * mode: 'rules' (default)
 *   parameters.rules.values = [
 *     {
 *       outputKey: string,           — label for this output port
 *       conditions: {                — full filter/condition block (see conditions.js)
 *         combinator: 'and'|'or',
 *         conditions: [...],
 *         options: { caseSensitive, typeValidation }
 *       }
 *     }
 *   ]
 *   parameters.options.fallbackOutput  — 'none'|'extra'|<number> (port index for unmatched items)
 *   parameters.options.allMatchingOutputs  — boolean, send item to ALL matching rules (default false = first match wins)
 *   parameters.options.ignoreCase     — boolean (default true)
 *
 * mode: 'expression'
 *   parameters.output          — expression that evaluates to a zero-based port index
 *   parameters.numberOutputs   — total number of output ports (default 4)
 *
 * Output ports: dynamic
 *   rules mode: one per rule + optional extra fallback port
 *   expression mode: numberOutputs ports
 *
 * Matches the behaviour of SwitchV3.execute() in n8n-nodes-base.
 */

import { evaluateConditions } from './conditions.js'
import { resolveValue } from './resolve.js'
import cds from '@sap/cds'

const log = cds.log('n8n:switch')

/**
 * @param {object} node
 * @param {Array}  input
 * @param {object} context
 * @returns {Array[]}  Array of port item arrays
 */
export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const mode = params.mode ?? 'rules'
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  if (mode === 'expression') {
    return executeExpressionMode(params, items, nodeOutputs, node.name)
  }
  return executeRulesMode(params, items, nodeOutputs, node.name)
}

// ── Rules mode ────────────────────────────────────────────────────────────────

function executeRulesMode(params, items, nodeOutputs, nodeName) {
  const rules = params.rules?.values ?? []
  const options = params.options ?? {}
  const fallback = options.fallbackOutput   // 'extra' | 'none' | undefined | number
  const allMatchingOutputs = options.allMatchingOutputs === true
  const ignoreCase = options.ignoreCase !== false  // default true → caseSensitive=false

  if (!rules.length) return [[]]

  // Total ports: one per rule, plus one if fallback='extra'
  const hasFallbackPort = fallback === 'extra'
  const totalPorts = rules.length + (hasFallbackPort ? 1 : 0)
  const fallbackPortIndex = hasFallbackPort
    ? rules.length
    : (typeof fallback === 'number' ? fallback : -1)

  // Initialise output arrays
  const outputs = Array.from({ length: totalPorts }, () => [])

  for (const item of items) {
    try {
      let matchFound = false

      for (let ruleIdx = 0; ruleIdx < rules.length; ruleIdx++) {
        const rule = rules[ruleIdx]
        const conditions = mergeConditionsOptions(rule.conditions ?? {}, ignoreCase)

        if (evaluateConditions(conditions, item, nodeOutputs)) {
          if (ruleIdx < outputs.length) {
            outputs[ruleIdx].push(item)
          }
          matchFound = true
          if (!allMatchingOutputs) break   // first-match wins
        }
      }

      if (!matchFound) {
        if (fallbackPortIndex >= 0 && fallbackPortIndex < totalPorts) {
          outputs[fallbackPortIndex].push(item)
        } else {
          log.debug(`Switch "${nodeName}": item did not match any rule — dropped (fallback=${fallback})`)
        }
      }
    } catch (err) {
      log.warn(`Switch "${nodeName}": error evaluating item — ${err.message}`)
      // On error, push to fallback if available, otherwise drop
      if (fallbackPortIndex >= 0 && fallbackPortIndex < totalPorts) {
        outputs[fallbackPortIndex].push(item)
      }
    }
  }

  return outputs
}

// ── Expression mode ───────────────────────────────────────────────────────────

function executeExpressionMode(params, items, nodeOutputs, nodeName) {
  const numOutputs = params.numberOutputs ?? 4
  const outputExpr = params.output ?? params.outputIndex ?? '0'

  const outputs = Array.from({ length: numOutputs }, () => [])

  for (const item of items) {
    try {
      const raw = resolveValue(outputExpr, item, nodeOutputs)
      const portIndex = parseInt(String(raw), 10)

      if (isNaN(portIndex)) {
        log.warn(`Switch "${nodeName}": expression returned "${raw}" which is not a valid number — dropping item`)
        continue
      }
      if (portIndex < 0 || portIndex >= numOutputs) {
        log.warn(`Switch "${nodeName}": output index ${portIndex} out of range (0–${numOutputs - 1}) — dropping item`)
        continue
      }
      outputs[portIndex].push(item)
    } catch (err) {
      log.warn(`Switch "${nodeName}": error resolving output expression — ${err.message}`)
    }
  }

  return outputs
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
 * Inject node-level ignoreCase into conditions.options.caseSensitive.
 */
function mergeConditionsOptions(conditions, ignoreCase) {
  if (!conditions || typeof conditions !== 'object') return conditions
  if (!Array.isArray(conditions.conditions)) return conditions
  return {
    ...conditions,
    options: {
      ...conditions.options,
      caseSensitive: !ignoreCase,
    },
  }
}
