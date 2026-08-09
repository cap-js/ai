/**
 * SplitOut.js — n8n-nodes-base.splitOut executor (V1 conformant)
 *
 * Splits one or more array fields inside each item into individual output items.
 *
 * Parameters:
 *   parameters.fieldToSplitOut        — field name(s), comma-separated
 *   parameters.include                — 'noOtherFields' | 'allOtherFields' | 'selectedOtherFields'
 *   parameters.fieldsToInclude        — comma-separated (for selectedOtherFields)
 *   parameters.options.destinationFieldName  — rename the output field(s), comma-separated
 *   parameters.options.disableDotNotation    — treat dots literally
 *   parameters.options.includeBinary         — copy binary data through (no-op here, no binary support)
 *
 * Behaviour notes (from real n8n source):
 *   - If the value is not an array: scalars are wrapped in [value]; plain objects
 *     become Object.values(obj); null/undefined → produces no output items for that field.
 *   - When include === 'noOtherFields' AND the element is an object AND there is no
 *     destinationFieldName AND only one field is being split: spread the object's
 *     own keys directly onto the output item (not nested under the field name).
 *   - Multiple fields to split: produces items indexed across all arrays in parallel
 *     (not a cross-product). destinationFieldName count must equal fieldToSplitOut count.
 *
 * Output ports: 1 (main)
 */

export function execute(node, input, _context) {
  const params = node.parameters ?? {}
  const fieldToSplitOut = params.fieldToSplitOut ?? ''
  const include = params.include ?? 'noOtherFields'
  const fieldsToInclude = params.fieldsToInclude ?? ''
  const options = params.options ?? {}
  const disableDotNotation = options.disableDotNotation ?? false

  // destinationFieldName may be comma-separated when multiple split fields
  const destinationFields = (options.destinationFieldName ?? '')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean)

  const items = normaliseInput(input)

  // Support comma-separated list of fields to split out; strip leading "$json." prefix
  const fieldsToSplit = fieldToSplitOut
    .split(',')
    .map(f => f.trim().replace(/^\$json\./, ''))
    .filter(Boolean)

  if (fieldsToSplit.length === 0) return [items]

  // Validate: if destination fields given they must match split fields in count
  if (destinationFields.length && destinationFields.length !== fieldsToSplit.length) {
    throw new Error(
      'SplitOut: if multiple fields to split out are given, the same number of destination fields must be given'
    )
  }

  const includeFieldsList = fieldsToInclude
    .split(',')
    .map(f => f.trim())
    .filter(Boolean)

  const multiSplit = fieldsToSplit.length > 1
  const output = []

  for (const item of items) {
    const json = { ...(item.json ?? item) }

    // For each input item, collect all arrays to be split in parallel
    const arrays = []
    for (const [entryIndex, field] of fieldsToSplit.entries()) {
      if (field === '$binary') {
        // Binary splitting not supported — emit empty
        arrays.push([])
        continue
      }

      let entityToSplit = disableDotNotation
        ? json[field]
        : getNestedValue(json, field)

      if (entityToSplit === undefined || entityToSplit === null) {
        // Missing field → no items emitted for this entry
        arrays.push([])
        continue
      }

      // Wrap scalars
      if (typeof entityToSplit !== 'object') {
        entityToSplit = [entityToSplit]
      } else if (!Array.isArray(entityToSplit)) {
        // Plain object → Object.values()
        entityToSplit = Object.values(entityToSplit)
      }

      arrays.push(entityToSplit)
    }

    // Determine max length across all arrays (parallel split)
    const maxLen = Math.max(0, ...arrays.map(a => a.length))

    for (let elementIndex = 0; elementIndex < maxLen; elementIndex++) {
      const splitItem = { json: {} }

      for (const [entryIndex, field] of fieldsToSplit.entries()) {
        const destFieldName = destinationFields[entryIndex] || ''
        const fieldName = destFieldName || field
        const element = arrays[entryIndex][elementIndex]

        if (element === undefined) continue

        // n8n behaviour: if element is an object AND include===noOtherFields
        // AND no destinationFieldName AND single split → spread element's keys
        if (
          typeof element === 'object' &&
          element !== null &&
          include === 'noOtherFields' &&
          destFieldName === '' &&
          !multiSplit
        ) {
          Object.assign(splitItem.json, element)
        } else {
          splitItem.json[fieldName] = element
        }
      }

      // Apply include mode
      if (include === 'allOtherFields') {
        // Deep-clone the original item so that deleteNestedValue cannot mutate
        // shared nested objects that other downstream items still reference
        const itemCopy = JSON.parse(JSON.stringify(json))
        for (const field of fieldsToSplit) {
          if (disableDotNotation) {
            delete itemCopy[field]
          } else {
            deleteNestedValue(itemCopy, field)
          }
        }
        splitItem.json = { ...itemCopy, ...splitItem.json }
      } else if (include === 'selectedOtherFields') {
        if (!includeFieldsList.length) {
          throw new Error('SplitOut: no fields specified for selectedOtherFields')
        }
        for (const f of includeFieldsList) {
          const val = disableDotNotation ? json[f] : getNestedValue(json, f)
          if (val !== undefined) splitItem.json[f] = val
        }
      }

      output.push(splitItem)
    }
  }

  return [output]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normaliseInput(input) {
  if (!input) return []
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}

function getNestedValue(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function deleteNestedValue(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return
    cur = cur[parts[i]]
  }
  if (cur != null) delete cur[parts[parts.length - 1]]
}
