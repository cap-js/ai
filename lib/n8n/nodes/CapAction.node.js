'use strict'
// CAP Action node — call any CDS service action or function.
// Services and their actions are discovered dynamically from /api/cap/model.
const { NodeConnectionTypes, NodeOperationError } = require('n8n-workflow')

class CapAction {
  description = {
    displayName: 'CAP Action',
    name: 'capAction',
    icon: 'node:code',
    iconColor: 'orange',
    group: ['transform'],
    version: 1,
    description: 'Call a CDS service action or function',
    defaults: { name: 'CAP Action' },
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
        displayName: 'Service',
        name: 'service',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getServices',
          loadOptionsDependsOn: ['baseUrl'],
        },
        default: '',
        required: true,
        description: 'CDS service to call',
      },
      {
        displayName: 'Action',
        name: 'action',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getActions',
          loadOptionsDependsOn: ['baseUrl', 'service'],
        },
        default: '',
        required: true,
        description: 'Action or function to invoke',
      },
      {
        displayName: 'Parameters (JSON)',
        name: 'params',
        type: 'json',
        default: '{}',
        description: 'Action parameters as a JSON object',
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

  methods = {
    loadOptions: {
      async getServices() {
        const baseUrl = (this.getNodeParameter('baseUrl', 0) ?? 'http://localhost:4004').replace(/\/$/, '')
        try {
          const res = await fetch(`${baseUrl}/api/cap/model`)
          if (!res.ok) return []
          const model = await res.json()
          return (model.services ?? []).map(s => ({ name: s.name, value: s.path }))
        } catch { return [] }
      },
      async getActions() {
        const baseUrl = (this.getNodeParameter('baseUrl', 0) ?? 'http://localhost:4004').replace(/\/$/, '')
        const service = this.getNodeParameter('service', 0) ?? ''
        try {
          const res = await fetch(`${baseUrl}/api/cap/model`)
          if (!res.ok) return []
          const model = await res.json()
          const svc = (model.services ?? []).find(s => s.path === service)
          if (!svc) return []
          return (svc.actions ?? []).map(a => ({
            name: `${a.name}${a.kind === 'function' ? ' (function)' : ''}`,
            value: a.name,
          }))
        } catch { return [] }
      },
    },
  }

  async execute() {
    const items = this.getInputData()
    const results = []

    for (let i = 0; i < items.length; i++) {
      const baseUrl  = this.getNodeParameter('baseUrl',  i).replace(/\/$/, '')
      const service  = this.getNodeParameter('service',  i)  // e.g. /odata/v4/catalog
      const action   = this.getNodeParameter('action',   i)
      const params   = this.getNodeParameter('params',   i)
      const token    = this.getNodeParameter('token',    i)

      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const body = typeof params === 'string' ? params : JSON.stringify(params ?? {})
      const url  = `${baseUrl}${service}/${action}`

      let res, data
      try {
        res  = await fetch(url, { method: 'POST', headers, body })
        const text = await res.text()
        data = text ? JSON.parse(text) : {}
      } catch (err) {
        throw new NodeOperationError(this.getNode(), `CAP Action request failed: ${err.message}`, { itemIndex: i })
      }

      if (!res.ok) {
        const msg = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`
        throw new NodeOperationError(this.getNode(), `CAP Action error: ${msg}`, { itemIndex: i })
      }

      // OData action result may be wrapped in { value: ... }
      const value = data?.value ?? data
      const rows  = Array.isArray(value) ? value : [value]
      results.push(...rows.map(row => ({ json: row ?? {}, pairedItem: { item: i } })))
    }

    return [results]
  }
}

exports.CapAction = CapAction
