# Mergit

Terminal UI for GitHub work that needs action. Before changing setup, checks, or release tooling,
read [the development guide](docs/development.md).

- Run `bun run check` before finishing changes. It runs typechecking, lint with house style,
  formatting, Knip, and tests.
- Format with `bun run format`, and fix style with `bun run style:fix`. House style comes from
  `@sqve/seam`; Mergit's own lint rules live in `scripts/lintRules.ts`.
- Follow the decisions in [docs/adr](docs/adr/README.md), and record new decisions there. Read that
  guide before adding or changing an ADR. When details of a decision change, edit its ADR in place
  in the same change. When its core choice reverses, write a new ADR and retire the old one. Do not
  write documents that explain how a feature works; see
  [ADR 0001](docs/adr/0001-documentation-scope.md).
- Name values in camelCase and types in PascalCase. Never SCREAMING_CASE, not even for module
  constants.
- Declare a helper before the code that uses it. Join at most three checks in one condition, and do
  not mix `&&` with `||`; name the inner group instead.
- Comment only what the code cannot say, such as a constraint or a workaround. Do not describe the
  code's history.
- For a PR targeting `main` that touches `src/**`, add a changeset with `bun run changeset`, except
  for release PRs. Before preparing release notes, read [Versioning](docs/development.md#versioning)
  for the exact CI gate and release-PR exceptions.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Architecture

- `src/` holds capability modules. Each folder module has one public entry file named after the
  folder, such as `session/session.ts`. Other files in the folder are private. Before changing
  module boundaries or code placement, read [ADR 0004](docs/adr/0004-capability-modules.md) and
  [ADR 0022](docs/adr/0022-owner-files-and-owner-first-names.md).
- Imports follow the table in ADR 0004. `mergit/module-boundaries` enforces it in ordinary lint. Do
  not silence it; change the table in `scripts/lintRules.ts` when a new edge keeps the ADR's
  directions.
- Put types beside the code that owns them. Do not add barrels, a shared `types.ts`, or `utils/`.
  Extract shared code only for two existing consumers.
- Application state lives in the session store, and the UI sends intents to it. The session owns the
  list viewport, and React keeps focus, modal, and overlay scroll state. Before changing state
  ownership, read [ADR 0005](docs/adr/0005-session-store.md).
- Define commands and keys only in the catalog in `commands.ts`. Before changing commands or keys,
  read [ADR 0006](docs/adr/0006-command-catalog.md).
- A module that needs I/O declares a record of the functions it uses, beside its own code. Run
  external tools as argument arrays. Before adding I/O, read
  [ADR 0007](docs/adr/0007-side-effect-functions.md).
- Return typed results for expected failures, and throw only through `invariant()`. Parse untrusted
  data once with zod where it enters. Before changing error handling or input boundaries, read
  [ADR 0014](docs/adr/0014-coding-conventions.md).
- Only `terminal.tsx` creates or destroys the renderer, handles signals, or exits. Before changing
  terminal lifetime, read [ADR 0008](docs/adr/0008-terminal-lifetime.md).
- Parse config and state once, in their owning module. Ask before a change that breaks a saved file.
  Before changing saved config or state, read [ADR 0009](docs/adr/0009-local-state-and-config.md).
- Before changing search or field filters, read
  [ADR 0019](docs/adr/0019-search-and-field-filters.md) and
  [ADR 0020](docs/adr/0020-filter-composer.md).
- Before changing GitHub fetching or refresh persistence, read
  [ADR 0011](docs/adr/0011-github-through-gh-api.md),
  [ADR 0015](docs/adr/0015-notifications-first.md), and
  [ADR 0016](docs/adr/0016-snapshot-and-full-refresh.md).

## Tests

- Test behavior a caller can observe. Do not test wording, constants, types, or internal calls.
- Keep tests next to source. Cross-module and tooling checks go in `tests/`.
- Use temporary directories for fixtures and remove them when the test finishes.
- Never drop assertions or failure cases to save time.
