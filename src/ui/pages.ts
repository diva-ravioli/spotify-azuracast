/**
 * The pages: plain HTML from the adapter itself. Nothing from anywhere else
 * loads, and everything that didn't come from this file is escaped.
 */
import type { ApiKey } from '../state.ts'
import { VERSION } from '../version.ts'

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f5f2; --card: #fff; --ink: #1c1b19; --soft: #6a665e;
  --line: #e2dfd7; --accent: #3b3fce; --accent-ink: #fff; --warn: #8a5200; --warn-bg: #fdf1dc;
  --bad: #a11d1d; --bad-bg: #fbe6e6; --good: #1d6b3a; --good-bg: #e2f4e8; }
@media (prefers-color-scheme: dark) { :root { --bg: #15151a; --card: #1f1f26; --ink: #ecebe6;
  --soft: #a09d94; --line: #33333c; --accent: #8e91ff; --accent-ink: #14141a; --warn: #f0bd6e;
  --warn-bg: #3a2c12; --bad: #f29a9a; --bad-bg: #3d1a1a; --good: #84d6a2; --good-bg: #16321f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.5;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 38rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
p { margin: .5rem 0; }
.lede { color: var(--soft); margin-bottom: 1.5rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 1.1rem 1.25rem; margin: 1rem 0; }
.soft { color: var(--soft); font-size: .9rem; }
a { color: var(--accent); }
ol.fields { list-style: decimal; padding-left: 1.25rem; margin: .5rem 0; }
ol.fields li { margin: .55rem 0; }
.copy { display: flex; gap: .4rem; margin-top: .3rem; }
code, .value { font: .85rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.value { flex: 1; min-width: 0; padding: .4rem .55rem; border: 1px solid var(--line);
  border-radius: 6px; background: var(--bg); overflow-wrap: anywhere; user-select: all; }
label { display: block; font-weight: 600; font-size: .9rem; margin: .75rem 0 .25rem; }
input[type=text] { width: 100%; padding: .55rem .65rem; font: inherit; color: inherit;
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
button, .button { display: inline-block; font: inherit; font-weight: 600; cursor: pointer;
  padding: .5rem .9rem; border-radius: 6px; border: 1px solid var(--accent);
  background: var(--accent); color: var(--accent-ink); text-decoration: none; }
button.quiet, .button.quiet { background: transparent; color: var(--accent); font-weight: 500; }
button.small { padding: .25rem .55rem; font-size: .85rem; }
form { margin: .5rem 0 0; }
form.inline { display: inline; margin: 0; }
.row { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-top: .75rem; }
.notice { padding: .65rem .85rem; border-radius: 8px; margin: 1rem 0; }
.notice.warn { color: var(--warn); background: var(--warn-bg); }
.notice.bad { color: var(--bad); background: var(--bad-bg); }
.notice.good { color: var(--good); background: var(--good-bg); }
.track { font-weight: 600; }
ul.plain { list-style: none; margin: .5rem 0 0; padding: 0; }
ul.plain > li { display: flex; justify-content: space-between; gap: .75rem; align-items: center;
  padding: .55rem 0; border-top: 1px solid var(--line); }
ol.next { margin: .4rem 0 0; padding-left: 1.25rem; color: var(--soft); font-size: .9rem; }
details { margin-top: .75rem; }
summary { cursor: pointer; font-weight: 600; font-size: .9rem; }
footer { color: var(--soft); font-size: .8rem; margin-top: 2rem; }
`

const SCRIPT = `
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  const text = button.parentElement.querySelector('.value').textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});
document.addEventListener('submit', (event) => {
  const ask = event.target.getAttribute('data-confirm');
  if (ask && !confirm(ask)) event.preventDefault();
});
const live = document.querySelector('[data-live]');
if (live) {
  const write = (selector, text) => { const node = live.querySelector(selector); if (node) node.textContent = text; };
  const names = { playing: 'Playing', paused: 'Paused', stopped: 'Nothing is playing', unknown: 'Something Spotify can\\u2019t name, or a private session' };
  async function refresh() {
    if (document.hidden) return;
    const response = await fetch('/status.json', { cache: 'no-store' }).catch(() => null);
    if (!response || !response.ok) return;
    const status = await response.json();
    write('[data-state]', status.problem ? status.problem : names[status.state] || '');
    write('[data-title]', status.title || '');
    write('[data-artists]', (status.artists || []).join(', '));
    const list = live.querySelector('[data-next]');
    list.replaceChildren(...(status.next || []).map((track) => {
      const item = document.createElement('li');
      item.textContent = track.title + ' \\u2014 ' + track.artists.join(', ');
      return item;
    }));
    live.querySelector('[data-next-title]').hidden = !(status.next || []).length;
  }
  refresh();
  setInterval(refresh, 5000);
}
`

export interface Page {
  title: string
  body: string
}

export function render(page: Page, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)} · spotify-azuracast</title>
<style nonce="${nonce}">${STYLE}</style></head>
<body><main>${page.body}
<footer>spotify-azuracast ${VERSION}. A self-hosted adapter, not affiliated with Spotify.</footer>
</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`
}

const copyable = (value: string) =>
  `<div class="copy"><div class="value">${escapeHtml(value)}</div><button type="button" class="small quiet" data-copy>Copy</button></div>`

const notice = (kind: 'warn' | 'bad' | 'good', html: string) =>
  `<div class="notice ${kind}">${html}</div>`

/**
 * What the Spotify app is called: this copy's own name, the first part of its
 * workers.dev address, or the whole of any other, which Spotify has anyway.
 * Neither it nor the description names this project, and neither is the same
 * for everyone, so Spotify can't simply count the people who use it.
 */
export function appName(redirectUri: string): string {
  const { hostname } = new URL(redirectUri)
  return hostname.endsWith('.workers.dev') ? hostname.split('.')[0]! : hostname
}

const WHAT = [
  'What I am listening to',
  'What I am playing',
  'My current song',
  'The song I have on',
  'What is playing for me',
  'My music right now',
  'Now playing',
  'The track I am on',
]
const WHERE = [
  'for my website',
  'on my site',
  'for my stream',
  'for my homepage',
  'on my page',
  'for friends',
  'for my blog',
  'for a small widget',
]

/** FNV-1a: enough to spread names over a handful of choices. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
  return hash
}

/**
 * A description in ordinary words, picked by this copy's name: the same every
 * time this copy is set up, and seldom the same as another's.
 */
export function appDescription(redirectUri: string): string {
  const hash = hashOf(appName(redirectUri))
  return `${WHAT[hash % WHAT.length]} ${WHERE[Math.floor(hash / WHAT.length) % WHERE.length]}`
}

export function setupPage(redirectUri: string, error?: string): Page {
  return {
    title: 'Set up',
    body: `
<h1>Connect your Spotify</h1>
<p class="lede">Spotify asks every self-hoster to register their own app. It is free and takes a couple of minutes, but the account that owns the app needs Premium.</p>
${error ? notice('bad', escapeHtml(error)) : ''}
<section class="card">
  <h2>1. Create a Spotify app</h2>
  <p><a class="button" href="https://developer.spotify.com/dashboard/create" target="_blank" rel="noopener noreferrer">Open Spotify's form</a></p>
  <ol class="fields">
    <li><b>App name</b>${copyable(appName(redirectUri))}</li>
    <li><b>App description</b>${copyable(appDescription(redirectUri))}</li>
    <li><b>Redirect URI</b>: paste this, then click Add.${copyable(redirectUri)}</li>
    <li><b>Which API/SDKs are you planning to use?</b> Tick <b>Web API</b>, accept the terms and save.</li>
  </ol>
</section>
<section class="card">
  <h2>2. Paste its Client ID</h2>
  <p>It is on the app's page. You don't need the client secret.</p>
  <form method="post" action="/setup">
    <label for="client_id">Client ID</label>
    <input type="text" id="client_id" name="client_id" required autocomplete="off" spellcheck="false" pattern="\\s*[0-9a-fA-F]{32}\\s*" title="32 letters and digits, from your app's page">
    <div class="row"><button>Connect Spotify</button></div>
  </form>
</section>`,
  }
}

export function signInPage(error?: string, ended = false): Page {
  return {
    title: 'Sign in',
    body: `
<h1>spotify-azuracast</h1>
<p class="lede">This adapter is set up. Sign in with the Spotify account that set it up.</p>
${error ? notice('bad', escapeHtml(error)) : ''}
${ended ? notice('warn', "Spotify ended this adapter's authorization, as it does after six months. Signing in renews it, and API clients carry on by themselves.") : ''}
<section class="card">
  <form method="post" action="/signin"><button>Sign in with Spotify</button></form>
</section>`,
  }
}

export interface DashboardView {
  ownerName: string
  endpoints: Endpoints
  keys: ApiKey[]
  /** When Spotify ends this authorization, if that's near. */
  expiresAt: number
  now: number
  dead: boolean
  update?: string
  notice?: { kind: 'good' | 'bad' | 'warn'; text: string }
}

const WARN_BEFORE_MS = 21 * 24 * 60 * 60 * 1000

const when = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function ago(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / 60_000)
  if (minutes < 10) return 'in the last few minutes'
  if (minutes < 120) return `${minutes} minutes ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours ago`
  return `on ${when(ms)}`
}

function updateAdvice(view: DashboardView): string {
  if (!view.update) return ''
  return notice(
    'warn',
    `<b>Version ${escapeHtml(view.update)} is out.</b> It installs itself within a day, or now. <form method="post" action="/update"><button>Update now</button></form>`
  )
}

function keyList(view: DashboardView): string {
  const remove = (id: string, label: string) =>
    `<form class="inline" method="post" action="/keys/${escapeHtml(id)}/remove" data-confirm="Stop ${escapeHtml(label)} reading what you play?"><button class="small quiet">Remove</button></form>`
  const keys = view.keys.map(
    (key) => `<li><div><b>${escapeHtml(key.label)}</b>
      <div class="soft">${key.lastSeenAt ? `Last used ${ago(key.lastSeenAt, view.now)}.` : 'Not used yet.'}</div></div>${remove(key.id, key.label)}</li>`
  )
  if (keys.length === 0) return ''
  return `<ul class="plain">${keys.join('')}</ul>`
}

function apiSection(view: DashboardView): string {
  return `<section class="card">
  <h2>API</h2>
  <p class="soft">What you play, in the format AzuraCast stations publish. Every request needs a key, sent as <code>Authorization: Bearer</code> followed by the key. Make one under Keys, below.</p>
  <ol class="fields">
    <li><b>Now playing</b>${copyable(view.endpoints.nowPlaying)}</li>
    <li><b>Queue</b>${copyable(view.endpoints.queue)}</li>
  </ol>
  <p class="soft">The station is <code>spotify</code>, or <code>${view.endpoints.stationId}</code>, wherever AzuraCast takes a station.</p>
</section>
<section class="card">
  <h2>Keys</h2>
  <p class="soft">Anything that reads the API, such as your website, an overlay or a bot, needs a key. Make one for each, so you can stop one without the others.</p>
  ${view.keys.length === 0 ? '<p class="soft"><b>No keys yet</b>, so nothing can read the API.</p>' : keyList(view)}
  <form method="post" action="/keys">
    <label for="label">Where will you use it?</label>
    <input type="text" id="label" name="label" required maxlength="60" placeholder="My website">
    <p class="soft">Only you see this, to tell your keys apart.</p>
    <div class="row"><button>Make a key</button></div>
  </form>
</section>`
}

export function dashboardPage(view: DashboardView): Page {
  const expiring = view.expiresAt - view.now < WARN_BEFORE_MS
  const reconnect = view.dead
    ? notice(
        'bad',
        `<b>Spotify ended this adapter's authorization.</b> API clients get 503 until then. <form method="post" action="/signin"><button>Authorize again</button></form>`
      )
    : expiring
      ? notice(
          'warn',
          `Spotify ends each authorization after six months, and this one on <b>${when(view.expiresAt)}</b>. Renewing takes one click. <form method="post" action="/signin"><button>Renew now</button></form>`
        )
      : ''
  return {
    title: 'Dashboard',
    body: `
<h1>spotify-azuracast</h1>
<p class="lede">Connected to Spotify as ${escapeHtml(view.ownerName)}.</p>
${view.notice ? notice(view.notice.kind, escapeHtml(view.notice.text)) : ''}
${reconnect}
${updateAdvice(view)}
<section class="card" data-live>
  <h2>Now</h2>
  <p class="soft" data-state>Asking Spotify…</p>
  <p class="track" data-title></p>
  <p data-artists></p>
  <p class="soft" data-next-title hidden>Next</p>
  <ol class="next" data-next></ol>
</section>
${apiSection(view)}
<section class="card">
  <h2>This install</h2>
  <p class="soft">Spotify's authorization runs until <b>${when(view.expiresAt)}</b>, when the API stops saying what you play. It's worth a reminder in your calendar: renewing takes one click, here.</p>
  <form method="post" action="/signin"><button class="quiet">Renew now</button></form>
  <p class="soft">This is version <b>${VERSION}</b>. It installs new versions by itself, once a day.</p>
  <form method="post" action="/update/check"><button class="quiet">Check for updates</button></form>
  <div class="row">
    <form class="inline" method="post" action="/signout"><button class="quiet">Sign out</button></form>
    <form class="inline" method="post" action="/reset" data-confirm="Forget your Spotify connection and every API key? You will set this up from the start."><button class="quiet">Forget everything</button></form>
  </div>
</section>`,
  }
}

export interface Endpoints {
  nowPlaying: string
  queue: string
  stationId: number
}

export function keyPage(label: string, key: string, endpoints: Endpoints): Page {
  return {
    title: 'New key',
    body: `
<h1>A key for ${escapeHtml(label)}</h1>
<p class="lede">It is shown only now, and it can read what you are playing, so treat it like a password. If you lose it, make another.</p>
<section class="card">
  ${copyable(key)}
  <p class="soft">Send it with every request:</p>
  ${copyable(`curl -H "Authorization: Bearer ${key}" ${endpoints.nowPlaying}`)}
  <p><a href="/">Done</a></p>
</section>`,
  }
}
