/** A deployed Worker installing a newer release over itself. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selfUpdate, type UpdateEnv } from '../src/cloudflare/self-update.ts'

const TOKEN = 'cf-token-that-must-stay-secret'
const env: UpdateEnv = { CF_API_TOKEN: TOKEN, CF_ACCOUNT_ID: 'abc', WORKER_NAME: 'mine' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

function world(tag: unknown = 'v0.2.0') {
  const seen = { uploads: [] as { url: string; auth: string | null; form: FormData }[], assets: [] as string[] }
  const state = {
    releases: (): Response => json({ tag_name: tag }),
    manifest: (): Response => json({ version: '0.2.0', compatibility_date: '2026-11-01', compatibility_flags: ['x'] }),
    code: (): Response => new Response('export default {}'),
    upload: (): Response => json({ success: true }),
  }
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/')) return state.releases()
    if (url.startsWith('https://github.com/')) {
      seen.assets.push(url)
      return url.endsWith('worker.js') ? state.code() : state.manifest()
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
  assert.deepEqual(seen.assets, [
    'https://github.com/diva-ravioli/spotify-azuracast/releases/download/v0.2.0/worker.js',
    'https://github.com/diva-ravioli/spotify-azuracast/releases/download/v0.2.0/worker.json',
  ])
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
  const { seen, fetcher } = world('v0.10.0')
  await selfUpdate(env, fetcher, '0.9.0').catch(() => {})
  assert.equal(seen.assets.length, 2)
})

test('without a token, it asks nobody anything', async () => {
  const { seen, fetcher } = world()
  assert.equal(await selfUpdate({}, fetcher, '0.1.0'), 'no-token')
  assert.deepEqual(seen.assets, [])
})

test('no releases yet is not a failure, and a tag that doesn’t look like one is ignored', async () => {
  const none = world()
  none.state.releases = () => new Response('', { status: 404 })
  assert.equal(await selfUpdate(env, none.fetcher, '0.1.0'), 'up-to-date')
  const odd = world('nightly')
  assert.equal(await selfUpdate(env, odd.fetcher, '0.1.0'), 'up-to-date')
  assert.deepEqual(odd.seen.uploads, [])
})

test('each failure is named, uploads nothing wrong, and never holds the token', async () => {
  const cases: [string, (w: ReturnType<typeof world>) => void][] = [
    ['ReleaseCheckFailed', (w) => { w.state.releases = () => new Response('', { status: 500 }) }],
    ['ReleaseUnavailable', (w) => { w.state.code = () => new Response('', { status: 404 }) }],
    ['ReleaseMismatch', (w) => { w.state.manifest = () => json({ version: '0.1.5', compatibility_date: '2026-01-01' }) }],
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
