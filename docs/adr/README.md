# Architecture decision records

Record lasting decisions and the reasons behind them, not how a feature works.

## Before writing

Follow [ADR 0001](./0001-documentation-scope.md) for documentation scope. Before opening the
[template](./TEMPLATE.md), answer:

- What choice are we making, and what lasting reason stands behind it?
- What credible alternative did we consider, and why did we reject it?

If the answers only restate what the code does, do not write an ADR. Code and tests hold behavior. A
feature change does not require a new document.

Use a title that names the choice, and state that choice in the first sentence of the Decision
section. Give each rejected or deferred alternative its own heading under Alternatives considered.
An ADR is not a feature summary, implementation plan, or acceptance checklist.

## Keeping ADRs current

A new ADR is Accepted, and Accepted is the only status. Merging its PR is the approval, so there is
no Proposed stage. When details of a decision change, edit its ADR in place. Supersede an ADR only
when its core choice reverses: the new ADR states the whole current rule and names the old one on
its Supersedes line. Delete the old file and add it to the Retired table. Numbers are never reused.
`git show <commit>:docs/adr/<file>` prints a retired ADR from its last commit.

## Project and tooling

- [0001: Documentation scope](./0001-documentation-scope.md)
- [0002: Bun as runtime, package manager, and test runner](./0002-bun-toolchain.md)
- [0010: One project base shared with Koja](./0010-shared-project-base.md)
- [0023: Mutation testing gates changed lines on pull requests](./0023-mutation-testing-on-changed-lines.md)

## Architecture and code

- [0003: OpenTUI with React bindings as the renderer](./0003-opentui-react-renderer.md)
- [0004: Capability modules with an enforced import table](./0004-capability-modules.md)
- [0005: One session store outside React](./0005-session-store.md)
- [0006: One command catalog as data](./0006-command-catalog.md)
- [0007: Side effects as narrow function records](./0007-side-effect-functions.md)
- [0008: One owner for terminal lifetime](./0008-terminal-lifetime.md)
- [0014: Results for expected failures, exceptions for bugs, and checked boundaries](./0014-coding-conventions.md)
- [0022: Owner files inside modules, thin coordinators, and owner-first file names](./0022-owner-files-and-owner-first-names.md)

## GitHub data and local state

- [0009: Versioned local state and config](./0009-local-state-and-config.md)
- [0011: GitHub through `gh api`](./0011-github-through-gh-api.md)
- [0015: Notifications first, with a batched subject lookup](./0015-notifications-first.md)
- [0016: A SQLite snapshot with a checked full refresh](./0016-snapshot-and-full-refresh.md)

## Search and filters

- [0019: Plain text search on `/`](./0019-search-and-field-filters.md)
- [0020: Field filters from a composer, applied on Enter](./0020-filter-composer.md)

## Retired

| ADR  | Title                                                        | Replaced by | Last commit |
| ---- | ------------------------------------------------------------ | ----------- | ----------- |
| 0012 | Sources find candidates, local rules decide why              | 0015        | d901d93f    |
| 0013 | Hand-written sync over a SQLite cache                        | 0016        | d901d93f    |
| 0017 | GitHub-style qualifiers, evaluated locally                   | 0019        | d901d93f    |
| 0018 | Local state for two Mergit processes                         | 0009        | d901d93f    |
| 0021 | Chips of one field combine by how many values a thread holds | 0020        | 39c9e067    |
| 0024 | Run mutation testing through the shared package              | 0023        | 70e38054    |
