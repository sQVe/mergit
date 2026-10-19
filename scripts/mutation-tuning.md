# Mutation tuning

This note records why `stryker.config.json` has each setting. Run the six commits again after you
change a setting that changes the mutants or their results.

## Method

Each run checked out one commit of `main` in a separate worktree, copied in `scripts/mutation*.ts`,
`tests/gitRepository.ts`, and `stryker.config.json`, and ran
`bun scripts/mutation.ts changed <commit>~1`. The commit's own tests ran, so the results show what
that commit's tests killed. They do not show what `main` kills today. The runs went two at a time on
a 32-core machine that also ran other jobs, so the times are rough. Production code has no
`// Stryker disable` comment, so every mutant the config does not skip is in the counts.

Each survivor was sorted by reading its line:

- Real gap: a test can pin observable behavior on that line. This is the default.
- Equivalent: no test can tell the mutant from the original.
- Noise: wording, styling, or a constant that `AGENTS.md` says not to test.

Survivors are `Survived` plus `NoCoverage` mutants.

## Commits

All six commits changed production code in `src/`. Counts are from the final config. "Timeout"
mutants are not in "Killed".

| Commit    | Change                                                  | Mutants | Killed | Survived | No coverage | Timeout | Wall time |
| --------- | ------------------------------------------------------- | ------: | -----: | -------: | ----------: | ------: | --------: |
| `39c9e06` | keep keys typed after f out of the list (#32)           |     473 |    364 |      103 |           5 |       1 |  16 min\* |
| `220fe60` | keep notices whole and readable at 80 columns (#42)     |      44 |     34 |        8 |           0 |       2 |     9 min |
| `87c0167` | draw :messages over the whole screen (#41)              |       8 |      3 |        5 |           0 |       0 |     2 min |
| `038cb7b` | close filters after adding one (#40)                    |      19 |     12 |        7 |           0 |       0 |     2 min |
| `1969826` | complete repo names and title words on the / line (#38) |     150 |    113 |       35 |           2 |       0 |     6 min |
| `8b0dca6` | add a command line with a :messages command (#39)       |     277 |    241 |       36 |           0 |       0 |    17 min |

\* `39c9e06` changed more than 500 mutants, the script's default cap at the time. The cap left
`src/session/filterDescriptions.ts` and `src/ui/ui.tsx` unmutated, so the script exited 1 with
status `error`. The survivors of the other four files are in the report and in the table.

### Survivors by kind

| Commit    | Real gap | Equivalent | Noise | What the equivalent and noise survivors are                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------: | ---------: | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `39c9e06` |       99 |          1 |     8 | Equivalent: `CandidateList.tsx:49`, the `''` fallback in `kept.at(-1) ?? ''`. No test reaches it, because `kept` is never empty there. Noise: `CandidateList.tsx:64-65`, the `palette.error` colour choice (4 mutants), and `query.ts:400`, the `valid` text for an unknown filter field (4 mutants: `'is'`, `'kind, state, new, or unread'`, `', '`, and the `name === 'is'` choice). |
| `220fe60` |        6 |          0 |     2 | Noise: `session.ts:319`, the toast tone `'error'`, and `session.ts:369`, a toast title.                                                                                                                                                                                                                                                                                                |
| `87c0167` |        0 |          0 |     5 | Noise: `browserOpen.ts:41-43`, the toast text for one page or many (5 mutants).                                                                                                                                                                                                                                                                                                        |
| `038cb7b` |        6 |          1 |     0 | Equivalent: `SearchCompletion.tsx:18`, `chosen === null` to `false`. `null - rows + 1` is 0 or less, so `Math.max(0, ...)` gives 0 either way.                                                                                                                                                                                                                                         |
| `1969826` |       31 |          2 |     4 | Equivalent: `searchCompletion.ts:27`, `/\s+/` to `/\s/`, because line 29 drops the empty words; and `:105`, a fallback `''` no test reaches. Noise: `SearchCompletion.tsx:33-35`, the `marked`, `failed`, and `muted` styling flags, and `commands.ts:54`, a disabled-reason text.                                                                                                     |
| `8b0dca6` |       29 |          1 |     6 | Equivalent: `messageToast.ts:31`, `nextMessageId += 1` to `-= 1`; ids stay unique. Noise: `MessageOverlay.tsx:49`, the tone colour (4 mutants); `messageWindow.ts:64`, a React key; and `commands.ts:329`, a disabled-reason text.                                                                                                                                                     |

Counts: 99 + 6 + 0 + 6 + 31 + 29 = 171 real gaps, 5 equivalent, and 25 noise survivors, 201 in all.
A survivor is `Survived` plus `NoCoverage`.

### Equivalent outside the tuning commits

`src/session/feedRefresh.ts:155`, `ObjectLiteral` on `return { kind: 'aborted' }`. The early return
still happens. After `stop`, `isCurrent` drops the outcome, so the replacement object never reaches
a caller. Removing the guard itself fails an existing test. The mutant stays in the advisory list.

## Wording survivors

The 12 wording survivors in the six runs are noise. They are toast titles and texts, disabled-reason
texts, and the unknown-field message:

| Commit    | Survivors | Where                                                                      |
| --------- | --------: | -------------------------------------------------------------------------- |
| `39c9e06` |         4 | `query.ts:400`, the `valid` text for an unknown filter field               |
| `220fe60` |         1 | `session.ts:369`, a toast title                                            |
| `87c0167` |         5 | `browserOpen.ts:41-43`, the toast text and the `pages.length === 1` choice |
| `1969826` |         1 | `commands.ts:54`, a disabled-reason text                                   |
| `8b0dca6` |         1 | `commands.ts:329`, a disabled-reason text                                  |

They stay in the advisory list. Production code has no disable comment for them.

The ignorer skips an error message only when it has no expression. Mergit returns typed results and
builds most messages from templates, as in `Invalid filter "${token}": ...`. Across the 46 mutated
files, the ignorer skips 2 of 4,949 mutants. It skips only plain error messages. The shared package
ME-742 will skip these wording survivors for every project.

## Settings

| Setting                          | Value                                           | Reason                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testRunner`, `plugins`          | `bun`, `@hughescr/stryker-bun-runner`           | Mergit's tests use `bun:test`. The runner gives per-test coverage. All six runs worked.                                                                                                                                                                                                                 |
| `bun.timeout`, `bun.bunArgs`     | `600000`, `--timeout 60000`                     | The pilot found that two `filterComposer` tests time out under instrumented code with the defaults. This tuning kept the setting and did not run without it.                                                                                                                                            |
| `coverageAnalysis`               | `perTest`                                       | Stryker runs only the tests that cover a mutant. The dry run of 547 tests took 68 seconds, and the runs of 3 to 468 mutants took 2 to 16 minutes.                                                                                                                                                       |
| `mutate`                         | `src/**/*.ts`, `src/**/*.tsx`, minus listed     | Every production file is under `src/`. Test files and `*Harness.ts(x)` test support are not production code.                                                                                                                                                                                            |
| `mutate` excludes `src/index.ts` | `!src/index.ts`                                 | With `src/index.ts` in `mutate`, the run of `220fe60` reported 17 mutants. Without it, 43. A run of `Notice.tsx` alone had 3 static mutants. With `src/index.ts` beside it, 24 were static and skipped. The cause is not known. The file is the process entry point, and its mutants have no unit test. |
| `tsconfigFile`                   | `stryker-no-tsconfig.json` (does not exist)     | Stryker core rewrites `tsconfig.json` through the TypeScript JavaScript API. With TypeScript 7 it failed with `ts.parseConfigFileTextToJson is not a function`. A missing file skips the rewrite.                                                                                                       |
| `checkers`                       | `[]`                                            | A TypeScript checker needs the same API. The six runs had 0 invalid mutants, so no checker is needed.                                                                                                                                                                                                   |
| `ignoreStatic`                   | `true`                                          | A mutant in code that runs while a file loads is not a test gap. On `filterDescriptions.ts` of `39c9e06`, a table of module-level data, 131 mutants survived with it off and 51 with it on, and 147 were skipped.                                                                                       |
| `ignorers`                       | `tauMessageIgnorer`                             | It skips error message text, as `AGENTS.md` asks. It is small here: 2 of 4,949 mutants. See above.                                                                                                                                                                                                      |
| `concurrency`                    | `4`                                             | Chosen for a 4-core CI runner. This value was not measured.                                                                                                                                                                                                                                             |
| `timeoutMS`                      | `10000`                                         | Runs had 0 to 2 timed-out mutants. A timeout counts as a kill, and no data argues for a change.                                                                                                                                                                                                         |
| `ignorePatterns`                 | `.tau`, `docs`, `tests`, `dist`, `CHANGELOG.md` | Stryker does not copy these into the sandbox. `tests/` holds the lint and process checks, which are slow and not unit tests. The pilot made the same choice; this tuning did not measure it.                                                                                                            |
| `tempDirName`, `cleanTempDir`    | `.stryker-tmp`, `true`                          | A fixed folder in the repository, ignored by Git, removed after a run.                                                                                                                                                                                                                                  |
| `thresholds.break`               | set to `null` by the script                     | The report decides the exit code, not a score.                                                                                                                                                                                                                                                          |
| Cap                              | `--max-mutants 100000` in the CI job            | See "Advisory CI job" below.                                                                                                                                                                                                                                                                            |

## Test files that run code at load

`ignoreStatic` skips every mutant that runs while a test file loads, even when a test also covers
it. `src/commands.test.ts` used to create a session at the top of the file. In a whole-suite run,
that made the session mutants static, and Stryker skipped them. The session is now created inside
each test. Keep test files free of work at load.

## Script source and the `sameFolderTests` switch

`scripts/mutation*.ts` follow Koja's version (sQVe/koja f15ae9b) until the shared package from Tau
replaces them. Two things differ: the ignorer is named `tauMessageIgnorer`, and the config key
`sameFolderTests` selects Koja's per-folder runs. With it on, the script starts Stryker once per
folder and runs only that folder's unit tests. With it off, the default, it starts Stryker once and
every unit test can kill each mutant.

Mergit leaves the switch off. With it on, a mutant can only be killed by a unit test in its own
folder, and a folder with no unit test reports every mutant as having no coverage. Mergit tests
cross folder, for example `src/commands.test.ts` covers code in `src/session`, and the user wants no
extra rules about where a test lives. This was not measured on a Mergit commit. The cost is one dry
run of all unit tests, 915 tests in about 2.5 minutes on the machine used here. Koja's
`KOJA_MUTATION` variable and `bunfig.mutation.toml` are Koja policy, and Mergit needs neither.
`tests/*.test.ts` is in `ignorePatterns` because those files are not unit tests, but the sandbox
keeps `tests/gitRepository.ts`, which `tests/mutation.test.ts` imports.

## Advisory CI job

The `Mutation` job runs on pull requests, lists survivors, and is not a required check. The user
wants better tests without extra hoops.

Run times with the script above, on the 4-concurrency config:

| Run                             | Mutants | Result                        | Time        |
| ------------------------------- | ------: | ----------------------------- | ----------- |
| `changed 04b0cd1`               |      12 | 12 killed                     | 2.5 min     |
| `changed 39c9e06~1`, cap 500    |     370 | 29 survived, 1 no coverage    | 7 min       |
| `changed 39c9e06~1`, cap 100000 |    2507 | stopped at 132 tested, 16 min | about 5.5 h |

The dry run costs about 2.5 minutes. The old per-commit runs of 3 to 275 mutants took 2 to 16
minutes. `timeout-minutes: 60` covers ordinary pull requests such as those commits. A refactor as
large as `39c9e06` would time out, and that is accepted: the job is advisory, and splitting a
refactor is cheaper than waiting hours. `--max-mutants 100000` keeps the script's fail-closed cap
but sets it above any real pull request, so the timeout is the only bound.
