import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrate, newState } from '../src/state.ts'

test('nothing stored is a fresh state', () => {
  assert.deepEqual(migrate(null), newState())
})

test('a stored state comes back as it was', () => {
  const stored = { ...newState(), keys: [{ id: '01', label: 'Mine', hash: 'ab', createdAt: 1 }] }
  assert.deepEqual(migrate(structuredClone(stored)), stored)
})

test('a state from a newer version is refused, not misread', () => {
  assert.throws(() => migrate({ schema: 2 }), /newer than this version/)
})
