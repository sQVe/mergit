# ADR 0003: OpenTUI with React bindings as the renderer

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0002: Bun as runtime, package manager, and test runner](./0002-bun-toolchain.md),
[OpenTUI scroll box](https://opentui.com/docs/components/scrollbox/),
[OpenTUI keymap](https://opentui.com/docs/keymap/overview/),
[OpenTUI testing](https://opentui.com/docs/core-concepts/testing/)

## Context

Mergit needs a terminal renderer with scrolling panes, focus, configurable shortcuts, resize
handling, and clean terminal restore on quit.

A prototype with sample data showed all five on OpenTUI with React on Bun. Headless tests covered
the panes, focus, shortcuts, and resize. A pseudo-terminal run covered quit with `q`, Ctrl+C, and
SIGINT.

The two problems the prototype found are in OpenTUI's core, so they apply to every OpenTUI binding.

## Decision

Mergit renders its terminal UI with OpenTUI and its React bindings, on Bun. The prototype needed no
React-specific workarounds.

### Shortcuts

- Shortcuts come from one keymap definition, registered through `@opentui/keymap`. Components do not
  hard-code keys.
- A focused scroll box scrolls on its own keys, outside the keymap. Every scroll box must call
  `preventDefault()` in its `onKeyDown` handler, so the keymap stays the only source of shortcuts.

### Layout

Code that reacts to a scroll box resize listens to the `resize` event of `scrollBox.viewport`. The
scroll box's `onSizeChange` runs before its viewport has the new size.

### Tests

UI tests use OpenTUI's headless test renderer and mock input, and wrap input and renders in React's
`act`.

## Consequences

### Positive

- One React model for state and rendering, with headless tests that press keys and read frames.

### Negative

- OpenTUI is young and changes often. Upgrades need the tests to catch behavior changes.
- Every scroll box needs the key guard. A missing guard lets removed shortcuts keep working.
- React's `act` rules apply to every UI test.

## Alternatives considered

### Ink

Use Ink. Rejected because the earlier library comparison chose OpenTUI over it before any prototype.

### OpenTUI with Solid bindings

Use OpenTUI with Solid bindings. Rejected because the project prefers React, and the core problems
would remain. OpenCode uses this binding, but the prototype did not try it.

### OpenTUI Core API without bindings

Use the OpenTUI Core API without bindings. Rejected because the app would update the list and
preview from state by hand.
