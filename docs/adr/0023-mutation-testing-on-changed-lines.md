# ADR 0023: Mutation testing gates changed lines on pull requests

**Date**: 2026-10-18\
**Status**: Accepted; the local copy of the script superseded by
[ADR 0024 (Run mutation testing through the shared package)](./0024-shared-mutation-package.md)\
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

`@hughescr/stryker-bun-runner` is the Stryker test runner that runs `bun test` with per-test
coverage. Its peer dependency is `typescript <7`, and Mergit uses TypeScript 7. Stryker core also
rewrites `tsconfig.json` through the TypeScript JavaScript API, which TypeScript 7 does not have.

## Decision

Mergit runs Stryker only on the lines a pull request changes. A surviving mutant on a changed line
fails the script and the CI job `Mutation`. The job is advisory: it lists survivors on pull requests
and is not a required check. The script is `scripts/mutation.ts`, and `.pi/tau.json` names it under
`mutation`.

The script follows Koja's version (sQVe/koja f15ae9b) until the shared package from Tau replaces it,
so projects can take fixes from each other. The only differences are the `sameFolderTests` switch
and the ignorer name `tauMessageIgnorer`. The switch is off in Mergit. See the tuning note for why.

Noise is removed by configuration, not by a score threshold:

- `coverageAnalysis: perTest` runs only the tests that cover a mutant.
- `ignoreStatic: true` skips mutants in code that runs while a test file loads. A test file must not
  build state at the top level, because Stryker would then count that state's mutants as static and
  skip them.
- The wording ignorer in `scripts/mutationIgnorer.ts` skips the text of plain error messages.

Production code has no `// Stryker disable` comments. A mutant that no test can tell from the
original, and a wording survivor such as a toast title or a disabled-reason text, stays in the
advisory list. The tuning note names them. A reader who finds a real gap resolves it with a test.

Mergit keeps TypeScript 7.0.2 and accepts the runner's peer warning. Bun installs with the warning,
and `bun install --frozen-lockfile` succeeds. The runner reads `typescript` only when the
`typescript` checker is on, and Mergit runs no checker. `tsconfigFile` names a file that does not
exist, so Stryker core skips its `tsconfig` rewrite.

## Consequences

### Positive

- A pull request shows every changed line whose behavior no test pins, so review can ask for a test.
- Survivors name the file, line, mutator, original text, and replacement, so the fix is a test.
- Old survivors do not block unrelated changes.

### Negative

- The job needs Node next to Bun, because Stryker core starts through its Node shebang.
- A very large refactor can exceed the job's `timeout-minutes`. The job then fails and a reviewer
  reads the failure as advisory. The cap is `--max-mutants 100000`, so no pull request reaches it.
- The peer warning stays until the runner allows TypeScript 7.
- Equivalent and wording survivors stay in the list, so a reader must tell them from real gaps.

## Alternatives considered

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
