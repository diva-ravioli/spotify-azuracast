/**
 * Spotify's accounts and player APIs, as a public client: authorization code
 * with PKCE, so a self-hoster pastes a Client ID and nothing else.
 */

export interface SpotifyEndpoints {
  accounts: string
  api: string
}
export const SPOTIFY: SpotifyEndpoints = {
  accounts: 'https://accounts.spotify.com',
  api: 'https://api.spotify.com',
}

export const SCOPES = 'user-read-playback-state user-read-currently-playing'
/** An answer should reach a client within a few seconds, and it may take two of these. */
const REQUEST_TIMEOUT_MS = 2_000
/**
 * Giving up on a token request can cost far more than a late answer: Spotify may
 * already have replaced the refresh token, and then the authorization is gone.
 * A client that stops waiting just asks again, and the answer is still kept.
 */
const TOKEN_TIMEOUT_MS = 15_000
/** Spotify's refresh tokens end this long after the user authorized the app, used or not. */
export const AUTHORIZATION_LIFETIME_MS = 182 * 24 * 60 * 60 * 1000

export interface Tokens {
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
}

/** Why Spotify gave no answer, sorted by what to do about it. */
export class SpotifyProblem extends Error {
  readonly kind: 'authorization' | 'refused' | 'limited' | 'unavailable'
  readonly retryAfterS: number

  constructor(kind: SpotifyProblem['kind'], message: string, retryAfterS = 5) {
    super(message)
    this.kind = kind
    this.retryAfterS = retryAfterS
  }
}

export function authorizeUrl(
  endpoints: SpotifyEndpoints,
  params: { clientId: string; redirectUri: string; state: string; challenge: string }
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    scope: SCOPES,
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge_method: 'S256',
    code_challenge: params.challenge,
  })
  return `${endpoints.accounts}/authorize?${query}`
}

function retryAfter(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : fallback
}

async function tokenRequest(
  endpoints: SpotifyEndpoints,
  fetcher: typeof fetch,
  now: number,
  form: Record<string, string>,
  previousRefreshToken?: string
): Promise<Tokens> {
  let response: Response
  try {
    response = await fetcher(`${endpoints.accounts}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    })
  } catch {
    throw new SpotifyProblem('unavailable', 'Spotify could not be reached.')
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (response.status === 429) {
    throw new SpotifyProblem('limited', 'Spotify is rate limiting.', retryAfter(response, 30))
  }
  if (response.status >= 500) {
    throw new SpotifyProblem('unavailable', `Spotify answered ${response.status}.`)
  }
  if (!response.ok) {
    const description = typeof body.error_description === 'string' ? body.error_description : ''
    const message = description || `Spotify refused the authorization (${String(body.error)}).`
    // Only this says the refresh token is over. Anything else may pass: it may
    // not even be from Spotify, and giving up for good would strand the install.
    if (body.error === 'invalid_grant') throw new SpotifyProblem('authorization', message)
    throw new SpotifyProblem('refused', message, 60)
  }
  const refreshToken =
    typeof body.refresh_token === 'string' ? body.refresh_token : previousRefreshToken
  if (typeof body.access_token !== 'string' || !refreshToken) {
    throw new SpotifyProblem('unavailable', 'Spotify gave an unreadable token answer.')
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600
  return {
    accessToken: body.access_token,
    accessExpiresAt: now + expiresIn * 1000,
    refreshToken,
  }
}

export const exchangeCode = (
  endpoints: SpotifyEndpoints,
  fetcher: typeof fetch,
  now: number,
  params: { code: string; redirectUri: string; clientId: string; verifier: string }
) =>
  tokenRequest(endpoints, fetcher, now, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  })

export const refreshTokens = (
  endpoints: SpotifyEndpoints,
  fetcher: typeof fetch,
  now: number,
  params: { refreshToken: string; clientId: string }
) =>
  tokenRequest(
    endpoints,
    fetcher,
    now,
    {
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    },
    params.refreshToken
  )

/** `null` for a `204`. A `401` is its own answer: the caller refreshes and tries once more. */
export async function apiGet(
  endpoints: SpotifyEndpoints,
  fetcher: typeof fetch,
  accessToken: string,
  path: string
): Promise<{ unauthorized: true } | { unauthorized: false; json: unknown }> {
  let response: Response
  try {
    response = await fetcher(`${endpoints.api}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new SpotifyProblem('unavailable', 'Spotify could not be reached.')
  }
  if (response.status === 204) {
    await response.body?.cancel()
    return { unauthorized: false, json: null }
  }
  if (response.status === 401) {
    await response.body?.cancel()
    return { unauthorized: true }
  }
  if (response.status === 429) {
    await response.body?.cancel()
    throw new SpotifyProblem('limited', 'Spotify is rate limiting.', retryAfter(response, 30))
  }
  if (response.status === 403) {
    // Most often: the app's owner has no Premium any more, or this account
    // isn't on the app's user list. Spotify's message says which.
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } }
    const message = typeof body.error?.message === 'string' ? body.error.message : ''
    throw new SpotifyProblem('refused', message || 'Spotify refused this app.', 60)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new SpotifyProblem(
      'unavailable',
      `Spotify answered ${response.status}.`,
      retryAfter(response, 5)
    )
  }
  try {
    const text = await response.text()
    if (text.trim() === '') return { unauthorized: false, json: null }
    return { unauthorized: false, json: JSON.parse(text) }
  } catch {
    throw new SpotifyProblem('unavailable', 'Spotify gave an unreadable answer.')
  }
}
