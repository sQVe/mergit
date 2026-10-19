# ADR 0009: Versioned local state and config

**Date**: 2026-10-01\
**Status**: Superseded\
**Superseded by**: [ADR 0018](./0018-local-state-and-config.md)\
**Related**: [ADR 0006: One command catalog as data](./0006-command-catalog.md),
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)

## Context

Mergit saves dismissals between runs and reads a user config with key remaps and repository
locations.

A crash during a write, a corrupt file, or an older Mergit reading a newer file must not destroy
saved data.

In Tau, a parse-once rule still produced four parsers for one value. Each file needs one parser
owner.

Mergit runs as one process per user. No use case needs two sessions writing one state file.

## Decision

Config and local state are versioned JSON files, parsed once at startup by their owning module, with
atomic writes. Each file has one owner, a version, and a write that cannot leave half a file.

### Files

- Config lives at `$XDG_CONFIG_HOME/mergit/config.json` and falls back to
  `~/.config/mergit/config.json`. `config.ts` parses it. Mergit never writes it.
- State lives at `$XDG_STATE_HOME/mergit/state.json` and falls back to
  `~/.local/state/mergit/state.json`. `localState.ts` parses and writes it.
- Each file has a `version` field. Code past the parser receives typed values only.

### Reading

- A missing file means defaults.
- Invalid config stops startup with the path and the reason.
- Invalid state shows a warning. Mergit runs without saved dismissals and does not write that file
  until the user resets it.
- An older version migrates forward in memory. State is saved in the current version on the next
  write.
- A version newer than Mergit knows stops startup.

### Writing

- Mergit writes state to a unique temporary file beside the target, flushes and closes it, then
  renames it over the target. A failed write keeps the last valid file.
- Writes run one at a time. A dismissal takes effect in memory at once and shows as unsaved until a
  write succeeds.
- One Mergit process writes a state file. Concurrent processes can lose each other's dismissals.

### Compatibility

- Each format change bumps the version and adds a migration with fixture tests.
- Ask the user before any change that breaks an existing config or state file.

## Consequences

### Positive

- Saved dismissals survive crashes, corrupt files, and older versions.
- Every format change has a version and a tested migration.

### Negative

- Users must add a `version` field to their config.
- Running two Mergit processes at once can lose dismissals.
- Invalid state needs a manual reset before Mergit saves dismissals again.

## Alternatives considered

### Unversioned JSON

Use unversioned JSON. Rejected because a reader cannot tell an older format from a newer one.

### Overwrite invalid state

Start with empty state and overwrite a file that fails to parse. Rejected because it silently
destroys saved dismissals.

### A database

Use a database such as SQLite. Rejected because one small file per user needs no query engine.

### Several writers with locks or merging

Use locks or merging for several writers. Deferred because no second-session use case exists.
