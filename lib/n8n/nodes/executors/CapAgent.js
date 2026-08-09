import { resolveValue } from './resolve.js'
import { randomUUID } from 'node:crypto'
import cds from '@sap/cds'

const log = cds.log('n8n:capAgent')

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

function extractText(artifacts) {
  if (!artifacts?.length) return ''
  const last = artifacts[artifacts.length - 1]
  return (last.parts ?? [])
    .filter(p => p.kind === 'text')
    .map(p => p.text ?? '')
    .join('')
}

async function a2aRequest(url, body) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`A2A fetch failed (${url}): ${err.message}`)
  }
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { /* ignore */ }
    throw new Error(`A2A HTTP ${res.status} from ${url}${detail ? ': ' + detail : ''}`)
  }
  return res.json()
}

export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const baseUrl = (params.baseUrl ?? '').replace(/\/$/, '')
  const agentPath = params.agentPath ?? ''
  const waitForCompletion = params.waitForCompletion ?? true
  const pollIntervalMs = params.pollIntervalMs ?? 1000
  const timeoutMs = params.timeoutMs ?? 60000

  const url = `${baseUrl}${agentPath}/`

  const items = normaliseInput(input)
  const completedItems = []
  const inputRequiredItems = []

  for (const item of items) {
    const message = String(resolveValue(params.message ?? '', item, context?.nodeOutputs ?? {}))
    const contextId = resolveValue(params.contextId ?? '', item, context?.nodeOutputs ?? {}) || undefined

    const sendBody = {
      jsonrpc: '2.0',
      id: '1',
      method: 'message/send',
      params: {
        message: {
          messageId: randomUUID(),
          role: 'user',
          parts: [{ kind: 'text', text: message }],
        },
        ...(contextId ? { contextId } : {}),
      },
    }

    log.debug(`CapAgent "${node.name}": sending to ${url}`)
    const sendResponse = await a2aRequest(url, sendBody)

    if (sendResponse.error) {
      throw new Error(`A2A error: ${sendResponse.error.message ?? JSON.stringify(sendResponse.error)}`)
    }

    let task = sendResponse.result

    // Poll until task leaves 'working' state
    if (waitForCompletion && task?.status?.state === 'working') {
      const deadline = Date.now() + timeoutMs
      while (task?.status?.state === 'working') {
        if (Date.now() >= deadline) {
          throw new Error(`CapAgent "${node.name}": timed out waiting for task ${task.id} after ${timeoutMs}ms`)
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))

        const pollResponse = await a2aRequest(url, {
          jsonrpc: '2.0',
          id: '2',
          method: 'tasks/get',
          params: { id: task.id },
        })
        if (pollResponse.error) {
          throw new Error(`A2A poll error: ${pollResponse.error.message ?? JSON.stringify(pollResponse.error)}`)
        }
        task = pollResponse.result
      }
    }

    const state = task?.status?.state
    const artifacts = task?.artifacts ?? []

    if (state === 'failed') {
      throw new Error(`CapAgent "${node.name}": task ${task?.id} failed`)
    }

    const outputItem = {
      json: {
        ...item.json,
        response: extractText(artifacts),
        contextId: task?.contextId,
        taskId: task?.id,
        state,
        artifacts,
      },
    }

    if (state === 'input-required') {
      inputRequiredItems.push(outputItem)
    } else {
      completedItems.push(outputItem)
    }
  }

  return [completedItems, inputRequiredItems]
}
