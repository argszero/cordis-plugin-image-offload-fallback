/**
 * Translator behavior against a real cordis waterfall: the two paths that must never
 * be taken, the two facts the recovery needs, and the ordering the executor requires.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  appendedTranslator,
  captureLogs,
  contextWith,
  DECODE_REJECTION_MESSAGE,
  dispatchRequestError,
  errorPayload,
  EXECUTOR_PACKAGE,
  mount,
  OFFLOAD_CODE,
  standInExecutor,
} from './helpers.mjs'
import { apply, DEFAULT_PATTERNS, IMAGE_OFFLOAD_REQUIRED_CODE, isCandidate, name } from '../lib/index.js'

const PATTERNS = DEFAULT_PATTERNS.map(source => new RegExp(source, 'i'))

describe('plugin surface', () => {
  it('publishes the module name and the offload code the executor matches', () => {
    assert.equal(name, 'image-offload-fallback')
    assert.equal(IMAGE_OFFLOAD_REQUIRED_CODE, OFFLOAD_CODE)
  })
})

describe('candidacy', () => {
  it('accepts the reported llama.cpp wording when the adapter flattened the code', () => {
    assert.equal(isCandidate({ message: DECODE_REJECTION_MESSAGE, code: 'INVALID_REQUEST', status: 400 }, PATTERNS), true)
  })

  it('accepts a text-classified adapter failure, which carries no status', () => {
    assert.equal(isCandidate({ message: 'HTTP 400: unable to load image', code: 'INVALID_REQUEST' }, PATTERNS), true)
  })

  it('never re-marks a failure that already carries the offload code', () => {
    assert.equal(isCandidate({ message: DECODE_REJECTION_MESSAGE, code: OFFLOAD_CODE, offloadImages: 4 }, PATTERNS), false)
  })

  it('ignores a status that cannot be a decode rejection', () => {
    for (const status of [401, 403, 429, 500]) {
      assert.equal(
        isCandidate({ message: DECODE_REJECTION_MESSAGE, code: 'SERVER', status }, PATTERNS),
        false,
        `status ${status} must not be translated`,
      )
    }
  })

  it('leaves a failure whose message says nothing about an image alone', () => {
    for (const message of [
      'invalid request body',
      'context window exceeded',
      'the request was rejected by content review',
      'tool call arguments are malformed',
    ]) {
      assert.equal(isCandidate({ message, code: 'INVALID_REQUEST', status: 400 }, PATTERNS), false, message)
    }
  })
})

describe('translation', () => {
  it('hands the executor a code and a count, and returns its retry', async () => {
    const seen = []
    const ctx = await contextWith(standInExecutor(seen), { name, apply })
    const action = await dispatchRequestError(ctx, errorPayload())

    assert.deepEqual(seen, [{ code: OFFLOAD_CODE, offloadImages: 1 }])
    assert.deepEqual(action, { kind: 'retry' })
  })

  it('keeps the provider wording, status, and request id on the published failure', async () => {
    const seen = []
    const ctx = await contextWith(standInExecutor(seen), { name, apply })
    const payload = errorPayload({ failure: { requestId: 'req-42', providerRetryAfterMs: 1500 } })
    await dispatchRequestError(ctx, payload)

    assert.equal(payload.failure.message, DECODE_REJECTION_MESSAGE)
    assert.equal(payload.failure.status, 400)
    assert.equal(payload.failure.requestId, 'req-42')
    assert.equal(payload.failure.providerRetryAfterMs, 1500)
    assert.equal(payload.failure.code, OFFLOAD_CODE)
  })

  it('passes an unrelated failure through untouched, by reference', async () => {
    const seen = []
    const ctx = await contextWith(standInExecutor(seen), { name, apply })
    const payload = errorPayload({ failure: { message: 'upstream is unavailable', code: 'SERVER', status: 503 } })
    const before = payload.failure
    const action = await dispatchRequestError(ctx, payload)

    assert.equal(payload.failure, before)
    assert.deepEqual(seen, [{ code: 'SERVER', offloadImages: undefined }])
    assert.equal(action, undefined)
  })

  it('preserves the count a route reported itself', async () => {
    const seen = []
    const ctx = await contextWith(standInExecutor(seen), { name, apply })
    const payload = errorPayload({
      failure: { message: 'request carries too many image bytes', code: OFFLOAD_CODE, offloadImages: 3 },
    })
    const action = await dispatchRequestError(ctx, payload)

    assert.deepEqual(seen, [{ code: OFFLOAD_CODE, offloadImages: 3 }])
    assert.deepEqual(action, { kind: 'retry' })
  })

  it('is inert without the executor, and says which package is missing', async () => {
    const ctx = await contextWith({ name, apply })
    const logs = captureLogs(ctx)
    const action = await dispatchRequestError(ctx, errorPayload())

    assert.equal(action, undefined)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].type, 'warn')
    assert.match(String(logs[0].args[0]), /nothing recovered it/)
    assert.ok(
      logs[0].args.includes(EXECUTOR_PACKAGE),
      'the warning must name the package that completes the recovery',
    )
  })
})

describe('configuration', () => {
  it('matches a deployment-specific wording only when configured to', async () => {
    const message = 'image_bytes_rejected_by_route: attachment 7'
    const seen = []
    const configured = []
    const ctx = await contextWith(standInExecutor(seen), { name, apply })
    const configuredCtx = new Context()
    await mount(configuredCtx, standInExecutor(configured))
    await mount(configuredCtx, { name, apply }, { extraPatterns: ['image_bytes_rejected_by_route'] })

    await dispatchRequestError(ctx, errorPayload({ failure: { message } }))
    await dispatchRequestError(configuredCtx, errorPayload({ failure: { message } }))

    assert.deepEqual(seen, [{ code: 'INVALID_REQUEST', offloadImages: undefined }])
    assert.deepEqual(configured, [{ code: OFFLOAD_CODE, offloadImages: 1 }])
  })

  it('requests the configured number of occurrences', async () => {
    const seen = []
    const ctx = new Context()
    await mount(ctx, standInExecutor(seen))
    await mount(ctx, { name, apply }, { offloadImages: 2 })
    await dispatchRequestError(ctx, errorPayload())

    assert.deepEqual(seen, [{ code: OFFLOAD_CODE, offloadImages: 2 }])
  })

  it('refuses malformed configuration at mount instead of shrinking the matcher', () => {
    for (const config of [
      { extraPatterns: 'failed to load image' },
      { extraPatterns: [''] },
      { extraPatterns: ['('] },
      { extraPatterns: [7] },
      { offloadImages: 0 },
      { offloadImages: -1 },
      { offloadImages: 1.5 },
    ]) {
      assert.throws(
        () => apply(contextWith(), config),
        /image-offload-fallback:/,
        `config ${JSON.stringify(config)} must be refused`,
      )
    }
  })
})

describe('listener ordering', () => {
  it('reaches an executor that mounted before it', async () => {
    // The plugin prepends itself, so the executor's earlier position does not matter.
    const seen = []
    const ctx = await contextWith(standInExecutor(seen), { name, apply })
    const action = await dispatchRequestError(ctx, errorPayload())

    assert.deepEqual(seen, [{ code: OFFLOAD_CODE, offloadImages: 1 }])
    assert.deepEqual(action, { kind: 'retry' })
  })

  it('is not reached by an executor that consumed the chain first', async () => {
    // Control arm for the requirement: the same substitution registered *after* the
    // executor is invisible to it, which is why `prepend` is load-bearing rather
    // than stylistic.
    const seen = []
    const ctx = await contextWith(standInExecutor(seen), appendedTranslator(PATTERNS))
    const action = await dispatchRequestError(ctx, errorPayload())

    assert.deepEqual(seen, [{ code: 'INVALID_REQUEST', offloadImages: undefined }])
    assert.equal(action, undefined)
  })
})
