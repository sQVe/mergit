# ADR 0022: Owner files inside modules, thin coordinators, and owner-first file names

**Date**: 2026-10-14\
**Status**: Accepted\
**Related**: [ADR 0004 (Capability modules)](./0004-capability-modules.md),
[ADR 0006 (Command catalog)](./0006-command-catalog.md),
[ADR 0010 (Shared project base)](./0010-shared-project-base.md),
[ADR 0014 (Coding conventions)](./0014-coding-conventions.md)

## Context

ADR 0004 decides which modules exist and which may import which. It says nothing about how code is
arranged inside a module, so most features have gone into a few central files. `session/session.ts`
holds refresh, account switches, subject lookups, toasts, done actions, intent dispatch, and
shutdown. `session/sessionState.ts` holds snapshot data, feed transitions, selection, folds,
grouping, and hiding. `ui/ui.tsx` holds key bindings, modal actions, search, and layout. Their two
test files are the largest files in the repository.

Agents write most features as slices that run in parallel branches. Recent slices for search, the
browser, and field filters all edited `session.ts`, `ui.tsx`, and both of their test files, and the
search and filter slices also edited `sessionState.ts`. Shared editing paths make conflicts likely
and make a reader scan one long file to find one feature. Size alone is not the cause.

Phi decided the same question in its ADR 0016, and ADR 0010 keeps shared decisions in line. Zeta
keeps Phi's rule. It differs only in which nouns turn out to be owners, because almost every Zeta
feature acts on one object, the notification thread.

## Decision

Inside each folder module, code for one owner lives in private files named owner first, and the
module's coordinators hold only dispatch, lifecycle, and the order that must stay central. Size is a
reason to review a file, never a check that fails.

### Owners

- An owner is a user-facing noun for behavior that changes on its own, whether an entity or a
  capability. Use the same noun for it in every module, so its session and UI files share a prefix.
- In Zeta most owners are capabilities, such as `search`, `filter`, `done`, `marker`, `detail`,
  `feed`, `account`, and `message`. `thread` owns only the thread itself, such as its row and its
  identity, because a `thread` prefix on every feature would hide which feature a file belongs to.
- Infrastructure that belongs to no feature has its own owner noun, such as `input`, `selection`, or
  `snapshot`.
- `message` owns the short-lived messages the user sees: showing them as toasts and keeping their
  history. A component for one presentation, such as `Toast.tsx`, belongs to it.
- An owner may have several files, one per behavior that changes on its own, such as transitions,
  effects, and parsing. Keep a resource's lifetime or one state machine in one file, as
  `session/done.ts` keeps the done queue and its cancellation.
- Extract shared code when two existing consumers need it, as ADR 0004 says.

### Coordinators

- `session/session.ts` owns the store, intent dispatch, and the order of publication, such as
  applying a feed update before pruning saved records. It starts and stops owners at shutdown, and
  each owner keeps its own cancellation state.
- `session/sessionState.ts` assembles the snapshot and calls the selection owner's repair after any
  change. The repair policy belongs to `selection`.
- `ui/ui.tsx` owns store subscriptions, routing keys to intents, modal precedence, layout across
  features, and mount order.
- `commands.ts` stays the one catalog of ADR 0006. It keeps each command's record and its pure
  availability and intent functions. `index.ts` stays the wiring.
- Coordinators delegate feature transitions and effects to owner files. A feature edits a
  coordinator only to register an intent, a command, a mode, or a layout slot, to change shared
  lifecycle or ordering, or to change a public contract. Keep those edits small and explicit.
- Entry files stay the public API that ADR 0004 defines. The lint table does not change.

### File names

- Name a private file `<owner><job>` in camelCase, with a singular owner noun first, such as
  `searchTransitions.ts`, `selectionRepair.ts`, `feedRefresh.ts`, or `filterComposer.ts`.
- A file may use the owner noun alone when that noun names what the file holds, such as
  `session/done.ts`. A plural noun alone names a collection, such as `github/subjects.ts`.
- A component file keeps PascalCase after the component it exports, as ADR 0014 says, and starts
  with its owner: `SearchLine.tsx`, `FilterBar.tsx`, `MessageOverlay.tsx`.
- Public entry files and flat modules keep the names ADR 0004 gives them.
- Functions start with a verb and types use PascalCase, as before. The owner-first order applies to
  file names only.

### Tests

- A test file keeps its source name with `.test`, so a split source file splits its tests.
- A feature's tests may go through the public store or mount the app, where its effects meet shared
  transitions. A coordinator's test file keeps the public contracts, such as snapshot identity and
  subscriptions, and the behavior that crosses features, such as focus, modal precedence, and
  publication order.
- Move setup into a private harness, such as `session/sessionHarness.ts`, only when two suites share
  it. A harness imports no `bun:test`, returns its cleanup, and holds no resource shared across
  suites. Setup shared across modules lives in `tests/`. Fixtures stay in the suite that uses them.
- An integration test in `tests/` is named for its owner and behavior, such as
  `doneTerminal.test.ts`.

### Size

- Review a file over 500 lines and a function over 60 lines or with more than 4 parameters. Split by
  responsibility, not to meet a count.
- These limits are review signals. No check fails on them.

## Consequences

### Positive

- Parallel slices for different owners edit different files, so they conflict less.
- A reader finds a feature by its noun: sorted listings group `search*` files together in each
  module.
- Coordinators stay short because they hold dispatch, lifecycle, and ordering only.
- Most current names already fit, so the rule needs few renames.
- Zeta and Phi follow one rule, so an agent that works in both finds code the same way.

### Negative

- One feature spans several small files across modules, so a change opens more files.
- Each new intent, command, mode, or layout slot still edits its coordinator once to register.
- Choosing an owner noun is a judgment call, and two slices can pick different nouns for one
  feature.
- Without a failing check, the size signals depend on review and can drift.
- Extracting owners from today's central files touches their importers and tests.

## Alternatives considered

### Keep growing the central files

Keep the current layout and rely on review. Rejected because the session, its state, the UI root,
and their tests already lie on the editing path of most slices.

### A hard line limit in lint

Let lint refuse files over 500 lines. Rejected because a count does not show ownership: it would
force splits of cohesive files such as the done queue and the terminal lifetime, while a coordinator
under the limit could still hold every feature. Zeta's lint denies warnings, so a warning level
would block too.

### The thread as the owner of every feature

Prefix every file that acts on threads with `thread`, the way Phi uses its pane for pane features.
Rejected because almost every Zeta feature acts on threads, so the prefix would no longer tell
search, filters, and done apart.

### One folder per feature across modules

A folder such as `src/search/` holding the search session, UI, and query code. Rejected because it
breaks the capability modules of ADR 0004: pure and UI code would share a folder, and the import
table could no longer tell them apart.

### Split by kind of code

Files such as `types.ts`, `handlers.ts`, and `keys.ts` inside each module. Rejected because one
feature would spread across every file, and ADR 0004 refuses a shared `types.ts`. Moving all key
bindings into one file only moves the shared edit.
