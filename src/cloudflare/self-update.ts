/**
 * Installs a newer release over this Worker, once a day, so that nobody has to
 * do anything to stay up to date. The install page gave the Worker a Cloudflare
 * API token for this, and nothing else uses it.
 *
 * Only a published GitHub Release, never a branch or a bare tag: a release is the
 * last step of release.yml, so one exists only if every check passed. Never
 * backwards.
 */
import { compareVersions } from '../app.ts'
import { RELEASES, failure, latestRelease } from '../releases.ts'
import { CLIENT, VERSION } from '../version.ts'

export interface UpdateEnv {
  CF_API_TOKEN?: string
  CF_ACCOUNT_ID?: string
  WORKER_NAME?: string
  PUBLIC_URL?: string
}

const REQUEST_TIMEOUT_MS = 30_000

/** Answers what it did. Throws, naming the step, if a newer release couldn't be installed. */
export async function selfUpdate(
  env: UpdateEnv,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  current: string = VERSION
): Promise<'no-token' | 'up-to-date' | 'updated'> {
  const { CF_API_TOKEN: token, CF_ACCOUNT_ID: account, WORKER_NAME: name } = env
  if (!token || !account || !name) return 'no-token'

  // No releases yet is not a failure.
  const latest = await latestRelease(fetcher, REQUEST_TIMEOUT_MS)
  if (!latest || compareVersions(latest.version, current) <= 0) return 'up-to-date'

  // That very release's code, even if a newer one came out a moment ago.
  let code: Response
  try {
    code = await fetcher(`${RELEASES}/download/v${latest.version}/worker.js`, {
      headers: { 'User-Agent': CLIENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw failure('ReleaseUnavailable')
  }
  if (!code.ok) {
    await code.body?.cancel()
    throw failure('ReleaseUnavailable', code.status)
  }

  // Everything is sent again: an upload replaces the Worker's bindings. There are
  // no migrations, since the Durable Object class never changes.
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: latest.compatibility_date,
    compatibility_flags: latest.compatibility_flags,
    bindings: [
      { type: 'durable_object_namespace', name: 'ADAPTER', class_name: 'Adapter' },
      { type: 'plain_text', name: 'WORKER_NAME', text: name },
      { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: account },
      { type: 'secret_text', name: 'CF_API_TOKEN', text: token },
      ...(env.PUBLIC_URL ? [{ type: 'plain_text', name: 'PUBLIC_URL', text: env.PUBLIC_URL }] : []),
    ],
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append(
    'worker.js',
    new Blob([await code.arrayBuffer()], { type: 'application/javascript+module' }),
    'worker.js'
  )
  const upload = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  )
  const result = (await upload.json().catch(() => null)) as { success?: unknown } | null
  if (!upload.ok || result?.success !== true) throw failure('UploadRefused', upload.status)
  return 'updated'
}
