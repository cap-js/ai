/**
 * conditions.js — Shared n8n condition evaluator
 *
 * Evaluates n8n-style filter/condition objects as used by If, Switch, and Filter nodes.
 * Fully conformant with n8n's executeFilterCondition from n8n-workflow filter-parameter.js.
 *
 * New-style parameter shape (n8n v2+ "filter" type):
 * {
 *   combinator: 'and' | 'or',
 *   conditions: [
 *     {
 *       id: 'uuid',
 *       leftValue: '={{ $json.field }}',
 *       rightValue: 'expected',
 *       operator: { type: 'string', operation: 'equals', singleValue?: true }
 *     }
 *   ],
 *   options: { caseSensitive: true, typeValidation: 'strict', version: 1 }
 * }
 *
 * Legacy v1 shape:
 * {
 *   string:  [ { value1, value2, operation } ],
 *   number:  [ ... ],
 *   boolean: [ ... ]
 * }
 */

import { resolveValue } from './resolve.js'

/**
 * Evaluate a conditions block against a single item.
 *
 * @param {object} conditions  - The `conditions` parameter from the node
 * @param {object} item        - Current item { json: {...} }
 * @param {object} nodeOutputs - Map nodeName → items (for $node[] expressions)
 * @returns {boolean}
 */
export function evaluateConditions(conditions, item, nodeOutputs = {}) {
  if (!conditions || typeof conditions !== 'object') return true

  // ── New-style filter object ───────────────────────────────────────────────
  if (Array.isArray(conditions.conditions)) {
    const combinator = conditions.combinator ?? 'and'
    const opts = conditions.options ?? {}
    const list = conditions.conditions

    if (list.length === 0) return true

    if (combinator === 'or') {
      return list.some((c, i) => evalSingleCondition(c, item, nodeOutputs, opts, i))
    }
    return list.every((c, i) => evalSingleCondition(c, item, nodeOutputs, opts, i))
  }

  // ── Legacy flat array ─────────────────────────────────────────────────────
  if (Array.isArray(conditions)) {
    if (conditions.length === 0) return true
    return conditions.every(c => evalLegacyCondition(c, item, nodeOutputs))
  }

  // ── Legacy typed groups { string: [], number: [], boolean: [] } ───────────
  const groups = [
    ...(conditions.string  ?? []),
    ...(conditions.number  ?? []),
    ...(conditions.boolean ?? []),
  ]
  if (groups.length === 0) return true
  return groups.every(c => evalLegacyCondition(c, item, nodeOutputs))
}

// ── New-style condition ───────────────────────────────────────────────────────

function evalSingleCondition(cond, item, nodeOutputs, opts = {}) {
  const left  = resolveValue(cond.leftValue  ?? cond.value1, item, nodeOutputs)
  const right = resolveValue(cond.rightValue ?? cond.value2, item, nodeOutputs)

  const operator = cond.operator ?? {}
  const opType = (typeof operator === 'object') ? (operator.type ?? 'string') : 'string'
  const opName = (typeof operator === 'object')
    ? (operator.operation ?? String(operator))
    : String(operator ?? cond.operation ?? '')

  // caseSensitive defaults to true (i.e. ignoreCase defaults to false)
  const caseSensitive = opts.caseSensitive !== false

  // exists / notExists are singleValue operators — check before type dispatch
  const exists = left !== undefined && left !== null && !Number.isNaN(left)
  if (opName === 'exists')    return exists
  if (opName === 'notExists') return !exists

  return applyTypedOperator(opType, opName, left, right, caseSensitive)
}

// ── Legacy condition ──────────────────────────────────────────────────────────

function evalLegacyCondition(cond, item, nodeOutputs) {
  const left  = resolveValue(cond.value1 ?? cond.leftValue,  item, nodeOutputs)
  const right = resolveValue(cond.value2 ?? cond.rightValue, item, nodeOutputs)
  const op    = cond.operation ?? cond.operator
  return applyOperatorLegacy(op, left, right, true)
}

// ── Type-aware operator dispatch (n8n v2+) ────────────────────────────────────

// eslint-disable-next-line complexity
function applyTypedOperator(type, op, left, right, caseSensitive) {
  const exists = left !== undefined && left !== null && !Number.isNaN(left)

  switch (type) {
    case 'string': {
      if (op === 'empty')    return String(left ?? '').length === 0
      if (op === 'notEmpty') return String(left ?? '').length !== 0

      let l = String(left ?? '')
      let r = String(right ?? '')
      if (!caseSensitive) {
        l = l.toLocaleLowerCase()
        // Do not lowercase the regex pattern itself
        if (op !== 'regex' && op !== 'notRegex') r = r.toLocaleLowerCase()
      }
      switch (op) {
        case 'equals':        return l === r
        case 'notEquals':     return l !== r
        case 'contains':      return l.includes(r)
        case 'notContains':   return !l.includes(r)
        case 'startsWith':    return l.startsWith(r)
        case 'notStartsWith': return !l.startsWith(r)
        case 'endsWith':      return l.endsWith(r)
        case 'notEndsWith':   return !l.endsWith(r)
        case 'regex':
        case 'matchesRegex': {
          try {
            const { source, flags } = parseRegexLiteral(String(right ?? ''))
            return new RegExp(source, flags).test(l)
          } catch { return false }
        }
        case 'notRegex':
        case 'notMatchesRegex': {
          try {
            const { source, flags } = parseRegexLiteral(String(right ?? ''))
            return !new RegExp(source, flags).test(l)
          } catch { return true }
        }
        default: return applyOperatorLegacy(op, left, right, caseSensitive)
      }
    }

    case 'number': {
      if (op === 'empty')    return !exists
      if (op === 'notEmpty') return exists
      const l = Number(left)
      const r = Number(right)
      switch (op) {
        case 'equals':    return l === r
        case 'notEquals': return l !== r
        case 'gt':        return l > r
        case 'lt':        return l < r
        case 'gte':       return l >= r
        case 'lte':       return l <= r
        default: return applyOperatorLegacy(op, left, right, caseSensitive)
      }
    }

    case 'boolean': {
      if (op === 'empty')    return !exists
      if (op === 'notEmpty') return exists
      const l = toBoolean(left)
      switch (op) {
        case 'true':      return l === true
        case 'false':     return l === false
        case 'equals':    return l === toBoolean(right)
        case 'notEquals': return l !== toBoolean(right)
        default: return applyOperatorLegacy(op, left, right, caseSensitive)
      }
    }

    case 'array': {
      const l = Array.isArray(left) ? left : []
      const r = Number(right)
      switch (op) {
        case 'empty':           return l.length === 0
        case 'notEmpty':        return l.length !== 0
        case 'contains':        return arrayContainsValue(l, right, !caseSensitive)
        case 'notContains':     return !arrayContainsValue(l, right, !caseSensitive)
        case 'lengthEquals':    return l.length === r
        case 'lengthNotEquals': return l.length !== r
        case 'lengthGt':        return l.length > r
        case 'lengthLt':        return l.length < r
        case 'lengthGte':       return l.length >= r
        case 'lengthLte':       return l.length <= r
        default: return false
      }
    }

    case 'object': {
      switch (op) {
        case 'empty':    return !left || Object.keys(left).length === 0
        case 'notEmpty': return !!left && Object.keys(left).length !== 0
        default: return false
      }
    }

    case 'dateTime': {
      if (op === 'empty')    return !exists
      if (op === 'notEmpty') return exists
      const lMs = toMillis(left)
      const rMs = toMillis(right)
      if (lMs === null || rMs === null) return false
      switch (op) {
        case 'equals':         return lMs === rMs
        case 'notEquals':      return lMs !== rMs
        case 'after':          return lMs >  rMs
        case 'before':         return lMs <  rMs
        case 'afterOrEquals':  return lMs >= rMs
        case 'beforeOrEquals': return lMs <= rMs
        default: return false
      }
    }

    case 'any':
    default:
      return applyOperatorLegacy(op, left, right, caseSensitive)
  }
}

// ── Legacy / type-agnostic operator dispatch ──────────────────────────────────

function applyOperatorLegacy(op, left, right, caseSensitive) {
  const L = caseSensitive ? left  : (typeof left  === 'string' ? left.toLowerCase()  : left)
  const R = caseSensitive ? right : (typeof right === 'string' ? right.toLowerCase() : right)

  switch (op) {
    // Equality
    case 'equals':
    case 'equal':
      return L == R  // eslint-disable-line eqeqeq
    case 'notEquals':
    case 'notEqual':
      return L != R  // eslint-disable-line eqeqeq

    // Numeric comparisons
    case 'gt':
    case 'larger':
      return Number(left) > Number(right)
    case 'gte':
    case 'largerEqual':
      return Number(left) >= Number(right)
    case 'lt':
    case 'smaller':
      return Number(left) < Number(right)
    case 'lte':
    case 'smallerEqual':
      return Number(left) <= Number(right)

    // String operations
    case 'contains':
      return String(L).includes(String(R))
    case 'notContains':
      return !String(L).includes(String(R))
    case 'startsWith':
      return String(L).startsWith(String(R))
    case 'notStartsWith':
      return !String(L).startsWith(String(R))
    case 'endsWith':
      return String(L).endsWith(String(R))
    case 'notEndsWith':
      return !String(L).endsWith(String(R))
    case 'regex':
    case 'matchesRegex':
      try { return new RegExp(String(right)).test(String(left)) } catch { return false }
    case 'notRegex':
    case 'notMatchesRegex':
      try { return !new RegExp(String(right)).test(String(left)) } catch { return true }

    // Existence
    case 'exists':
    case 'isNotEmpty':
      return left !== undefined && left !== null && left !== ''
    case 'notExists':
    case 'isEmpty':
      return left === undefined || left === null || left === ''

    // Boolean
    case 'true':
    case 'isTrue':
      return Boolean(left) === true
    case 'false':
    case 'isFalse':
      return Boolean(left) === false

    default:
      // Unknown operator — treat as true so we don't accidentally block flows
      return true
  }
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 'true'  || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return Boolean(value)
}

function toMillis(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return isNaN(ms) ? null : ms
  }
  if (value instanceof Date) return value.getTime()
  // Luxon DateTime support (has .toMillis())
  if (typeof value?.toMillis === 'function') return value.toMillis()
  return null
}

function arrayContainsValue(array, value, ignoreCase) {
  if (ignoreCase && typeof value === 'string') {
    return array.some(item =>
      typeof item === 'string' &&
      item.toLocaleLowerCase() === value.toLocaleLowerCase()
    )
  }
  return array.includes(value)
}

/**
 * Parse a regex literal like /pattern/flags or a plain pattern string.
 */
function parseRegexLiteral(pattern) {
  const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/)
  if (m) return { source: m[1], flags: m[2] }
  return { source: pattern, flags: '' }
}
