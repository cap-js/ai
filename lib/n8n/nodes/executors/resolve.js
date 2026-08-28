/**
 * resolve.js — n8n expression resolver for CAP execution
 *
 * Handles the subset of n8n expression syntax needed for flow-control nodes:
 *   - Plain values (non-expressions) returned as-is
 *   - ={{ $json.field }}                  → item.json.field
 *   - ={{ $json["field"] }}               → item.json["field"]
 *   - ={{ $json.a.b.c }}                  → nested access on item.json
 *   - ={{ $node["nodeName"].json.field }}  → field from a prior node's output
 *   - ={{ $('nodeName').first().json.f }}  → same, function-call style
 *   - ={{ $now }}                          → current ISO timestamp
 *   - ={{ $today }}                        → current date (YYYY-MM-DD)
 *   - ={{ $itemIndex }}                    → 0 (or context-supplied)
 *   - ={{ $json.a === $json.b }}           → JS expression via new Function()
 *   - ={{ $json.s.toUpperCase() }}         → string/method via new Function()
 *   - ={{ $x > 0 ? 'y' : 'n' }}           → ternary via new Function()
 *
 * Fast-paths handle pure property-access patterns cheaply.  Everything else
 * is evaluated through new Function() with standard n8n variables in scope.
 * Errors from the Function call return undefined rather than throwing.
 */

/**
 * Resolve a value that may be an n8n expression.
 *
 * @param {*}      expr        - The raw parameter value (may or may not be an expression)
 * @param {object} item        - Current item: { json: {...} }
 * @param {object} [nodeOutputs] - Map of nodeName → output items array, for $node[] access
 * @returns {*} Resolved value
 */
export function resolveValue(expr, item, nodeOutputs = {}) {
  if (typeof expr !== 'string') return expr

  // Fast-path: not an expression
  if (!expr.includes('={{') && !expr.startsWith('={{')) return expr

  // Strip ={{ ... }} wrapper — allow the full string to be an expression
  const m = expr.match(/^=\{\{([\s\S]*)\}\}$/)
  if (!m) return expr
  const inner = m[1].trim()

  return evalExprInner(inner, item, nodeOutputs)
}

/**
 * Resolve an expression string that is already stripped of ={{ }}.
 * Also used to resolve bare expressions when calling from conditions.
 */
export function evalExprInner(inner, item, nodeOutputs = {}) {
  const json = item?.json ?? item ?? {}

  // --- Fast-path: pure $json property access (no operators, no method calls) ---
  // Matches: $json  /  $json.field  /  $json["key"]  /  $json.a.b[0].c  etc.
  // Does NOT match: $json.a + 1  /  $json.s.toUpperCase()  (falls through to full eval)
  if (inner.startsWith('$json')) {
    const rest = inner.slice(5)
    if (!rest || /^(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*|\[["'][^"']+["']\]|\[\d+\])*$/.test(rest)) {
      return getPath(json, rest)
    }
    // Has operators or method calls — fall through to full eval
  }

  // --- Fast-path: $('nodeName').accessor.chain ---
  const fnCallMatch = inner.match(/^\$\(['"](.+?)['"]\)(.*)$/)
  if (fnCallMatch) {
    const nodeName = fnCallMatch[1]
    const rest = fnCallMatch[2]  // e.g. ".item.json.value" or ".first().json.value"
    const nodeItems = nodeOutputs[nodeName]
    if (!nodeItems) return undefined
    const items = Array.isArray(nodeItems) ? nodeItems : [nodeItems]

    // .all()
    if (rest === '.all()') return items

    // .last()
    if (rest.startsWith('.last()')) {
      const targetItem = items[items.length - 1]
      const afterMethod = rest.slice('.last()'.length)
      if (!afterMethod) return targetItem
      if (afterMethod.startsWith('.json')) {
        return getPath(targetItem?.json ?? targetItem, afterMethod.slice('.json'.length) || '')
      }
      return getPath(targetItem, afterMethod)
    }

    // .first() or .item — both mean first item
    const afterMethod = rest.startsWith('.first()') ? rest.slice('.first()'.length)
                      : rest.startsWith('.item')    ? rest.slice('.item'.length)
                      : rest
    const targetItem = items[0]
    if (!afterMethod) return targetItem
    if (afterMethod.startsWith('.json')) {
      return getPath(targetItem?.json ?? targetItem, afterMethod.slice('.json'.length) || '')
    }
    return getPath(targetItem, afterMethod)
  }

  // --- Fast-path: $node["nodeName"].json.field ---
  const nodeMatch = inner.match(/^\$node\[["'](.+?)["']\](.*)$/)
  if (nodeMatch) {
    const nodeName = nodeMatch[1]
    const rest = nodeMatch[2] // e.g. ".json.field"
    const nodeItems = nodeOutputs[nodeName]
    if (!nodeItems) return undefined
    const firstItem = Array.isArray(nodeItems) ? nodeItems[0] : nodeItems
    if (!rest) return firstItem
    // rest is like ".json.field", ".json", or ".field"
    if (rest.startsWith('.json')) {
      const afterJson = rest.slice('.json'.length) // '' or '.field'
      if (!afterJson) return firstItem?.json ?? firstItem
      return getPath(firstItem?.json ?? firstItem, afterJson)
    }
    return getPath(firstItem, rest)
  }

  // --- Full JS eval via new Function() ---
  // Handles: operators, ternaries, string/array methods, $now, $today, $itemIndex,
  // and complex $json/$node/$() expressions that didn't match the fast-paths above.
  return _evalFull(inner, json, nodeOutputs)
}

/**
 * Evaluate an expression in a context that provides the standard n8n variables.
 * Returns undefined (never throws) if evaluation fails.
 *
 * @param {string} inner       - Expression body (no ={{ }} wrapper)
 * @param {object} json        - Resolved item.json
 * @param {object} nodeOutputs - Map of nodeName → items array
 * @returns {*}
 */
function _evalFull(inner, json, nodeOutputs) {
  // Build an accessor object for a node — mirrors n8n's RunData API surface
  const makeAccessor = nodeName => {
    const nodeItems = nodeOutputs[nodeName]
    const arr = nodeItems ? (Array.isArray(nodeItems) ? nodeItems : [nodeItems]) : []
    return {
      first:  () => arr[0],
      last:   () => arr[arr.length - 1],
      all:    () => arr,
      get item() { return arr[0] },
      // $node["Name"].json gives the first item's json — the most common access pattern
      get json() { return arr[0]?.json ?? arr[0] },
    }
  }

  // $node["name"] / $node.name — Proxy so any property lookup returns an accessor
  const $nodeProxy = new Proxy({}, {
    get: (_, name) => makeAccessor(name),
  })

  try {
    // eslint-disable-next-line no-new-func
    return new Function(
      '$json', '$now', '$today', '$itemIndex', '$', '$node', '$items',
      `return ${inner}`
    )(
      json,
      new Date().toISOString(),
      new Date().toISOString().slice(0, 10),
      0,
      makeAccessor,   // $('nodeName')
      $nodeProxy,     // $node["nodeName"] / $node.nodeName
      makeAccessor,   // $items('nodeName')
    )
  } catch {
    return undefined
  }
}

/**
 * Walk a path string like ".field", ".a.b", "['key']", or ".a['b'].c"
 * starting from obj.
 */
function getPath(obj, pathStr) {
  if (!pathStr || pathStr === '') return obj
  if (obj == null) return undefined

  // Tokenise the path: accept .key  ["key"]  ['key']  [0]
  const tokens = []
  const re = /\.([a-zA-Z_$][a-zA-Z0-9_$]*)|(?:\[["']([^"']+)["']\])|(?:\[(\d+)\])/g
  let match
  while ((match = re.exec(pathStr)) !== null) {
    tokens.push(match[1] ?? match[2] ?? Number(match[3]))
  }

  let cur = obj
  for (const tok of tokens) {
    if (cur == null) return undefined
    cur = cur[tok]
  }
  return cur
}
