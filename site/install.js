/**
 * Installs the adapter on someone's Cloudflare account, from their browser.
 *
 * Cloudflare's API can't be called from a web page, so requests go through a
 * small relay that adds the headers a browser needs: relay/worker.ts, in this
 * repository. It forwards them to api.cloudflare.com and keeps nothing. The token ends up in only one place: as
 * a secret of the user's own Worker, which uses it to install new releases.
 */
export const RELAY = 'https://spotify-azuracast-relay.diva-ravioli.workers.dev/client/v4'
export const SCHEDULE = '17 4 * * *'
const MIGRATION = { new_tag: 'v1', new_sqlite_classes: ['Adapter'] }

/** What a person can act on. Its message is shown as it is. */
export class InstallError extends Error {}

export const validName = (name) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
export const validAccount = (id) => /^[0-9a-f]{32}$/.test(id)

const permissionHint = 'Check the Account ID, and that the token has Workers Scripts: Edit.'

/** Answers the new Worker's address. Safe to run again: it picks up where it failed. */
export async function install({ token, accountId, name, fetcher = fetch, log = () => {} }) {
  if (!token) throw new InstallError('Paste your Cloudflare API token.')
  if (!validAccount(accountId)) throw new InstallError('That Account ID should be 32 letters and numbers.')
  if (!validName(name)) {
    throw new InstallError('A Worker name can only have lower-case letters, numbers and dashes.')
  }

  const cloudflare = async (path, options = {}) => {
    let response
    try {
      response = await fetcher(`${RELAY}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...options.headers },
      })
    } catch {
      throw new InstallError("Couldn't reach Cloudflare. Check your connection and try again.")
    }
    const body = await response.json().catch(() => null)
    return { ok: response.ok && body?.success === true, status: response.status, result: body?.result }
  }
  const account = `/accounts/${accountId}/workers`
  const script = `${account}/scripts/${encodeURIComponent(name)}`
  const json = { 'Content-Type': 'application/json' }

  log('Checking your token')
  if (!(await cloudflare('/user/tokens/verify')).ok) {
    throw new InstallError("Cloudflare didn't accept that token. Check you copied all of it.")
  }

  log('Fetching the latest release')
  const release = await Promise.all([fetcher('./worker.js'), fetcher('./worker.json')]).catch(() => null)
  if (!release || !release[0].ok || !release[1].ok) {
    throw new InstallError("The latest release isn't available right now. Try again in a few minutes.")
  }
  const code = await release[0].text()
  const manifest = await release[1].json()

  log('Looking at your account')
  const subdomain = await cloudflare(`${account}/subdomain`)
  if (!subdomain.ok && subdomain.status !== 404) throw new InstallError(permissionHint)
  if (!subdomain.result?.subdomain) {
    throw new InstallError(
      'Your account has no workers.dev address yet. Open Workers & Pages in your Cloudflare dashboard once to choose one, then try again.'
    )
  }
  const scripts = await cloudflare(`${account}/scripts`)
  if (!scripts.ok) throw new InstallError(permissionHint)
  const existing = scripts.result?.find((worker) => worker.id === name)
  if (existing) {
    // This token can replace any Worker on the account: never one that isn't this adapter.
    const settings = await cloudflare(`${script}/settings`)
    const isAdapter = settings.result?.bindings?.some(
      (binding) => binding.type === 'durable_object_namespace' && binding.class_name === 'Adapter'
    )
    if (!isAdapter) {
      throw new InstallError(`You already have a Worker called ${name}. Choose another name.`)
    }
  }

  log('Installing')
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: manifest.compatibility_flags ?? [],
    bindings: [
      { type: 'durable_object_namespace', name: 'ADAPTER', class_name: 'Adapter' },
      { type: 'plain_text', name: 'WORKER_NAME', text: name },
      { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: accountId },
      { type: 'secret_text', name: 'CF_API_TOKEN', text: token },
    ],
    // Only the first time: running it again must not touch what is stored.
    ...(existing?.migration_tag ? {} : { migrations: MIGRATION }),
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js')
  if (!(await cloudflare(script, { method: 'PUT', body: form })).ok) {
    throw new InstallError(`Cloudflare refused the upload. ${permissionHint}`)
  }

  log('Giving it an address')
  const address = await cloudflare(`${script}/subdomain`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ enabled: true }),
  })
  if (!address.ok) throw new InstallError("It's installed, but couldn't get its address. Try again.")

  log('Turning on updates')
  const schedule = await cloudflare(`${script}/schedules`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify([{ cron: SCHEDULE }]),
  })
  if (!schedule.ok) throw new InstallError("It's installed, but updates couldn't be turned on. Try again.")

  return `https://${name}.${subdomain.result.subdomain}.workers.dev`
}
