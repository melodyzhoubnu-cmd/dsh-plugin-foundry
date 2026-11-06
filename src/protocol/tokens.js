/**
 * Token estimation used only when the provider did not give per-tool counts:
 * tool-result content and capability signals. It is deliberately cheap and
 * documented as an estimate, never as a billable measurement.
 *
 * CJK characters count as one token each; other text is approximated at four
 * characters per token. Both are upper-ish bounds for the tokenizers DSH uses.
 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g

export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (!value) return 0
  const cjk = (value.match(CJK) || []).length
  const rest = value.length - cjk
  return Math.max(0, Math.ceil(cjk + rest / 4))
}

/** Rough character budget for a context fragment. */
export function estimateChars(tokens) {
  return Math.max(0, Math.trunc(Number(tokens) * 2.5))
}
