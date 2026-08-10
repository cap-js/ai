'use strict'
// CAP Entity node — read, create, update, or delete a CDS entity via OData
// Calls the CAP server's OData endpoint, so it works with any entity exposed
// by any ApplicationService already running in the same CAP application.
const { NodeConnectionTypes, NodeOperationError } = require('n8n-workflow')

class CapEntity {
  description = {
    displayName: 'CAP Entity',
    name: 'capEntity',
    icon: 'node:database',
    iconColor: 'blue',
    group: ['transform'],
    version: 1,
    description: 'Read, create, update or delete a CDS entity via the CAP OData API',
    defaults: { name: 'CAP Entity' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    properties: [
      {
        displayName: 'CAP Server URL',
        name: 'baseUrl',
        type: 'string',
        default: 'http://localhost:4004',
        description: 'Root URL of the CAP server',
        required: true,
      },
      {
        displayName: 'Service Path',
        name: 'servicePath',
        type: 'string',
        default: '/odata/v4/catalog',
        description: 'OData service path, e.g. /odata/v4/catalog',
        required: true,
      },
      {
        displayName: 'Entity',
        name: 'entity',
        type: 'string',
        default: 'Books',
        description: 'Entity set name, e.g. Books',
        required: true,
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        options: [
          { name: 'Read (List)', value: 'list', description: 'GET entity set — returns an array' },
          { name: 'Read (By Key)', value: 'get', description: 'GET a single entity by key' },
          { name: 'Create', value: 'create', description: 'POST a new entity' },
          { name: 'Update', value: 'update', description: 'PATCH an existing entity by key' },
          { name: 'Delete', value: 'delete', description: 'DELETE an entity by key' },
        ],
        default: 'list',
        required: true,
      },
      // ── List options ────────────────────────────────────────────────────────
      {
        displayName: '$filter',
        name: 'filter',
        type: 'string',
        default: '',
        description: 'OData $filter expression, e.g. stock gt 10',
        displayOptions: { show: { operation: ['list'] } },
      },
      {
        displayName: '$select',
        name: 'select',
        type: 'string',
        default: '',
        description: 'Comma-separated field list, e.g. ID,title,stock',
        displayOptions: { show: { operation: ['list'] } },
      },
      {
        displayName: '$orderby',
        name: 'orderby',
        type: 'string',
        default: '',
        description: 'OData $orderby, e.g. title asc',
        displayOptions: { show: { operation: ['list'] } },
      },
      {
        displayName: '$top',
        name: 'top',
        type: 'number',
        default: 100,
        description: 'Maximum number of records to return',
        displayOptions: { show: { operation: ['list'] } },
      },
      // ── Key (get / update / delete) ─────────────────────────────────────────
      {
        displayName: 'Key',
        name: 'key',
        type: 'string',
        default: '',
        description: 'Entity key value, e.g. 1 or a UUID. For compound keys use JSON: {"key1":1,"key2":2}',
        displayOptions: { show: { operation: ['get', 'update', 'delete'] } },
        required: true,
      },
      // ── Body (create / update) ───────────────────────────────────────────────
      {
        displayName: 'Data (JSON)',
        name: 'body',
        type: 'json',
        default: '{}',
        description: 'JSON object to send as the request body',
        displayOptions: { show: { operation: ['create', 'update'] } },
        required: true,
      },
      // ── Auth ─────────────────────────────────────────────────────────────────
      {
        displayName: 'Bearer Token',
        name: 'token',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        description: 'Optional Authorization Bearer token for secured endpoints',
      },
    ],
  }

  async execute() {
    const items = this.getInputData()
    const results = []

    for (let i = 0; i < items.length; i++) {
      const baseUrl    = this.getNodeParameter('baseUrl',     i).replace(/\/$/, '')
      const svcPath    = this.getNodeParameter('servicePath', i).replace(/\/$/, '')
      const entity     = this.getNodeParameter('entity',      i)
      const operation  = this.getNodeParameter('operation',   i)
      const token      = this.getNodeParameter('token',       i)

      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      let url = `${baseUrl}${svcPath}/${entity}`
      let method = 'GET'
      let body

      if (operation === 'list') {
        const params = new URLSearchParams()
        const filter  = this.getNodeParameter('filter',  i)
        const select  = this.getNodeParameter('select',  i)
        const orderby = this.getNodeParameter('orderby', i)
        const top     = this.getNodeParameter('top',     i)
        if (filter)  params.set('$filter',  filter)
        if (select)  params.set('$select',  select)
        if (orderby) params.set('$orderby', orderby)
        if (top)     params.set('$top',     String(top))
        if (params.size) url += '?' + params.toString()

      } else if (operation === 'get') {
        url += `(${this._formatKey(this.getNodeParameter('key', i))})`

      } else if (operation === 'create') {
        method = 'POST'
        body   = this.getNodeParameter('body', i)

      } else if (operation === 'update') {
        method = 'PATCH'
        url   += `(${this._formatKey(this.getNodeParameter('key', i))})`
        body   = this.getNodeParameter('body', i)

      } else if (operation === 'delete') {
        method = 'DELETE'
        url   += `(${this._formatKey(this.getNodeParameter('key', i))})`
      }

      const fetchOpts = { method, headers }
      if (body) fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body)

      let res, data
      try {
        res  = await fetch(url, fetchOpts)
        const text = await res.text()
        data = text ? JSON.parse(text) : {}
      } catch (err) {
        throw new NodeOperationError(this.getNode(), `CAP Entity request failed: ${err.message}`, { itemIndex: i })
      }

      if (!res.ok) {
        const msg = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`
        throw new NodeOperationError(this.getNode(), `CAP Entity error: ${msg}`, { itemIndex: i })
      }

      // OData list returns { value: [...] }; single entity returns the object directly
      const rows = Array.isArray(data?.value) ? data.value : [data]
      results.push(...rows.map(row => ({ json: row, pairedItem: { item: i } })))
    }

    return [results]
  }

  _formatKey(key) {
    if (!key) return ''
    // If it looks like a JSON object, convert to OData compound key syntax
    try {
      const obj = JSON.parse(key)
      if (typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.entries(obj)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? `'${v}'` : v}`)
          .join(',')
      }
    } catch { /* scalar key */ }
    // UUID or integer
    const isUuid = /^[0-9a-f-]{36}$/i.test(key)
    return isUuid ? key : (isNaN(Number(key)) ? `'${key}'` : key)
  }
}

exports.CapEntity = CapEntity
