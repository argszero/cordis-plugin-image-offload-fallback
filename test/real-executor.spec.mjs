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
import { appendedTranslator, appliedContext, dispatchRequestError, errorPayload, fakeSession, imageMessage } from './helpers.mjs'

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
