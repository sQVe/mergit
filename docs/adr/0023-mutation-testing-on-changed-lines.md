# ADR 0023: Mutation testing gates changed lines on pull requests

**Date**: 2026-10-18\
**Status**: Accepted\
**Related**: [ADR 0002 (Bun as runtime, package manager, and test runner)](./0002-bun-toolchain.md),
[ADR 0014 (Results for expected failures, exceptions for bugs, and checked boundaries)](./0014-coding-conventions.md)

## Context

Line coverage shows that a test ran a line. It does not show that a test would fail if the line were
wrong. Agents write much of Mergit, and a test that only runs code passes review easily.

Stryker changes the code one small step at a time and runs the tests. A change that no test notices
is a surviving mutant, and it points at a missing assertion. A run over the whole code base takes
tens of minutes and reports many survivors that no test should kill: error wording, styling flags,
and module-level data. The `AGENTS.md` rule "Do not test wording, constants, types, or internal
calls" means such a survivor is correct, not a gap.

Several projects kept their own copies of a mutation script, and the copies drifted within days.
Each project solved the same Bun runner problems on its own, and a fix in one copy did not reach the
others. What Mergit needs to choose is small: which files to mutate, which modules to leave out,
timeouts, and the test runner. The scope parsing, the report, and the message ignorer are the same
in every project.

`@hughescr/stryker-bun-runner` is the Stryker test runner that runs `bun test` with per-test
coverage. Its peer dependency is `typescript <7`, and Mergit uses TypeScript 7. Stryker core also
rewrites `tsconfig.json` through the TypeScript JavaScript API, which TypeScript 7 does not have.

## Decision

Mergit runs Stryker only on the lines a pull request changes. A surviving mutant on a changed line
fails the script and the CI job `Mutation`. The job is advisory: it lists survivors on pull requests
and is not a required check.

### The shared package

Mergit runs mutation testing through the `@sqve/mutation` package, installed as a pinned dev
dependency, and keeps no copy of the script. The package owns the shared parts, so a fix reaches
Mergit through a version bump.

`stryker.config.json` holds only Mergit's policy: the `mutate` globs, the left-out modules, the
timeouts, incremental results, and the Bun runner. `mutation.argv` in `.pi/tau.json` names the
package's `mutation` command, and the CI job `Mutation` runs that argv with a copy of the config
that uses every core. The package's `--same-folder-tests` switch stays off for the reason in the
tuning note.

Stryker reuses a mutant result while the mutated code and the tests that covered it are unchanged.
The CI job caches the incremental file per pull request. The cache key hashes what Stryker does not
track: test helpers, dependencies, and config.

The package has no mutant cap by default, so a change of any size runs every mutant on its changed
lines. The job's `timeout-minutes` is the only bound.

### Noise

Noise is removed by configuration, not by a score threshold:

- `coverageAnalysis: perTest` runs only the tests that cover a mutant.
- `ignoreStatic: true` skips mutants in code that runs while a test file loads. The package sets it
  unless the config sets its own value. A test file must not build state at the top level, because
  Stryker would then count that state's mutants as static and skip them.
- The package's `tauMessageIgnorer` skips the text of plain error messages and of toast, title, and
  disabled-reason wording.

Production code has no `// Stryker disable` comments. A mutant that no test can tell from the
original stays in the advisory list. The tuning note names them. A reader who finds a real gap
resolves it with a test.

### TypeScript 7

Mergit keeps TypeScript 7 and accepts the runner's peer warning. Bun installs with the warning, and
`bun install --frozen-lockfile` succeeds. The runner reads `typescript` only when the `typescript`
checker is on, and Mergit runs no checker. `tsconfigFile` names a file that does not exist, so
Stryker core skips its `tsconfig` rewrite.

## Consequences

### Positive

- A pull request shows every changed line whose behavior no test pins, so review can ask for a test.
- Survivors name the file, line, mutator, original text, and replacement, so the fix is a test.
- Old survivors do not block unrelated changes.
- A fix or new runner support reaches Mergit through a version bump.
- The Stryker config shows only what is particular to Mergit.

### Negative

- A very large refactor can exceed the job's `timeout-minutes`. The job then fails and a reviewer
  reads the failure as advisory.
- The peer warning stays until the runner allows TypeScript 7.
- A change to production code outside the mutated lines can leave a stale reused result, because
  Stryker does not see it and the cache key does not hash production code.
- Equivalent survivors stay in the list, so a reader must tell them from real gaps.
- A change to the script needs a package release before Mergit can use it. Mergit cannot patch the
  script locally.

## Alternatives considered

### A local copy of the script

Keep a copy of the mutation script in `scripts/`. Rejected because the copies drifted within days
and each project fixed the same problems on its own.

### Pin TypeScript 6 for the runner

Install `typescript` 6 so the peer range holds. Rejected because Mergit type-checks with TypeScript
7, and a second version would split what the editor, `tsc`, and Stryker see for no gain, since no
checker is on.

### Mutate the whole code base with a score threshold

Run Stryker on `src/` and require a minimum score. Rejected because a run takes too long for every
pull request, a score hides which lines are untested, and equivalent mutants keep the score below
100 percent.

### Exclude string literals from mutation

Set `mutator.excludedMutations` to `StringLiteral`. Rejected because it also drops string mutants
that matter, such as a field name or a command id. The ignorer removes only wording.
