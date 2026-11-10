# Working on spotify-azuracast

Publishes what someone plays on Spotify, and their queue, in the API format AzuraCast stations publish, behind `Authorization: Bearer` keys. Self-hosted by each of its users. AzuraCast describes its API in <https://github.com/AzuraCast/AzuraCast/blob/main/web/static/openapi.yml>; `npm test` fetches it into `.azuracast/` at the commit pinned in `scripts/fetch-azuracast.mjs`. "Adapter" is the project's word for itself.

## Map

| Path | What it is |
|---|---|
| `src/tracker.ts` | The core, and pure: readings in, what is on out. Plays and their ids, settling, the queue and history, and timing that stays still between reads. |
| `src/spotify/` | Spotify's OAuth and player API (`client.ts`), and its answers as readings (`parse.ts`). |
| `src/azuracast/` | What is on, in AzuraCast's shapes: `NowPlaying`, the queue, and errors. |
| `src/app.ts` | Every route, on Web-standard `Request` and `Response`: setup, sign-in, the API, and keys. |
| `src/ui/pages.ts` | The pages. |
| `src/cloudflare/worker.ts` | The host: a Durable Object. It only supplies storage and requests. |
| `src/cloudflare/self-update.ts` | What a deployed Worker runs each day, or when its owner clicks Update now, to install a newer release over itself. |
| `site/` | The install page, on GitHub Pages: uploads the Worker to someone's Cloudflare account from their browser. |
| `relay/` | The install page's way to Cloudflare's API, its own small Worker. `relay.yml` deploys it from `main`. |
| `scripts/build-release.mjs` | Builds the two files a release publishes: `worker.js` and `worker.json`. |

## Commands

`npm test` (Node, with answers checked against AzuraCast's API description), `npm run check` (types), `npm run test:worker` (workerd), `npm run test:browser` (a real browser). Run all four before calling a change done: each of the last two has caught a bug that broke every user and passed everything before it.

## Rules

**Keep the journeys short.** Nobody needs a GitHub account or a terminal. Installing takes a Cloudflare API token and Account ID, and setup a Client ID and nothing else. A user who updates has nothing to do. Every new setting, secret or step has to be worth what it costs them.

**No dependencies at run time.** `package.json` has only `devDependencies`, and a test holds it to that. Node runs `src/` as it is, so TypeScript must stay erasable, with `.ts` in imports.

**Code runs on Workers, and its tests under Node, and they differ.** Use Web APIs. Workers refuse `fetch` with `redirect: 'error'`: use `'manual'` and turn away a 3xx yourself.

**What is kept stays still between reads.** Spotify's position changes on every read, so the tracker keeps an anchor that moves only on a real jump, and the stored state changes only when something happened. Elapsed and remaining time are worked out from the anchor as each answer is made, never stored.

**The API never says 401 or 403 about Spotify.** A client takes those to mean its key is wrong, and may stop for good. Trouble with Spotify is 429 or 503, with `Retry-After`, and recovers by itself.

**The API is open to every origin, and takes only a key.** No cookies, ever, on `/api/`: that is what makes `Access-Control-Allow-Origin: *` safe.

**Secrets.** Keys are stored only as hashes. Secrets never go in a log, an error message, a URL or a page, beyond showing a new address once. Log an error's name, never its text.

**Pages.** Escape everything that didn't come from `pages.ts`. Nothing loads from elsewhere. `Referrer-Policy: no-referrer` looks stricter but makes browsers send `Origin: null` with a page's own forms.

**State.** Everything is one JSON document (`src/state.ts`). A change to its shape adds a step to `migrate`, since nobody runs anything when they update. Save only when something changed: free plans count writes.

**A deployed copy.** An update re-uploads the Worker with the bindings in `self-update.ts` and no migrations, so keep the Durable Object class named `Adapter`, and change the bindings there and in `site/install.js` together. The API token can change any Worker on the user's account: it never goes anywhere but Cloudflare, and the install page never replaces a Worker that isn't this adapter.

**Spotify can't count us.** Each user registers their own Spotify app, and what they give Spotify (the app's name and description, and the redirect URI with the Worker's name in it) never names this project, and what is the same for everyone is ordinary words: the install page makes up a Worker name, and setup names the app after it. `test/app.test.ts` and `test/install.test.ts` hold this.

**The relay passes on only what the install page asks.** Every user's Cloudflare token goes through it, so it takes requests only from the install page's origin, only for the requests in `site/install.js`, and keeps and logs nothing. A new request in `install.js` needs adding to `relay/worker.ts` too: `test/relay.test.ts` installs through the relay and fails until it is. It has no bindings and no settings, and `relay.yml` deploys it from `main` alone, so what runs is what is here.

## The format

AzuraCast's OpenAPI document is the reference, and `test/azuracast.test.ts` holds every answer to it. Code written for an AzuraCast station should never find a field missing, so what Spotify has no answer for (listeners, mounts, a stream, playlists, requests, a DJ) is there, empty. Where AzuraCast and Spotify disagree, as on a paused track or a private session, do what works for someone showing their listening, and say why in `src/azuracast/nowplaying.ts`.

## Releasing

Update the version in `package.json` and `src/version.ts`, add it to `CHANGELOG.md`, then push a tag such as `v0.2.0`. `release.yml` tests it, creates the GitHub Release with the built Worker, and refreshes the install page, and deployed copies pick that Release up within a day. A tag alone reaches nobody, but treat every published Release as going straight to production, because it does.
