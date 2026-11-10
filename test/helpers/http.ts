/** The same fakes over real sockets, and a browser that uses them. */
import { createServer, type Server } from 'node:http'
import { FakeSpotify } from './fakes.ts'

export async function serve(handler: (request: Request) => Promise<Response>) {
  const server: Server = createServer(async (incoming, outgoing) => {
    const parts: Buffer[] = []
    for await (const part of incoming) parts.push(part as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value)
    }
    const hasBody = !['GET', 'HEAD'].includes(incoming.method ?? 'GET')
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method ?? 'GET',
      headers,
      ...(hasBody ? { body: Buffer.concat(parts) } : {}),
    })
    const response = await handler(request).catch(() => new Response('oops', { status: 500 }))
    const sent: Record<string, string | string[]> = Object.fromEntries(response.headers)
    const cookies = response.headers.getSetCookie()
    if (cookies.length) sent['set-cookie'] = cookies
    outgoing.writeHead(response.status, sent)
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

/** A fake Spotify on a real socket. */
export async function fakeServers() {
  const spotify = new FakeSpotify()
  const spotifyServer = await serve(spotify.handle)
  return { spotify, spotifyServer, close: () => spotifyServer.close() }
}

export class HttpBrowser {
  cookies = new Map<string, string>()
  readonly origin: string

  constructor(origin: string) {
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

  private cookieHeader(): Record<string, string> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    return cookie ? { cookie } : {}
  }

  async get(url: string): Promise<Response> {
    const target = new URL(url, this.origin)
    const own = target.origin === this.origin
    const response = await fetch(target, {
      redirect: 'manual',
      headers: own ? this.cookieHeader() : {},
    })
    if (own) this.keep(response)
    return response
  }

  async post(path: string, form: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(new URL(path, this.origin), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        ...this.cookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: this.origin,
      },
      body: new URLSearchParams(form),
    })
    this.keep(response)
    return response
  }

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

export async function until<T>(
  what: string,
  check: () => T | Promise<T>,
  timeoutMs = 15_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
