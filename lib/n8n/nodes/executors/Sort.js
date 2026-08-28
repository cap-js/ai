/**
 * Sort.js — n8n-nodes-base.sort executor
 *
 * Matches the real n8n Sort node behaviour:
 *   type: simple  — sort by one or more named fields, asc or desc
 *   type: random  — Fisher-Yates shuffle
 *   type: code    — user-supplied JS comparison function via new Function()
 *
 * Options:
 *   disableDotNotation — treat field names literally (no nested path traversal)
 */

export function execute(node, input, _context) {
  const params = node.parameters ?? {}
  const type = params.type ?? 'simple'
  const items = normaliseInput(input)

  // ── random ──────────────────────────────────────────────────────────────────
  if (type === 'random') {
    const arr = [...items]
    // Fisher-Yates shuffle (matches n8n's shuffleArray utility)
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return [arr]
  }

  // ── code ────────────────────────────────────────────────────────────────────
  if (type === 'code') {
    const userCode = params.code ?? ''
    if (!/\breturn\b/.test(userCode)) {
      throw new Error("Sort code doesn't return. Please add a 'return' statement to your code")
    }
    // n8n wraps user code as the body of a sort comparator: (a, b) => { <userCode> }
    // The items array is available as `items` so the full expression is:
    //   return items.sort((a, b) => { <userCode> })
    // We replicate this exactly.
    const sortFn = new Function('items', `return items.sort((a, b) => { ${userCode} })`)
    const sorted = sortFn([...items])
    return [sorted]
  }

  // ── simple ───────────────────────────────────────────────────────────────────
  const disableDotNotation = params.options?.disableDotNotation ?? false
  const sortFields = params.sortFieldsUi?.sortField ?? []

  if (!sortFields.length) {
    throw new Error('No sorting specified. Please add a field to sort by')
  }

  const getVal = (obj, field) => {
    if (disableDotNotation) return obj[field]
    return dotGet(obj, field)
  }

  const sortFieldsWithDir = sortFields.map(f => ({
    name: f.fieldName,
    dir: f.order === 'descending' ? -1 : 1,
  }))

  const sorted = [...items].sort((a, b) => {
    for (const field of sortFieldsWithDir) {
      let valA = getVal(a.json, field.name)
      let valB = getVal(b.json, field.name)

      // Case-insensitive string comparison — matches n8n
      if (typeof valA === 'string') valA = valA.toLowerCase()
      if (typeof valB === 'string') valB = valB.toLowerCase()

      if (isDeepEqual(valA, valB)) continue

      const less = isLessThan(valA, valB)
      return less ? -1 * field.dir : 1 * field.dir
    }
    return 0
  })

  return [sorted]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Dot-notation field access (lodash `get` equivalent for simple paths).
 * Handles 'a.b.c' and array indices like 'a[0].b'.
 */
function dotGet(obj, path) {
  if (obj == null || !path) return undefined
  // Split on dots and bracket notation
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur = obj
  for (const part of parts) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

function isDeepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

function isLessThan(a, b) {
  if (a == null && b != null) return true
  if (a != null && b == null) return false
  return a < b
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}
