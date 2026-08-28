'use strict'
// CAP LLM node — call an AI Core / @cap-js/agents LLM model already configured
// in the CAP application. No separate credentials needed — the CAP server uses
// its own cds.requires bindings (AI Core service keys, destinations, etc.).
const { NodeConnectionTypes, NodeOperationError } = require('n8n-workflow')

class CapLlm {
  description = {
    displayName: 'CAP LLM',
    name: 'capLlm',
    icon: 'node:openAi',
    iconColor: 'black',
    group: ['transform'],
    version: 1,
    description: 'Call an LLM through the CAP AI Core configuration — no extra credentials needed',
    defaults: { name: 'CAP LLM' },
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
        displayName: 'Model / Deployment',
        name: 'model',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getModels',
          loadOptionsDependsOn: ['baseUrl'],
        },
        default: '',
        description: 'LLM deployment configured in cds.requires.aicore',
      },
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: 'You are a helpful assistant.',
      },
      {
        displayName: 'User Message',
        name: 'userMessage',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.message ?? $json.text ?? $json.input }}',
        required: true,
        description: 'The user message. Supports n8n expressions.',
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 1024,
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 2, numberStepSize: 0.1 },
        default: 0.7,
      },
      {
        displayName: 'Output Field',
        name: 'outputField',
        type: 'string',
        default: 'text',
        description: 'Field name to put the LLM response text into',
      },
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

  methods = {
    loadOptions: {
      async getModels() {
        const baseUrl = (this.getNodeParameter('baseUrl', 0) ?? 'http://localhost:4004').replace(/\/$/, '')
        try {
          const res = await fetch(`${baseUrl}/api/cap/model`)
          if (!res.ok) return [{ name: '(default)', value: '' }]
          const model = await res.json()
          const deployments = model.llmDeployments ?? []
          if (!deployments.length) return [{ name: '(default)', value: '' }]
          return deployments.map(d => ({ name: d.label ?? d.id, value: d.id }))
        } catch {
          return [{ name: '(default)', value: '' }]
        }
      },
    },
  }

  async execute() {
    const items = this.getInputData()
    const results = []

    for (let i = 0; i < items.length; i++) {
      const baseUrl      = this.getNodeParameter('baseUrl',      i).replace(/\/$/, '')
      const model        = this.getNodeParameter('model',        i)
      const systemPrompt = this.getNodeParameter('systemPrompt', i)
      const userMessage  = this.getNodeParameter('userMessage',  i)
      const maxTokens    = this.getNodeParameter('maxTokens',    i)
      const temperature  = this.getNodeParameter('temperature',  i)
      const outputField  = this.getNodeParameter('outputField',  i) || 'text'
      const token        = this.getNodeParameter('token',        i)

      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const body = JSON.stringify({ model, systemPrompt, userMessage, maxTokens, temperature })

      let res, data
      try {
        res  = await fetch(`${baseUrl}/api/cap/llm`, { method: 'POST', headers, body })
        const text = await res.text()
        data = text ? JSON.parse(text) : {}
      } catch (err) {
        throw new NodeOperationError(this.getNode(), `CAP LLM request failed: ${err.message}`, { itemIndex: i })
      }

      if (!res.ok) {
        const msg = data?.error?.message ?? data?.message ?? `HTTP ${res.status}`
        throw new NodeOperationError(this.getNode(), `CAP LLM error: ${msg}`, { itemIndex: i })
      }

      results.push({
        json: { ...items[i].json, [outputField]: data.text ?? data.content ?? '' },
        pairedItem: { item: i },
      })
    }

    return [results]
  }
}

exports.CapLlm = CapLlm
