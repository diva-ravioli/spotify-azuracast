/**
 * What is on, decided from a stream of readings. Pure, and the heart of the
 * adapter: it tells one play from the next, settles flicker, keeps timing still
 * between reads, and remembers what played. Spotify's answers flicker and its
 * position changes on every read: what comes out of here doesn't.
 *
 * A tracker is plain JSON: it is persisted as it stands.
 */

export type PlayerState = 'playing' | 'paused' | 'stopped' | 'unknown'

/** Spotify gives up to 20 queued tracks. */
export const MAX_QUEUE = 20
/** As many plays as AzuraCast keeps in `song_history` by default. */
export const MAX_HISTORY = 5

export interface TrackInfo {
  /** What a track is compared by: its Spotify id, or a hash for a local file, which has none. */
  key: string
  title: string
  artists: string[]
  album?: string
  durationMs?: number
  isrc?: string
  /** The album's cover, from Spotify's image server. */
  art?: string
}

export type Reading =
  | { kind: 'track'; track: TrackInfo; playing: boolean; progressMs?: number; at: number }
  /** Nothing is on: no active device. */
  | { kind: 'nothing'; at: number }
  /** Something the adapter can't name or may not say: an episode, an ad, a private session. */
  | { kind: 'other'; at: number }

/** Where playback was, once. Moves only on a real jump, so timing doesn't change between reads. */
export interface Anchor {
  positionMs?: number
  at: number
  playing: boolean
  /** It ran out and the player went back to the start to wait, as at a playlist's end. */
  ended?: boolean
}

export interface Play {
  /** AzuraCast's `sh_id`: one number per play, always going up. */
  sh: number
  track: TrackInfo
  anchor: Anchor
}

/** A play that is over, for `song_history`. */
export interface PastPlay {
  sh: number
  track: TrackInfo
  startedAt: number
}

export interface QueuedTrack {
  track: TrackInfo
  /** When it was first seen in the queue: AzuraCast's `cued_at`. */
  cuedAt: number
}

export interface Tracker {
  declared: PlayerState | null
  /** The last play. Kept through `stopped` and `unknown`: the same play coming back is the same play. */
  play: Play | null
  queue: QueuedTrack[]
  /** A change seen but not yet declared. */
  candidate: { category: string; since: number } | null
  /** Plays that are over, the latest first. */
  history: PastPlay[]
  /** The last `sh` given out. */
  lastSh: number
}

export interface TrackerOptions {
  /** How long a change to another track must hold before it counts. */
  settleMs: number
  /** How long "nothing is on" or "can't tell" must hold before it counts: Spotify flickers. */
  stopSettleMs: number
}

export const DEFAULT_OPTIONS: TrackerOptions = { settleMs: 2_000, stopSettleMs: 10_000 }

/** A position further than this from where it should be is a jump, not drift. */
export const JUMP_MS = 2_000
/** Longer than this since the last read, and what we hold says nothing about now. */
const STALE_AFTER_MS = 30_000
/** How close to its end a track counts as finishing. */
const END_MARGIN_MS = 3_000
/** A long pause takes its anchor along now and then, so that it never says something ancient. */
const PAUSED_REANCHOR_MS = 60 * 60 * 1000

export const newTracker = (): Tracker => ({
  declared: null,
  play: null,
  queue: [],
  candidate: null,
  history: [],
  lastSh: 0,
})

function categoryOf(reading: Reading): string {
  if (reading.kind === 'track') return `track:${reading.track.key}`
  return reading.kind === 'nothing' ? 'stopped' : 'unknown'
}

function declaredCategory(tracker: Tracker): string | null {
  if (tracker.declared === 'playing' || tracker.declared === 'paused') {
    return `track:${tracker.play?.track.key}`
  }
  return tracker.declared
}

/** When the play on now should end, if it is playing and that can be told. */
export function expectedEnd(tracker: Tracker): number | undefined {
  if (tracker.declared !== 'playing' || !tracker.play) return undefined
  const { anchor, track } = tracker.play
  if (anchor.positionMs === undefined || !track.durationMs) return undefined
  return anchor.at - anchor.positionMs + track.durationMs
}

/** When a play started, as its anchor has it: moves with a seek, so start and elapsed add up to now. */
export const startOf = (play: Play) => play.anchor.at - (play.anchor.positionMs ?? 0)

/**
 * Whether the same track on now is another play of it. It must be running, past
 * where it should have ended, and not just late: not a seek (it had time left),
 * not a stall (it is still at its end), and not a pause between two reads (it
 * is a little behind). The "expected end passed" recipe alone counts all three.
 * After a long gap with no reads, a pause can't be told from a play: this errs
 * towards another play.
 */
function isAnotherPlay(play: Play, reading: Extract<Reading, { kind: 'track' }>): boolean {
  const { anchor, track } = play
  if (anchor.ended && reading.playing) return true
  if (!reading.playing || !anchor.playing || anchor.positionMs === undefined) return false
  if (reading.progressMs === undefined || !track.durationMs) return false
  const predicted = anchor.positionMs + (reading.at - anchor.at)
  if (predicted < track.durationMs - END_MARGIN_MS) return false
  if (reading.progressMs >= track.durationMs - END_MARGIN_MS) return false
  const wentBack = reading.progressMs < anchor.positionMs
  const farBehind = predicted - reading.progressMs > Math.min(30_000, track.durationMs / 2)
  return wentBack || farBehind
}

function ranOutAndReset(
  previous: Anchor,
  reading: Extract<Reading, { kind: 'track' }>,
  durationMs: number | undefined
): boolean {
  if (!previous.playing || reading.playing || !durationMs) return false
  if (previous.positionMs === undefined || reading.progressMs === undefined) return false
  const predicted = previous.positionMs + (reading.at - previous.at)
  return predicted >= durationMs - END_MARGIN_MS && reading.progressMs < END_MARGIN_MS
}

function nextAnchor(
  previous: Anchor,
  reading: Extract<Reading, { kind: 'track' }>,
  durationMs: number | undefined
): Anchor {
  const fresh: Anchor = {
    positionMs: reading.progressMs,
    at: reading.at,
    playing: reading.playing,
  }
  if (ranOutAndReset(previous, reading, durationMs)) return { ...fresh, ended: true }
  if (previous.ended && !reading.playing) fresh.ended = true
  if (previous.playing !== reading.playing) return fresh
  if (previous.positionMs === undefined || reading.progressMs === undefined) {
    return previous.positionMs === reading.progressMs ? previous : fresh
  }
  if (reading.playing) {
    const predicted = previous.positionMs + (reading.at - previous.at)
    return Math.abs(reading.progressMs - predicted) > JUMP_MS ? fresh : previous
  }
  const moved = Math.abs(reading.progressMs - previous.positionMs) > JUMP_MS
  return moved || reading.at - previous.at > PAUSED_REANCHOR_MS ? fresh : previous
}

function apply(tracker: Tracker, reading: Reading) {
  tracker.candidate = null
  if (reading.kind === 'nothing') {
    tracker.declared = 'stopped'
    return
  }
  if (reading.kind === 'other') {
    tracker.declared = 'unknown'
    return
  }
  const { track, at } = reading
  const play = tracker.play
  if (play && play.track.key === track.key && !isAnotherPlay(play, reading)) {
    play.anchor = nextAnchor(play.anchor, reading, play.track.durationMs)
  } else {
    if (play) {
      tracker.history = [
        { sh: play.sh, track: play.track, startedAt: startOf(play) },
        ...tracker.history,
      ].slice(0, MAX_HISTORY)
    }
    // From the clock, so that it still goes up if the state is ever lost.
    tracker.lastSh = Math.max(tracker.lastSh + 1, Math.floor(at / 1000))
    tracker.play = {
      sh: tracker.lastSh,
      track,
      anchor: { positionMs: reading.progressMs, at, playing: reading.playing },
    }
    // What was queued behind this track still is, until a new queue says otherwise.
    const place = tracker.queue.findIndex((queued) => queued.track.key === track.key)
    tracker.queue = place >= 0 ? tracker.queue.slice(place + 1) : []
  }
  tracker.declared = reading.playing ? 'playing' : 'paused'
}

/**
 * Whether a change may be declared without waiting. Settling guards against
 * flicker, not against news: what was queued next arriving when it should
 * isn't flicker, and waiting for it would delay every ordinary track change.
 */
function declaresAtOnce(tracker: Tracker, reading: Reading, options: TrackerOptions): boolean {
  if (tracker.declared === null) return true
  if (reading.kind !== 'track') return false
  // Starting from nothing: there is no play on now to protect.
  if (tracker.declared === 'stopped' || tracker.declared === 'unknown') return true
  // Spotify's own clock says it has held.
  if (reading.playing && (reading.progressMs ?? 0) >= options.settleMs) return true
  const end = expectedEnd(tracker)
  return (
    tracker.queue[0]?.track.key === reading.track.key &&
    end !== undefined &&
    reading.at >= end - END_MARGIN_MS
  )
}

/**
 * Takes in a reading: what is on may change. `previousReadAt` is when Spotify was
 * last read: after a long gap there is no flicker to guard against, only a play
 * on now that stopped being true long ago.
 */
export function observe(
  tracker: Tracker,
  reading: Reading,
  options: TrackerOptions = DEFAULT_OPTIONS,
  previousReadAt?: number
): void {
  const category = categoryOf(reading)
  const stale = previousReadAt !== undefined && reading.at - previousReadAt > STALE_AFTER_MS
  if (
    stale ||
    category === declaredCategory(tracker) ||
    declaresAtOnce(tracker, reading, options)
  ) {
    apply(tracker, reading)
    return
  }
  if (tracker.candidate?.category !== category) {
    tracker.candidate = { category, since: reading.at }
  }
  const need = reading.kind === 'track' ? options.settleMs : options.stopSettleMs
  if (reading.at - tracker.candidate.since >= need) apply(tracker, reading)
}

/**
 * Takes in what is queued, in order. A track that was queued already keeps when
 * it was first seen, so that reading the same queue again changes nothing.
 */
export function observeQueue(tracker: Tracker, queue: TrackInfo[], now: number): void {
  const before = [...tracker.queue]
  tracker.queue = queue.slice(0, MAX_QUEUE).map((track) => {
    const place = before.findIndex((queued) => queued.track.key === track.key)
    const cuedAt = place >= 0 ? before.splice(place, 1)[0]!.cuedAt : now
    return { track, cuedAt }
  })
}

/** When each queued track should start, while that can be told: one day ahead at most. */
export function queueStarts(tracker: Tracker): (number | undefined)[] {
  let cursor = expectedEnd(tracker)
  const horizon = (tracker.play?.anchor.at ?? 0) + 24 * 60 * 60 * 1000
  return tracker.queue.map(({ track }) => {
    if (cursor === undefined || cursor >= horizon) return (cursor = undefined)
    const starts = cursor
    cursor = track.durationMs ? cursor + track.durationMs : undefined
    return starts
  })
}
