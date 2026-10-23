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
  as clearing the line, share a `configId`. They show as one help row when their effective keys
  agree; otherwise help shows each scope's keys.
- `disabledReason(snapshot)` returns why the command cannot run, or nothing when it can.
- `intent(snapshot, count)` returns an application intent for the session, a UI intent for React, or
  a terminal intent. It performs no I/O. `count` is the number typed before the key, or `undefined`
  when none was typed. Only the commands marked `counted` use it: `selectNext`, `selectPrevious`,
  `selectLast`, `selectFirst`, `centerSelectedRow`, `topSelectedRow`, `bottomSelectedRow`,
  `halfPageDown`, `halfPageUp`, `pageDown`, and `pageUp`, on the list layer. Esc cancels a pending
  count or key sequence. A key that does not finish it cancels it and does not run. Fixed Ctrl+C
  quit bindings run before sequence dispatch. Keys in `keysDuringCount` also work during a count.
  Only `terminal.tsx` handles terminal intents, so the session never owns the process lifetime.
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
- A command with an `overlayMove`, such as `selectNext` or `halfPageDown`, also binds its keys in
  the `help` and `messages` layers, where they scroll the open overlay. A remap of the list command
  moves both. The conflict rule below covers these keys in those layers too.
- A conflict is two commands on one parsed key stroke in one scope. `shift+g` and `Shift+G` are one
  stroke. A single key that is the first stroke of another command's sequence in the same scope is
  also a conflict, such as `g` beside `gg`.

### Remaps

- `src/config/config.ts` loads remaps once. Its private notation and remap files parse Vim notation
  and resolve conflicts against the catalog. Config maps public config ids to lists of keys. A list
  replaces the defaults; `[]` removes keys except the fixed Ctrl+C quit binding.
- The shared ids `clearLine` and `closeEmptyLine` remap all three input lines together. Their
  internal command ids and the fixed input-line quit commands are not public config ids.
- Ctrl+C is a key event in raw mode, not a SIGINT signal. It always quits, including in input lines
  and during a pending count or key sequence. Config cannot remove it, assign it to another command,
  or use it in a longer sequence. `quit` may list `<C-c>` by itself.
- Escape cancels pending sequences, so a config key may use it only alone or as the first stroke.
- Unknown ids and invalid notation stop startup. List and global keys starting with `1` through `9`
  also stop startup because those digits start a list count.
- Two user keys that are equal after parsing, or one that is a prefix of another, stop startup
  within a layer, even within one id. Conflicts include the movement copies in help and messages.
- A user key beats a conflicting default in that layer. Mergit removes the default there and shows a
  notice naming the keys, ids, and layers. Other layers keep their defaults.
- `cancelInput`, `closeCommandLine`, `closeDetail`, `closeHelp`, `closeMessages`, `cancelOpen`, and
  `closeFilters` must each keep a portable binding after conflict resolution. A binding with Ctrl+I,
  Ctrl+M, Ctrl+H, or Ctrl+J at any stroke does not count: those controls require Kitty keyboard
  reporting. Removing the last portable binding stops startup even if a protocol-dependent binding
  remains, so close and cancel actions stay reachable on legacy terminals.
- Control-letter meanings remain distinct from their legacy equivalents. Required commands may keep
  protocol-dependent controls alongside a portable alternative. Non-required commands need no
  portable alternative. This rule does not depend on the current terminal's reporting protocol.
- Aliases add command-line names to configurable list and global commands without removing built-in
  names. Names are case-sensitive, nonempty, and contain no whitespace. A name owned by another
  command stops startup; repeating a name for the same command is allowed. An id does not become a
  command-line name automatically. Other scopes cannot take aliases.

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
