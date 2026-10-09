/**
 * Guard against the two ways this package can ship broken while its own tests pass:
 * an import that survives into the artifact without a matching runtime declaration, and
 * an entry point the tarball does not actually contain.
 *
 * This is the check that caught a third plugin of ours importing `@deepseek-ai/schemastery`
 * from `lib/` while declaring it only as a devDependency — which installed cleanly from a
 * tarball (where the package happened to be resolvable anyway) and failed only under
 * `npm install <name>` from the registry.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']
const DECLARED_FIELDS = [...RUNTIME_FIELDS, 'devDependencies']

function walk(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else found.push(path)
  }
  return found
}

/**
 * The package a bare specifier belongs to: a subpath import (`pkg/projection`) is
 * satisfied by the declaration of `pkg`, so comparing package names is what makes this
 * check describe the tarball rather than the spelling of an import.
 * @param specifier - a bare module specifier.
 * @returns the package name, scope included.
 */
function packageOf(specifier) {
  const [first, second] = specifier.split('/')
  return first.startsWith('@') ? `${first}/${second}` : first
}

/**
 * Bare specifiers in one file, split by whether the import survives type erasure.
 * @param file - source or artifact path.
 * @returns runtime and type-only package names.
 */
function specifiersOf(file) {
  const text = readFileSync(file, 'utf8')
  const runtime = new Set()
  const typeOnly = new Set()
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) {
    const [, isTypeOnly, specifier] = match
    if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:')) continue
    ;(isTypeOnly === undefined ? runtime : typeOnly).add(packageOf(specifier))
  }
  return { runtime, typeOnly }
}

const artifacts = walk('lib').filter(path => path.endsWith('.js'))
const sources = walk('src').filter(path => path.endsWith('.ts'))

const runtimeNeeded = new Set(artifacts.flatMap(path => [...specifiersOf(path).runtime]))
const typeNeeded = new Set(sources.flatMap(path => [...specifiersOf(path).typeOnly]))

describe('published entry points', () => {
  it('ships every path its manifest advertises', () => {
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (key === './package.json') continue
      for (const path of Object.values(typeof target === 'string' ? { default: target } : target)) {
        const relative = path.replace(/^\.\//, '')
        const shipped = manifest.files.some(pattern => matchFile(pattern, relative))
        assert.ok(shipped, `${key} → ${path} is not covered by "files"`)
        assert.ok(existsSync(relative), `${key} → ${path} was never built`)
      }
    }
  })

  it('ships the patch that mounts it', () => {
    const patch = manifest.dsh.bundle.patch.replace(/^\.\//, '')
    assert.ok(manifest.files.includes(patch), `${patch} must be published`)
    assert.ok(existsSync(patch))
    assert.match(readFileSync(patch, 'utf8'), new RegExp(manifest.name.replace(/[/@.]/g, '\\$&')))
  })
})

/** Minimal `files` glob matcher covering `**` and `*`. */
function matchFile(pattern, relative) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
  return new RegExp(`^${escaped}$`).test(relative)
}

describe('dependency declarations', () => {
  it('declares every package the artifact imports at runtime', () => {
    const declared = new Set(RUNTIME_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {})))
    for (const specifier of runtimeNeeded) {
      assert.ok(declared.has(specifier), `${specifier} is imported by lib/ but not declared as a runtime dependency`)
    }
  })

  it('carries no runtime dependency it does not use', () => {
    for (const specifier of Object.keys(manifest.dependencies ?? {})) {
      assert.ok(runtimeNeeded.has(specifier), `${specifier} is declared but never imported at runtime`)
    }
  })

  it('declares every package the sources type-check against', () => {
    const declared = new Set(DECLARED_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {})))
    for (const specifier of typeNeeded) {
      assert.ok(declared.has(specifier), `${specifier} is imported for types but declared nowhere`)
    }
  })

  it('needs no runtime dependency at all', () => {
    // The mirror in `src/index.ts` is the reason: nothing this plugin needs at runtime
    // belongs to a harness package, so there is nothing for a deployment to resolve.
    assert.deepEqual([...runtimeNeeded], [])
  })
})
