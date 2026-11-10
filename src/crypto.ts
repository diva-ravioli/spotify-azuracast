/** Secrets and hashes, in Web Crypto: the same under Workers and Node. */

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** 256 random bits, as a `b64token`, which is also valid as a PKCE verifier. */
export const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

export const randomId = () => hex(crypto.getRandomValues(new Uint8Array(8)))

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export const sha256Hex = async (text: string) => hex(await digest(text))

/** The PKCE S256 challenge. */
export const challengeOf = async (verifier: string) => base64url(await digest(verifier))

/** Compares two hex hashes, taking the same time wherever they differ. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}
