/** The install page's relay to Cloudflare's API: what it passes on, and what it never does. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { INSTALL_PAGE, relay } from '../relay/worker.ts'
// @ts-expect-error: a plain script for browsers, with no types.
import { RELAY, install } from '../site/install.js'

const UPSTREAM = 'https://cloudflare.fake.test/client/v4'
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const TOKEN = 'cf-token-that-must-stay-secret'

interface Seen { method: string; url: string; headers: Headers; body: ArrayBuffer | null }

/** A stand-in for Cloudflare's API, answering as it does. */
function cloudflare(answer?: (url: string) => Response) {
  const seen: Seen[] = []
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    seen.push({
      method: init.method ?? 'GET',
      url: input,
      headers: new Headers(init.headers),
      body: (init.body as ArrayBuffer | undefined) ?? null,
    })
    if (answer) return answer(input)
    // An account with this adapter on it already: the page then asks all it can.
    const result = input.endsWith('/workers/subdomain')
      ? { subdomain: 'me' }
      : input.endsWith('/scripts')
        ? [{ id: 'spotify-azuracast', migration_tag: 'v1' }]
        : input.endsWith('/settings')
          ? { bindings: [{ type: 'durable_object_namespace', name: 'ADAPTER', class_name: 'Adapter' }] }
          : {}
    return Response.json({ success: true, result })
  }) as unknown as typeof fetch
  return { seen, fetcher }
}

const ask = (
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
  fetcher: typeof fetch = cloudflare().fetcher
) =>
  relay(
    new Request(`${RELAY}${path}`, { ...init, headers: { Origin: INSTALL_PAGE, ...init.headers } }),
    { fetch: fetcher, upstream: UPSTREAM }
  )

test('everything the install page asks, the relay passes on, and installing works through it', async () => {
  const upstream = cloudflare()
  // The page in a browser: every request it makes goes through the relay.
  const browser = (async (input: string, init: RequestInit = {}) => {
    if (input === './worker.js') return new Response('export default {}')
    if (input === './worker.json') return Response.json({ compatibility_date: '2026-10-01' })
    const headers = new Headers(init.headers)
    headers.set('Origin', INSTALL_PAGE)
    return relay(new Request(input, { ...init, headers }), { fetch: upstream.fetcher, upstream: UPSTREAM })
  }) as unknown as typeof fetch
  const address = await install({ token: TOKEN, accountId: ACCOUNT, name: 'spotify-azuracast', fetcher: browser })
  assert.equal(address, 'https://spotify-azuracast.me.workers.dev')
  assert.equal(new Set(upstream.seen.map((call) => `${call.method} ${call.url}`)).size, 7, 'all seven kinds of request')
  for (const call of upstream.seen) {
    assert.ok(call.url.startsWith(`${UPSTREAM}/`), call.url)
    assert.equal(call.headers.get('authorization'), `Bearer ${TOKEN}`)
  }
  const upload = upstream.seen.find((call) => call.method === 'PUT' && call.url.endsWith('/scripts/spotify-azuracast'))!
  const form = await new Response(upload.body, { headers: { 'Content-Type': upload.headers.get('content-type')! } }).formData()
  assert.equal(await (form.get('worker.js') as Blob).text(), 'export default {}', 'the upload arrives whole')
})

test('only the install page may use it', async () => {
  const upstream = cloudflare()
  for (const origin of [undefined, 'https://evil.example', 'null', `${INSTALL_PAGE}.evil.example`]) {
    const answer = await relay(
      new Request(`${RELAY}/user/tokens/verify`, { headers: origin ? { Origin: origin } : {} }),
      { fetch: upstream.fetcher, upstream: UPSTREAM }
    )
    assert.equal(answer.status, 403, String(origin))
    assert.equal(answer.headers.get('access-control-allow-origin'), null)
  }
  assert.equal(upstream.seen.length, 0)
})

test('nothing else in Cloudflare’s API is passed on', async () => {
  const upstream = cloudflare()
  const attempts: [string, string][] = [
    ['DELETE', `/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`],
    ['GET', `/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`],
    ['PUT', `/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast/secrets`],
    ['GET', '/user/tokens'],
    ['POST', '/user/tokens'],
    ['GET', '/zones'],
    ['GET', `/accounts/${ACCOUNT}/workers/scripts/Not_A_Name/settings`],
    ['GET', '/accounts/not-an-account/workers/scripts'],
    ['GET', `/accounts/${ACCOUNT}/workers/scripts/a/../../../../user/tokens`],
  ]
  for (const [method, path] of attempts) {
    const answer = await ask(path, { method }, upstream.fetcher)
    assert.equal(answer.status, 404, `${method} ${path}`)
    assert.equal((await answer.json()).success, false)
  }
  const elsewhere = await relay(new Request('https://relay.example/v4/user/tokens/verify', { headers: { Origin: INSTALL_PAGE } }), {
    fetch: upstream.fetcher,
    upstream: UPSTREAM,
  })
  assert.equal(elsewhere.status, 404)
  assert.equal(upstream.seen.length, 0)
})

test('a browser’s preflight is answered for what the page asks, and nothing else', async () => {
  const preflight = (path: string, method: string) =>
    ask(path, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': method } })
  const allowed = await preflight(`/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`, 'PUT')
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers.get('access-control-allow-origin'), INSTALL_PAGE)
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'PUT')
  assert.match(allowed.headers.get('access-control-allow-headers')!, /Authorization/)
  assert.equal((await preflight(`/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`, 'DELETE')).status, 404)
})

test('only the token and the type of the body go on: no cookies, nothing about the browser', async () => {
  const upstream = cloudflare()
  await ask('/user/tokens/verify', {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Cookie: 'session=abc',
      'X-Forwarded-For': '203.0.113.9',
      'Accept-Language': 'de',
    },
  }, upstream.fetcher)
  const sent = [...upstream.seen[0]!.headers.keys()].sort()
  assert.deepEqual(sent, ['authorization', 'user-agent'])
  await ask('/user/tokens/verify', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } }, upstream.fetcher)
  assert.equal(upstream.seen[1]!.headers.get('authorization'), null, 'only a Bearer token')
})

test('Cloudflare’s answer comes back as it was, for the install page alone', async () => {
  const refused = cloudflare(() => Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 403 }))
  const answer = await ask('/user/tokens/verify', {}, refused.fetcher)
  assert.equal(answer.status, 403)
  assert.equal(answer.headers.get('access-control-allow-origin'), INSTALL_PAGE)
  assert.deepEqual(await answer.json(), { success: false, errors: [{ code: 1000 }] })
})

test('a redirect is not followed, and Cloudflare out of reach is said plainly', async () => {
  const redirecting = cloudflare(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }))
  const redirected = await ask('/user/tokens/verify', {}, redirecting.fetcher)
  assert.equal(redirected.status, 502)
  assert.equal(redirecting.seen.length, 1)
  const unreachable = (async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  const answer = await ask('/user/tokens/verify', {}, unreachable)
  assert.equal(answer.status, 502)
  assert.equal((await answer.json()).success, false)
})

test('the deployed relay has nothing to keep anything in, and no logs', () => {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'relay', 'wrangler.jsonc'), 'utf8'))
  assert.deepEqual(config.observability, { enabled: false })
  const kinds = ['kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects', 'queues', 'analytics_engine_datasets', 'logpush', 'tail_consumers', 'vars']
  for (const kind of kinds) assert.equal(config[kind], undefined, kind)
  assert.equal(new URL(RELAY).host, `${config.name}.diva-ravioli.workers.dev`)
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', 'relay', 'worker.ts'), 'utf8'), /console\./)
})
