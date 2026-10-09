/**
 * Shared fixtures: a real cordis context, a stand-in offload executor, and a
 * session stand-in carrying exactly the members `offloadOldestImages` reads.
 *
 * The waterfall is the real one throughout — these tests exercise ordering and
 * payload sharing, which is precisely what a hand-written dispatcher would fake.
 */

import { Context } from '@deepseek-ai/cordis'
import { apply as translatorApply, DEFAULT_PATTERNS, name as translatorName } from '../lib/index.js'

/** The plugin under test, as cordis receives it. */
export const translatorPlugin = { name: translatorName, apply: translatorApply }

/** Mount the plugin under test onto an already-configured context. */
export async function appliedContext(ctx) {
  await ctx.plugin(translatorPlugin)
  return ctx
}

export const OFFLOAD_CODE = 'IMAGE_OFFLOAD_REQUIRED'
export const EXECUTOR_PACKAGE = '@deepseek-ai/dsh-compaction-image-offload'

/**
 * Build a context and mount each plugin in order.
 *
 * `ctx.plugin()` starts an asynchronous fiber: `apply` has not run until the fiber
 * settles, so a test that skips the await registers nothing and every dispatch
 * silently reaches no listener.
 * @param plugins - plugin shapes to mount in order.
 */
export async function contextWith(...plugins) {
  const ctx = new Context()
  for (const plugin of plugins) await ctx.plugin(plugin)
  return ctx
}

/** Mount one plugin with configuration, after its fiber settles. */
export async function mount(ctx, plugin, config) {
  await ctx.plugin(plugin, config)
  return ctx
}

/**
 * Dispatch `agent/request-error` the way the agent loop does: every listener shares
 * one payload object and one argument list, and the chain ends at a no-op inner
 * callback (`agent-loop/src/agent.ts`).
 * @param ctx - context holding the listeners.
 * @param payload - the failed request's published facts.
 * @returns the outermost listener's action.
 */
export function dispatchRequestError(ctx, payload) {
  return ctx.waterfall('agent/request-error', payload, () => Promise.resolve(undefined))
}

/**
 * The failure llama.cpp-based routes answer with when an attachment's encoding
 * cannot be decoded (discussion #7406), as the chat-completions adapter publishes it.
 */
export const DECODE_REJECTION_MESSAGE =
  '400: {"code":400,"message":"Failed to load image or audio file","type":"invalid_request_error"}'

/** One failed-request payload, with overridable facts. */
export function errorPayload({ failure = {}, agent = {}, ...rest } = {}) {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'local-llama',
    failure: {
      message: DECODE_REJECTION_MESSAGE,
      code: 'INVALID_REQUEST',
      status: 400,
      ...failure,
    },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...rest,
  }
}

/**
 * The recovery contract `dsh-compaction-image-offload` implements, reduced to its
 * decision: act only on the offload code and its count, and answer with a retry.
 * `test/real-executor.spec.mjs` runs the same fixtures against the published plugin.
 * @param seen - array receiving one record per failure the executor observed.
 */
export function standInExecutor(seen) {
  return {
    name: 'stand-in-image-offload',
    apply(ctx) {
      ctx.on('agent/request-error', ({ failure }, next) => {
        seen.push({ code: failure.code, offloadImages: failure.offloadImages })
        if (failure.code !== OFFLOAD_CODE || failure.offloadImages === undefined) return next()
        return Promise.resolve({ kind: 'retry' })
      })
    },
  }
}

/**
 * A translator with the plugin's exact substitution but no `prepend`, used only as
 * the control arm that shows the ordering requirement is load-bearing.
 */
export function appendedTranslator(patterns = DEFAULT_PATTERNS.map(source => new RegExp(source, 'i'))) {
  return {
    name: 'appended-translator',
    apply(ctx) {
      ctx.on('agent/request-error', async (payload, next) => {
        if (patterns.some(pattern => pattern.test(payload.failure.message))) {
          payload.failure = { ...payload.failure, code: OFFLOAD_CODE, offloadImages: 1 }
        }
        return next()
      })
    },
  }
}

/**
 * A session stand-in exposing the four members `offloadOldestImages` reads.
 * @param entries - `{ seq, type, message }` in model-visible order; `message` is what
 *   `deriveEventMessage` returns for that event.
 */
export function fakeSession(entries) {
  const bySeq = new Map(entries.map(entry => [entry.seq, entry]))
  const appended = []
  return {
    appended,
    surface: {
      nodes: entries.map(entry => entry.seq),
      replaceGeneration: 0,
      contentGeneration: 0,
    },
    eventAt: (seq) => {
      const entry = bySeq.get(Number(seq))
      return entry === undefined ? undefined : { seq: entry.seq, type: entry.type }
    },
    deriveEventMessage: (event) => bySeq.get(Number(event.seq))?.message,
    append: (type, data) => {
      appended.push({ type, data })
      return { seq: entries.length + 1 }
    },
  }
}

/** One durable image reference, shaped as the attachment service publishes it. */
export function imageRef(id) {
  return {
    attachmentId: `sha256:${String(id).padStart(64, '0')}`,
    mediaType: 'image/webp',
    bytes: 1024,
    width: 800,
    height: 600,
  }
}

/**
 * One user message holding `images` image blocks followed by a text block.
 * @param options.attachments - attachment id per occurrence; defaults to that occurrence's index.
 */
export function imageMessage({ images, offloaded = [], text = 'what is this?', attachments = [] }) {
  return {
    role: 'user',
    content: [
      ...Array.from({ length: images }, (_, index) => ({
        type: 'image',
        attachment: imageRef(attachments[index] ?? index + 1),
        ...(offloaded.includes(index) ? { offloaded: true } : {}),
      })),
      { type: 'text', text },
    ],
  }
}

/** The store's own failure shape, without importing the harness class the tarball may not have. */
export class FakeAttachmentError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
    this.name = 'AttachmentError'
  }
}

/**
 * A stand-in attachment service: the two members the probe reads.
 * @param options.missing - attachment ids whose read throws `ATTACHMENT_NOT_FOUND`.
 * @param options.failing - `{ code, ids }` pairs: ids whose read throws that code instead.
 * @param options.signal - a signal to abort on read, emulating a cancelled step.
 */
export function fakeAttachments({ missing = [], failing = {}, abortOnRead = undefined } = {}) {
  const missingIds = new Set(missing.map(id => String(id)))
  const reads = []
  return {
    reads,
    async readImage(ref, signal) {
      reads.push(String(ref.attachmentId))
      signal?.throwIfAborted()
      if (abortOnRead !== undefined) throw abortOnRead
      const id = String(ref.attachmentId)
      for (const [code, ids] of Object.entries(failing)) {
        if (ids.map(String).includes(id)) throw new FakeAttachmentError(`attachment ${code}`, code)
      }
      if (missingIds.has(id)) throw new FakeAttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
      return { ref, data: new Uint8Array(0) }
    },
    isAttachmentError(error) {
      return error instanceof FakeAttachmentError
    },
  }
}

/**
 * A stand-in for the session store's projection registry: it records what the mounted
 * plugins register and exposes it the way the real store does, so a plugin that asks
 * whether the offload interpreter is present gets the true answer.
 * @param initial - projections already registered before the plugins mount.
 */
export function fakeSessions(initial = []) {
  const projections = [...initial]
  return {
    projections,
    registerMessageProjection(projection) {
      projections.push(projection)
      return async () => {}
    },
    get messageProjections() {
      return projections
    },
  }
}

/**
 * Collect the logger's structured messages for assertions.
 *
 * An exporter declares the severities it wants: the default target level is INFO, so
 * a `warn` message is dropped unless the exporter asks for it. `2` is WARN — the
 * harness's own boot exporter uses the same literal (`app-boot/src/index.ts`), because
 * cordis's `LoggerLevel` is a `const enum` and has no runtime export to import here.
 */
export function captureLogs(ctx) {
  const messages = []
  ctx.logger.exporter({ levels: { default: 2 }, export: (message) => { messages.push(message) } })
  return messages
}
