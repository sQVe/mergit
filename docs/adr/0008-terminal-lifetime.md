# ADR 0008: One owner for terminal lifetime

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0003: OpenTUI with React bindings as the renderer](./0003-opentui-react-renderer.md),
[ADR 0007: Side effects as narrow function records](./0007-side-effect-functions.md)

## Context

Mergit stops on `q`, Ctrl+C, SIGINT, SIGTERM, and fatal errors. Each path must stop timers and
children, save state, and restore the terminal.

Surveyed OpenTUI apps work around unsafe teardown: Ox repairs terminal line discipline after
destroy, and Cline defers destroy until input parsing finishes.

The renderer prototype in [ADR 0003](./0003-opentui-react-renderer.md) restored the terminal on `q`,
Ctrl+C, and SIGINT.

Herdr is optional. Without it, tuicr must run in Mergit's own terminal, so the renderer must pause
and resume around a child process.

## Decision

`terminal.tsx` alone owns the renderer, the keymap instance, React mounting, signal handlers, and
shutdown. The bindings on that instance come from the command catalog. `index.ts` composes
dependencies and starts `terminal`. One module controls the renderer's lifetime, every exit path,
and every terminal handoff.

### Shutdown

- One idempotent shutdown runs for every exit path. The renderer's own exit handling is turned off.
- It blocks new intents and stops timers, then aborts refresh and owned child processes. It
  terminates children that do not exit within a bounded wait.
- It saves dismissals within a bounded wait.
- It unmounts React, removes bindings and subscriptions, and destroys the renderer in `finally`.
- It restores the terminal before it prints a fatal error.
- It never stops a Herdr workspace or daemon.

### Lending the terminal

- `terminal` provides a function that suspends input and rendering, runs a child process in the
  terminal, and resumes in `finally`. Actions receive it as an injected function.
- If resume fails, Mergit restores the terminal and exits.

## Consequences

### Positive

- Every exit path runs the same cleanup in the same order.
- Actions can run interactive tools without knowing about the renderer.

### Negative

- The suspend and resume sequence is not yet verified on the pinned OpenTUI version. The first
  action that lends the terminal must prove it in a pseudo-terminal test.
- Bounded waits can cut off a slow save or child process at quit.

## Alternatives considered

### Startup and shutdown in `index.ts`

Let `index.ts` own startup and shutdown. Rejected because it would mix dependency wiring with signal
handling and mounting, and terminal code could not be tested with fake dependencies.

### Component-owned exits

Let each component or hook handle its own exit. Rejected because exit paths would compete, and one
could skip cleanup.

### Require Herdr

Require Herdr and run tuicr only in a Herdr pane. Rejected because Mergit must work without Herdr.
