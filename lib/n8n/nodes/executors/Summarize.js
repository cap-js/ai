/**
 * Summarize.js — n8n-nodes-base.summarize executor
 *
 * Matches the real n8n Summarize node behaviour.
 *
 * Parameters:
 *   fieldsToSummarize.values  — array of { aggregation, field, includeEmpty, separateBy, customSeparator }
 *   fieldsToSplitBy           — comma-separated group-by field names
 *   options.outputFormat      — 'separateItems' (default) | 'singleItem'
 *   options.disableDotNotation
 *   options.skipEmptySplitFields
 *
 * Aggregation display name prefixes (match n8n exactly):
 *   append      → appended_
 *   average     → average_
 *   concatenate → concatenated_
 *   count       → count_
 *   countUnique → unique_count_
 *   max         → max_
 *   min         → min_
 *   sum         → sum_
 *
 * Output key = normalizeFieldName(`${prefix}${field}`)
 * where normalizeFieldName strips []" chars and replaces spaces/dots with _.
 */

const AGG_PREFIX = {
  append:      'appended_',
  average:     'average_',
  concatenate: 'concatenated_',
  count:       'count_',
  countUnique: 'unique_count_',
  max:         'max_',
  min:         'min_',
  sum:         'sum_',
}

const NUMERICAL_AGGREGATIONS = ['average', 'sum']

export function execute(node, input, _context) {
  const params = node.parameters ?? {}
  const options = params.options ?? {}
  const items = normaliseInput(input)

  // Group-by fields
  const fieldsToSplitBy = (params.fieldsToSplitBy ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)

  // Aggregation definitions
  const aggDefs = (params.fieldsToSummarize?.values ?? [])
    .filter(a => a.field !== '')

  if (aggDefs.length === 0) {
    throw new Error("You need to add at least one aggregation to 'Fields to Summarize' with non empty 'Field'")
  }

  const disableDotNotation = options.disableDotNotation ?? false
  const outputFormat = options.outputFormat ?? 'separateItems'

  const getValue = makeGetValue(disableDotNotation)

  // Enrich items with their original index (needed for pairedItems tracking)
  const newItems = items.map((item, i) => ({ ...item.json, _itemIndex: i }))

  const aggregationResult = aggregateAndSplitData({
    splitKeys: fieldsToSplitBy,
    inputItems: newItems,
    fieldsToSummarize: aggDefs,
    options: { ...options, outputFormat },
    getValue,
    convertKeysToString: false,
  })

  if (outputFormat === 'singleItem') {
    return [[{ json: flattenToObject(aggregationResult) }]]
  }

  // separateItems (default)
  if (!fieldsToSplitBy.length && 'returnData' in aggregationResult) {
    return [[{ json: aggregationResult.returnData }]]
  }

  const flatResults = flattenToArray(aggregationResult)
  return [flatResults.map(r => ({ json: r.returnData }))]
}

// ── Core aggregation logic ────────────────────────────────────────────────────

function aggregateAndSplitData({ splitKeys, inputItems, fieldsToSummarize, options, getValue, convertKeysToString }) {
  if (!splitKeys?.length) {
    return aggregateData(inputItems, fieldsToSummarize, options, getValue)
  }

  const [firstSplitKey, ...restSplitKeys] = splitKeys
  // Use plain object instead of Map (keys converted to string naturally)
  // but we need to preserve insertion order — plain object does that in modern JS
  const groupedItems = {}

  for (const item of inputItems) {
    let splitValue = getValue(item, firstSplitKey)
    if (splitValue && typeof splitValue === 'object') {
      splitValue = JSON.stringify(splitValue)
    }
    if (convertKeysToString) {
      splitValue = String(splitValue)
    }
    if (options.skipEmptySplitFields && typeof splitValue !== 'number' && !splitValue) {
      continue
    }
    const groupKey = String(splitValue)
    if (!groupedItems[groupKey]) groupedItems[groupKey] = []
    groupedItems[groupKey].push(item)
  }

  const splits = {}
  for (const [groupKey, items] of Object.entries(groupedItems)) {
    splits[groupKey] = aggregateAndSplitData({
      splitKeys: restSplitKeys,
      inputItems: items,
      fieldsToSummarize,
      options,
      getValue,
      convertKeysToString,
    })
  }

  return { fieldName: firstSplitKey, splits }
}

function aggregateData(data, fieldsToSummarize, options, getValue) {
  const returnData = {}
  for (const aggDef of fieldsToSummarize) {
    const key = normalizeFieldName(`${AGG_PREFIX[aggDef.aggregation] ?? ''}${aggDef.field}`)
    returnData[key] = aggregate(data, aggDef, getValue)
  }
  if (options.outputFormat === 'singleItem') {
    return { returnData }
  }
  return { returnData, pairedItems: data.map(item => item._itemIndex) }
}

function aggregate(items, entry, getValue) {
  const { aggregation, field } = entry
  let data = [...items]

  if (NUMERICAL_AGGREGATIONS.includes(aggregation)) {
    data = data.filter(item => {
      const v = getValue(item, field)
      return typeof v === 'number'
    })
  }

  switch (aggregation) {
    case 'append': {
      if (!entry.includeEmpty) {
        data = data.filter(item => !isEmpty(getValue(item, field)))
      }
      return data.map(item => getValue(item, field))
    }

    case 'concatenate': {
      const sep = entry.separateBy === 'other' ? (entry.customSeparator ?? '') : (entry.separateBy ?? ',')
      if (!entry.includeEmpty) {
        data = data.filter(item => !isEmpty(getValue(item, field)))
      }
      return data.map(item => {
        let value = getValue(item, field)
        if (typeof value === 'object' && value !== null) value = JSON.stringify(value)
        if (value === undefined) value = 'undefined'
        return value
      }).join(sep)
    }

    case 'average': {
      if (data.length === 0) return NaN
      return data.reduce((acc, item) => acc + getValue(item, field), 0) / data.length
    }

    case 'sum': {
      return data.reduce((acc, item) => acc + getValue(item, field), 0)
    }

    case 'min': {
      let min
      for (const item of data) {
        const v = getValue(item, field)
        if (v !== undefined && v !== null && v !== '') {
          if (min === undefined || v < min) min = v
        }
      }
      return min ?? null
    }

    case 'max': {
      let max
      for (const item of data) {
        const v = getValue(item, field)
        if (v !== undefined && v !== null && v !== '') {
          if (max === undefined || v > max) max = v
        }
      }
      return max ?? null
    }

    case 'countUnique': {
      if (!entry.includeEmpty) {
        return new Set(data.map(item => getValue(item, field)).filter(v => !isEmpty(v))).size
      }
      return new Set(data.map(item => getValue(item, field))).size
    }

    default: // count
      if (!entry.includeEmpty) {
        return data.filter(item => !isEmpty(getValue(item, field))).length
      }
      return data.length
  }
}

// ── Flatten helpers ───────────────────────────────────────────────────────────

function flattenToObject(result) {
  if ('splits' in result) {
    const out = {}
    for (const [key, value] of Object.entries(result.splits)) {
      out[key] = flattenToObject(value)
    }
    return out
  }
  return result.returnData
}

function flattenToArray(result) {
  if ('splits' in result) {
    const rows = []
    for (const [value, innerResult] of Object.entries(result.splits)) {
      const inner = flattenToArray(innerResult)
      for (const v of inner) {
        v.returnData[normalizeFieldName(result.fieldName)] = value
        rows.push(v)
      }
    }
    return rows
  }
  return [result]
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function normalizeFieldName(fieldName) {
  return fieldName.replace(/[\]\["]/g, '').replace(/[ .]/g, '_')
}

function isEmpty(value) {
  return value === undefined || value === null || value === ''
}

function makeGetValue(disableDotNotation) {
  return (item, field) => {
    if (disableDotNotation) return item[field]
    return dotGet(item, field)
  }
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

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}
