/**
 * cql-fusion.js — CQL query pushdown via flowing query tokens
 *
 * capEntity(list/get) and capCql nodes emit a `_cql_query` token instead of
 * executing immediately.  Foldable downstream nodes (Filter, Sort, Limit, If)
 * modify the token and pass it on.  The first non-foldable node executes
 * whatever query it received.
 *
 * Token shapes:
 *   { type:'capEntity', service, entity, operation, filter, columns, key, orderBy, top, skip }
 *   { type:'capCql',    baseCql, namedParams, where, orderBy, top }
 *
 * If nodes receive a token and produce two independently-modified tokens on
 * their two output ports — one with the condition added, one with NOT condition.
 * This means each branch's consumer executes a different query, naturally.
 *
 * The token is stripped from recorded execution outputs by _finishStep so the
 * n8n UI shows no items flowing through fusion nodes.
 */

import { resolveValue } from './nodes/executors/resolve.js'

// ── Condition → CQL WHERE string ─────────────────────────────────────────────

const OP_MAP = {
  equals:      (l, r) => `${l} = ${r}`,
  notEquals:   (l, r) => `${l} != ${r}`,
  gt:          (l, r) => `${l} > ${r}`,
  gte:         (l, r) => `${l} >= ${r}`,
  lt:          (l, r) => `${l} < ${r}`,
  lte:         (l, r) => `${l} <= ${r}`,
  contains:    (l, r) => `${l} like '%${r}%'`,
  notContains: (l, r) => `${l} not like '%${r}%'`,
  startsWith:  (l, r) => `${l} like '${r}%'`,
  endsWith:    (l, r) => `${l} like '%${r}'`,
  exists:      (l)    => `${l} is not null`,
  notExists:   (l)    => `${l} is null`,
  true:        (l)    => `${l} = true`,
  false:       (l)    => `${l} = false`,
}

function jsonField(expr) {
  if (typeof expr !== 'string') return null
  const m = expr.match(/^={{\s*\$json\.([a-zA-Z_][a-zA-Z0-9_.]*)\s*}}$/)
  return m ? m[1] : null
}

function formatRhs(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string' && value.includes('={{')) return null
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function conditionToCql(cond) {
  const field = jsonField(cond.leftValue ?? cond.value1 ?? '')
  if (!field) return null
  const op   = cond.operator?.operation ?? cond.operator ?? cond.operation ?? 'equals'
  const opFn = OP_MAP[op]
  if (!opFn) return null
  const isSingleValue = ['exists', 'notExists', 'true', 'false', 'empty', 'notEmpty'].includes(op)
  if (isSingleValue) return opFn(field)
  const rhs = formatRhs(cond.rightValue ?? cond.value2)
  if (rhs === null) return null
  return opFn(field, rhs)
}

export function conditionsBlockToCql(conditionsParam) {
  const block = conditionsParam?.conditions ?? conditionsParam
  if (!Array.isArray(block?.conditions ?? block)) return null
  const list      = block.conditions ?? block
  const combinator = block.combinator ?? 'and'
  const parts = []
  for (const c of list) {
    const frag = conditionToCql(c)
    if (frag === null) return null
    parts.push(frag)
  }
  if (!parts.length) return null
  return parts.length === 1 ? parts[0] : `(${parts.join(` ${combinator.toUpperCase()} `)})`
}

export function sortToCql(params) {
  if (params.type !== 'simple' && params.type !== undefined && params.type !== '') return null
  const fields = params.sortFieldsUi?.sortField ?? []
  if (!fields.length) return null
  return fields.map(f => `${f.fieldName} ${f.order === 'descending' ? 'desc' : 'asc'}`).join(', ')
}

// ── Query token factories ─────────────────────────────────────────────────────

export function makeCapEntityQuery(node, inputItems, nodeOutputs) {
  const p    = node.parameters ?? {}
  const item = inputItems[0] ?? { json: {} }
  const rv   = v => resolveValue(v, item, nodeOutputs)
  return {
    _sourceNodeName: node.name,
    type:      'capEntity',
    service:   rv(p.service),
    entity:    rv(p.entity),
    operation: rv(p.operation) ?? 'list',
    filter:    rv(p.filter)  ?? null,
    columns:   rv(p.columns) ?? null,
    key:       rv(p.key)     ?? null,
    orderBy:   rv(p.orderBy) ?? null,
    top:       rv(p.top)  != null ? Number(rv(p.top))  : null,
    skip:      rv(p.skip) != null ? Number(rv(p.skip)) : null,
  }
}

export function makeCapCqlQuery(node, inputItems, nodeOutputs) {
  const p    = node.parameters ?? {}
  const item = inputItems[0] ?? { json: {} }
  const rv   = v => resolveValue(v, item, nodeOutputs)
  const baseCql = rv(p.cql)
  if (!baseCql) throw new Error(`capCql node "${node.name}" requires a cql parameter`)
  const cqlParamsRaw = rv(p.params)
  let namedParams = cqlParamsRaw
  if (!namedParams) {
    const refs = [...baseCql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1])
    if (refs.length) namedParams = Object.fromEntries(refs.map(k => [k, item.json[k]]))
  }
  return { _sourceNodeName: node.name, type: 'capCql', baseCql, namedParams: namedParams ?? {}, where: null, orderBy: null, top: null }
}

// ── Query token modifiers ─────────────────────────────────────────────────────

/** Add a WHERE condition. Returns null if not foldable (e.g. capEntity get). */
export function addWhereToQuery(query, where) {
  if (query.type === 'capCql') {
    return { ...query, where: query.where ? `(${query.where}) and (${where})` : where }
  }
  if (query.type === 'capEntity' && query.operation !== 'get') {
    return { ...query, filter: query.filter ? `(${query.filter}) and (${where})` : where }
  }
  return null
}

/** Split a query into true/false branches for an If node. Returns null if not foldable. */
export function branchQuery(query, where) {
  const q0 = addWhereToQuery(query, where)
  const q1 = addWhereToQuery(query, `not (${where})`)
  if (!q0 || !q1) return null
  return { port0: q0, port1: q1 }
}

/** Add ORDER BY. Returns new token or null. */
export function addOrderByToQuery(query, orderBy) {
  if (query.type === 'capCql' || query.type === 'capEntity') return { ...query, orderBy }
  return null
}

/** Add LIMIT/top. Returns new token or null. */
export function addTopToQuery(query, top) {
  if (query.type === 'capCql' || query.type === 'capEntity') {
    return { ...query, top: query.top != null ? Math.min(query.top, top) : top }
  }
  return null
}

/** Record that a node was folded into this token (for nodeOutputs backfill on execution). */
export function foldNodeIntoToken(query, nodeName) {
  const chain = query._foldedNodeNames ? [...query._foldedNodeNames, nodeName] : [nodeName]
  return { ...query, _foldedNodeNames: chain }
}

// ── Query execution ───────────────────────────────────────────────────────────

/**
 * Execute a query token, returning an array of { json: row } items.
 * previewMode caps results to 1 row (UI "run this node" requests).
 */
export async function executeQueryToken(query, context, runCapEntity, previewMode = false) {
  const toItems = rows => (Array.isArray(rows) ? rows : rows != null ? [rows] : []).map(r => ({ json: r }))

  if (query.type === 'capCql') {
    let cql = query.baseCql
    if (query.where) cql = `SELECT * FROM (${cql}) WHERE ${query.where}`
    if (query.orderBy) cql += ` ORDER BY ${query.orderBy}`
    const top = previewMode ? 1 : query.top
    if (top) cql += ` LIMIT ${top}`
    const cqn = context.cds.parse.cql(cql)
    const output = await context.cds.run(cqn, query.namedParams ?? [])
    return toItems(Array.isArray(output) ? output : output != null ? [output] : [])
  }

  if (query.type === 'capEntity') {
    const rows = await runCapEntity({
      service:   query.service,
      entity:    query.entity,
      operation: query.operation,
      filter:    query.filter,
      columns:   query.columns,
      key:       query.key,
      orderBy:   query.orderBy,
      top:       previewMode ? 1 : query.top,
      skip:      query.skip,
    })
    return toItems(rows)
  }

  return []
}
