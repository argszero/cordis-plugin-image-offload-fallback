# @argszero/cordis-plugin-image-offload-fallback

Recover a session wedged by an image its route cannot serve, by handing the
image-offload recovery `deepseek-harness` already ships a failure it acts on.

## The two failures this closes

Both leave **one durable image occurrence that can never be served**, so every later
request replays it, including plain-text turns and every compaction of the same prefix.
Nothing in the product offers a way out.

**1. The route cannot decode the encoding.** A provider can declare image input and
still fail on one encoding. A local `llama.cpp` vision server does exactly that: its
`stb` loader rejects WebP, so a WebP screenshot makes the server answer

```
400 {"error":{"message":"Failed to load image or audio file", ...}}
```

on every request carrying the attachment (discussion #7406).

**2. The attachment object is gone.** History stores only the reference, so the bytes
are re-read from the store before every request. An object removed outside the harness
— a cleanup job, a wiped `DSH_HOME`, a restored session log — makes the read fail
before the provider is even called, and the adapter publishes that as a generic
transport failure (discussions #7582, #9262). Compaction replays the very same prefix,
so the session never gets past it.

## Why the harness does not already recover

The harness *does* have a recovery for the neighbouring condition. A failure whose code
is `IMAGE_OFFLOAD_REQUIRED` and which carries `offloadImages` reaches
`@deepseek-ai/dsh-compaction-image-offload`, which permanently replaces that many of the
oldest retained image occurrences with placeholder text and retries — without spending
provider retry budget. The base bundle mounts that executor by default (id
`image-offload`, `packages/bundle/base/cordis.patch.yml`).

But only a route's **byte-budget** rejection raises that code. Neither failure above
does: a **decode** rejection is flattened by both adapters to `INVALID_REQUEST`, and a
**missing object** never reaches the adapter at all. This plugin closes both gaps from
outside the core packages.

## Install

```sh
dsh plugin --profile <profile> add github:argszero/cordis-plugin-image-offload-fallback
```

The git spec installs the tree this README describes; `npm install` on its own never attaches a plugin to a profile — `dsh plugin add` is what writes the row that makes it load.

Then mount it, e.g. in a profile overlay:

```yaml
- insert:
    - id: image-offload-fallback
      name: '@argszero/cordis-plugin-image-offload-fallback'
```

The package also ships `cordis.patch.yml`, so a bundle that reads `dsh.bundle.patch`
picks the entry up without you writing it.

## What it does

It listens on the `agent/request-error` waterfall — prepended, because the executor
answers `next()` for any code other than the offload code. On each failed request it
runs two mechanisms, in this order, and returns `{ kind: 'retry' }` when either one
repaired the session:

**Probe, then repair — the missing-object path.** The plugin walks the same surface the
executor walks (`user/message` and `tool/result` nodes, image indexes counted in
model-visible order) and asks the attachment store whether it can still serve each
occurrence. Occurrences whose read raises `ATTACHMENT_NOT_FOUND` are recorded in one
durable `image/offload` event naming **exactly those occurrences**, and the step is
retried.

The decision is made by asking the store, **never** by reading the failure's words. The
published `LlmFailure` is a closed projection that carries no cause, and the same
message and code are produced by unrelated failures — a TLS-inspection proxy surfaces
the identical `DeepSeek Messages transport failed` / `TRANSPORT` (discussion #9266).
Keying on that wording would silently drop a user's images over a network error, so the
probe is the only trustworthy discriminator: a store answer describes the real object,
a message does not.

**Translate — the decode path.** When the probe finds nothing (or is disabled), a
failure that looks like a decode rejection is substituted with the same failure carrying
`code: 'IMAGE_OFFLOAD_REQUIRED'` and `offloadImages: <n>`. The executor then does the
work it already does for byte-budget rejections: mark the oldest retained occurrence(s),
retry, and record the durable selection.

Detection here keys on `failure.message`, **never** on the code — the code is exactly
the information the adapters discard (`INVALID_REQUEST` also covers malformed and
oversized requests, so branching on it would catch unrelated failures). A candidate must
also be an image-shaped wording and, when a status is present, one a decode rejection
arrives with (`400` or `415`).

## Configuration

```yaml
- id: image-offload-fallback
  name: '@argszero/cordis-plugin-image-offload-fallback'
  config:
    extraPatterns:
      - 'cannot display this picture'
    offloadImages: 1
    missingAttachmentCodes:
      - ATTACHMENT_NOT_FOUND
      - ATTACHMENT_CORRUPT
```

| option | default | meaning |
|---|---|---|
| `extraPatterns` | `[]` | additional case-insensitive regex sources, appended to the built-in decode set |
| `offloadImages` | `1` | retained occurrences to request per attempt on the decode path |
| `recoverMissingAttachments` | `true` | probe the store for objects it can no longer serve |
| `missingAttachmentCodes` | `['ATTACHMENT_NOT_FOUND']` | store codes the probe treats as proof the object is unusable |

`offloadImages` does not apply to the missing-object path, which names the exact
occurrences that are gone instead of counting from the oldest. `ATTACHMENT_CORRUPT` is
deliberately **not** in the default set: it is equally unfixable, but a transient read
error should not cost the user an image. Add it if your deployment prefers recovery.

If the executor is not mounted, the plugin stays inert and says so — on the probe path
it names the package that would apply the selection, and on the decode path the package
that would complete the recovery. It never claims a recovery it did not get.

## Honest boundaries

- **The log keeps the image.** The plugin changes the *request*, not the durable session
  content: the executor marks occurrences and records an `image/offload` event, and the
  harness's own machinery decides what is replayed. It does not delete anything from your
  session file.
- **The model is not told.** Nothing here informs the model that an image was dropped; it
  sees the transparent placeholder the executor writes, exactly as it would for a
  byte-budget offload.
- **The probe costs one read per distinct attachment, on every failure.** Present objects
  are deliberately re-probed rather than cached: an object can be deleted at any moment,
  and a cached "present" answer would never notice. Disable the path with
  `recoverMissingAttachments: false` if a deployment would rather pay the failure.
- **Probing needs an attachment store.** The service is read optionally, so a deployment
  with a different attachment backend still gets the decode translation; without one the
  probe path is simply inert.
- **Prevention belongs upstream.** The right long-term shape is transcoding the image to
  an encoding the route accepts, inside `readImageRequest` — which needs the route's
  accepted media types in `ImageRequestTarget`, a change this plugin cannot make from
  outside. Until then this is recovery, not prevention.
- **A zero-width offload cannot help.** If the offending image is the only retained
  occurrence and the route rejects the placeholder-free request anyway, the executor
  exhausts its occurrences and the provider failure surfaces unchanged.

## Tests

```sh
npm test
```

The suite runs against a real `@deepseek-ai/cordis` and the **published**
`@deepseek-ai/dsh-compaction-image-offload`, not a hand-written stand-in: the "published
executor" arms are what prove the translator feeds the real consumer and that the
selection this plugin records is admitted by the shipped projection. The
"objects are all present" arm is the one that keeps the probe from reacting to the
`#9266` wording. `test/contract.spec.mjs` pins the mirrored `IMAGE_OFFLOAD_REQUIRED` and
`ATTACHMENT_NOT_FOUND` codes against the installed harness packages, so a rename fails
in development instead of silently turning this plugin into a no-op.

## Licence

MIT
