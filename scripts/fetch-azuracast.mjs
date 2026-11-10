#!/usr/bin/env node
/**
 * Fetches AzuraCast's API description, at the commit this adapter is tested
 * against, into .azuracast/ (not committed: it has its own licence). The format
 * tests hold what this adapter answers to its schemas. To move to a newer one:
 * change the commit, run the tests, and read what changed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = '5d4265ff73a16ff98fe6ff6bacf3571d8df6eea7'
const FILE = `https://raw.githubusercontent.com/AzuraCast/AzuraCast/${COMMIT}/web/static/openapi.yml`

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, '.azuracast')
const stamp = join(target, '.commit')

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === COMMIT) process.exit(0)

const response = await fetch(FILE, { signal: AbortSignal.timeout(60_000) })
if (!response.ok) throw new Error(`Fetching AzuraCast's openapi.yml: ${response.status}`)
const text = await response.text()
rmSync(target, { recursive: true, force: true })
mkdirSync(target)
writeFileSync(join(target, 'openapi.yml'), text)
writeFileSync(stamp, `${COMMIT}\n`)
console.log(`Fetched AzuraCast's API description at ${COMMIT.slice(0, 7)}.`)
