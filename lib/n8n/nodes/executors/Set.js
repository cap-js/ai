/**
 * Set.js — n8n-nodes-base.set executor (v3.x / Edit Fields)
 *
 * Modifies item fields. Supports all parameter shapes:
 *
 * v3.3+ (assignmentCollection):
 *   parameters.assignments.assignments = [
 *     { id, name, value, type }   ← type is 'string'|'number'|'boolean'|'array'|'object'
 *   ]
 *
 * v3.0–3.2 (fields.values):
 *   parameters.fields.values = [
 *     { name, type, stringValue|numberValue|booleanValue|arrayValue|objectValue }
 *   ]
 *
 * JSON / raw mode:
 *   parameters.mode = 'raw'
 *   parameters.jsonOutput = '{ ... }' or expression resolving to an object
 *
 * Field inclusion:
 *   parameters.includeOtherFields  (boolean, v3.3+)
 *   parameters.include             ('all'|'none'|'selected'|'except', v3.0–3.2 and v3.3+ with includeOtherFields=true)
 *   parameters.includeFields       (comma-separated field names, for 'selected')
 *   parameters.excludeFields       (comma-separated field names, for 'except')
 *
 * Options:
 *   parameters.options.dotNotation  (boolean, default true) — whether to expand dot paths
 *
 * Output ports: 1 (main)
 */

import { resolveValue } from './resolve.js'
import cds from '@sap/cds'

const log = cds.log('n8n:set')

/**
 * @param {object} node
 * @param {Array}  input
 * @param {object} context - { executionId, workflowId, nodeOutputs }
 * @returns {Array[]}
 */
export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  const output = []
  for (let i = 0; i < items.length; i++) {
    let result
    try {
      result = resolveItemAssignments(params, items[i], nodeOutputs, node.name, i, items)
    } catch (err) {
      log.warn(`Set node "${node.name}" item ${i}: ${err.message}`)
      result = items[i]
    }
    // duplicateItem: repeat the output item duplicateCount+1 times (n8n manual-mode feature)
    if (params.duplicateItem === true) {
      const count = params.duplicateCount ?? 0
      for (let j = 0; j <= count; j++) output.push(result)
    } else {
      output.push(result)
    }
  }

  return [output]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) {
    return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
  }
  return [{ json: input }]
}

function resolveItemAssignments(params, item, nodeOutputs, nodeName, itemIndex, allItems) {
  const mode = params.mode ?? 'manual'
  const options = params.options ?? {}
  const dotNotation = options.dotNotation !== false  // default true

  // Determine what input fields to include in the output
  // v3.3+: controlled by includeOtherFields + include
  // v3.0–3.2: controlled by include directly
  const includeOtherFields = params.includeOtherFields ?? false
  let include = params.include ?? 'all'

  // v3.3+ semantics: if includeOtherFields=false, force 'none'
  // (the node was TypeVersion >= 3.3 if it has the assignments param OR if include is not set)
  const hasAssignments = !!(params.assignments?.assignments)
  const isV33plus = hasAssignments || params.includeOtherFields !== undefined
  if (isV33plus) {
    include = includeOtherFields ? include : 'none'
  }

  // Build the base json object from input (respecting include mode)
  const base = buildBase(item, include, params, itemIndex)

  // ── raw mode ──────────────────────────────────────────────────────────────
  if (mode === 'raw') {
    const rawExpr = params.jsonOutput ?? params.json
    if (rawExpr !== undefined) {
      let newData
      try {
        const resolved = resolveValue(rawExpr, item, nodeOutputs)
        newData = typeof resolved === 'string' ? JSON.parse(resolved) : resolved
      } catch (err) {
        log.warn(`Set node "${nodeName}": could not parse jsonOutput — ${err.message}`)
        newData = {}
      }
      if (typeof newData !== 'object' || newData === null || Array.isArray(newData)) {
        log.warn(`Set node "${nodeName}": jsonOutput did not resolve to an object`)
        newData = {}
      }
      // In raw mode the newData IS the full output; merge with base
      return { json: { ...base, ...newData } }
    }
  }

  // ── manual mode: v3.3+ assignmentCollection ───────────────────────────────
  if (hasAssignments) {
    const assignments = params.assignments.assignments
    const out = { ...base }
    for (const a of assignments) {
      const name = a.name
      if (name === undefined || name === '') continue
      const resolved = resolveValue(a.value, item, nodeOutputs)
      const coerced = coerceType(resolved, a.type, options.ignoreConversionErrors)
      setPath(out, name, coerced, dotNotation)
    }
    return { json: out }
  }

  // ── manual mode: v3.0–3.2 fields.values ──────────────────────────────────
  const fieldsValues = params.fields?.values
  if (Array.isArray(fieldsValues)) {
    const out = { ...base }
    for (const entry of fieldsValues) {
      const name = entry.name
      if (!name) continue
      // entry.type is 'string'|'number'|'boolean'|'array'|'object'; the value lives in stringValue etc.
      const typeName = entry.type  // 'string', 'number', etc.
      const typeKey = typeName ? typeName + 'Value' : null  // 'stringValue', 'numberValue', etc.
      const rawVal = typeKey ? (entry[typeKey] ?? entry.value) : entry.value
      const resolved = resolveValue(rawVal, item, nodeOutputs)
      const coerced = coerceType(resolved, typeName, options.ignoreConversionErrors)
      setPath(out, name, coerced, dotNotation)
    }
    return { json: out }
  }

  // ── Legacy flat { values: [ { name, value } ] } ───────────────────────────
  const legacyValues = params.values
  if (Array.isArray(legacyValues)) {
    const out = { ...base }
    for (const v of legacyValues) {
      const name = v.name ?? v.field
      if (!name) continue
      const resolved = resolveValue(v.value, item, nodeOutputs)
      setPath(out, name, resolved, dotNotation)
    }
    return { json: out }
  }

  // ── raw mode (no mode key, but jsonOutput present) ────────────────────────
  if (params.jsonOutput !== undefined) {
    let newData
    try {
      const resolved = resolveValue(params.jsonOutput, item, nodeOutputs)
      newData = typeof resolved === 'string' ? JSON.parse(resolved) : resolved
    } catch { newData = {} }
    return { json: { ...base, ...newData } }
  }

  // Nothing to do — pass through
  return item
}

/**
 * Build the base output object according to the include strategy.
 */
function buildBase(item, include, params, itemIndex) {
  switch (include) {
    case 'all':
      return { ...item.json }

    case 'selected': {
      const out = {}
      const fields = (params.includeFields ?? '')
        .split(',').map(f => f.trim()).filter(Boolean)
      for (const key of fields) {
        const val = getNestedPath(item.json, key)
        if (val !== undefined) out[key] = val
      }
      return out
    }

    case 'except': {
      const out = { ...item.json }
      const fields = (params.excludeFields ?? '')
        .split(',').map(f => f.trim()).filter(Boolean)
      for (const key of fields) {
        delete out[key]
      }
      return out
    }

    case 'none':
    default:
      return {}
  }
}

/**
 * Set a value at a path, respecting the dotNotation flag.
 * With dotNotation=true (default): "a.b" → { a: { b: value } }
 * With dotNotation=false: "a.b" → { "a.b": value }
 */
function setPath(obj, path, value, dotNotation) {
  if (!dotNotation) {
    obj[path] = value
    return
  }
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (cur[part] == null || typeof cur[part] !== 'object') {
      cur[part] = {}
    }
    cur = cur[part]
  }
  cur[parts[parts.length - 1]] = value
}

function getNestedPath(obj, path) {
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function coerceType(value, type, ignoreErrors = false) {
  if (value === undefined || value === null) return value
  try {
    switch (type) {
      case 'number':
        return Number(value)
      case 'boolean':
        if (typeof value === 'boolean') return value
        if (value === 'true'  || value === '1' || value === 1) return true
        if (value === 'false' || value === '0' || value === 0) return false
        return Boolean(value)
      case 'string':
        return typeof value === 'object' ? JSON.stringify(value) : String(value)
      case 'array':
        if (Array.isArray(value)) return value
        if (typeof value === 'string') return JSON.parse(value)
        return [value]
      case 'object':
        if (typeof value === 'object' && !Array.isArray(value)) return value
        if (typeof value === 'string') return JSON.parse(value)
        return value
      default:
        return value
    }
  } catch (err) {
    if (ignoreErrors) return value
    throw err
  }
}
