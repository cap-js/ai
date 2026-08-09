import { resolveValue } from './resolve.js'
import { createRequire } from 'module'
import cds from '@sap/cds'

const log = cds.log('n8n:html')
const require = createRequire(import.meta.url)

function loadCheerio() {
  try { return require('cheerio') }
  catch { throw new Error('Html node requires the "cheerio" package. Run: npm install cheerio') }
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

function capitalizeHeader(header) {
  return header
    .split('_')
    .filter(w => w)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  const operation = params.operation ?? 'generateHtmlTemplate'
  const items = normaliseInput(input)
  const nodeOutputs = context?.nodeOutputs ?? {}

  // ── convertToHtmlTable ───────────────────────────────────────────────────
  if (operation === 'convertToHtmlTable' && items.length) {
    const options = params.options ?? {}

    let tableStyle = ''
    let headerStyle = ''
    let cellStyle = ''
    if (!options.customStyling) {
      tableStyle = "style='border-spacing:0; font-family:helvetica,arial,sans-serif'"
      headerStyle = "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee; text-align:left; color:#888; font-weight:normal'"
      cellStyle = "style='margin:0; padding:7px 20px 7px 0px; border-bottom:1px solid #eee'"
    }

    const tableAttributes = options.tableAttributes ?? ''
    const headerAttributes = options.headerAttributes ?? ''
    const rowAttributes = options.rowAttributes ?? ''
    const cellAttributes = options.cellAttributes ?? ''

    // Collect all keys across all items
    const allKeys = new Set()
    const itemsData = items.map(item => {
      for (const key of Object.keys(item.json)) allKeys.add(key)
      return item.json
    })
    const headers = Array.from(allKeys)

    let table = `<table ${tableStyle} ${tableAttributes}>`
    if (options.caption) table += `<caption>${options.caption}</caption>`
    table += `<thead ${headerStyle} ${headerAttributes}>`
    table += '<tr>'
    table += headers.map(h => `<th>${options.capitalize ? capitalizeHeader(h) : h}</th>`).join('')
    table += '</tr></thead><tbody>'

    for (const entry of itemsData) {
      table += `<tr ${rowAttributes}>`
      table += headers.map(h => {
        let td = `<td ${cellStyle} ${cellAttributes}>`
        if (typeof entry[h] === 'boolean') {
          td += `<input type="checkbox" ${entry[h] ? 'checked="checked"' : ''}/>`
        } else {
          td += entry[h] ?? ''
        }
        td += '</td>'
        return td
      }).join('')
      table += '</tr>'
    }
    table += '</tbody></table>'

    return [[{
      json: { table },
      pairedItem: items.map((_, idx) => ({ item: idx })),
    }]]
  }

  // ── Per-item operations ───────────────────────────────────────────────────
  const returnData = []

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]

    try {
      if (operation === 'generateHtmlTemplate') {
        // Resolve {{ expressions }} in the HTML template using item data
        let html = params.html ?? ''
        // Support simple {{ fieldName }} and n8n-style {{ $json.fieldName }} expressions
        html = html.replace(/\{\{([^}]+)\}\}/g, (match, expr) => {
          const trimmed = expr.trim()
          // Simple field name
          if (/^\w+$/.test(trimmed)) {
            const val = item.json[trimmed]
            return val !== undefined ? String(val) : ''
          }
          // $json.fieldName
          const jsonField = trimmed.match(/^\$json\.(\w+)$/)
          if (jsonField) {
            const val = item.json[jsonField[1]]
            return val !== undefined ? String(val) : ''
          }
          // Try resolveValue for full n8n expressions
          try {
            const val = resolveValue(`={{${trimmed}}}`, item, nodeOutputs)
            return val !== undefined ? String(val) : match
          } catch {
            return match
          }
        })
        returnData.push({ json: { html }, pairedItem: { item: itemIndex } })

      } else if (operation === 'extractHtmlContent') {
        // extractHtmlContent
        const dataPropertyName = params.dataPropertyName ?? 'data'
        const extractionValues = params.extractionValues?.values ?? []
        const options = params.options ?? {}

        // Default: trimValues=true, cleanUpText=true (matching n8n defaults)
        const trimValues = options.trimValues !== false
        const cleanUpText = options.cleanUpText !== false

        // Resolve the HTML source from the item JSON
        let htmlSource = item.json[dataPropertyName]
        if (htmlSource === undefined) {
          // Try resolveValue in case it's an expression
          htmlSource = resolveValue(dataPropertyName, item, nodeOutputs)
        }
        if (htmlSource === undefined) {
          throw new Error(`No property named "${dataPropertyName}" exists!`)
        }

        // May be a string or array of strings
        const htmlArray = Array.isArray(htmlSource) ? htmlSource : [htmlSource]

        for (const html of htmlArray) {
          const $ = loadCheerio().load(String(html))
          const newItem = { json: {}, pairedItem: { item: itemIndex } }

          for (const valueData of extractionValues) {
            const { key, cssSelector, returnValue = 'text', attribute, returnArray = false, skipSelectors } = valueData
            if (!key || !cssSelector) continue

            const htmlElement = $(cssSelector)

            if (returnArray) {
              newItem.json[key] = []
              htmlElement.each((_, el) => {
                const val = extractValue($(el), returnValue, attribute, skipSelectors, trimValues, cleanUpText)
                if (val !== undefined) newItem.json[key].push(val)
              })
            } else {
              newItem.json[key] = extractValue(htmlElement, returnValue, attribute, skipSelectors, trimValues, cleanUpText)
            }
          }
          returnData.push(newItem)
        }

      } else {
        throw new Error(`Unknown HTML operation: "${operation}"`)
      }
    } catch (err) {
      log.warn(`Html node error on item ${itemIndex}:`, err.message)
      returnData.push({ json: { error: err.message }, pairedItem: { item: itemIndex } })
    }
  }

  return [returnData]
}

// ── Cheerio-based value extraction ───────────────────────────────────────────

function extractValue($el, returnValue, attribute, skipSelectors, trimValues, cleanUpText) {
  let value

  if (returnValue === 'attribute') {
    value = $el.attr(attribute)
  } else if (returnValue === 'html') {
    value = $el.html() ?? undefined
  } else if (returnValue === 'value') {
    const v = $el.val()
    if (v === undefined) return undefined
    value = Array.isArray(v) ? v.join(',') : String(v)
  } else {
    // text — optionally skip child selectors
    if (skipSelectors) {
      // Clone and remove skipped elements before getting text
      const cloned = $el.clone()
      for (const sel of skipSelectors.split(',').map(s => s.trim()).filter(Boolean)) {
        cloned.find(sel).remove()
      }
      value = cloned.text() ?? undefined
    } else {
      value = $el.text() ?? undefined
    }
  }

  if (value === undefined || value === null) return undefined

  value = String(value)

  if (trimValues) value = value.trim()
  if (cleanUpText) {
    value = value
      .replace(/^\s+|\s+$/g, '')
      .replace(/(\r\n|\n|\r)/gm, '')
      .replace(/\s+/g, ' ')
  }

  return value
}
