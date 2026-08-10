/**
 * CronTrigger.js — n8n-nodes-base.cron executor (legacy Cron node)
 *
 * When executed manually/programmatically, emits a single item with timestamp.
 * Scheduling is handled by N8nService._startScheduler().
 */

export function execute(_node, _input, _context) {
  return [[{ json: { timestamp: new Date().toISOString() } }]]
}

/**
 * Parse a Cron node's `triggerTimes` parameter into cron expressions.
 * triggerTimes.item[] each has { mode, hour, minute, dayOfMonth, weekday, expression }
 *
 * @param {object} triggerTimes  - node.parameters.triggerTimes
 * @returns {string[]}
 */
export function parseCronExpressions(triggerTimes) {
  const items = triggerTimes?.item ?? []
  const exprs = []

  for (const item of items) {
    const mode = item.mode ?? 'everyMinute'
    switch (mode) {
      case 'everyMinute':
        exprs.push('* * * * *')
        break
      case 'everyHour': {
        const m = item.minute ?? 0
        exprs.push(`${m} * * * *`)
        break
      }
      case 'everyDay': {
        const h = item.hour ?? 0
        const m = item.minute ?? 0
        exprs.push(`${m} ${h} * * *`)
        break
      }
      case 'everyWeek': {
        const dow = item.weekday ?? 0
        const h   = item.hour ?? 0
        const m   = item.minute ?? 0
        exprs.push(`${m} ${h} * * ${dow}`)
        break
      }
      case 'everyMonth': {
        const dom = item.dayOfMonth ?? 1
        const h   = item.hour ?? 0
        const m   = item.minute ?? 0
        exprs.push(`${m} ${h} ${dom} * *`)
        break
      }
      case 'custom': {
        const expr = item.expression ?? ''
        if (expr) exprs.push(expr)
        break
      }
    }
  }

  return exprs
}
