# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Smart Life session lost after a while ("token is expired", then "sign
  invalid" on every refresh): Tuya revokes the old refresh token at each
  renewal, and a renewal made between two hourly saves (by the live updates,
  a command or a status read) could be replaced by the older saved one when
  Gladys reconnected or the container restarted. Every renewal is now saved
  at once, and a reconnection keeps the newer token the bridge already holds.
- An expired Smart Life session now says so in the integration status, asking
  for a new QR login, instead of an error with a stack trace every hour. Once
  the hourly refresh has found it expired, the live updates stop retrying with
  the dead token.
- The Smart Life refresh token no longer appears in the logs when Tuya cannot
  be reached during a renewal, and the Tuya library's lines are no longer
  logged twice.

## [0.3.2] - 2026-10-13

### Changed

- Shared tooling of the LM1LC3N7 Gladys integrations: CI on Node 22 and 24
  with `npm audit`, Release workflow driven by this changelog, GitHub Releases
  from its sections, grouped Dependabot updates.
- Gladys integration SDK 0.15: poll-frequency and batch validation of the
  discovered devices, state heartbeat, the SDK fake Gladys for the tests.

## [0.3.1] - 2026-10-13

The releases before this file was started are described by their GitHub
Releases.

[Unreleased]: https://github.com/LM1LC3N7/gladys-lubluelu-vaccum/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/LM1LC3N7/gladys-lubluelu-vaccum/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/LM1LC3N7/gladys-lubluelu-vaccum/releases/tag/v0.3.1
