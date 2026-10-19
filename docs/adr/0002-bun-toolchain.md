# ADR 0002: Bun as runtime, package manager, and test runner

**Date**: 2026-09-30\
**Status**: Accepted\
**Related**: [OpenTUI runtime support](https://opentui.com/docs/getting-started/runtime-support/),
[OpenTUI testing](https://opentui.com/docs/core-concepts/testing/)

## Context

Mergit will render its terminal UI with OpenTUI. OpenTUI's native renderer fails on Node 24 with
"OpenTUI native FFI is not available for this runtime yet".

OpenTUI supports Bun, and Node 26.4 or later only with experimental FFI enabled. Its testing docs
use Bun.

With Node tooling, app tests would need a second runtime and test runner next to the tooling tests.

## Decision

Mergit uses Bun as its runtime, package manager, and test runner. One runtime runs the tooling, the
app, and every test.

### Toolchain

- `bun.lock` is the only lockfile. `packageManager` in `package.json` pins the Bun version, and CI
  installs that version.
- Tests use `bun test` and import from `bun:test`.
- Vite+ stays for lint, formatting, and staged checks. TypeScript, Knip, and Changesets also stay.
- Scripts and hooks run installed command-line tools with `bunx --bun`, so tools with a Node shebang
  run on Bun.

## Consequences

### Positive

- The tooling, the app, and all tests share one runtime and one test runner.

### Negative

- GitHub's dependency graph does not read `bun.lock`, so dependency review does not cover locked
  package versions. A scheduled `bun audit` covers them instead.
- Tools that assume Node need `bunx --bun`, and a tool that fails on Bun has no Node fallback.
- Oxlint's test rules do not recognize `bun:test`, so test files get no test-specific lint.

## Alternatives considered

### Node 24, pnpm, and Vitest

Keep Node 24, pnpm, and Vitest. Rejected because app code and app tests cannot load OpenTUI on
Node 24.

### Node with experimental FFI

Move to Node 26.4 or later with experimental FFI. Rejected because it depends on an experimental
flag, and the project prefers Bun for OpenTUI.

### Vitest on Bun

Use Bun, and run Vitest on Bun. Rejected because Vitest works on Bun, but it adds a second test tool
when Bun already has a test runner.
