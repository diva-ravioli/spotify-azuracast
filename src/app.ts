/**
 * The adapter: every route, on Web-standard `Request` and `Response`, so that
 * it runs in a Cloudflare Durable Object, and under Node in the tests. The Worker
 * gives it a store and passes it requests; the only state in memory is what can
 * be lost.
 */
import {
  SHORTCODE,
  STATION_ID,
  apiError,
  isStation,
  nowPlayingOf,
  queueOf,
} from './azuracast/nowplaying.ts'
import { challengeOf, randomId, randomSecret, sameHash, sha256Hex } from './crypto.ts'
import {
  AUTHORIZATION_LIFETIME_MS,
  SPOTIFY,
  SpotifyProblem,
  apiGet,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  type SpotifyEndpoints,
} from './spotify/client.ts'
import { parsePlayback, parseQueue } from './spotify/parse.ts'
import { migrate, newState, type Flow, type State, type Store } from './state.ts'
import {
  DEFAULT_OPTIONS,
  expectedEnd,
  observe,
  observeQueue,
  type TrackerOptions,
} from './tracker.ts'
import {
  dashboardPage,
  keyPage,
  render,
  setupPage,
  signInPage,
  type Page,
} from './ui/pages.ts'
import { CLIENT, REPOSITORY, VERSION } from './version.ts'

export interface AppOptions {
  store: Store
  /** This install's address, where it can't be taken from the request. */
  publicUrl?: string
  fetch?: typeof fetch
  now?: () => number
  spotify?: SpotifyEndpoints
  tracker?: TrackerOptions
}

/** A reading this fresh is good enough: clients poll every few seconds, and share it. */
const READ_TTL_MS = 4_000
const QUEUE_TTL_MS = 30_000
/** Past this into a read, the queue waits for the next: a client is waiting for now. */
const QUEUE_BUDGET_MS = 2_500
const FLOW_TTL_MS = 10 * 60 * 1000
/**
 * Longer than Spotify's authorization, on purpose. Signing in renews that, so
 * with a shorter session nobody would ever be signed in to see it running out.
 * Browsers cap a cookie at 400 days.
 */
const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 5
const MAX_FLOWS = 20
const LAST_SEEN_EVERY_MS = 5 * 60 * 1000
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000
const SESSION_COOKIE = 'adapter_session'
const FLOW_COOKIE = 'adapter_flow'

export const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/')

/** Routes the app answers; a host can turn away everything else before waking anything up. */
export function isRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/status.json' ||
    pathname === '/setup' ||
    pathname === '/signin' ||
    pathname === '/signout' ||
    pathname === '/reset' ||
    pathname === '/spotify/callback' ||
    pathname === '/keys' ||
    pathname.startsWith('/keys/') ||
    isApiPath(pathname)
  )
}

type ApiRoute = { kind: 'all' } | { kind: 'station' } | { kind: 'queue' }

/** AzuraCast's paths, with or without a `/` at the end, for this adapter's one station. */
function apiRouteOf(pathname: string): ApiRoute | null {
  const path = pathname.replace(/\/$/, '')
  if (path === '/api/nowplaying') return { kind: 'all' }
  const station = /^\/api\/nowplaying\/([^/]+)$/.exec(path)
  if (station && isStation(decodeURIComponent(station[1]!))) return { kind: 'station' }
  const queue = /^\/api\/station\/([^/]+)\/queue$/.exec(path)
  if (queue && isStation(decodeURIComponent(queue[1]!))) return { kind: 'queue' }
  return null
}

/**
 * Any site may call the API from a browser: it takes no cookies, only a key
 * that whoever runs the site chose to give it.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Retry-After',
}

export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Max-Age': '86400',
    },
  })
}

export function unauthorized(): Response {
  return apiError(
    401,
    'NotLoggedInException',
    'This needs an API key, sent as Authorization: Bearer.',
    { ...CORS, 'WWW-Authenticate': 'Bearer' }
  )
}

function cookiesOf(request: Request): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const equals = part.indexOf('=')
    if (equals > 0) cookies.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim())
  }
  return cookies
}

export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('.').map((part) => Number(part) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0)
    if (difference) return difference
  }
  return 0
}

const NOTICES: Record<string, { kind: 'good' | 'bad' | 'warn'; text: string }> = {
  renewed: { kind: 'good', text: "Spotify's authorization is renewed for six months." },
}

export class App {
  private readonly store: Store
  private readonly publicUrl: string | undefined
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly spotify: SpotifyEndpoints
  private readonly trackerOptions: TrackerOptions

  private state: State | null = null
  private savedTracker = ''
  private reading: Promise<void> | null = null
  private refreshing: Promise<string> | null = null
  private readAt = 0
  private queueAt = 0
  private queueDisagreed = false
  private blockedUntil = 0

  constructor(options: AppOptions) {
    this.store = options.store
    this.publicUrl = options.publicUrl?.replace(/\/+$/, '')
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? Date.now
    this.spotify = options.spotify ?? SPOTIFY
    this.trackerOptions = options.tracker ?? DEFAULT_OPTIONS
  }

  // ─── State ───────────────────────────────────────────────────────────────

  async load(): Promise<State> {
    if (!this.state) {
      const stored = migrate(await this.store.load())
      // Another request may have loaded it while this one waited.
      this.state ??= stored
      this.savedTracker = JSON.stringify(this.state.tracker)
    }
    return this.state
  }

  private async save(): Promise<void> {
    const state = await this.load()
    this.savedTracker = JSON.stringify(state.tracker)
    await this.store.save(state)
  }

  private dropExpired(state: State) {
    const now = this.now()
    state.flows = state.flows.filter((flow) => flow.expiresAt > now)
    state.sessions = state.sessions.filter((session) => session.expiresAt > now)
  }

  // ─── Requests ────────────────────────────────────────────────────────────

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (isApiPath(url.pathname)) return await this.api(request, url)
      return await this.page(request, url)
    } catch (error) {
      // Never its text: an error may hold a token or a URL with a secret.
      console.error(`Failed on ${request.method} ${url.pathname}:`, (error as Error)?.name)
      return isApiPath(url.pathname)
        ? apiError(500, 'Exception', 'Something went wrong.', CORS)
        : new Response('Something went wrong.', { status: 500 })
    }
  }

  private async page(request: Request, url: URL): Promise<Response> {
    const origin = this.publicUrl ?? url.origin
    const state = await this.load()
    this.dropExpired(state)
    const { pathname } = url
    const method = request.method

    if (method === 'POST' && !this.sameOrigin(request, origin)) {
      return new Response('This form came from somewhere else.', { status: 403 })
    }
    if (pathname === '/spotify/callback' && method === 'GET') {
      return this.spotifyCallback(request, url, origin)
    }
    if (pathname === '/setup' && method === 'POST') return this.startSetup(request, origin)
    if (pathname === '/signin' && method === 'POST') return this.startSignIn(origin)

    if (!state.spotify) {
      if (pathname === '/' && method === 'GET') {
        return this.html(setupPage(`${origin}/spotify/callback`), origin)
      }
      return this.redirect('/')
    }

    const signedIn = await this.isSignedIn(request)
    if (!signedIn) {
      if (pathname === '/' && method === 'GET') {
        return this.html(signInPage(undefined, state.spotify.dead), origin)
      }
      if (pathname === '/status.json') return new Response(null, { status: 401 })
      return this.redirect('/')
    }

    if (pathname === '/' && method === 'GET') return this.dashboard(url, origin)
    if (pathname === '/status.json' && method === 'GET') return this.statusJson()
    if (pathname === '/signout' && method === 'POST') return this.signOut(request)
    if (pathname === '/reset' && method === 'POST') return this.reset()
    if (pathname === '/keys' && method === 'POST') return this.makeKey(request, origin)
    const removal = /^\/keys\/([0-9a-f]+)\/remove$/.exec(pathname)
    if (removal && method === 'POST') return this.removeKey(removal[1]!)
    return new Response('Not found.', { status: 404 })
  }

  /** Whether a form came from these pages: the browser says, which a page can't fake. */
  private sameOrigin(request: Request, origin: string): boolean {
    const site = request.headers.get('sec-fetch-site')
    if (site) return site === 'same-origin'
    return request.headers.get('origin') === origin
  }

  private html(page: Page, origin: string, init: { status?: number; cookies?: string[] } = {}) {
    const nonce = randomId()
    const formTargets = origin.startsWith('http://') ? 'https: http:' : 'https:'
    const headers = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': [
        `default-src 'none'`,
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        `connect-src 'self'`,
        // A form here may end in a redirect to Spotify, and browsers hold
        // redirects after a form to this too.
        `form-action 'self' ${formTargets}`,
        `base-uri 'none'`,
        `frame-ancestors 'none'`,
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      // Nothing leaves for another site, the code in a callback's URL included.
      // Not no-referrer: browsers then send `Origin: null` with this site's own forms.
      'Referrer-Policy': 'same-origin',
    })
    for (const cookie of init.cookies ?? []) headers.append('Set-Cookie', cookie)
    return new Response(render(page, nonce), { status: init.status ?? 200, headers })
  }

  private redirect(location: string, cookies: string[] = []) {
    const headers = new Headers({
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'same-origin',
    })
    for (const cookie of cookies) headers.append('Set-Cookie', cookie)
    return new Response(null, { status: 303, headers })
  }

  private cookie(name: string, value: string, maxAgeS: number, secure: boolean): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  private async isSignedIn(request: Request): Promise<boolean> {
    const cookie = cookiesOf(request).get(SESSION_COOKIE)
    if (!cookie) return false
    const hash = await sha256Hex(cookie)
    const state = await this.load()
    return state.sessions.some((session) => sameHash(session.hash, hash))
  }

  private async newSession(origin: string): Promise<string> {
    const state = await this.load()
    const secret = randomSecret()
    const hash = await sha256Hex(secret)
    state.sessions = [
      ...state.sessions,
      { hash, expiresAt: this.now() + SESSION_TTL_MS },
    ].slice(-MAX_SESSIONS)
    return this.cookie(
      SESSION_COOKIE,
      secret,
      SESSION_TTL_MS / 1000,
      origin.startsWith('https://')
    )
  }

  private async signOut(request: Request) {
    const state = await this.load()
    const hash = await sha256Hex(cookiesOf(request).get(SESSION_COOKIE) ?? '')
    state.sessions = state.sessions.filter((session) => !sameHash(session.hash, hash))
    await this.save()
    return this.redirect('/', [`${SESSION_COOKIE}=; Path=/; Max-Age=0`])
  }

  private async reset() {
    // First: anything saved from here on is the empty state, not what is being forgotten.
    this.state = newState()
    this.savedTracker = JSON.stringify(this.state.tracker)
    await this.store.clear()
    this.readAt = 0
    this.queueAt = 0
    return this.redirect('/', [`${SESSION_COOKIE}=; Path=/; Max-Age=0`])
  }

  // ─── Spotify: setup, sign-in and tokens ──────────────────────────────────

  private async startSetup(request: Request, origin: string) {
    const state = await this.load()
    if (state.spotify) return this.redirect('/')
    const form = await request.formData()
    const clientId = String(form.get('client_id') ?? '').trim()
    const redirectUri = `${origin}/spotify/callback`
    if (!/^[0-9a-fA-F]{32}$/.test(clientId)) {
      return this.html(
        setupPage(redirectUri, "That isn't a Client ID: it is 32 letters and digits."),
        origin,
        { status: 400 }
      )
    }
    return this.startSpotifyFlow(clientId, redirectUri, origin)
  }

  private async startSignIn(origin: string) {
    const state = await this.load()
    if (!state.spotify) return this.redirect('/')
    return this.startSpotifyFlow(state.spotify.clientId, `${origin}/spotify/callback`, origin)
  }

  private async startSpotifyFlow(clientId: string, redirectUri: string, origin: string) {
    const state = await this.load()
    const flow: Flow = {
      state: randomSecret(),
      verifier: randomSecret(),
      expiresAt: this.now() + FLOW_TTL_MS,
      redirectUri,
      clientId,
    }
    // Anyone can start one before setup: what they start can't crowd out memory.
    state.flows = [...state.flows.slice(-(MAX_FLOWS - 1)), flow]
    await this.save()
    const location = authorizeUrl(this.spotify, {
      clientId,
      redirectUri,
      state: flow.state,
      challenge: await challengeOf(flow.verifier),
    })
    return this.redirect(location, [
      this.cookie(FLOW_COOKIE, flow.state, FLOW_TTL_MS / 1000, origin.startsWith('https://')),
    ])
  }

  /** The flow this callback ends, once: bound to the browser that started it. */
  private async takeFlow(request: Request, url: URL) {
    const state = await this.load()
    const given = url.searchParams.get('state') ?? ''
    if (!given || cookiesOf(request).get(FLOW_COOKIE) !== given) return null
    const flow = state.flows.find((f) => f.state === given)
    if (!flow) return null
    state.flows = state.flows.filter((f) => f !== flow)
    return flow
  }

  private async spotifyCallback(request: Request, url: URL, origin: string) {
    const state = await this.load()
    const again = () =>
      state.spotify ? signInPage : (message: string) => setupPage(`${origin}/spotify/callback`, message)
    const flow = await this.takeFlow(request, url)
    if (!flow) {
      return this.html(again()('That sign-in ran out, or began in another browser. Try again.'), origin, {
        status: 400,
      })
    }
    await this.save()
    const code = url.searchParams.get('code')
    const refusal = url.searchParams.get('error')
    if (refusal || !code) {
      const why = refusal === 'access_denied' ? 'You cancelled at Spotify.' : 'Spotify refused the sign-in.'
      return this.html(again()(`${why} Nothing changed.`), origin, { status: 400 })
    }

    let tokens
    let profile: { id?: unknown; display_name?: unknown }
    try {
      const now = this.now()
      tokens = await exchangeCode(this.spotify, this.fetch, now, {
        code,
        redirectUri: flow.redirectUri,
        clientId: flow.clientId,
        verifier: flow.verifier,
      })
      const me = await apiGet(this.spotify, this.fetch, tokens.accessToken, '/v1/me')
      if (me.unauthorized) throw new SpotifyProblem('authorization', 'Spotify refused the sign-in.')
      profile = (me.json ?? {}) as typeof profile
    } catch (error) {
      if (error instanceof SpotifyProblem) {
        const hint =
          error.kind === 'refused'
            ? ` Use the Spotify account that owns the app, which needs Premium. Spotify said: ${error.message}`
            : ` ${error.message}`
        return this.html(again()(`Sign-in failed.${hint}`), origin, { status: 400 })
      }
      throw error
    }
    if (typeof profile.id !== 'string') {
      return this.html(again()('Spotify gave an unreadable answer. Try again.'), origin, {
        status: 400,
      })
    }

    // The first account through becomes the owner: it alone can sign in from now on.
    if (state.spotify && state.spotify.ownerId !== profile.id) {
      return this.html(
        signInPage('That Spotify account does not own this adapter. Sign in with the one that set it up.'),
        origin,
        { status: 403 }
      )
    }
    const renewed = !!state.spotify
    state.spotify = {
      clientId: flow.clientId,
      ownerId: profile.id,
      ownerName: typeof profile.display_name === 'string' ? profile.display_name : profile.id,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshToken: tokens.refreshToken,
      authorizedAt: this.now(),
      dead: false,
    }
    delete state.problem
    const session = await this.newSession(origin)
    await this.save()
    return this.redirect(renewed ? '/?notice=renewed' : '/', [
      session,
      `${FLOW_COOKIE}=; Path=/; Max-Age=0`,
    ])
  }

  /** A fresh access token, one refresh at a time: Spotify may rotate the refresh token. */
  private accessToken(force = false): Promise<string> {
    return (async () => {
      const state = await this.load()
      const link = state.spotify
      if (!link || link.dead) throw new SpotifyProblem('authorization', 'Not authorized.', 300)
      if (!force && link.accessExpiresAt - this.now() > 60_000) return link.accessToken
      this.refreshing ??= this.refreshAccess().finally(() => {
        this.refreshing = null
      })
      return this.refreshing
    })()
  }

  private async refreshAccess(): Promise<string> {
    const state = await this.load()
    const link = state.spotify
    if (!link) throw new SpotifyProblem('authorization', 'Not authorized.', 300)
    try {
      const tokens = await refreshTokens(this.spotify, this.fetch, this.now(), {
        refreshToken: link.refreshToken,
        clientId: link.clientId,
      })
      Object.assign(link, tokens)
      await this.save()
      return tokens.accessToken
    } catch (error) {
      if (error instanceof SpotifyProblem && error.kind === 'authorization') {
        link.dead = true
        await this.save()
        throw new SpotifyProblem('authorization', error.message, 300)
      }
      throw error
    }
  }

  private async spotifyGet(path: string): Promise<unknown> {
    const answer = await apiGet(this.spotify, this.fetch, await this.accessToken(), path)
    if (!answer.unauthorized) return answer.json
    const retried = await apiGet(this.spotify, this.fetch, await this.accessToken(true), path)
    if (retried.unauthorized) {
      throw new SpotifyProblem('refused', 'Spotify refused a fresh access token.', 60)
    }
    return retried.json
  }

  // ─── Reading Spotify ─────────────────────────────────────────────────────

  /**
   * Brings what is on up to date, reading Spotify if what we have is old.
   * Requests that arrive meanwhile share the one read.
   */
  private async refresh(): Promise<void> {
    const state = await this.load()
    const now = this.now()
    if (now < this.blockedUntil) {
      throw new SpotifyProblem(
        'limited',
        'Spotify is rate limiting.',
        Math.ceil((this.blockedUntil - now) / 1000)
      )
    }
    const end = expectedEnd(state.tracker)
    const passedEnd = end !== undefined && now >= end && this.readAt < end
    const fresh = this.readAt > 0 && now - this.readAt < READ_TTL_MS && !passedEnd
    if (fresh) return
    this.reading ??= this.read().finally(() => {
      this.reading = null
    })
    return this.reading
  }

  private async read(): Promise<void> {
    const state = await this.load()
    const started = this.now()
    try {
      const json = await this.spotifyGet('/v1/me/player?additional_types=track,episode')
      const finished = this.now()
      // Spotify read its clock somewhere between sending and answering.
      const reading = parsePlayback(json, Math.round((started + finished) / 2))
      const playBefore = state.tracker.play?.sh
      observe(state.tracker, reading, this.trackerOptions, this.readAt)
      this.readAt = finished

      const playChanged = state.tracker.play?.sh !== playBefore
      const { declared, play } = state.tracker
      // What Spotify says now, not only what we have declared: while a private
      // session settles, what was on is still declared, and its queue isn't ours.
      const onThisTrack =
        (declared === 'playing' || declared === 'paused') &&
        reading.kind === 'track' &&
        reading.track.key === play?.track.key
      if (
        onThisTrack &&
        finished - started < QUEUE_BUDGET_MS &&
        (playChanged || finished - this.queueAt >= QUEUE_TTL_MS)
      ) {
        await this.readQueue(finished, reading.track.key)
      }
      if (state.problem) {
        delete state.problem
        await this.save()
      }
      if (JSON.stringify(state.tracker) !== this.savedTracker) await this.save()
    } catch (error) {
      if (!(error instanceof SpotifyProblem)) throw error
      if (error.kind === 'limited') this.blockedUntil = this.now() + error.retryAfterS * 1000
      const same = state.problem?.kind === error.kind && state.problem?.message === error.message
      if (!same) {
        state.problem = { kind: error.kind, message: error.message, at: this.now() }
        await this.save()
      }
      throw error
    }
  }

  /** The queue is a bonus: failing to read it never fails the read. */
  private async readQueue(now: number, currentKey?: string): Promise<void> {
    const state = await this.load()
    this.queueAt = now
    try {
      const { currentKey: theirs, queue } = parseQueue(await this.spotifyGet('/v1/me/player/queue'))
      observeQueue(state.tracker, queue, now)
      // Read as the track changed? Then ask once more at the next read.
      const disagrees = !!currentKey && !!theirs && currentKey !== theirs
      if (disagrees && !this.queueDisagreed) this.queueAt = 0
      this.queueDisagreed = disagrees
    } catch (error) {
      if (!(error instanceof SpotifyProblem)) throw error
      if (error.kind === 'limited') this.blockedUntil = this.now() + error.retryAfterS * 1000
    }
  }

  // ─── The API ─────────────────────────────────────────────────────────────

  private async api(request: Request, url: URL): Promise<Response> {
    if (request.method === 'OPTIONS') return preflight()
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return apiError(405, 'MethodNotAllowed', 'Only GET and HEAD.', {
        ...CORS,
        Allow: 'GET, HEAD, OPTIONS',
      })
    }
    const given = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.get('authorization') ?? '')
    if (!given) return unauthorized()
    const state = await this.load()
    const hash = await sha256Hex(given[1]!)
    // Every key, not the first that matches: the time taken says nothing.
    let key = null
    for (const candidate of state.keys) if (sameHash(candidate.hash, hash)) key = candidate
    if (!key) return unauthorized()
    const now = this.now()
    if (!key.lastSeenAt || now - key.lastSeenAt > LAST_SEEN_EVERY_MS) {
      key.lastSeenAt = now
      await this.save()
    }

    const route = apiRouteOf(url.pathname)
    if (!route) return apiError(404, 'NotFoundException', 'Record not found.', CORS)

    try {
      await this.refresh()
    } catch (error) {
      if (error instanceof SpotifyProblem) {
        // Never 401 or 403: a client takes those to mean its key is wrong, and
        // may stop for good. Trouble with Spotify passes, by itself or when
        // its owner signs in.
        const limited = error.kind === 'limited'
        return apiError(
          limited ? 429 : 503,
          limited ? 'RateLimitExceededException' : 'ServiceUnavailable',
          limited ? 'Spotify is rate limiting. Try again later.' : 'Spotify can’t be read right now.',
          { ...CORS, 'Retry-After': String(Math.max(1, error.retryAfterS)) }
        )
      }
      throw error
    }

    const at = this.now()
    const view = { name: `${state.spotify?.ownerName ?? 'Someone'} on Spotify` }
    const nowPlaying = () => nowPlayingOf(state.tracker, view, at)
    const body =
      route.kind === 'queue' ? queueOf(state.tracker) : route.kind === 'all' ? [nowPlaying()] : nowPlaying()
    const headers = new Headers({
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': `private, max-age=${this.maxAge(state)}`,
    })
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status: 200, headers })
  }

  /**
   * How soon asking again is worth it: a few seconds, but never so long that a
   * client that keeps to it misses the end of the track on now.
   */
  private maxAge(state: State): number {
    if (state.tracker.declared !== 'playing') return 10
    const end = expectedEnd(state.tracker)
    if (end === undefined) return 5
    const untilAfterEnd = (end + 1_500 - this.now()) / 1000
    if (untilAfterEnd <= 0) return 2
    return Math.min(5, Math.max(1, Math.ceil(untilAfterEnd)))
  }

  // ─── The dashboard ───────────────────────────────────────────────────────

  private async dashboard(url: URL, origin: string) {
    const state = await this.load()
    const link = state.spotify!
    const name = url.searchParams.get('notice') ?? ''
    const known = Object.hasOwn(NOTICES, name) ? NOTICES[name] : undefined
    return this.html(
      dashboardPage({
        ownerName: link.ownerName,
        endpoints: this.endpoints(origin),
        keys: state.keys,
        expiresAt: link.authorizedAt + AUTHORIZATION_LIFETIME_MS,
        now: this.now(),
        dead: link.dead,
        update: await this.availableUpdate(),
        ...(known ? { notice: known } : {}),
      }),
      origin
    )
  }

  private endpoints(origin: string) {
    return {
      nowPlaying: `${origin}/api/nowplaying/${SHORTCODE}`,
      queue: `${origin}/api/station/${SHORTCODE}/queue`,
      stationId: STATION_ID,
    }
  }

  private async statusJson() {
    const state = await this.load()
    let problem: string | undefined
    try {
      await this.refresh()
    } catch (error) {
      if (!(error instanceof SpotifyProblem)) throw error
      problem = error.message
    }
    const { tracker } = state
    const on = tracker.declared === 'playing' || tracker.declared === 'paused'
    const brief = (track: { title: string; artists: string[] }) => ({
      title: track.title,
      artists: track.artists,
    })
    return Response.json(
      {
        state: tracker.declared ?? 'unknown',
        problem,
        ...(on && tracker.play ? brief(tracker.play.track) : {}),
        next: on ? tracker.queue.slice(0, 10).map((queued) => brief(queued.track)) : [],
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  /** The latest release, if it is newer. Asked at most once a day, and only when someone is looking. */
  private async availableUpdate(): Promise<string | undefined> {
    const state = await this.load()
    const now = this.now()
    if (!state.update || now - state.update.checkedAt > UPDATE_CHECK_EVERY_MS) {
      state.update = { checkedAt: now, ...(state.update?.latest ? { latest: state.update.latest } : {}) }
      try {
        const response = await this.fetch(
          `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
          {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': CLIENT },
            signal: AbortSignal.timeout(1_500),
          }
        )
        if (response.ok) {
          const release = (await response.json()) as { tag_name?: unknown }
          if (typeof release.tag_name === 'string') {
            state.update.latest = release.tag_name.replace(/^v/, '')
          }
        } else {
          await response.body?.cancel()
        }
      } catch {
        // Nothing depends on this. Ask again tomorrow.
      }
      await this.save()
    }
    const latest = state.update.latest
    return latest && compareVersions(latest, VERSION) > 0 ? latest : undefined
  }

  // ─── API keys ────────────────────────────────────────────────────────────

  private async makeKey(request: Request, origin: string) {
    const state = await this.load()
    const form = await request.formData()
    const label = String(form.get('label') ?? '').trim().slice(0, 60) || 'An API client'
    const secret = randomSecret()
    state.keys.push({ id: randomId(), label, hash: await sha256Hex(secret), createdAt: this.now() })
    await this.save()
    return this.html(keyPage(label, secret, this.endpoints(origin)), origin)
  }

  private async removeKey(id: string) {
    const state = await this.load()
    state.keys = state.keys.filter((key) => key.id !== id)
    await this.save()
    return this.redirect('/')
  }

  async persist(): Promise<void> {
    await this.save()
  }
}
