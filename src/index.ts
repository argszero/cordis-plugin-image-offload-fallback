/**
 * Recover a session wedged by an image the route cannot decode, by translating
 * that rejection into the harness's existing image-offload recovery.
 *
 * A provider that declares image input but cannot decode one encoding fails every
 * request that carries the attachment — llama.cpp's stb loader rejects WebP, so a
 * WebP screenshot makes an OpenAI-compatible local vision server answer 400
 * `Failed to load image or audio file`. The attachment is durable before the first
 * failure, so every later turn replays it, compaction replays the same prefix, and
 * the session never recovers.
 *
 * The harness already recovers from "this route's request must carry fewer images":
 * a failure whose `code` is `IMAGE_OFFLOAD_REQUIRED` and which carries
 * `offloadImages` reaches `dsh-compaction-image-offload`, which permanently replaces
 * that many of the oldest retained occurrences with placeholder text and retries
 * without spending provider retry budget. Only a route's *byte-budget* rejection
 * raises that code, so a *decode* rejection never reaches the executor. This plugin
 * closes that gap from the outside: it recognizes the rejection on
 * `agent/request-error` and hands the executor a failure the executor acts on.
 *
 * @module @argszero/cordis-plugin-image-offload-fallback
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'

export const name = 'image-offload-fallback'

/**
 * Canonical offload code, mirrored from `@deepseek-ai/dsh-llm`'s
 * `IMAGE_OFFLOAD_REQUIRED_CODE`.
 *
 * The value is a stable wire string that `dsh-compaction-image-offload` matches on.
 * It is repeated as a literal rather than imported so this plugin carries no runtime
 * dependency on the harness packages — the published `latest` dist-tag of
 * `@deepseek-ai/dsh-llm` is stale, so a peer version npm would auto-install is not
 * the version the host runs. `test/contract.spec.mjs` asserts this literal equals the
 * installed package's exported constant, so an upstream rename fails in development
 * rather than silently turning this plugin into a no-op.
 */
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED'

/** One failed model request, as `agent/request-error` publishes it. */
export type RequestErrorPayload = Parameters<Events['agent/request-error']>[0]

/** Configuration for the translator. */
export interface Config {
  /**
   * Extra decode-rejection patterns, as case-insensitive regular-expression sources,
   * appended to the built-in set. Add one when a route words the rejection differently
   * and the plugin stayed quiet.
   */
  extraPatterns?: readonly string[]
  /**
   * Retained occurrences to request per attempt. Defaults to 1 — the smallest step
   * that can unblock the request, so a session that holds an older decodable image
   * loses only as many images as the route truly needs removed.
   */
  offloadImages?: number
}

/**
 * Provider wordings that mean "this route could not decode one of the images in the
 * request", as case-insensitive regular-expression sources. Exported so a deployment
 * can see what is matched before adding a wording of its own.
 *
 * Deliberately narrow: each pattern names an image as the thing that failed to load,
 * decode, or be accepted, so an unrelated 400 that merely mentions an image does not
 * cost the session an image. A pattern that also matches a *byte*-budget rejection is
 * harmless — those already carry the offload code and are skipped first.
 */
export const DEFAULT_PATTERNS: readonly string[] = Object.freeze([
  'failed to load image',
  'failed to (?:decode|read|process) (?:the )?image',
  "can(?:no|')t load image",
  'unable to load image',
  'could not (?:load|decode|read) image',
  'invalid image (?:data|format|bytes|encoding)',
  'image format (?:is )?(?:not supported|unsupported|invalid)',
  'unsupported image (?:format|type|encoding)',
])

const DEFAULT_OFFLOAD_IMAGES = 1

/** HTTP statuses a decode rejection arrives with; the value is absent on text-classified adapters. */
const DECODE_REJECTION_STATUSES: readonly number[] = Object.freeze([400, 415])

function resolvePatterns(config: Config | undefined): readonly RegExp[] {
  const extra = config?.extraPatterns
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.some(source => typeof source !== 'string' || source.length === 0)) {
      throw new Error(`${name}: extraPatterns must be an array of non-empty regular-expression sources`)
    }
  }
  const sources = [...DEFAULT_PATTERNS, ...extra ?? []]
  try {
    return Object.freeze(sources.map(source => new RegExp(source, 'i')))
  } catch (cause) {
    // A malformed pattern must fail the mount, not silently shrink the matcher.
    throw new Error(`${name}: extraPatterns contains an invalid regular expression: ${String(cause)}`)
  }
}

function resolveOffloadImages(config: Config | undefined): number {
  const count = config?.offloadImages ?? DEFAULT_OFFLOAD_IMAGES
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`${name}: offloadImages must be a positive safe integer`)
  }
  return count
}

/**
 * Decide whether one failed request is a route's decode rejection.
 *
 * The offload code itself is never a candidate: a failure that already carries it is
 * either the route's own byte-budget report or a previous translation, and re-marking
 * it would replace the count that report chose.
 * @param failure - the failed request's published facts.
 * @param patterns - resolved decode-rejection patterns.
 * @returns whether the plugin should translate this failure.
 */
export function isCandidate(failure: RequestErrorPayload['failure'], patterns: readonly RegExp[]): boolean {
  if (failure.code === IMAGE_OFFLOAD_REQUIRED_CODE) return false
  if (failure.status !== undefined && !DECODE_REJECTION_STATUSES.includes(failure.status)) return false
  return patterns.some(pattern => pattern.test(failure.message))
}

/**
 * Mount the translator without configuration requirements.
 *
 * The listener is prepended: `dsh-compaction-image-offload` answers `next()` for any
 * failure whose code is not the offload code, so a translator registered after it
 * would substitute a failure nobody reads again.
 * @param ctx - the plugin context.
 * @param config - optional extra patterns and per-attempt occurrence count.
 */
export function apply(ctx: Context, config?: Config): void {
  const patterns = resolvePatterns(config)
  const offloadImages = resolveOffloadImages(config)

  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    if (!isCandidate(payload.failure, patterns)) return next()
    // Replaced rather than mutated: `LlmFailure`'s fields are readonly, so a
    // substitution is the only assignment the event's own types allow.
    payload.failure = {
      ...payload.failure,
      code: IMAGE_OFFLOAD_REQUIRED_CODE,
      offloadImages,
    }
    const action = await next()
    if (action?.kind !== 'retry') {
      ctx.logger.warn(
        '%s: translated a decode rejection into %s but nothing recovered it — mount "%s" to complete this recovery',
        name,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        '@deepseek-ai/dsh-compaction-image-offload',
      )
    }
    return action
  }, true)
}
