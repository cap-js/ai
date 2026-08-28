'use strict'
// CAP Agent node — call a @cap-js/agents A2A agent from an n8n workflow.
// Supports multi-turn conversations via contextId and HITL via the "Input Required" output.
const { NodeConnectionTypes } = require('n8n-workflow')

class CapAgent {
  description = {
    displayName: 'CAP Agent',
    name: 'CUSTOM.capAgent',
    icon: 'node:openAi',
    iconColor: 'black',
    group: ['transform'],
    version: 1,
    description: 'Call a @cap-js/agents A2A agent. Routes to "Input Required" when the agent pauses for human input.',
    defaults: { name: 'CAP Agent' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [
      { type: NodeConnectionTypes.Main, displayName: 'Response' },
      { type: NodeConnectionTypes.Main, displayName: 'Input Required' },
    ],
    properties: [
      {
        displayName: 'CAP Server Base URL',
        name: 'baseUrl',
        type: 'string',
        default: 'http://localhost:4004',
        description: 'CAP server base URL',
      },
      {
        displayName: 'Agent Path',
        name: 'agentPath',
        type: 'string',
        default: '/a2a/my-agent',
        description: 'A2A path for the agent service (e.g. /a2a/catalog)',
      },
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.message ?? $json.text ?? $json.input }}',
        description: 'Message to send to the agent',
      },
      {
        displayName: 'Context ID',
        name: 'contextId',
        type: 'string',
        default: '={{ $json.contextId }}',
        description: 'Conversation context ID for multi-turn. Leave blank to start a new conversation.',
      },
      {
        displayName: 'Wait for Completion',
        name: 'waitForCompletion',
        type: 'boolean',
        default: true,
        description: 'Wait for the agent to finish. If false, returns immediately with the task ID.',
      },
      {
        displayName: 'Poll Interval (ms)',
        name: 'pollIntervalMs',
        type: 'number',
        default: 1000,
        displayOptions: {
          show: {
            waitForCompletion: [true],
          },
        },
        description: 'How often to poll for completion (ms)',
      },
      {
        displayName: 'Timeout (ms)',
        name: 'timeoutMs',
        type: 'number',
        default: 60000,
        displayOptions: {
          show: {
            waitForCompletion: [true],
          },
        },
        description: 'Max time to wait for completion (ms)',
      },
    ],
  }
}

exports.CapAgent = CapAgent
