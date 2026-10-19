# ADR 0007: Side effects as narrow function records

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0004: Capability modules with an enforced import table](./0004-capability-modules.md),
[ADR 0008: One owner for terminal lifetime](./0008-terminal-lifetime.md)

## Context

Mergit calls `gh`, Grove, Herdr, tuicr, the browser, the filesystem, and the clock. Tests must run
without a GitHub account or these tools.

Tests of a refused action must show that no command ran and no file changed.

In Tau, adapter interfaces without a second implementation became scaffolding. lazygit's guide names
a "God Struct" of broad dependencies.

Mergit usually runs inside Herdr, but it must also work without Herdr.

## Decision

Side effects reach a module as a narrow record of plain functions that the module declares for
itself. Each consumer names only the effects it uses, and tests pass fakes for those.

### Function records

- Each consumer declares the type of its record beside its own code. The session's record holds only
  what the session calls, such as fetching work, running an action, saving dismissals, reading the
  time, and scheduling timers.
- `index.ts` builds the production functions. Tests pass fakes, deferred promises, and a fake clock.
- No adapter interfaces, classes, or containers.
- Long-running effects accept an `AbortSignal`.

### External tools

- External tools run as argument arrays, never as shell strings.
- Grove owns worktrees, Herdr owns workspaces, and tuicr owns reviews. Mergit chooses the action and
  invokes the tool.
- Actions detect Herdr and fall back when it is absent. Herdr is never required.

## Consequences

### Positive

- A function signature shows which effects a module can reach.
- Tests pass only the fakes a module uses, and record calls to assert after the action.

### Negative

- Two consumers of the same effect declare similar types.
- `index.ts` wires every record by hand.
- Each Herdr action needs a fallback path and tests for both paths.

## Alternatives considered

### Adapter interfaces, classes, or a service container

Use adapter interfaces, classes, or a service container. Rejected because each has one production
implementation, so the extra type adds no choice.

### One shared effects record

Use one shared `Effects` record for the whole app. Rejected because every consumer could reach every
effect, and one type would couple all modules.

### Direct runtime calls and module mocks

Make direct runtime calls inside each module, replaced in tests with module mocks. Rejected because
tests would depend on module loading, and pure modules would gain I/O.
