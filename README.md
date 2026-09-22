# @argszero/cordis-plugin-image-offload-fallback

Recover a session wedged by an image the route cannot decode, by translating that
rejection into the image-offload recovery `deepseek-harness` already ships.

## The failure this closes

A provider can declare image input and still fail to decode one encoding. A local
`llama.cpp` vision server does exactly that: its `stb` loader rejects WebP, so a WebP
screenshot makes the server answer

```
400 {"error":{"message":"Failed to load image or audio file", ...}}
```

on every request that carries the attachment. The attachment is durable before the
first failure, so every later turn replays it and every compaction replays the same
prefix — the session never recovers, and nothing in the product offers a way out.

The harness *does* have a recovery for the neighbouring condition. A failure whose
code is `IMAGE_OFFLOAD_REQUIRED` and which carries `offloadImages` reaches
`@deepseek-ai/dsh-compaction-image-offload`, which permanently replaces that many of
the oldest retained image occurrences with placeholder text and retries — without
spending provider retry budget. The base bundle mounts that executor by default
(id `image-offload`, `packages/bundle/base/cordis.patch.yml`).

But only a route's **byte-budget** rejection raises that code. A **decode** rejection
is flattened by both adapters to `INVALID_REQUEST`, so it never reaches the executor
and the session stays wedged. This plugin is that missing translation, applied from
outside the core packages.

## Install

```sh
npm install @argszero/cordis-plugin-image-offload-fallback
```

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
answers `next()` for any code other than the offload code. When a failure looks like
a decode rejection, it substitutes the same failure with
`code: 'IMAGE_OFFLOAD_REQUIRED'` and `offloadImages: <n>`. The executor then does the
work it already does for byte-budget rejections: mark the oldest retained
occurrence(s), retry, and record a durable `image/offload` event.

Detection keys on `failure.message`, **never** on the code — the code is exactly the
information the adapters discard (`INVALID_REQUEST` also covers malformed and
oversized requests, so branching on it would catch unrelated failures). A candidate
must also be an image-shaped wording and, when a status is present, one a decode
rejection arrives with (`400` or `415`).

The default matcher is deliberately narrow. Add your route's wording if it stays
quiet:

```yaml
- id: image-offload-fallback
  name: '@argszero/cordis-plugin-image-offload-fallback'
  config:
    extraPatterns:
      - 'cannot display this picture'
    offloadImages: 1
```

| option | default | meaning |
|---|---|---|
| `extraPatterns` | `[]` | additional case-insensitive regex sources, appended to the built-in set |
| `offloadImages` | `1` | retained occurrences to request per attempt |

If the executor is not mounted, the plugin stays inert and logs which package is
missing — it never claims a recovery it did not get.

## Honest boundaries

- **The log keeps the image.** The plugin changes the *request*, not the durable
  session content: the executor marks occurrences and records an `image/offload`
  event, and the harness's own machinery decides what is replayed. It does not delete
  anything from your session file.
- **The model is not told.** Nothing here informs the model that an image was dropped;
  it sees the transparent placeholder the executor writes, exactly as it would for a
  byte-budget offload.
- **Prevention belongs upstream.** The right long-term shape is transcoding the image
  to an encoding the route accepts, inside `readImageRequest` — which needs the route's
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
`@deepseek-ai/dsh-compaction-image-offload`, not a hand-written stand-in — the
"published executor" arm is what proves the translator feeds the real consumer, and
an unmounted-executor arm is what proves the plugin does not fabricate a recovery.

## Licence

MIT
