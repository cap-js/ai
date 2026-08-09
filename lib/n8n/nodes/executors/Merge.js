/**
 * Merge.js — n8n-nodes-base.merge executor (V3 conformant)
 *
 * Modes (node.parameters.mode):
 *   append           — concatenate all inputs in order
 *   combine          — depends on combineBy:
 *     combineByFields    — join on matching key fields (inner/left/right/outer join)
 *     combineByPosition  — zip inputs by index
 *     combineAll         — cartesian product of input1 × input2
 *     combineBySql       — not supported; falls back to append
 *   chooseBranch     — output from a selected input branch
 *
 * Multi-input handling:
 *   In the CAP engine each node receives one `input` array (from the immediately
 *   upstream node on the primary connection).  When the engine has collected items
 *   from multiple upstream branches it may populate `context.mergeInputs`:
 *     { input1: items[], input2: items[], ...inputN: items[] }
 *   If mergeInputs is absent we treat all input items as input1 and input2 as [].
 *
 * Output ports: 1 (main)
 */

import cds from '@sap/cds'

const log = cds.log('n8n:merge')

export function execute(node, input, context) {
  const params = node.parameters ?? {}
  const mode = params.mode ?? 'append'

  // Prefer explicit multi-input bag when the engine provides it
  const mi = context?.mergeInputs
  const input1 = mi?.input1 ?? normaliseInput(input)
  const input2 = mi?.input2 ?? []

  // Collect all inputs for modes that accept N inputs (append, chooseBranch)
  const allInputs = mi
    ? Object.values(mi)
    : [input1, input2]

  let result
  switch (mode) {

    // ── append ──────────────────────────────────────────────────────────────
    case 'append': {
      result = []
      for (const inp of allInputs) result.push(...inp)
      break
    }

    // ── combine ─────────────────────────────────────────────────────────────
    case 'combine': {
      const combineBy = params.combineBy ?? 'combineByFields'
      result = executeCombine(combineBy, params, input1, input2)
      break
    }

    // ── chooseBranch ────────────────────────────────────────────────────────
    case 'chooseBranch': {
      const output = params.output ?? 'specifiedInput'
      if (output === 'empty') {
        result = [{ json: {} }]
      } else {
        // useDataOfInput is 1-based
        const idx = (params.useDataOfInput ?? 1) - 1
        result = allInputs[idx] ?? []
      }
      break
    }

    // ── Legacy mode names (V1/V2 compat) ────────────────────────────────────
    case 'mergeByIndex':
    case 'combineByPosition':
      result = combineByPosition(input1, input2, params)
      break

    case 'mergeByField':
    case 'combineByFields':
      result = combineByFields(input1, input2, params)
      break

    case 'multiplex':
    case 'combineAll':
      result = combineAll(input1, input2)
      break

    // V1 enrichment modes — kept for back-compat
    case 'enrichInput1':
      result = enrichInput(input1, input2, params, 1)
      break
    case 'enrichInput2':
      result = enrichInput(input1, input2, params, 2)
      break

    case 'keepKeyMatches': {
      const joinField = params.options?.joinField ?? 'id'
      const keys2 = new Set(input2.map(i => i.json[joinField]))
      result = input1.filter(i => keys2.has(i.json[joinField]))
      break
    }
    case 'removeKeyMatches': {
      const joinField = params.options?.joinField ?? 'id'
      const keys2 = new Set(input2.map(i => i.json[joinField]))
      result = input1.filter(i => !keys2.has(i.json[joinField]))
      break
    }

    default:
      log.warn(`Merge node "${node.name}": unknown mode "${mode}" — appending inputs`)
      result = [...input1, ...input2]
  }

  return [result]
}

// ── combine dispatch ────────────────────────────────────────────────────────

function executeCombine(combineBy, params, input1, input2) {
  switch (combineBy) {
    case 'combineByFields':
      return combineByFields(input1, input2, params)
    case 'combineByPosition':
      return combineByPosition(input1, input2, params)
    case 'combineAll':
      return combineAll(input1, input2)
    case 'combineBySql':
      // SQL not implementable without a SQL engine — log and fall through
      log.warn('Merge: combineBySql is not supported; falling back to append')
      return [...input1, ...input2]
    default:
      return combineByFields(input1, input2, params)
  }
}

// ── combineByFields (inner / left / right / outer join) ─────────────────────
//
// params:
//   fieldsToMatchString  — comma-separated field names (same in both inputs)
//   mergeByFields.values — [{ field1, field2 }] (when advanced: true)
//   advanced             — boolean
//   joinMode             — keepMatches | keepNonMatches | keepEverything |
//                          enrichInput1 | enrichInput2
//   outputDataFrom       — both | input1 | input2
//   options.disableDotNotation
//   options.multipleMatches — all | first

function combineByFields(input1, input2, params) {
  // Resolve match-field pairs
  let matchPairs
  if (params.advanced) {
    matchPairs = (params.mergeByFields?.values ?? [])
  } else {
    const str = params.fieldsToMatchString ?? params.joinField ?? 'id'
    matchPairs = str.split(',').map(f => {
      const field = f.trim()
      return { field1: field, field2: field }
    }).filter(p => p.field1)
  }

  if (!matchPairs.length) return [...input1, ...input2]

  const joinMode = params.joinMode ?? 'keepMatches'
  const outputDataFrom = params.outputDataFrom ?? 'both'
  const disableDot = params.options?.disableDotNotation ?? false
  const multipleMatches = params.options?.multipleMatches ?? 'all'

  const getVal = (item, field) =>
    disableDot ? item.json[field] : getNestedValue(item.json, field)

  // Build match key function (multi-field key as JSON string for reliable equality)
  const makeKey1 = item => JSON.stringify(matchPairs.map(p => getVal(item, p.field1)))
  const makeKey2 = item => JSON.stringify(matchPairs.map(p => getVal(item, p.field2)))

  // Index input2 by key
  const idx2 = {}
  for (const item of input2) {
    const k = makeKey2(item)
    if (!idx2[k]) idx2[k] = []
    idx2[k].push(item)
  }

  const matched = []       // { entry: item1, matches: [item2, ...] }
  const unmatched1 = []
  const matched2Keys = new Set()

  for (const item1 of input1) {
    const k = makeKey1(item1)
    const partners = idx2[k] ?? []
    if (partners.length) {
      const usePartners = multipleMatches === 'first' ? [partners[0]] : partners
      matched.push({ entry: item1, matches: usePartners })
      usePartners.forEach(p => matched2Keys.add(makeKey2(p)))
    } else {
      unmatched1.push(item1)
    }
  }
  const unmatched2 = input2.filter(item => !matched2Keys.has(makeKey2(item)))

  // Build output
  const output = []

  if (joinMode === 'keepMatches') {
    for (const { entry, matches } of matched) {
      for (const m of matches) {
        if (outputDataFrom === 'input1') output.push(entry)
        else if (outputDataFrom === 'input2') output.push(m)
        else output.push({ json: { ...entry.json, ...m.json } })
      }
    }
  }

  if (joinMode === 'keepNonMatches') {
    if (outputDataFrom === 'input1') return unmatched1
    if (outputDataFrom === 'input2') return unmatched2
    // both: tag with _source
    return [
      ...unmatched1.map(i => ({ json: { ...i.json, _source: 'input1' } })),
      ...unmatched2.map(i => ({ json: { ...i.json, _source: 'input2' } })),
    ]
  }

  if (joinMode === 'keepEverything') {
    for (const { entry, matches } of matched) {
      for (const m of matches) {
        if (outputDataFrom === 'input1') output.push(entry)
        else if (outputDataFrom === 'input2') output.push(m)
        else output.push({ json: { ...entry.json, ...m.json } })
      }
    }
    if (outputDataFrom !== 'input2') output.push(...unmatched1)
    if (outputDataFrom !== 'input1') output.push(...unmatched2)
  }

  if (joinMode === 'enrichInput1') {
    for (const { entry, matches } of matched) {
      for (const m of matches) {
        output.push({ json: { ...entry.json, ...m.json } })
      }
    }
    output.push(...unmatched1)
  }

  if (joinMode === 'enrichInput2') {
    for (const { entry, matches } of matched) {
      for (const m of matches) {
        output.push({ json: { ...entry.json, ...m.json } })
      }
    }
    output.push(...unmatched2)
  }

  return output
}

// ── combineByPosition (zip) ──────────────────────────────────────────────────
//
// params.options.includeUnpaired — whether to include unmatched trailing items

function combineByPosition(input1, input2, params) {
  const includeUnpaired = params.options?.includeUnpaired ?? false
  const len = includeUnpaired
    ? Math.max(input1.length, input2.length)
    : Math.min(input1.length, input2.length)

  const result = []
  for (let i = 0; i < len; i++) {
    const a = input1[i]?.json ?? {}
    const b = input2[i]?.json ?? {}
    result.push({ json: { ...a, ...b } })
  }
  return result
}

// ── combineAll (cartesian product) ──────────────────────────────────────────

function combineAll(input1, input2) {
  if (!input1.length || !input2.length) return []
  const result = []
  for (const a of input1) {
    for (const b of input2) {
      result.push({ json: { ...a.json, ...b.json } })
    }
  }
  return result
}

// ── enrichInput helper (V1 back-compat) ─────────────────────────────────────

function enrichInput(input1, input2, params, dominantInputNum) {
  const joinField = params.options?.joinField ?? 'id'
  if (dominantInputNum === 1) {
    const map2 = {}
    for (const i of input2) { map2[i.json[joinField]] = i.json }
    return input1.map(i => ({ json: { ...i.json, ...(map2[i.json[joinField]] ?? {}) } }))
  } else {
    const map1 = {}
    for (const i of input1) { map1[i.json[joinField]] = i.json }
    return input2.map(i => ({ json: { ...(map1[i.json[joinField]] ?? {}), ...i.json } }))
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNestedValue(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function normaliseInput(input) {
  if (!input) return []
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}
