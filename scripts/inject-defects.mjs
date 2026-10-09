/**
 * Mutation arms for the missing-object probe.
 *
 * An arm mutates `src/index.ts`, rebuilds `lib/`, and runs the suite: an arm whose
 * suite stays green means the behaviour it disabled was never observed by a test —
 * SILENT, i.e. the harness failed, not the mutation. The control arm changes only a
 * comment and must stay green, which is what proves the harness can tell the two apart.
 *
 * Run from the package root: npm run test:arms
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'src/index.ts'

/** @type {{ name: string, find: string, replace: string, expect: 'CAUGHT'|'GREEN' }[]} */
const ARMS = [
  {
    name: 'probe-blind',
    find: '    probed.set(id, missing)',
    replace: '    probed.set(id, false)',
    expect: 'CAUGHT',
  },
  {
    name: 'probe-eager',
    find: '      missing = attachments.isAttachmentError(error) && codes.includes(error.code)',
    replace: '      missing = true',
    expect: 'CAUGHT',
  },
  {
    name: 'cancellation-read-as-evidence',
    find: '      if (signal?.aborted === true) throw error\n',
    replace: '',
    expect: 'CAUGHT',
  },
  {
    name: 'index-skips-offloaded-occurrences',
    find: '      if (block.offloaded !== true) occurrences.push({ seq, imageIndex, attachment: block.attachment })\n      imageIndex += 1',
    replace: '      if (block.offloaded !== true) {\n        occurrences.push({ seq, imageIndex, attachment: block.attachment })\n        imageIndex += 1\n      }',
    expect: 'CAUGHT',
  },
  {
    name: 'projection-guard-misses-the-registration',
    find: 'projection.type === IMAGE_OFFLOAD_EVENT',
    replace: "projection.type === 'image/offload-x'",
    expect: 'CAUGHT',
  },
  {
    name: 'no-recovery-signal',
    find: '  }\n  return true\n}',
    replace: '  }\n  return false\n}',
    expect: 'CAUGHT',
  },
  {
    name: 'selection-indexes-descending',
    find: 'imageIndexes.sort((a, b) => a - b)',
    replace: 'imageIndexes.sort((a, b) => b - a)',
    expect: 'CAUGHT',
  },
  {
    name: 'deployment-codes-ignored',
    find: 'attachments.isAttachmentError(error) && codes.includes(error.code)',
    replace: 'attachments.isAttachmentError(error) && codes.includes(MISSING_ATTACHMENT_CODE)',
    expect: 'CAUGHT',
  },
  {
    name: 'control-comment-only',
    find: ' * Recover a session wedged by an image its route cannot serve, by handing the',
    replace: ' * Recover a session wedged by an image its route cannot serve by handing the',
    expect: 'GREEN',
  },
]

const original = readFileSync(SOURCE, 'utf8')

function build() {
  execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.build.json'], { stdio: 'pipe' })
}

/** @returns {boolean} whether the suite is green. */
function suiteGreen() {
  try {
    execFileSync('node', ['--test', 'test/*.spec.mjs'], { stdio: 'pipe', shell: false })
    return true
  } catch {
    return false
  }
}

const results = []
for (const arm of ARMS) {
  const mutated = original.replace(arm.find, arm.replace)
  if (mutated === original) throw new Error(`arm ${arm.name}: anchor not found`)
  writeFileSync(SOURCE, mutated)
  let observed
  try {
    try {
      build()
    } catch {
      // The compiler refused the mutation outright — the strongest outcome: the
      // behaviour is pinned by the type, not only by a test.
      observed = 'BUILD-REFUSED'
    }
    if (observed === undefined) observed = suiteGreen() ? 'GREEN' : 'CAUGHT'
    // A compiler refusal is a `CAUGHT`: the behaviour is pinned by the type as well.
    const caught = observed === 'CAUGHT' || observed === 'BUILD-REFUSED'
    results.push({ name: arm.name, expect: arm.expect, observed, ok: arm.expect === 'CAUGHT' ? caught : observed === 'GREEN' })
  } finally {
    writeFileSync(SOURCE, original)
  }
}

build()
const green = suiteGreen()

for (const result of results) {
  console.log(`${result.ok ? '✔' : '✖'} ${result.name.padEnd(38)} expect=${result.expect} observed=${result.observed}`)
}
const silent = results.filter(result => result.expect === 'CAUGHT' && result.observed === 'GREEN')
console.log(`\narms=${results.length} CAUGHT=${results.filter(r => r.observed === 'CAUGHT').length} SILENT=${silent.length}`)
console.log(`restored source: suite ${green ? 'green' : 'RED'}`)
process.exitCode = silent.length === 0 && green && results.every(r => r.ok) ? 0 : 1
