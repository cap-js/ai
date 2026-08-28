# n8n Workflow Execution — Test Guidelines

Target audience: developer or test management team writing tests for the `@cap-js/ai` n8n plugin.

---

## Architecture recap

The plugin embeds n8n workflow execution directly inside the CAP process. The n8n UI is only a visual designer — no n8n server runs. Workflow definitions are stored as rows in `cap.ai.n8n.WorkflowDefinitions`, executions are tracked in `cap.ai.n8n.WorkflowExecutions`, and per-node results land in `cap.ai.n8n.WorkflowStepResults`. The public surface for tests is the REST API mounted at `/n8n`.

---

## 1. Test setup

### Bootstrapping

Every n8n test file uses exactly one `cds.test()` instance pointed at the bookshop test app:

```js
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Starts the full CAP server against the test bookshop.
// { GET, POST } are pre-configured Axios instances with the base URL set.
const { GET, POST } = cds.test(path.join(__dirname, 'bookshop'))
```

`cds.test()` boots the server once for the entire `describe` block, tears it down after. Do not call it more than once per file.

### LLM mocking

For any workflow that exercises a LangChain AI node (`chainLlm`, `textClassifier`, `sentimentAnalysis`, `informationExtractor`, `guardrails`, `agent`) or a CAP custom AI node (`CUSTOM.capAiAgent`, `CUSTOM.capAiClassify`, `CUSTOM.capAiExtract`), configure the `llm-mock` kind provided by `@cap-js/agents`.

Add to the bookshop's `package.json` under `cds.requires`, or override per-test file via `cds.test(...).in(...).with(...)`:

```js
// In tests/bookshop/package.json — cds.requires section:
{
  "cds": {
    "requires": {
      "n8n": "n8n",
      "llm": { "kind": "llm-mock" }
    }
  }
}
```

The `llm-mock` kind is defined in `@cap-js/agents`:

```
"llm-mock": { "impl": "@cap-js/agents/lib/models/mock" }
```

The mock returns a deterministic static string for every invocation unless `options.message` is set:

```
[Mock LLM] This is a mocked response from @cap-js/agents development mode. No real LLM was invoked.
```

When the mock is wired to a tool-calling node (e.g. `agent`) and a `query` tool is registered, the first call returns a tool-call message; the second call (with the tool result) returns the plain static string. Because responses are deterministic, tests can `assert.strictEqual` the exact output text.

### Pre-seeded workflows

The file `tests/bookshop/db/data/cap.ai.n8n-WorkflowDefinitions.csv` is deployed automatically on every `cds.test()` boot. These workflows are always available — do not create or delete them inside tests.

---

## 2. Public API endpoints

**Never call `N8nService` methods directly.** All tests go through the HTTP layer. The adapter is mounted at `/n8n`:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/n8n/api/v1/workflows/:id/run` | Trigger a workflow — returns `{ data: { executionId } }` |
| `GET`  | `/n8n/api/v1/executions/:id` | Poll execution — returns `{ data: { status, finished, data, ... } }` |
| `GET`  | `/n8n/api/v1/workflows` | List all workflow definitions |
| `GET`  | `/n8n/api/v1/workflows/:id` | Fetch a single workflow definition |

`POST /run` returns immediately with an `executionId`. The execution runs asynchronously in the same process. Poll `GET /executions/:id` until `data.status` is `"success"` or `"error"`.

The `data.data` field on the execution response is a `flatted`-encoded string (n8n's own circular-safe serialiser). To read node outputs in tests, decode it:

```js
import { parse as flattedParse } from 'flatted'

const exec = await GET(`/n8n/api/v1/executions/${executionId}`)
const execData = flattedParse(exec.data.data.data)
// execData.resultData.runData["NodeName"][0].data.main[0]  →  array of items
```

---

## 3. `runWorkflow` test helper

All test files should share this helper. Place it in `tests/helpers/n8n.js` (create this once):

```js
// tests/helpers/n8n.js
import { parse as flattedParse } from 'flatted'

const POLL_RETRIES   = 10
const POLL_INTERVAL  = 500   // ms

/**
 * Trigger a workflow and poll until it finishes.
 *
 * @param {string}   workflowId  - Stable ID from the CSV (e.g. 'wf-set-001')
 * @param {object}   inputData   - JSON payload forwarded as the trigger's input items
 * @param {{ GET, POST }} http   - Destructured from cds.test()
 * @returns {Promise<{ status: string, runData: object, raw: object }>}
 *   status  — 'success' | 'error'
 *   runData — decoded resultData.runData ({ NodeName: [TaskData, ...] })
 *   raw     — full decoded execution data object
 */
export async function runWorkflow(workflowId, inputData, { GET, POST }) {
  // 1. Trigger
  const trigger = await POST(`/n8n/api/v1/workflows/${workflowId}/run`, inputData)
  assert.equal(trigger.status, 200, `Trigger failed: ${JSON.stringify(trigger.data)}`)
  const { executionId } = trigger.data.data

  // 2. Poll
  for (let i = 0; i < POLL_RETRIES; i++) {
    const poll = await GET(`/n8n/api/v1/executions/${executionId}`)
    const exec = poll.data.data

    if (exec.status === 'success' || exec.status === 'error') {
      const raw = flattedParse(exec.data)
      return {
        status:  exec.status,
        runData: raw.resultData?.runData ?? {},
        raw,
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }

  throw new Error(`Execution ${executionId} did not finish within ${POLL_RETRIES * POLL_INTERVAL}ms`)
}

/** Extract the first item's JSON from a named node in runData. */
export function firstItem(runData, nodeName) {
  return runData[nodeName]?.[0]?.data?.main?.[0]?.[0]?.json ?? null
}

/** Extract all items (port 0) from a named node in runData. */
export function allItems(runData, nodeName) {
  return runData[nodeName]?.[0]?.data?.main?.[0] ?? []
}
```

Usage:

```js
import { runWorkflow, firstItem } from '../helpers/n8n.js'

const { status, runData } = await runWorkflow('wf-set-001', {}, { GET, POST })
assert.equal(status, 'success')
assert.equal(firstItem(runData, 'Assign').greeting, 'hello')
```

---

## 4. Pre-seeded workflow IDs

All IDs below exist in `tests/bookshop/db/data/cap.ai.n8n-WorkflowDefinitions.csv`.

### Flow control

| ID | Name | Tests |
|----|------|-------|
| `wf-passthrough-001` | Test: Manual Trigger passthrough | ManualTrigger node passes input through unchanged |
| `wf-if-001` | Test: If node routes by value | If node routes to `True` branch when `value > 10`, `False` otherwise |
| `wf-switch-001` | Test: Switch routes to correct output | Switch on `color` field routes to named outputs `Red` / `Blue` |
| `wf-stoponerror-001` | Test: StopAndError throws on condition | Execution ends with `status: "error"` when StopAndError node fires |
| `wf-error-trigger-001` | Test: ErrorTrigger wraps error context | ErrorTrigger node sets `hasError: true` from the error context |
| `wf-execute-workflow-001` | Test: ExecuteWorkflow calls sub-workflow | Calls `wf-set-001` as a sub-workflow; result contains `greeting: "hello"` |
| `wf-splitinbatches-001` | Test: SplitInBatches processes items in groups | Loops 5 items in batches of 2; all items get `processed: true` |

### Data transformation

| ID | Name | Tests |
|----|------|-------|
| `wf-set-001` | Test: Set node assigns fields | Set node writes `greeting: "hello"` and `count: 42` |
| `wf-code-001` | Test: Code node transforms items | Code node doubles `value` field (`doubled = value * 2`) |
| `wf-code-noreturn-001` | Test: Code node null return passes through | Code with no `return` statement passes input through unchanged |
| `wf-filter-001` | Test: Filter node keeps matching items | Filter keeps only items where `active === true` |
| `wf-sort-001` | Test: Sort node orders items | Sort orders items by `score` descending |
| `wf-limit-001` | Test: Limit node caps output | Limit caps output at 2 items regardless of input length |
| `wf-splitout-001` | Test: SplitOut expands array field | SplitOut explodes `tags` array into individual items |
| `wf-merge-001` | Test: Merge combines two branches | Merge (append mode) combines BranchA and BranchB; 2 items total |
| `wf-summarize-001` | Test: Summarize aggregates items | Summarize produces `sum(amount)` over input items |
| `wf-removeduplicates-001` | Test: RemoveDuplicates deduplicates by field | RemoveDuplicates on `id` field removes duplicate rows |
| `wf-compare-001` | Test: CompareDatasets finds added items | CompareDatasets identifies added/removed items between two inputs |
| `wf-datetime-001` | Test: DateTime formats a timestamp | DateTime converts `ts` field to a formatted date string |
| `wf-markdown-001` | Test: Markdown converts to HTML | Markdown node converts `md` field to `html` |
| `wf-xml-001` | Test: XML converts JSON to XML | XML node converts `data` field to XML string |

### CAP entity nodes

| ID | Name | Tests |
|----|------|-------|
| `wf-cap-entity-list-001` | Test: CAP Entity list Books | `CUSTOM.capEntity` list on `CatalogService.Books`; returns up to 3 rows with `ID` and `title` |
| `wf-cap-entity-get-001` | Test: CAP Entity get single Book | `CUSTOM.capEntity` get on `CatalogService.Books` key `201`; returns the matching book |
| `wf-cap-entity-filter-001` | Test: CAP Entity list with filter and orderBy | `CUSTOM.capEntity` list with `stock > 0`, ordered by `title asc`; pushes filter and order to DB |
| `wf-cap-entity-create-001` | Test: CAP Entity create Book | `CUSTOM.capEntity` create on `AdminService.Books`; input: `{ id, title, author_ID, stock }` |
| `wf-cap-entity-update-001` | Test: CAP Entity update Book stock | `CUSTOM.capEntity` update on `AdminService.Books`; input: `{ id, stock }`; patches the stock field |
| `wf-cap-entity-delete-001` | Test: CAP Entity delete Book | Creates book `ID=9901` then deletes it; final node output is empty (delete returns no data) |
| `wf-cap-entity-composed-key-001` | Test: CAP Entity get by composed key | `CUSTOM.capEntity` get on `CatalogService.BooksWithComposedKey` key `{key1:1, key2:2}`; returns "The Murders in the Rue Morgue" |
| `wf-cap-entity-custom-key-001` | Test: CAP Entity get by custom key field | `CUSTOM.capEntity` get on `CatalogService.BooksWithCustomKey` key `501`; returns "Agnes Grey" |

### CAP CQL node

| ID | Name | Tests |
|----|------|-------|
| `wf-cap-cql-select-001` | Test: CAP CQL basic SELECT | `CUSTOM.capCql` SELECT with ORDER BY; returns all books ordered by ID ascending |
| `wf-cap-cql-params-001` | Test: CAP CQL SELECT with named params | `CUSTOM.capCql` with `:minStock` param; input: `{ minStock: 100 }`; returns only books with stock > minStock |
| `wf-cap-cql-join-001` | Test: CAP CQL SELECT with JOIN | `CUSTOM.capCql` JOIN query; returns rows with `ID`, `title`, `authorName` |

### CAP Action node

| ID | Name | Tests |
|----|------|-------|
| `wf-cap-action-001` | Test: CAP Action submitOrder | `CUSTOM.capAction` calls `CatalogService.submitOrder`; input: `{ book: 201, quantity: 1 }`; returns `{ stock }` |

### CAP LLM Provider + LangChain AI nodes

| ID | Name | Tests |
|----|------|-------|
| `wf-cap-chain-llm-001` | Test: CAP LLM Provider with chainLlm | `CUSTOM.capLlmProvider` wired to `chainLlm`; input: `{ prompt: 'hello' }`; returns text matching `/Mock LLM/` |
| `wf-cap-text-classifier-001` | Test: CAP LLM Provider with textClassifier | `CUSTOM.capLlmProvider` wired to `textClassifier` (categories: positive/negative); routes all items to first output (positive) via mock |
| `wf-cap-info-extractor-001` | Test: CAP LLM Provider with informationExtractor | `CUSTOM.capLlmProvider` wired to `informationExtractor` (fields: title, author); mock returns each field as the mock string |

### CAP AI executor nodes

| ID | Name | Tests |
|----|------|-------|
| `wf-cap-ai-classify-001` | Test: CAP AI Classify routes to category | `CUSTOM.capAiClassify` with categories fiction/poetry; mock routes to first category (`fiction`); item gains `_category: 'fiction'` |
| `wf-cap-ai-extract-001` | Test: CAP AI Extract structured fields from text | `CUSTOM.capAiExtract` extracts `title` (string) and `year` (number); mock sets both fields on the item |
| `wf-cap-ai-agent-001` | Test: CAP AI Agent with tool call loop | `CUSTOM.capAiAgent` with `getBooks` tool against `CatalogService`; input: `{ question: '...' }`; returns `agentResult` string |

### CAP Agent (A2A) node

| ID | Name | Tests |
|----|------|-------|
| `wf-cap-agent-001` | Test: CAP Agent A2A call | `CUSTOM.capAgent` calls `/a2a/assistant`; input: `{ message: 'list books' }`; routes to Response output |

---

## 5. Test structure guidelines

### One `cds.test()` per file

```
tests/
  n8n/
    flow-control.test.js      ← one cds.test() instance
    data-transform.test.js
    cap-entity.test.js
    llm-nodes.test.js
```

### Group by feature area

- `flow-control` — If, Switch, Merge, SplitInBatches, StopAndError, ExecuteWorkflow, ErrorTrigger
- `data-transform` — Set, Code, Filter, Limit, Sort, Summarize, RemoveDuplicates, SplitOut, CompareDatasets, DateTime, Markdown, XML
- `cap-entity` — CUSTOM.capEntity (list/get/filter), CUSTOM.capCql, CUSTOM.capAction
- `llm-nodes` — chainLlm, textClassifier, sentimentAnalysis, informationExtractor, guardrails, agent, CUSTOM.capAiClassify, CUSTOM.capAiExtract

### Assertion pattern

Every test must assert on both:

1. **Execution status** — `assert.equal(status, 'success')`
2. **Output items** — at least one field from the last meaningful node's output

```js
test('If node routes value > 10 to True branch', async () => {
  const { status, runData } = await runWorkflow(
    'wf-if-001',
    { value: 42 },
    { GET, POST }
  )
  assert.equal(status, 'success')
  assert.equal(firstItem(runData, 'True').result, 'true')
})

test('If node routes value <= 10 to False branch', async () => {
  const { status, runData } = await runWorkflow(
    'wf-if-001',
    { value: 5 },
    { GET, POST }
  )
  assert.equal(status, 'success')
  assert.equal(firstItem(runData, 'False').result, 'false')
})
```

### Error-path tests

When testing a workflow that is expected to fail (e.g. `wf-stoponerror-001`), assert `status === 'error'`:

```js
test('StopAndError produces status error', async () => {
  const { status } = await runWorkflow('wf-stoponerror-001', {}, { GET, POST })
  assert.equal(status, 'error')
})
```

### Never access internals

Do not import or call anything from:

- `lib/n8n/` — node executors, api-adapter
- `srv/N8nService.js` — the CAP service class
- `cds.connect.to('n8n')` — the internal service handle

All assertions go through `GET` / `POST` on the public endpoints.

---

## 6. LLM node testing

### Configuration

Add `llm: { kind: 'llm-mock' }` to `cds.requires` in the bookshop's `package.json` (or override with `cds.test().with()`). The mock does not require any credentials or external connectivity.

### What the mock returns

| Node type | Mock behaviour |
|-----------|---------------|
| `chainLlm` | Returns the static mock string as `text` |
| `textClassifier` | Routes all items to the first output category |
| `sentimentAnalysis` | Routes all items to the first output (positive) |
| `informationExtractor` | Returns an object with each schema field set to the mock string |
| `guardrails` | Routes all items to the "pass" output |
| `agent` | First LLM call returns a `query` tool call (if a `query` tool is registered); second call returns the mock string |
| `CUSTOM.capAiClassify` | Returns the first category in the configured list |
| `CUSTOM.capAiExtract` | Returns each field as the mock string |

Because the mock response is deterministic, tests must assert the exact expected category or text — do not use `assert.ok` where a strict equality check is possible.

### Sample LLM test

```js
// tests/n8n/llm-nodes.test.js
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'
import { runWorkflow, firstItem } from '../helpers/n8n.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { GET, POST } = cds.test(path.join(__dirname, '../bookshop'))

describe('LLM nodes', () => {
  test('chainLlm returns mock text', async () => {
    // wf-chain-llm-001 must exist in the CSV with a chainLlm node
    const { status, runData } = await runWorkflow('wf-chain-llm-001', { prompt: 'hello' }, { GET, POST })
    assert.equal(status, 'success')
    const item = firstItem(runData, 'LLM')
    assert.ok(typeof item.text === 'string' && item.text.length > 0)
    assert.match(item.text, /Mock LLM/)
  })
})
```

---

## 7. Sample end-to-end test

Below is a complete, runnable test file for the data-transformation workflows:

```js
// tests/n8n/data-transform.test.js
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'
import { runWorkflow, firstItem, allItems } from '../helpers/n8n.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { GET, POST } = cds.test(path.join(__dirname, '../bookshop'))

describe('data-transform workflows', () => {
  test('Set node writes greeting and count', async () => {
    const { status, runData } = await runWorkflow('wf-set-001', {}, { GET, POST })
    assert.equal(status, 'success')
    const item = firstItem(runData, 'Assign')
    assert.equal(item.greeting, 'hello')
    assert.equal(item.count, 42)
  })

  test('Code node doubles value field', async () => {
    const { status, runData } = await runWorkflow('wf-code-001', { value: 7 }, { GET, POST })
    assert.equal(status, 'success')
    assert.equal(firstItem(runData, 'Double').doubled, 14)
  })

  test('Filter keeps only active items', async () => {
    const input = [{ active: true, id: 1 }, { active: false, id: 2 }, { active: true, id: 3 }]
    // The manual trigger receives the array as the input items
    const { status, runData } = await runWorkflow('wf-filter-001', input, { GET, POST })
    assert.equal(status, 'success')
    const items = allItems(runData, 'Filter')
    assert.equal(items.length, 2)
    assert.ok(items.every(i => i.json.active === true))
  })

  test('Limit caps output at 2 items', async () => {
    const input = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]
    const { status, runData } = await runWorkflow('wf-limit-001', input, { GET, POST })
    assert.equal(status, 'success')
    assert.equal(allItems(runData, 'Limit').length, 2)
  })

  test('Sort orders items by score descending', async () => {
    const input = [{ score: 10 }, { score: 50 }, { score: 30 }]
    const { status, runData } = await runWorkflow('wf-sort-001', input, { GET, POST })
    assert.equal(status, 'success')
    const scores = allItems(runData, 'Sort').map(i => i.json.score)
    assert.deepEqual(scores, [50, 30, 10])
  })

  test('CAP Entity list returns Books from DB', async () => {
    const { status, runData } = await runWorkflow('wf-cap-entity-list-001', {}, { GET, POST })
    assert.equal(status, 'success')
    const items = allItems(runData, 'GetBooks')
    assert.ok(items.length > 0, 'expected at least one book')
    assert.ok('ID' in items[0].json, 'expected ID field')
    assert.ok('title' in items[0].json, 'expected title field')
  })
})
```

---

## 8. What not to test

| Area | Reason |
|------|--------|
| Internal routing logic in `N8nService.js` | Covered by the execution engine itself; test through outcomes, not mechanism |
| DB schema / entity structure | Use the public API — don't query `cap.ai.n8n.*` entities directly |
| n8n UI rendering | Out of scope — that is n8n's own test concern |
| `/rest/*` endpoints (editor adapter) | Those serve the UI, not the execution contract; test the `/api/v1/` surface |
| Cron / schedule triggers | Time-based triggers require a real clock; test the underlying node logic via a manual-trigger wrapper workflow instead |

---

## 9. Running the tests

```sh
# From repo root
node --test tests/n8n/*.test.js

# Or via the package script
npm test
```

Tests run against SQLite in-memory — no external services required when `llm-mock` is configured.
