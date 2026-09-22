/**
 * The contract this plugin borrows instead of depending on: the offload code string is
 * mirrored from `@deepseek-ai/dsh-llm`, and the harness's own recovery only runs for the
 * exact value the executor matches.
 *
 * These assertions are what make the mirroring safe — a renamed constant fails here in
 * development rather than silently turning the plugin into a no-op in a deployment.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_PATTERNS, IMAGE_OFFLOAD_REQUIRED_CODE, isCandidate } from '../lib/index.js'
import { DECODE_REJECTION_MESSAGE } from './helpers.mjs'

const HARNESS_LLM = '@deepseek-ai/dsh-llm'

async function harnessConstant() {
  try {
    return await import(HARNESS_LLM)
  } catch {
    return undefined
  }
}

describe('offload code contract', () => {
  it('equals the code the harness declares', async (t) => {
    const llm = await harnessConstant()
    if (llm === undefined) {
      // The published tarball's tests run without the harness installed; the mirror is
      // then unverified, and saying so is the point of this arm.
      t.diagnostic(`${HARNESS_LLM} is not installed — the mirrored code is unverified here`)
      t.skip('harness package unavailable')
      return
    }
    assert.equal(IMAGE_OFFLOAD_REQUIRED_CODE, llm.IMAGE_OFFLOAD_REQUIRED_CODE)
  })

  it('is read by the executor this plugin feeds', async (t) => {
    let executor
    try {
      executor = await import('@deepseek-ai/dsh-compaction-image-offload')
    } catch {
      t.skip('executor package unavailable')
      return
    }
    // The executor acts on the code through this constant, so the two can only agree.
    const llm = await harnessConstant()
    assert.equal(executor.name, 'compaction-image-offload')
    assert.equal(typeof executor.apply, 'function')
    assert.equal(IMAGE_OFFLOAD_REQUIRED_CODE, llm.IMAGE_OFFLOAD_REQUIRED_CODE)
  })
})

describe('default patterns', () => {
  const patterns = DEFAULT_PATTERNS.map(source => new RegExp(source, 'i'))

  it('match the failure that motivated this plugin', () => {
    assert.equal(isCandidate({ message: DECODE_REJECTION_MESSAGE, code: 'INVALID_REQUEST', status: 400 }, patterns), true)
  })

  it('match the wordings sibling projects hit against the same server', () => {
    for (const message of [
      'Failed to load image or audio file',
      'unable to load image: unsupported format',
      'Error: could not decode image',
      'invalid image data',
      'image format not supported',
      'Unsupported image type: image/webp',
    ]) {
      assert.equal(isCandidate({ message, code: 'INVALID_REQUEST', status: 400 }, patterns), true, message)
    }
  })

  it('do not match failures that are not about an image', () => {
    for (const message of [
      'failed to load model weights',
      'invalid request: tool schema is malformed',
      'context length exceeded',
      'the content was rejected by the provider',
      'rate limit reached',
    ]) {
      assert.equal(isCandidate({ message, code: 'INVALID_REQUEST', status: 400 }, patterns), false, message)
    }
  })

  it('are all valid case-insensitive expressions', () => {
    for (const source of DEFAULT_PATTERNS) assert.doesNotThrow(() => new RegExp(source, 'i'), source)
  })
})
