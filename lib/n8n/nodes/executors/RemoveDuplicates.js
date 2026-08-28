/**
 * RemoveDuplicates.js — n8n-nodes-base.removeDuplicates executor
 *
 * Implements V1/V2 removeDuplicateInputItems behaviour.
 *
 * Parameters (V1 and V2 removeDuplicateInputItems operation):
 *   compare              — 'allFields' | 'allFieldsExcept' | 'selectedFields'
 *   fieldsToExclude      — comma-separated fields to exclude (allFieldsExcept mode)
 *   fieldsToCompare      — comma-separated fields to compare (selectedFields mode)
 *   options.disableDotNotation
 *   options.removeOtherFields — strip non-compared fields from output items
 *
 * V2-only:
 *   operation            — 'removeDuplicateInputItems' (handled here)
 *                        — 'removeItemsSeenInPreviousExecutions' (no external state; pass-through)
 *                        — 'clearDeduplicationHistory' (no-op)
 *
 * Algorithm: O(n log n) sort-then-deduplicate, matching n8n source.
 */

export function execute(node, input, _context) {
  const params = node.parameters ?? {}
  const items = normaliseInput(input)

  // V2 has an operation selector
  const operation = params.operation ?? 'removeDuplicateInputItems'

  if (operation === 'clearDeduplicationHistory') {
    // No external state in CAP engine — nothing to clear, pass items through
    return [items]
  }

  if (operation === 'removeItemsSeenInPreviousExecutions') {
    // Stateful cross-execution deduplication is not supported in the CAP engine.
    // Fall back to pass-through so workflows don't hard-crash.
    return [items]
  }

  // operation === 'removeDuplicateInputItems' (default for both V1 and V2)
  return removeDuplicateInputItems(params, items)
}

function removeDuplicateInputItems(params, items) {
  if (items.length === 0) return [[]]

  const compare = params.compare ?? 'allFields'
  const disableDotNotation = params.options?.disableDotNotation ?? false
  const removeOtherFields = params.options?.removeOtherFields ?? false

  // Build the full union of all keys across all items
  let keys = []
  for (const item of items) {
    const itemKeys = disableDotNotation
      ? Object.keys(item.json)
      : Object.keys(flattenKeys(item.json))
    for (const k of itemKeys) {
      if (!keys.includes(k)) keys.push(k)
    }
  }

  if (compare === 'allFieldsExcept') {
    const fieldsToExclude = parseFields(params.fieldsToExclude ?? '')
    if (!fieldsToExclude.length) {
      throw new Error('No fields specified. Please add a field to exclude from comparison')
    }
    if (!disableDotNotation) {
      keys = Object.keys(flattenKeys(items[0].json))
    }
    keys = keys.filter(k => !fieldsToExclude.includes(k))
  }

  if (compare === 'selectedFields') {
    // The workflow JSON may store the param as 'fields' (V1 UI) or 'fieldsToCompare' (V2 UI)
    const rawFields = params.fieldsToCompare ?? params.fields ?? ''
    const fieldsToCompare = parseFields(rawFields)
    if (!fieldsToCompare.length) {
      throw new Error('No fields specified. Please add a field to compare on')
    }
    if (!disableDotNotation) {
      keys = Object.keys(flattenKeys(items[0].json))
    }
    keys = fieldsToCompare.map(k => k.trim())
  }

  // Add original index so we can restore order after sort-based dedup
  const indexedItems = items.map((item, index) => ({
    json: { ...item.json, __INDEX: index },
  }))

  // Sort by compare keys — makes identical items adjacent
  indexedItems.sort((a, b) => {
    for (const key of keys) {
      const valA = getVal(a.json, key, disableDotNotation)
      const valB = getVal(b.json, key, disableDotNotation)
      if (isDeepEqual(valA, valB)) continue
      return isLessThan(valA, valB) ? -1 : 1
    }
    return 0
  })

  // Walk sorted list and collect indexes of duplicates (keep first occurrence)
  const removedIndexes = new Set()
  let prev = indexedItems[0]
  for (let i = 1; i < indexedItems.length; i++) {
    const curr = indexedItems[i]
    if (compareItems(curr, prev, keys, disableDotNotation)) {
      removedIndexes.add(curr.json.__INDEX)
    } else {
      prev = curr
    }
  }

  let result = items.filter((_, idx) => !removedIndexes.has(idx))

  if (removeOtherFields) {
    result = result.map(item => {
      const picked = {}
      for (const k of keys) {
        picked[k] = item.json[k]
      }
      return { json: picked }
    })
  }

  return [result]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function compareItems(a, b, keys, disableDotNotation) {
  for (const key of keys) {
    const valA = getVal(a.json, key, disableDotNotation)
    const valB = getVal(b.json, key, disableDotNotation)
    if (!isDeepEqual(valA, valB)) return false
  }
  return true
}

function getVal(obj, key, disableDotNotation) {
  if (disableDotNotation) return obj[key]
  return dotGet(obj, key)
}

function dotGet(obj, path) {
  if (obj == null || !path) return undefined
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur = obj
  for (const part of parts) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * Flatten nested object keys to dot-notation keys.
 * E.g. { a: { b: 1 } } → { 'a.b': 1 }
 */
function flattenKeys(obj, prefix = '', result = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenKeys(v, key, result)
    } else {
      result[key] = v
    }
  }
  return result
}

function isDeepEqual(a, b) {
  if (a === b) return true
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

function isLessThan(a, b) {
  if (a == null && b != null) return true
  if (a != null && b == null) return false
  return a < b
}

function parseFields(val) {
  if (Array.isArray(val)) return val.map(s => String(s).trim()).filter(Boolean)
  if (!val) return []
  return String(val).split(',').map(s => s.trim()).filter(Boolean)
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}
