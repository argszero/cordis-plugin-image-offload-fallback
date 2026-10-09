/**
 * The missing-object path, end to end on a real cordis waterfall.
 *
 * The load-bearing assertion of this file is the one that is easiest to get wrong:
 * the plugin must act on what the *store* says, never on the failure's words. Two
 * unrelated failures publish the identical `DeepSeek Messages transport failed` /
 * `TRANSPORT` (discussion #9266's TLS-inspection proxy and #9262's deleted object), so
 * the arm that proves the plugin stays quiet when every object is present is the arm
 * that keeps it from dropping a user's images on a network error.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  captureLogs,
  dispatchRequestError,
  errorPayload,
  EXECUTOR_PACKAGE,
  fakeAttachments,
  fakeSession,
  fakeSessions,
  imageMessage,
  imageRef,
  mount,
  OFFLOAD_CODE,
} from './helpers.mjs'
import {
  apply,
  collectImageOccurrences,
  findMissingOccurrences,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  MISSING_ATTACHMENT_CODE,
  name,
} from '../lib/index.js'

/** `attachmentId` for occurrence `n` of the default fixture, as `imageRef` builds it. */
const id = n => imageRef(n).attachmentId

/** The failure the DeepSeek Messages adapter publishes, whoever caused it. */
const TRANSPORT_FAILURE = Object.freeze({
  message: 'DeepSeek Messages transport failed',
  code: 'TRANSPORT',
})

/**
 * A mounted plugin with the two services the probe reads, and a session holding
 * three images where the third occurrence's object is gone.
 * @param options - overrides for the session contents, the store, and the plugin config.
 */
async function scenario({ images = 3, missing = [3], offloaded = [], config, attach = true, projections } = {}) {
  const session = fakeSession([
    { seq: 5, type: 'user/message', message: imageMessage({ images, offloaded }) },
    { seq: 9, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ])
  const attachments = fakeAttachments({ missing: missing.map(n => id(n)) })
  const sessions = fakeSessions(projections ?? [{ type: 'image/offload' }])
  const ctx = new Context()
  ctx.provide('sessions', sessions)
  if (attach) ctx.provide('attachments', attachments)
  await mount(ctx, { name, apply }, config)
  return { ctx, session, attachments, sessions }
}

describe('surface walk', () => {
  it('lists every retained occurrence in request order, indexing offloaded ones too', () => {
    const session = fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 2 }) },
      { seq: 7, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      { seq: 9, type: 'tool/result', message: imageMessage({ images: 2, offloaded: [0] }) },
    ])
    const occurrences = collectImageOccurrences(session)

    assert.deepEqual(
      occurrences.map(o => [Number(o.seq), o.imageIndex]),
      // The second node's first occurrence is offloaded, and the index after it still
      // counts it: the index space the durable selection is defined in.
      [[5, 0], [5, 1], [9, 1]],
    )
    assert.equal(occurrences[2].attachment.attachmentId, id(2))
  })

  it('ignores nodes that produce no message', () => {
    const session = fakeSession([
      { seq: 1, type: 'turn/start', message: undefined },
      { seq: 2, type: 'assistant/attempt', message: undefined },
    ])
    assert.deepEqual(collectImageOccurrences(session), [])
  })
})

describe('probe', () => {
  it('reports only the occurrences the store cannot serve', async () => {
    const attachments = fakeAttachments({ missing: [id(2)] })
    const occurrences = collectImageOccurrences(fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 3 }) },
    ]))
    const missing = await findMissingOccurrences(occurrences, attachments, [MISSING_ATTACHMENT_CODE])

    assert.deepEqual(missing.map(o => o.imageIndex), [1])
    // Each distinct attachment is probed once, in request order.
    assert.deepEqual(attachments.reads, [id(1), id(2), id(3)])
  })

  it('probes a repeated attachment once and reports every occurrence of it', async () => {
    const attachments = fakeAttachments({ missing: [id(1)] })
    const occurrences = collectImageOccurrences(fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 3, attachments: [1, 2, 1] }) },
    ]))
    const missing = await findMissingOccurrences(occurrences, attachments, [MISSING_ATTACHMENT_CODE])

    assert.deepEqual(missing.map(o => o.imageIndex), [0, 2])
    assert.deepEqual(attachments.reads, [id(1), id(2)])
  })

  it('treats an unreadable-but-present object as present', async () => {
    const attachments = fakeAttachments({ failing: { ATTACHMENT_READ_FAILED: [id(1)] } })
    const occurrences = collectImageOccurrences(fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 1 }) },
    ]))
    assert.deepEqual(await findMissingOccurrences(occurrences, attachments, [MISSING_ATTACHMENT_CODE]), [])
  })

  it('propagates a cancelled step instead of reading it as evidence', async () => {
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    const attachments = fakeAttachments({ missing: [id(1)], abortOnRead: new Error('cancelled') })
    const occurrences = collectImageOccurrences(fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 1 }) },
    ]))
    await assert.rejects(
      () => findMissingOccurrences(occurrences, attachments, [MISSING_ATTACHMENT_CODE], controller.signal),
      /cancelled/,
    )
  })
})

describe('recovery', () => {
  it('records the exact occurrences the store lost and asks for a retry', async () => {
    const { ctx, session, attachments } = await scenario({ images: 3, missing: [3] })
    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(session.appended, [
      { type: 'image/offload', data: { targets: [{ seq: 5, imageIndexes: [2] }] } },
    ])
    // A live image in front of the missing one is untouched: the selection names the
    // offender instead of counting from the oldest, which is the difference from the
    // decode path's count-based hand-off.
    assert.deepEqual(attachments.reads, [id(1), id(2), id(3)])
  })

  it('groups every occurrence of every missing attachment by its node', async () => {
    const session = fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 2, attachments: [1, 2] }) },
      { seq: 6, type: 'assistant/message', message: { role: 'assistant', content: [] } },
      { seq: 9, type: 'tool/result', message: imageMessage({ images: 2, attachments: [2, 3], offloaded: [1] }) },
    ])
    const ctx = new Context()
    ctx.provide('sessions', fakeSessions([{ type: 'image/offload' }]))
    ctx.provide('attachments', fakeAttachments({ missing: [id(2)] }))
    await mount(ctx, { name, apply })

    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(session.appended[0].data.targets, [
      { seq: 5, imageIndexes: [1] },
      { seq: 9, imageIndexes: [0] },
    ])
  })

  it('names every lost occurrence of one node, in image order', async () => {
    const session = fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 3, attachments: [1, 2, 3] }) },
    ])
    const ctx = new Context()
    ctx.provide('sessions', fakeSessions([{ type: 'image/offload' }]))
    ctx.provide('attachments', fakeAttachments({ missing: [id(2), id(3)] }))
    await mount(ctx, { name, apply })

    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(session.appended[0].data.targets, [{ seq: 5, imageIndexes: [1, 2] }])
  })

  it('leaves a failure whose objects are all present exactly as it found it', async () => {
    // The #9266 shape: the identical message and code produced by a TLS-inspection
    // proxy. Nothing here may act on the words.
    const { ctx, session, attachments } = await scenario({ images: 2, missing: [] })
    const payload = errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE })
    const before = payload.failure
    const action = await dispatchRequestError(ctx, payload)

    assert.equal(action, undefined)
    assert.equal(payload.failure, before)
    assert.deepEqual(session.appended, [])
    assert.equal(attachments.reads.length, 2, 'the probe must have run and found the objects present')
  })

  it('stays inert once every occurrence is already offloaded', async () => {
    const { ctx, session } = await scenario({ images: 2, missing: [1], offloaded: [0, 1] })
    const action = await dispatchRequestError(
      ctx,
      errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }),
    )

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })

  it('does not probe at all when the path is disabled', async () => {
    const { ctx, session, attachments } = await scenario({
      images: 1, missing: [1], config: { recoverMissingAttachments: false },
    })
    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.equal(action, undefined)
    assert.deepEqual(attachments.reads, [])
    assert.deepEqual(session.appended, [])
  })

  it('says which package applies the selection when its projection is absent', async () => {
    // Recording the selection with no interpreter would look like a recovery while
    // every retry re-read the same object.
    const { ctx, session } = await scenario({ images: 1, missing: [1], projections: [] })
    const logs = captureLogs(ctx)
    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
    assert.equal(logs.length, 1)
    assert.equal(logs[0].type, 'warn')
    assert.match(String(logs[0].args[0]), /are missing from the store/)
    assert.ok(logs[0].args.includes(EXECUTOR_PACKAGE), 'the warning must name the package that applies it')
  })

  it('warns once per reason, not once per failure', async () => {
    const { ctx, session } = await scenario({ images: 1, missing: [1], projections: [] })
    const logs = captureLogs(ctx)
    await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))
    await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.equal(logs.filter(m => m.type === 'warn').length, 1)
  })

  it('stays inert, without a throw, when no attachment service is mounted', async () => {
    const { ctx, session } = await scenario({ images: 1, missing: [1], attach: false })
    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })

  it('survives a store that cannot answer at all', async () => {
    const session = fakeSession([
      { seq: 5, type: 'user/message', message: imageMessage({ images: 1 }) },
    ])
    const ctx = new Context()
    ctx.provide('sessions', fakeSessions([{ type: 'image/offload' }]))
    ctx.provide('attachments', {
      readImage() { return Promise.reject(new Error('store is unavailable')) },
      isAttachmentError() { return false },
    })
    await mount(ctx, { name, apply })

    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })
})

describe('decode path after the probe', () => {
  it('still translates a decode rejection when the objects are all present', async () => {
    const { ctx, session } = await scenario({ images: 1, missing: [] })
    const payload = errorPayload({ agent: { session }, failure: { code: 'INVALID_REQUEST', status: 400 } })
    const action = await dispatchRequestError(ctx, payload)

    assert.equal(payload.failure.code, IMAGE_OFFLOAD_REQUIRED_CODE)
    assert.deepEqual(payload.failure.offloadImages, 1)
    // Without the executor mounted nothing acts on it, so the action stays undefined
    // and the plugin warns — the shape `plugin.spec.mjs` covers in full.
    assert.equal(action, undefined)
  })

  it('prefers the missing-object repair over the wording it also matches', async () => {
    const { ctx, session } = await scenario({ images: 1, missing: [1] })
    const payload = errorPayload({
      agent: { session },
      failure: { message: 'unable to load image: the object is gone', code: 'TRANSPORT' },
    })
    const action = await dispatchRequestError(ctx, payload)

    assert.deepEqual(action, { kind: 'retry' })
    // The failure keeps the route's own words: the repair is durable, not a re-marking.
    assert.equal(payload.failure.code, 'TRANSPORT')
    assert.deepEqual(session.appended[0].data.targets, [{ seq: 5, imageIndexes: [0] }])
  })
})

describe('configuration', () => {
  it('refuses malformed probe configuration at mount', () => {
    for (const config of [
      { recoverMissingAttachments: 'yes' },
      { missingAttachmentCodes: [] },
      { missingAttachmentCodes: [''] },
      { missingAttachmentCodes: 'ATTACHMENT_NOT_FOUND' },
      { missingAttachmentCodes: [7] },
    ]) {
      assert.throws(
        () => apply(new Context(), config),
        /image-offload-fallback:/,
        `config ${JSON.stringify(config)} must be refused`,
      )
    }
  })

  it('recovers a code the deployment added to the set', async () => {
    for (const config of [undefined, { missingAttachmentCodes: [MISSING_ATTACHMENT_CODE, 'ATTACHMENT_CORRUPT'] }]) {
      const session = fakeSession([
        { seq: 5, type: 'user/message', message: imageMessage({ images: 1 }) },
      ])
      const ctx = new Context()
      ctx.provide('sessions', fakeSessions([{ type: 'image/offload' }]))
      ctx.provide('attachments', fakeAttachments({ failing: { ATTACHMENT_CORRUPT: [id(1)] } }))
      await mount(ctx, { name, apply }, config)

      const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))
      assert.equal(
        action === undefined,
        config === undefined,
        `ATTACHMENT_CORRUPT must be out of the default set and in the configured one (config: ${JSON.stringify(config)})`,
      )
    }
  })

  it('mirrors the store code the probe matches', async (t) => {
    // The strongest available contract: the shipped store's own read path, on an empty
    // root, must raise exactly the code this plugin treats as "the object is gone".
    let readImageFile
    try {
      ({ readImageFile } = await import('@deepseek-ai/dsh-attachment-local'))
    } catch {
      t.diagnostic('@deepseek-ai/dsh-attachment-local is not installed — the mirrored code is unverified here')
      t.skip('attachment store unavailable')
      return
    }
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'dsh-offload-probe-'))
    try {
      await assert.rejects(
        () => readImageFile(root, imageRef(1)),
        error => error.code === MISSING_ATTACHMENT_CODE,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('published constants', () => {
  it('keeps the offload code the executor matches', () => {
    assert.equal(IMAGE_OFFLOAD_REQUIRED_CODE, OFFLOAD_CODE)
  })
})
