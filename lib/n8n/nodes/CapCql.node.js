'use strict'
// CAP CQL node — run a CQL/SQL SELECT against the CAP database via the
// /api/cap/cql endpoint.  The DB engine handles joins, filters, aggregations
// and sorting — no in-memory data processing on the Node.js side.
//
// CQL is a superset of SQL that maps directly to CDS entity names:
//   SELECT ID, title, stock FROM CatalogService.Books WHERE stock < 5
//   SELECT b.title, a.name FROM CatalogService.Books b JOIN CatalogService.Authors a ON b.author_ID = a.ID
//   SELECT genre_ID, count(*) as count FROM CatalogService.Books GROUP BY genre_ID
const { NodeConnectionTypes, NodeOperationError } = require('n8n-workflow')

class CapCql {
  description = {
    displayName: 'CAP CQL Query',
    name: 'capCql',
    icon: 'node:database',
    iconColor: 'green',
    group: ['transform'],
    version: 1,
    description: 'Run a CQL/SQL query against the CAP database — joins, filters, aggregations handled by the DB engine',
    defaults: { name: 'CAP CQL Query' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    properties: [
      {
        displayName: 'CAP Server URL',
        name: 'baseUrl',
        type: 'string',
        default: 'http://localhost:4004',
        required: true,
      },
      {
        displayName: 'CQL Statement',
        name: 'cql',
        type: 'string',
        typeOptions: { rows: 6, editor: 'sqlEditor' },
        default: 'SELECT * FROM CatalogService.Books LIMIT 10',
        required: true,
        description: [
          'CQL SELECT statement. Use full qualified names like CatalogService.Books.',
          'Supports JOINs, GROUP BY, ORDER BY, WHERE, subqueries.',
          'Supports n8n expressions — e.g. WHERE ID = {{ $json.id }}',
        ].join(' '),
        noDataExpression: false,
      },
      {
        displayName: 'Named Parameters (JSON)',
        name: 'params',
        type: 'json',
        default: '{}',
        description: 'Optional named parameters referenced in CQL as :paramName',
      },
      {
        displayName: 'Bearer Token',
        name: 'token',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        description: 'Optional Authorization Bearer token',
      },
    ],
  }

  async execute() {
    const items = this.getInputData()
    const results = []

    for (let i = 0; i < items.length; i++) {
      const baseUrl = this.getNodeParameter('baseUrl', i).replace(/\/$/, '')
      const cql     = this.getNodeParameter('cql',     i)
      const params  = this.getNodeParameter('params',  i)
      const token   = this.getNodeParameter('token',   i)

      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const body = JSON.stringify({
        cql,
        params: typeof params === 'string' ? JSON.parse(params || '{}') : (params ?? {}),
      })

      let res, data
      try {
        res  = await fetch(`${baseUrl}/api/cap/cql`, { method: 'POST', headers, body })
        const text = await res.text()
        data = text ? JSON.parse(text) : {}
      } catch (err) {
        throw new NodeOperationError(this.getNode(), `CAP CQL request failed: ${err.message}`, { itemIndex: i })
      }

      if (!res.ok) {
        const msg = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`
        throw new NodeOperationError(this.getNode(), `CAP CQL error: ${msg}`, { itemIndex: i })
      }

      const rows = Array.isArray(data) ? data : (data?.value ?? [data])
      results.push(...rows.map(row => ({ json: row, pairedItem: { item: i } })))
    }

    return [results]
  }
}

exports.CapCql = CapCql
