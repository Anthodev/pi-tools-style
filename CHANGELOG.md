# Changelog

## [Unreleased]

## [0.2.0] - 2026-10-11

### Features

- feat(rendering)!: add OMP-style tool views and per-tool configuration ([c036929](https://github.com/Anthodev/pi-tools-style/commit/c036929082ac00b6ecf4033c7753aebaae5db371))
  - Breaking for consumers on Pi `1.0.x`: the published `0.1.4` package targeted Pi `1.0.x`, so `0.2.0` moves the supported peer range to Pi `>=1.1.0 <2`. Update Pi to `1.1.x` before installing this release.
  - Adds semantic tool, MCP, and web-search views with per-tool settings; disabling styling restores the captured native rendering.
- feat(rendering): unify framed tool inputs and execution views ([01fb182](https://github.com/Anthodev/pi-tools-style/commit/01fb182683428e7418dbeee1ffe468069e4dc5ec))
  - Applies the same framed input-then-result layout to every supported tool, with the supplied data under the head and no `Input` or `Command` divider.

**Full changelog**: https://github.com/Anthodev/pi-tools-style/compare/v0.1.4...v0.2.0

## [0.1.4] - 2026-10-03

### Changes

- chore(release): prepare v0.1.4 ([e9a6606](https://github.com/Anthodev/pi-tools-style/commit/e9a6606f1995b038e5f08fab03542c0131f40bf4))
- ci(release): use curated changelog notes for tagged releases ([fdcb72e](https://github.com/Anthodev/pi-tools-style/commit/fdcb72e8b6473d23a4c2ad8630280e140f4fb33b))

### Fixes

- fix(compat): support Pi 1.0.x ([9c985dc](https://github.com/Anthodev/pi-tools-style/commit/9c985dc4055928aa3175a478f9002638841a4eb4))

**Full changelog**: https://github.com/Anthodev/pi-tools-style/compare/v0.1.3...v0.1.4

## [0.1.3] - 2026-08-09

### Changes

- perf: cache decorated tool renders in long sessions ([ee03d5e](https://github.com/Anthodev/pi-tools-style/commit/ee03d5efe1622b5de003473b89186343789a7eaf))

**Full changelog**: https://github.com/Anthodev/pi-tools-style/compare/v0.1.2...v0.1.3

## [0.1.2] - 2026-08-09

### Fixes

- fix: publish npm tarball from explicit local path and bump version ([3babb49](https://github.com/Anthodev/pi-tools-style/commit/3babb49f3c2541408e40940adfe2ff1046d49556))

**Full changelog**: https://github.com/Anthodev/pi-tools-style/compare/v0.1.1...v0.1.2

## [0.1.1] - 2026-08-09

### Changes

- chore: update README and bump version to 0.1.1 ([d298189](https://github.com/Anthodev/pi-tools-style/commit/d298189c86b35ba09aa1a77fb0b623a9bb592104))

> [!NOTE]
> This historical entry is based on the `v0.1.1` tag. Its original release-note body was unavailable when this changelog was initialized.
