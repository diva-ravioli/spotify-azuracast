/** Everything the adapter keeps, as one JSON document, and where it is kept. */
import { newTracker, type Tracker } from './tracker.ts'

export interface SpotifyLink {
  clientId: string
  /** The Spotify account that owns this install. It alone can sign in. */
  ownerId: string
  ownerName: string
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  authorizedAt: number
  /** The refresh token stopped working: its user must authorize again. */
  dead: boolean
}

/** A key an API client sends as `Authorization: Bearer`. Only its hash is kept. */
export interface ApiKey {
  id: string
  label: string
  hash: string
  createdAt: number
  lastSeenAt?: number
}

/** A sign-in with Spotify, between leaving for Spotify and coming back. */
export interface Flow {
  state: string
  expiresAt: number
  verifier: string
  redirectUri: string
  clientId: string
}

export interface State {
  schema: 1
  spotify?: SpotifyLink
  tracker: Tracker
  keys: ApiKey[]
  sessions: { hash: string; expiresAt: number }[]
  flows: Flow[]
  /** What last went wrong reading Spotify, for its owner. */
  problem?: { kind: string; message: string; at: number }
  update?: { checkedAt: number; latest?: string }
}

export const SCHEMA = 1

export const newState = (): State => ({
  schema: SCHEMA,
  tracker: newTracker(),
  keys: [],
  sessions: [],
  flows: [],
})

/**
 * Brings a stored document up to this version. An update may change the shape
 * of what is stored: each change adds a step here, and nobody has to do
 * anything when they update.
 */
export function migrate(stored: unknown): State {
  if (!stored || typeof stored !== 'object') return newState()
  const state = stored as Record<string, unknown>
  if (state.schema !== SCHEMA) {
    throw new Error(
      `Stored state has schema ${String(state.schema)}, newer than this version understands. Update this install.`
    )
  }
  return state as unknown as State
}

export interface Store {
  load(): Promise<unknown>
  save(state: State): Promise<void>
  /** Forgets everything. */
  clear(): Promise<void>
}
