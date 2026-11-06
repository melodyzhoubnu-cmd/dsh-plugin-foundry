/**
 * Delivery into the conversation.
 *
 * Recommendations and install receipts are `developer/message` surface events:
 * the model sees them on its next step, the user sees them in the transcript,
 * and no side panel or floating card is involved. Only the tail is appended;
 * tool declarations and the system prompt are untouched.
 */
import { randomUUID } from 'node:crypto'

export function createNotifier({ ctx, logger } = {}) {
  function sessionOf(sessionId) {
    try {
      const sessions = (ctx.get && ctx.get('sessions')) || ctx.sessions
      if (sessions && typeof sessions.get === 'function') return sessions.get(sessionId)
    } catch {
      /* fall through */
    }
    return null
  }

  function append(sessionId, text, meta = {}) {
    const session = sessionOf(sessionId)
    if (!session || typeof session.append !== 'function' || !text) return false
    const message = {
      id: randomUUID(),
      role: 'developer',
      source: { kind: 'capability', form: 'notice', summary: 'plugin-foundry' },
      content: [{ type: 'text', text }],
    }
    const data = {
      turn: Number(meta.turn) || 0,
      step: Number(meta.step) || 0,
      message,
    }
    try {
      session.append('developer/message', data, { surfaceOp: 'append' })
      return true
    } catch (error) {
      // Some host versions accept the message body without turn/step. The
      // fallback keeps delivery working instead of silently dropping it.
      try {
        session.append('developer/message', { message }, { surfaceOp: 'append' })
        return true
      } catch {
        logger?.warn?.(`plugin-foundry: developer message failed: ${String((error && error.message) || error)}`)
        return false
      }
    }
  }

  return { append, sessionOf }
}
