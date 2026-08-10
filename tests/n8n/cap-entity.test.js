import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'url'
import cds from '@sap/cds'
import { runWorkflow, firstItem, allItems } from '../helpers/n8n.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { GET, POST } = cds.test(path.join(__dirname, '../bookshop'))

describe('capEntity workflows', () => {
  test('wf-book-catalog: list returns books with label', async () => {
    const { status, runData } = await runWorkflow('wf-book-catalog', {}, { GET, POST })
    assert.equal(status, 'success')
    const items = allItems(runData, 'AddLabel')
    assert.ok(items.length > 0, 'expected at least one book')
    const item = items[0].json
    assert.ok(typeof item.label === 'string' && item.label.includes('in stock'), `unexpected label: ${item.label}`)
    assert.ok(typeof item.ID === 'number')
    assert.ok(typeof item.price === 'number')
  })

  test('wf-book-detail: get book with author data', async () => {
    const { status, runData } = await runWorkflow('wf-book-detail', { bookId: 201 }, { GET, POST })
    assert.equal(status, 'success')
    // BookWithAuthor merges book + author fields
    const result = firstItem(runData, 'BookWithAuthor')
    assert.ok(result, 'BookWithAuthor produced no output')
    assert.equal(result.bookId, 201)
    assert.ok(typeof result.title === 'string')
    assert.ok(typeof result.authorName === 'string')
  })

  test('wf-book-lifecycle: create, update, verify, delete', async () => {
    const { status, runData } = await runWorkflow('wf-book-lifecycle', {}, { GET, POST })
    assert.equal(status, 'success')
    const result = firstItem(runData, 'LifecycleOk')
    assert.equal(result?.result, 'lifecycle-complete')
  })

  test('wf-key-variants: composed and custom key lookups merge correctly', async () => {
    const { status, runData } = await runWorkflow('wf-key-variants', {}, { GET, POST })
    assert.equal(status, 'success')
    const items = allItems(runData, 'MergeLookups')
    assert.equal(items.length, 2)
    const sources = items.map(i => i.json.source).sort()
    assert.deepEqual(sources, ['composed-key', 'custom-key'])
  })
})

describe('capCql workflows', () => {
  test('wf-book-detail: AuthorQuery resolves :authorId from item json', async () => {
    const { status, runData } = await runWorkflow('wf-book-detail', { bookId: 203 }, { GET, POST })
    assert.equal(status, 'success')
    // AuthorQuery is a token node — actual results land in the consuming Set node
    const result = firstItem(runData, 'BookWithAuthor')
    assert.ok(result?.authorName, 'author name missing — :authorId param not resolved')
  })

  test('wf-author-bibliography: deduplicates books by title', async () => {
    const { status, runData } = await runWorkflow('wf-author-bibliography', { authorId: 101 }, { GET, POST })
    assert.equal(status, 'success')
    const items = allItems(runData, 'FormatEntry')
    assert.ok(items.length > 0)
    const titles = items.map(i => i.json.title)
    assert.equal(titles.length, new Set(titles).size, 'duplicate titles found')
  })

  test('wf-stock-report: summarizes and sorts by stock descending', async () => {
    const { status, runData } = await runWorkflow('wf-stock-report', {}, { GET, POST })
    assert.equal(status, 'success')
    const items = allItems(runData, 'SortByStock')
    assert.ok(items.length > 0)
    const stocks = items.map(i => i.json.totalStock)
    assert.deepEqual(stocks, [...stocks].sort((a, b) => b - a), 'not sorted descending')
  })
})
