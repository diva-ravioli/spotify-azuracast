# Changelog

## 0.1.1

The install page suggests a made-up Worker name, and setup names the Spotify app after it, so nothing given to Spotify names this project. The install page follows Cloudflare's new token form.

## 0.1.0

The first release: what you play on Spotify and your queue, in the API format AzuraCast stations publish (`/api/nowplaying` and a station's queue), behind `Authorization: Bearer` keys, from a Cloudflare Worker, with setup, sign-in and keys on the adapter's own pages, and automatic updates. The install page reaches Cloudflare's API through a relay of its own, in `relay/`.
