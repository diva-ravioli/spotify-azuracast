/** A deployed Worker installing a newer release over itself. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selfUpdate, type UpdateEnv } from '../src/cloudflare/self-update.ts'

const TOKEN = 'cf-token-that-must-stay-secret'
const env: UpdateEnv = { CF_API_TOKEN: TOKEN, CF_ACCOUNT_ID: 'abc', WORKER_NAME: 'mine' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

const RELEASES = 'https://github.com/diva-ravioli/spotify-azuracast/releases'

/** GitHub, where the newest release is `version`, and Cloudflare. */
function world(version: unknown = '0.2.0') {
  const seen = { uploads: [] as { url: string; auth: string | null; form: FormData }[], assets: [] as string[] }
  const state = {
    latest: (): Response => json({ version, compatibility_date: '2026-11-01', compatibility_flags: ['x'] }),
    code: (): Response => new Response('export default {}'),
    upload: (): Response => json({ success: true }),
  }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/')) throw new Error('GitHub’s API is not to be asked: from a Worker, it mostly says no')
    if (url.startsWith('https://github.com/')) {
      seen.assets.push(url)
      if (url === `${RELEASES}/latest/download/worker.json`) return state.latest()
      if (url.endsWith('/worker.js')) return state.code()
      return new Response('Not Found', { status: 404 })
    }
    const auth = new Headers(init?.headers).get('authorization')
    seen.uploads.push({ url, auth, form: init?.body as FormData })
    return state.upload()
  }) as typeof fetch
  return { seen, state, fetcher }
}

test('a newer release is uploaded over this Worker, with all it needs to go on', async () => {
  const { seen, fetcher } = world()
  assert.equal(await selfUpdate(env, fetcher, '0.1.0'), 'updated')
  assert.deepEqual(seen.assets, [`${RELEASES}/latest/download/worker.json`, `${RELEASES}/download/v0.2.0/worker.js`])
  const [upload] = seen.uploads
  assert.equal(upload!.url, 'https://api.cloudflare.com/client/v4/accounts/abc/workers/scripts/mine')
  assert.equal(upload!.auth, `Bearer ${TOKEN}`)
  const metadata = JSON.parse(await (upload!.form.get('metadata') as Blob).text())
  assert.equal(metadata.main_module, 'worker.js')
  assert.equal(metadata.compatibility_date, '2026-11-01')
  assert.deepEqual(metadata.compatibility_flags, ['x'])
  assert.equal(metadata.migrations, undefined, 'the Durable Object must be left alone')
  assert.deepEqual(metadata.bindings, [
    { type: 'durable_object_namespace', name: 'ADAPTER', class_name: 'Adapter' },
    { type: 'plain_text', name: 'WORKER_NAME', text: 'mine' },
    { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: 'abc' },
    { type: 'secret_text', name: 'CF_API_TOKEN', text: TOKEN },
  ])
  assert.equal(await (upload!.form.get('worker.js') as Blob).text(), 'export default {}')
})

test('a custom address survives an update', async () => {
  const { seen, fetcher } = world()
  await selfUpdate({ ...env, PUBLIC_URL: 'https://mine.example' }, fetcher, '0.1.0')
  const metadata = JSON.parse(await (seen.uploads[0]!.form.get('metadata') as Blob).text())
  assert.deepEqual(metadata.bindings.at(-1), { type: 'plain_text', name: 'PUBLIC_URL', text: 'https://mine.example' })
})

test('with no newer release, nothing happens', async () => {
  for (const current of ['0.2.0', '0.10.0']) {
    const { seen, fetcher } = world()
    assert.equal(await selfUpdate(env, fetcher, current), 'up-to-date', current)
    assert.deepEqual(seen.uploads, [])
  }
})

test('versions compare by number, not as text', async () => {
  const { seen, fetcher } = world('0.10.0')
  assert.equal(await selfUpdate(env, fetcher, '0.9.0'), 'updated')
  assert.equal(seen.uploads.length, 1)
})

test('without a token, it asks nobody anything', async () => {
  const { seen, fetcher } = world()
  assert.equal(await selfUpdate({}, fetcher, '0.1.0'), 'no-token')
  assert.deepEqual(seen.assets, [])
})

test('no releases yet is not a failure', async () => {
  const none = world()
  none.state.latest = () => new Response('Not Found', { status: 404 })
  assert.equal(await selfUpdate(env, none.fetcher, '0.1.0'), 'up-to-date')
  assert.deepEqual(none.seen.uploads, [])
})

test('each failure is named, uploads nothing wrong, and never holds the token', async () => {
  const cases: [string, (w: ReturnType<typeof world>) => void][] = [
    ['ReleaseCheckFailed', (w) => { w.state.latest = () => new Response('', { status: 429 }) }],
    ['ReleaseCheckFailed', (w) => { w.state.latest = () => { throw new TypeError(`fetch failed ${TOKEN}`) } }],
    ['ReleaseUnavailable', (w) => { w.state.code = () => new Response('', { status: 404 }) }],
    ['ReleaseUnavailable', (w) => { w.state.code = () => { throw new TypeError(`fetch failed ${TOKEN}`) } }],
    ['ReleaseMismatch', (w) => { w.state.latest = () => json({ version: 'nightly', compatibility_date: '2026-01-01' }) }],
    ['ReleaseMismatch', (w) => { w.state.latest = () => json({ version: '0.2.0' }) }],
    ['ReleaseMismatch', (w) => { w.state.latest = () => new Response('<html>') }],
    ['UploadRefused', (w) => { w.state.upload = () => json({ success: false }, 403) }],
  ]
  for (const [name, breakIt] of cases) {
    const w = world()
    breakIt(w)
    await assert.rejects(selfUpdate(env, w.fetcher, '0.1.0'), (error: Error) => {
      assert.equal(error.name, name)
      assert.doesNotMatch(`${error.name} ${error.message}`, new RegExp(TOKEN))
      return true
    })
    if (name !== 'UploadRefused') assert.deepEqual(w.seen.uploads, [], name)
  }
})

test('a failure says GitHub’s or Cloudflare’s status, for the log', async () => {
  const limited = world()
  limited.state.latest = () => new Response('', { status: 429 })
  await assert.rejects(selfUpdate(env, limited.fetcher, '0.1.0'), (error: Error & { status?: number }) => error.status === 429)
  const refused = world()
  refused.state.upload = () => json({ success: false }, 403)
  await assert.rejects(selfUpdate(env, refused.fetcher, '0.1.0'), (error: Error & { status?: number }) => error.status === 403)
})
