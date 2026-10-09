/**
 * The recovery end to end, against the published `@deepseek-ai/dsh-compaction-image-offload`
 * rather than a stand-in: the translator's substitution must be what that plugin's own
 * listener reads, and the durable selection it appends must be the one a model request
 * would then render as placeholder text.
 *
 * The session and the two services it injects are stand-ins — the executor's decision
 * and the cordis waterfall are the shipped ones.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as imageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import {
  appendedTranslator,
  appliedContext,
  dispatchRequestError,
  errorPayload,
  fakeAttachments,
  fakeSession,
  imageMessage,
  imageRef,
  translatorPlugin,
} from './helpers.mjs'

/** The failure the DeepSeek Messages adapter publishes for a route it could not reach. */
const TRANSPORT_FAILURE = Object.freeze({ message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' })

/** `attachmentId` for occurrence `n` of `imageMessage`'s default fixture. */
const id = n => imageRef(n).attachmentId

const OFFENDING_SEQ = 5

/** A context carrying the executor's injected services and a session holding `images`. */
async function scenario({ images, offloaded = [] }) {
  const session = fakeSession([
    { seq: OFFENDING_SEQ, type: 'user/message', message: imageMessage({ images, offloaded }) },
  ])
  const ctx = new Context()
  ctx.provide('sessions', { registerMessageProjection() {} })
  ctx.provide('agents', {})
  await ctx.plugin(imageOffload)
  return { ctx, session }
}

describe('published executor', () => {
  it('is mounted with the services it injects', async () => {
    const { ctx } = await scenario({ images: 1 })
    assert.equal(ctx.get('sessions') !== undefined, true)
    assert.equal(ctx.get('agents') !== undefined, true)
    assert.equal(typeof imageOffload.apply, 'function')
  })

  it('marks nothing for a decode rejection on its own', async () => {
    // The gap this plugin fills: the executor answers `next()` for a code it does not
    // recognize, so an untouched decode rejection never reaches its offload decision.
    const { ctx, session } = await scenario({ images: 1 })
    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session } }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })

  it('recovers a decode rejection once the translator runs', async () => {
    const { ctx, session } = await scenario({ images: 1 })
    await appliedContext(ctx)

    const payload = errorPayload({ agent: { session } })
    const action = await dispatchRequestError(ctx, payload)

    assert.deepEqual(action, { kind: 'retry' })
    assert.equal(session.appended.length, 1)
    const [selection] = session.appended
    assert.equal(selection.type, 'image/offload')
    assert.deepEqual(selection.data.targets, [{ seq: OFFENDING_SEQ, imageIndexes: [0] }])
    assert.equal(payload.failure.message.includes('Failed to load image'), true)
  })

  it('selects the fewest occurrences when the offender is not the oldest image', async () => {
    // Count 1 is the minimal step: one attempt removes one image, and the next turn
    // removes the next, so a session that holds an older decodable image loses only
    // what the route actually refuses to serve.
    const { ctx, session } = await scenario({ images: 3, offloaded: [1] })
    await appliedContext(ctx)

    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session } }))

    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(session.appended[0].data.targets, [{ seq: OFFENDING_SEQ, imageIndexes: [0] }])
  })

  it('stops claiming recovery once every occurrence is marked', async () => {
    // The bounded end of the loop: with nothing left to offload the executor delegates,
    // which is what keeps a repeated failure from becoming a retry cycle.
    const { ctx, session } = await scenario({ images: 2, offloaded: [0, 1] })
    await appliedContext(ctx)

    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session } }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })

  it('needs the prepended registration to be reached at all', async () => {
    // Control arm against the shipped listener: the same substitution registered after
    // the executor is consumed by it as an unrecognized failure.
    const { ctx, session } = await scenario({ images: 1 })
    await ctx.plugin(appendedTranslator())

    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session } }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })
})

/**
 * The same context, with the published executor's *registration* recorded instead of
 * discarded, so the plugin's "is an interpreter mounted" question is answered by the
 * shipped plugin rather than by a stand-in.
 * @param options.missing - occurrence numbers whose attachment object is gone.
 */
async function mountedScenario({ images, missing = [], offloaded = [] }) {
  const session = fakeSession([
    { seq: OFFENDING_SEQ, type: 'user/message', message: imageMessage({ images, offloaded }) },
  ])
  const registrations = []
  const ctx = new Context()
  ctx.provide('sessions', {
    registerMessageProjection(projection) {
      registrations.push(projection)
      return async () => {}
    },
    get messageProjections() {
      return registrations
    },
  })
  ctx.provide('agents', {})
  ctx.provide('attachments', fakeAttachments({ missing: missing.map(id) }))
  await ctx.plugin(imageOffload)
  await ctx.plugin(translatorPlugin)
  return { ctx, session, registrations }
}

describe('published executor with the missing-object probe', () => {
  it('publishes the projection type the probe guards on', async () => {
    // The guard is not a guess: this is the shipped registration it looks for.
    const { registrations } = await mountedScenario({ images: 1 })
    assert.deepEqual(registrations.map(projection => projection.type), ['image/offload'])
  })

  it('recovers an object whose absence only the store knows about', async () => {
    // No wording in the failure points at an image — only the probe does.
    const { ctx, session } = await mountedScenario({ images: 3, missing: [3] })
    const payload = errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE })
    const action = await dispatchRequestError(ctx, payload)

    assert.deepEqual(action, { kind: 'retry' })
    assert.deepEqual(session.appended, [
      { type: 'image/offload', data: { targets: [{ seq: OFFENDING_SEQ, imageIndexes: [2] }] } },
    ])
    // The failure keeps the route's own words: this is a durable repair, not a re-marking.
    assert.equal(payload.failure.code, TRANSPORT_FAILURE.code)
    assert.equal(payload.failure.message, TRANSPORT_FAILURE.message)
  })

  it('hands the shipped projection a selection it accepts', async () => {
    const { ctx, session } = await mountedScenario({ images: 3, missing: [2] })
    await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    const [selection] = session.appended
    const message = imageMessage({ images: 3 })
    const projected = imageOffloadProjection.project(selection, {
      baseSeq: OFFENDING_SEQ,
      nodes: [OFFENDING_SEQ],
      events: [{ seq: OFFENDING_SEQ, type: 'user/message', data: message }],
      messages: new Map(),
    })

    // Applying the decision to the message it was written for marks exactly the lost
    // occurrence and leaves the two live ones alone, which is the whole recovery.
    const blocks = projected.get(OFFENDING_SEQ).content
    assert.deepEqual(blocks.filter(block => block.type === 'image').map(block => block.offloaded === true), [false, true, false])
  })

  it('never acts on the identical wording when the objects are all present', async () => {
    // The #9266 arm: a TLS-inspection proxy publishes this exact sentence and code.
    const { ctx, session } = await mountedScenario({ images: 2, missing: [] })
    const action = await dispatchRequestError(ctx, errorPayload({ agent: { session }, failure: TRANSPORT_FAILURE }))

    assert.equal(action, undefined)
    assert.deepEqual(session.appended, [])
  })
})
