#!/usr/bin/env node
/**
 * Builds what a release publishes, into dist/: the Worker as one file, and what
 * Cloudflare needs to know to run it. The install page and every deployed copy's
 * self-update upload these two files.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
})
for (const extra of ['dist/worker.js.map', 'dist/README.md']) rmSync(extra, { force: true })

const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'))
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const manifest = {
  version,
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags ?? [],
}
writeFileSync('dist/worker.json', `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Built ${version} into dist/.`)
