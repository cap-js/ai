// Config sub-node — no execution. Service name is read by consuming AI nodes via context.llmService.
export async function execute(_node, _input, _context) {
  return [[]]
}
