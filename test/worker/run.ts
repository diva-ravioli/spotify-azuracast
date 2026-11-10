/**
 * The Cloudflare host in workerd, Cloudflare's own runtime, through wrangler:
 * the same journey as a person's, with Spotify faked over a real socket. Then the
 * install page's relay, with Cloudflare's API faked the same way.
 * `npm run test:worker`: it is slower than the rest, so kept apart.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_ID, NOW_PLAYING, QUEUE, playing, track } from '../helpers/fakes.ts'
import { HttpBrowser, fakeServers, serve, until } from '../helpers/http.ts'
import { INSTALL_PAGE } from '../../relay/worker.ts'

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })

const fakes = await fakeServers()
const persist = await mkdtemp(join(tmpdir(), 'spotify-azuracast-worker-'))
const port = await freePort()
const origin = `http://127.0.0.1:${port}`
let wrangler: ChildProcess | undefined
let output = ''

async function startWorker() {
  wrangler = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      persist,
      '--var',
      `TEST_SPOTIFY:${fakes.spotifyServer.origin}`,
      '--show-interactive-dev-session=false',
    ],
    {
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  )
  wrangler.stdout!.on('data', (chunk) => (output += chunk))
  wrangler.stderr!.on('data', (chunk) => (output += chunk))
  await until(
    'the worker to start',
    async () => {
      const answer = await fetch(`${origin}/healthz`).catch(() => null)
      return answer?.status === 200
    },
    60_000
  )
}

async function stopWorker() {
  if (!wrangler?.pid) return
  const exited = new Promise((resolve) => wrangler!.once('exit', resolve))
  try {
    process.kill(-wrangler.pid, 'SIGTERM')
  } catch {}
  await exited
  wrangler = undefined
}

/** The relay in workerd, passing requests to a stand-in for Cloudflare that says what arrived. */
async function relayJourney() {
  const arrived: { method: string; path: string; authorization: string | null; cookie: string | null; form?: FormData }[] = []
  const cloudflare = await serve(async (request) => {
    const { pathname } = new URL(request.url)
    arrived.push({
      method: request.method,
      path: pathname,
      authorization: request.headers.get('authorization'),
      cookie: request.headers.get('cookie'),
      ...(request.method === 'PUT' ? { form: await request.formData() } : {}),
    })
    return Response.json({ success: true, result: { subdomain: 'me' } })
  })
  const relayPort = await freePort()
  const relayOrigin = `http://127.0.0.1:${relayPort}`
  const process_ = spawn(
    'npx',
    [
      'wrangler', 'dev', 'test/worker/relay-under-test.ts',
      '--config', 'relay/wrangler.jsonc',
      '--port', String(relayPort), '--ip', '127.0.0.1',
      '--var', `UPSTREAM:${cloudflare.origin}/client/v4`,
      '--show-interactive-dev-session=false',
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
  )
  process_.stdout!.on('data', (chunk) => (output += chunk))
  process_.stderr!.on('data', (chunk) => (output += chunk))
  const account = `/client/v4/accounts/0123456789abcdef0123456789abcdef/workers`
  const fromPage = { Origin: INSTALL_PAGE, Authorization: 'Bearer cf-token' }
  try {
    await until(
      'the relay to start',
      async () => (await fetch(`${relayOrigin}/client/v4/user/tokens/verify`, { headers: fromPage }).catch(() => null))?.status === 200,
      60_000
    )
    const form = new FormData()
    form.append('metadata', new Blob(['{"main_module":"worker.js"}'], { type: 'application/json' }))
    form.append('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js')
    const upload = await fetch(`${relayOrigin}${account}/scripts/spotify-azuracast`, {
      method: 'PUT',
      headers: { ...fromPage, Cookie: 'session=abc' },
      body: form,
    })
    assert.equal(upload.status, 200)
    assert.equal(upload.headers.get('access-control-allow-origin'), INSTALL_PAGE)
    const put = arrived.find((request) => request.method === 'PUT')!
    assert.equal(put.path, `${account}/scripts/spotify-azuracast`)
    assert.equal(put.authorization, 'Bearer cf-token')
    assert.equal(put.cookie, null)
    assert.equal(await (put.form!.get('worker.js') as Blob).text(), 'export default {}')
    step('the relay passes an upload on whole, with the token and nothing else')

    const before = arrived.length
    const elsewhere = await fetch(`${relayOrigin}/client/v4/user/tokens/verify`, {
      headers: { ...fromPage, Origin: 'https://evil.example' },
    })
    assert.equal(elsewhere.status, 403)
    const deleting = await fetch(`${relayOrigin}${account}/scripts/spotify-azuracast`, { method: 'DELETE', headers: fromPage })
    assert.equal(deleting.status, 404)
    const preflight = await fetch(`${relayOrigin}${account}/scripts/spotify-azuracast`, {
      method: 'OPTIONS',
      headers: { Origin: INSTALL_PAGE, 'Access-Control-Request-Method': 'PUT' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(arrived.length, before, 'none of these reached Cloudflare')
    step('the relay turns away other sites and other requests, and answers the page’s preflight')
  } finally {
    const exited = new Promise((resolve) => process_.once('exit', resolve))
    try {
      process.kill(-process_.pid!, 'SIGTERM')
    } catch {}
    await exited
    await cloudflare.close()
  }
}

const step = (text: string) => console.log(`ok - ${text}`)

let failed = false
try {
  await startWorker()
  const { spotify } = fakes
  spotify.playback = playing('a', 5_000)
  spotify.queue = [track('b'), track('c')]

  const browser = new HttpBrowser(origin)
  const setupPage = await (await browser.get('/')).text()
  assert.ok(setupPage.includes(`${origin}/spotify/callback`))
  step('a fresh worker shows its setup')

  const done = await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
  assert.equal(done.status, 200)
  const dashboard = await done.text()
  assert.match(dashboard, /The Owner/)
  assert.ok(dashboard.includes(`${origin}${NOW_PLAYING}`))
  step('setup with a Client ID and PKCE ends on the dashboard, with the API’s address')

  const keyPage = await (await browser.post('/keys', { label: 'My site' })).text()
  const key = /<div class="value">([^<]+)<\/div>/.exec(keyPage)![1]!
  const headers = { Authorization: `Bearer ${key}` }
  step('a key is made on the dashboard')

  const read = await fetch(`${origin}${NOW_PLAYING}`, { headers })
  assert.equal(read.status, 200)
  const nowPlaying = (await read.json()) as Record<string, any>
  assert.equal(nowPlaying.is_online, true)
  assert.equal(nowPlaying.now_playing.song.title, 'Title a')
  assert.equal(nowPlaying.playing_next.song.title, 'Title b')
  assert.match(read.headers.get('cache-control')!, /max-age=\d+/)
  assert.equal(read.headers.get('access-control-allow-origin'), '*')
  const queue = (await (await fetch(`${origin}${QUEUE}`, { headers })).json()) as unknown[]
  assert.equal(queue.length, 2)
  assert.equal((await fetch(`${origin}/api/nowplaying`, { headers })).status, 200)
  step('now playing, all stations and the queue read, with a key')

  assert.equal((await fetch(`${origin}${NOW_PLAYING}`)).status, 401)
  assert.equal((await fetch(`${origin}${NOW_PLAYING}`, { headers: { Authorization: 'Bearer nope' } })).status, 401)
  assert.equal((await fetch(`${origin}/api/nowplaying/2`, { headers })).status, 404)
  const preflight = await fetch(`${origin}${NOW_PLAYING}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://site.example', 'Access-Control-Request-Headers': 'authorization' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  step('401 without the key, 404 for another station, and a preflight any site passes')

  const before = spotify.calls.player
  await Promise.all(Array.from({ length: 5 }, () => fetch(`${origin}${NOW_PLAYING}`, { headers })))
  assert.ok(spotify.calls.player - before <= 1, 'concurrent requests share a read')
  step('concurrent requests share one read of Spotify')

  const status = await (await browser.get('/status.json')).json()
  assert.equal((status as { title?: string }).title, 'Title a')
  assert.equal((await fetch(`${origin}/favicon.ico`)).status, 404)
  step('the dashboard’s live status, and not-found stops at the edge')

  const withKey = await (await browser.get('/')).text()
  assert.match(withKey, /My site/)
  assert.ok(!withKey.includes(key))
  step('the dashboard names the key, never shows it')

  await stopWorker()
  await startWorker()
  const stillThere = new HttpBrowser(origin)
  assert.match(await (await stillThere.get('/')).text(), /Sign in with Spotify/)
  const afterRestart = await fetch(`${origin}${NOW_PLAYING}`, { headers })
  assert.equal(afterRestart.status, 200)
  const readAgain = (await afterRestart.json()) as Record<string, any>
  assert.equal(readAgain.now_playing.sh_id, nowPlaying.now_playing.sh_id, 'the same play keeps its id')
  step('after a restart, or an update: state, key and the play’s id all survive')

  const signedIn = await browser.get('/')
  assert.match(await signedIn.text(), /The Owner/)
  const reset = await browser.follow(await browser.post('/reset'))
  assert.match(await reset.text(), /Connect your Spotify/)
  assert.equal((await fetch(`${origin}${NOW_PLAYING}`, { headers })).status, 401)
  step('forgetting everything starts over, and the key stops working')

  await stopWorker()
  await relayJourney()
} catch (error) {
  failed = true
  console.error(error)
  console.error('--- wrangler said ---\n' + output.slice(-3000))
} finally {
  await stopWorker().catch(() => {})
  await fakes.close()
  await rm(persist, { recursive: true, force: true })
}
if (failed) process.exit(1)
console.log('All worker checks passed.')
process.exit(0)
