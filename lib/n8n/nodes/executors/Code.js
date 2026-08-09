function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

function normaliseOutput(result) {
  if (result == null) return []
  const arr = Array.isArray(result) ? result : [result]
  return arr.map(r => ('json' in r) ? r : { json: r })
}

/**
 * Build the $('nodeName') selector used in Code node user code.
 * Mirrors n8n's WorkflowDataProxy API surface for node output access.
 */
function makeNodeSelector(nodeOutputs) {
  const makeAccessor = (nodeName) => {
    const raw = nodeOutputs[nodeName]
    const arr = raw ? (Array.isArray(raw) ? raw : [raw]) : []
    return {
      first: () => arr[0],
      last:  () => arr[arr.length - 1],
      all:   () => arr,
      get item() { return arr[0] },
    }
  }
  const $node = new Proxy({}, { get: (_, name) => makeAccessor(name) })
  return { $: makeAccessor, $node }
}

export async function execute(node, input, context) {
  const items = normaliseInput(input)

  // Language check — pythonCode parameter exists but Python execution is not supported
  const language = node.parameters?.language ?? 'javaScript'
  if (language === 'pythonNative' || language === 'python') {
    throw new Error(`Code node "${node.name}": Python is not supported in the CAP-native n8n executor. Switch the node language to JavaScript.`)
  }

  const code = node.parameters?.jsCode ?? ''
  const mode = node.parameters?.mode ?? 'runOnceForAllItems'

  // Warn about unsupported patterns (no sandbox here — code runs in CAP context)
  if (code.includes('require(') || code.includes('import ')) {
    console.warn(`[n8n Code node "${node.name}"] Code contains require() or import — these are not supported in the CAP-native executor. Use ES module imports in the workflow definition instead.`)
  }

  const workflowData = context?.workflowData ?? {}
  const $vars = workflowData.variables ?? workflowData.vars ?? {}
  const $execution = {
    id: workflowData.executionId ?? 'unknown',
    mode: workflowData.mode ?? 'integrated',
    resumeUrl: null,
    customData: {},
  }
  const nodeOutputs = context?.nodeOutputs ?? {}
  const { $, $node } = makeNodeSelector(nodeOutputs)

  try {
    if (mode === 'runOnceForEachItem') {
      const results = []

      for (let $itemIndex = 0; $itemIndex < items.length; $itemIndex++) {
        const item = items[$itemIndex]

        const $input = {
          item,
          all:   () => items,
          first: () => items[0],
          last:  () => items[items.length - 1],
        }
        const $json = item.json
        const $now = new Date().toISOString()
        const $today = $now.slice(0, 10)
        const $parameter = node.parameters ?? {}
        const $prevNode = { name: node.name, outputIndex: 0, runIndex: 0 }

        const fn = new Function(
          'item', '$input', '$json', '$now', '$today',
          '$itemIndex', '$prevNode', '$parameter', '$vars', '$execution',
          '$', '$node',
          `return (async () => {\n${code}\n})()`
        )
        const result = await fn(
          item, $input, $json, $now, $today,
          $itemIndex, $prevNode, $parameter, $vars, $execution,
          $, $node,
        )
        // n8n: no return → pass item through unchanged
        if (result == null) {
          results.push(item)
        } else {
          results.push(...normaliseOutput(result))
        }
      }

      return [results]
    } else {
      // runOnceForAllItems
      const $input = {
        get item() { return items[0] },
        all:   () => items,
        first: () => items[0],
        last:  () => items[items.length - 1],
      }
      const $json = items[0]?.json ?? {}
      const $now = new Date().toISOString()
      const $today = $now.slice(0, 10)
      const $itemIndex = 0
      const $parameter = node.parameters ?? {}
      const $prevNode = { name: node.name, outputIndex: 0, runIndex: 0 }

      const fn = new Function(
        'items', '$input', '$json', '$now', '$today',
        '$itemIndex', '$prevNode', '$parameter', '$vars', '$execution',
        '$', '$node',
        `return (async () => {\n${code}\n})()`
      )
      const result = await fn(
        items, $input, $json, $now, $today,
        $itemIndex, $prevNode, $parameter, $vars, $execution,
        $, $node,
      )
      // n8n: no return → pass items through unchanged (matches n8n source behaviour)
      if (result == null) return [items]
      return [normaliseOutput(result)]
    }
  } catch (err) {
    throw new Error(`Code node "${node.name}": ${err.message}`)
  }
}
