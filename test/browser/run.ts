/**
 * The journey in a real browser: what only a browser enforces can only be tested
 * in one. Its first run found that `Referrer-Policy: no-referrer` made browsers
 * send `Origin: null`, which refused every form on every page.
 *
 *   npx playwright install --with-deps chromium-headless-shell
 *   npm run test:browser                  # SCREENSHOTS=<directory> to see it
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { chromium, type Page } from 'playwright'
// @ts-expect-error: a plain script for browsers, with no types.
import { RELAY } from '../../site/install.js'
import { App, isRoute } from '../../src/app.ts'
import { CLIENT_ID, NOW_PLAYING, memoryStore, playing, track } from '../helpers/fakes.ts'
import { fakeServers, serve } from '../helpers/http.ts'

const shots = process.env.SCREENSHOTS
if (shots) mkdirSync(shots, { recursive: true })
const shoot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true })
}
const step = (text: string) => console.log(`ok - ${text}`)
function check(condition: unknown, text: string): asserts condition {
  if (!condition) throw new Error(text)
}

const fakes = await fakeServers()
const named = (id: string, name: string, ...artists: string[]) =>
  track(id, { name, artists: artists.map((artist) => ({ name: artist })) })
fakes.spotify.playback = playing('a', 40_000, {
  item: named('a', 'Slow Kettle Waltz', 'Paperclip Lagoon'),
})
fakes.spotify.queue = [
  named('b', 'Moss Telegram', 'Paperclip Lagoon'),
  named('c', 'Harbour of Small Lamps', 'Tin Orchard', 'June Vale'),
]
const app = new App({
  store: memoryStore(),
  spotify: { accounts: fakes.spotifyServer.origin, api: fakes.spotifyServer.origin },
})
// What the Worker does in front of the app. A browser asks for things like /favicon.ico.
const host = await serve(async (request) =>
  isRoute(new URL(request.url).pathname)
    ? app.handle(request)
    : new Response('Not found.', { status: 404 })
)
// The install page as GitHub Pages serves it, with a release's two files beside it.
const siteDirectory = join(import.meta.dirname, '..', '..', 'site')
const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
}
const site = await serve(async (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === '/worker.js') {
    return new Response('export default {}', { headers: { 'Content-Type': 'text/javascript' } })
  }
  if (pathname === '/worker.json') {
    return Response.json({ compatibility_date: '2026-10-01', compatibility_flags: [] })
  }
  const file = pathname === '/' ? 'index.html' : pathname.slice(1)
  try {
    return new Response(readFileSync(join(siteDirectory, file)), {
      headers: { 'Content-Type': contentTypes[extname(file)] ?? 'text/plain' },
    })
  } catch {
    return new Response('Not found.', { status: 404 })
  }
})
// Some other site, as a page that shows what someone plays would be. Not the
// install page: its own policy lets it talk only to itself and the relay.
const elsewhereSite = await serve(
  async () => new Response('<!doctype html><title>Another site</title>', { headers: { 'Content-Type': 'text/html' } })
)
const browser = await chromium.launch()
const problems: string[] = []
const watch = (page: Page) => {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => problems.push(`script: ${error.message}`))
}

let failed = false
try {
  const context = await browser.newContext({
    viewport: { width: 760, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  watch(page)

  await page.goto(host.origin)
  await shoot(page, '1-setup')

  await page.locator('[data-copy]').nth(2).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  check(copied === `${host.origin}/spotify/callback`, `Copied ${copied}`)
  step('a copy button copies the redirect URI, under the content security policy')

  await page.fill('#client_id', 'nope')
  await page.click('button:has-text("Connect Spotify")')
  check(page.url() === `${host.origin}/`, 'a wrong Client ID should stay on the page')
  step('a wrong Client ID is stopped in the browser')

  await page.fill('#client_id', `  ${CLIENT_ID} `)
  await page.click('button:has-text("Connect Spotify")')
  await page.waitForSelector('[data-live]', { timeout: 5_000 })
  step('a form, through Spotify, to the dashboard: forms and redirects are allowed')

  await page.waitForFunction(() => document.querySelector('[data-title]')?.textContent !== '')
  const title = await page.textContent('[data-title]')
  check(title === 'Slow Kettle Waltz', `Showed ${title}`)
  check((await page.locator('[data-next] li').count()) === 2, 'should list what is next')
  await shoot(page, '2-dashboard')
  step('the live card shows what is playing and what is next')

  await page.fill('#label', 'My site')
  await page.click('button:has-text("Make a key")')
  await page.waitForSelector('.value')
  const key = (await page.locator('.value').first().textContent()) ?? ''
  check(/^[\w-]{43}$/.test(key), `Key ${key}`)
  await shoot(page, '3-key')
  await page.click('a:has-text("Done")')
  await page.waitForSelector('[data-live]')
  step('a key is made, and shown')

  // Another site's page, calling the API with the key: the browser's own CORS checks.
  const elsewhere = await context.newPage()
  watch(elsewhere)
  await elsewhere.goto(elsewhereSite.origin)
  const fromElsewhere = await elsewhere.evaluate(
    async ([url, key]) => {
      const answer = await fetch(url!, { headers: { Authorization: `Bearer ${key}` } })
      return { status: answer.status, body: await answer.json() }
    },
    [`${host.origin}${NOW_PLAYING}`, key]
  )
  check(fromElsewhere.status === 200, `From another site: ${fromElsewhere.status}`)
  check(
    fromElsewhere.body.now_playing.song.title === 'Slow Kettle Waltz',
    `From another site: ${JSON.stringify(fromElsewhere.body.now_playing)}`
  )
  await elsewhere.close()
  step('a page on another site reads now playing with the key, through a preflight')

  page.once('dialog', (dialog) => void dialog.dismiss())
  const keys = await page.locator('button:has-text("Remove")').count()
  await page.locator('button:has-text("Remove")').first().click()
  await page.waitForTimeout(200)
  check(
    (await page.locator('button:has-text("Remove")').count()) === keys,
    'cancelling should cancel'
  )
  page.once('dialog', (dialog) => void dialog.accept())
  await page.locator('button:has-text("Remove")').first().click()
  await page.waitForFunction(
    (count) => document.querySelectorAll('ul.plain button').length === count - 1,
    keys
  )
  step('removing a key asks first')

  fakes.spotify.playback = null
  const dark = await browser.newContext({
    viewport: { width: 390, height: 800 },
    colorScheme: 'dark',
    storageState: await context.storageState(),
  })
  const narrow = await dark.newPage()
  watch(narrow)
  await narrow.goto(host.origin)
  await narrow.waitForTimeout(400)
  await shoot(narrow, '5-narrow-dark')
  check(
    !(await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
    'a narrow page should not scroll sideways'
  )
  step('a narrow screen, in dark mode')

  const stranger = await (await browser.newContext()).newPage()
  watch(stranger)
  await stranger.goto(host.origin)
  await shoot(stranger, '6-signed-out')
  check((await stranger.locator('[data-live]').count()) === 0, 'signed out should show nothing')
  await stranger.click('button:has-text("Sign in with Spotify")')
  await stranger.waitForSelector('[data-live]', { timeout: 5_000 })
  step('another browser signs in with Spotify, and nothing else')

  // The install page, with Cloudflare's API stood in for at the relay.
  const installer = await context.newPage()
  watch(installer)
  const asked: string[] = []
  await installer.route(`${RELAY}/**`, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    asked.push(`${request.method()} ${pathname}`)
    const result = pathname.endsWith('/workers/subdomain')
      ? { subdomain: 'me' }
      : pathname.endsWith('/workers/scripts')
        ? []
        : {}
    await route.fulfill({
      json: { success: true, result },
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  })
  await installer.goto(site.origin)
  await shoot(installer, '7-install')
  await installer.fill('#token', 'a-cloudflare-token')
  await installer.fill('#account', '0123456789abcdef0123456789abcdef')
  await installer.click('button:has-text("Install")')
  await installer.waitForSelector('#done a', { state: 'visible', timeout: 5_000 })
  const installedAt = await installer.locator('#done a').getAttribute('href')
  check(installedAt === 'https://spotify-azuracast.me.workers.dev', `Installed at ${installedAt}`)
  check(asked.some((call) => call.startsWith('PUT ') && call.endsWith('/scripts/spotify-azuracast')), 'no upload')
  check((await installer.inputValue('#token')) === '', 'the token should leave the form')
  await installer.close()
  step('the install page uploads the Worker and shows its address')

  await page.goto(host.origin)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.click('button:has-text("Forget everything")')
  await page.waitForSelector('#client_id', { timeout: 5_000 })
  step('forgetting everything goes back to setup')

  check(problems.length === 0, `The browser complained:\n${problems.join('\n')}`)
} catch (error) {
  failed = true
  console.error(error)
} finally {
  await browser.close()
  await host.close()
  await site.close()
  await elsewhereSite.close()
  await fakes.close()
}
if (failed) process.exit(1)
console.log('All browser checks passed.')
process.exit(0)
