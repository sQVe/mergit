# Mergit

Terminal UI for GitHub work that needs action. Read [the development guide](docs/development.md) for
local setup and verification.

- Run `bun run check` before finishing changes. It runs typechecking, lint with house style,
  formatting, Knip, and tests.
- Format with `bun run format`, and fix style with `bun run style:fix`. House style comes from
  `@sqve/seam`; Mergit's own lint rules live in `scripts/lintRules.ts`.
- Follow the decisions in [docs/adr](docs/adr/README.md), and record new decisions there. Read that
  guide before adding an ADR. Do not write documents that explain how a feature works; see
  [ADR 0001](docs/adr/0001-documentation-scope.md).
- Name values in camelCase and types in PascalCase. Never SCREAMING_CASE, not even for module
  constants.
- Declare a helper before the code that uses it. Join at most three checks in one condition, and do
  not mix `&&` with `||`; name the inner group instead.
- Comment only what the code cannot say, such as a constraint or a workaround. Do not describe the
  code's history.
- Add a changeset with `bun run changeset` for user-facing changes.
- Before finishing a document, check its local links and verify the commands it gives against the
  repository.

## Architecture

- `src/` holds capability modules. Folder modules `github/`, `work/`, `session/`, and `ui/` each
  have one public entry file named after the folder, such as `session/session.ts`. Other files in
  the folder are private. Flat modules are `config.ts`, `actions.ts`, `localState.ts`,
  `commands.ts`, `invariant.ts`, `query.ts`, `index.ts`, and `terminal.tsx`. See
  [ADR 0004](docs/adr/0004-capability-modules.md) and
  [ADR 0017](docs/adr/0017-local-query-language.md).
- Imports follow the table in ADR 0004. `mergit/module-boundaries` enforces it in ordinary lint. Do
  not silence it; change the table in `scripts/lintRules.ts` when a new edge keeps the ADR's
  directions.
- Put types beside the code that owns them. Do not add barrels, a shared `types.ts`, or `utils/`.
  Extract shared code only for two existing consumers.
- Application state lives in the session store, and the UI sends intents to it. React keeps only
  focus, modal, and viewport state. See [ADR 0005](docs/adr/0005-session-store.md).
- Define commands and keys only in the catalog in `commands.ts`. See
  [ADR 0006](docs/adr/0006-command-catalog.md).
- A module that needs I/O declares a record of the functions it uses, beside its own code. Run
  external tools as argument arrays. See [ADR 0007](docs/adr/0007-side-effect-functions.md).
- Return typed results for expected failures, and throw only through `invariant()`. Parse untrusted
  data once with zod where it enters. See [ADR 0014](docs/adr/0014-coding-conventions.md).
- Only `terminal.tsx` creates or destroys the renderer, handles signals, or exits. See
  [ADR 0008](docs/adr/0008-terminal-lifetime.md).
- Parse config and state once, in their owning module. Ask before a change that breaks a saved file.
  See [ADR 0018](docs/adr/0018-local-state-and-config.md).

## Tests

- Test behavior a caller can observe. Do not test wording, constants, types, or internal calls.
- Keep tests next to source. Cross-module and tooling checks go in `tests/`.
- Use temporary directories for fixtures and remove them when the test finishes.
- Never drop assertions or failure cases to save time.
