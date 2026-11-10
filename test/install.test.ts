/** The install page's logic, against a stand-in for Cloudflare's API. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
// @ts-expect-error: a plain script for browsers, with no types.
import { InstallError, RELAY, SCHEDULE, install } from '../site/install.js'

const TOKEN = 'cf-token-that-must-stay-secret'
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const ours = { bindings: [{ type: 'durable_object_namespace', name: 'ADAPTER', class_name: 'Adapter' }] }
const ok = (result: unknown = {}) =>
  new Response(JSON.stringify({ success: true, result }), { status: 200 })
// Cloudflare's errors carry `result: null`.
const refused = (status = 403) =>
  new Response(JSON.stringify({ success: false, errors: [], result: null }), { status })

interface Call { method: string; path: string; auth: string | null; body: unknown }

function cloudflare(overrides: Record<string, () => Response> = {}, existing: unknown[] = []) {
  const calls: Call[] = []
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    if (input === './worker.js') return new Response('export default {}')
    if (input === './worker.json') {
      return new Response(JSON.stringify({ compatibility_date: '2026-10-01', compatibility_flags: [] }))
    }
    assert.ok(input.startsWith(RELAY), input)
    const path = input.slice(RELAY.length)
    const method = init.method ?? 'GET'
    calls.push({ method, path, auth: new Headers(init.headers).get('authorization'), body: init.body })
    const key = `${method} ${path}`
    if (overrides[key]) return overrides[key]!()
    const account = `/accounts/${ACCOUNT}/workers`
    if (path === `${account}/subdomain`) return ok({ subdomain: 'me' })
    if (path === `${account}/scripts` && method === 'GET') return ok(existing)
    return ok()
  }) as unknown as typeof fetch
  return { calls, fetcher }
}
const run = (fetcher: typeof fetch, name = 'spotify-azuracast', token = TOKEN) =>
  install({ token, accountId: ACCOUNT, name, fetcher })
const metadataOf = async (calls: Call[]) => {
  const upload = calls.find((call) => call.method === 'PUT' && call.path.endsWith('/scripts/spotify-azuracast'))!
  return JSON.parse(await ((upload.body as FormData).get('metadata') as Blob).text())
}

test('a first install creates the Durable Object, keeps the token as a secret, and schedules updates', async () => {
  const { calls, fetcher } = cloudflare()
  assert.equal(await run(fetcher), 'https://spotify-azuracast.me.workers.dev')
  assert.ok(calls.every((call) => call.auth === `Bearer ${TOKEN}`))
  const metadata = await metadataOf(calls)
  assert.deepEqual(metadata.migrations, { new_tag: 'v1', new_sqlite_classes: ['Adapter'] })
  assert.deepEqual(metadata.bindings, [
    { type: 'durable_object_namespace', name: 'ADAPTER', class_name: 'Adapter' },
    { type: 'plain_text', name: 'WORKER_NAME', text: 'spotify-azuracast' },
    { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: ACCOUNT },
    { type: 'secret_text', name: 'CF_API_TOKEN', text: TOKEN },
  ])
  const script = `/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`
  assert.ok(calls.some((call) => call.method === 'POST' && call.path === `${script}/subdomain`))
  const schedule = calls.find((call) => call.path === `${script}/schedules`)!
  assert.equal(schedule.method, 'PUT')
  assert.deepEqual(JSON.parse(schedule.body as string), [{ cron: SCHEDULE }])
})

test('running it again keeps what is stored: no migration', async () => {
  const script = `/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`
  const { calls, fetcher } = cloudflare(
    { [`GET ${script}/settings`]: () => ok(ours) },
    [{ id: 'spotify-azuracast', migration_tag: 'v1' }]
  )
  await run(fetcher)
  assert.equal((await metadataOf(calls)).migrations, undefined)
})

test('it never replaces a Worker that is not this adapter', async () => {
  const script = `/accounts/${ACCOUNT}/workers/scripts/spotify-azuracast`
  const { calls, fetcher } = cloudflare(
    { [`GET ${script}/settings`]: () => ok({ bindings: [] }) },
    [{ id: 'spotify-azuracast' }]
  )
  await assert.rejects(run(fetcher), /already have a Worker/)
  assert.ok(!calls.some((call) => call.method === 'PUT'))
})

test('what a person can get wrong is said plainly, and never holds the token', async () => {
  const account = `/accounts/${ACCOUNT}/workers`
  const cases: [Record<string, () => Response>, RegExp][] = [
    [{ 'GET /user/tokens/verify': () => refused(401) }, /didn't accept that token/],
    [{ [`GET ${account}/subdomain`]: () => refused() }, /Workers Scripts: Edit/],
    [{ [`GET ${account}/subdomain`]: () => ok({}) }, /no workers\.dev address/],
    [{ [`GET ${account}/subdomain`]: () => refused(404) }, /no workers\.dev address/],
    [{ [`PUT ${account}/scripts/spotify-azuracast`]: () => refused() }, /refused the upload/],
    [{ [`PUT ${account}/scripts/spotify-azuracast/schedules`]: () => refused() }, /updates couldn't be turned on/],
  ]
  for (const [overrides, expected] of cases) {
    const { fetcher } = cloudflare(overrides)
    await assert.rejects(run(fetcher), (error: Error) => {
      assert.ok(error instanceof InstallError)
      assert.match(error.message, expected)
      assert.doesNotMatch(error.message, new RegExp(TOKEN))
      return true
    })
  }
})

test('bad input is caught before anything is sent', async () => {
  for (const [token, accountId, name] of [
    ['', ACCOUNT, 'ok'],
    [TOKEN, 'nope', 'ok'],
    [TOKEN, ACCOUNT, 'Not Valid'],
    [TOKEN, ACCOUNT, '../other'],
  ]) {
    const { calls, fetcher } = cloudflare()
    await assert.rejects(install({ token, accountId, name, fetcher }), InstallError)
    assert.deepEqual(calls, [])
  }
})

test('the page loads nothing from elsewhere, and only talks to the relay', () => {
  const site = join(import.meta.dirname, '..', 'site')
  const html = readFileSync(join(site, 'index.html'), 'utf8')
  assert.ok(html.includes(`connect-src 'self' ${new URL(RELAY).origin}`))
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/)
  assert.doesNotMatch(readFileSync(join(site, 'page.js'), 'utf8'), /innerHTML/)
  assert.match(html, /type="password" id="token"/)
})

test('the Durable Object the page creates is the one the Worker exports', () => {
  const config = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8'))
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['Adapter'] }])
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'ADAPTER', class_name: 'Adapter' }])
})
