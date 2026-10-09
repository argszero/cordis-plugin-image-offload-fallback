/**
 * Recover a session wedged by an image its route cannot serve, by handing the
 * harness's existing image-offload recovery a failure it acts on.
 *
 * Two failures wedge a session the same way — one durable image occurrence that can
 * never be served, replayed by every later request:
 *
 * 1. the route cannot **decode** the attachment's encoding. llama.cpp's stb loader
 *    rejects WebP, so a WebP screenshot makes an OpenAI-compatible local vision server
 *    answer 400 `Failed to load image or audio file` (discussion #7406);
 * 2. the attachment **object is gone**. History stores only the reference, so bytes are
 *    re-read from the store before every request; an object deleted outside the harness
 *    fails every later turn, including plain-text ones, and compaction replays the same
 *    prefix (discussions #7582, #9262).
 *
 * The harness already recovers from "this route's request must carry fewer images": a
 * failure whose `code` is `IMAGE_OFFLOAD_REQUIRED` and which carries `offloadImages`
 * reaches `dsh-compaction-image-offload`, which durably replaces that many of the
 * oldest retained occurrences with placeholder text and retries without spending
 * provider retry budget. Only a route's *byte-budget* rejection raises that code, so
 * neither failure above reaches the executor on its own. This plugin closes both gaps
 * from the outside, on `agent/request-error`:
 *
 * - **decode rejection** — recognized by wording (and status), translated into the
 *   offload code, so the executor performs the recovery;
 * - **missing object** — recognized by *probing* the store, never by wording. The
 *   published failure is a closed projection that carries no cause, and the same
 *   message and code are produced by unrelated failures (a TLS-inspection proxy
 *   surfaces the identical `DeepSeek Messages transport failed` / `TRANSPORT` —
 *   discussion #9266), so the only trustworthy discriminator is asking the store. The
 *   plugin probes every retained image occurrence, records an `image/offload` selection
 *   for exactly the occurrences the store no longer holds, and retries.
 *
 * @module @argszero/cordis-plugin-image-offload-fallback
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'

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

/**
 * The attachment store's code for "the durable object is not there", mirrored from
 * `@deepseek-ai/dsh-attachment-local`'s `readImageFile` — the only place the harness
 * raises it.
 *
 * It is the one code the probe treats as evidence, because a deleted object is the
 * only attachment failure that a retry can never fix. `ATTACHMENT_CORRUPT` and
 * `ATTACHMENT_READ_FAILED` are deliberately outside the default set: they are equally
 * unfixable but they are not this report's failure, and widening the default would
 * silently drop a user's image over a transient read error. Deployments that want them
 * can add the code through `missingAttachmentCodes`.
 */
export const MISSING_ATTACHMENT_CODE = 'ATTACHMENT_NOT_FOUND'

/** The durable selection the harness's image-offload executor records and replays. */
const IMAGE_OFFLOAD_EVENT = 'image/offload'

/** The package whose message projection turns a recorded selection into placeholder text. */
const EXECUTOR_PACKAGE = '@deepseek-ai/dsh-compaction-image-offload'

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
   * Retained occurrences to request per attempt on the decode path. Defaults to 1 — the
   * smallest step that can unblock the request, so a session that holds an older
   * decodable image loses only as many images as the route truly needs removed.
   *
   * It does not apply to the missing-object path, which names the exact occurrences the
   * store no longer holds instead of counting from the oldest.
   */
  offloadImages?: number
  /**
   * Probe the attachment store for objects that no longer exist when an image-bearing
   * request fails. Defaults to true; disable it when a deployment would rather pay the
   * failure than the probe.
   */
  recoverMissingAttachments?: boolean
  /**
   * Attachment failure codes the probe treats as proof that the object is unusable,
   * replacing the default `['ATTACHMENT_NOT_FOUND']`. Add `ATTACHMENT_CORRUPT` to also
   * recover a history whose stored bytes no longer match their reference.
   */
  missingAttachmentCodes?: readonly string[]
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

function resolveMissingCodes(config: Config | undefined): readonly string[] {
  const codes = config?.missingAttachmentCodes ?? [MISSING_ATTACHMENT_CODE]
  if (!Array.isArray(codes) || codes.length === 0
    || codes.some(code => typeof code !== 'string' || code.length === 0)) {
    throw new Error(`${name}: missingAttachmentCodes must be a nonempty array of non-empty strings`)
  }
  return Object.freeze([...codes])
}

function resolveRecoverMissing(config: Config | undefined): boolean {
  const enabled = config?.recoverMissingAttachments ?? true
  if (typeof enabled !== 'boolean') {
    throw new Error(`${name}: recoverMissingAttachments must be a boolean`)
  }
  return enabled
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

/** One retained input-image occurrence on the current surface, in model-visible order. */
export interface ImageOccurrence {
  /** Current message-producing event holding this occurrence. */
  readonly seq: SessionSeq
  /** Zero-based index among every image of that message, already-offloaded ones included. */
  readonly imageIndex: number
  /** The durable reference the request would re-read. */
  readonly attachment: ImageAttachmentRef
}

/**
 * Enumerate every retained image occurrence a request would serve, in request order.
 *
 * The walk is the harness executor's own (`offloadOldestImages`): current surface nodes
 * only, `user/message` and `tool/result` only, and an index that counts every image of a
 * message including the already-offloaded ones — the index space the durable selection
 * is defined in. Already-offloaded occurrences are skipped: their bytes are no longer
 * read, and re-selecting one is refused by the projection.
 *
 * Reads the surface through `Session.eventAt`, which upstream deprecated for new
 * in-repo callers as a storage direction (the log will not stay fully resident); it is
 * still the only synchronous seq → event reader, and the harness's own offload executor,
 * region selector, pruner and token meter all walk the surface the same way. The caller
 * guards it, so a future removal degrades this plugin to a no-op rather than failing the
 * request.
 * @param session - session whose next request replays these occurrences.
 * @returns the occurrences, oldest first.
 */
export function collectImageOccurrences(session: Session): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = []
  for (const seq of session.surface.nodes) {
    // oxlint-disable-next-line typescript/no-deprecated -- surface walk, as the harness executor does
    const event = session.eventAt(seq)
    if (event === undefined || (event.type !== 'user/message' && event.type !== 'tool/result')) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    let imageIndex = 0
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (block.offloaded !== true) occurrences.push({ seq, imageIndex, attachment: block.attachment })
      imageIndex += 1
    }
  }
  return occurrences
}

/**
 * Ask the store which of these occurrences it can no longer serve.
 *
 * Every distinct attachment is probed once, through the same read the failing request
 * made (`AttachmentStore.readImage`), so the answer describes the real object rather
 * than the reference. Only a listed code counts as missing: an unreadable-but-present
 * object, a hostile service, or a cancellation leaves the failure exactly as it was.
 * Present objects are re-probed on every failure on purpose — an object can be deleted
 * at any moment and no cached "present" answer would ever notice.
 * @param occurrences - occurrences to probe, in request order.
 * @param attachments - the mounted attachment service.
 * @param codes - codes that prove the object cannot be served.
 * @param signal - the failed step's cancellation signal.
 * @returns the occurrences whose object is gone, in request order.
 * @throws the signal reason when the step was cancelled mid-probe.
 */
export async function findMissingOccurrences(
  occurrences: readonly ImageOccurrence[],
  attachments: AttachmentStore,
  codes: readonly string[],
  signal?: AbortSignal,
): Promise<ImageOccurrence[]> {
  const probed = new Map<string, boolean>()
  for (const occurrence of occurrences) {
    const id = String(occurrence.attachment.attachmentId)
    if (probed.has(id)) continue
    let missing = false
    try {
      await attachments.readImage(occurrence.attachment, signal)
    } catch (error) {
      // Cancellation is not evidence about the object.
      if (signal?.aborted === true) throw error
      missing = attachments.isAttachmentError(error) && codes.includes(error.code)
    }
    probed.set(id, missing)
  }
  return occurrences.filter((occurrence) => probed.get(String(occurrence.attachment.attachmentId)) === true)
}

/**
 * Record one durable selection omitting exactly these occurrences.
 *
 * The selection is the same shape the harness executor writes, and it is read by the
 * executor's message projection, which replaces the selected occurrences with
 * placeholder text *before* any adapter touches the store — so the retry that follows
 * cannot re-read the missing object.
 * @param session - session whose next request applies the decision.
 * @param occurrences - occurrences to omit, in request order.
 * @throws when the selection is not admissible (an occurrence is no longer a current
 *   surface node, or the data is rejected by the projection).
 */
export function recordOffload(session: Session, occurrences: readonly ImageOccurrence[]): void {
  const bySeq = new Map<SessionSeq, number[]>()
  for (const occurrence of occurrences) {
    const indexes = bySeq.get(occurrence.seq)
    if (indexes === undefined) bySeq.set(occurrence.seq, [occurrence.imageIndex])
    else indexes.push(occurrence.imageIndex)
  }
  session.append(IMAGE_OFFLOAD_EVENT, {
    targets: [...bySeq].map(([seq, imageIndexes]) => ({ seq, imageIndexes: imageIndexes.sort((a, b) => a - b) })),
  })
}

/** Per-reason once-only warning, so a repeated failure does not flood the log. */
type WarnOnce = (reason: string, message: string, ...args: unknown[]) => void

/**
 * Probe and repair one failed request, if its images are the reason it failed.
 * @param ctx - the plugin context; both services are read optionally.
 * @param payload - the failed request's published facts.
 * @param codes - attachment failure codes that prove the object is gone.
 * @param warnOnce - once-per-reason warning sink.
 * @returns whether a durable selection was recorded and the step should be retried.
 */
async function recoverMissingAttachments(
  ctx: Context,
  payload: RequestErrorPayload,
  codes: readonly string[],
  warnOnce: WarnOnce,
): Promise<boolean> {
  // Read optionally rather than declaring an injection: a deployment without an
  // attachment store still gets the decode-rejection translation, and a plugin whose
  // required service is absent is dropped from the loader entirely.
  const attachments = ctx.get('attachments')
  const session: Session | undefined = payload.agent?.session
  if (attachments === undefined || session === undefined) return false

  let occurrences: ImageOccurrence[]
  try {
    occurrences = collectImageOccurrences(session)
  } catch (error) {
    warnOnce('surface', '%s: could not read the session surface to probe attachments: %s', name, String(error))
    return false
  }
  if (occurrences.length === 0) return false

  let missing: ImageOccurrence[]
  try {
    missing = await findMissingOccurrences(occurrences, attachments, codes, payload.signal)
  } catch {
    // A cancelled step or an unusable store leaves the original failure alone.
    return false
  }
  if (missing.length === 0) return false

  const projections = ctx.get('sessions')?.messageProjections
  if (projections?.some(projection => projection.type === IMAGE_OFFLOAD_EVENT) !== true) {
    // Recording the selection without its interpreter would look like a recovery while
    // every retry re-reads the same object — a loop, not a fix. Say so instead.
    warnOnce(
      'projection',
      '%s: %d image attachment(s) are missing from the store, but no "%s" projection is mounted to apply an offload — mount "%s" to recover',
      name,
      missing.length,
      IMAGE_OFFLOAD_EVENT,
      EXECUTOR_PACKAGE,
    )
    return false
  }

  try {
    recordOffload(session, missing)
  } catch (error) {
    warnOnce('append', '%s: could not record the image offload selection: %s', name, String(error))
    return false
  }
  return true
}

/**
 * Mount the recovery without configuration requirements.
 *
 * The listener is prepended: `dsh-compaction-image-offload` answers `next()` for any
 * failure whose code is not the offload code, so a translator registered after it
 * would substitute a failure nobody reads again.
 * @param ctx - the plugin context.
 * @param config - optional extra patterns, counts, and probe settings.
 */
export function apply(ctx: Context, config?: Config): void {
  const patterns = resolvePatterns(config)
  const offloadImages = resolveOffloadImages(config)
  const missingCodes = resolveMissingCodes(config)
  const recoverMissing = resolveRecoverMissing(config)

  const warned = new Set<string>()
  const warnOnce: WarnOnce = (reason, message, ...args) => {
    if (warned.has(reason)) return
    warned.add(reason)
    ctx.logger.warn(message, ...args)
  }

  ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
    if (recoverMissing && await recoverMissingAttachments(ctx, payload, missingCodes, warnOnce)) {
      // A durable surface repair, not a provider retry: it spends no retry budget.
      return { kind: 'retry' }
    }
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
        EXECUTOR_PACKAGE,
      )
    }
    return action
  }, true)
}
