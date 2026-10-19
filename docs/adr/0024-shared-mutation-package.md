# ADR 0024: Run mutation testing through the shared package

**Date**: 2026-10-19\
**Status**: Accepted\
**Supersedes**: [ADR 0023 (Mutation testing gates changed lines on pull requests)](./0023-mutation-testing-on-changed-lines.md):
the local copy of the script, its ignorer, and its mutant cap\
**Related**: [ADR 0002 (Bun as runtime, package manager, and test runner)](./0002-bun-toolchain.md)

## Context

ADR 0023 gave Mergit its own copy of the mutation script, adapted from a sibling project. Several
projects kept such copies, and the copies drifted within days. Each project solved the same Bun
runner problems on its own, and a fix in one copy did not reach the others.

What Mergit needs to choose is small: which files to mutate, which modules to leave out, timeouts,
and the test runner. The scope parsing, the report, and the message ignorer are the same in every
project.

## Decision

Mergit runs mutation testing through the `@sqve/mutation` package, installed as a pinned dev
dependency, and keeps no copy of the script.

The package owns the shared parts, so a fix reaches Mergit through a version bump. It always adds
the `tauMessageIgnorer` ignorer and sets `ignoreStatic: true` unless the config sets its own value.
`stryker.config.json` holds only Mergit's policy: the `mutate` globs, the left-out modules, the
timeouts, and the Bun runner. `mutation.argv` in `.pi/tau.json` names the package's `mutation`
command, and the CI job `Mutation` runs that argv. The package's `--same-folder-tests` switch stays
off for the reason in the tuning note.

The package has no mutant cap by default, so a change of any size runs every mutant on its changed
lines. The job's `timeout-minutes` is the only bound. The gate itself is unchanged: survivors on
changed lines fail the advisory job, as ADR 0023 decided.

## Consequences

### Positive

- A fix or new runner support reaches Mergit through a version bump.
- The Stryker config shows only what is particular to Mergit.
- The package's ignorer also skips toast, title, and disabled-reason wording, which the local copy
  left as survivors.

### Negative

- A change to the script needs a package release before Mergit can use it.
- Mergit cannot patch the script locally; it must change the package or wait for a release.

## Alternatives considered

### Keep the local copy

The rule of ADR 0023. Rejected because the copies drifted within days and each project fixed the
same problems on its own.
