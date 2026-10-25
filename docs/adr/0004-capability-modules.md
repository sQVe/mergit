# ADR 0004: Capability modules with an enforced import table

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0005: One session store outside React](./0005-session-store.md),
[ADR 0007: Side effects as narrow function records](./0007-side-effect-functions.md),
[lazygit PR #2519](https://github.com/jesseduffield/lazygit/pull/2519)

## Context

Mergit reads GitHub, classifies work, coordinates a session, runs local actions, saves local state,
reads config, and renders a terminal UI. Each job needs one clear owner before app code exists.

Surveys of mature TUIs suggested layer folders such as `domain/`, `application/`, and `adapters/`.
In Tau, generic layers and early shared extraction became scaffolding that later had to be removed.

Separate files alone did not constrain state access in lazygit, whose refactor PR #2519 says "it's
not clear where state should live".

Written rules alone did not hold in Tau: it grew four task-ID parsers despite a parse-once rule.
Boundaries need a mechanical check.

## Decision

`src/` holds capability modules. A lint rule, `mergit/module-boundaries`, enforces which module may
import which. Modules name their owner, and lint refuses imports that cross the table.

### Modules

- Folder modules: `github/`, `work/`, `session/`, `ui/`, `localState/`, `config/`. Each has one
  public entry file named after the folder, such as `session/session.ts`. Other files in the folder
  are private to the module.
- Flat modules: `actions.ts`, `commands.ts`, `fuzzy.ts`, `invariant.ts`, `query.ts`, `index.ts`,
  `terminal.tsx`.
- A file outside these modules is an error. A new module starts as a flat file. It becomes a folder
  when it needs a second source file.

### Import direction

- `fuzzy` owns fuzzy text scoring shared by filter completion and help search. It imports no other
  module. `session` and `ui` import it so neither owns the other's matching behavior.
- `work` and `invariant` import no other module. Every module may import `invariant`.
- `config` imports `commands`, which defines the commands that a config file remaps.
- `github`, `localState`, and `actions` import `work`. `actions` also imports `config`.
- `query` imports `work` and `invariant`, as defined in
  [ADR 0019](./0019-search-and-field-filters.md).
- `session` imports `work` and `query`. It may import types from `github`, `actions`, and
  `localState`, but not their functions. Their functions reach the session as injected dependencies.
- `commands` imports `work` and `session`. `ui` imports `work`, `session`, and `commands`. Neither
  imports an integration module.
- `terminal` imports `ui`, `session`, `commands`, and `config`. `index` imports any module. No
  module imports `index` or `terminal`, except `index` importing `terminal`.
- `fuzzy`, `work`, `query`, `session`, `commands`, and `ui` import no Node or Bun built-ins.
  `fuzzy`, `work`, `query`, `session`, and `commands` also import no React or OpenTUI packages.
- Type imports count as dependencies. Dynamic imports must use a literal path.

The rule holds the exact table. A change that keeps these directions updates the rule. A new module
joins the table with the ADR that introduces it. A change that reverses a direction needs a new ADR.

### Code placement

- Types live in the module that owns them. Do not add a shared `types.ts`, `utils/`, or barrel file.
- Extract shared code only when two existing consumers need it.

## Consequences

### Positive

- An agent or reviewer can read ownership from the path, and lint refuses imports that cross it.
- Pure modules stay free of I/O, so tests run them without fakes.

### Negative

- Every new module or edge needs a rule change, which adds friction to small additions.
- The rule checks import paths only. It does not detect I/O reached through globals such as
  `Date.now` or `process`.

## Alternatives considered

### Layer folders

Use layer folders (`domain/`, `application/`, `adapters/`, `ui/`). Rejected because the folder names
say little about who owns a job, and they invite empty scaffolding.

### Import rules written only in `AGENTS.md`

Use capability modules with import rules written only in `AGENTS.md`. Rejected because the rules
would drift without a check.

### Start every module as a flat file

Start every module as one flat file and add folders later. Rejected because `github`, `work`,
`session`, and `ui` each split into several files in the first version.
