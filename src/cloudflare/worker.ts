/**
 * The Cloudflare host. One Durable Object holds the state and answers
 * everything, one request at a time where it matters. Its SQLite storage is on
 * Cloudflare's free plan, and strongly consistent: every request sees the same state.
 */
import { App, isApiPath, isRoute, preflight, unauthorized } from '../app.ts'
import { SPOTIFY } from '../spotify/client.ts'
import type { State, Store } from '../state.ts'
import { selfUpdate, type UpdateEnv } from './self-update.ts'

interface DurableStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  deleteAll(): Promise<void>
}

interface DurableObjectContext {
  storage: DurableStorage
}

interface Env extends UpdateEnv {
  ADAPTER: {
    idFromName(name: string): unknown
    get(id: unknown): { fetch(request: Request): Promise<Response> }
  }
  /** This install's address, if it isn't the one requests arrive at. */
  PUBLIC_URL?: string
  /** For the tests only: a stand-in Spotify. */
  TEST_SPOTIFY?: string
}

const STATE_KEY = 'state'

export class Adapter {
  private readonly app: App

  constructor(context: DurableObjectContext, env: Env) {
    const store: Store = {
      load: () => context.storage.get(STATE_KEY),
      save: (state: State) => context.storage.put(STATE_KEY, state),
      clear: () => context.storage.deleteAll(),
    }
    const test = env.TEST_SPOTIFY
    this.app = new App({
      store,
      update: () => selfUpdate(env),
      ...(env.PUBLIC_URL ? { publicUrl: env.PUBLIC_URL } : {}),
      ...(test
        ? { spotify: { accounts: test, api: test } }
        : { spotify: SPOTIFY }),
    })
  }

  fetch(request: Request): Promise<Response> {
    return this.app.handle(request)
  }
}

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname } = new URL(request.url)
    // Scanners shouldn't spend the free plan's Durable Object requests.
    if (pathname === '/healthz') return new Response('ok')
    if (!isRoute(pathname)) return new Response('Not found.', { status: 404 })
    if (isApiPath(pathname)) {
      if (request.method === 'OPTIONS') return preflight()
      if (!request.headers.has('authorization')) return unauthorized()
    }
    return env.ADAPTER.get(env.ADAPTER.idFromName('main')).fetch(request)
  },

  /** Once a day, on the schedule the install page set. */
  scheduled(_event: unknown, env: Env, context: { waitUntil(work: Promise<unknown>): void }): void {
    context.waitUntil(
      selfUpdate(env).catch((error) => console.error('Failed updating:', (error as Error)?.name))
    )
  },
}
