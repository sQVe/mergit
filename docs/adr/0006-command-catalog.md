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

- Each command has an id, a label, a scope (one of the nine below), a help section, and default
  keys.
- Help reads its sections from the catalog, in a fixed order. Input-line copies of one action, such
  as clearing the line, share a `configId`, so they show as one help row.
- `disabledReason(snapshot)` returns why the command cannot run, or nothing when it can.
- `intent(snapshot, count)` returns an application intent for the session, a UI intent for React, or
  a terminal intent. It performs no I/O. `count` is the number typed before the key, or `undefined`
  when none was typed. Only the commands marked `counted` use it: `selectNext`, `selectPrevious`,
  and `selectLast`, on the list layer. A key that is not a counted command cancels a pending count,
  except the keys a command lists in `keysDuringCount`, such as Ctrl+C on `quit`. Only
  `terminal.tsx` handles terminal intents, so the session never owns the process lifetime.
- Keymap layers, help, and availability come from the catalog. Key handlers read the latest
  snapshot, not one captured at render.
- The session checks preconditions again before it acts. A disabled key is not a safety check.

### Scopes

- The nine scopes are `global`, `list`, `preview`, `help`, `messages`, `confirm`, `input`,
  `command`, and `filter`.
- Each scope has one keymap layer. The layer carries a priority, and a higher priority wins a key
  that a lower one also binds. From highest to lowest: overlay or dialog (`help`, `messages`,
  `confirm`), input line (`input`, `command`, `filter`), detail pane (`preview`), list (`list`), and
  global (`global`). Scopes at one level are never active together, so `escape` in one modal never
  runs another's command.
- A higher level shadows the same key in a lower one on purpose.
- `list` and `preview` bindings follow focus. `global` bindings stay active under help, messages,
  and the confirmation, and are off while an input line is open.
- An open modal blocks the `list` and `preview` commands beneath it. On close, focus returns to the
  previous target only if it is still mounted.
- A conflict is two commands on one parsed key stroke in one scope. `shift+g` and `Shift+G` are one
  stroke.

### Remaps

- Config maps a command id to a list of keys. The list replaces the defaults, and `[]` disables the
  command's keys.
- Unknown ids, invalid keys, and one key bound to two commands in one scope stop startup.
- Quit signals such as SIGINT still stop Mergit when the quit command has no keys.

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
