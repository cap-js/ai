import { resolveValue } from './resolve.js'

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

export async function execute(node, input, context) {
  const { cds } = context
  const items = normaliseInput(input)
  const firstItem = items[0] ?? { json: {} }
  const workflowId = resolveValue(node.parameters?.workflowId, firstItem, context?.nodeOutputs ?? {})
  const waitForSubWorkflow = node.parameters?.waitForSubWorkflow ?? true

  const { SELECT } = cds.ql
  const wf = await SELECT.one.from('cap.ai.n8n.WorkflowDefinitions').where({ ID: workflowId })
  if (!wf) throw new Error(`ExecuteWorkflow: workflow "${workflowId}" not found`)

  const n8nService = await cds.connect.to('n8n')
  const outputItems = []

  for (const item of items) {
    const result = await n8nService.send('triggerWorkflow', { workflowId, data: JSON.stringify(item.json) })

    if (!waitForSubWorkflow) {
      outputItems.push({ json: { ...item.json, executionId: result.executionId } })
      continue
    }

    const raw = await n8nService.send('awaitExecution', { id: result.executionId, timeoutMs: 60000 })
    const exec = typeof raw === 'string' ? JSON.parse(raw) : raw

    if (exec?.status === 'error') {
      throw new Error(`ExecuteWorkflow: sub-workflow "${workflowId}" failed`)
    }

    // Collect all output items from the last node in nodeOutputs
    const nodeOutputs = exec?.nodeOutputs ?? {}
    const nodeNames = Object.keys(nodeOutputs)
    const lastNodeName = nodeNames[nodeNames.length - 1]
    const lastNode = lastNodeName ? nodeOutputs[lastNodeName] : null
    const taskDataArr = Array.isArray(lastNode) ? lastNode : (lastNode ? [lastNode] : [])
    const subItems = taskDataArr[0]?.data?.main?.[0] ?? taskDataArr[0] ?? []
    const subItemsArr = Array.isArray(subItems) ? subItems : [subItems]

    if (subItemsArr.length) {
      for (const subItem of subItemsArr) {
        const json = subItem?.json ?? subItem ?? {}
        outputItems.push({ json: { ...item.json, ...json, executionId: result.executionId } })
      }
    } else {
      outputItems.push({ json: { ...item.json, executionId: result.executionId, status: exec?.status } })
    }
  }

  return [outputItems]
}
