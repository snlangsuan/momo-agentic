/**
 * Prints the CHANGELOG.md section for a given version, used by the release
 * workflow to build GitHub Release notes.
 *
 *   bun run scripts/extract-changelog.ts 0.1.0
 *   bun run scripts/extract-changelog.ts v0.1.0   # leading "v" is stripped
 *
 * Exits non-zero if no matching section exists, so a release with missing notes
 * fails loudly rather than publishing an empty body.
 */
import { readFileSync } from 'node:fs'

const version = (process.argv[2] ?? '').replace(/^v/, '').trim()
if (!version) {
  console.error('usage: extract-changelog <version>')
  process.exit(1)
}

const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const headingRe = new RegExp(`^##\\s*\\[${escaped}\\]`)

const start = lines.findIndex((line) => headingRe.test(line))
if (start === -1) {
  console.error(`No CHANGELOG.md section found for version "${version}".`)
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s*\[/.test(lines[i] ?? '')) {
    end = i
    break
  }
}

// Drop trailing link-reference lines (e.g. "[0.1.0]: https://...").
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .replace(/\n\[[^\]]+\]:\s*\S+\s*$/g, '')
  .trim()

if (!body) {
  console.error(`CHANGELOG.md section for "${version}" is empty.`)
  process.exit(1)
}

console.log(body)
