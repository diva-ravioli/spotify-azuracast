/** Things that have to agree across files, and things this repository must not ship. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { VERSION } from '../src/version.ts'

const root = join(import.meta.dirname, '..')
const read = (name: string) => readFileSync(join(root, name), 'utf8')

test('the version is the same everywhere', () => {
  assert.equal(JSON.parse(read('package.json')).version, VERSION)
  assert.ok(read('CHANGELOG.md').includes(`## ${VERSION}`))
})

test('nothing at run time but the platform: no dependencies to install or update', () => {
  assert.equal(JSON.parse(read('package.json')).dependencies, undefined)
})

test('the licence is the one package.json names', () => {
  assert.equal(JSON.parse(read('package.json')).license, '0BSD')
  assert.match(read('LICENSE'), /BSD Zero Clause License/)
})
