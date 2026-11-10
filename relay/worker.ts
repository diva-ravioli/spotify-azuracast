/**
 * The install page's way to Cloudflare's API. A web page can't call
 * api.cloudflare.com itself, since it doesn't allow other sites in (no CORS), so
 * the page calls this, which passes the request on and the answer back.
 *
 * It is as narrow as it can be. It passes on only the requests the install page
 * makes, only from the install page, only to Cloudflare, and only the headers
 * they need. It keeps nothing: it has no storage, and it logs nothing, not even
 * errors. `relay.yml` deploys this file, and only this file, as it is in `main`.
 */

/** Where the install page is published. Browsers let only this page read the answers. */
export const INSTALL_PAGE = 'https://diva-ravioli.github.io'
const CLOUDFLARE = 'https://api.cloudflare.com/client/v4'
const PREFIX = '/client/v4'

const ACCOUNT = '[0-9a-f]{32}'
/** A Worker's name, as the install page allows it. */
const NAME = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const route = (path: string) => new RegExp(`^${path}$`)

/** Every request the install page makes, and nothing else. */
const ALLOWED: { method: string; path: RegExp }[] = [
  { method: 'GET', path: route('/user/tokens/verify') },
  { method: 'GET', path: route(`/accounts/${ACCOUNT}/workers/subdomain`) },
  { method: 'GET', path: route(`/accounts/${ACCOUNT}/workers/scripts`) },
  { method: 'GET', path: route(`/accounts/${ACCOUNT}/workers/scripts/${NAME}/settings`) },
  { method: 'PUT', path: route(`/accounts/${ACCOUNT}/workers/scripts/${NAME}`) },
  { method: 'POST', path: route(`/accounts/${ACCOUNT}/workers/scripts/${NAME}/subdomain`) },
  { method: 'PUT', path: route(`/accounts/${ACCOUNT}/workers/scripts/${NAME}/schedules`) },
]

const isAllowed = (method: string, path: string) =>
  ALLOWED.some((allowed) => allowed.method === method && allowed.path.test(path))

const CORS = {
  'Access-Control-Allow-Origin': INSTALL_PAGE,
  Vary: 'Origin',
}

/** An answer in Cloudflare's own shape, which the install page reads. */
function refuse(status: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code: status, message }], messages: [], result: null },
    { status, headers: CORS }
  )
}

export interface RelayOptions {
  fetch?: typeof fetch
  /** Where Cloudflare's API is: a stand-in, in the tests. */
  upstream?: string
}

export async function relay(request: Request, options: RelayOptions = {}): Promise<Response> {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const upstream = options.upstream ?? CLOUDFLARE
  // A browser always says where a request comes from. Anything else could call
  // Cloudflare itself, and has no need of this.
  if (request.headers.get('origin') !== INSTALL_PAGE) {
    return new Response('Only the install page uses this.', { status: 403 })
  }
  const { pathname } = new URL(request.url)
  const path = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : null

  if (request.method === 'OPTIONS') {
    const method = request.headers.get('access-control-request-method') ?? ''
    if (path === null || !isAllowed(method, path)) return refuse(404, 'Not something the install page asks.')
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        'Access-Control-Allow-Methods': method,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      },
    })
  }
  if (path === null || !isAllowed(request.method, path)) {
    return refuse(404, 'Not something the install page asks.')
  }

  // Only what the request needs: never cookies, or anything about the browser.
  const headers = new Headers({ 'User-Agent': 'spotify-azuracast-relay' })
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) headers.set('Authorization', authorization)
  const type = request.headers.get('content-type')
  if (type) headers.set('Content-Type', type)

  let answer: Response
  try {
    answer = await send(`${upstream}${path}`, {
      method: request.method,
      headers,
      ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }),
      // Not 'error', which Workers refuse outright: a 3xx is turned away below.
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    return refuse(502, "Cloudflare couldn't be reached.")
  }
  if (answer.status >= 300 && answer.status < 400) {
    await answer.body?.cancel()
    return refuse(502, 'Cloudflare answered with a redirect, which this does not follow.')
  }
  return new Response(answer.body, {
    status: answer.status,
    headers: { ...CORS, 'Content-Type': answer.headers.get('content-type') ?? 'application/json' },
  })
}

export default {
  fetch: (request: Request) => relay(request),
}
