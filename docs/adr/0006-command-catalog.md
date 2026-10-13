# ADR 0006: One command catalog as data

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0003: OpenTUI with React bindings as the renderer](./0003-opentui-react-renderer.md),
[ADR 0005: One session store outside React](./0005-session-store.md),
[ADR 0009: Versioned local state and config](./0009-local-state-and-config.md)

## Context

[ADR 0003](./0003-opentui-react-renderer.md) requires shortcuts from one keymap definition. Help,
availability, and user remaps need the same source, or they drift from the keys that work.

lazygit binding records carry a handler, description, scope, and disabled reason. One record drives
invocation, help, and availability.

Ox splits navigation keys from action commands, and Gemini CLI keeps keyboard commands apart from
slash commands. Each split adds a second place to change.

A command written as a closure cannot tell help why it is disabled, and tests must run its effects
to see what it does.

## Decision

`commands.ts` defines every command once, as data in one catalog. Keymap, help, availability, and
remaps read the same records, and tests assert intents without running effects.

### Commands

- Each command has an id, a label, a scope (`global`, `list`, `preview`, or `modal`), and default
  keys.
- `disabledReason(snapshot)` returns why the command cannot run, or nothing when it can.
- `intent(snapshot)` returns an application intent for the session, a UI intent for React, or a
  terminal intent. It performs no I/O. Only `terminal.tsx` handles terminal intents, so the session
  never owns the process lifetime.
- Keymap layers, help, and availability come from the catalog. Key handlers read the latest
  snapshot, not one captured at render.
- The session checks preconditions again before it acts. A disabled key is not a safety check.

### Scopes

- `list` and `preview` bindings follow focus. `global` bindings work outside modals.
- An open modal blocks the commands beneath it. On close, focus returns to the previous target only
  if it is still mounted.

### Remaps

- Config maps a command id to a list of keys. The list replaces the defaults, and `[]` disables the
  command's keys.
- Unknown ids, invalid keys, and one key bound to two commands in overlapping scopes stop startup.
- Quit signals such as SIGINT still stop Zeta when the quit command has no keys.

## Consequences

### Positive

- A key shown in help is a key that works, and help can say why a command is disabled.
- Tests check a command by its intent, with no fakes for effects.

### Negative

- Every command needs a catalog entry, even one used in a single place.
- Intents add a type for each action, which a closure would not need.

## Alternatives considered

### Command closures

Define commands with a `run(dispatch)` closure. Rejected because help cannot explain a disabled
command, and tests must run effects to observe a command.

### Component-owned bindings

Let each component register bindings. Rejected because ADR 0003 already requires one keymap
definition.
