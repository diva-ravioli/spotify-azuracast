# Changelog

## 0.1.0

The first release: what you play on Spotify and your queue, in the API format AzuraCast stations publish (`/api/nowplaying` and a station's queue), behind `Authorization: Bearer` keys, from a Cloudflare Worker, with setup, sign-in and keys on the adapter's own pages, and automatic updates. The install page reaches Cloudflare's API through a relay of its own, in `relay/`.
