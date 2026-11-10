/** Stand-ins for Spotify and a browser, driven in virtual time. */
import { createHash } from 'node:crypto'
import { App, type AppOptions } from '../../src/app.ts'
import type { State, Store } from '../../src/state.ts'

export const ACCOUNTS = 'https://accounts.fake.test'
export const API = 'https://api.fake.test'
export const ADAPTER = 'https://adapter.fake.test'
export const CLIENT_ID = '0123456789abcdef0123456789abcdef'

export class Clock {
  ms = Date.parse('2026-11-06T12:00:00.000Z')
  now = () => this.ms
  advance(ms: number) {
    this.ms += ms
  }
}

export function memoryStore(): Store & { value: unknown; saves: number } {
  const store = {
    value: null as unknown,
    saves: 0,
    async load() {
      return store.value === null ? null : structuredClone(store.value)
    },
    async save(state: State) {
      store.saves += 1
      store.value = structuredClone(state)
    },
    async clear() {
      store.value = null
    },
  }
  return store
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

export function track(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'track',
    id,
    name: `Title ${id}`,
    artists: [{ name: `Artist ${id}` }],
    album: {
      name: `Album ${id}`,
      images: [
        { url: `https://i.scdn.co/image/${id}-64`, width: 64, height: 64 },
        { url: `https://i.scdn.co/image/${id}-640`, width: 640, height: 640 },
      ],
    },
    duration_ms: 200_000,
    explicit: false,
    is_local: false,
    external_ids: { isrc: 'USS1Z2600001' },
    ...overrides,
  }
}

export function playing(id: string, progress_ms: number, overrides: Record<string, unknown> = {}) {
  return {
    device: { is_active: true, is_private_session: false, name: 'A device' },
    currently_playing_type: 'track',
    is_playing: true,
    progress_ms,
    timestamp: 0,
    item: track(id),
    ...overrides,
  }
}

export class FakeSpotify {
  /** `null`: 204, no active device. */
  playback: unknown = null
  queue: unknown[] = []
  owner = { id: 'owner-1', display_name: 'The Owner' }
  /** Answers instead of the player's, for failures. */
  failPlayer: (() => Response) | null = null
  failQueue: (() => Response) | null = null
  failRefresh: (() => Response) | null = null
  rotateRefreshTokens = true
  calls = { player: 0, queue: 0, me: 0, refresh: 0, exchange: 0 }
  authorizeRequests: URLSearchParams[] = []
  /** Answers the authorize page: approves by default. */
  decision: 'approve' | 'deny' = 'approve'
  private codes = new Map<string, { challenge: string; redirectUri: string }>()
  private access = new Set<string>()
  private refresh = new Set<string>()
  private counter = 0

  /** Ends every access token, as an hour passing would. */
  expireAccess() {
    this.access.clear()
  }

  /** Ends the refresh token, as six months passing would. */
  expireRefresh() {
    this.access.clear()
    this.refresh.clear()
  }

  private issue() {
    this.counter += 1
    const access = `access-${this.counter}`
    const refresh = `refresh-${this.counter}`
    this.access.add(access)
    this.refresh.add(refresh)
    return { access, refresh }
  }

  handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === '/authorize') {
      this.authorizeRequests.push(url.searchParams)
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('state', url.searchParams.get('state')!)
      if (this.decision === 'deny') {
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = `code-${this.codes.size + 1}`
        this.codes.set(code, {
          challenge: url.searchParams.get('code_challenge')!,
          redirectUri: url.searchParams.get('redirect_uri')!,
        })
        back.searchParams.set('code', code)
      }
      return new Response(null, { status: 302, headers: { Location: back.toString() } })
    }
    if (url.pathname === '/api/token') {
      const form = new URLSearchParams(await request.text())
      if (form.get('grant_type') === 'authorization_code') {
        this.calls.exchange += 1
        const code = this.codes.get(form.get('code') ?? '')
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url')
        if (!code || code.challenge !== challenge || code.redirectUri !== form.get('redirect_uri')) {
          return json({ error: 'invalid_grant' }, 400)
        }
        this.codes.delete(form.get('code')!)
        const { access, refresh } = this.issue()
        return json({ access_token: access, refresh_token: refresh, expires_in: 3600 })
      }
      this.calls.refresh += 1
      if (this.failRefresh) return this.failRefresh()
      const given = form.get('refresh_token') ?? ''
      if (!this.refresh.has(given) || form.get('client_id') !== CLIENT_ID) {
        return json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400)
      }
      if (this.rotateRefreshTokens) {
        this.refresh.delete(given)
        const { access, refresh } = this.issue()
        return json({ access_token: access, refresh_token: refresh, expires_in: 3600 })
      }
      const { access } = this.issue()
      return json({ access_token: access, expires_in: 3600 })
    }
    const bearer = request.headers.get('authorization')?.replace('Bearer ', '') ?? ''
    if (!this.access.has(bearer)) return json({ error: { status: 401, message: 'expired' } }, 401)
    if (url.pathname === '/v1/me') {
      this.calls.me += 1
      return json(this.owner)
    }
    if (url.pathname === '/v1/me/player') {
      this.calls.player += 1
      if (this.failPlayer) return this.failPlayer()
      return this.playback === null ? new Response(null, { status: 204 }) : json(this.playback)
    }
    if (url.pathname === '/v1/me/player/queue') {
      this.calls.queue += 1
      if (this.failQueue) return this.failQueue()
      const current = (this.playback as { item?: unknown } | null)?.item ?? null
      return json({ currently_playing: current, queue: this.queue })
    }
    return json({ error: { status: 404, message: 'no' } }, 404)
  }
}

/** Routes requests to the fakes by origin. */
export function fakeFetch(routes: Record<string, (request: Request) => Promise<Response>>) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const route = routes[new URL(request.url).origin]
    if (!route) throw new TypeError(`fetch failed: ${request.url}`)
    return route(request)
  }) as typeof fetch
}

/** Just enough browser: a cookie jar, and it follows redirects between the fakes. */
export class Browser {
  cookies = new Map<string, string>()
  readonly app: App
  readonly external: typeof fetch
  readonly origin: string

  constructor(app: App, external: typeof fetch, origin = ADAPTER) {
    this.app = app
    this.external = external
    this.origin = origin
  }

  private keep(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';')
      const equals = pair!.indexOf('=')
      const [name, value] = [pair!.slice(0, equals), pair!.slice(equals + 1)]
      if (value === '' || /Max-Age=0/.test(cookie)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  private headers(extra: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    return { ...(cookie ? { cookie } : {}), ...extra }
  }

  async get(path: string): Promise<Response> {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin) return this.external(url, { redirect: 'manual' })
    const response = await this.app.handle(new Request(url, { headers: this.headers() }))
    this.keep(response)
    return response
  }

  async post(path: string, form: Record<string, string> = {}, origin = this.origin) {
    const response = await this.app.handle(
      new Request(new URL(path, this.origin), {
        method: 'POST',
        headers: this.headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: origin,
        }),
        body: new URLSearchParams(form),
      })
    )
    this.keep(response)
    return response
  }

  /** Follows a response's redirects, as a browser does, to where they end. */
  async follow(response: Response): Promise<Response> {
    let current = response
    for (let hops = 0; hops < 8; hops++) {
      const location = current.headers.get('location')
      if (!location || current.status < 300 || current.status >= 400) return current
      current = await this.get(new URL(location, this.origin).toString())
    }
    throw new Error('Too many redirects.')
  }
}

/** github.com, where the newest release is `version`: it sends its worker.json, as GitHub does. */
export function latestRelease(version: string | (() => string | null), onAsk = () => {}) {
  return async (request: Request) => {
    if (!request.url.endsWith('/releases/latest/download/worker.json')) return new Response('Not Found', { status: 404 })
    onAsk()
    const latest = typeof version === 'function' ? version() : version
    if (!latest) return new Response('Too many requests', { status: 429 })
    return json({ version: latest, compatibility_date: '2026-10-01', compatibility_flags: [] })
  }
}

export function setup(options: Partial<AppOptions> = {}) {
  const clock = new Clock()
  const spotify = new FakeSpotify()
  const external = fakeFetch({
    [ACCOUNTS]: spotify.handle,
    [API]: spotify.handle,
    'https://github.com': latestRelease('0.1.0'),
  })
  const store = memoryStore()
  const app = new App({
    store,
    now: clock.now,
    fetch: external,
    spotify: { accounts: ACCOUNTS, api: API },
    ...options,
  })
  const browser = new Browser(app, external)
  return { app, browser, clock, spotify, store, external }
}

/** Takes a fresh install through setup. */
export async function connected(options: Partial<AppOptions> = {}) {
  const context = setup(options)
  const answer = await context.browser.post('/setup', { client_id: CLIENT_ID })
  const end = await context.browser.follow(answer)
  if (end.status !== 200) throw new Error(`Setup failed: ${end.status}`)
  return context
}

export const NOW_PLAYING = '/api/nowplaying/spotify'
export const QUEUE = '/api/station/spotify/queue'

/** Makes a key on the dashboard, as its owner would, and answers it. */
export async function makeKey(browser: Browser, label = 'A client'): Promise<string> {
  const page = await browser.post('/keys', { label })
  const html = await page.text()
  const key = /<div class="value">([A-Za-z0-9\-._~+/]+=*)<\/div>/.exec(html)?.[1]
  if (!key) throw new Error('No key on the page.')
  return key
}

/** A fresh install with an API client reading it. */
export async function keyed(options: Partial<AppOptions> = {}) {
  const context = await connected(options)
  const key = await makeKey(context.browser)
  const ask = (path = NOW_PLAYING, headers: Record<string, string> = {}, method = 'GET') =>
    context.app.handle(
      new Request(new URL(path, ADAPTER), {
        method,
        headers: { Authorization: `Bearer ${key}`, ...headers },
      })
    )
  return { ...context, key, ask }
}

export { json }
