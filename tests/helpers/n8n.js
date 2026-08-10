import { parse as flattedParse } from 'flatted'
import assert from 'node:assert/strict'

const POLL_RETRIES  = 20
const POLL_INTERVAL = 300

export async function runWorkflow(workflowId, inputData, { GET, POST }) {
  const trigger = await POST(`/n8n/rest/workflows/${workflowId}/run`, { inputData })
  assert.equal(trigger.status, 200, `Trigger failed: ${JSON.stringify(trigger.data)}`)
  const { executionId } = trigger.data.data

  for (let i = 0; i < POLL_RETRIES; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL))
    const poll = await GET(`/n8n/api/v1/executions/${executionId}`)
    const exec = poll.data.data
    if (exec.status === 'success' || exec.status === 'error') {
      const raw = flattedParse(exec.data)
      return { status: exec.status, runData: raw.resultData?.runData ?? {}, error: raw.resultData?.error, raw }
    }
    if (i === 5) process.stderr.write(`[runWorkflow] still waiting for ${executionId} (${workflowId})...\n`)
  }
  throw new Error(`Execution ${executionId} did not finish within ${POLL_RETRIES * POLL_INTERVAL}ms`)
}

export function firstItem(runData, nodeName) {
  return runData[nodeName]?.[0]?.data?.main?.[0]?.[0]?.json ?? null
}

export function allItems(runData, nodeName) {
  return runData[nodeName]?.[0]?.data?.main?.[0] ?? []
}
