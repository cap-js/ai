/**
 * ScheduleTrigger.js — n8n-nodes-base.scheduleTrigger executor
 *
 * When executed manually/programmatically, emits a single item with the
 * current timestamp. The actual scheduling (firing on a timer) is handled
 * by N8nService._startScheduler().
 */

export function execute(_node, _input, _context) {
  return [[{ json: { timestamp: new Date().toISOString() } }]]
}

/**
 * Parse a scheduleTrigger node's `rule` parameter into a list of cron expressions.
 * Returns an array of cron strings (standard 5-field or 6-field with seconds).
 *
 * @param {object} rule  - node.parameters.rule
 * @returns {string[]}
 */
export function parseCronExpressions(rule) {
  const intervals = rule?.interval ?? []
  const exprs = []

  for (const entry of intervals) {
    const field = entry.field ?? 'days'

    switch (field) {
      case 'seconds': {
        const n = entry.secondsInterval ?? 1
        exprs.push(`*/${n} * * * * *`)  // 6-field: every N seconds
        break
      }
      case 'minutes': {
        const n = entry.minutesInterval ?? 1
        exprs.push(`*/${n} * * * *`)
        break
      }
      case 'hours': {
        const n = entry.hoursInterval ?? 1
        const m = entry.triggerAtMinute ?? 0
        exprs.push(n === 1 ? `${m} * * * *` : `${m} */${n} * * *`)
        break
      }
      case 'days': {
        const n   = entry.daysInterval ?? 1
        const h   = entry.triggerAtHour ?? 0
        const m   = entry.triggerAtMinute ?? 0
        exprs.push(n === 1 ? `${m} ${h} * * *` : `${m} ${h} */${n} * *`)
        break
      }
      case 'weeks': {
        const days = entry.triggerAtDay ?? [0]  // 0 = Sunday
        const h    = entry.triggerAtHour ?? 0
        const m    = entry.triggerAtMinute ?? 0
        const dow  = Array.isArray(days) ? days.join(',') : days
        exprs.push(`${m} ${h} * * ${dow}`)
        break
      }
      case 'months': {
        const dom = entry.triggerAtDayOfMonth ?? 1
        const h   = entry.triggerAtHour ?? 0
        const m   = entry.triggerAtMinute ?? 0
        exprs.push(`${m} ${h} ${dom} * *`)
        break
      }
      case 'cronExpression': {
        const expr = entry.expression ?? ''
        if (expr) exprs.push(expr)
        break
      }
    }
  }

  return exprs
}
