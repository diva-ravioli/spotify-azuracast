/** Spotify's answers as readings. Everything in them is untrusted, and any field may be missing. */
import type { Reading, TrackInfo } from '../tracker.ts'

type Json = Record<string, unknown>
const asObject = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

const MAX_DAY_MS = 86_400_000

/** A character that isn't whitespace or a control character: a name needs at least one. */
const VISIBLE = /[^\s\u0000-\u001F\u007F-\u009F᠎﻿]/u
const CONTROL = /\p{Cc}/gu

/**
 * Text fit to pass on: NFC, no control characters, trimmed and cut to `max`
 * code points. `undefined` when nothing is left.
 */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.normalize('NFC').replace(CONTROL, ' ').trim()
  if (!VISIBLE.test(text)) return undefined
  const cut = Array.from(text).slice(0, max).join('').trim()
  return VISIBLE.test(cut) ? cut : undefined
}

/** An ISRC as 12 uppercase characters. Anything else is left out, not passed on. */
export function cleanIsrc(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^([A-Za-z]{2})-?([A-Za-z0-9]{3})-?([0-9]{2})-?([0-9]{5})$/.exec(value.trim())
  return match ? match.slice(1).join('').toUpperCase() : undefined
}

export function cleanDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const ms = Math.round(value)
  return ms >= 1 && ms <= MAX_DAY_MS ? ms : undefined
}

export function cleanPosition(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const ms = Math.round(value)
  return ms >= 0 && ms <= MAX_DAY_MS ? ms : undefined
}

/** An image address, only if it is an https URL: it ends up in other people's pages. */
export function cleanImage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

/** A short, stable hash, for tracks with no id. Not a secret, and not security. */
export function shortHash(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

const SPOTIFY_ID = /^[A-Za-z0-9]{1,64}$/

/** The largest of an album's images: Spotify lists them largest first, but says their sizes too. */
function coverOf(album: Json): string | undefined {
  const images = (Array.isArray(album.images) ? album.images : [])
    .map((image) => asObject(image))
    .map((image) => ({ url: cleanImage(image.url), width: Number(image.width) || 0 }))
    .filter((image): image is { url: string; width: number } => image.url !== undefined)
  return images.sort((a, b) => b.width - a.width)[0]?.url
}

/** A track, or `null` for anything that isn't one: an episode, or a file with no title or artist. */
export function parseTrack(item: unknown): TrackInfo | null {
  const raw = asObject(item)
  if (raw.type !== undefined && raw.type !== 'track') return null
  const title = cleanText(raw.name, 300)
  const artists = (Array.isArray(raw.artists) ? raw.artists : [])
    .map((artist) => cleanText(asObject(artist).name, 200))
    .filter((name): name is string => name !== undefined)
    .slice(0, 10)
  // A local file may have neither: there is nothing to show.
  if (!title || artists.length === 0) return null
  const durationMs = cleanDuration(raw.duration_ms)
  const spotifyId =
    raw.is_local !== true && typeof raw.id === 'string' && SPOTIFY_ID.test(raw.id)
      ? raw.id
      : undefined
  const key =
    spotifyId ?? `local-${shortHash(JSON.stringify([artists, title, durationMs ?? null]))}`
  const albumJson = asObject(raw.album)
  const album = cleanText(albumJson.name, 300)
  const isrc = cleanIsrc(asObject(raw.external_ids).isrc)
  const art = coverOf(albumJson)
  return {
    key,
    title,
    artists,
    ...(album ? { album } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(isrc ? { isrc } : {}),
    ...(art ? { art } : {}),
  }
}

/** `GET /me/player`, `null` being its `204`: no active device. */
export function parsePlayback(json: unknown, at: number): Reading {
  if (json === null) return { kind: 'nothing', at }
  const raw = asObject(json)
  // Its user asked Spotify not to share this session: nor do we.
  if (asObject(raw.device).is_private_session === true) return { kind: 'other', at }
  if (raw.currently_playing_type !== undefined && raw.currently_playing_type !== 'track') {
    return { kind: 'other', at }
  }
  const track = parseTrack(raw.item)
  if (!track) return { kind: 'other', at }
  const progress = cleanPosition(raw.progress_ms)
  const progressMs =
    progress !== undefined && track.durationMs ? Math.min(progress, track.durationMs) : progress
  return { kind: 'track', track, playing: raw.is_playing === true, progressMs, at }
}

/** `GET /me/player/queue`: the tracks queued, and what Spotify says is on as it answers. */
export function parseQueue(json: unknown): { currentKey?: string; queue: TrackInfo[] } {
  const raw = asObject(json)
  const queue = (Array.isArray(raw.queue) ? raw.queue : [])
    .map(parseTrack)
    .filter((track): track is TrackInfo => track !== null)
  return { currentKey: parseTrack(raw.currently_playing)?.key, queue }
}
