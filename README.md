# spotify-azuracast

Publishes what you are playing on Spotify, and what is queued next, in the API format [AzuraCast](https://www.azuracast.com/) radio stations publish. Anything written to show an AzuraCast station's now playing (a website widget, an overlay, a bot, a smart display) can show your Spotify instead.

It is an **adapter**: Spotify's player API goes in, AzuraCast's `/api/nowplaying` and queue come out. Spotify wouldn't approve this as a public app, so there is no hosted version. You run your own copy, with your own Spotify developer app. This project makes that as short as it can be.

**Beta.**

## Set up

You need Spotify Premium on the account that owns the Spotify app (Spotify's rule), and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account. There are no servers to run and nothing to install.

1. **[Install it](https://diva-ravioli.github.io/spotify-azuracast/).** The page asks for a Cloudflare API token and your Account ID, and tells you where to find them.

2. **Open it**, straight away, at the address the install page gives you. The first Spotify account to complete setup becomes the owner, and only it can sign in from then on.

3. **Follow the page.** It takes you to Spotify's form with everything to paste, then asks for one thing back: your app's Client ID.

4. **Make a key.** Name it on the dashboard, and copy it: it is shown once. Give it to whatever reads your now playing, which sends it as `Authorization: Bearer <key>`.

## Updates

**You don't have to do anything.** Your Worker checks for a new release every day and installs it over itself, using the Cloudflare API token you gave it. Your settings, connections and Worker name stay. Only published releases are installed, which means they passed this project's tests first.

- **To undo one:** roll back to the previous version on the Worker's **Deployments** tab in Cloudflare, and delete the token as below so that the update doesn't come back.
- **To choose updates yourself:** delete the token on [Cloudflare's API tokens page](https://dash.cloudflare.com/profile/api-tokens). The dashboard tells you when a release is out, and running the install page again with a new token installs it and turns updates back on.

Your Worker installs what this project publishes without asking, so you are trusting its releases. If you'd rather not, delete the token and read each release first.

### The one thing Spotify makes you repeat

Spotify ends every authorization six months after you give it, whatever you do. The dashboard shows the date and warns you three weeks ahead. **Sign in, or click Renew, any time before then and the six months start again.** If it does run out, the API answers 503 until then, and everything carries on by itself once you sign in, with no key to change.

## The API

Every request needs a key from the dashboard, as `Authorization: Bearer <key>`. Your Spotify is one station, `spotify` or `1`, wherever AzuraCast takes a station:

| Request | What it answers |
|---|---|
| `GET /api/nowplaying/spotify` | AzuraCast's `NowPlaying`: the station, what is on now with its elapsed and remaining time, what is next, and the last five tracks played |
| `GET /api/nowplaying` | The same, in a list of one, as AzuraCast lists all its stations |
| `GET /api/station/spotify/queue` | AzuraCast's queue: up to 20 tracks, each with when it should start, while that can be told |

```sh
curl -H "Authorization: Bearer <key>" https://<your-worker>/api/nowplaying/spotify
```

Every answer is checked against [AzuraCast's own API description](https://github.com/AzuraCast/AzuraCast/blob/main/web/static/openapi.yml). Any web page may call it: it allows every origin, and takes no cookies, only the key you give it. A key in a public web page can be read by anyone who visits it, so give such a page a key of its own.

| On Spotify | `is_online` | `now_playing` |
|---|---|---|
| A track playing | `true` | The track: title, artists, album, cover, ISRC, and its Spotify id as `song.id` |
| A track paused | `false` | The track, its time standing still |
| No active device | `false` | AzuraCast's `Station Offline` |
| A podcast, an ad, a track with no artist | `false` | `Station Offline` |
| A **private session** | `false` | `Station Offline`: you asked Spotify not to share it, so this doesn't either |

What AzuraCast has and Spotify doesn't (listeners, a stream to listen to, playlists, requests, a live DJ) is there, empty, so that code written for AzuraCast finds every field it expects.

A new track counts at once when it's the one queued next, arriving when it should. A skip counts once it has held for 2 seconds, so skipping through a playlist doesn't flash every track on the way. "Nothing on" must hold for 10 seconds, because Spotify's answer flickers.

Trouble with Spotify is never a 401 or 403, which a client would take to mean its key is wrong: it is 503, or 429 when Spotify rate limits, with `Retry-After`.

## How much it asks of Spotify

It reads Spotify only while something is asking, and at most every 4 seconds, plus the queue every 30 seconds and at each new track. Everything asking at once shares one read. If Spotify rate limits it, it passes the wait on and stops asking until then.

That fits Cloudflare's free plan: one client asking every 5 seconds all day makes about 17,000 of the 100,000 requests it allows per day. Answers carry `Cache-Control: max-age` of a few seconds, which a client may keep to.

## If something goes wrong

| What you see | What to do |
|---|---|
| `INVALID_CLIENT: Invalid redirect URI` at Spotify | The redirect URI in your Spotify app must match the setup page's exactly. |
| "Use the Spotify account that owns the app" | Sign in with the account that made the Spotify app, which needs Premium. Spotify's own message is shown too. |
| The dashboard says Premium is required | Spotify stops an app when its owner's Premium lapses. It carries on by itself when Premium is back. |
| The API answers 401 | The key is wrong, or was removed: make another on the dashboard. |
| The API answers 503 | Spotify can't be read: the dashboard says why. |
| Someone else got to the setup page first | Delete the Worker in Cloudflare and install again under another name. They can't see your Spotify. |
| Updates have stopped | The API token may be gone or expired. Run the install page again with a new one: it keeps your setup. |

**Forget everything** on the dashboard erases all it keeps. Your Spotify app is yours to delete on [Spotify's dashboard](https://developer.spotify.com/dashboard).

## Security and privacy

- **Narrow permissions:** it only asks Spotify for permission to read playback, and it has no client secret to leak.
- **Keys:** each is 256 random bits, of which only the hash is kept. Removing a key stops it at once.
- **What it stores:** your Spotify tokens, what is on and queued, and the last five tracks played. It tells these to nobody but holders of your keys, and its pages load nothing from anywhere else.
- **Your Cloudflare token:** it's an encrypted secret of your own Worker, used only to install new releases. It can change any Worker on your account, so a compromised release could misuse it. On the way to Cloudflare it passes once through a small relay this project runs, because a web page can't call Cloudflare's API directly. The relay is [`relay/worker.ts`](relay/worker.ts), deployed from `main` by [`relay.yml`](.github/workflows/relay.yml): it keeps and logs nothing, and passes on only the requests the install page makes, only from that page.
- **Who can get in:** only the Spotify account that set it up. There is a brief window after deploying when anyone who finds the address could set it up first. They would gain nothing of yours, and you would notice at step 2.
- **Spotify's terms** are between you and Spotify: you accept them when you create your app.

## Develop

```sh
npm install
npm test               # everything in Node, with answers checked against AzuraCast's API description
npm run check          # types
npm run test:worker    # the journey in workerd, Cloudflare's runtime
npm run test:browser   # the journey in a real browser
```

[`AGENTS.md`](AGENTS.md) describes the code and its rules.

## Licence

[0BSD](LICENSE): do anything you like with it, with no conditions, not even attribution. Spotify is a trademark of Spotify AB, and AzuraCast is AzuraCast's. This project isn't affiliated with either.
