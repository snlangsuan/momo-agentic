---
name: update-changelog
description: >-
  Add or edit entries in CHANGELOG.md correctly. Use whenever recording a change,
  feature, fix, or breaking change in the changelog, or when cutting a release.
  Enforces Keep a Changelog rules — new entries go under [Unreleased], dated/released
  version sections are never edited — to prevent putting changes in the wrong section.
---

# Updating CHANGELOG.md

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
SemVer. The CHANGELOG section for a tagged version is published **verbatim** as the
GitHub Release notes (see `.github/workflows/release.yml`), so accuracy matters.

## The one rule that's easy to break

**New entries ALWAYS go under `## [Unreleased]`. NEVER add to or edit a dated
section like `## [0.5.0] - 2026-06-19`.** A dated section is *released and frozen* —
it has a matching git tag (`vX.Y.Z`) and its bytes are the published release notes.
If work landed **after** that version was tagged, it belongs in `[Unreleased]`, even
if it feels topically related to the released version (e.g. a follow-up fix to a
feature shipped in 0.5.0 still goes in `[Unreleased]`, not back into `[0.5.0]`).

This is the mistake to guard against: do not retroactively edit history.

## Step 1 — Before editing, check release state

```bash
git tag --list 'v*'                 # which versions are cut/frozen
git show vX.Y.Z:CHANGELOG.md         # what a tagged section actually contains
```

A version section is **frozen** if it is dated (`## [x.y.z] - DATE`) — almost
always also git-tagged. Only `## [Unreleased]` (undated) is editable for new work.
If `[Unreleased]` is missing, add it as the first section above the latest version.

## Step 2 — Add the entry under `[Unreleased]`

Use the Keep a Changelog categories, in this order, creating the `###` subsection
only if it doesn't exist yet:

`### Added` · `### Changed` · `### Deprecated` · `### Removed` · `### Fixed` · `### Security`

- **Public API / behavior changes MUST be recorded** (CLAUDE.md §8): a new/renamed
  export, a new option, changed defaults, a bug fix users can observe.
- **Internal-only changes** (refactors, build/CI, path aliases) → `### Changed`,
  and say so: start with `Internal:` and note "no public API change".
- Match the existing entry style: `- **Short title — `codeRef`**: one or two
  sentences on what changed and why; name new exports.
- Breaking changes → `### Changed` or `### Removed`, prefixed `**BREAKING:**`.
- Convert relative dates to absolute. Don't invent a date for `[Unreleased]`.

## Step 3 — Verify you didn't touch a frozen section

```bash
git diff CHANGELOG.md
```

The diff should touch **only** `## [Unreleased]` — unless you are deliberately
cutting a release (Step 4). If it changed any dated section, move those lines back
into `[Unreleased]`.

## Step 4 — Cutting a release (only when explicitly releasing)

Follow CLAUDE.md §9:

1. Bump `version` in `package.json`.
2. Rename `## [Unreleased]` → `## [x.y.z] - YYYY-MM-DD` (today's real date) and add
   a fresh empty `## [Unreleased]` above it.
3. The git tag must be `vX.Y.Z` and match `package.json` exactly, or `release.yml`
   fails.

Do not run git/tag/publish yourself — prepare the files and hand the commands to
the user (this repo's convention; see the memory note on not self-deploying).

## Picking the version bump

- **patch** (x.y.Z): bug fixes, internal/build/CI changes, docs — no API change.
- **minor** (x.Y.0): new backward-compatible features (new exports/options/fields).
- **major** (X.0.0): breaking changes. (Pre-1.0, breaking may ride a minor — call
  it out explicitly and confirm with the user.)
