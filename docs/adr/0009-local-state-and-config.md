# ADR 0009: Versioned local state and config

**Date**: 2026-10-01\
**Status**: Accepted\
**Related**: [ADR 0006: One command catalog as data](./0006-command-catalog.md),
[ADR 0015: Notifications first, with a batched subject lookup](./0015-notifications-first.md),
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)

## Context

Mergit saves local state between runs: the "new" markers, the chosen grouping, and the record of
threads it marked done. A user config with key remaps and repository locations is planned but not
built yet.

A crash during a write, a corrupt file, or an older Mergit reading a newer file must not destroy
saved data.

In Tau, a parse-once rule still produced four parsers for one value. Each file needs one parser
owner.

Mergit can run as an always-open pane and as a quick check at once, so two processes can write one
state file.

## Decision

Config and local state are versioned JSON files, parsed once at startup by their owning module, with
atomic writes. Each file has one owner, a version, and a write that cannot leave half a file. Two
Mergit processes may write the same state file, and the last write wins.

### Files

- Config lives at `$XDG_CONFIG_HOME/mergit/config.json` and falls back to
  `~/.config/mergit/config.json`. `config.ts` will parse it. Mergit never writes it. Until
  `config.ts` exists, Mergit reads no config file, and the config rules below apply once it does.
- State lives at `$XDG_STATE_HOME/mergit/state.json` and falls back to
  `~/.local/state/mergit/state.json`. `localState/savedState.ts` parses and writes it.
- Each file has a `version` field. Code past the parser receives typed values only.

### Reading

- A missing file means defaults.
- Invalid config stops startup with the path and the reason.
- Invalid state shows a warning. Mergit runs without saved local state and does not write that file
  until the user resets it.
- An older version migrates forward in memory. State is saved in the current version on the next
  write.
- A version newer than Mergit knows stops startup.

### Writing

- Mergit writes state to a unique temporary file beside the target, flushes and closes it, then
  renames it over the target. A failed write keeps the last valid file.
- Writes run one at a time within each process.
- A failed write shows a short-lived message that names what was not saved. Mergit does not mark the
  change as unsaved.
- Two Mergit processes may write one state file. The last write wins, so concurrent processes can
  lose each other's changes.

### Compatibility

- Each format change bumps the version and adds a migration with fixture tests.
- Ask the user before any change that breaks an existing config or state file.

## Consequences

### Positive

- Saved state survives crashes, corrupt files, and older versions.
- Every format change has a version and a tested migration.

### Negative

- Users must add a `version` field to their config.
- Two processes can lose each other's markers, grouping, or done entries, so a thread already marked
  done can show again.
- Invalid state needs a manual reset before Mergit saves state again.

## Alternatives considered

### Unversioned JSON

Use unversioned JSON. Rejected because a reader cannot tell an older format from a newer one.

### Overwrite invalid state

Start with empty state and overwrite a file that fails to parse. Rejected because it silently
destroys saved state.

### A database

Use a database such as SQLite. Rejected because one small file per user needs no query engine.

### One writer per state file

Allow only one Mergit process to write a state file. Rejected because Mergit runs as an always-open
pane and as a quick check at once.

### Locks or merging

Use locks or merging between writers. Deferred because a lost entry costs a marker, the grouping, or
one more done.

### Mark unsaved changes until a write succeeds

Mark a change as unsaved until a later write succeeds. Rejected because a lost entry costs little,
and a lasting marker takes status-line space.

### TOML for config

Use TOML for config. Deferred because it helps long queries in saved views, which are not in the
first version.
