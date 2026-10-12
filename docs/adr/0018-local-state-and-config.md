# ADR 0018: Local state for two Zeta processes

**Date**: 2026-10-05\
**Status**: Accepted\
**Related**: [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)

## Context

[ADR 0009](./0009-local-state-and-config.md) set the rules for config and state files. It assumed
one Zeta process per user, and saved dismissals, which Zeta no longer has.

Zeta now saves the "new" markers, the chosen grouping, and the record of threads it marked done. See
[ADR 0015](./0015-notifications-first.md).

Zeta can run as an always-open pane and as a quick check at once, so two processes can write one
state file.

## Decision

Two Zeta processes may write the same state file, keeping the file rules of ADR 0009. The last write
wins.

### File rules

- The file rules of ADR 0009 stay: versioned JSON in `config.json` and `state.json`, one parser per
  file, atomic writes, migrations, and a stop on a newer version.
- Where ADR 0009 names dismissals, read saved local state.
- A failed write shows a short-lived message that names what was not saved. Zeta does not mark the
  change as unsaved, as ADR 0009 did.

## Consequences

### Positive

- Saved state keeps ADR 0009's protection against crashes and corrupt files.

### Negative

- Two processes can lose each other's markers, grouping, or done entries, so a thread already marked
  done can show again.

## Alternatives considered

### Keep ADR 0009

Keep ADR 0009. Rejected because it rules out a second writer.

### Locks or merging

Use locks or merging between writers. Deferred because a lost entry costs a marker, the grouping, or
one more done.

### Mark unsaved changes until a write succeeds

Mark a change as unsaved until a later write succeeds, as ADR 0009 did. Rejected because a lost
entry costs little, and a lasting marker takes status-line space.

### TOML for config

Use TOML for config. Deferred because it helps long queries in saved views, which are not in the
first version.
