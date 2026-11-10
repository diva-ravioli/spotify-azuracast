/**
 * The newest published release, as a deployed copy finds it.
 *
 * From github.com, not GitHub's API: the API allows 60 requests an hour to
 * anyone not signed in, counted by address, and Workers share their addresses
 * with everyone else's, so from a Worker it mostly says no. github.com sends
 * `releases/latest/download/worker.json` on to the newest published release's
 * file, which says which version it is. Drafts and pre-releases are never it.
 */
import { CLIENT, REPOSITORY } from './version.ts'

export const RELEASES = `https://github.com/${REPOSITORY}/releases`

export interface Release {
  version: string
  compatibility_date: string
  compatibility_flags: string[]
}

/** Named, as an error's name is all that may be logged. Its status, if any, is GitHub's or Cloudflare's. */
export function failure(name: string, status?: number): Error & { status?: number } {
  const error: Error & { status?: number } = new Error(name)
  error.name = name
  if (status !== undefined) error.status = status
  return error
}

/** The newest release, or null if there is none. Throws `ReleaseCheckFailed` or `ReleaseMismatch`. */
export async function latestRelease(
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<Release | null> {
  let answer: Response
  try {
    answer = await fetcher(`${RELEASES}/latest/download/worker.json`, {
      headers: { 'User-Agent': CLIENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw failure('ReleaseCheckFailed')
  }
  if (answer.status === 404) {
    await answer.body?.cancel()
    return null
  }
  if (!answer.ok) {
    await answer.body?.cancel()
    throw failure('ReleaseCheckFailed', answer.status)
  }
  const manifest = (await answer.json().catch(() => null)) as Partial<Record<keyof Release, unknown>> | null
  const version = manifest?.version
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    typeof manifest?.compatibility_date !== 'string'
  ) {
    throw failure('ReleaseMismatch')
  }
  return {
    version,
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: Array.isArray(manifest.compatibility_flags)
      ? manifest.compatibility_flags.filter((flag): flag is string => typeof flag === 'string')
      : [],
  }
}
