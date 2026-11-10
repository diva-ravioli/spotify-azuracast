import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACCOUNTS,
  ADAPTER,
  API,
  Browser,
  CLIENT_ID,
  Clock,
  FakeSpotify,
  connected,
  fakeFetch,
  NOW_PLAYING,
  QUEUE,
  json,
  keyed,
  latestRelease,
  makeKey,
  memoryStore,
  playing,
  setup,
  track,
} from './helpers/fakes.ts'
import { App, type AppOptions } from '../src/app.ts'
import { VERSION } from '../src/version.ts'
import { appDescription, appName } from '../src/ui/pages.ts'

// ─── Setting up ──────────────────────────────────────────────────────────────

test('a fresh install shows its setup, with the redirect URI to paste', async () => {
  const { browser } = setup()
  const page = await (await browser.get('/')).text()
  assert.match(page, /https:\/\/adapter\.fake\.test\/spotify\/callback/)
  assert.match(page, /Premium/)
  assert.doesNotMatch(page, /client secret<\/label>/i)
})

test('what goes to Spotify is named after this copy, never after the project', async () => {
  const { browser } = setup()
  const page = await (await browser.get('/')).text()
  const given = [...page.matchAll(/<div class="value">([^<]*)<\/div>/g)].map((match) => match[1]!)
  assert.deepEqual(given.slice(0, 1), ['adapter.fake.test'], 'the app name is its address')
  assert.equal(given.length, 3)
  for (const value of given) assert.doesNotMatch(value, /azuracast/i, value)
  assert.equal(appName('https://lively-harbor-b542.me.workers.dev/spotify/callback'), 'lively-harbor-b542', 'on workers.dev, its Worker name')
})

test('the app description is ordinary words, the same for a copy each time, and seldom another copy’s', async () => {
  // @ts-expect-error: a plain script for browsers, with no types.
  const { suggestName } = await import('../site/install.js')
  const uri = (name: string) => `https://${name}.me.workers.dev/spotify/callback`
  const names: string[] = Array.from({ length: 300 }, () => suggestName())
  const descriptions = names.map((name) => appDescription(uri(name)))
  for (const description of descriptions) assert.doesNotMatch(description, /spotify|azuracast/i, description)
  assert.ok(new Set(descriptions).size >= 40, `only ${new Set(descriptions).size} different descriptions`)
  assert.equal(appDescription(uri(names[0]!)), descriptions[0], 'the same copy, the same description')
  const { browser } = setup()
  const page = await (await browser.get('/')).text()
  assert.match(page, new RegExp(`<div class="value">${appDescription('https://adapter.fake.test/spotify/callback')}</div>`))
})

test('setup asks for a Client ID alone, and PKCE does the rest', async () => {
  const { browser, spotify, store } = await connected()
  const authorize = spotify.authorizeRequests[0]!
  assert.equal(authorize.get('client_id'), CLIENT_ID)
  assert.equal(authorize.get('code_challenge_method'), 'S256')
  assert.equal(authorize.get('scope'), 'user-read-playback-state user-read-currently-playing')
  const page = await (await browser.get('/')).text()
  assert.match(page, /The Owner/)
  const stored = store.value as { spotify: { ownerId: string; refreshToken: string } }
  assert.equal(stored.spotify.ownerId, 'owner-1')
  assert.ok(stored.spotify.refreshToken)
})

test('the dashboard says a key is needed, and that there is none yet', async () => {
  const { browser } = await connected()
  const page = await (await browser.get('/')).text()
  assert.match(page, /<h2>Keys<\/h2>/)
  assert.match(page, /No keys yet<\/b>, so nothing can read the API/)
  assert.match(page, /Where will you use it\?/)
})

test('a Client ID that cannot be one is said so, and nothing is started', async () => {
  const { browser, spotify } = setup()
  const answer = await browser.post('/setup', { client_id: 'nonsense' })
  assert.equal(answer.status, 400)
  assert.match(await answer.text(), /32 letters/)
  assert.equal(spotify.authorizeRequests.length, 0)
})

test('a pasted Client ID may have spaces around it', async () => {
  const { browser } = setup()
  const answer = await browser.post('/setup', { client_id: `  ${CLIENT_ID}\n` })
  assert.equal(answer.status, 303)
})

test('cancelling at Spotify claims nothing, and setup can start again', async () => {
  const { browser, spotify, store } = setup()
  spotify.decision = 'deny'
  const end = await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
  assert.equal(end.status, 400)
  assert.match(await end.text(), /cancelled/)
  assert.equal((store.value as { spotify?: unknown }).spotify, undefined)
  spotify.decision = 'approve'
  const again = await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
  assert.equal(again.status, 200)
})

test('starting setup claims nothing until Spotify says who you are', async () => {
  const { browser, spotify, external, app } = setup()
  await browser.post('/setup', { client_id: CLIENT_ID })
  // Someone else gets there first, and finishes.
  const other = new Browser(app, external)
  await other.follow(await other.post('/setup', { client_id: CLIENT_ID }))
  assert.match(await (await other.get('/')).text(), /The Owner/)
  // The first browser is now just someone signed out.
  assert.match(await (await browser.get('/')).text(), /Sign in with Spotify/)
  assert.equal(spotify.calls.exchange, 1)
})

test('a callback in a browser that did not start the flow is refused', async () => {
  const { browser, app, external, spotify, store } = setup()
  const answer = await browser.post('/setup', { client_id: CLIENT_ID })
  const location = answer.headers.get('location')!
  const callback = await (await external(location, { redirect: 'manual' })).headers.get('location')!
  const stranger = new Browser(app, external)
  const refused = await stranger.get(callback)
  assert.equal(refused.status, 400)
  assert.equal((store.value as { spotify?: unknown }).spotify, undefined)
  assert.equal(spotify.calls.exchange, 0)
})

test('a callback used twice is refused the second time', async () => {
  const { browser, external } = setup()
  const answer = await browser.post('/setup', { client_id: CLIENT_ID })
  const location = answer.headers.get('location')!
  const callback = (await external(location, { redirect: 'manual' })).headers.get('location')!
  const cookies = new Map(browser.cookies)
  assert.equal((await browser.get(callback)).status, 303)
  browser.cookies = cookies
  assert.equal((await browser.get(callback)).status, 400)
})

// ─── Signing in ──────────────────────────────────────────────────────────────

test('signed out, nothing shows but signing in', async () => {
  const { app, external, spotify } = await connected()
  spotify.playback = playing('secret-track', 5_000)
  const stranger = new Browser(app, external)
  const page = await (await stranger.get('/')).text()
  assert.match(page, /Sign in with Spotify/)
  assert.doesNotMatch(page, /The Owner|secret-track/)
  assert.equal((await stranger.get('/status.json')).status, 401)
  for (const path of ['/reset', '/signout', '/keys', '/keys/0123/remove']) {
    const answer = await stranger.post(path, { domain: 'x', label: 'x' })
    assert.equal(answer.status, 303, path)
    assert.equal(answer.headers.get('location'), '/', path)
  }
})

test('the owner signs in with Spotify, and that renews its authorization', async () => {
  const { app, external, clock, store } = await connected()
  const before = (store.value as { spotify: { authorizedAt: number } }).spotify.authorizedAt
  clock.advance(1_000_000)
  const browser = new Browser(app, external)
  const end = await browser.follow(await browser.post('/signin'))
  assert.equal(end.status, 200)
  assert.match(await end.text(), /renewed/)
  const after = (store.value as { spotify: { authorizedAt: number } }).spotify.authorizedAt
  assert.equal(after, before + 1_000_000)
})

test('another Spotify account can neither sign in nor change anything', async () => {
  const { app, external, spotify, store } = await connected()
  const before = JSON.stringify((store.value as { spotify: unknown }).spotify)
  spotify.owner = { id: 'somebody-else', display_name: 'Somebody' }
  const browser = new Browser(app, external)
  const end = await browser.follow(await browser.post('/signin'))
  assert.equal(end.status, 403)
  assert.match(await end.text(), /does not own/)
  assert.doesNotMatch(await (await browser.get('/')).text(), /The Owner/)
  assert.equal(JSON.stringify((store.value as { spotify: unknown }).spotify), before)
})

test('a session ends: when signed out, and in the end', async () => {
  const { browser, clock } = await connected()
  const again = new Map(browser.cookies)
  await browser.post('/signout')
  browser.cookies = again
  assert.match(await (await browser.get('/')).text(), /Sign in/)
  await browser.follow(await browser.post('/signin'))
  clock.advance(399 * 24 * 60 * 60 * 1000)
  assert.doesNotMatch(await (await browser.get('/')).text(), /Sign in with Spotify/)
  clock.advance(2 * 24 * 60 * 60 * 1000)
  assert.match(await (await browser.get('/')).text(), /Sign in with Spotify/)
})

test('a form from another site is refused', async () => {
  const { browser } = await connected()
  const answer = await browser.post('/reset', {}, 'https://evil.example')
  assert.equal(answer.status, 403)
  assert.match(await (await browser.get('/')).text(), /The Owner/)
})

test('a form is judged by what the browser says about where it came from', async () => {
  const { app, browser } = await connected()
  const send = (headers: Record<string, string>) =>
    app.handle(
      new Request(`${ADAPTER}/signout`, {
        method: 'POST',
        headers: {
          cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
          ...headers,
        },
      })
    )
  assert.equal((await send({ 'Sec-Fetch-Site': 'cross-site', Origin: ADAPTER })).status, 403)
  assert.equal((await send({ 'Sec-Fetch-Site': 'same-site' })).status, 403)
  assert.equal((await send({ Origin: 'null' })).status, 403)
  assert.equal((await send({})).status, 403)
  assert.equal((await send({ 'Sec-Fetch-Site': 'same-origin', Origin: 'null' })).status, 303)
})

test('pages keep to themselves: scripts, frames, referrers and caches', async () => {
  const { browser } = await connected()
  const { headers } = await browser.get('/')
  const policy = headers.get('content-security-policy')!
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /frame-ancestors 'none'/)
  assert.doesNotMatch(policy, /unsafe/)
  // Not no-referrer: browsers then send `Origin: null` with a page's own forms.
  assert.equal(headers.get('referrer-policy'), 'same-origin')
  assert.equal(headers.get('cache-control'), 'no-store')
})

test('the session cookie is out of scripts’ reach, and https only here', async () => {
  const { browser } = setup()
  const answer = await browser.post('/setup', { client_id: CLIENT_ID })
  const location = answer.headers.get('location')!
  const callback = (await browser.external(location, { redirect: 'manual' })).headers.get('location')!
  const end = await browser.get(callback)
  const cookie = end.headers.getSetCookie().find((c) => c.startsWith('adapter_session='))!
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /SameSite=Lax/)
})

test('text from Spotify is escaped in pages', async () => {
  const { browser, spotify } = setup()
  spotify.owner = { id: 'x', display_name: '<script>alert(1)</script>' }
  await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
  const page = await (await browser.get('/')).text()
  assert.doesNotMatch(page, /<script>alert/)
  assert.match(page, /&lt;script&gt;alert/)
})

test('forgetting everything starts over', async () => {
  const { browser, store, key } = await keyed()
  assert.ok(key)
  const end = await browser.follow(await browser.post('/reset'))
  assert.match(await end.text(), /Connect your Spotify/)
  assert.equal(store.value, null)
})

// ─── The API ─────────────────────────────────────────────────────────────────

test('the API answers at AzuraCast’s paths, with a key, with or without a / at the end', async () => {
  const { ask, spotify } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.queue = [track('b')]
  for (const path of [NOW_PLAYING, `${NOW_PLAYING}/`, '/api/nowplaying/1']) {
    const response = await ask(path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-type'), 'application/json')
    const nowPlaying = await response.json()
    assert.equal(nowPlaying.is_online, true)
    assert.equal(nowPlaying.now_playing.song.title, 'Title a')
    assert.equal(nowPlaying.playing_next.song.title, 'Title b')
  }
  const all = await (await ask('/api/nowplaying')).json()
  assert.equal(all.length, 1)
  assert.equal(all[0].station.shortcode, 'spotify')
  for (const path of [QUEUE, '/api/station/1/queue/']) {
    const queue = await (await ask(path)).json()
    assert.deepEqual(queue.map((item: { song: { title: string } }) => item.song.title), ['Title b'])
  }
})

test('another station, or another path, is not found', async () => {
  const { ask, spotify } = await keyed()
  for (const path of ['/api/nowplaying/2', '/api/nowplaying/other', '/api/station/2/queue', '/api/station/spotify/requests', '/api']) {
    const response = await ask(path)
    assert.equal(response.status, 404, path)
  }
  assert.equal(spotify.calls.player, 0)
})

test('any site may call it from a page: it takes a key, never cookies', async () => {
  const { ask, app, spotify } = await keyed()
  spotify.playback = playing('a', 5_000)
  const preflight = await app.handle(
    new Request(`${ADAPTER}${NOW_PLAYING}`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://site.example', 'Access-Control-Request-Headers': 'authorization' },
    })
  )
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-headers')!, /Authorization/)
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
  const answer = await ask(NOW_PLAYING, { Origin: 'https://site.example' })
  assert.equal(answer.headers.get('access-control-allow-origin'), '*')
  const refused = await ask(NOW_PLAYING, { Authorization: 'Bearer wrong' })
  assert.equal(refused.headers.get('access-control-allow-origin'), '*', 'so a page can tell why')
})

test('HEAD answers as GET does, without a body', async () => {
  const { ask, spotify } = await keyed()
  spotify.playback = playing('a', 5_000)
  const answer = await ask(NOW_PLAYING, {}, 'HEAD')
  assert.equal(answer.status, 200)
  assert.equal(await answer.text(), '')
})
test('no key, or the wrong key, is 401, and reads nothing', async () => {
  const { app, spotify } = await keyed()
  const before = spotify.calls.player
  const attempts: Record<string, string>[] = [
    {},
    { Authorization: 'Bearer wrong' },
    { Authorization: 'Basic x' },
  ]
  for (const headers of attempts) {
    const answer = await app.handle(new Request(`${ADAPTER}${NOW_PLAYING}`, { headers }))
    assert.equal(answer.status, 401)
    assert.equal(answer.headers.get('www-authenticate'), 'Bearer')
  }
  assert.equal(spotify.calls.player, before)
})

test('a method other than GET is refused', async () => {
  const { ask } = await keyed()
  const answer = await ask(NOW_PLAYING, {}, 'PUT')
  assert.equal(answer.status, 405)
  assert.match(answer.headers.get('allow')!, /GET/)
})

test('elapsed time moves on between reads of Spotify, and stands still when paused', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  const first = (await (await ask()).json()).now_playing
  clock.advance(3_000)
  const second = (await (await ask()).json()).now_playing
  assert.equal(spotify.calls.player, 1)
  assert.equal(second.elapsed, first.elapsed + 3)
  assert.equal(second.played_at, first.played_at)
  clock.advance(2_000)
  spotify.playback = playing('a', 10_000, { is_playing: false })
  const paused = await (await ask()).json()
  clock.advance(3_000)
  const later = await (await ask()).json()
  assert.equal(paused.is_online, false)
  assert.equal(later.now_playing.elapsed, 10)
})
test('fetches close together share one read of Spotify', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  await Promise.all([ask(), ask(), ask()])
  assert.equal(spotify.calls.player, 1)
  clock.advance(1_000)
  await ask()
  assert.equal(spotify.calls.player, 1)
  clock.advance(3_000)
  await ask()
  assert.equal(spotify.calls.player, 2)
})

test('a fetch just after the expected end reads Spotify, however recent the last read', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 199_000)
  await ask()
  assert.equal(spotify.calls.player, 1)
  clock.advance(2_500)
  spotify.playback = playing('b', 1_500)
  await ask()
  assert.equal(spotify.calls.player, 2)
})

test('the queue is read when the track changes and now and then, not on every read', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.queue = [track('b')]
  await ask()
  assert.equal(spotify.calls.queue, 1)
  for (let i = 1; i <= 5; i++) {
    clock.advance(5_000)
    spotify.playback = playing('a', 5_000 + i * 5_000)
    await ask()
  }
  assert.equal(spotify.calls.queue, 1)
  clock.advance(5_000)
  spotify.playback = playing('a', 35_000)
  await ask()
  assert.equal(spotify.calls.queue, 2)
  clock.advance(5_000)
  spotify.playback = playing('b', 5_000)
  await ask()
  assert.equal(spotify.calls.queue, 3)
})

test('nothing on means no queue read', async () => {
  const { ask, spotify } = await keyed()
  spotify.playback = null
  await ask()
  assert.equal(spotify.calls.queue, 0)
})

test('a queue that fails costs what is next, not what is on', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.failQueue = () => json({ error: { status: 500, message: 'no' } }, 500)
  const response = await ask()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).playing_next, null)
  clock.advance(5_000)
  spotify.failQueue = () => new Response(null, { status: 429, headers: { 'Retry-After': '7' } })
  clock.advance(30_000)
  spotify.playback = playing('a', 40_000)
  assert.equal((await ask()).status, 200)
})

test('max-age is a few seconds, and never hides a track’s end', async () => {
  const { ask, spotify, clock } = await keyed()
  const maxAge = async () =>
    Number(/max-age=(\d+)/.exec((await ask()).headers.get('cache-control')!)![1])
  spotify.playback = playing('a', 100_000)
  assert.equal(await maxAge(), 5, 'far from its end')
  // 98 s later, with 2 s left: back in 2 s + 1.5 s, not in 5.
  clock.advance(98_000)
  spotify.playback = playing('a', 198_000)
  assert.equal(await maxAge(), 4)
  // Just before its end: 0.5 s + 1.5 s.
  clock.advance(1_500)
  assert.equal(await maxAge(), 2)
  // Past its end and still on: don't lose it, but don't hammer either.
  clock.advance(3_000)
  spotify.playback = playing('a', 199_900)
  assert.equal(await maxAge(), 2)
})

test('paused or stopped, a client is asked to come back less often', async () => {
  const { ask, spotify } = await keyed()
  spotify.playback = playing('a', 100_000, { is_playing: false })
  assert.match((await ask()).headers.get('cache-control')!, /private, max-age=10/)
})

test('Spotify rate limiting is passed on, and Spotify left alone until it ends', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.failPlayer = () => new Response(null, { status: 429, headers: { 'Retry-After': '42' } })
  const answer = await ask()
  assert.equal(answer.status, 429)
  assert.equal(answer.headers.get('retry-after'), '42')
  const calls = spotify.calls.player
  clock.advance(20_000)
  const later = await ask()
  assert.equal(later.status, 429)
  assert.equal(later.headers.get('retry-after'), '22')
  assert.equal(spotify.calls.player, calls)
  spotify.failPlayer = null
  spotify.playback = playing('a', 5_000)
  clock.advance(23_000)
  assert.equal((await ask()).status, 200)
})

test('Spotify failing is a 503 a client backs off from, never a 401 or 403', async () => {
  const { ask, spotify } = await keyed()
  for (const failure of [
    () => new Response('oops', { status: 502 }),
    () => json({ error: { status: 403, message: 'Premium required' } }, 403),
    () => new Response('not json at all', { status: 200 }),
  ]) {
    spotify.failPlayer = failure
    const answer = await ask()
    assert.equal(answer.status, 503)
    assert.ok(Number(answer.headers.get('retry-after')) >= 1)
    spotify.failPlayer = null
  }
})

test('Spotify’s reason for refusing is shown to the owner, and clears when it stops', async () => {
  const { ask, spotify, browser, clock } = await keyed()
  spotify.failPlayer = () =>
    json({ error: { status: 403, message: 'Active premium subscription required' } }, 403)
  await ask()
  const status = await (await browser.get('/status.json')).json()
  assert.match(status.problem, /premium/)
  spotify.failPlayer = null
  spotify.playback = playing('a', 5_000)
  clock.advance(5_000)
  const after = await (await browser.get('/status.json')).json()
  assert.equal(after.problem, undefined)
  assert.equal(after.title, 'Title a')
  assert.equal(after.state, 'playing')
})

// ─── Spotify's tokens ────────────────────────────────────────────────────────

test('an access token is refreshed before it ends, and a rotated refresh token kept', async () => {
  const { ask, spotify, clock, store } = await keyed()
  spotify.playback = playing('a', 5_000)
  const before = (store.value as { spotify: { refreshToken: string } }).spotify.refreshToken
  clock.advance(3_590_000)
  assert.equal((await ask()).status, 200)
  assert.equal(spotify.calls.refresh, 1)
  const after = (store.value as { spotify: { refreshToken: string } }).spotify.refreshToken
  assert.notEqual(after, before)
  clock.advance(3_590_000)
  assert.equal((await ask()).status, 200)
  assert.equal(spotify.calls.refresh, 2)
})

test('a refresh token that is not rotated stays', async () => {
  const { ask, spotify, clock, store } = await keyed()
  spotify.rotateRefreshTokens = false
  spotify.playback = playing('a', 5_000)
  const before = (store.value as { spotify: { refreshToken: string } }).spotify.refreshToken
  clock.advance(3_590_000)
  assert.equal((await ask()).status, 200)
  assert.equal((store.value as { spotify: { refreshToken: string } }).spotify.refreshToken, before)
})

test('a token Spotify ends early is refreshed and the read tried again, once', async () => {
  const { ask, spotify } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.expireAccess()
  assert.equal((await ask()).status, 200)
  assert.equal(spotify.calls.refresh, 1)
})

test('with a rotating refresh token, fetches at once still refresh only once', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  clock.advance(3_590_000)
  const answers = await Promise.all([ask(), ask(), ask(), ask()])
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200])
  assert.equal(spotify.calls.refresh, 1)
})

test('when the authorization ends, clients wait, the owner is told, and one click fixes it', async () => {
  const { ask, spotify, clock, browser } = await keyed()
  spotify.playback = playing('a', 5_000)
  await ask()
  spotify.expireRefresh()
  clock.advance(3_590_000)

  const waiting = await ask()
  assert.equal(waiting.status, 503)
  assert.equal(waiting.headers.get('retry-after'), '300')
  const calls = spotify.calls.refresh
  clock.advance(10_000)
  assert.equal((await ask()).status, 503)
  assert.equal(spotify.calls.refresh, calls, 'it knows: it does not keep asking')

  const page = await (await browser.get('/')).text()
  assert.match(page, /Authorize again/)
  await browser.follow(await browser.post('/signin'))
  clock.advance(5_000)
  const back = await ask()
  assert.equal(back.status, 200, 'the same key works again, with nothing to do at the client')
})

test('the dashboard warns as the six months run out, and signing in renews them', async () => {
  const { browser, clock } = await connected()
  const warning = /and this one on <b>/
  assert.doesNotMatch(await (await browser.get('/')).text(), warning)
  clock.advance(150 * 24 * 60 * 60 * 1000)
  assert.doesNotMatch(await (await browser.get('/')).text(), warning)
  clock.advance(15 * 24 * 60 * 60 * 1000)
  assert.match(await (await browser.get('/')).text(), warning)
  await browser.follow(await browser.post('/signin'))
  assert.doesNotMatch(await (await browser.get('/')).text(), warning)
})

test('when it has ended, even a signed-out page says so, and signing in fixes it', async () => {
  const { app, external, spotify, ask, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.expireRefresh()
  clock.advance(3_590_000)
  assert.equal((await ask()).status, 503)
  const stranger = new Browser(app, external)
  const page = await (await stranger.get('/')).text()
  assert.match(page, /ended this adapter/)
  await stranger.follow(await stranger.post('/signin'))
  assert.equal((await ask()).status, 200)
})

test('only an expired or revoked refresh token ends the link: any other refusal may pass', async () => {
  const { ask, spotify, clock, store } = await keyed()
  spotify.playback = playing('a', 5_000)
  await ask()
  clock.advance(3_590_000)
  for (const failure of [
    () => json({ error: 'temporarily_unavailable' }, 400),
    () => new Response('<html>Request Timeout</html>', { status: 408 }),
    () => new Response('<html>Forbidden</html>', { status: 403 }),
  ]) {
    spotify.failRefresh = failure
    assert.equal((await ask()).status, 503)
    const link = (store.value as { spotify: { dead: boolean } }).spotify
    assert.equal(link.dead, false)
    clock.advance(5_000)
  }
  spotify.failRefresh = null
  assert.equal((await ask()).status, 200, 'it recovers by itself')
})

test('a refresh answer that takes a while is still waited for, so a rotated token is not lost', async () => {
  const seen: number[] = []
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  const original = AbortSignal.timeout
  AbortSignal.timeout = (ms: number) => {
    seen.push(ms)
    return original.call(AbortSignal, ms)
  }
  try {
    clock.advance(3_590_000)
    await ask()
  } finally {
    AbortSignal.timeout = original
  }
  assert.ok(Math.max(...seen) >= 10_000, `The longest timeout was ${Math.max(...seen)} ms.`)
})

/** Reads along every 5 s until the queue is due again, without a gap. */
async function untilQueueIsDue(
  ask: () => Promise<Response>,
  spotify: FakeSpotify,
  clock: Clock
) {
  for (let i = 1; i <= 5; i++) {
    clock.advance(5_000)
    spotify.playback = playing('a', 5_000 + i * 5_000)
    await ask()
  }
  clock.advance(5_000)
}

test('a private session’s queue is not read while the session settles', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.queue = []
  await ask()
  await untilQueueIsDue(ask, spotify, clock)
  spotify.playback = playing('a', 35_000, { device: { is_private_session: true } })
  spotify.queue = [track('secret')]
  const nowPlaying = await (await ask()).json()
  assert.equal(nowPlaying.now_playing.song.title, 'Title a', 'still settling')
  assert.equal(nowPlaying.playing_next, null)
  assert.equal(spotify.calls.queue, 1)
})

test('a flicker of nothing does not read the queue either', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.queue = [track('b')]
  await ask()
  await untilQueueIsDue(ask, spotify, clock)
  spotify.playback = null
  const nowPlaying = await (await ask()).json()
  assert.equal(nowPlaying.is_online, true, 'still settling')
  assert.equal(spotify.calls.queue, 1)
})

test('after a long gap, what was on is no longer true: nothing waits to settle', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  await ask()
  spotify.playback = null
  clock.advance(2 * 24 * 60 * 60 * 1000)
  const stopped = await (await ask()).json()
  assert.equal(stopped.is_online, false)
  assert.equal(stopped.now_playing.sh_id, 0)
  spotify.playback = playing('a', 5_000)
  clock.advance(5_000)
  await ask()
  spotify.playback = playing('b', 100)
  clock.advance(60 * 60 * 1000)
  const moved = await (await ask()).json()
  assert.equal(moved.now_playing.song.title, 'Title b')
})

test('an answer that breaks off part way costs the read, not a 500', async () => {
  const { ask, spotify, clock } = await keyed()
  const broken = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'))
        },
      }),
      { status: 200 }
    )
  spotify.failPlayer = broken
  assert.equal((await ask()).status, 503)
  spotify.failPlayer = null
  spotify.playback = playing('a', 5_000)
  spotify.failQueue = broken
  clock.advance(5_000)
  const answer = await ask()
  assert.equal(answer.status, 200, 'a queue that breaks off never fails the read')
})

test('a slow read of the player leaves the queue for next time, to answer in time', async () => {
  const { ask, spotify, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  spotify.queue = [track('b')]
  spotify.failPlayer = () => {
    clock.advance(3_000)
    return json(spotify.playback)
  }
  const first = await (await ask()).json()
  assert.equal(first.playing_next, null)
  assert.equal(spotify.calls.queue, 0)
  spotify.failPlayer = null
  clock.advance(5_000)
  spotify.playback = playing('a', 13_000)
  const second = await (await ask()).json()
  assert.equal(second.playing_next.song.title, 'Title b')
})

test('a crafted notice in a link changes nothing', async () => {
  const { browser } = await connected()
  for (const name of ['constructor', '__proto__', 'toString', 'nonsense']) {
    assert.equal((await browser.get(`/?notice=${name}`)).status, 200, name)
  }
})

test('a forgotten install stays forgotten, whatever is saved meanwhile', async () => {
  const { browser, app, store } = await connected()
  const clear = store.clear
  store.clear = async () => {
    await clear()
    await app.persist()
  }
  await browser.post('/reset')
  assert.doesNotMatch(JSON.stringify(store.value), /refreshToken/)
})

test('a session survives old ones being dropped as it is made', async () => {
  const { app, external, clock } = await connected()
  clock.advance(401 * 24 * 60 * 60 * 1000)
  const browser = new Browser(app, external)
  await browser.follow(await browser.post('/signin'))
  assert.doesNotMatch(await (await browser.get('/')).text(), /Sign in with Spotify/)
})

// ─── API keys ────────────────────────────────────────────────────────────────

test('a new key is shown once, with how to use it, and works at once', async () => {
  const { browser, app, spotify } = await connected()
  spotify.playback = playing('a', 5_000)
  const answer = await browser.post('/keys', { label: 'Mine <3' })
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  const page = await answer.text()
  assert.match(page, /Mine &lt;3/)
  const key = /<div class="value">([^<]+)<\/div>/.exec(page)![1]!
  assert.ok(key.length >= 43, '256 bits')
  assert.ok(page.includes(`curl -H &quot;Authorization: Bearer ${key}&quot; https://adapter.fake.test/api/nowplaying/spotify`))
  const read = await app.handle(
    new Request(`${ADAPTER}${NOW_PLAYING}`, { headers: { Authorization: `Bearer ${key}` } })
  )
  assert.equal(read.status, 200)
  const dashboard = await (await browser.get('/')).text()
  assert.ok(!dashboard.includes(key), 'and never again')
  assert.match(dashboard, /Mine &lt;3/)
  assert.ok(dashboard.includes('https://adapter.fake.test/api/station/spotify/queue'))
})

test('only the key’s hash is kept', async () => {
  const { store, key } = await keyed()
  assert.ok(!JSON.stringify(store.value).includes(key))
})
test('removing a key stops it at once', async () => {
  const { ask, browser, store, spotify } = await keyed()
  spotify.playback = playing('a', 5_000)
  assert.equal((await ask()).status, 200)
  const id = (store.value as { keys: { id: string }[] }).keys[0]!.id
  await browser.post(`/keys/${id}/remove`)
  assert.equal((await ask()).status, 401)
})

test('each client has its own key, and one going leaves the other', async () => {
  const { ask, browser, app, store, spotify } = await keyed()
  spotify.playback = playing('a', 5_000)
  const second = await makeKey(browser, 'Second')
  const id = (store.value as { keys: { id: string }[] }).keys[0]!.id
  await browser.post(`/keys/${id}/remove`)
  assert.equal((await ask()).status, 401)
  const read = await app.handle(
    new Request(`${ADAPTER}${NOW_PLAYING}`, { headers: { Authorization: `Bearer ${second}` } })
  )
  assert.equal(read.status, 200)
})
test('when a key was last used shows on the dashboard, without a write on every request', async () => {
  const { ask, browser, spotify, store, clock } = await keyed()
  spotify.playback = playing('a', 5_000)
  await ask()
  const saves = store.saves
  for (let i = 0; i < 10; i++) {
    clock.advance(5_000)
    spotify.playback = playing('a', 5_000 + (i + 1) * 5_000)
    await ask()
  }
  assert.equal(store.saves, saves, 'nothing changed: nothing written')
  assert.match(await (await browser.get('/')).text(), /Last used/)
})

// ─── The update notice ───────────────────────────────────────────────────────

function withRelease(tag: string | null, update?: AppOptions['update']) {
  let latest = tag
  const spotify = new FakeSpotify()
  let asked = 0
  const external = fakeFetch({
    [ACCOUNTS]: spotify.handle,
    [API]: spotify.handle,
    'https://github.com': latestRelease(
      () => latest?.replace(/^v/, '') ?? null,
      () => {
        asked += 1
      }
    ),
  })
  const clock = new Clock()
  const app = new App({
    store: memoryStore(),
    now: clock.now,
    fetch: external,
    spotify: { accounts: ACCOUNTS, api: API },
    ...(update ? { update } : {}),
  })
  const release = (tag: string) => {
    latest = tag
  }
  return { app, external, browser: new Browser(app, external), clock, asked: () => asked, release }
}

/** A page as its reader sees it: apostrophes come escaped. */
const read = async (answer: Response) => (await answer.text()).replaceAll('&#39;', "'")

/** Signed in, as the owner, with releases up to `tag` on GitHub. */
async function ownerWithRelease(tag: string | null, update?: AppOptions['update']) {
  const context = withRelease(tag, update)
  await context.browser.follow(await context.browser.post('/setup', { client_id: CLIENT_ID }))
  return context
}

const named = (name: string, message = 'Bearer cf-token-that-must-stay-secret') =>
  Object.assign(new Error(message), { name })

test('a newer release is mentioned, and looked for at most once a day', async () => {
  const { browser, clock, asked } = withRelease('v9.0.0')
  await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
  const page = await (await browser.get('/')).text()
  assert.match(page, /Version 9\.0\.0 is out/)
  assert.match(page, /installs itself within a day/)
  await browser.get('/')
  assert.equal(asked(), 1)
  clock.advance(25 * 60 * 60 * 1000)
  await browser.get('/')
  assert.equal(asked(), 2)
})

test('the same version or an older one is not', async () => {
  for (const tag of ['v0.1.0', 'v0.0.9']) {
    const { browser } = withRelease(tag)
    await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
    assert.doesNotMatch(await (await browser.get('/')).text(), /is out/)
  }
})

test('the update check failing changes nothing', async () => {
  const spotify = new FakeSpotify()
  const external = fakeFetch({ [ACCOUNTS]: spotify.handle, [API]: spotify.handle })
  const app = new App({
    store: memoryStore(),
    fetch: external,
    spotify: { accounts: ACCOUNTS, api: API },
  })
  const browser = new Browser(app, external)
  const end = await browser.follow(await browser.post('/setup', { client_id: CLIENT_ID }))
  assert.equal(end.status, 200)
  assert.doesNotMatch(await end.text(), /is out/)
})

test('unknown paths and methods are not found, signed in or not', async () => {
  const { browser } = await connected()
  assert.equal((await browser.post('/keys/nothing/remove')).status, 404)
})

test('“Check for updates” asks GitHub straight away, and says when this is the latest', async () => {
  const { browser, asked } = await ownerWithRelease('v0.1.0')
  const before = asked()
  const page = await read(await browser.follow(await browser.post('/update/check')))
  assert.equal(asked(), before + 1, 'however recently it last asked')
  assert.match(page, /This is the latest version/)
  assert.match(page, new RegExp(`This is version <b>${VERSION.replaceAll('.', '\\.')}</b>`))
})

test('a version that came out since the last look shows on checking, with a button to install it', async () => {
  const { browser, release } = await ownerWithRelease('v0.1.0')
  release('v9.0.0')
  assert.doesNotMatch(await read(await browser.get('/')), /is out/, 'not until a day has passed, or someone checks')
  const page = await read(await browser.follow(await browser.post('/update/check')))
  assert.match(page, /Version 9\.0\.0 is out/)
  assert.match(page, /<form method="post" action="\/update"><button>Update now<\/button>/)
})

test('GitHub not answering a check is said, and not taken for “up to date”', async () => {
  const { browser } = await ownerWithRelease(null)
  const page = await read(await browser.follow(await browser.post('/update/check')))
  assert.match(page, /GitHub didn't answer/)
  assert.doesNotMatch(page, /latest version/)
})

test('“Update now” installs the new version, and says so', async () => {
  let updates = 0
  const { browser } = await ownerWithRelease('v9.0.0', async () => {
    updates += 1
    return 'updated'
  })
  const page = await read(await browser.follow(await browser.post('/update')))
  assert.equal(updates, 1)
  assert.match(page, /new version is installed, and takes over within a minute/)
})

test('“Update now” says plainly why it couldn’t, and never an error’s text', async () => {
  const cases: [NonNullable<AppOptions['update']>, RegExp][] = [
    [async () => 'up-to-date', /This is the latest version/],
    [async () => 'no-token', /wasn't installed with a Cloudflare API token/],
    [async () => { throw named('UploadRefused') }, /Cloudflare refused the new version.*Workers Scripts: Edit/],
    [async () => { throw named('ReleaseCheckFailed') }, /GitHub didn't answer/],
    [async () => { throw named('ReleaseUnavailable') }, /couldn't be downloaded/],
    [async () => { throw named('ReleaseMismatch') }, /couldn't be downloaded/],
    [async () => { throw new TypeError('Bearer cf-token-that-must-stay-secret') }, /couldn't be downloaded/],
  ]
  for (const [update, expected] of cases) {
    const { browser } = await ownerWithRelease('v9.0.0', update)
    const page = await read(await browser.follow(await browser.post('/update')))
    assert.match(page, expected, String(expected))
    assert.doesNotMatch(page, /cf-token-that-must-stay-secret/)
  }
  const { browser } = await ownerWithRelease('v9.0.0')
  assert.match(await read(await browser.follow(await browser.post('/update'))), /can't update itself/)
})

test('only the owner can update or check, and only from these pages', async () => {
  let updates = 0
  const { app, external, browser, asked } = await ownerWithRelease('v9.0.0', async () => {
    updates += 1
    return 'updated'
  })
  const before = asked()
  const stranger = new Browser(app, external)
  for (const path of ['/update', '/update/check']) {
    const answer = await stranger.post(path)
    assert.equal(answer.status, 303, path)
    assert.equal(answer.headers.get('location'), '/', path)
    assert.equal((await browser.post(path, {}, 'https://evil.example')).status, 403, path)
  }
  assert.equal(updates, 0)
  assert.equal(asked(), before)
})
