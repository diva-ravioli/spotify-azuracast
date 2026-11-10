/**
 * What is on, in the shapes an AzuraCast station publishes: `Api_NowPlaying` for
 * `/api/nowplaying`, and `Api_StationQueueDetailed` for a station's queue.
 * https://github.com/AzuraCast/AzuraCast/blob/main/web/static/openapi.yml has
 * them, and the tests hold what this writes to that document.
 *
 * Spotify is one station. Fields with no meaning here (listeners, mounts, a
 * stream to listen to) are there, empty, so that code written for AzuraCast
 * finds every field it expects.
 */
import { MAX_HISTORY, queueStarts, startOf, type Play, type QueuedTrack, type TrackInfo, type Tracker } from '../tracker.ts'

export const STATION_ID = 1
export const SHORTCODE = 'spotify'
/** What AzuraCast says when its station is off the air, as code written for it may look for it. */
export const OFFLINE_TEXT = 'Station Offline'

/** A station is named by its id or its short code, as AzuraCast takes either. */
export const isStation = (given: string) => given === String(STATION_ID) || given === SHORTCODE

const seconds = (ms: number) => Math.floor(ms / 1000)

export interface Song {
  id: string
  art: string
  custom_fields: string[]
  text: string
  artist: string
  title: string
  album: string
  genre: string
  isrc: string
  lyrics: string
}

function songOf(track: TrackInfo): Song {
  const artist = track.artists.join(', ')
  return {
    id: track.key,
    art: track.art ?? '',
    custom_fields: [],
    text: `${artist} - ${track.title}`,
    artist,
    title: track.title,
    album: track.album ?? '',
    genre: '',
    isrc: track.isrc ?? '',
    lyrics: '',
  }
}

const offlineSong: Song = {
  id: 'offline',
  art: '',
  custom_fields: [],
  text: OFFLINE_TEXT,
  artist: '',
  title: OFFLINE_TEXT,
  album: '',
  genre: '',
  isrc: '',
  lyrics: '',
}

/** Where a song came from, which Spotify doesn't say: nothing here is a playlist or a request. */
const PROVENANCE = {
  playlist: '',
  playlist_chain: [] as string[],
  playlist_source: null,
  is_request: false,
}

function historyOf(sh: number, startedAt: number, track: TrackInfo) {
  return {
    sh_id: sh,
    played_at: seconds(startedAt),
    duration: track.durationMs ? Math.round(track.durationMs / 1000) : 0,
    ...PROVENANCE,
    streamer: '',
    song: songOf(track),
  }
}

/** The play on now, its elapsed time as of `now`: paused, that stands still. */
function currentOf(play: Play, now: number) {
  const entry = historyOf(play.sh, startOf(play), play.track)
  const { positionMs = 0, at, playing } = play.anchor
  const elapsedMs = playing ? positionMs + Math.max(0, now - at) : positionMs
  const elapsed = Math.min(seconds(elapsedMs), entry.duration || Infinity)
  return { ...entry, elapsed, remaining: Math.max(0, entry.duration - elapsed) }
}

const offline = () => ({
  sh_id: 0,
  played_at: 0,
  duration: 0,
  ...PROVENANCE,
  streamer: '',
  song: offlineSong,
  elapsed: 0,
  remaining: 0,
})

function queuedOf({ track, cuedAt }: QueuedTrack, startsAt: number | undefined) {
  return {
    cued_at: seconds(cuedAt),
    played_at: startsAt === undefined ? null : seconds(startsAt),
    duration: track.durationMs ? track.durationMs / 1000 : 0,
    ...PROVENANCE,
    song: songOf(track),
  }
}

const isOn = (tracker: Tracker) =>
  (tracker.declared === 'playing' || tracker.declared === 'paused') && tracker.play !== null

export interface StationView {
  name: string
}

function stationOf(view: StationView) {
  return {
    id: STATION_ID,
    name: view.name,
    shortcode: SHORTCODE,
    description: 'Playing on Spotify',
    frontend: 'remote',
    backend: 'none',
    timezone: 'UTC',
    listen_url: '',
    url: null,
    public_player_url: '',
    playlist_pls_url: '',
    playlist_m3u_url: '',
    is_public: false,
    requests_enabled: false,
    mounts: [],
    remotes: [],
    hls_enabled: false,
    hls_is_default: false,
    hls_url: null,
    hls_listeners: 0,
  }
}

/**
 * `Api_NowPlaying`, as of `now`. Online while a track is playing. Paused, the
 * track is still what is on, with its time standing still. Nothing on, or
 * something this mustn't name, is a station off the air.
 */
export function nowPlayingOf(tracker: Tracker, view: StationView, now: number) {
  const on = isOn(tracker)
  const next = on ? tracker.queue[0] : undefined
  return {
    station: stationOf(view),
    listeners: { total: 0, unique: 0, current: 0 },
    live: { is_live: false, streamer_name: '', broadcast_start: null, art: null },
    now_playing: on ? currentOf(tracker.play!, now) : offline(),
    playing_next: next ? queuedOf(next, queueStarts(tracker)[0]) : null,
    song_history: tracker.history
      .slice(0, MAX_HISTORY)
      .map((past) => historyOf(past.sh, past.startedAt, past.track)),
    is_online: on && tracker.declared === 'playing',
    // Where it came from: read just now, not from a cache.
    cache: 'station',
  }
}

/** A station's queue, each as `Api_StationQueueDetailed`: empty while nothing is on. */
export function queueOf(tracker: Tracker) {
  if (!isOn(tracker)) return []
  const starts = queueStarts(tracker)
  return tracker.queue.map((queued, i) => ({
    ...queuedOf(queued, starts[i]),
    sent_to_autodj: false,
    is_played: false,
    autodj_custom_uri: null,
    log: null,
    links: {},
  }))
}

/** An answer in AzuraCast's error shape, `Api_Error`. */
export function apiError(
  status: number,
  type: string,
  message: string,
  headers: HeadersInit = {}
): Response {
  return Response.json(
    { code: status, type, message, formatted_message: message, extra_data: [], success: false },
    { status, headers }
  )
}
