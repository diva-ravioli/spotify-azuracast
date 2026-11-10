import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nowPlayingOf } from '../src/azuracast/nowplaying.ts'
import {
  MAX_HISTORY,
  expectedEnd,
  newTracker,
  observe,
  observeQueue,
  queueStarts,
  type Reading,
  type TrackInfo,
  type Tracker,
} from '../src/tracker.ts'

const START = Date.parse('2026-11-06T12:00:00.000Z')
const info = (key: string, durationMs = 200_000): TrackInfo => ({
  key,
  title: `Title ${key}`,
  artists: [`Artist ${key}`],
  durationMs,
})
const on = (key: string, progressMs: number, at: number, playing = true): Reading => ({
  kind: 'track',
  track: info(key),
  playing,
  progressMs,
  at,
})
const nowId = (tracker: Tracker) => tracker.play?.sh
const said = (tracker: Tracker, at = START) => nowPlayingOf(tracker, { name: 'Test' }, at)

function started(key = 'a', at = START, progress = 5_000) {
  const tracker = newTracker()
  observe(tracker, on(key, progress, at))
  return tracker
}

test('the first reading counts at once', () => {
  const tracker = started()
  assert.equal(tracker.declared, 'playing')
  assert.equal(nowId(tracker), START / 1000)
})

test('reads that wobble a little either way change nothing kept, so nothing is written', () => {
  const tracker = started()
  const first = JSON.stringify(tracker)
  for (let i = 1; i <= 20; i++) {
    observe(tracker, on('a', 5_000 + i * 5_000 + (i % 2 ? 300 : -300), START + i * 5_000))
    assert.equal(JSON.stringify(tracker), first)
  }
})

test('a pause and a resume keep the id and count at once, and change the timing', () => {
  const tracker = started()
  const id = nowId(tracker)
  observe(tracker, on('a', 10_000, START + 5_000, false))
  assert.equal(tracker.declared, 'paused')
  assert.equal(nowId(tracker), id)
  assert.equal(said(tracker, START + 60_000).now_playing.elapsed, 10, 'a paused track stands still')
  assert.equal(expectedEnd(tracker), undefined, 'a paused track is not running towards an end')
  observe(tracker, on('a', 10_000, START + 65_000, true))
  assert.equal(tracker.declared, 'playing')
  assert.equal(nowId(tracker), id)
})

test('a seek keeps the id and moves the timing at once', () => {
  const tracker = started()
  const id = nowId(tracker)
  observe(tracker, on('a', 150_000, START + 5_000))
  assert.equal(nowId(tracker), id)
  assert.equal(said(tracker, START + 5_000).now_playing.elapsed, 150)
  observe(tracker, on('a', 0, START + 10_000))
  assert.equal(nowId(tracker), id, 'seeking back to the start is not another play')
})

test('another track flickering past is not declared', () => {
  const tracker = started()
  const id = nowId(tracker)
  observe(tracker, on('b', 300, START + 5_000))
  assert.equal(nowId(tracker), id)
  observe(tracker, on('a', 10_500, START + 6_000))
  assert.equal(nowId(tracker), id)
  assert.equal(tracker.candidate, null)
})

test('another track counts once it has held, by our clock', () => {
  const tracker = started()
  observe(tracker, on('b', 100, START + 5_000))
  assert.notEqual(tracker.play?.track.key, 'b')
  observe(tracker, on('b', 1_100, START + 6_000))
  assert.notEqual(tracker.play?.track.key, 'b')
  observe(tracker, on('b', 2_100, START + 7_000))
  assert.equal(tracker.play?.track.key, 'b')
})

test("another track counts at once when Spotify's clock says it has held", () => {
  const tracker = started()
  observe(tracker, on('b', 2_500, START + 5_000))
  assert.equal(tracker.play?.track.key, 'b')
})

test('another track paused has no running clock to go by: it must hold', () => {
  const tracker = started()
  observe(tracker, on('b', 90_000, START + 5_000, false))
  assert.notEqual(tracker.play?.track.key, 'b')
})

test('a track announced as next, arriving as the last one ends, needs no settling', () => {
  const tracker = started('a', START, 195_000)
  observeQueue(tracker, [info('b')], START)
  const end = expectedEnd(tracker)!
  // Fetched 1.5 s after the expected end: b has been on for only 1.5 s.
  observe(tracker, on('b', 1_500, end + 1_500))
  assert.equal(tracker.play?.track.key, 'b')
})

test('the track announced as next, arriving early, is a skip: it must settle', () => {
  const tracker = started('a', START, 5_000)
  observeQueue(tracker, [info('b')], START)
  observe(tracker, on('b', 500, START + 10_000))
  assert.equal(tracker.play?.track.key, 'a')
})

test('a queued track keeps when it was first seen as the queue moves up', () => {
  const tracker = started('a', START, 195_000)
  observeQueue(tracker, [info('b'), info('c')], START)
  const end = expectedEnd(tracker)!
  observe(tracker, on('b', 1_500, end + 1_500))
  assert.deepEqual(tracker.queue.map((queued) => queued.track.key), ['c'])
  observeQueue(tracker, [info('c'), info('d')], end + 2_000)
  assert.deepEqual(tracker.queue.map((queued) => queued.cuedAt), [START, end + 2_000])
})

test('the same track, queued behind itself, is still queued', () => {
  const tracker = started('a', START, 5_000)
  observeQueue(tracker, [info('a')], START)
  assert.equal(said(tracker).playing_next?.song.id, 'a')
})

test('a track repeating is another play, and the first goes into the history', () => {
  const tracker = started('a', START, 195_000)
  const first = nowId(tracker)!
  observeQueue(tracker, [info('a')], START)
  const end = expectedEnd(tracker)!
  observe(tracker, on('a', 2_000, end + 2_000))
  assert.ok(nowId(tracker)! > first)
  assert.deepEqual(tracker.history.map((past) => past.sh), [first])
})

test('a track stalled at its end is not another play', () => {
  const tracker = started('a', START, 195_000)
  const id = nowId(tracker)
  // Long past when it should have ended, and still at its end.
  observe(tracker, on('a', 199_000, START + 30_000))
  assert.equal(nowId(tracker), id)
})

test('the same track found mid-way long after its end is another play', () => {
  const tracker = started('a', START, 5_000)
  const id = nowId(tracker)
  observe(tracker, on('a', 60_000, START + 3_600_000))
  assert.notEqual(nowId(tracker), id)
})

test('a pause, or a pause and a resume, between two reads near its end is not another play', () => {
  const paused = started('a', START, 190_000)
  const id = nowId(paused)
  observe(paused, on('a', 195_500, START + 10_000, false))
  assert.equal(nowId(paused), id)
  const resumed = started('a', START, 190_000)
  const same = nowId(resumed)
  observe(resumed, on('a', 196_000, START + 15_000))
  assert.equal(nowId(resumed), same)
})

test('a short track repeating from its very start is another play', () => {
  const tracker = newTracker()
  const short = (progressMs: number, at: number): Reading => ({
    kind: 'track',
    track: info('s', 20_000),
    playing: true,
    progressMs,
    at,
  })
  observe(tracker, short(0, START))
  const id = nowId(tracker)
  observe(tracker, short(1_000, START + 21_000))
  assert.notEqual(nowId(tracker), id)
})

test('a track that ended and sits at its start, then is played again, is another play', () => {
  const tracker = started('a', START, 195_000)
  const id = nowId(tracker)
  // The end of a playlist: the player goes back to the start, and waits.
  observe(tracker, on('a', 0, START + 8_000, false))
  assert.equal(nowId(tracker), id, 'the same play, until someone plays it again')
  observe(tracker, on('a', 500, START + 3_600_000, true))
  assert.notEqual(nowId(tracker), id)
})

test('paused at the start, far from any end, then resumed, is the same play', () => {
  const tracker = started('a', START, 5_000)
  const id = nowId(tracker)
  observe(tracker, on('a', 0, START + 8_000, false))
  observe(tracker, on('a', 0, START + 60_000, true))
  assert.equal(nowId(tracker), id)
})

test('nothing on must hold before it counts: Spotify flickers', () => {
  const tracker = started()
  observe(tracker, { kind: 'nothing', at: START + 5_000 })
  assert.equal(tracker.declared, 'playing')
  observe(tracker, on('a', 15_000, START + 10_000))
  assert.equal(tracker.candidate, null)
  observe(tracker, { kind: 'nothing', at: START + 15_000 })
  observe(tracker, { kind: 'nothing', at: START + 20_000 })
  assert.equal(tracker.declared, 'playing')
  observe(tracker, { kind: 'nothing', at: START + 25_000 })
  assert.equal(tracker.declared, 'stopped')
  assert.equal(said(tracker).is_online, false)
  assert.equal(said(tracker).now_playing.song.title, 'Station Offline')
})

test('the same play coming back after stopping keeps its id and starts at once', () => {
  const tracker = started()
  const id = nowId(tracker)
  observe(tracker, on('a', 20_000, START + 15_000, false))
  observe(tracker, { kind: 'nothing', at: START + 20_000 })
  observe(tracker, { kind: 'nothing', at: START + 31_000 })
  assert.equal(tracker.declared, 'stopped')
  observe(tracker, on('a', 20_000, START + 60_000, true))
  assert.equal(tracker.declared, 'playing')
  assert.equal(nowId(tracker), id)
})

test('something unnamed must hold, then says nothing about what is on', () => {
  const tracker = started()
  observe(tracker, { kind: 'other', at: START + 5_000 })
  assert.equal(tracker.declared, 'playing')
  observe(tracker, { kind: 'other', at: START + 15_000 })
  assert.equal(tracker.declared, 'unknown')
  observeQueue(tracker, [info('b')], START + 15_000)
  const answer = said(tracker, START + 15_000)
  assert.equal(answer.now_playing.sh_id, 0)
  assert.equal(answer.playing_next, null)
})

test('a track after unknown counts at once, even at its very start', () => {
  const tracker = newTracker()
  observe(tracker, { kind: 'other', at: START })
  observe(tracker, on('a', 200, START + 5_000))
  assert.equal(tracker.declared, 'playing')
})

test('a long pause re-anchors now and then, and stays the same play', () => {
  const tracker = started()
  const id = nowId(tracker)
  observe(tracker, on('a', 10_000, START + 5_000, false))
  const first = tracker.play!.anchor.at
  observe(tracker, on('a', 10_000, START + 30 * 60_000, false))
  assert.equal(tracker.play!.anchor.at, first)
  observe(tracker, on('a', 10_000, START + 90 * 60_000, false))
  assert.ok(tracker.play!.anchor.at > first)
  assert.equal(nowId(tracker), id)
})

test('queued tracks carry when they should start, for as long as that can be told', () => {
  const tracker = started('a', START, 0)
  observeQueue(tracker, [info('b', 60_000), { ...info('c'), durationMs: undefined }, info('d')], START)
  assert.deepEqual(queueStarts(tracker), [START + 200_000, START + 260_000, undefined])
  observe(tracker, on('a', 5_000, START + 5_000, false))
  assert.deepEqual(queueStarts(tracker), [undefined, undefined, undefined], 'paused, nothing is due')
})

test('at most twenty tracks are queued, as many as Spotify gives', () => {
  const tracker = started()
  observeQueue(tracker, Array.from({ length: 30 }, (_, i) => info(`q${i}`)), START)
  assert.equal(tracker.queue.length, 20)
})

test('the history keeps the latest plays, the latest first, each when it started', () => {
  const tracker = started('a', START, 5_000)
  const keys = ['b', 'c', 'd', 'e', 'f', 'g', 'h']
  keys.forEach((key, i) => observe(tracker, on(key, 5_000, START + (i + 1) * 60_000)))
  assert.equal(tracker.history.length, MAX_HISTORY)
  assert.deepEqual(tracker.history.map((past) => past.track.key), ['g', 'f', 'e', 'd', 'c'])
  assert.equal(tracker.history[0]!.startedAt, START + 6 * 60_000 - 5_000)
})

test('each play gets a higher number than the last, even when they come fast', () => {
  const tracker = started('a', START, 5_000)
  const seen = [nowId(tracker)!]
  for (const [i, key] of ['b', 'c', 'd'].entries()) {
    observe(tracker, on(key, 5_000, START + 100 + i * 100))
    seen.push(nowId(tracker)!)
  }
  assert.deepEqual([...seen].sort((x, y) => x - y), seen)
  assert.equal(new Set(seen).size, seen.length)
})

test('stopping and starting the same play again adds nothing to the history', () => {
  const tracker = started()
  observe(tracker, { kind: 'nothing', at: START + 5_000 })
  observe(tracker, { kind: 'nothing', at: START + 20_000 })
  observe(tracker, on('a', 20_000, START + 60_000))
  assert.deepEqual(tracker.history, [])
})

test('the tracker survives JSON, which is how it is kept', () => {
  const tracker = started()
  observeQueue(tracker, [info('b')], START)
  const restored = JSON.parse(JSON.stringify(tracker)) as Tracker
  assert.deepEqual(said(restored), said(tracker))
})
