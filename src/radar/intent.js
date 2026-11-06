/**
 * Intent cues extracted from the conversation. Kept separate from the task
 * profile so the recommender and the delivery layer use the same vocabulary
 * and cannot drift.
 */
const CAPABILITY_PATTERNS = [
  /有没有.{0,12}(工具|插件|办法|能力|功能)/i,
  /能不能|可不可以|能做吗|可以做到吗/i,
  /有什么.{0,8}(工具|插件|办法)/i,
  /\bis there a (tool|plugin|way)\b|\bcan you (do|handle)\b/i,
]
const ERROR_PATTERNS = [
  /command not found|module not found|cannot find module|no such file|permission denied|missing dependency|not installed/i,
  /缺依赖|找不到|未安装|没有这个命令|权限不足|安装失败/i,
]

export function detectCapabilityQuestion(text) {
  const value = String(text || '')
  return CAPABILITY_PATTERNS.some((pattern) => pattern.test(value))
}

export function looksLikeDependencyError(text) {
  const value = String(text || '')
  return ERROR_PATTERNS.some((pattern) => pattern.test(value))
}

export function intentOf(text) {
  return {
    capabilityQuestion: detectCapabilityQuestion(text),
    dependencyError: looksLikeDependencyError(text),
  }
}
