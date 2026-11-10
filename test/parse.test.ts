import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePlayback, parseQueue, parseTrack } from '../src/spotify/parse.ts'
import { playing, track } from './helpers/fakes.ts'

const AT = 1_000

test('a track, with what AzuraCast can carry', () => {
  const reading = parsePlayback(playing('abc', 5_000), AT)
  assert.equal(reading.kind, 'track')
  if (reading.kind !== 'track') return
  assert.equal(reading.playing, true)
  assert.equal(reading.progressMs, 5_000)
  assert.deepEqual(reading.track, {
    key: 'abc',
    title: 'Title abc',
    artists: ['Artist abc'],
    album: 'Album abc',
    durationMs: 200_000,
    isrc: 'USS1Z2600001',
    art: 'https://i.scdn.co/image/abc-640',
  })
})

test('no active device is nothing', () => {
  assert.deepEqual(parsePlayback(null, AT), { kind: 'nothing', at: AT })
})

test('a private session says nothing about what is on', () => {
  const reading = parsePlayback(
    playing('abc', 1, { device: { is_private_session: true } }),
    AT
  )
  assert.deepEqual(reading, { kind: 'other', at: AT })
})

test('an episode, an ad and no item are not tracks', () => {
  for (const overrides of [
    { currently_playing_type: 'episode', item: { type: 'episode', name: 'A show' } },
    { currently_playing_type: 'ad', item: null },
    { currently_playing_type: 'unknown', item: null },
    { item: null },
  ]) {
    assert.equal(parsePlayback(playing('abc', 1, overrides), AT).kind, 'other')
  }
})

test('a local file has no Spotify id: it is known by a hash', () => {
  const local = track('ignored', { id: null, is_local: true, uri: 'spotify:local:x' })
  const parsed = parseTrack(local)!
  assert.match(parsed.key, /^local-[0-9a-f]{16}$/)
  assert.equal(parseTrack(local)!.key, parsed.key)
})

test('a track with no artist or no title is not passed on as one', () => {
  assert.equal(parseTrack(track('a', { artists: [] })), null)
  assert.equal(parseTrack(track('a', { artists: [{ name: '  ' }] })), null)
  assert.equal(parseTrack(track('a', { name: ' \uFEFF\u0007 ' })), null)
  assert.equal(parseTrack(track('a', { name: 42 })), null)
})

test('blank artists are dropped, and ten is the most', () => {
  const artists = [{ name: '' }, ...Array.from({ length: 15 }, (_, i) => ({ name: `A${i}` }))]
  assert.equal(parseTrack(track('a', { artists }))!.artists.length, 10)
})

test('an ISRC in the wrong shape is left out; one with hyphens is normalised', () => {
  assert.equal(parseTrack(track('a', { external_ids: { isrc: 'nope' } }))!.isrc, undefined)
  assert.equal(parseTrack(track('a', { external_ids: {} }))!.isrc, undefined)
  assert.equal(parseTrack(track('a', { external_ids: undefined }))!.isrc, undefined)
  assert.equal(
    parseTrack(track('a', { external_ids: { isrc: 'us-s1z-26-00001' } }))!.isrc,
    'USS1Z2600001'
  )
})

test('a position past the track is held at its end, and a strange one is left out', () => {
  const past = parsePlayback(playing('a', 999_999), AT)
  assert.equal(past.kind === 'track' && past.progressMs, 200_000)
  const strange = parsePlayback(playing('a', -5), AT)
  assert.equal(strange.kind === 'track' && strange.progressMs, undefined)
  const missing = parsePlayback(playing('a', 0, { progress_ms: null }), AT)
  assert.equal(missing.kind === 'track' && missing.progressMs, undefined)
})

test('anything in the answer may be missing or the wrong type', () => {
  for (const nonsense of [{}, [], 'text', 7, { item: 7 }, { item: { artists: 'x' } }]) {
    assert.equal(parsePlayback(nonsense, AT).kind, 'other')
  }
})

test('a queue skips what is not a track', () => {
  const { currentKey, queue } = parseQueue({
    currently_playing: track('a'),
    queue: [track('b'), { type: 'episode', name: 'A show' }, null, track('c')],
  })
  assert.equal(currentKey, 'a')
  assert.deepEqual(queue.map((t) => t.key), ['b', 'c'])
  assert.deepEqual(parseQueue(null).queue, [])
})

test('the largest cover is used, and only from an https address', () => {
  const cover = (images: unknown) => parseTrack(track('a', { album: { name: 'A', images } }))!.art
  assert.equal(
    cover([
      { url: 'https://i.scdn.co/small', width: 64 },
      { url: 'https://i.scdn.co/large', width: 640 },
    ]),
    'https://i.scdn.co/large'
  )
  assert.equal(cover([{ url: 'http://i.scdn.co/plain', width: 640 }]), undefined)
  assert.equal(cover([{ url: 'javascript:alert(1)', width: 640 }]), undefined)
  assert.equal(cover([{ url: 'https://user:pass@i.scdn.co/x', width: 640 }]), undefined)
  assert.equal(cover('nonsense'), undefined)
  assert.equal(cover([]), undefined)
  assert.equal(cover([{ url: 'https://i.scdn.co/unsized' }]), 'https://i.scdn.co/unsized')
})
