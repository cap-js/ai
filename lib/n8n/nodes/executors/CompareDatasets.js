/**
 * CompareDatasets.js — n8n-nodes-base.compareDatasets executor
 *
 * Compares Input A (port 0) against Input B (port 1).
 *
 * Real n8n output ports:
 *   0 — "In A only"   (items in A that have no matching key in B)
 *   1 — "Same"        (items whose matched pairs are identical)
 *   2 — "Different"   (items whose matched pairs differ)
 *   3 — "In B only"   (items in B that have no matching key in A)
 *
 * Parameters:
 *   mergeByFields.values  — array of { field1, field2 } match key pairs
 *   resolve               — 'preferInput1' | 'preferInput2' | 'mix' | 'includeBoth'
 *   fuzzyCompare          — boolean (type-tolerant comparison)
 *   preferWhenMix         — 'input1' | 'input2'  (only when resolve === 'mix')
 *   exceptWhenMix         — comma-separated fields (only when resolve === 'mix')
 *   options.skipFields    — comma-separated fields to exclude from equality check
 *   options.disableDotNotation
 *   options.multipleMatches — 'first' | 'all'
 *   options.fuzzyCompare  — v1 location for fuzzyCompare
 *
 * Dual-input handling:
 *   Input A = the `input` argument (items from the branch connected to port 0).
 *   Input B = context.mergeInputs?.input2 if populated by the engine,
 *             otherwise an empty array (no B branch connected).
 */

export function execute(node, input, context) {
  const params = node.parameters ?? {}
  const options = params.options ?? {}

  // Match field pairs
  const matchFields = (params.mergeByFields?.values ?? [])
    .filter(p => p.field1 !== '' && p.field2 !== '')

  if (matchFields.length === 0) {
    throw new Error('You need to define at least one pair of fields in "Fields to Match"')
  }

  const disableDotNotation = options.disableDotNotation ?? false
  const multipleMatches = options.multipleMatches ?? 'first'
  const skipFields = parseFields(options.skipFields ?? '')
  const fuzzyCompare = params.fuzzyCompare ?? options.fuzzyCompare ?? false
  const resolve = params.resolve ?? 'includeBoth'
  const preferWhenMix = params.preferWhenMix ?? 'input1'
  const exceptWhenMix = params.exceptWhenMix ?? ''

  // ── Get Input A and Input B ────────────────────────────────────────────────
  const inputA = normaliseInput(input)
  // Engine populates mergeInputs for multi-input nodes (same as Merge node)
  const inputB = normaliseInput(context?.mergeInputs?.input2 ?? [])

  const isEqual = fuzzyCompare ? fuzzyEquals : strictEquals

  // ── Find matches ───────────────────────────────────────────────────────────
  const data1 = [...inputA]
  const data2 = [...inputB]

  const filteredData = {
    matched: [],
    unmatched1: [],
    unmatched2: [],
  }
  const matchedInInput2 = new Set()

  outer: for (const entryA of data1) {
    // Build lookup: { field2Name: valueFromA.field1 }
    const lookup = {}
    for (const pair of matchFields) {
      const v = disableDotNotation ? entryA.json[pair.field1] : dotGet(entryA.json, pair.field1)
      if (v === undefined) {
        filteredData.unmatched1.push(entryA)
        continue outer
      }
      lookup[pair.field2] = v
    }

    const foundMatches = multipleMatches === 'all'
      ? findAllMatches(data2, lookup, disableDotNotation, isEqual)
      : findFirstMatch(data2, lookup, disableDotNotation, isEqual)

    if (foundMatches.length > 0) {
      for (const m of foundMatches) matchedInInput2.add(m.index)
      filteredData.matched.push({ entry: entryA, matches: foundMatches.map(m => m.entry) })
    } else {
      filteredData.unmatched1.push(entryA)
    }
  }

  for (let i = 0; i < data2.length; i++) {
    if (!matchedInInput2.has(i)) {
      filteredData.unmatched2.push(data2[i])
    }
  }

  // ── Classify matched pairs as same or different ────────────────────────────
  const same = []
  const different = []

  for (const { entry: entryA, matches } of filteredData.matched) {
    for (const entryB of matches) {
      // Build comparison copies — omit skipFields
      let jsonA = entryA.json
      let jsonB = entryB.json
      if (skipFields.length) {
        jsonA = omitFields(jsonA, skipFields, disableDotNotation)
        jsonB = omitFields(jsonB, skipFields, disableDotNotation)
      }

      const itemsAreEqual = fuzzyCompare
        ? Object.keys(jsonA).every(k => isEqual(jsonA[k], jsonB[k]))
        : isEqual(jsonA, jsonB)

      if (itemsAreEqual) {
        // Use preferInput2 version if fuzzyCompare + preferInput2 (matches n8n)
        if (fuzzyCompare && resolve === 'preferInput2') {
          same.push(entryB)
        } else {
          same.push(entryA)
        }
      } else {
        switch (resolve) {
          case 'preferInput1':
            different.push(entryA)
            break
          case 'preferInput2':
            different.push(entryB)
            break
          case 'mix':
            different.push(combineItems(entryA, entryB, preferWhenMix, exceptWhenMix, disableDotNotation))
            break
          default: // includeBoth
            different.push(buildIncludeBothItem(entryA, entryB, matchFields, skipFields, isEqual, disableDotNotation))
        }
      }
    }
  }

  // Output: [inAOnly, same, different, inBOnly]
  return [filteredData.unmatched1, same, different, filteredData.unmatched2]
}

// ── Match helpers ─────────────────────────────────────────────────────────────

function findAllMatches(data, lookup, disableDotNotation, isEqual) {
  return data.reduce((acc, entry, i) => {
    if (entry === undefined) return acc
    for (const [key, expectedValue] of Object.entries(lookup)) {
      const v = disableDotNotation ? entry.json[key] : dotGet(entry.json, key)
      if (!isEqual(expectedValue, v)) return acc
    }
    return acc.concat({ entry, index: i })
  }, [])
}

function findFirstMatch(data, lookup, disableDotNotation, isEqual) {
  const index = data.findIndex(entry => {
    if (entry === undefined) return false
    for (const [key, expectedValue] of Object.entries(lookup)) {
      const v = disableDotNotation ? entry.json[key] : dotGet(entry.json, key)
      if (!isEqual(expectedValue, v)) return false
    }
    return true
  })
  if (index === -1) return []
  return [{ entry: data[index], index }]
}

// ── Resolve helpers ───────────────────────────────────────────────────────────

function combineItems(itemA, itemB, prefer, except, disableDotNotation) {
  // prefer determines which input is the "base"; except fields come from the other
  const [base, other] = prefer === 'input1' ? [itemA, itemB] : [itemB, itemA]
  const result = { json: { ...base.json } }
  const exceptFields = parseFields(typeof except === 'string' ? except : '')
  for (const field of exceptFields) {
    if (disableDotNotation) {
      result.json[field] = other.json[field]
    } else {
      const v = dotGet(other.json, field) ?? null
      dotSet(result.json, field, v)
    }
  }
  return result
}

function buildIncludeBothItem(itemA, itemB, matchFields, skipFields, isEqual, disableDotNotation) {
  // Build the structured { keys, same, different } output n8n uses for includeBoth
  const keys = {}
  for (const pair of matchFields) {
    keys[pair.field1] = itemA.json[pair.field1]
  }

  const allKeys = union(Object.keys(itemA.json), Object.keys(itemB.json))
  const compareKeys = skipFields.length
    ? allKeys.filter(k => !skipFields.includes(k))
    : allKeys

  const sameFields = {}
  const differentFields = {}

  for (const key of compareKeys) {
    const vA = itemA.json[key]
    const vB = itemB.json[key]
    if (isEqual(vA, vB)) {
      sameFields[key] = vA
    } else {
      differentFields[key] = { inputA: vA ?? null, inputB: vB ?? null }
    }
  }

  return { json: { keys, same: sameFields, different: differentFields } }
}

// ── Comparison functions ──────────────────────────────────────────────────────

function strictEquals(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return false
}

function fuzzyEquals(a, b) {
  // Tolerate type differences: number 3 == string '3'
  if (a === b) return true
  if (a === null || b === null) return a == b // eslint-disable-line eqeqeq
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  // eslint-disable-next-line eqeqeq
  return a == b
}

// ── Field utilities ───────────────────────────────────────────────────────────

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

function dotSet(obj, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function omitFields(obj, fields, disableDotNotation) {
  if (!fields.length) return obj
  const result = { ...obj }
  for (const f of fields) {
    if (disableDotNotation) {
      delete result[f]
    } else {
      // Simple top-level omit for now (dot-notation nested omit is complex)
      delete result[f]
    }
  }
  return result
}

function union(a, b) {
  const s = new Set([...a, ...b])
  return [...s]
}

function parseFields(str) {
  if (!str) return []
  return str.split(',').map(s => s.trim()).filter(Boolean)
}

function normaliseInput(input) {
  if (!input) return []
  if (!Array.isArray(input)) return [{ json: typeof input === 'object' ? input : { value: input } }]
  if (input.length === 0) return []
  return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i ?? {} })
}
