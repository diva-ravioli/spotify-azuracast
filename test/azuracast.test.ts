/**
 * Held to AzuraCast's own API description (scripts/fetch-azuracast.mjs fetches
 * it): what this adapter answers is checked against the schemas AzuraCast
 * publishes for the same endpoints, so code written for AzuraCast can read it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Ajv } from 'ajv'
import { parse } from 'yaml'
import { NOW_PLAYING, QUEUE, keyed, playing, track } from './helpers/fakes.ts'

const description = parse(
  readFileSync(join(import.meta.dirname, '..', '.azuracast', 'openapi.yml'), 'utf8')
) as { components: { schemas: Record<string, unknown> } }

/** OpenAPI 3.0 is nearly JSON Schema: `type: any` is the one thing in these that isn't. */
function asJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(asJsonSchema)
  if (!node || typeof node !== 'object') return node
  const entries = Object.entries(node).filter(([key, value]) => !(key === 'type' && value === 'any'))
  return Object.fromEntries(entries.map(([key, value]) => [key, asJsonSchema(value)]))
}

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true })
ajv.addSchema({ $id: 'azuracast', components: asJsonSchema(description.components) })
const schema = (name: string) => ({ $ref: `azuracast#/components/schemas/${name}` })
const validators = {
  nowPlaying: ajv.compile(schema('Api_NowPlaying')),
  all: ajv.compile({ type: 'array', items: schema('Api_NowPlaying') }),
  // What AzuraCast's queue answers: its StationQueueDetailed extends StationQueue.
  queue: ajv.compile({
    type: 'array',
    items: { allOf: [schema('Api_NowPlaying_StationQueue'), schema('Api_StationQueueDetailed')] },
  }),
  error: ajv.compile(schema('Api_Error')),
}

function valid(kind: keyof typeof validators, body: unknown) {
  const validate = validators[kind]
  assert.ok(validate(body), JSON.stringify({ errors: validate.errors, body }, null, 1))
}

/** Asks all three endpoints, checks each, and answers the station's. */
async function askAll(ask: Awaited<ReturnType<typeof keyed>>['ask']) {
  const one = await ask(NOW_PLAYING)
  assert.equal(one.status, 200)
  const nowPlaying = await one.json()
  valid('nowPlaying', nowPlaying)
  const all = await (await ask('/api/nowplaying')).json()
  valid('all', all)
  const queue = await (await ask(QUEUE)).json()
  valid('queue', queue)
  return { nowPlaying, queue }
}

test('a whole listening session is what AzuraCast says, at every step', async () => {
  const { ask, spotify, clock } = await keyed()
  const steps: Record<string, unknown> = {}
  const step = async (label: string) => {
    const { nowPlaying, queue } = await askAll(ask)
    steps[label] = {
      online: nowPlaying.is_online,
      now: nowPlaying.now_playing.song.title,
      next: nowPlaying.playing_next?.song.title ?? null,
      queued: queue.length,
      history: nowPlaying.song_history.map((entry: { song: { title: string } }) => entry.song.title),
    }
    clock.advance(5_000)
  }

  spotify.playback = playing('a', 190_000)
  spotify.queue = [track('b'), track('c')]
  await step('a starts')
  spotify.playback = playing('a', 195_500, { is_playing: false })
  await step('a paused')
  spotify.playback = playing('a', 195_500)
  await step('a resumed')
  clock.advance(1_000)
  spotify.playback = playing('b', 1_500)
  spotify.queue = [track('c')]
  await step('b starts')
  spotify.playback = playing('c', 300)
  spotify.queue = []
  await step('c seen')
  spotify.playback = playing('c', 5_300)
  await step('c counts')
  spotify.playback = playing('c', 0, { currently_playing_type: 'ad', item: null })
  await step('ad seen')
  clock.advance(6_000)
  await step('ad counts')
  spotify.playback = null
  await step('nothing seen')
  clock.advance(6_000)
  await step('nothing counts')
  spotify.playback = playing('c', 60_000)
  await step('c again')

  const offline = 'Station Offline'
  assert.deepEqual(steps, {
    'a starts': { online: true, now: 'Title a', next: 'Title b', queued: 2, history: [] },
    'a paused': { online: false, now: 'Title a', next: 'Title b', queued: 2, history: [] },
    'a resumed': { online: true, now: 'Title a', next: 'Title b', queued: 2, history: [] },
    'b starts': { online: true, now: 'Title b', next: 'Title c', queued: 1, history: ['Title a'] },
    'c seen': { online: true, now: 'Title b', next: 'Title c', queued: 1, history: ['Title a'] },
    'c counts': { online: true, now: 'Title c', next: null, queued: 0, history: ['Title b', 'Title a'] },
    'ad seen': { online: true, now: 'Title c', next: null, queued: 0, history: ['Title b', 'Title a'] },
    'ad counts': { online: false, now: offline, next: null, queued: 0, history: ['Title b', 'Title a'] },
    'nothing seen': { online: false, now: offline, next: null, queued: 0, history: ['Title b', 'Title a'] },
    'nothing counts': { online: false, now: offline, next: null, queued: 0, history: ['Title b', 'Title a'] },
    'c again': { online: true, now: 'Title c', next: null, queued: 0, history: ['Title b', 'Title a'] },
  })
})

test('a song says what AzuraCast would, and its times are in seconds', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 30_000, {
    item: track('a', { artists: [{ name: 'One' }, { name: 'Two' }] }),
  })
  spotify.queue = [track('b'), track('c', { duration_ms: 61_500 })]
  const started = clock.ms - 30_000
  assert.equal((await askAll(ask)).nowPlaying.now_playing.elapsed, 30)
  // Spotify was read once, and the time goes on without asking it again.
  clock.advance(3_000)
  const { nowPlaying, queue } = await askAll(ask)
  assert.deepEqual(nowPlaying.now_playing.song, {
    id: 'a',
    art: 'https://i.scdn.co/image/a-640',
    custom_fields: [],
    text: 'One, Two - Title a',
    artist: 'One, Two',
    title: 'Title a',
    album: 'Album a',
    genre: '',
    isrc: 'USS1Z2600001',
    lyrics: '',
  })
  const current = nowPlaying.now_playing
  assert.equal(current.played_at, Math.floor(started / 1000))
  assert.equal(current.duration, 200)
  assert.equal(current.elapsed, 33)
  assert.equal(current.remaining, 167)
  assert.equal(queue[0].played_at, Math.floor((started + 200_000) / 1000))
  assert.equal(queue[1].played_at, Math.floor((started + 400_000) / 1000))
  assert.equal(queue[1].duration, 61.5)
  assert.equal(nowPlaying.station.shortcode, 'spotify')
  assert.equal(nowPlaying.station.name, 'The Owner on Spotify')
})

test('text at its worst is cut, never refused', async () => {
  const { ask, spotify } = await keyed()
  const long = '𝄞'.repeat(2_000)
  const hostile = (id: string) =>
    track(id, {
      name: `  ${long}\u0007\n`,
      artists: Array.from({ length: 30 }, (_, i) => ({ name: `\u0000${i}${long}` })),
      album: { name: long, images: [{ url: 'javascript:alert(1)' }] },
      duration_ms: 86_400_001,
      external_ids: { isrc: 'not an isrc' },
    })
  spotify.playback = { ...playing('a', 5_000), item: hostile('a') }
  spotify.queue = Array.from({ length: 30 }, (_, i) => hostile(`q${i}`))
  const { nowPlaying, queue } = await askAll(ask)
  assert.equal(Array.from(nowPlaying.now_playing.song.title as string).length, 300)
  assert.equal(nowPlaying.now_playing.song.art, '')
  assert.equal(queue.length, 20)
})

test('every other shape of answer is valid too', async () => {
  const { ask, spotify, clock } = await keyed()
  const shapes = [
    null,
    playing('a', 5_000, { is_playing: false }),
    playing('b', 0, { progress_ms: null }),
    playing('c', 5_000, { item: track('c', { duration_ms: undefined, album: undefined }) }),
    playing('d', 5_000, { item: track('d', { is_local: true, id: null }) }),
    playing('e', 5_000, { currently_playing_type: 'episode', item: { type: 'episode' } }),
    playing('f', 5_000, { device: { is_private_session: true } }),
  ]
  for (const playback of shapes) {
    spotify.playback = playback
    spotify.queue = [track('q')]
    clock.advance(20_000)
    await askAll(ask)
    clock.advance(20_000)
    await askAll(ask)
  }
})

test('every error is in AzuraCast’s shape', async () => {
  const { ask, app, spotify } = await keyed()
  const bodies = [
    await app.handle(new Request('https://adapter.fake.test/api/nowplaying/spotify')),
    await ask(NOW_PLAYING, { Authorization: 'Bearer wrong' }),
    await ask('/api/nowplaying/another'),
    await ask(NOW_PLAYING, {}, 'POST'),
  ]
  spotify.failPlayer = () => new Response(null, { status: 503 })
  bodies.push(await ask(NOW_PLAYING))
  assert.deepEqual(
    bodies.map((response) => response.status),
    [401, 401, 404, 405, 503]
  )
  for (const response of bodies) valid('error', await response.json())
})
