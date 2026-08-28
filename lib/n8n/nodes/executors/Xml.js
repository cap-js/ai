import { createRequire } from 'module'
import cds from '@sap/cds'

const log = cds.log('n8n:xml')
const require = createRequire(import.meta.url)

function loadXml2js() {
  try { return require('xml2js') }
  catch { throw new Error('Xml node requires the "xml2js" package. Run: npm install xml2js') }
}

function normaliseInput(input) {
  if (!input) return [{ json: {} }]
  if (Array.isArray(input)) return input.map(i => ('json' in i) ? i : { json: i })
  return [{ json: input }]
}

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

export async function execute(node, input, context) {
  const params = node.parameters ?? {}
  // n8n uses 'xmlToJson' and 'jsonToxml' (lowercase x in jsonToxml)
  const mode = params.mode ?? 'xmlToJson'
  const dataPropertyName = params.dataPropertyName ?? 'data'
  const options = { ...(params.options ?? {}) }
  const items = normaliseInput(input)

  // Validate forbidden keys (matching n8n's security check)
  if (options.attrkey !== undefined) {
    options.attrkey = String(options.attrkey)
    if (FORBIDDEN_KEYS.includes(options.attrkey)) {
      throw new Error(`The "Attribute Key" option value "${options.attrkey}" is not allowed`)
    }
  }
  if (options.charkey !== undefined) {
    options.charkey = String(options.charkey)
    if (FORBIDDEN_KEYS.includes(options.charkey)) {
      throw new Error(`The "Character Key" option value "${options.charkey}" is not allowed`)
    }
  }

  const returnData = []

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]
    try {
      if (mode === 'xmlToJson') {
        if (item.json[dataPropertyName] === undefined) {
          throw new Error(`Item has no JSON property called "${dataPropertyName}"`)
        }

        const { Parser: XmlParser } = loadXml2js()
        // xml2js defaults matching n8n: mergeAttrs=true, explicitArray=false
        const parserOptions = Object.assign(
          { mergeAttrs: true, explicitArray: false },
          options
        )

        const parser = new XmlParser(parserOptions)
        const json = await parser.parseStringPromise(item.json[dataPropertyName])
        returnData.push({ json: JSON.parse(JSON.stringify(json)), pairedItem: { item: itemIndex } })

      } else if (mode === 'jsonToxml') {
        const { Builder: XmlBuilder } = loadXml2js()
        // Builder options: rootName, headless, cdata, allowSurrogateChars, attrkey, charkey
        const builderOptions = {}
        if (options.attrkey !== undefined) builderOptions.attrkey = options.attrkey
        if (options.charkey !== undefined) builderOptions.charkey = options.charkey
        if (options.rootName !== undefined) builderOptions.rootName = options.rootName
        if (options.headless !== undefined) builderOptions.headless = options.headless
        if (options.cdata !== undefined) builderOptions.cdata = options.cdata
        if (options.allowSurrogateChars !== undefined) builderOptions.allowSurrogateChars = options.allowSurrogateChars

        const builder = new XmlBuilder(builderOptions)
        const xmlStr = builder.buildObject(item.json)
        returnData.push({
          json: { [dataPropertyName]: xmlStr },
          pairedItem: { item: itemIndex },
        })

      } else {
        throw new Error(`The operation "${mode}" is not known!`)
      }
    } catch (err) {
      log.warn(`Xml node error on item ${itemIndex}:`, err.message)
      returnData.push({
        json: { error: err.message },
        pairedItem: { item: itemIndex },
      })
    }
  }

  return [returnData]
}
