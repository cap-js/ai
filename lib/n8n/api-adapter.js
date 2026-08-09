/**
 * api-adapter.js — CAP-native n8n UI adapter
 *
 * Replaces the n8n child process + reverse proxy entirely. CAP serves the n8n
 * editor static files and implements the REST API the n8n UI calls against.
 * No n8n server is running — CAP owns everything.
 *
 * Usage:
 *   import { mountN8nAdapter } from './lib/n8n/api-adapter.js'
 *   mountN8nAdapter(app, { publicPath: '/n8n' })
 */

import path from 'node:path'
import fs from 'node:fs'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import express from 'express'
import cds from '@sap/cds'

// flatted is n8n's own serialization for execution data — the UI decodes it
// with flatted.parse(), so we must use the same format.
const _req = createRequire(import.meta.url)
const { stringify: flattedStringify } = _req('flatted')

const log = cds.log('n8n-adapter')

// ── SSE broadcast registry ─────────────────────────────────────────────────────
// All active /rest/push SSE connections. N8nService.js emits 'n8n.push' events
// on cds which are forwarded here to every connected browser tab.

const _sseClients = new Set()

// Recent execution events buffered for 30s so clients that connect after a fast
// execution (before their SSE connection opens) still receive the events.
const _recentEvents = []
const RECENT_EVENT_TTL = 30_000

function _storeRecentEvent(type, data) {
  const ts = Date.now()
  _recentEvents.push({ type, data, ts })
  // Expire old entries
  const cutoff = ts - RECENT_EVENT_TTL
  while (_recentEvents.length && _recentEvents[0].ts < cutoff) _recentEvents.shift()
}

export function broadcastN8nEvent(type, data) {
  if (type === 'executionStarted' || type === 'executionFinished' || type === 'nodeExecuteAfter' || type === 'nodeExecuteBefore' || type === 'nodeExecuteAfterData') {
    _storeRecentEvent(type, data)
  }
  if (_sseClients.size === 0) return
  const payload = `data: ${JSON.stringify({ type, data })}\n\n`
  for (const res of _sseClients) {
    try { res.write(payload) } catch { _sseClients.delete(res) }
  }
}

cds.on('n8n.push', ({ type, data }) => broadcastN8nEvent(type, data))

// ── Static dir resolution ──────────────────────────────────────────────────────

/**
 * Resolve the n8n static files directory.
 *
 * Prefer ~/.n8n/.cache/n8n/public — n8n pre-processes all JS/CSS files there,
 * replacing {{BASE_PATH}} placeholders. The raw n8n-editor-ui/dist files still
 * contain those placeholders and cannot be served directly.
 *
 * If the cache doesn't exist yet, we generate it ourselves at startup.
 */
function resolveStaticDir(cfg) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
  const cacheDir = cfg.staticDir ?? path.join(home, '.n8n', '.cache', 'n8n', 'public')
  return cacheDir
}

/**
 * Resolve the raw n8n-editor-ui dist dir (unprocessed source).
 */
function resolveDistDir() {
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve('n8n-editor-ui/package.json')
    const distDir = path.join(path.dirname(pkgJson), 'dist')
    if (existsSync(distDir)) return distDir
  } catch { /* not found */ }
  return null
}

/**
 * Load @n8n/n8n-nodes-langchain nodes, prefix with package name, patch dynamic
 * input expression strings with a static fallback that exposes the ai_languageModel slot,
 * and filter to only the types in allowedNodeTypes.
 *
 * Output expressions (={{...}}) are deliberately kept as-is — the n8n editor evaluates
 * them client-side and uses them to render the correct number of output ports per node
 * parameters (e.g. textClassifier categories, sentimentAnalysis categories, guardrails pass/fail).
 * Replacing them with ['main'] would collapse multi-port nodes to a single output.
 */
function loadLangchainNodes(req, allowedNodeTypes) {
  try {
    const lcPkg = req.resolve('@n8n/n8n-nodes-langchain/package.json')
    const lcDir = path.dirname(lcPkg)
    const lcNodes = JSON.parse(fs.readFileSync(path.join(lcDir, 'dist/types/nodes.json'), 'utf-8'))
    return lcNodes
      .map(n => {
        const node = { ...n, name: `@n8n/n8n-nodes-langchain.${n.name}` }
        // Replace dynamic input expressions with a static value so the editor
        // renders the correct connection slots. chatTrigger has inputs=[] (no sub-nodes),
        // other AI nodes get a main port + optional model sub-node port.
        if (typeof node.inputs === 'string') {
          if (node.name === '@n8n/n8n-nodes-langchain.chatTrigger') {
            node.inputs = []
          } else {
            node.inputs = [{ displayName: '', type: 'main' }, { displayName: 'Model', type: 'ai_languageModel', required: false, maxConnections: 1 }]
          }
        }
        // Replace "node:*" icon references — these require the editor's built-in icon registry
        // which is not available in our static-file serving mode. Map to FontAwesome equivalents.
        if (typeof node.icon === 'string' && node.icon.startsWith('node:')) {
          const NODE_ICON_MAP = {
            'node:chat-trigger': 'fa:comments',
            'node:openAi':       'fa:brain',
          }
          node.icon = NODE_ICON_MAP[node.icon] ?? 'fa:puzzle-piece'
        }
        return node
      })
      .filter(n => allowedNodeTypes.has(n.name))
  } catch {
    return []
  }
}

/**
 * One-time preprocessing: copy n8n-editor-ui/dist → staticCacheDir,
 * replacing all {{BASE_PATH}} and %CONFIG_TAGS% placeholders in JS/CSS/HTML.
 * Mirrors what n8n's own generateStaticAssets() does.
 * Synchronous so it blocks server startup on the first boot — the cache only
 * needs to be generated once and subsequent starts skip this entirely.
 */
function generateStaticCacheSync(distDir, cacheDir, publicPath, allowedNodeTypes) {
  const n8nPath = publicPath.replace(/\/?$/, '/')
  const b64 = v => Buffer.from(v).toString('base64')
  const configTags = [
    `<meta name="n8n:config:rest-endpoint" content="${b64('rest')}">`,
    `<meta name="n8n:config:sentry" content="${b64(JSON.stringify({ dsn: '', environment: 'development', release: 'n8n@2.33.7' }))}">`,
  ].join('')

  const processText = (content, isHtml) => {
    let out = content
    out = out.replace(/\/\{\{BASE_PATH\}\}\//g, n8nPath)
    out = out.replace(/\/%7B%7BBASE_PATH%7D%7D\//g, n8nPath)
    out = out.replace(/\/%257B%257BBASE_PATH%257D%257D\//g, n8nPath)
    out = out.replace(/\{\{BASE_PATH\}\}/g, publicPath)
    if (isHtml) {
      out = out.replace('%CONFIG_TAGS%', configTags)
      out = out.replace('{{REST_ENDPOINT}}', 'rest')
    }
    return out
  }

  const getAllFiles = (dir, base = dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const files = []
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) files.push(...getAllFiles(full, base))
      else files.push(path.relative(base, full))
    }
    return files
  }

  fs.mkdirSync(cacheDir, { recursive: true })
  for (const file of getAllFiles(distDir)) {
    const src  = path.join(distDir, file)
    const dest = path.join(cacheDir, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (/\.(js|css|html)$/.test(file)) {
      const content = fs.readFileSync(src, 'utf-8')
      fs.writeFileSync(dest, processText(content, file.endsWith('.html')), 'utf-8')
    } else {
      fs.copyFileSync(src, dest)
    }
  }

  // Generate types/nodes.json and types/credentials.json from n8n-nodes-base.
  // The n8n editor UI fetches these as static assets — real n8n writes them at startup.
  try {
    const req = createRequire(import.meta.url)
    const baseDir = path.dirname(req.resolve('n8n-nodes-base/package.json'))
    const typesDir = path.join(cacheDir, 'types')
    fs.mkdirSync(typesDir, { recursive: true })

    const baseNodes = JSON.parse(fs.readFileSync(path.join(baseDir, 'dist/types/nodes.json'), 'utf-8'))
    // Prefix, filter to allowed set, then deduplicate keeping highest version.
    const prefixedFiltered = baseNodes
      .map(n => ({ ...n, name: `n8n-nodes-base.${n.name}` }))
      .filter(n => allowedNodeTypes.has(n.name))
    const best = {}
    for (const n of prefixedFiltered) {
      const ver = Array.isArray(n.version) ? Math.max(...n.version) : (n.version ?? 1)
      if (!best[n.name] || ver > best[n.name].ver) best[n.name] = { node: n, ver }
    }
    // Include CAP custom nodes so the browser palette shows them on first load.
    // They are also served via /rest/node-types but the static file is loaded first.
    const lcNodes = loadLangchainNodes(req, allowedNodeTypes)
    const prefixed = [...Object.values(best).map(e => e.node), ...lcNodes, ...CAP_NODE_TYPES]
    fs.writeFileSync(path.join(typesDir, 'nodes.json'), JSON.stringify(prefixed), 'utf-8')

    const baseCreds = JSON.parse(fs.readFileSync(path.join(baseDir, 'dist/types/credentials.json'), 'utf-8'))
    // Strip credentials that expose themselves as "Action in an app" HTTP shortcut nodes.
    // These add alienvault, auth0, etc. to the palette — we don't want them.
    const filteredCreds = baseCreds.filter(c => !c.httpRequestNode)
    fs.writeFileSync(path.join(typesDir, 'credentials.json'), JSON.stringify(filteredCreds), 'utf-8')

    log.info(`n8n types written: ${prefixed.length} nodes, ${filteredCreds.length} credentials (${baseCreds.length - filteredCreds.length} HTTP shortcut nodes removed)`)
  } catch (err) {
    log.warn('Could not generate types JSON:', err.message)
  }

  log.info(`n8n static cache generated at ${cacheDir}`)
}

// ── Node types ─────────────────────────────────────────────────────────────────

const ALLOWED_NODE_TYPES = new Set([
  // Flow control
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.loop',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.stopAndError',
  'n8n-nodes-base.noOp',
  // Core data transformation
  'n8n-nodes-base.set',
  'n8n-nodes-base.code',
  // Item-set operations (credential-free)
  'n8n-nodes-base.filter',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.summarize',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.compareDatasets',
  'n8n-nodes-base.dateTime',
  // Format conversion (credential-free)
  'n8n-nodes-base.markdown',
  'n8n-nodes-base.xml',
  'n8n-nodes-base.html',
  // Workflow composition
  'n8n-nodes-base.executeWorkflow',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.stickyNote',
  // External connectivity (auth=None by default, inline auth only)
  'n8n-nodes-base.httpRequest',
  // Chat / webhook response
  'n8n-nodes-base.respondToWebhook',
  // LangChain AI nodes — executed via cds.requires.llm, no model sub-node needed
  '@n8n/n8n-nodes-langchain.chainLlm',
  '@n8n/n8n-nodes-langchain.textClassifier',
  '@n8n/n8n-nodes-langchain.chainSummarization',
  '@n8n/n8n-nodes-langchain.sentimentAnalysis',
  '@n8n/n8n-nodes-langchain.informationExtractor',
  '@n8n/n8n-nodes-langchain.guardrails',
  '@n8n/n8n-nodes-langchain.agent',
  '@n8n/n8n-nodes-langchain.chatTrigger',
  '@n8n/n8n-nodes-langchain.chat',
])

/** CAP custom node descriptors — type names must match N8nService.js dispatch keys */
const CAP_NODE_TYPES = [
  {
    name: 'CUSTOM.capAction',
    displayName: 'CAP Action',
    icon: 'fa:bolt',
    iconColor: 'orange',
    group: ['transform'],
    version: 1,
    description: 'Call a CAP service action or function in-process',
    defaults: { name: 'CAP Action' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Service',
        name: 'service',
        type: 'options',
        default: '',
        required: true,
        description: 'CAP service name as defined in cds.requires',
        typeOptions: { loadOptionsMethod: 'getCapServices' },
      },
      {
        displayName: 'Action',
        name: 'action',
        type: 'options',
        default: '',
        required: true,
        description: 'Action or function name exposed by the service',
        typeOptions: { loadOptionsMethod: 'getCapActions', loadOptionsDependsOn: ['service'] },
      },
      { displayName: 'Parameters (JSON)', name: 'params', type: 'json', default: '{}', description: 'Parameters to pass to the action. Use ={{ $json }} to forward the current item.' },
    ],
    methods: {
      loadOptions: {
        async getCapServices() {
          return []  // resolved server-side via /rest/dynamic-node-parameters/options
        },
        async getCapActions() {
          return []
        },
      },
    },
    codex: { categories: ['CAP'], subcategories: { CAP: ['Actions'] } },
  },
  {
    name: 'CUSTOM.capEntity',
    displayName: 'CAP Entity',
    icon: 'fa:database',
    iconColor: 'blue',
    group: ['transform'],
    version: 1,
    description: 'Read, create, update or delete a CAP entity in-process',
    defaults: { name: 'CAP Entity' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Service',
        name: 'service',
        type: 'options',
        default: '',
        required: false,
        description: 'CAP service name (required for create/update/delete)',
        typeOptions: { loadOptionsMethod: 'getCapServices' },
      },
      {
        displayName: 'Entity',
        name: 'entity',
        type: 'options',
        default: '',
        required: true,
        description: 'Fully qualified entity name, e.g. CatalogService.Books',
        typeOptions: { loadOptionsMethod: 'getCapEntities', loadOptionsDependsOn: ['service'] },
      },
      {
        displayName: 'Operation', name: 'operation', type: 'options', default: 'list', required: true,
        options: [
          { name: 'Read (List)', value: 'list' },
          { name: 'Read (By Key)', value: 'get' },
          { name: 'Create', value: 'create' },
          { name: 'Update', value: 'update' },
          { name: 'Delete', value: 'delete' },
        ],
      },
      { displayName: 'Columns (comma-separated)', name: 'columns', type: 'string', default: '', placeholder: 'ID, title, stock', description: 'Leave empty to select all columns', displayOptions: { show: { operation: ['list'] } } },
      { displayName: 'Filter (CQL WHERE clause)', name: 'filter', type: 'string', default: '', displayOptions: { show: { operation: ['list'] } } },
      { displayName: 'Order By', name: 'orderBy', type: 'string', default: '', placeholder: 'stock desc, title asc', description: 'CQL ORDER BY clause — pushed to DB', displayOptions: { show: { operation: ['list'] } } },
      { displayName: 'Limit', name: 'top', type: 'number', default: 0, description: 'Max rows to return (0 = no limit) — pushed to DB', displayOptions: { show: { operation: ['list'] } } },
      { displayName: 'Skip', name: 'skip', type: 'number', default: 0, description: 'Rows to skip for pagination — pushed to DB', displayOptions: { show: { operation: ['list'] } } },
      { displayName: 'Key', name: 'key', type: 'string', default: '', displayOptions: { show: { operation: ['get', 'update', 'delete'] } } },
      { displayName: 'Body (JSON)', name: 'body', type: 'json', default: '{}', displayOptions: { show: { operation: ['create', 'update'] } } },
    ],
    codex: { categories: ['CAP'], subcategories: { CAP: ['Data'] } },
  },
  {
    name: 'CUSTOM.capCql',
    displayName: 'CAP CQL Query',
    icon: 'fa:search',
    iconColor: 'green',
    group: ['transform'],
    version: 1,
    description: 'Run a CQL SELECT against the CAP database in-process',
    defaults: { name: 'CAP CQL Query' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'CQL Statement',
        name: 'cql',
        type: 'string',
        typeOptions: { rows: 6 },
        default: 'SELECT * FROM CatalogService.Books LIMIT 10',
        required: true,
        description: 'Only SELECT statements are allowed. Use ={{ $json.field }} for dynamic values.',
      },
      { displayName: 'Parameters (JSON)', name: 'params', type: 'json', default: '{}' },
    ],
    codex: { categories: ['CAP'], subcategories: { CAP: ['Data'] } },
  },
  {
    name: 'CUSTOM.capLlmProvider',
    displayName: 'CAP LLM',
    icon: 'fa:brain',
    iconColor: 'purple',
    group: ['ai'],
    version: 1,
    description: 'Provides a CAP-configured LLM to AI nodes — pick which cds.requires service to use',
    defaults: { name: 'CAP LLM' },
    inputs: [],
    outputs: ['ai_languageModel'],
    outputNames: ['Language Model'],
    properties: [
      {
        displayName: 'Service Name',
        name: 'service',
        type: 'string',
        default: 'llm',
        required: true,
        description: 'cds.requires service name (e.g. "llm", "llm-fast"). Must be configured in cds.requires.',
      },
    ],
    codex: { categories: ['CAP'], subcategories: { CAP: ['AI'] }, alias: ['llm', 'model', 'ai'] },
  },
  {
    name: 'CUSTOM.capAgent',
    displayName: 'CAP Agent',
    icon: 'node:openAi',
    iconColor: 'black',
    group: ['transform'],
    version: 1,
    description: 'Call a @cap-js/agents A2A agent. Routes to "Input Required" when the agent pauses for human input (HITL).',
    defaults: { name: 'CAP Agent' },
    inputs: ['main'],
    outputs: ['main', 'main'],
    outputNames: ['Response', 'Input Required'],
    properties: [
      { displayName: 'CAP Server Base URL', name: 'baseUrl', type: 'string', default: 'http://localhost:4004', description: 'CAP server base URL' },
      { displayName: 'Agent Path', name: 'agentPath', type: 'string', default: '/a2a/my-agent', description: 'A2A path for the agent service (e.g. /a2a/catalog)' },
      { displayName: 'Message', name: 'message', type: 'string', typeOptions: { rows: 4 }, default: '={{ $json.message ?? $json.text ?? $json.input }}', description: 'Message to send to the agent' },
      { displayName: 'Context ID', name: 'contextId', type: 'string', default: '={{ $json.contextId }}', description: 'Conversation context ID for multi-turn. Leave blank to start a new conversation.' },
      { displayName: 'Wait for Completion', name: 'waitForCompletion', type: 'boolean', default: true, description: 'Wait for the agent to finish. If false, returns immediately with the task ID.' },
      { displayName: 'Poll Interval (ms)', name: 'pollIntervalMs', type: 'number', default: 1000, displayOptions: { show: { waitForCompletion: [true] } }, description: 'How often to poll for task completion' },
      { displayName: 'Timeout (ms)', name: 'timeoutMs', type: 'number', default: 60000, displayOptions: { show: { waitForCompletion: [true] } }, description: 'Max time to wait for completion' },
    ],
    codex: { categories: ['CAP'], subcategories: { CAP: ['AI'] } },
  },
]

/** Load and filter nodes.json, caching the result */
let _nodeTypesCache = null
function getNodeTypes(staticDir) {
  if (_nodeTypesCache) return _nodeTypesCache

  let allNodes = []

  // Try the pre-processed cache first (has full n8n-nodes-base. prefixed names)
  const cacheNodesJson = path.join(staticDir, 'types', 'nodes.json')
  if (existsSync(cacheNodesJson)) {
    try { allNodes = JSON.parse(fs.readFileSync(cacheNodesJson, 'utf8')) } catch { /**/ }
  }

  // Fall back to n8n-nodes-base/dist/types/nodes.json (short names, add prefix)
  if (!allNodes.length) {
    try {
      const req = createRequire(import.meta.url)
      const pkgDir = path.dirname(req.resolve('n8n-nodes-base/package.json'))
      const raw = JSON.parse(fs.readFileSync(path.join(pkgDir, 'dist/types/nodes.json'), 'utf8'))
      allNodes = raw.map(n => ({ ...n, name: `n8n-nodes-base.${n.name}` }))
    } catch { /**/ }
  }

  // Deduplicate by type name, keeping the highest version
  const best = {}
  for (const node of allNodes) {
    if (!ALLOWED_NODE_TYPES.has(node.name)) continue
    const ver = Array.isArray(node.version) ? Math.max(...node.version) : (node.version ?? 1)
    if (!best[node.name] || ver > best[node.name].ver) best[node.name] = { node, ver }
  }

  if (!Object.keys(best).length) log.warn('Could not load n8n node types — only CAP nodes will appear')
  const req2 = createRequire(import.meta.url)
  const lcNodes = loadLangchainNodes(req2, ALLOWED_NODE_TYPES)
  const combined = [...Object.values(best).map(e => e.node), ...lcNodes, ...CAP_NODE_TYPES]
  // Deduplicate by name — static cache file may already include LangChain nodes
  const seen = new Set()
  _nodeTypesCache = combined.filter(n => { if (seen.has(n.name)) return false; seen.add(n.name); return true })
  return _nodeTypesCache
}

// ── User helper ────────────────────────────────────────────────────────────────

function getUserInfo(req) {
  const u = req.user
  if (u && u.id && u.id !== 'anonymous') {
    return {
      email: u.id.includes('@') ? u.id : `${u.id}@cap-ai.local`,
      firstName: u.attr?.given_name ?? u.id,
      lastName: u.attr?.family_name ?? 'User',
    }
  }
  return { email: 'admin@cap-ai.local', firstName: 'CAP', lastName: 'Admin' }
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

const WF_ENTITY   = 'cap.ai.n8n.WorkflowDefinitions'
const EX_ENTITY   = 'cap.ai.n8n.WorkflowExecutions'
const STEP_ENTITY = 'cap.ai.n8n.WorkflowStepResults'

const WORKFLOW_SCOPES = [
  'execution:reveal',
  'workflow:create','workflow:delete','workflow:disableRedaction','workflow:enableRedaction',
  'workflow:execute','workflow:execute-chat','workflow:export','workflow:import',
  'workflow:list','workflow:move','workflow:publish','workflow:read',
  'workflow:share','workflow:unpublish','workflow:unshare','workflow:update',
]

function workflowChecksum(row) {
  const content = JSON.stringify({
    nodes: parseJson(row.nodes, []),
    connections: parseJson(row.connections, {}),
    settings: parseJson(row.settings, {}),
  })
  return createHash('sha256').update(content).digest('hex')
}

function rowToWorkflow(row, { includeNodes = true } = {}) {
  const base = {
    id: row.ID,
    name: row.name ?? '',
    description: null,
    active: row.active ?? false,
    isArchived: false,
    settings: parseJson(row.settings, { executionOrder: 'v1' }),
    versionId: row.versionId ?? row.ID,
    activeVersionId: null,
    versionCounter: row.versionCounter ?? 1,
    triggerCount: 0,
    sourceWorkflowId: null,
    parentFolder: null,
    activeVersion: null,
    meta: null,
    nodeGroups: [],
    pinData: parseJson(row.pinData, {}),
    tags: [],
    homeProject: PERSONAL_PROJECT_STUB,
    sharedWithProjects: [],
    usedCredentials: [],
    scopes: WORKFLOW_SCOPES,
    checksum: workflowChecksum(row),
    createdAt: row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updatedAt ?? new Date().toISOString(),
  }
  if (includeNodes) {
    base.nodes = parseJson(row.nodes, [])
    base.connections = parseJson(row.connections, {})
    base.staticData = parseJson(row.staticData, null)
  }
  return base
}

const PERSONAL_PROJECT_STUB = {
  id: 'personal',
  name: 'Personal',
  type: 'personal',
  role: 'project:personalOwner',
  icon: null,
}

function rowToExecution(row, stepRows = [], wfRow = null) {
  // Build node id→name map from workflow definition
  const nodeNames = {}
  if (wfRow?.nodes) {
    const nodes = parseJson(wfRow.nodes, [])
    for (const n of nodes) nodeNames[n.id] = n.name
  }

  // Build runData: { "NodeName": [TaskData, TaskData, ...] }
  // Nodes that run multiple times (loops) produce one entry per runIndex.
  // stepRows arrive ordered by executedAt asc, runIndex asc from the DB query.
  const sorted = stepRows
  const runData = {}
  let execIdx = 0
  for (const step of sorted) {
    const name = nodeNames[step.nodeID] ?? step.nodeID
    const raw = parseJson(step.output, [])
    // raw is either Array[] (port arrays stored by new code) or flat item array (old code)
    const portArrays = Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])
      ? raw
      : [Array.isArray(raw) ? raw : [{ json: raw }]]
    const taskData = {
      startTime: step.executedAt ? new Date(step.executedAt).getTime() : 0,
      executionTime: 0,
      executionIndex: execIdx++,
      executionStatus: step.status === 'success' ? 'success' : 'error',
      hints: [],
      data: { main: portArrays },
      source: [],
      error: step.error ? parseJson(step.error, { message: step.error }) : undefined,
    }
    if (!runData[name]) runData[name] = []
    runData[name].push(taskData)
  }

  // Fill source arrays from connections: for each edge A →(portP)→ B,
  // set source on each run of B pointing back to the corresponding run of A.
  if (wfRow?.connections) {
    const connections = parseJson(wfRow.connections, {})
    for (const [srcName, branches] of Object.entries(connections)) {
      const mainPorts = branches.main ?? []
      for (let portIdx = 0; portIdx < mainPorts.length; portIdx++) {
        for (const edge of (mainPorts[portIdx] ?? [])) {
          const destRuns = runData[edge.node]
          if (!destRuns?.length) continue
          const srcRuns = runData[srcName] ?? []
          destRuns.forEach((taskData, runI) => {
            if (!taskData.source?.length) {
              taskData.source = [{
                previousNode: srcName,
                previousNodeRun: Math.min(runI, Math.max(0, srcRuns.length - 1)),
                previousNodeOutput: portIdx,
              }]
            }
          })
        }
      }
    }
  }

  const finished = row.finishedAt != null || row.status === 'success' || row.status === 'error'
  // lastNodeExecuted = name of the node with the highest runIndex (last to execute)
  const lastStep = sorted[sorted.length - 1]
  const lastNodeExecuted = lastStep
    ? (nodeNames[lastStep.nodeID] ?? lastStep.nodeID)
    : undefined

  const executionDataObj = {
    version: 1,
    startData: { destinationNode: null, runNodeFilter: null },
    resultData: {
      runData,
      pinData: parseJson(row.pinData, {}),
      error: row.status === 'error' ? parseJson(row.error, undefined) : undefined,
      lastNodeExecuted,
    },
    executionData: {
      contextData: {},
      nodeExecutionStack: [],
      metadata: {},
      waitingExecution: {},
      waitingExecutionSource: {},
      runtimeData: {
        version: 1,
        establishedAt: row.startedAt ? new Date(row.startedAt).getTime() : Date.now(),
        source: 'manual',
        triggerNode: null,
        redaction: null,
        credentials: {},
      },
    },
    resumeToken: null,
  }

  const createdAt = row.startedAt ?? null

  return {
    id: row.ID,
    finished,
    mode: row.mode ?? 'manual',
    retryOf: null,
    retrySuccessId: null,
    status: row.status ?? 'unknown',
    createdAt,
    startedAt: row.startedAt ?? null,
    stoppedAt: row.finishedAt ?? null,
    deletedAt: null,
    waitTill: null,
    storedAt: 'db',
    tracingContext: null,
    deduplicationKey: null,
    jsonSizeBytes: 0,
    binaryDataSizeBytes: 0,
    workflowVersionId: null,
    usedPrivateCredentials: false,
    workflowId: row.workflow_ID ?? null,
    workflowData: wfRow ? rowToWorkflow(wfRow) : null,
    data: serializeExecutionData(executionDataObj),
  }
}

/**
 * Serialize execution data using n8n's flatted format.
 * The n8n UI calls flatted.parse() to decode execution data, so we must
 * use flatted.stringify() — our previous custom serializer was incompatible.
 */
function serializeExecutionData(data) {
  return flattedStringify(data)
}

function parseJson(val, fallback) {
  if (val == null) return fallback
  if (typeof val !== 'string') return val
  try { return JSON.parse(val) } catch { return fallback }
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Build the n8n REST API + static file router.
 *
 * Returns an object with { router, staticDir, publicPath, serveStatic } so the
 * caller can mount them on any Express app at the right path.
 *
 * @param {{ publicPath?: string, staticDir?: string, publicOrigin?: string }} [cfg]
 */
export function buildN8nRouter(cfg = {}) {
  const publicPath  = (cfg.publicPath ?? '/n8n').replace(/\/$/, '')
  const staticDir   = resolveStaticDir(cfg)
  const distDir     = resolveDistDir()

  if (!existsSync(staticDir)) {
    if (distDir) {
      log.info('Generating n8n static cache (first run)…')
      generateStaticCacheSync(distDir, staticDir, publicPath, ALLOWED_NODE_TYPES)
      log.info('n8n static cache ready')
    } else {
      log.warn(`n8n static dir not found: ${staticDir} — UI will not load`)
    }
  } else {
    // Cache already exists — regenerate types/nodes.json so custom CAP nodes are always current.
    // This is fast (just writes one small JSON file) and ensures palette changes take effect on restart.
    try {
      const req = createRequire(import.meta.url)
      const baseDir = path.dirname(req.resolve('n8n-nodes-base/package.json'))
      const typesDir = path.join(staticDir, 'types')
      fs.mkdirSync(typesDir, { recursive: true })
      const baseNodes = JSON.parse(fs.readFileSync(path.join(baseDir, 'dist/types/nodes.json'), 'utf-8'))
      const prefixedFiltered = baseNodes
        .map(n => ({ ...n, name: `n8n-nodes-base.${n.name}` }))
        .filter(n => ALLOWED_NODE_TYPES.has(n.name))
      const best = {}
      for (const n of prefixedFiltered) {
        const ver = Array.isArray(n.version) ? Math.max(...n.version) : (n.version ?? 1)
        if (!best[n.name] || ver > best[n.name].ver) best[n.name] = { node: n, ver }
      }
      const lcNodes = loadLangchainNodes(req, ALLOWED_NODE_TYPES)
      const merged = [...Object.values(best).map(e => e.node), ...lcNodes, ...CAP_NODE_TYPES]
      fs.writeFileSync(path.join(typesDir, 'nodes.json'), JSON.stringify(merged), 'utf-8')

      // Also regenerate credentials.json — may be missing if the types/ dir was
      // deleted independently of the rest of the cache (types/ is a subdirectory
      // of staticDir, so existsSync(staticDir) is true even when types/ is absent).
      const credsJsonPath = path.join(typesDir, 'credentials.json')
      if (!existsSync(credsJsonPath)) {
        const baseCreds = JSON.parse(fs.readFileSync(path.join(baseDir, 'dist/types/credentials.json'), 'utf-8'))
        const filteredCreds = baseCreds.filter(c => !c.httpRequestNode)
        fs.writeFileSync(credsJsonPath, JSON.stringify(filteredCreds), 'utf-8')
        log.info(`n8n types refreshed: ${merged.length} nodes (${lcNodes.length} LangChain, ${CAP_NODE_TYPES.length} CAP custom), ${filteredCreds.length} credentials (regenerated missing file)`)
      } else {
        log.info(`n8n types refreshed: ${merged.length} nodes (${lcNodes.length} LangChain, ${CAP_NODE_TYPES.length} CAP custom)`)
      }
    } catch (err) {
      log.warn('Could not refresh types/nodes.json:', err.message)
    }
  }
  log.info(`Serving n8n UI from ${staticDir}`)

  // ── JSON body parsing router ────────────────────────────────────────────────
  const router = express.Router()
  router.use(express.json())

  // ── Auth — never show the login screen ─────────────────────────────────────

  // Real n8n GET /rest/login returns the current user object (not wrapped in {user:...})
  // Shape matches what the frontend store reads: data.id, data.role, data.globalScopes, etc.
  router.get('/rest/login', (req, res) => {
    const u = getUserInfo(req)
    res.json({
      data: {
        id: 'cap-ai-owner',
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        personalizationAnswers: null,
        settings: { userActivated: true },
        disabled: false,
        mfaEnabled: false,
        lastActiveAt: new Date().toISOString().slice(0, 10),
        isPending: false,
        role: 'global:owner',
        signInType: 'email',
        isOwner: true,
        featureFlags: {},
        globalScopes: [],
        mfaAuthenticated: false,
        isManagedByEnv: false,
      },
    })
  })

  router.post('/rest/login', (req, res) => {
    res.setHeader('Set-Cookie', 'n8n-auth-token=cap-session; Path=/; HttpOnly')
    const u = getUserInfo(req)
    res.json({
      data: {
        id: 'cap-ai-owner',
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        personalizationAnswers: null,
        settings: { userActivated: true },
        disabled: false,
        mfaEnabled: false,
        lastActiveAt: new Date().toISOString().slice(0, 10),
        isPending: false,
        role: 'global:owner',
        signInType: 'email',
        isOwner: true,
        featureFlags: {},
        globalScopes: [],
        mfaAuthenticated: false,
        isManagedByEnv: false,
      },
    })
  })

  router.get('/rest/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'n8n-auth-token=; Path=/; HttpOnly; Max-Age=0')
    res.json({ data: {} })
  })

  // ── /rest/me ────────────────────────────────────────────────────────────────

  router.get('/rest/me', (req, res) => {
    const u = getUserInfo(req)
    res.json({
      data: {
        id: 'cap-ai-owner',
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        personalizationAnswers: null,
        settings: { userActivated: true, easyAIWorkflowOnboarded: true },
        disabled: false,
        mfaEnabled: false,
        lastActiveAt: new Date().toISOString().slice(0, 10),
        isPending: false,
        role: 'global:owner',
        signInType: 'email',
        isOwner: true,
        featureFlags: {},
        globalScopes: [],
        mfaAuthenticated: false,
        isManagedByEnv: false,
      },
    })
  })

  router.get('/rest/me/api-key', (_req, res) => {
    res.json({ data: { apiKey: 'cap-managed' } })
  })

  // ── /rest/settings ──────────────────────────────────────────────────────────

  const port = cds.env.server?.port ?? process.env.PORT ?? 4004
  const publicOrigin = `http://localhost:${port}`
  const publicPathSlash = publicPath + '/'

  router.get('/rest/settings', (_req, res) => {
    res.json({
      data: {
        // 'authenticated' (not 'public') so the store applies all settings fields.
        // With 'public' the store skips the entire block that sets timezone, endpoints,
        // instanceId, allowedModules, etc. and still calls n.telemetry.enabled without
        // optional chaining — crashing if telemetry is absent.
        settingsMode: 'authenticated',
        inE2ETests: false,
        isDocker: false,
        databaseType: 'sqlite',
        previewMode: false,
        endpointForm: 'form',
        endpointFormTest: 'form-test',
        endpointFormWaiting: 'form-waiting',
        endpointMcp: 'mcp',
        endpointMcpTest: 'mcp-test',
        endpointWebhook: 'webhook',
        endpointWebhookTest: 'webhook-test',
        endpointWebhookWaiting: 'webhook-waiting',
        endpointHealth: '/healthz',
        saveDataErrorExecution: 'all',
        saveDataSuccessExecution: 'all',
        saveManualExecutions: true,
        saveExecutionProgress: false,
        executionTimeout: -1,
        maxExecutionTimeout: 3600,
        workflowCallerPolicyDefaultOption: 'workflowsFromSameOwner',
        oauthCallbackUrls: {
          oauth1: `${publicOrigin}/rest/oauth1-credential/callback`,
          oauth2: `${publicOrigin}/rest/oauth2-credential/callback`,
        },
        jwksUri: `${publicOrigin}/rest/.well-known/jwks.json`,
        timezone: 'UTC',
        urlBaseWebhook: `${publicOrigin}/`,
        urlBaseEditor: `${publicOrigin}${publicPathSlash}`,
        urlBaseWebhookTest: `${publicOrigin}${publicPathSlash}`,
        versionCli: '2.33.7',
        // n8n strips the leading 'v' from process.version; does not expose nodeEnv
        nodeJsVersion: process.version.replace(/^v/, ''),
        concurrency: -1,
        evaluationConcurrencyLimit: 1,
        authCookie: { secure: false },
        binaryDataMode: 'filesystem',
        releaseChannel: 'stable',
        instanceId: 'cap-ai-n8n',
        telemetry: { enabled: false },
        posthog: {
          enabled: false,
          apiHost: 'https://ph.n8n.io',
          apiKey: '',
          autocapture: false,
          disableSessionRecording: true,
          debug: false,
          proxy: `${publicOrigin}/rest/ph`,
        },
        personalizationSurveyEnabled: false,
        defaultLocale: 'en',
        userManagement: {
          quota: -1,
          showSetupOnFirstLoad: false,
          smtpSetup: false,
          authenticationMethod: 'email',
          passwordMinLength: 8,
        },
        sso: {
          managedByEnv: false,
          saml: { loginLabel: '', loginEnabled: false },
          oidc: {
            loginEnabled: false,
            loginUrl: `${publicOrigin}/rest/sso/oidc/login`,
            callbackUrl: `${publicOrigin}/rest/sso/oidc/callback`,
          },
          ldap: { loginLabel: '', loginEnabled: false },
        },
        logStreaming: { managedByEnv: false },
        dataTables: { maxSize: 209715200 },
        publicApi: { enabled: true, latestVersion: 1, path: 'api', swaggerUi: { enabled: true } },
        workflowTagsDisabled: false,
        workflowsAutosaveDisabled: false,
        useWorkflowPublicationService: false,
        logLevel: 'info',
        hiringBannerEnabled: false,
        templates: { enabled: false, host: '' },
        executionMode: 'regular',
        isMultiMain: false,
        // SSE — our adapter serves GET /rest/push as text/event-stream
        pushBackend: 'sse',
        communityNodesEnabled: false,
        unverifiedCommunityNodesEnabled: false,
        communityNodesManagedByEnv: false,
        aiAssistant: { enabled: false, setup: false },
        askAi: { enabled: false },
        aiBuilder: { enabled: false, setup: false },
        deployment: { type: 'default' },
        // Empty object (not {builtIn:[],external:[]}) matches n8n when no modules configured
        allowedModules: {},
        enterprise: {
          sharing: false,
          ldap: false,
          saml: false,
          oidc: false,
          mfaEnforcement: false,
          logStreaming: false,
          advancedExecutionFilters: false,
          variables: false,
          sourceControl: false,
          auditLogs: false,
          externalSecrets: false,
          showNonProdBanner: false,
          debugInEditor: false,
          binaryDataS3: false,
          workerView: false,
          advancedPermissions: false,
          workflowDiffs: false,
          namedVersions: false,
          provisioning: false,
          projects: { team: { limit: 0 } },
          customRoles: false,
          personalSpacePolicy: false,
          dataRedaction: false,
          otelCustomSpanAttributes: false,
          workflowReviews: false,
        },
        mfa: { enabled: true, enforced: false },
        hideUsagePage: true,
        license: { planName: 'Community', consumerId: 'cap-ai', environment: 'development' },
        variables: { limit: 0 },
        banners: { dismissed: ['V1'] },
        workflowHistory: { pruneTime: 24, licensePruneTime: 24 },
        pruning: { isEnabled: true, maxAge: 336, maxCount: 10000 },
        aiCredits: { enabled: false, credits: 0, setup: false },
        ai: { allowSendingParameterValues: true },
        security: { blockFileAccessToN8nFiles: true },
        chatTrigger: { disablePublicChat: false },
        easyAIWorkflowOnboarded: true,
        folders: { enabled: false },
        collaboration: { crdt: 'off' },
        evaluation: {
          quota: 0,
          collectionsEnabled: false,
          configEvalsEnabled: false,
          agentEvalsEnabled: false,
        },
        activeModules: [],
        canvasOnly: false,
        envFeatureFlags: {},
        versionNotifications: {
          enabled: false,
          endpoint: 'https://api.n8n.io/api/versions/',
          whatsNewEnabled: true,
          whatsNewEndpoint: 'https://api.n8n.io/api/whats-new',
          infoUrl: 'https://docs.n8n.io/hosting/installation/updating/',
        },
        dynamicBanners: { endpoint: 'https://api.n8n.io/api/banners', enabled: false, filters: { publishedWorkflowCount: 0 } },
        missingPackages: false,
      },
    })
  })

  // ── /rest/node-types ────────────────────────────────────────────────────────

  router.get('/rest/node-types', (_req, res) => {
    res.json({ data: getNodeTypes(staticDir) })
  })

  // POST /rest/node-types — UI posts nodeInfos to get full descriptions by name@version
  router.post('/rest/node-types', (req, res) => {
    const { nodeInfos = [] } = req.body ?? {}
    const all = getNodeTypes(staticDir)
    const result = nodeInfos.map(({ name }) => all.find(n => n.name === name)).filter(Boolean)
    res.json({ data: result })
  })

  router.get('/rest/node-types/:nodeType/translation', (_req, res) => {
    res.json({})
  })

  // ── /rest/node-icon — return 404, UI degrades gracefully ────────────────────

  router.get('/rest/node-icon/:packageName/:nodeType', (_req, res) => {
    res.status(404).end()
  })

  router.get('/rest/node-icon-source/:packageName/:nodeType', (_req, res) => {
    res.status(404).end()
  })

  // ── /rest/active-workflows ──────────────────────────────────────────────────

  router.get('/rest/active-workflows', (_req, res) => {
    res.json({ data: [] })
  })

  // ── /rest/tags, /rest/variables, /rest/credentials ─────────────────────────

  router.get('/rest/tags', (_req, res) => { res.json({ data: [] }) })
  router.get('/rest/variables', (_req, res) => { res.json({ data: [] }) })
  router.get('/rest/credentials', (_req, res) => { res.json({ data: [] }) })
  router.get('/rest/credential-types', (_req, res) => { res.json({ data: [] }) })
  router.get('/rest/credentials/for-workflow', (_req, res) => { res.json({ data: [] }) })
  // Shared handler for GET (legacy) and POST (current n8n UI) versions.
  // POST body: { path, methodName, currentNodeParameters, nodeTypeAndVersion }
  // GET query: { path, nodeType, currentNodeParameters (JSON string) }
  async function _handleDynamicOptions(paramPath, currentNodeParameters, res) {
    const model = cds.model
    if (!model) return res.json({ data: [] })

    // Build service/entity/action map — deduplicate by tracking seen names per service
    const svcMap = {}
    for (const [fqn, def] of Object.entries(model.definitions ?? {})) {
      if (def.kind !== 'service') continue
      if (def['@protocol'] === 'none' || def['@n8n']) continue
      svcMap[fqn] = { entities: new Set(), actions: new Set() }
    }
    for (const [fqn, def] of Object.entries(model.definitions ?? {})) {
      const dot = fqn.lastIndexOf('.')
      if (dot < 0) continue
      const svcName = fqn.slice(0, dot)
      if (!svcMap[svcName]) continue
      const shortName = fqn.slice(dot + 1)
      if (def.kind === 'entity') svcMap[svcName].entities.add(shortName)
      else if (def.kind === 'action' || def.kind === 'function') svcMap[svcName].actions.add(shortName)
    }

    const normPath = paramPath ?? ''
    if (normPath === 'service' || normPath.endsWith('.service')) {
      return res.json({ data: Object.keys(svcMap).map(name => ({ name, value: name })) })
    }
    if (normPath === 'action' || normPath.endsWith('.action')) {
      const svcName = currentNodeParameters?.service
      const actions = svcName && svcMap[svcName]
        ? [...svcMap[svcName].actions]
        : [...new Set(Object.values(svcMap).flatMap(s => [...s.actions]))]
      return res.json({ data: actions.map(a => ({ name: a, value: a })) })
    }
    if (normPath === 'entity' || normPath.endsWith('.entity')) {
      const svcName = currentNodeParameters?.service
      const entities = svcName && svcMap[svcName]
        ? [...svcMap[svcName].entities]
        : [...new Set(Object.values(svcMap).flatMap(s => [...s.entities]))]
      return res.json({ data: entities.map(e => ({ name: e, value: e })) })
    }

    res.json({ data: [] })
  }

  router.get('/rest/dynamic-node-parameters/options', async (req, res) => {
    try {
      const { path: paramPath, currentNodeParameters: cpRaw } = req.query
      const currentNodeParameters = cpRaw
        ? (typeof cpRaw === 'string' ? JSON.parse(cpRaw) : cpRaw)
        : {}
      await _handleDynamicOptions(paramPath, currentNodeParameters, res)
    } catch (err) { res.status(500).json({ message: err.message }) }
  })

  router.post('/rest/dynamic-node-parameters/options', async (req, res) => {
    try {
      const { path: paramPath, currentNodeParameters } = req.body ?? {}
      await _handleDynamicOptions(paramPath, currentNodeParameters, res)
    } catch (err) { res.status(500).json({ message: err.message }) }
  })
  router.get('/rest/oauth2-credential/callback', (_req, res) => { res.json({ data: {} }) })

  // ── User/instance endpoints ─────────────────────────────────────────────────
  router.get('/rest/users', (_req, res) => {
    res.json({ data: [{
      id: 'cap-ai-owner',
      email: 'admin@cap-ai.local',
      firstName: 'CAP',
      lastName: 'Admin',
      role: 'global:owner',
      isPending: false,
      disabled: false,
      mfaEnabled: false,
    }] })
  })

  router.get('/rest/license', (_req, res) => {
    res.json({ data: {
      planName: 'Community',
      consumerId: 'cap-ai',
      environment: 'development',
    } })
  })

  router.get('/rest/insights/summary', (_req, res) => {
    res.json({ data: {
      averageRunTime: 0,
      failed: 0,
      failureRate: 0,
      runTime: 0,
      succeeded: 0,
      total: 0,
      timeSavedMin: 0,
    } })
  })

  router.get('/rest/data-tables-global', (_req, res) => { res.json({ data: [] }) })
  router.get('/rest/data-tables-global/limits', (_req, res) => { res.json({ data: {} }) })

  // Session/telemetry — accept and ignore
  router.get('/rest/events/session-started', (_req, res) => { res.json({}) })
  router.post('/rest/events/session-started', (_req, res) => { res.json({}) })
  router.post('/rest/telemetry', (_req, res) => { res.json({}) })
  router.use('/rest/ph', (_req, res) => { res.json({}) })

  // Stub out the instance AI examples endpoint — it serves a bundled JSON of example
  // workflows referencing third-party service nodes (AlienVault, Auth0, Gmail, etc.)
  // which clutter the "Add first step" empty-state view with irrelevant nodes.
  router.get('/rest/instance-ai-examples', (_req, res) => {
    res.json({ categories: [], subcategories: [], totalWorkflows: 0, workflows: [] })
  })

  // ── /rest/favorites — favorite workflows/nodes list ────────────────────────
  // Shape: array of enriched favorite objects. Empty for a CAP-managed instance.
  router.get('/rest/favorites', (_req, res) => { res.json({ data: [] }) })

  // ── /rest/module-settings — per-module frontend configuration ──────────────
  // Real n8n returns Object.fromEntries(moduleRegistry.settings) — empty object
  // when no extra modules are loaded, which is always the case here.
  router.get('/rest/module-settings', (_req, res) => { res.json({ data: {} }) })

  // ── /rest/workflows/new (name suggestion) ──────────────────────────────────

  router.get('/rest/workflows/new', (_req, res) => {
    res.json({ data: { name: 'My workflow' } })
  })

  // ── /rest/push — SSE endpoint for live updates ──────────────────────────────

  router.get('/rest/push', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=UTF-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.writeHead(200)
    res.write(':ok\n\n')
    res.flush?.()

    // Replay any recent events so fast executions that finished before this
    // SSE connection opened are not lost (fixes the "stuck" UI for quick workflows).
    const executionId = req.query.executionId
    const cutoff = Date.now() - RECENT_EVENT_TTL
    for (const ev of _recentEvents) {
      if (ev.ts < cutoff) continue
      if (executionId && ev.data?.executionId && ev.data.executionId !== executionId) continue
      try { res.write(`data: ${JSON.stringify({ type: ev.type, data: ev.data })}\n\n`) } catch { /* ignore */ }
    }
    res.flush?.()

    _sseClients.add(res)
    const t = setInterval(() => { try { res.write(':ping\n\n') } catch { _sseClients.delete(res) } }, 30000)
    req.on('close', () => { clearInterval(t); _sseClients.delete(res) })
  })

  // ── /api/v1/workflows — CRUD ────────────────────────────────────────────────

  router.get('/api/v1/workflows', async (_req, res) => {
    try {
      const db = await cds.connect.to('db')
      const rows = await db.run(SELECT.from(WF_ENTITY))
      res.json({ data: rows.map(rowToWorkflow), nextCursor: null })
    } catch (err) {
      log.error('GET workflows:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.post('/api/v1/workflows', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const body = req.body ?? {}
      const id = cds.utils.uuid()
      const now = new Date().toISOString()
      const row = {
        ID: id,
        name: body.name ?? 'My workflow',
        active: body.active ?? false,
        nodes: JSON.stringify(body.nodes ?? []),
        connections: JSON.stringify(body.connections ?? {}),
        settings: JSON.stringify(body.settings ?? {}),
        staticData: body.staticData ? JSON.stringify(body.staticData) : null,
        createdAt: now,
        updatedAt: now,
      }
      await db.run(INSERT.into(WF_ENTITY).entries(row))
      res.status(201).json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('POST workflows:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.get('/api/v1/workflows/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('GET workflow:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.put('/api/v1/workflows/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const body = req.body ?? {}
      const now = new Date().toISOString()
      const update = {
        name: body.name,
        active: body.active ?? false,
        nodes: JSON.stringify(body.nodes ?? []),
        connections: JSON.stringify(body.connections ?? {}),
        settings: JSON.stringify(body.settings ?? {}),
        staticData: body.staticData ? JSON.stringify(body.staticData) : null,
        updatedAt: now,
      }
      await db.run(UPDATE(WF_ENTITY).set(update).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('PUT workflow:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.delete('/api/v1/workflows/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(DELETE.from(WF_ENTITY).where({ ID: req.params.id }))
      res.json({})
    } catch (err) {
      log.error('DELETE workflow:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.post('/api/v1/workflows/:id/activate', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(UPDATE(WF_ENTITY).set({ active: true }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('activate workflow:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.post('/api/v1/workflows/:id/deactivate', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(UPDATE(WF_ENTITY).set({ active: false }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('deactivate workflow:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  // ── /api/v1/executions ──────────────────────────────────────────────────────

  router.get('/api/v1/executions', async (_req, res) => {
    try {
      const db = await cds.connect.to('db')
      const rows = await db.run(SELECT.from(EX_ENTITY))
      res.json({ data: rows.map(row => rowToExecution(row)), nextCursor: null })
    } catch (err) {
      log.error('GET executions:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.get('/api/v1/executions/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(EX_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      const [steps, wfRow] = await Promise.all([
        db.run(SELECT.from(STEP_ENTITY).where({ executionID: req.params.id }).orderBy('executedAt asc', 'runIndex asc')),
        row.workflow_ID ? db.run(SELECT.one.from(WF_ENTITY).where({ ID: row.workflow_ID })) : null,
      ])
      res.json({ data: rowToExecution(row, steps, wfRow) })
    } catch (err) {
      log.error('GET execution:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.put('/api/v1/executions/:id/stop', async (req, res) => {
    try {
      const n8n = await cds.connect.to('n8n')
      const result = await n8n.send('stopExecution', { id: req.params.id })
      res.json({ data: result })
    } catch (err) {
      res.status(err.status || err.statusCode || 500).json({ message: err.message || String(err) })
    }
  })

  router.delete('/api/v1/executions/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(DELETE.from(EX_ENTITY).where({ ID: req.params.id }))
      res.json({})
    } catch (err) {
      log.error('DELETE execution:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  // ── /rest/workflows (UI-facing CRUD) ────────────────────────────────────────
  // Real n8n UI uses /rest/workflows for all workflow operations, not /api/v1/workflows.
  // List returns summary (no nodes/connections); individual GET/POST/PUT return full shape.

  router.get('/rest/workflows', async (_req, res) => {
    try {
      const db = await cds.connect.to('db')
      const rows = await db.run(SELECT.from(WF_ENTITY))
      res.json({ count: rows.length, data: rows.map(r => rowToWorkflow(r, { includeNodes: false })) })
    } catch (err) {
      log.error('GET /rest/workflows:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.post('/rest/workflows', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const body = req.body ?? {}
      const now = new Date().toISOString()

      // If the UI sends an existing id, update rather than insert
      if (body.id) {
        const existing = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: body.id }))
        if (existing) {
          const versionId = cds.utils.uuid()
          await db.run(UPDATE(WF_ENTITY).set({
            name: body.name ?? existing.name,
            active: body.active ?? existing.active,
            nodes: JSON.stringify(body.nodes ?? []),
            connections: JSON.stringify(body.connections ?? {}),
            settings: JSON.stringify(body.settings ?? { executionOrder: 'v1' }),
            staticData: body.staticData ? JSON.stringify(body.staticData) : null,
            pinData: body.pinData ? JSON.stringify(body.pinData) : null,
            versionId,
          }).where({ ID: body.id }))
          const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: body.id }))
          return res.json({ data: rowToWorkflow(row) })
        }
      }

      const id = body.id ?? cds.utils.uuid()
      const versionId = cds.utils.uuid()
      const row = {
        ID: id,
        name: body.name ?? 'My workflow',
        active: body.active ?? false,
        nodes: JSON.stringify(body.nodes ?? []),
        connections: JSON.stringify(body.connections ?? {}),
        settings: JSON.stringify(body.settings ?? { executionOrder: 'v1' }),
        staticData: body.staticData ? JSON.stringify(body.staticData) : null,
        pinData: body.pinData ? JSON.stringify(body.pinData) : null,
        versionId,
        createdAt: now,
        updatedAt: now,
      }
      await db.run(INSERT.into(WF_ENTITY).entries(row))
      res.status(201).json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('POST /rest/workflows:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.get('/rest/workflows/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('GET /rest/workflows/:id:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.put('/rest/workflows/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const body = req.body ?? {}
      const existing = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!existing) return res.status(404).json({ message: 'Not found' })
      const versionId = cds.utils.uuid()
      const now = new Date().toISOString()
      await db.run(UPDATE(WF_ENTITY).set({
        name: body.name,
        active: body.active ?? false,
        nodes: JSON.stringify(body.nodes ?? []),
        connections: JSON.stringify(body.connections ?? {}),
        settings: JSON.stringify(body.settings ?? { executionOrder: 'v1' }),
        staticData: body.staticData ? JSON.stringify(body.staticData) : null,
        pinData: body.pinData ? JSON.stringify(body.pinData) : null,
        versionId,
        updatedAt: now,
        versionCounter: (existing.versionCounter ?? 1) + 1,
      }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('PUT /rest/workflows/:id:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.patch('/rest/workflows/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const body = req.body ?? {}
      const existing = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!existing) return res.status(404).json({ message: 'Not found' })
      const versionId = cds.utils.uuid()
      const now = new Date().toISOString()
      const updateFields = { versionId, updatedAt: now, versionCounter: (existing.versionCounter ?? 1) + 1 }
      if (body.name !== undefined)        updateFields.name = body.name
      if (body.active !== undefined)      updateFields.active = body.active
      if (body.nodes !== undefined)       updateFields.nodes = JSON.stringify(body.nodes)
      if (body.connections !== undefined) updateFields.connections = JSON.stringify(body.connections)
      if (body.settings !== undefined)    updateFields.settings = JSON.stringify(body.settings)
      if (body.staticData !== undefined)  updateFields.staticData = body.staticData ? JSON.stringify(body.staticData) : null
      if (body.pinData !== undefined)     updateFields.pinData = body.pinData ? JSON.stringify(body.pinData) : null
      await db.run(UPDATE(WF_ENTITY).set(updateFields).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      log.error('PATCH /rest/workflows/:id:', err.message)
      res.status(500).json({ message: err.message })
    }
  })

  router.patch('/rest/workflows/:id/activate', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(UPDATE(WF_ENTITY).set({ active: true }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // Real n8n UI also uses POST /:workflowId/activate  (not just PATCH)
  router.post('/rest/workflows/:id/activate', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(UPDATE(WF_ENTITY).set({ active: true }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  router.patch('/rest/workflows/:id/deactivate', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(UPDATE(WF_ENTITY).set({ active: false }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // Real n8n UI also uses POST /:workflowId/deactivate  (not just PATCH)
  router.post('/rest/workflows/:id/deactivate', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(UPDATE(WF_ENTITY).set({ active: false }).where({ ID: req.params.id }))
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // ── /rest/workflows/:id/run — trigger manual execution ─────────────────────
  router.post('/rest/workflows/:id/run', async (req, res) => {
    try {
      const n8n = await cds.connect.to('n8n')
      log.info('POST /rest/workflows/:id/run body:', JSON.stringify(req.body ?? {}))
      const { inputData, destinationNode, startNodes, runData: reqRunData, pinData: runPinData } = req.body ?? {}

      // destinationNode: { nodeName, mode } — mode is 'inclusive' (run the node) or 'exclusive' (stop before it)
      const destNodeName = destinationNode?.nodeName ?? (typeof destinationNode === 'string' ? destinationNode : null)
      const destMode     = destinationNode?.mode ?? 'exclusive'

      // startNodes arrives as [{ name, sourceData }] objects or plain strings
      const startNodeNames = startNodes?.length
        ? startNodes.map(n => n.name ?? n.id ?? n).filter(Boolean)
        : undefined

      const payload = { workflowId: req.params.id, data: JSON.stringify(inputData ?? {}) }
      if (destNodeName) payload.destinationNode = destNodeName
      if (destNodeName) payload.destinationMode = destMode
      if (startNodeNames?.length) payload.startNodeIds = JSON.stringify(startNodeNames)
      if (reqRunData && Object.keys(reqRunData).length) payload.runData = JSON.stringify(reqRunData)
      if (runPinData && Object.keys(runPinData).length) payload.pinData = JSON.stringify(runPinData)

      const result = await n8n.send('triggerWorkflow', payload)
      res.json({ data: { executionId: result.executionId } })
    } catch (err) {
      const status = err.status || err.statusCode || 500
      const message = err.message || String(err.code || 'Internal error')
      log.error('POST /rest/workflows/:id/run:', message)
      res.status(status).json({ message })
    }
  })

  // ── Shared chat output extractor ─────────────────────────────────────────────
  // Reads nodeOutputs, finds the respondToWebhook node (or last node), and
  // returns the first item's output/text/message field as a string.
  async function _extractChatOutput(nodeOutputs, workflowId) {
    if (!nodeOutputs) return ''
    const db = await cds.connect.to('db')
    const wfRow = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: workflowId }))
    const wfNodes = parseJson(wfRow?.nodes, [])
    const nodeTypeMap = Object.fromEntries(wfNodes.map(n => [n.name, n.type]))
    const respondNodeName = Object.keys(nodeOutputs).find(
      name => nodeTypeMap[name] === 'n8n-nodes-base.respondToWebhook'
        || nodeTypeMap[name] === '@n8n/n8n-nodes-langchain.chat'
    )
    const nodeNames = Object.keys(nodeOutputs)
    const targetNodeName = respondNodeName ?? nodeNames[nodeNames.length - 1]
    const targetNode = targetNodeName ? nodeOutputs[targetNodeName] : null
    const taskDataArr = Array.isArray(targetNode) ? targetNode : (targetNode ? [targetNode] : [])
    const items = taskDataArr[0]?.data?.main?.[0] ?? taskDataArr[0] ?? []
    const firstItem = (Array.isArray(items) ? items[0] : items)?.json ?? (Array.isArray(items) ? items[0] : items) ?? {}
    let outputText = firstItem.output ?? firstItem.text ?? firstItem.message ?? firstItem.chatInput ?? ''
    if (!outputText && Object.keys(firstItem).length > 0) {
      // No known field — find the first string value in the item (e.g. { table: "..." })
      const firstStringVal = Object.values(firstItem).find(v => typeof v === 'string' && v.length > 0)
      outputText = firstStringVal ?? JSON.stringify(firstItem)
    }
    return outputText
  }

  // ── /webhook-test/:webhookId/chat — Chat Trigger test endpoint ─────────────
  // The n8n editor canvas chat panel POSTs here with:
  //   { action: "sendMessage", chatInput: "...", sessionId: "..." }
  // We find the workflow, trigger it synchronously, and return the output
  // directly in the response body as { output: "..." }.
  // The @n8n/chat library reads response.output ?? response.text ?? response.message.
  //
  // The @n8n/chat widget sends to /webhook-test/{webhookId}/{sessionId} (two segments).
  // Register both patterns so either URL works.
  async function handleChatTriggerPost(req, res) {
    try {
      const { webhookId, sessionId: paramSessionId } = req.params
      const body = req.body ?? {}
      const { action, chatInput, sessionId: bodySessionId } = body

      if (action && action !== 'sendMessage') {
        return res.status(400).json({ message: `Unsupported chat action: ${action}` })
      }

      // Find the workflow — the canvas sends the workflow ID as the first path segment;
      // production webhooks send the chatTrigger node's webhookId. Try both.
      const db = await cds.connect.to('db')
      const workflows = await db.run(SELECT.from(WF_ENTITY).columns('ID', 'nodes'))
      let workflowId
      // 1. direct workflow ID match (canvas chat panel)
      if (workflows.find(wf => wf.ID === webhookId)) {
        workflowId = webhookId
      }
      // 2. node webhookId scan (production / external triggers)
      if (!workflowId) {
        for (const wf of workflows) {
          const nodes = parseJson(wf.nodes, [])
          const found = nodes.find(n =>
            n.type === '@n8n/n8n-nodes-langchain.chatTrigger' && n.webhookId === webhookId
          )
          if (found) { workflowId = wf.ID; break }
        }
      }

      if (!workflowId) {
        return res.status(404).json({ message: `No workflow found with chatTrigger webhookId "${webhookId}"` })
      }

      const n8n = await cds.connect.to('n8n')
      const sid = paramSessionId ?? bodySessionId ?? cds.utils.uuid()

      // Trigger the workflow
      const triggerResult = await n8n.send('triggerWorkflow', {
        workflowId,
        data: JSON.stringify({ chatInput, sessionId: sid }),
      })

      const { executionId } = triggerResult

      // Now await the actual completion
      let outputText = ''
      try {
        const completion = await n8n.send('awaitExecution', { id: executionId, timeoutMs: 60000 })
        const result = typeof completion === 'string' ? JSON.parse(completion) : completion
        outputText = await _extractChatOutput(result?.nodeOutputs, workflowId)
      } catch (e) {
        log.warn(`Chat trigger: execution ${executionId} await failed: ${e.message}`)
        outputText = `(workflow error: ${e.message})`
      }

      // Return the text as the HTTP response — @n8n/chat reads output ?? text ?? message
      res.json({ output: outputText, sessionId: sid, executionId })
    } catch (err) {
      log.error('POST /webhook-test/:webhookId/chat:', err.message)
      res.status(500).json({ message: err.message })
    }
  }

  router.post('/webhook-test/:webhookId/chat', handleChatTriggerPost)
  router.post('/webhook-test/:webhookId/:sessionId', handleChatTriggerPost)

  // ── /chat/conversations/manual/:workflowId/send ────────────────────────────
  // Called by the n8n chatHub canvas panel when a workflow has a chatTrigger node.
  // Payload: { messageId, sessionId, message, previousMessageId, agentName, timeZone }
  // Response is delivered via SSE push events (chatHub* types), not the HTTP body.
  router.post('/chat/conversations/manual/:workflowId/send', async (req, res) => {
    try {
      const { workflowId } = req.params
      const body = req.body ?? {}
      const { messageId, sessionId, message } = body
      const sid = sessionId ?? cds.utils.uuid()
      const respMessageId = cds.utils.uuid()

      // ACK immediately — response comes via SSE push
      res.json({ sessionId: sid })

      const n8n = await cds.connect.to('n8n')
      const triggerResult = await n8n.send('triggerWorkflow', {
        workflowId,
        data: JSON.stringify({ chatInput: message, sessionId: sid }),
      }).catch(err => { log.error('chat manual send trigger failed:', err.message); return null })

      if (!triggerResult) return

      const { executionId } = triggerResult

      // Signal stream start
      cds.emit('n8n.push', { type: 'chatHubExecutionBegin', data: { sessionId: sid } })
      cds.emit('n8n.push', {
        type: 'chatHubStreamBegin',
        data: { sessionId: sid, messageId: respMessageId, sequenceNumber: 0, previousMessageId: messageId ?? null },
      })

      // Await execution and stream the output
      let outputText = ''
      try {
        const completion = await n8n.send('awaitExecution', { id: executionId, timeoutMs: 60000 })
        const result = typeof completion === 'string' ? JSON.parse(completion) : completion
        outputText = await _extractChatOutput(result?.nodeOutputs, workflowId)
      } catch (e) {
        log.warn(`chat manual send: execution ${executionId} failed: ${e.message}`)
        cds.emit('n8n.push', { type: 'chatHubStreamError', data: { sessionId: sid, messageId: respMessageId, error: e.message } })
        cds.emit('n8n.push', { type: 'chatHubExecutionEnd', data: { sessionId: sid, status: 'error' } })
        return
      }

      cds.emit('n8n.push', {
        type: 'chatHubStreamChunk',
        data: { sessionId: sid, messageId: respMessageId, sequenceNumber: 1, content: outputText },
      })
      cds.emit('n8n.push', {
        type: 'chatHubStreamEnd',
        data: { sessionId: sid, messageId: respMessageId, status: 'success' },
      })
      cds.emit('n8n.push', { type: 'chatHubExecutionEnd', data: { sessionId: sid, status: 'success' } })
    } catch (err) {
      log.error('POST /chat/conversations/manual/:workflowId/send:', err.message)
      if (!res.headersSent) res.status(500).json({ message: err.message })
    }
  })

  // ── /chat/conversations/send ───────────────────────────────────────────────
  // Production chatHub mode. Payload includes model.workflowId.
  router.post('/chat/conversations/send', async (req, res) => {
    try {
      const body = req.body ?? {}
      const { model, messageId, sessionId, message } = body
      const workflowId = model?.workflowId
      if (!workflowId) return res.status(400).json({ message: 'model.workflowId is required' })
      const sid = sessionId ?? cds.utils.uuid()
      const respMessageId = cds.utils.uuid()

      res.json({ sessionId: sid })

      const n8n = await cds.connect.to('n8n')
      const triggerResult = await n8n.send('triggerWorkflow', {
        workflowId,
        data: JSON.stringify({ chatInput: message, sessionId: sid }),
      }).catch(err => { log.error('chat send trigger failed:', err.message); return null })

      if (!triggerResult) return

      const { executionId } = triggerResult

      cds.emit('n8n.push', { type: 'chatHubExecutionBegin', data: { sessionId: sid } })
      cds.emit('n8n.push', {
        type: 'chatHubStreamBegin',
        data: { sessionId: sid, messageId: respMessageId, sequenceNumber: 0, previousMessageId: messageId ?? null },
      })

      let outputText = ''
      try {
        const completion = await n8n.send('awaitExecution', { id: executionId, timeoutMs: 60000 })
        const result = typeof completion === 'string' ? JSON.parse(completion) : completion
        outputText = await _extractChatOutput(result?.nodeOutputs, workflowId)
      } catch (e) {
        log.warn(`chat send: execution ${executionId} failed: ${e.message}`)
        cds.emit('n8n.push', { type: 'chatHubStreamError', data: { sessionId: sid, messageId: respMessageId, error: e.message } })
        cds.emit('n8n.push', { type: 'chatHubExecutionEnd', data: { sessionId: sid, status: 'error' } })
        return
      }

      cds.emit('n8n.push', {
        type: 'chatHubStreamChunk',
        data: { sessionId: sid, messageId: respMessageId, sequenceNumber: 1, content: outputText },
      })
      cds.emit('n8n.push', {
        type: 'chatHubStreamEnd',
        data: { sessionId: sid, messageId: respMessageId, status: 'success' },
      })
      cds.emit('n8n.push', { type: 'chatHubExecutionEnd', data: { sessionId: sid, status: 'success' } })
    } catch (err) {
      log.error('POST /chat/conversations/send:', err.message)
      if (!res.headersSent) res.status(500).json({ message: err.message })
    }
  })

  // ── /chat/conversations/:sessionId — stub ──────────────────────────────────
  router.get('/chat/conversations/:sessionId', (_req, res) => { res.json({ data: null }) })
  router.delete('/chat/conversations/:sessionId', (_req, res) => { res.json({ data: {} }) })

  // ── /rest/executions — UI execution list/details ────────────────────────────
  router.get('/rest/executions', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const filter = req.query.filter ? JSON.parse(req.query.filter) : {}
      let query = SELECT.from(EX_ENTITY)
      if (filter.workflowId) query = query.where({ workflow_ID: filter.workflowId })
      const rows = await db.run(query)
      // Real n8n returns { data: { results, count, estimated, concurrentExecutionsCount } }
      res.json({
        data: {
          results: rows.map(row => rowToExecution(row)),
          count: rows.length,
          estimated: false,
          concurrentExecutionsCount: -1,
        },
      })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  router.get('/rest/executions/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(EX_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      const [steps, wfRow] = await Promise.all([
        db.run(SELECT.from(STEP_ENTITY).where({ executionID: req.params.id }).orderBy('executedAt asc', 'runIndex asc')),
        row.workflow_ID ? db.run(SELECT.one.from(WF_ENTITY).where({ ID: row.workflow_ID })) : null,
      ])
      res.json({ data: rowToExecution(row, steps, wfRow) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // ── /rest/workflows/:id/collaboration/write-lock ───────────────────────────
  // The UI requests this when opening a workflow editor. Return a stub indicating
  // no active writer (so the current user gets the write lock immediately).
  router.get('/rest/workflows/:id/collaboration/write-lock', (_req, res) => {
    res.json({ data: null })
  })

  // ── /rest/workflows/:id/archive + /unarchive ─────────────────────────────
  // Archive/unarchive are enterprise features — stub with 200 so the UI
  // doesn't crash if it calls them.
  router.post('/rest/workflows/:id/archive', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  router.post('/rest/workflows/:id/unarchive', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      if (!row) return res.status(404).json({ message: 'Not found' })
      res.json({ data: rowToWorkflow(row) })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // ── /rest/executions/:id/retry ─────────────────────────────────────────────
  // Stub — retry is not supported in the CAP-native runner, return error.
  router.post('/rest/executions/:id/retry', (_req, res) => {
    res.status(501).json({ message: 'Retry is not supported in CAP-native mode' })
  })

  // n8n UI uses POST /rest/executions/:id/stop to cancel a running execution
  router.post('/rest/executions/:id/stop', async (req, res) => {
    try {
      const n8n = await cds.connect.to('n8n')
      const result = await n8n.send('stopExecution', { id: req.params.id })
      res.json({ data: result })
    } catch (err) {
      res.status(err.status || err.statusCode || 500).json({ message: err.message || String(err) })
    }
  })

  // ── /rest/executions/:id (DELETE) ─────────────────────────────────────────
  router.delete('/rest/executions/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      await db.run(DELETE.from(EX_ENTITY).where({ ID: req.params.id }))
      res.json({ data: {} })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // ── /rest/workflows/:id/exists ─────────────────────────────────────────────
  router.get('/rest/workflows/:id/exists', async (req, res) => {
    try {
      const db = await cds.connect.to('db')
      const row = await db.run(SELECT.one.from(WF_ENTITY).where({ ID: req.params.id }))
      res.json({ data: { exists: row != null } })
    } catch (err) {
      res.status(500).json({ message: err.message })
    }
  })

  // ── /rest/projects ─────────────────────────────────────────────────────────
  // All scopes granted — CAP manages auth; we give the UI full owner permissions
  // so canCreateWorkflow / projectPermissions.workflow.create evaluates to true.
  const ALL_SCOPES = [
    'agent:create','agent:delete','agent:execute','agent:list','agent:manage',
    'agent:publish','agent:read','agent:unpublish','agent:update',
    'aiAssistant:manage',
    'annotationTag:create','annotationTag:delete','annotationTag:list','annotationTag:read','annotationTag:update',
    'apiKey:create','apiKey:delete','apiKey:list','apiKey:manage','apiKey:update',
    'auditLogs:manage','banner:dismiss','breakingChanges:list',
    'chatHub:manage','chatHub:message',
    'chatHubAgent:create','chatHubAgent:delete','chatHubAgent:list','chatHubAgent:read','chatHubAgent:update',
    'community:register',
    'communityPackage:install','communityPackage:list','communityPackage:uninstall','communityPackage:update',
    'credential:connect','credential:create','credential:createEndUser','credential:delete',
    'credential:list','credential:manageInstance','credential:move','credential:read',
    'credential:share','credential:shareGlobally','credential:unshare','credential:update',
    'credentialResolver:create','credentialResolver:delete','credentialResolver:list',
    'credentialResolver:read','credentialResolver:update',
    'dataTable:create','dataTable:delete','dataTable:list','dataTable:listProject',
    'dataTable:read','dataTable:readColumn','dataTable:readRow','dataTable:update',
    'dataTable:writeColumn','dataTable:writeRow',
    'encryptionKey:manage',
    'eventBusDestination:create','eventBusDestination:delete','eventBusDestination:list',
    'eventBusDestination:read','eventBusDestination:test','eventBusDestination:update',
    'execution:reveal',
    'externalSecret:list',
    'externalSecretsProvider:create','externalSecretsProvider:delete','externalSecretsProvider:list',
    'externalSecretsProvider:read','externalSecretsProvider:sync','externalSecretsProvider:update',
    'folder:create','folder:delete','folder:list','folder:move','folder:read','folder:update',
    'insights:list','insights:read',
    'instanceAi:eval','instanceAi:gateway','instanceAi:manage','instanceAi:message',
    'ldap:manage','ldap:sync','license:manage','logStreaming:manage',
    'mcp:manage','mcp:oauth','mcpApiKey:create','mcpApiKey:rotate',
    'oidc:manage','orchestration:read','otel:manage',
    'project:create','project:delete','project:export','project:list','project:read','project:update',
    'projectVariable:create','projectVariable:delete','projectVariable:list',
    'projectVariable:read','projectVariable:update',
    'provisioning:manage',
    'role:manage','role:read',
    'roleMappingRule:create','roleMappingRule:delete','roleMappingRule:list',
    'roleMappingRule:read','roleMappingRule:update',
    'saml:manage','securityAudit:generate','securitySettings:manage',
    'sourceControl:manage','sourceControl:pull','sourceControl:push',
    'tag:create','tag:delete','tag:list','tag:read','tag:update',
    'user:changeRole','user:create','user:delete','user:enforceMfa',
    'user:generateInviteLink','user:list','user:read','user:resetPassword','user:update',
    'variable:create','variable:delete','variable:list','variable:read','variable:update',
    'workersView:manage',
    'workflow:create','workflow:delete','workflow:disableRedaction','workflow:enableRedaction',
    'workflow:execute','workflow:execute-chat','workflow:export','workflow:import',
    'workflow:list','workflow:move','workflow:publish','workflow:read',
    'workflow:share','workflow:unpublish','workflow:unshare','workflow:update',
  ]

  const PERSONAL_PROJECT = {
    id: 'personal',
    name: 'Personal',
    type: 'personal',
    icon: null,
    description: null,
    customTelemetryTags: [],
    creatorId: 'cap-ai-owner',
    role: 'project:personalOwner',
    scopes: ALL_SCOPES,
    rolesManaged: false,
  }

  const PERSONAL_PROJECT_FULL = {
    ...PERSONAL_PROJECT,
    projectRelations: [{
      userId: 'cap-ai-owner',
      projectId: 'personal',
      role: {
        slug: 'project:personalOwner',
        displayName: 'Project Owner',
        description: 'Project Owner',
        systemRole: true,
        roleType: 'project',
        scopes: ALL_SCOPES.map(s => ({ slug: s, displayName: s, description: null })),
      },
    }],
  }

  router.get('/rest/projects', (_req, res) => {
    res.json({ data: [PERSONAL_PROJECT], count: 1 })
  })

  // Q() extracts .data, so wrap the array
  router.get('/rest/projects/my-projects', (_req, res) => {
    res.json({ data: [PERSONAL_PROJECT] })
  })

  // Q() extracts .data
  router.get('/rest/projects/personal', (_req, res) => {
    res.json({ data: PERSONAL_PROJECT_FULL })
  })

  // Must be before /:id
  router.get('/rest/projects/count', (_req, res) => {
    res.json({ personal: 1, team: 0 })
  })

  router.get('/rest/projects/:id/roles', (_req, res) => {
    res.json({ data: [] })
  })

  router.get('/rest/projects/:id', (req, res) => {
    res.json({ data: { ...PERSONAL_PROJECT_FULL, id: req.params.id } })
  })

  // ── /rest/roles ─────────────────────────────────────────────────────────────
  router.get('/rest/roles', (_req, res) => {
    res.json({ data: [] })
  })

  // ── /rest/community-packages ────────────────────────────────────────────────
  router.get('/rest/community-packages', (_req, res) => {
    res.json({ data: [] })
  })

  function serveIndex(_req, res) {
    const indexFile = path.join(staticDir, 'index.html')
    if (!fs.existsSync(indexFile)) {
      return res.status(404).send('n8n static files not found.')
    }
    res.setHeader('Content-Type', 'text/html')
    res.send(fs.readFileSync(indexFile, 'utf-8'))
  }

  // Log any /rest/* requests that reach here unhandled — helps diagnose mystery nodes
  router.use('/rest', (req, _res, next) => {
    log.info(`UNHANDLED REST: ${req.method} ${req.path}`)
    next()
  })

  return { router, staticDir, publicPath, serveIndex }
}

/**
 * Mount the n8n adapter on the CDS Express app.
 * Convenience wrapper around buildN8nRouter for direct use.
 *
 * @param {import('express').Application} app
 * @param {{ publicPath?: string, staticDir?: string }} [cfg]
 */
export function mountN8nAdapter(app, cfg = {}) {
  const { router, staticDir, publicPath, serveIndex } = buildN8nRouter(cfg)

  // IMPORTANT: mount at publicPath (e.g. /n8n) so that the n8n UI's requests
  // to /n8n/rest/settings and /n8n/api/v1/workflows are matched here.
  app.use(publicPath, router)

  // /healthz — root-level heartbeat (n8n UI polls this every few seconds)
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }))

  app.get(publicPath, serveIndex)
  app.get(publicPath + '/', serveIndex)

  // Static assets (after API routes so /n8n/rest/* doesn't accidentally match)
  app.use(publicPath, express.static(staticDir, { index: false }))

  // SPA fallback
  app.use(publicPath + '/*path', serveIndex)

  log.info(`n8n adapter mounted — editor UI at ${publicPath}/`)
}

/**
 * Mount only the static files, SPA fallback and /healthz on the Express app.
 * The REST API router is mounted separately by the protocol adapter.
 * This must be called AFTER protocols.serve() so the API routes take priority.
 *
 * @param {import('express').Application} app
 * @param {{ publicPath?: string, staticDir?: string }} [cfg]
 */
export function mountN8nStatic(app, cfg = {}) {
  const publicPath = (cfg.publicPath ?? '/n8n').replace(/\/$/, '')
  const staticDir  = resolveStaticDir(cfg)

  function serveIndex(_req, res) {
    const indexFile = path.join(staticDir, 'index.html')
    if (!fs.existsSync(indexFile)) return res.status(404).send('n8n static files not found.')
    res.setHeader('Content-Type', 'text/html')
    res.send(fs.readFileSync(indexFile, 'utf-8'))
  }

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }))
  app.get(publicPath, serveIndex)
  app.get(publicPath + '/', serveIndex)
  app.use(publicPath, express.static(staticDir, { index: false }))
  app.use(publicPath + '/*path', serveIndex)

  log.info(`n8n static UI mounted at ${publicPath}/`)
}


const { SELECT, INSERT, UPDATE, DELETE } = cds.ql
