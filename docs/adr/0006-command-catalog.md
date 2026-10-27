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

- Each command has an id, a label, a scope (one of the ten below), a help section, and default keys.
- Help reads its sections from the catalog, in a fixed order. Copies of one action in several
  scopes, such as clearing an input line or the reader copy of Done, share a config id: the
  `configId`, or the id of a command without one. They show as one help row when their effective
  keys agree; otherwise help shows each scope's keys.
- `disabledReason(snapshot, reader)` returns why the command cannot run, or nothing when it can.
- `intent(snapshot, reader, count)` returns an application intent for the session, a UI intent for
  React, or a terminal intent. It performs no I/O. `reader` is the reader context:
  `{ kind: 'inbox' }` when no thread is focused, or `{ kind: 'reader', row }` with the thread row
  captured at Enter. The UI builds it from its own state at key time, and both functions only read
  it. `count` is the number typed before the key, or `undefined` when none was typed. Only the
  commands marked `counted` use it: `selectNext`, `selectPrevious`, `selectLast`, `selectFirst`,
  `centerSelectedRow`, `topSelectedRow`, `bottomSelectedRow`, `halfPageDown`, `halfPageUp`,
  `pageDown`, and `pageUp`, on the list layer. Esc cancels a pending count or key sequence. A key
  that does not finish it cancels it and does not run. Fixed Ctrl+C quit bindings run before
  sequence dispatch. Keys in `keysDuringCount` also work during a count. Only `terminal.tsx` handles
  terminal intents, so the session never owns the process lifetime.
- Keymap layers, help, and availability come from the catalog. Key handlers read the latest
  snapshot, not one captured at render.
- The session checks preconditions again before it acts. A disabled key is not a safety check.

### Scopes

- The ten scopes are `global`, `list`, `reader`, `help`, `helpSearch`, `messages`, `confirm`,
  `input`, `command`, and `filter`.
- `helpSearch` is active alone while editing help search. It takes precedence over help scrolling
  and global commands, including during input bursts. Its fixed Ctrl+C binding still quits.
- Each scope has one keymap layer. The layer carries a priority, and a higher priority wins a key
  that a lower one also binds. From highest to lowest: overlay or dialog (`help`, `messages`,
  `confirm`), input line (`input`, `command`, `filter`), reader (`reader`), list (`list`), and
  global (`global`). Scopes at one level are never active together, so `escape` in one modal never
  runs another's command.
- A higher level shadows the same key in a lower one on purpose.
- `list` and `reader` bindings follow focus. The reader takes focus on Enter at every terminal
  width, so width only changes the layout, never which scope is active. `global` bindings stay
  active under help, messages, and the confirmation, and are off while an input line is open.
- An open modal blocks the `list` and `reader` commands beneath it. On close, focus returns to the
  previous target only if it is still mounted.
- A command with an `overlayMove`, such as `selectNext` or `halfPageDown`, also binds its keys in
  the `help` and `messages` layers, where they scroll the open overlay. A remap of the list command
  moves both. The conflict rule below covers these keys in those layers too.
- A conflict is two commands on one parsed key stroke in one scope. `shift+g` and `Shift+G` are one
  stroke. A single key that is the first stroke of another command's sequence in the same scope is
  also a conflict, such as `g` beside `gg`.

### Remaps

- Config ids are public API, separate from internal command ids, so catalog changes do not break
  user configuration.
- Ctrl+C remains a fixed quit key in every context, including pending counts and key sequences. Raw
  mode delivers it as a key event rather than SIGINT, so remaps must preserve that exit path.
- A user key beats a conflicting default only in that layer. Other layers keep their defaults so a
  local remap does not remove unrelated bindings.
- Commands marked `mustKeepKey` in the catalog must retain a portable close or cancel binding after
  conflict resolution, so users can leave every context on legacy terminals.
- Control-letter meanings remain distinct from their legacy equivalents. Portability checks do not
  depend on the current terminal's reporting protocol, so a config stays usable across terminals.

The [README configuration reference](../../README.md#configuration) owns the notation, command ids,
alias rules, and startup errors.

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
