# Development

Set up a checkout and check changes before release.

## Local setup

Use the Bun version specified by `packageManager` in [package.json](../package.json). Bun is the
runtime, package manager, and test runner. Run these commands from the Mergit checkout:

```sh
bun install --frozen-lockfile
bun run check
```

`bun install` also installs the Git hooks. The pre-commit hook runs the house-style and format
checks on staged files.

## Check changes

| Command                           | Use                                                                       |
| --------------------------------- | ------------------------------------------------------------------------- |
| `bun run check`                   | Run typechecking, house style, formatting, Knip, and the full test suite. |
| `bun run test`                    | Run the full test suite.                                                  |
| `bun run test tests/lint.test.ts` | Run one test file.                                                        |
| `bun run test:changed`            | Run tests affected by uncommitted changes.                                |
| `bun run style:check`             | Check all lint rules, including house style, with `seam`.                 |
| `bun run style:fix`               | Apply safe lint fixes with `seam --fix`, then format.                     |
| `bun run lint`                    | Run ordinary lint diagnostics, as editors do.                             |
| `bun run format`                  | Format files.                                                             |
| `bun run knip`                    | Find unused files, exports, and dependencies.                             |
| `bun run mutation changed <base>` | Mutate the lines changed since `<base>` and list surviving mutants.       |

House style comes from the [`@sqve/seam`](https://www.npmjs.com/package/@sqve/seam) package. Its
`seam` command turns on the house rules for its own lint run, so editors and `bun run lint` show the
ordinary rules only. Mergit adds one local rule, `mergit/module-boundaries`, from
[scripts/lintRules.ts](../scripts/lintRules.ts). It runs in every lint command.

Style commands accept file paths, for example `bun run style:fix tests/lint.test.ts`. Rename
bindings and move helpers manually.

Configure linting, formatting, and staged checks in [vite.config.ts](../vite.config.ts). Run
installed command-line tools with `bunx --bun`, as the scripts do. The tools start with a Node
shebang, so without `--bun` they run on Node instead of Bun.

`bun run mutation` runs the `mutation` command of the
[`@sqve/mutation`](https://www.npmjs.com/package/@sqve/mutation) package with the root
[stryker.config.json](../stryker.config.json). The package README lists the report, the exit codes,
and the defaults it adds to the config, such as its message ignorer and `ignoreStatic`. The config
sets only Mergit's own policy. The command runs on Bun through `bunx --bun`, so CI needs no Node.
Bump the pinned package version to get a fix.

## Versioning

For a PR targeting `main` that touches `src/**`, add a changeset:

```sh
bun run changeset
```

Describe the behavior change for users. Commit the generated file under `.changeset/` with the
change it describes.

The [changeset check](../.github/workflows/changeset.yml) uses the `src/**` path gate, not a
user-facing-change test. It does not require a changeset for changes only outside `src/`, such as
docs, tooling, or dependencies. It also skips a PR if its title is exactly
`chore: release version packages` or its head branch is `changeset-release/main`.

The [release workflow](../.github/workflows/release.yml) opens version PRs and creates Git tags and
GitHub releases. Mergit is private and is not published to npm.
