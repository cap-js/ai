import cds from '@sap/cds'
import { resolveValue } from '../lib/n8n/nodes/executors/resolve.js'
import { makeCapEntityQuery, makeCapCqlQuery, conditionsBlockToCql, sortToCql,
         addWhereToQuery, branchQuery, addOrderByToQuery, addTopToQuery, foldNodeIntoToken, executeQueryToken } from '../lib/n8n/cql-fusion.js'
import { createRequire } from 'node:module'
const _require = createRequire(import.meta.url)

// ── Node executors ────────────────────────────────────────────────────────────
import { execute as _execManualTrigger         } from '../lib/n8n/nodes/executors/ManualTrigger.js'
import { execute as _execNoOp                  } from '../lib/n8n/nodes/executors/NoOp.js'
import { execute as _execSet                   } from '../lib/n8n/nodes/executors/Set.js'
import { execute as _execIf                    } from '../lib/n8n/nodes/executors/If.js'
import { execute as _execSwitch                } from '../lib/n8n/nodes/executors/Switch.js'
import { execute as _execMerge                 } from '../lib/n8n/nodes/executors/Merge.js'
import { execute as _execSplitOut              } from '../lib/n8n/nodes/executors/SplitOut.js'
import { execute as _execSplitInBatches        } from '../lib/n8n/nodes/executors/SplitInBatches.js'
import { execute as _execWait                  } from '../lib/n8n/nodes/executors/Wait.js'
import { execute as _execStopAndError          } from '../lib/n8n/nodes/executors/StopAndError.js'
import { execute as _execCode                  } from '../lib/n8n/nodes/executors/Code.js'
import { execute as _execFilter                } from '../lib/n8n/nodes/executors/Filter.js'
import { execute as _execLimit                 } from '../lib/n8n/nodes/executors/Limit.js'
import { execute as _execSort                  } from '../lib/n8n/nodes/executors/Sort.js'
import { execute as _execSummarize             } from '../lib/n8n/nodes/executors/Summarize.js'
import { execute as _execRemoveDuplicates      } from '../lib/n8n/nodes/executors/RemoveDuplicates.js'
import { execute as _execCompareDatasets       } from '../lib/n8n/nodes/executors/CompareDatasets.js'
import { execute as _execDateTime              } from '../lib/n8n/nodes/executors/DateTime.js'
import { execute as _execExecuteWorkflow       } from '../lib/n8n/nodes/executors/ExecuteWorkflow.js'
import { execute as _execExecuteWorkflowTrigger} from '../lib/n8n/nodes/executors/ExecuteWorkflowTrigger.js'
import { execute as _execErrorTrigger          } from '../lib/n8n/nodes/executors/ErrorTrigger.js'
import { execute as _execHttpRequest           } from '../lib/n8n/nodes/executors/HttpRequest.js'
import { execute as _execMarkdown              } from '../lib/n8n/nodes/executors/Markdown.js'
import { execute as _execHtml                  } from '../lib/n8n/nodes/executors/Html.js'
import { execute as _execXml                   } from '../lib/n8n/nodes/executors/Xml.js'
import { execute as _execRespondToWebhook      } from '../lib/n8n/nodes/executors/RespondToWebhook.js'
import { execute as _execCapAgent              } from '../lib/n8n/nodes/executors/CapAgent.js'
import { execute as _execCapAiAgent           } from '../lib/n8n/nodes/executors/CapAiAgent.js'
import { execute as _execCapAiClassify        } from '../lib/n8n/nodes/executors/CapAiClassify.js'
import { execute as _execCapAiExtract         } from '../lib/n8n/nodes/executors/CapAiExtract.js'
import { execute as _execCapLlmProvider        } from '../lib/n8n/nodes/executors/CapLlmProvider.js'
import { execute as _execLCChainLlm            } from '../lib/n8n/nodes/executors/LangchainChainLlm.js'
import { execute as _execLCTextClassifier      } from '../lib/n8n/nodes/executors/LangchainTextClassifier.js'
import { execute as _execLCSummarization       } from '../lib/n8n/nodes/executors/LangchainSummarization.js'
import { execute as _execLCSentimentAnalysis   } from '../lib/n8n/nodes/executors/LangchainSentimentAnalysis.js'
import { execute as _execLCInfoExtractor       } from '../lib/n8n/nodes/executors/LangchainInformationExtractor.js'
import { execute as _execLCGuardrails          } from '../lib/n8n/nodes/executors/LangchainGuardrails.js'
import { execute as _execLCAgent               } from '../lib/n8n/nodes/executors/LangchainAgent.js'
import { execute as _execLCChatTrigger         } from '../lib/n8n/nodes/executors/ChatTrigger.js'
import { execute as _execLCChat               } from '../lib/n8n/nodes/executors/Chat.js'
import { execute as _execScheduleTrigger, parseCronExpressions as _schedParseCron } from '../lib/n8n/nodes/executors/ScheduleTrigger.js'
import { execute as _execCronTrigger,     parseCronExpressions as _cronParseCron  } from '../lib/n8n/nodes/executors/CronTrigger.js'
import { execute as _execIntervalTrigger, toMilliseconds as _intervalToMs         } from '../lib/n8n/nodes/executors/IntervalTrigger.js'

// ── Executor registry: type string → executor function ───────────────────────
// All executors are async — the dispatch loop always awaits them uniformly.
const NODE_EXECUTORS = {
  'n8n-nodes-base.manualTrigger':      _execManualTrigger,
  'n8n-nodes-base.noOp':               _execNoOp,
  'n8n-nodes-base.set':                _execSet,
  'n8n-nodes-base.if':                 _execIf,
  'n8n-nodes-base.switch':             _execSwitch,
  'n8n-nodes-base.merge':              _execMerge,
  'n8n-nodes-base.splitOut':           _execSplitOut,
  'n8n-nodes-base.splitInBatches':     _execSplitInBatches,
  'n8n-nodes-base.loop':               _execSplitInBatches,
  'n8n-nodes-base.wait':               _execWait,
  'n8n-nodes-base.stopAndError':       _execStopAndError,
  'n8n-nodes-base.code':               _execCode,
  'n8n-nodes-base.filter':             _execFilter,
  'n8n-nodes-base.limit':              _execLimit,
  'n8n-nodes-base.sort':               _execSort,
  'n8n-nodes-base.summarize':          _execSummarize,
  'n8n-nodes-base.removeDuplicates':   _execRemoveDuplicates,
  'n8n-nodes-base.compareDatasets':    _execCompareDatasets,
  'n8n-nodes-base.dateTime':           _execDateTime,
  'n8n-nodes-base.executeWorkflow':    _execExecuteWorkflow,
  'n8n-nodes-base.executeWorkflowTrigger': _execExecuteWorkflowTrigger,
  'n8n-nodes-base.errorTrigger':       _execErrorTrigger,
  'n8n-nodes-base.httpRequest':        _execHttpRequest,
  'n8n-nodes-base.markdown':           _execMarkdown,
  'n8n-nodes-base.html':               _execHtml,
  'n8n-nodes-base.xml':                _execXml,
  'n8n-nodes-base.respondToWebhook':   _execRespondToWebhook,
  'CUSTOM.capAgent':                   _execCapAgent,
  'CUSTOM.capAiAgent':                 _execCapAiAgent,
  'CUSTOM.capAiClassify':              _execCapAiClassify,
  'CUSTOM.capAiExtract':               _execCapAiExtract,
  'CUSTOM.capLlmProvider':             _execCapLlmProvider,
  // n8n LangChain AI nodes — executed natively via cds.requires.llm, no sub-node wiring needed
  '@n8n/n8n-nodes-langchain.chainLlm':            _execLCChainLlm,
  '@n8n/n8n-nodes-langchain.textClassifier':       _execLCTextClassifier,
  '@n8n/n8n-nodes-langchain.chainSummarization':   _execLCSummarization,
  '@n8n/n8n-nodes-langchain.sentimentAnalysis':    _execLCSentimentAnalysis,
  '@n8n/n8n-nodes-langchain.informationExtractor': _execLCInfoExtractor,
  '@n8n/n8n-nodes-langchain.guardrails':           _execLCGuardrails,
  '@n8n/n8n-nodes-langchain.agent':                _execLCAgent,
  '@n8n/n8n-nodes-langchain.chatTrigger':          _execLCChatTrigger,
  '@n8n/n8n-nodes-langchain.chat':                 _execLCChat,
  'n8n-nodes-base.scheduleTrigger':                _execScheduleTrigger,
  'n8n-nodes-base.cron':                           _execCronTrigger,
  'n8n-nodes-base.interval':                       _execIntervalTrigger,
}

const { SELECT, INSERT, UPDATE } = cds.ql
const log = cds.log('n8n')

// In-memory pending step counter per execution. Incremented before emitting
// workflow.step, decremented when a step completes (with or without successors).
// When it reaches 0 the execution is finished.
const _pendingSteps = {}

// CQL query token helpers — see lib/n8n/cql-fusion.js

// Promise resolvers for callers awaiting execution completion (e.g. chat trigger).
// executionId → { resolve, reject }
const _awaitingCompletion = {}

// Short-lived cache of final nodeOutputs (runData) for finished executions.
// In-memory map of node outputs per execution: executionId → { nodeName: itemsArray }
// Used to resolve $('nodeName') expressions in subsequent nodes.
const _nodeOutputs = {}

// In-memory waiting-execution map for multi-input nodes (e.g. Merge).
// Structure: executionId → { nodeName → { inputCount, slots: [ items|null, ... ], sources: [ src|null, ... ] } }
// A node is enqueued only once all input slots are filled (non-null).
const _waitingInputs = {}

// Per-execution node execution index counter (mirrors n8n's currentNodeExecutionIndex).
const _execIndex = {}
const _nodeRunIndex = {}
const _destinationNode = {} // executionId → { name, mode }, set for partial executions
const _stepState = {}       // executionId → { nodeName → stepState } for stateful nodes (e.g. SplitInBatches)
const _pinData = {}         // executionId → { nodeName → itemArray } pinned node output
const _pushSeq = {}         // executionId → incrementing sequence number for nodeExecuteBefore/After

/**
 * N8nService – CAP-native workflow execution engine.
 *
 * The n8n UI is used purely as a visual designer.  CAP owns execution.
 * Workflow definitions are stored in cap.ai.n8n.WorkflowDefinitions.
 * Execution state is tracked in cap.ai.n8n.WorkflowExecutions and
 * cap.ai.n8n.WorkflowStepResults.
 *
 * Execution flow:
 *   triggerWorkflow  →  creates WorkflowExecution row (status=running)
 *                    →  cds.emit('workflow.step', { executionId, workflowId, nodeId, input })
 *   workflow.step    →  loads execution + workflow from DB
 *                    →  executes the node (_executeNode)
 *                    →  stores result in WorkflowStepResults
 *                    →  emits workflow.step for each successor node
 *                    →  when no more successors, marks execution 'success'
 */
export default class N8nService extends cds.ApplicationService {

  async init() {
    this.on('triggerWorkflow',        req => this._triggerWorkflow(req))
    this.on('awaitExecution',         req => this._awaitExecution(req))
    this.on('getExecution',           req => this._getExecution(req))
    this.on('stopExecution',          req => this._stopExecution(req))
    this.on('cleanupStaleExecutions', req => this._cleanupStaleExecutions(req))

    cds.on('workflow.step', event => this._handleStep(event))

    cds.once('served', () => {
      // Stale-execution cleanup — every 5 minutes using cds.spawn so it runs in a
      // proper CAP transaction context and doesn't block process shutdown.
      cds.spawn({ every: 5 * 60 * 1000 }, async () => {
        await this.send('cleanupStaleExecutions', {})
      })
      // Run once immediately at startup too
      this.send('cleanupStaleExecutions', {}).catch(() => {})

      // Start cron/interval scheduler for active workflows
      this._startScheduler().catch(e => log.warn('Scheduler start failed:', e.message))
    })

    await super.init()
  }

  async _cleanupStaleExecutions(_req) {
    // A stale execution is one stuck in 'running' with no in-memory pending steps —
    // it was either interrupted by a restart or hung due to a bug.
    // We use a DB-only UPDATE with a stale threshold so concurrent instances don't
    // double-process: only executions started more than 10 minutes ago are touched.
    const threshold = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const stale = await SELECT.from('cap.ai.n8n.WorkflowExecutions')
      .where({ status: 'running' })
      .and({ startedAt: { '<': threshold } })
    if (!stale.length) return { cleaned: 0 }
    log.warn(`Cleaning up ${stale.length} stale running execution(s)`)
    for (const ex of stale) {
      // Skip executions that actually have live in-memory state (they're still running)
      if (_pendingSteps[ex.ID]) continue
      await UPDATE('cap.ai.n8n.WorkflowExecutions')
        .set({ status: 'error', finishedAt: new Date().toISOString(),
               error: JSON.stringify({ message: 'Execution timed out or was interrupted' }) })
        .where({ ID: ex.ID, status: 'running' }) // status guard prevents double-update
    }
    return { cleaned: stale.length }
  }

  // ── Action: triggerWorkflow ───────────────────────────────────────────────

  async _triggerWorkflow(req) {
    const { workflowId, data, destinationNode, destinationMode, startNodeIds, pinData: runPinData, runData: runDataJson } = req.data
    if (!workflowId) return req.error(400, 'workflowId is required')

    const wf = await SELECT.one.from('cap.ai.n8n.WorkflowDefinitions').where({ ID: workflowId })
    if (!wf) return req.error(404, `WorkflowDefinition ${workflowId} not found`)

    let nodes, connections, pinData
    try {
      nodes       = wf.nodes       ? JSON.parse(wf.nodes)       : []
      connections = wf.connections ? JSON.parse(wf.connections)  : {}
      pinData     = wf.pinData     ? JSON.parse(wf.pinData)      : {}
      // Run-time pinData (from UI "run with this data") overrides stored pins
      if (runPinData) {
        const runtimePins = typeof runPinData === 'string' ? JSON.parse(runPinData) : runPinData
        pinData = { ...pinData, ...runtimePins }
      }
    } catch (err) {
      return req.error(500, `Workflow ${workflowId} has invalid JSON: ${err.message}`)
    }

    const initialInput = data ? (typeof data === 'string' ? JSON.parse(data) : data) : {}
    const executionId  = cds.utils.uuid()

    await INSERT.into('cap.ai.n8n.WorkflowExecutions').entries({
      ID:          executionId,
      workflow_ID: workflowId,
      status:      'running',
      mode:        'manual',
      data:        JSON.stringify(initialInput),
    })

    // Partial execution: UI sends startNodeIds when "run previous node" is clicked.
    // We start only from those specific nodes instead of the workflow's trigger nodes.
    let startNodes
    if (startNodeIds) {
      const ids = typeof startNodeIds === 'string' ? JSON.parse(startNodeIds) : startNodeIds
      startNodes = nodes.filter(n => ids.includes(n.id) || ids.includes(n.name))
      if (!startNodes.length) startNodes = this._findStartNodes(nodes, connections)
    } else {
      startNodes = this._findStartNodes(nodes, connections)
    }

    if (startNodes.length === 0) {
      await UPDATE('cap.ai.n8n.WorkflowExecutions')
        .set({ status: 'success', finishedAt: new Date().toISOString() })
        .where({ ID: executionId })
      return { executionId, status: 'success' }
    }

    _pendingSteps[executionId]  = startNodes.length
    _nodeOutputs[executionId]   = {}
    _waitingInputs[executionId] = {}
    _execIndex[executionId]     = 0
    _nodeRunIndex[executionId]  = {}
    _stepState[executionId]     = {}
    _pinData[executionId]       = pinData

    // destinationNode: stop routing after this node completes (partial execution).
    // Store it so _finishStep can check it before emitting successors.
    if (destinationNode) _destinationNode[executionId] = { name: destinationNode, mode: destinationMode ?? 'exclusive' }

    // Build CQL fusion plans for capEntity nodes whose successor chains can be
    // folded into a single DB query. Skip fusion for partial executions (the UI
    // wants real per-node results when "run this node" is clicked).
    if (destinationNode) _destinationNode[executionId] = { name: destinationNode, mode: destinationMode ?? 'exclusive' }

    // Pre-populate nodeOutputs from runData (cached outputs for partial executions).
    // runData format: { "NodeName": [{ data: { main: [[...items...]] } }] }
    if (runDataJson) {
      const runData = typeof runDataJson === 'string' ? JSON.parse(runDataJson) : runDataJson
      _nodeOutputs[executionId] = _nodeOutputs[executionId] ?? {}
      for (const [nodeName, taskDataArray] of Object.entries(runData)) {
        const taskData = Array.isArray(taskDataArray) ? taskDataArray[0] : taskDataArray
        const portItems = taskData?.data?.main?.[0]
        if (Array.isArray(portItems) && portItems.length > 0) {
          _nodeOutputs[executionId][nodeName] = portItems.map(item =>
            (item && typeof item === 'object' && 'json' in item) ? item : { json: item }
          )
        }
      }
    }

    cds.emit('n8n.push', {
      type: 'executionStarted',
      data: { executionId, mode: 'manual', workflowId, workflowName: wf.name ?? '', startedAt: new Date(), flattedRunData: '[]' },
    })

    for (const node of startNodes) {
      // For partial executions, use cached runData output of the immediate parent as input.
      // This feeds the correct items into the start node instead of the raw trigger input.
      const cachedInput = _nodeOutputs[executionId]?.[node.name]
        ? null  // node itself is in runData — it will be re-executed, don't pre-feed
        : (() => {
            // Find any parent whose cached output we can use
            const parentName = Object.keys(_nodeOutputs[executionId] ?? {}).find(pName => {
              const conns = connections[pName]
              return Object.values(conns ?? {}).some(ports =>
                ports.some(port => (Array.isArray(port) ? port : []).some(e => e.node === node.name))
              )
            })
            return parentName ? (_nodeOutputs[executionId][parentName] ?? null) : null
          })()
      cds.emit('workflow.step', {
        executionId,
        workflowId,
        nodeId:          node.id,
        input:           cachedInput ?? initialInput,
        predecessorName: null,
        predecessorPort: 0,
        destInputPort:   0,
      })
    }

    return { executionId, status: 'running' }
  }

  // ── Event handler: workflow.step ──────────────────────────────────────────

  async _handleStep(event) {
    const { executionId, workflowId, nodeId, input, predecessorName = null, predecessorPort = 0, destInputPort = 0 } = event

    // Load execution to ensure it's still running
    const execution = await SELECT.one.from('cap.ai.n8n.WorkflowExecutions').where({ ID: executionId })
    if (!execution) {
      log.error(`workflow.step: execution ${executionId} not found`)
      return
    }
    if (execution.status !== 'running') {
      log.warn(`workflow.step: execution ${executionId} is already ${execution.status}, skipping node ${nodeId}`)
      return
    }

    // Load workflow definition
    const wf = await SELECT.one.from('cap.ai.n8n.WorkflowDefinitions').where({ ID: workflowId })
    if (!wf) {
      log.error(`workflow.step: workflow ${workflowId} not found`)
      await this._failExecution(executionId, `Workflow ${workflowId} not found`)
      return
    }

    let nodes, connections
    try {
      nodes       = wf.nodes       ? JSON.parse(wf.nodes)       : []
      connections = wf.connections ? JSON.parse(wf.connections)  : {}
    } catch (err) {
      await this._failExecution(executionId, `Invalid workflow JSON: ${err.message}`)
      return
    }

    const node = nodes.find(n => n.id === nodeId)
    if (!node) {
      await this._failExecution(executionId, `Node ${nodeId} not found in workflow ${workflowId}`)
      return
    }

    // ── Gap 1: Disabled nodes — pass first input port through, do not execute ──
    // Mirrors n8n handleDisabledNode: returns inputData.main[0] unchanged.
    if (node.disabled === true) {
      log.debug(`workflow.step: node "${node.name}" is disabled — passing input through`)
      const inputItems = this._normaliseToItems(input)
      const outputs = [inputItems]
      await this._finishStep({ executionId, workflowId, node, nodes, connections, execution,
        outputs, predecessorName, predecessorPort, destInputPort, isDisabled: true })
      return
    }

    // ── Gap 3: Multi-input node synchronization (e.g. Merge) ─────────────────
    // Count how many distinct input ports the target node has across all connections.
    // If >1, we buffer each incoming branch in _waitingInputs and only proceed
    // when all slots are filled — matching n8n's waitingExecution mechanism.
    const inputCount = this._countInputPorts(node.name, connections)
    if (inputCount > 1) {
      _waitingInputs[executionId] ??= {}
      _waitingInputs[executionId][node.name] ??= {
        inputCount,
        slots:   new Array(inputCount).fill(null),
        sources: new Array(inputCount).fill(null),
      }
      const waiting = _waitingInputs[executionId][node.name]
      const slot = destInputPort < inputCount ? destInputPort : 0
      // Store items as-is — empty array is valid (branch produced nothing).
      // Do NOT normalise here or an empty branch becomes a phantom item.
      waiting.slots[slot]   = Array.isArray(input) ? input : (input ? this._normaliseToItems(input) : [])
      waiting.sources[slot] = { previousNode: predecessorName, previousNodeOutput: predecessorPort, previousNodeRun: 0 }

      const allFilled = waiting.slots.every(s => s !== null)
      if (!allFilled) {
        // Not all branches arrived yet — silently consume this step's pending slot.
        // Each of the N-1 early-returning inputs decrements by 1; the last one
        // runs through _finishStep which does the final decrement.
        const prev = _pendingSteps[executionId] ?? 1
        _pendingSteps[executionId] = Math.max(1, prev - 1)
        return
      }
      // All inputs arrived — collect and proceed.
      // Do NOT adjust _pendingSteps here; _finishStep handles the final decrement.
      const slots       = waiting.slots      // Array of per-port item arrays
      const mergedInput = slots.flat()       // flat array passed as primary input
      delete _waitingInputs[executionId][node.name]

      // Build named mergeInputs: { input1: items[], input2: items[], ... }
      // This matches what Merge.js (Object.values(mi)) and CompareDatasets.js
      // (mi.input2) expect from context.mergeInputs.
      const mergeInputs = {}
      for (let i = 0; i < slots.length; i++) {
        mergeInputs[`input${i + 1}`] = slots[i] ?? []
      }

      return this._executeAndFinish({
        executionId, workflowId, node, nodes, connections, execution,
        input: mergedInput,
        predecessorName, predecessorPort, destInputPort,
        mergeInputs,
      })
    }

    return this._executeAndFinish({
      executionId, workflowId, node, nodes, connections, execution,
      input, predecessorName, predecessorPort, destInputPort,
    })
  }

  // ── Internal: run a node then route successors ────────────────────────────

  async _executeAndFinish({ executionId, workflowId, node, nodes, connections, execution,
    input, predecessorName, predecessorPort, destInputPort, mergeInputs }) {

    const stepStart = Date.now()
    const execIdx   = (_execIndex[executionId] ?? 0)
    _execIndex[executionId] = execIdx + 1

    // ── Pin data: skip execution and use pinned output directly ──────────────
    const pinnedItems = (_pinData[executionId] ?? {})[node.name]
    if (pinnedItems !== undefined) {
      const items = Array.isArray(pinnedItems) ? pinnedItems : []
      const outputs = [items]
      const _seqB = (_pushSeq[executionId] ?? 0); _pushSeq[executionId] = _seqB + 1
      cds.emit('n8n.push', { type: 'nodeExecuteBefore', data: { executionId, nodeName: node.name, sequenceNumber: _seqB, data: { startTime: stepStart, executionIndex: execIdx, source: [] } } })
      await this._finishStep({
        executionId, workflowId, node, nodes, connections, execution,
        outputs, predecessorName, predecessorPort, destInputPort,
        stepStart, execIdx,
      })
      return
    }

    // ── Gap 5: retryOnFail ────────────────────────────────────────────────────
    const maxTries       = (node.retryOnFail === true) ? Math.min(5, Math.max(2, node.maxTries ?? 3))    : 1
    const waitBetween    = (node.retryOnFail === true) ? Math.min(5000, Math.max(0, node.waitBetweenTries ?? 1000)) : 0

    let outputs
    let execError = null
    cds.emit('n8n.push', { type: 'nodeExecuteBefore', data: { executionId, nodeName: node.name,
      sequenceNumber: (_pushSeq[executionId] ?? 0), data: { startTime: stepStart, executionIndex: execIdx, source: [] } } })
    _pushSeq[executionId] = (_pushSeq[executionId] ?? 0) + 1

    for (let tryIdx = 0; tryIdx < maxTries; tryIdx++) {
      if (tryIdx > 0 && waitBetween > 0) {
        await new Promise(r => cds.spawn({ after: waitBetween }, r))
      }
      try {
        const execContext = {
          cds, executionId,
          nodeOutputs: _nodeOutputs[executionId] ?? {},
          stepState:   (_stepState[executionId] ?? {})[node.name],
          ...(mergeInputs ? { mergeInputs } : {}),
          connections, nodes,
        }
        const result = await this._executeNode(node, input, executionId, execContext)
        outputs = result.outputs
        // Persist nextStepState so the next invocation of this node (e.g. loop) gets it
        if (result.nextStepState !== undefined) {
          _stepState[executionId] ??= {}
          if (result.nextStepState === null) {
            delete _stepState[executionId][node.name]
          } else {
            _stepState[executionId][node.name] = result.nextStepState
          }
        }
        execError = null
        break
      } catch (err) {
        execError = err
        const msg = err.message || err.reason || (err.details && JSON.stringify(err.details)) || String(err)
        log.warn(`workflow.step: node "${node.name}" try ${tryIdx + 1}/${maxTries} threw [${err.constructor?.name}] code=${err.code} status=${err.status}: ${msg}`)
      }
    }

    if (execError) {
      // ── Gap 2: continueOnFail / onError ──────────────────────────────────
      // n8n: continueOnFail OR onError in ['continueRegularOutput','continueErrorOutput']
      // → pass input through as output instead of failing the whole execution.
      const continuesOnFail = node.continueOnFail === true ||
        ['continueRegularOutput', 'continueErrorOutput'].includes(node.onError ?? '')

      if (continuesOnFail) {
        log.warn(`workflow.step: node "${node.name}" failed but continueOnFail is set — passing input through`)
        outputs = [this._normaliseToItems(input).map(item => ({
          json:  { ...item.json, error: execError.message },
          error: execError,
        }))]
        execError = null  // treat as soft error — execution continues
      } else {
        log.error(`workflow.step: node "${node.name}" (${node.type}) threw:`, execError)
        const errMsg = execError.message || execError.reason || (execError.details && JSON.stringify(execError.details)) || String(execError)
        await this._recordStep(executionId, node.id, 'error', null, errMsg)
        await this._failExecution(executionId, `Node "${node.name}" failed: ${errMsg}`)
        const _seqErr = (_pushSeq[executionId] ?? 0)
        cds.emit('n8n.push', {
          type: 'nodeExecuteAfter',
          data: { executionId, nodeName: node.name, sequenceNumber: _seqErr,
            itemCountByConnectionType: { main: [] },
            data: { startTime: stepStart, executionTime: Date.now() - stepStart, executionIndex: execIdx, executionStatus: 'error', hints: [], source: [] } }
        })
        return
      }
    }

    // ── Gap 4: alwaysOutputData ───────────────────────────────────────────────
    // n8n: if the node produces no items on port 0 and alwaysOutputData=true,
    // emit one empty item {json:{}} so downstream nodes always receive something.
    // Exclude stateful loop nodes (SplitInBatches/loop) — their port 0 is the
    // "done" port which is intentionally empty during loop iterations.
    const isLoopNode = node.type === 'n8n-nodes-base.splitInBatches' || node.type === 'n8n-nodes-base.loop'
    if (node.alwaysOutputData === true && !isLoopNode && (!outputs[0] || outputs[0].length === 0)) {
      outputs[0] = [{ json: {} }]
    }

    await this._finishStep({
      executionId, workflowId, node, nodes, connections, execution,
      outputs, predecessorName, predecessorPort, destInputPort,
      stepStart, execIdx,
    })
  }

  async _finishStep({ executionId, workflowId, node, nodes, connections, execution,
    outputs, predecessorName, predecessorPort, destInputPort,
    stepStart = Date.now(), execIdx = 0, isDisabled = false }) {

    const nodeId = node.id

    // Strip CQL query tokens from recorded outputs — these are internal routing
    // tokens and must not appear as data in the UI.
    const isCqlToken = item => item?.json?._cql_query !== undefined
    const recordedOutputs = outputs.map(port => (port ?? []).filter(i => !isCqlToken(i)))

    // Persist all port arrays so the UI can show each port's items per run.
    await this._recordStep(executionId, nodeId, 'success', recordedOutputs, null)
    // runIndex was just incremented by _recordStep; the current run is at index - 1
    const nodeRunIndex = (_nodeRunIndex[executionId]?.[nodeId] ?? 1) - 1

    // Accumulate this node's output so downstream nodes can reference it via $('nodeName')
    _nodeOutputs[executionId] ??= {}
    const primaryOutput = outputs.find(p => p && p.length > 0) ?? outputs[0] ?? []
    _nodeOutputs[executionId][node.name] = primaryOutput

    const execTime = Date.now() - stepStart
    const sourceArray = predecessorName
      ? [{ previousNode: predecessorName, previousNodeRun: 0, previousNodeOutput: predecessorPort ?? 0 }]
      : []

    // nodeExecuteAfter carries the full ITaskData including data.main (output items + metadata).
    const taskData = {
      startTime:       stepStart,
      executionTime:   execTime,
      executionIndex:  execIdx,
      executionStatus: 'success',
      hints:           [],
      data:            { main: recordedOutputs },
      source:          sourceArray,
    }
    // itemCountByConnectionType: { main: [port0Count, port1Count, ...] }
    const itemCountByConnectionType = { main: recordedOutputs.map(p => (p ?? []).length) }
    // Disabled nodes pass input through but emit no events (mirrors real n8n behaviour).
    if (!isDisabled) {
      const seqAfter = (_pushSeq[executionId] ?? 0); _pushSeq[executionId] = seqAfter + 1
      cds.emit('n8n.push', {
        type: 'nodeExecuteAfter',
        data: { executionId, nodeName: node.name, sequenceNumber: seqAfter, data: taskData, itemCountByConnectionType },
      })
    }

    // Route to successor nodes — one successor set per output port.
    // Empty ports are still emitted to multi-input nodes (e.g. Merge after an If
    // branch that produced 0 items) so _handleStep can fill the slot and unblock.
    let successorCount = 0
    for (let portIndex = 0; portIndex < outputs.length; portIndex++) {
      const portItems = outputs[portIndex] ?? []
      const nextEdges = this._findNextEdges(node.name, connections, portIndex)

      for (const edge of nextEdges) {
        const nextNode = nodes.find(n => n.name === edge.node)
        if (!nextNode) {
          log.warn(`workflow.step: next node "${edge.node}" not found in workflow, skipping`)
          continue
        }
        if (nextNode.type === 'n8n-nodes-base.stickyNote') continue

        const destPort = edge.index ?? 0
        const destInputCount = this._countInputPorts(nextNode.name, connections)

        // Skip empty branches that feed single-input nodes — they terminate here.
        // But always forward (even empty) to multi-input nodes so _handleStep
        // can mark the slot as received and unblock the node.
        if (portItems.length === 0 && destInputCount <= 1) continue

        // Partial execution routing:
        // - exclusive: stop BEFORE the destination node (never route to it)
        // - inclusive: allow routing TO the destination node, but stop AFTER it completes
        const _dest = _destinationNode[executionId]
        if (_dest) {
          if (_dest.mode === 'exclusive' && nextNode.name === _dest.name) continue
          if (_dest.mode === 'inclusive' && node.name === _dest.name) continue
        }

        successorCount++
        cds.emit('workflow.step', {
          executionId,
          workflowId,
          nodeId:          nextNode.id,
          input:           portItems,
          predecessorName: node.name,
          predecessorPort: portIndex,
          destInputPort:   destPort,
        })
      }
    }

    // Update pending counter: replace 1 completed step with however many successors were spawned
    const prev = _pendingSteps[executionId] ?? 1
    const next = prev - 1 + successorCount
    if (next > 0) {
      _pendingSteps[executionId] = next
    } else {
      // All branches have terminated — execution is complete
      delete _pendingSteps[executionId]
      delete _nodeOutputs[executionId]
      delete _waitingInputs[executionId]
      delete _execIndex[executionId]
      delete _nodeRunIndex[executionId]
      delete _destinationNode[executionId]
      delete _stepState[executionId]
      delete _pinData[executionId]
      delete _pushSeq[executionId]
      const finishedAt = new Date().toISOString()
      await UPDATE('cap.ai.n8n.WorkflowExecutions')
        .set({ status: 'success', finishedAt })
        .where({ ID: executionId })

      // ── Gap 7: runData format ─────────────────────────────────────────────
      let runData = {}
      try {
        runData = await this._buildRunData(executionId, nodes)
      } catch (e) {
        log.warn(`Execution ${executionId}: _buildRunData failed: ${e.message}`)
      }
      await UPDATE('cap.ai.n8n.WorkflowExecutions')
        .set({ data: JSON.stringify({ status: 'success', nodeOutputs: runData }) })
        .where({ ID: executionId })
      cds.emit('n8n.push', {
        type: 'executionFinished',
        data: { executionId, workflowId, status: 'success' },
      })

      // Resolve any awaiting caller (e.g. chat trigger route).
      const awaiting = _awaitingCompletion[executionId]
      if (awaiting) {
        delete _awaitingCompletion[executionId]
        awaiting.resolve(JSON.stringify({ status: 'success', nodeOutputs: runData }))
      }
    }
  }

  // ── Node execution ────────────────────────────────────────────────────────

  /**
   * Execute a single node and return { outputs, nextStepState? }.
   *
   * `outputs` is an array of output-port arrays:
   *   [ port0Items, port1Items, ... ]
   *
   * Single-output nodes return [ allItems ].
   * Branching nodes (If, Switch) return [ port0, port1, ... ].
   *
   * Legacy callers that only look at outputs[0] still work correctly.
   */
  async _executeNode(node, input, executionId, context = {}) {
    const type   = node.type
    const params = node.parameters ?? {}

    // Resolve CAP LLM provider service name from connected ai_languageModel sub-node
    const _llmService = (() => {
      const conns = context?.connections ?? {}
      for (const [srcName, branches] of Object.entries(conns)) {
        const aiPorts = branches.ai_languageModel ?? []
        for (const port of aiPorts) {
          for (const edge of (Array.isArray(port) ? port : [])) {
            if (edge.node === node.name) {
              const providerNode = context?.nodes?.find(n => n.name === srcName)
              if (providerNode?.type === 'CUSTOM.capLlmProvider') {
                return providerNode.parameters?.service ?? 'llm'
              }
            }
          }
        }
      }
      return undefined
    })()

    const execContext = { cds, executionId, nodeOutputs: context.nodeOutputs ?? {}, llmService: _llmService, ...context }
    let inputItems  = this._normaliseToItems(input)

    // ── CQL query token handling ──────────────────────────────────────────────
    // capEntity/capCql nodes emit a _cql_query token instead of executing.
    // Foldable nodes (Filter, Sort, Limit, If) modify the token and forward it.
    // Any non-foldable node — or the specific target node in preview mode — executes
    // the accumulated query and replaces inputItems with real results.
    const _inputQuery = inputItems[0]?.json?._cql_query ?? null
    const _previewMode = !!_destinationNode[executionId]
    const _dest = _destinationNode[executionId]
    // A node is the effective target if:
    // - it IS the destination (inclusive/run-current), OR
    // - the destination is exclusive and this node's only successor is that destination
    //   (i.e. this is the last node that will actually execute — "run previous")
    const _isTargetNode = _previewMode && (
      _dest?.name === node.name ||
      (_dest?.mode === 'exclusive' && (() => {
        const succs = (context.connections?.[node.name]?.main ?? []).flat()
        return succs.length === 1 && succs[0]?.node === _dest.name
      })())
    )

    if (_inputQuery) {
      // At the target node in preview mode: execute immediately, show results, stop
      if (_isTargetNode) {
        const nodeOutputs = _nodeOutputs[executionId] ?? {}
        inputItems = await executeQueryToken(_inputQuery, { ...context, cds }, this._runCapEntity.bind(this), true)
        const _srcName = _inputQuery._sourceNodeName
        if (_srcName) nodeOutputs[_srcName] = inputItems
        for (const fn of (_inputQuery._foldedNodeNames ?? [])) nodeOutputs[fn] = inputItems
        _nodeOutputs[executionId] = nodeOutputs
        // Fall through to normal dispatch with real inputItems
      } else {
        // Try to fold this node into the token
        let foldedQuery = null

        if (type === 'n8n-nodes-base.filter') {
          const where = conditionsBlockToCql(params.conditions)
          if (where) foldedQuery = addWhereToQuery(_inputQuery, where)
        } else if (type === 'n8n-nodes-base.sort') {
          const ob = sortToCql(params)
          if (ob) foldedQuery = addOrderByToQuery(_inputQuery, ob)
        } else if (type === 'n8n-nodes-base.limit') {
          const max = Number(params.maxItems ?? 0)
          if (max && params.keep !== 'lastItems') foldedQuery = addTopToQuery(_inputQuery, max)
        } else if (type === 'n8n-nodes-base.if') {
          const where = conditionsBlockToCql(params.conditions)
          if (where) {
            const branches = branchQuery(_inputQuery, where)
            if (branches) {
              const out0 = [{ json: { _cql_query: foldNodeIntoToken(branches.port0, node.name) } }]
              const out1 = [{ json: { _cql_query: foldNodeIntoToken(branches.port1, node.name) } }]
              return { outputs: [out0, out1], output: out0, outputIndex: 0 }
            }
          }
        }

        if (foldedQuery) {
          const out = [{ json: { _cql_query: foldNodeIntoToken(foldedQuery, node.name) } }]
          return { outputs: [out], output: out, outputIndex: 0 }
        }

        // Non-foldable node — execute query and replace inputItems with real results.
        // Backfill nodeOutputs for source + folded nodes so $node[...] resolves.
        const nodeOutputs = _nodeOutputs[executionId] ?? {}
        inputItems = await executeQueryToken(_inputQuery, { ...context, cds }, this._runCapEntity.bind(this), _previewMode)
        const _srcName = _inputQuery._sourceNodeName
        if (_srcName) nodeOutputs[_srcName] = inputItems
        for (const fn of (_inputQuery._foldedNodeNames ?? [])) nodeOutputs[fn] = inputItems
        _nodeOutputs[executionId] = nodeOutputs
      }
    }

    // Also execute capEntity/capCql directly when they are the target node in preview mode
    // (they emitted a token instead, so we need to intercept before the token path below)

    // ── Registry-based dispatch ───────────────────────────────────────────
    const executor = NODE_EXECUTORS[type]
    if (executor) {
      return this._wrapExecutorResult(await executor(node, inputItems, execContext))
    }

    // ── StickyNote: visual-only, pass input through ───────────────────────
    if (type === 'n8n-nodes-base.stickyNote') {
      return { outputs: [inputItems], output: inputItems, outputIndex: 0 }
    }

    // ── CUSTOM.capEntity ──────────────────────────────────────────────────
    if (type === 'CUSTOM.capEntity') {
      const nodeOutputs = context.nodeOutputs ?? {}
      const firstItem = inputItems[0] ?? { json: {} }
      const rv = v => resolveValue(v, firstItem, nodeOutputs)
      const { service, entity, operation = 'list', filter, columns, key, body, orderBy, top, skip } = params

      // Read ops: emit token for fusion; execute directly only if this node is the preview target
      if (operation === 'list' || operation === 'get') {
        const query = makeCapEntityQuery(node, inputItems, nodeOutputs)
        if (!_isTargetNode) {
          const out = [{ json: { _cql_query: query } }]
          return { outputs: [out], output: out, outputIndex: 0 }
        }
        const items = await executeQueryToken(query, { ...context, cds }, this._runCapEntity.bind(this), true)
        return { outputs: [items], output: items, outputIndex: 0 }
      }

      const output = await this._runCapEntity({
        service:   rv(service),
        entity:    rv(entity),
        operation: rv(operation),
        filter:    rv(filter),
        columns:   rv(columns),
        key:       rv(key),
        body:      rv(body),
        orderBy:   rv(orderBy),
        top:       _previewMode ? 1 : rv(top),
        skip:      rv(skip),
        input,
      })
      const rows = Array.isArray(output) ? output : (output != null ? [output] : [])
      const items = rows.map(row => ({ json: row }))
      return { outputs: [items], output: items, outputIndex: 0 }
    }

    // ── CUSTOM.capAction ──────────────────────────────────────────────────
    if (type === 'CUSTOM.capAction') {
      const nodeOutputs = context.nodeOutputs ?? {}
      const firstItem = inputItems[0] ?? { json: {} }
      const rv = v => resolveValue(v, firstItem, nodeOutputs)
      const { service: serviceName, action, params: actionParams } = params
      const resolvedService = rv(serviceName)
      const resolvedAction  = rv(action)
      if (!resolvedService || !resolvedAction) throw new Error(`capAction node "${node.name}" requires service and action parameters`)
      const svc = await cds.connect.to(resolvedService)
      let resolvedActionParams = rv(actionParams)
      if (typeof resolvedActionParams === 'string') {
        try { resolvedActionParams = JSON.parse(resolvedActionParams) } catch { /* leave as-is */ }
      }
      // Run with privileged user so @requires annotations don't block n8n-driven calls
      const output = await svc.tx({ user: new cds.User.Privileged() }, tx =>
        tx.send(resolvedAction, resolvedActionParams ?? input)
      )
      const rows = Array.isArray(output) ? output : (output != null ? [output] : [])
      const items = rows.map(row => ({ json: row }))
      return { outputs: [items], output: items, outputIndex: 0 }
    }

    // ── CUSTOM.capCql ─────────────────────────────────────────────────────
    if (type === 'CUSTOM.capCql') {
      const query = makeCapCqlQuery(node, inputItems, context.nodeOutputs ?? {})
      if (!_isTargetNode) {
        const out = [{ json: { _cql_query: query } }]
        return { outputs: [out], output: out, outputIndex: 0 }
      }
      const items = await executeQueryToken(query, { ...context, cds }, this._runCapEntity.bind(this), true)
      return { outputs: [items], output: items, outputIndex: 0 }
    }

    // ── CUSTOM.capLlmProvider ─────────────────────────────────────────────
    if (type === 'CUSTOM.capLlmProvider') {
      const { model, systemPrompt, userPrompt } = params
      try {
        const aicore = await cds.connect.to('AICore')
        const messages = []
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
        messages.push({ role: 'user', content: userPrompt ?? (typeof input === 'string' ? input : JSON.stringify(input)) })
        const output = await aicore.send('chat', { model, messages })
        return { outputs: [[{ json: output }]], output, outputIndex: 0 }
      } catch (err) {
        log.warn(`capLlmProvider node "${node.name}": AICore not available or call failed — ${err.message}`)
        return { outputs: [inputItems], output: input, outputIndex: 0 }
      }
    }

    // ── Unknown type: pass-through with warning ───────────────────────────
    log.warn(`Unknown node type "${type}" (node: "${node.name}") — passing input through.`)
    return { outputs: [inputItems], output: input, outputIndex: 0 }
  }

  /**
   * Wrap the result of an executor function into the canonical
   * { outputs, output, outputIndex, nextStepState? } shape.
   *
   * Executors can return either:
   *   - Array[]              plain multi-port output arrays
   *   - { outputs, nextStepState? }  extended shape with step state
   */
  _wrapExecutorResult(result) {
    // Extended shape: { outputs: Array[], nextStepState? }
    if (result && !Array.isArray(result) && Array.isArray(result.outputs)) {
      const outputs = result.outputs
      // Find first non-empty port for legacy outputIndex
      const outputIndex = outputs.findIndex(p => p && p.length > 0)
      const output = outputs[Math.max(0, outputIndex)]
      return {
        outputs,
        output:         output ?? [],
        outputIndex:    Math.max(0, outputIndex),
        nextStepState:  result.nextStepState,
      }
    }

    // Plain Array[] shape: each element is a port's item array
    if (Array.isArray(result)) {
      const outputs = result
      const outputIndex = outputs.findIndex(p => p && p.length > 0)
      const output = outputs[Math.max(0, outputIndex)]
      return {
        outputs,
        output:      output ?? [],
        outputIndex: Math.max(0, outputIndex),
      }
    }

    // Fallback (shouldn't happen — treat as pass-through with empty output)
    return { outputs: [[]], output: [], outputIndex: 0 }
  }

  /** Convert raw input (plain object, array of plain objects, or items array) to items */
  _normaliseToItems(input) {
    if (!input) return [{ json: {} }]
    if (Array.isArray(input)) {
      return input.map(i => (i && typeof i === 'object' && 'json' in i) ? i : { json: i })
    }
    if (typeof input === 'object' && 'json' in input) return [input]
    return [{ json: input }]
  }

  // ── CUSTOM.capEntity helper ───────────────────────────────────────────────

  async _runCapEntity({ service, entity, operation, filter, columns, key, body, orderBy, top, skip, input }) {
    if (!entity) throw new Error('capEntity requires an entity parameter')

    // Parse a key that may be a scalar string ("501"), a JSON object string ('{"k":1}'),
    // or a JS object-literal string ("{key1:1,key2:2}"). Returns the parsed value.
    const parseKey = raw => {
      if (raw == null) return raw
      if (typeof raw !== 'string') return raw
      const s = raw.trim()
      // Try JSON first
      try { return JSON.parse(s) } catch { /* fall through */ }
      // Try JS object literal (e.g. "{key1: 1, key2: 2}")
      if (s.startsWith('{')) {
        // eslint-disable-next-line no-new-func
        try { return new Function(`return (${s})`)() } catch { /* fall through */ }
      }
      // Numeric scalar
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
      return s
    }

    // Parse a body value that may be a JSON string or already an object.
    const parseBody = raw => {
      if (raw == null) return raw
      if (typeof raw !== 'string') return raw
      try { return JSON.parse(raw) } catch { return raw }
    }

    // Strip service prefix if entity was stored as "ServiceName.EntityName"
    const stripPrefix = name => (service && name.startsWith(service + '.')) ? name.slice(service.length + 1) : name

    switch (operation) {
      case 'list': {
        const cols = columns ? columns.split(',').map(c => c.trim()).filter(Boolean) : null
        let query = cols ? SELECT.from(entity).columns(...cols) : SELECT.from(entity)
        if (filter)  query = query.where(filter)
        if (orderBy) query = query.orderBy(orderBy)
        if (top)     query = query.limit(Number(top), skip ? Number(skip) : undefined)
        return cds.db.run(query)
      }
      case 'get': {
        const rawKey = key ?? filter
        if (rawKey != null) {
          const parsedKey = parseKey(rawKey)
          // Scalar key: find the entity's first key field from cds.model (handles non-ID keys)
          if (typeof parsedKey !== 'object' || parsedKey === null) {
            const defs = cds.model?.definitions ?? {}
            // entity may be short name — find matching FQN
            const entityDef = defs[entity] ?? Object.values(defs).find(d => d.name === entity || d.name?.endsWith('.' + entity))
            const keyFields = entityDef ? Object.entries(entityDef.elements ?? {}).filter(([,e]) => e.key).map(([n]) => n) : []
            const keyField = keyFields[0] ?? 'ID'
            return SELECT.one.from(entity).where({ [keyField]: parsedKey })
          }
          return SELECT.one.from(entity).where(parsedKey)
        }
        // No key: fall back to first item's json fields as where clause
        const itemJson = Array.isArray(input) ? (input[0]?.json ?? {}) : (input?.json ?? input ?? {})
        return SELECT.one.from(entity).where(itemJson)
      }
      case 'create': {
        if (!service) throw new Error('capEntity create requires a service parameter')
        const svc = await cds.connect.to(service)
        const entityName = stripPrefix(entity)
        const data = parseBody(body) ?? (Array.isArray(input) ? input[0]?.json : input)
        const result = await svc.tx({ user: new cds.User.Privileged() }, tx =>
          tx.insert(data).into(entityName)
        )
        // INSERT returns InsertResults (array-like) or a number — return the inserted data instead
        // so downstream nodes receive a usable object, not a row count
        const isUsable = result && typeof result === 'object' && !Array.isArray(result) && result.constructor?.name === 'Object'
        return isUsable ? result : data
      }
      case 'update': {
        if (!service) throw new Error('capEntity update requires a service parameter')
        const svc = await cds.connect.to(service)
        const entityName = stripPrefix(entity)
        const parsedKey = key != null ? parseKey(key) : null
        const updateData = parseBody(body) ?? (Array.isArray(input) ? input[0]?.json : input)
        await svc.tx({ user: new cds.User.Privileged() }, tx => {
          let q = tx.update(entityName).set(updateData)
          if (parsedKey != null) {
            q = typeof parsedKey === 'object' ? q.where(parsedKey) : q.byKey(parsedKey)
          }
          return q
        })
        // UPDATE returns a count — pass through the merged data so downstream nodes can use it
        const keyPart = typeof parsedKey === 'object' && parsedKey !== null ? parsedKey : {}
        return { ...keyPart, ...updateData }
      }
      case 'delete': {
        if (!service) throw new Error('capEntity delete requires a service parameter')
        const svc = await cds.connect.to(service)
        const entityName = stripPrefix(entity)
        const parsedKey = key != null ? parseKey(key) : null
        await svc.tx({ user: new cds.User.Privileged() }, tx => {
          let q = tx.delete(entityName)
          if (parsedKey != null) {
            q = typeof parsedKey === 'object' ? q.where(parsedKey) : q.byKey(parsedKey)
          }
          return q
        })
        // DELETE returns a count — return a status object so downstream nodes continue
        return { deleted: true, key: parsedKey }
      }
      default:
        throw new Error(`capEntity: unknown operation "${operation}"`)
    }
  }

  // ── Graph helpers ─────────────────────────────────────────────────────────

  /**
   * Find all nodes with no incoming connections — the workflow entry points.
   * Also skips stickyNote nodes (Gap 6).
   */
  _findStartNodes(nodes, connections) {
    // Collect all node names that appear as targets in connections
    const targeted = new Set()
    for (const branches of Object.values(connections)) {
      for (const outputs of Object.values(branches)) {
        for (const output of outputs) {
          for (const edge of output) {
            targeted.add(edge.node)
          }
        }
      }
    }
    return nodes.filter(n => !targeted.has(n.name) && n.type !== 'n8n-nodes-base.stickyNote')
  }

  /**
   * Given a source node name and the connections map, return the list of
   * target edge descriptors { node, index } reachable via the given output
   * branch index. `index` is the destination input port on the target node.
   */
  _findNextEdges(nodeName, connections, outputIndex = 0) {
    const nodeConns    = connections[nodeName]
    if (!nodeConns) return []
    const mainBranches = nodeConns.main ?? []
    const branch       = mainBranches[outputIndex] ?? []
    // Each edge: { node: string, type: string, index: number }
    // `index` is the input slot on the destination node (for multi-input detection)
    return branch.map(edge => ({ node: edge.node, index: edge.index ?? 0 }))
  }

  /**
   * Convenience alias that returns just node names (backward compat).
   */
  _findNextNodes(nodeName, connections, outputIndex = 0) {
    return this._findNextEdges(nodeName, connections, outputIndex).map(e => e.node)
  }

  /**
   * Count how many distinct input ports a node has based on the connections map.
   * Scans all edges and finds the maximum `index` value used when a node appears
   * as a target, returning max+1 (so index 0 and 1 → 2 ports).
   */
  _countInputPorts(nodeName, connections) {
    let max = -1
    for (const branches of Object.values(connections)) {
      for (const outputs of Object.values(branches)) {
        for (const branch of outputs) {
          for (const edge of branch) {
            if (edge.node === nodeName && typeof edge.index === 'number') {
              if (edge.index > max) max = edge.index
            }
          }
        }
      }
    }
    return max < 0 ? 1 : max + 1
  }

  // ── DB helpers ────────────────────────────────────────────────────────────

  async _recordStep(executionId, nodeId, status, output, error) {
    // Track how many times this node has run in this execution (loop support)
    _nodeRunIndex[executionId] ??= {}
    const runIndex = _nodeRunIndex[executionId][nodeId] ?? 0
    _nodeRunIndex[executionId][nodeId] = runIndex + 1

    const executionIndex = _execIndex[executionId] ?? 0

    try {
      await INSERT.into('cap.ai.n8n.WorkflowStepResults').entries({
        executionID:    executionId,
        nodeID:         nodeId,
        runIndex,
        executionIndex,
        status,
        output:      output !== null && output !== undefined ? JSON.stringify(output) : null,
        error:       error ?? null,
      })
    } catch (e) {
      // Fallback: update existing row (e.g. retry overwrites first attempt)
      if (e.message?.includes('UNIQUE')) {
        await UPDATE('cap.ai.n8n.WorkflowStepResults')
          .set({ status, executionIndex, output: output !== null ? JSON.stringify(output) : null, error: error ?? null })
          .where({ executionID: executionId, nodeID: nodeId, runIndex })
      } else throw e
    }
  }

  async _failExecution(executionId, errorMessage) {
    delete _pendingSteps[executionId]
    delete _nodeOutputs[executionId]
    delete _waitingInputs[executionId]
    delete _execIndex[executionId]
    delete _nodeRunIndex[executionId]
    delete _destinationNode[executionId]
    delete _stepState[executionId]
    delete _pinData[executionId]
    delete _pushSeq[executionId]
    const finishedAt = new Date().toISOString()
    const execRow = await SELECT.one.from('cap.ai.n8n.WorkflowExecutions').where({ ID: executionId })
    await UPDATE('cap.ai.n8n.WorkflowExecutions')
      .set({
        status:     'error',
        finishedAt,
        error:      JSON.stringify({ message: errorMessage }),
      })
      .where({ ID: executionId })
    await UPDATE('cap.ai.n8n.WorkflowExecutions')
      .set({ data: JSON.stringify({ status: 'error', error: errorMessage }) })
      .where({ ID: executionId })
    cds.emit('n8n.push', {
      type: 'executionFinished',
      data: { executionId, workflowId: execRow?.workflow_ID ?? null, status: 'error' },
    })

    // Reject any awaiting caller (e.g. chat trigger route)
    const awaiting = _awaitingCompletion[executionId]
    if (awaiting) {
      delete _awaitingCompletion[executionId]
      awaiting.reject(new Error(errorMessage))
    }
  }

  async _stopExecution(req) {
    const { id } = req.data
    if (!id) return req.error(400, 'id is required')
    const exec = await SELECT.one.from('cap.ai.n8n.WorkflowExecutions').where({ ID: id })
    if (!exec) return req.error(404, `Execution ${id} not found`)
    if (exec.status !== 'running') return { id, status: exec.status }
    await this._failExecution(id, 'Execution stopped by user')
    return { id, status: 'stopped' }
  }

  // ── Action: awaitExecution ────────────────────────────────────────────────
  // Register a Promise that resolves when the given execution finishes.
  // Used by the chat trigger route to get a synchronous response.
  // Handles the race: if the execution already finished, resolves immediately
  // from the DB record.
  async _awaitExecution(req) {
    const { id, timeoutMs = 30000 } = req.data
    if (!id) return req.error(400, 'id is required')

    return new Promise(async (resolve, reject) => {
      // Already finished — resolve immediately from DB
      const exec = await cds.tx(async tx => tx.run(SELECT.one.from('cap.ai.n8n.WorkflowExecutions').where({ ID: id })))
      if (exec && exec.status !== 'running') {
        const result = exec.data ? (typeof exec.data === 'string' ? JSON.parse(exec.data) : exec.data) : {}
        if (exec.status === 'error') return reject(new Error(result.error ?? 'Execution failed'))
        return resolve(JSON.stringify({ status: exec.status, nodeOutputs: result.nodeOutputs ?? {} }))
      }

      // Use cds.spawn so CAP manages the timer; self-checks the map to avoid firing after resolution
      let _timedOut = false
      cds.spawn({ after: timeoutMs }, () => {
        if (!_timedOut && _awaitingCompletion[id]) {
          _timedOut = true
          delete _awaitingCompletion[id]
          reject(new Error(`Execution ${id} timed out after ${timeoutMs}ms`))
        }
      })

      _awaitingCompletion[id] = { resolve, reject }  // no timeoutHandle needed
    })
  }

  async _buildRunData(executionId, nodes) {
    const results = await SELECT.from('cap.ai.n8n.WorkflowStepResults')
      .where({ executionID: executionId })
      .orderBy('executionIndex asc', 'runIndex asc')
    const nodeIdToName = nodes ? Object.fromEntries(nodes.map(n => [n.id, n.name])) : {}
    const runData = {}
    let idx = 0
    for (const r of results) {
      const name = nodeIdToName[r.nodeID] ?? r.nodeID
      const output = r.output ? (typeof r.output === 'string' ? JSON.parse(r.output) : r.output) : []
      const portArrays = Array.isArray(output) && output.length > 0 && Array.isArray(output[0])
        ? output
        : [Array.isArray(output) ? output : [{ json: output }]]
      const taskData = {
        startTime:       r.executedAt ? new Date(r.executedAt).getTime() : 0,
        executionTime:   0,
        executionIndex:  idx++,
        executionStatus: r.status === 'success' ? 'success' : 'error',
        hints:           [],
        data:            { main: portArrays },
        source:          [],
      }
      if (!runData[name]) runData[name] = []
      runData[name].push(taskData)
    }
    return runData
  }

  // ── Action: getExecution ──────────────────────────────────────────────────

  async _getExecution(req) {
    const { id } = req.data
    if (!id) return req.error(400, 'id is required')

    const exec = await SELECT.one.from('cap.ai.n8n.WorkflowExecutions').where({ ID: id })
    if (!exec) return req.error(404, `Execution ${id} not found`)

    return {
      id:          exec.ID,
      status:      exec.status,
      outputData:  exec.data,
      error:       exec.error,
      finishedAt:  exec.finishedAt,
    }
  }

  // ── Scheduler: fire active schedule/cron/interval workflows ──────────────

  async _startScheduler() {
    // Load all active workflows and register jobs for every trigger node found.
    const workflows = await SELECT.from('cap.ai.n8n.WorkflowDefinitions').where({ active: true })
    for (const wf of workflows) {
      this._scheduleWorkflow(wf)
    }
    log.info(`Scheduler started — ${workflows.length} active workflow(s) scanned`)
  }

  _scheduleWorkflow(wf) {
    let nodes
    try {
      nodes = (typeof wf.nodes === 'string' ? JSON.parse(wf.nodes) : wf.nodes) ?? []
    } catch {
      return
    }

    for (const node of nodes) {
      const type = node.type

      if (type === 'n8n-nodes-base.scheduleTrigger') {
        const exprs = _schedParseCron(node.parameters?.rule)
        for (const expr of exprs) {
          this._spawnCronJob(expr, wf.ID, node.id)
        }

      } else if (type === 'n8n-nodes-base.cron') {
        const exprs = _cronParseCron(node.parameters?.triggerTimes)
        for (const expr of exprs) {
          this._spawnCronJob(expr, wf.ID, node.id)
        }

      } else if (type === 'n8n-nodes-base.interval') {
        const ms = _intervalToMs(node.parameters)
        // cds.spawn manages the transaction context, error handling, and .unref() on the timer
        cds.spawn({ every: ms }, () => this._fireScheduledWorkflow(wf.ID, node.id))
        log.debug(`Interval trigger registered for workflow ${wf.ID} every ${ms}ms`)
      }
    }
  }

  _spawnCronJob(expr, workflowId, nodeId) {
    if (!cds.utils.cron(expr)) {
      log.warn(`Invalid cron expression "${expr}" for workflow ${workflowId} — skipping`)
      return
    }
    const schedule = () => {
      let msUntilNext
      try {
        const { CronExpressionParser } = _require('cron-parser')
        msUntilNext = Math.max(1000, CronExpressionParser.parse(expr).next().toDate().getTime() - Date.now())
      } catch (e) {
        log.warn(`Cron parse failed for "${expr}" (workflow ${workflowId}): ${e.message}`)
        return
      }
      cds.spawn({ after: msUntilNext }, async () => {
        await this._fireScheduledWorkflow(workflowId, nodeId)
        schedule()
      })
    }
    schedule()
    log.debug(`Cron trigger registered for workflow ${workflowId}: ${expr}`)
  }

  async _fireScheduledWorkflow(workflowId, triggerNodeId) {
    await this.send('triggerWorkflow', {
      workflowId,
      startNodeIds: [triggerNodeId],
      data: { timestamp: new Date().toISOString() },
      mode: 'trigger',
    })
  }
}
