# ADR 0019: A confirmation prompt is a modal with its own command scope

**Date**: 2026-10-13\
**Status**: Accepted\
**Extends**: [ADR 0006: One command catalog as data](./0006-command-catalog.md)

## Context

Some actions change many threads at once, so Zeta asks before it runs them. The prompt waits for one
key. A stray key must not run a list command or quit while the user decides.

[ADR 0006](./0006-command-catalog.md) gives each command one of four scopes: `global`, `list`,
`preview`, or `modal`. Help is the only modal so far, and it closes on `Esc`. A prompt also cancels
on `Esc`. Both commands in the `modal` scope would bind `Esc` at once, and the catalog rejects one
key bound to two commands in overlapping scopes.

## Decision

A confirmation prompt is a modal whose commands use a fifth scope, `confirmation`.

While a prompt is open, only `confirmation` commands bind. The confirm key runs the action. Every
other key cancels the prompt and does nothing else, global keys included. Help and other modals
cannot open while a prompt is open, so their keys never bind together with the prompt's.

The confirm and cancel commands stay in the catalog with every other command.

## Consequences

### Positive

- A stray key never runs the action, a list command, or quit while the prompt waits.
- Help's `Esc` and the prompt's `Esc` stay separate commands that the overlap check accepts.

### Negative

- Quit keys cancel the prompt first, so quitting from an open prompt takes two presses.
- The UI must know which modal is open to pick the active scope.

## Alternatives considered

### Share the `modal` scope with help

Put confirm and cancel in `modal` and let the UI choose between help and the prompt. Rejected
because two commands in one scope would bind `Esc`, and the catalog's overlap check exists to forbid
that.

### Let global keys work during the prompt

Keep `q` and `?` active, as they are outside modals. Rejected because the prompt guards a bulk
action, and a key that does something else while it waits is easy to press by mistake.
