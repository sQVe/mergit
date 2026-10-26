# Mergit

Mergit is a terminal UI for GitHub work that needs action, such as review requests, requested
changes, failed checks, and conflicted pull requests.

<!-- prettier-ignore -->
> [!IMPORTANT]
> Mergit is in early development. Run `bun run start` to open it; it does not show GitHub work yet.

## Configuration

Mergit reads `$XDG_CONFIG_HOME/mergit/config.json`. If `XDG_CONFIG_HOME` is unset or empty, it uses
`$HOME/.config/mergit/config.json`. If both variables are unset or empty, or the selected file does
not exist, Mergit uses defaults. Mergit never writes this file.

The file must be a JSON object with `"version": 1`. The optional `keys` and `aliases` objects map
public config ids to arrays of strings. No other top-level fields are accepted.

```json
{
  "version": 1,
  "keys": {
    "refresh": ["R"],
    "clearLine": ["<C-u>"],
    "quit": []
  },
  "aliases": {
    "refresh": ["reload"],
    "showMessages": ["log"]
  }
}
```

A `keys` entry replaces that id's default keys. An omitted id keeps its defaults, subject to the
conflict rules below. `[]` removes its keys, except that `quit` always keeps `<C-c>`. Some close and
cancel commands must keep a key.

### Key notation

Keys use Vim notation. Plain characters are key strokes: `j` is one stroke, `gg` is two, `G` is
Shift+G, and `zR` is `z` followed by Shift+R. Join strokes without spaces.

These are all accepted bracket names. Names inside brackets are case-insensitive.

| Name                                  | Key                   |
| ------------------------------------- | --------------------- |
| `<CR>`, `<Enter>`, `<Return>`         | Enter                 |
| `<Esc>`                               | Escape                |
| `<Space>`                             | Space                 |
| `<Tab>`                               | Tab                   |
| `<S-Tab>`                             | Shift+Tab             |
| `<BS>`                                | Backspace             |
| `<Up>`, `<Down>`, `<Left>`, `<Right>` | Arrow keys            |
| `<lt>`                                | Literal `<`           |
| `<C-a>` through `<C-z>`               | Ctrl+A through Ctrl+Z |

Use bracket names, not `enter`, `escape`, or `ctrl+x`. Sequences whose letters spell a built-in key
name are rejected when the keymap would read them as a different binding. For example, `enter`
cannot mean five letter strokes; use `<CR>` for Enter. A sequence such as `esc` is three letter
strokes, not Escape. Empty strings, literal whitespace, an unclosed `<`, unknown bracket names, and
keys the keymap cannot read are invalid. Write `<Space>` for a space and `<lt>` for `<`. Escape
cancels a pending sequence, so `<Esc>` is allowed only alone or as the first stroke.

`<C-i>`, `<C-m>`, `<C-h>`, and `<C-j>` require Kitty keyboard reporting. Legacy terminals report
Tab, Enter, Backspace, and Linefeed instead. These control-letter forms remain accepted and distinct
from those keys; Mergit does not normalize them.

### Public config ids and defaults

These are all v1 ids accepted in `keys`. Defaults use the notation above. `[]` means no default key.
The labels come from the command catalog; `confirmOpen` and `cancelOpen` are hidden from help. Only
rows marked "Yes" accept `aliases`.

| Id                         | Default keys      | Help label                            | Aliases |
| -------------------------- | ----------------- | ------------------------------------- | ------- |
| `quit`                     | `q`, `<C-c>`      | Quit                                  | Yes     |
| `help`                     | `?`               | Toggle help                           | Yes     |
| `selectNext`               | `j`, `<Down>`     | Select next row                       | Yes     |
| `selectPrevious`           | `k`, `<Up>`       | Select previous row                   | Yes     |
| `selectFirst`              | `gg`              | Select first row                      | Yes     |
| `selectLast`               | `G`               | Select last row                       | Yes     |
| `selectNextGroup`          | `J`               | Select next group                     | Yes     |
| `selectPreviousGroup`      | `K`               | Select previous group                 | Yes     |
| `toggleFold`               | `za`, `<Space>`   | Fold or unfold node                   | Yes     |
| `openFold`                 | `zo`              | Open fold                             | Yes     |
| `closeFold`                | `zc`              | Close fold                            | Yes     |
| `openAllFolds`             | `zR`              | Open all folds                        | Yes     |
| `closeAllFolds`            | `zM`              | Close all folds                       | Yes     |
| `centerSelectedRow`        | `zz`              | Center the selected row               | Yes     |
| `topSelectedRow`           | `zt`              | Put the selected row at the top       | Yes     |
| `bottomSelectedRow`        | `zb`              | Put the selected row at the bottom    | Yes     |
| `halfPageDown`             | `<C-d>`           | Half page down                        | Yes     |
| `halfPageUp`               | `<C-u>`           | Half page up                          | Yes     |
| `pageDown`                 | `<C-f>`           | Page down                             | Yes     |
| `pageUp`                   | `<C-b>`           | Page up                               | Yes     |
| `activateRow`              | `<CR>`            | Fold group or open thread detail      | Yes     |
| `cycleGrouping`            | `s`               | Cycle grouping                        | Yes     |
| `refresh`                  | `r`               | Refresh                               | Yes     |
| `markDone`                 | `d`               | Mark done                             | Yes     |
| `openInBrowser`            | `o`, `gx`         | Open in browser                       | Yes     |
| `undoDone`                 | `u`               | Undo the last done                    | Yes     |
| `openSearch`               | `/`               | Search the list                       | Yes     |
| `clearSearch`              | `<Esc>`           | Clear the search                      | Yes     |
| `openCommandLine`          | `:`               | Open the command line                 | Yes     |
| `openFilters`              | `f`               | Open filters                          | Yes     |
| `clearFilters`             | `F`               | Clear all filters                     | Yes     |
| `submitInput`              | `<CR>`            | Keep the search                       | No      |
| `nextSearchCompletion`     | `<Tab>`           | Complete the last word                | No      |
| `previousSearchCompletion` | `<S-Tab>`         | Complete the last word backwards      | No      |
| `cancelInput`              | `<Esc>`           | Restore the previous search           | No      |
| `clearLine`                | `<C-u>`           | Clear an input line                   | No      |
| `closeEmptyLine`           | `<BS>`            | Close an empty input line             | No      |
| `runCommandLine`           | `<CR>`            | Run the command                       | No      |
| `closeCommandLine`         | `<Esc>`           | Close the command line                | No      |
| `closeDetail`              | `<Esc>`           | Close thread detail                   | No      |
| `openHelpSearch`           | `/`               | Search help                           | No      |
| `keepHelpSearch`           | `<Enter>`         | Keep help search                      | No      |
| `cancelHelpSearch`         | `<Esc>`           | Clear and close help search           | No      |
| `clearHelpSearch`          | `<C-u>`           | Clear help search                     | No      |
| `closeEmptyHelpSearch`     | `<BS>`            | Close empty help search               | No      |
| `closeHelp`                | `q`, `<Esc>`      | Close help                            | No      |
| `showMessages`             | `[]`              | Show recent messages                  | Yes     |
| `closeMessages`            | `q`, `<Esc>`      | Close messages                        | No      |
| `confirmOpen`              | `y`, `<CR>`       | Confirm opening the repos             | No      |
| `cancelOpen`               | `n`, `<Esc>`      | Cancel opening the repos              | No      |
| `applyFilterRow`           | `<CR>`            | Apply the filter row                  | No      |
| `takeFilterRow`            | `<Tab>`           | Copy the filter row to the line       | No      |
| `moveFilterUp`             | `<Up>`, `<C-p>`   | Move up a filter row                  | No      |
| `moveFilterDown`           | `<Down>`, `<C-n>` | Move down a filter row                | No      |
| `closeFilters`             | `<Esc>`           | Close the composer or cancel the edit | No      |

`clearLine` and `closeEmptyLine` remap the search, command, and filter input lines together. Their
internal command ids are not config ids. `clearHelpSearch` and `closeEmptyHelpSearch` remap help
search clearing and empty-query closing separately. Closing an empty help query leaves Help open.
The fixed input-line quit commands are not config ids either.

### Command names and aliases

Open the command line with `:` by default. Type a name without the leading colon and press Enter.
The built-in names are `quit`, `q`, `quitall`, and `qa` for `quit`, and `messages` for
`showMessages`. Other ids have no built-in command-line names; an id is not automatically a name.

Aliases add names without removing built-in names. Only configurable list and global commands accept
aliases, as marked in the table. Names are case-sensitive, must not be empty, and must not contain
whitespace. A name cannot belong to two commands, whether it is built-in or user-defined. Repeating
a name for the same command is allowed. `[]` adds no names and removes none.

### Conflicts and startup errors

- Ctrl+C always quits, including in input lines and while a count or key sequence is pending. It
  cannot be removed or reassigned. `<C-c>` alone is allowed only for `quit`; it is invalid anywhere
  in another binding or in a longer sequence, even for `quit`.
- Keys for list and global commands cannot start with digits `1` through `9`. Those digits start a
  count in the list. This restriction does not apply to other scopes or to a leading `0`.
- Conflicts are checked on parsed strokes within each layer. Two user keys that are equal, or one
  that is a prefix of the other, stop startup. This also applies within one id's key list, including
  equivalent spellings such as `<CR>` and `<Enter>`.
- A user key beats a conflicting default key in that layer, including prefix conflicts. The default
  is removed from that layer. Mergit shows a startup notice naming the keys, ids, and affected
  layers. The notice is also available in `:messages`.
- List movement keys for `selectNext`, `selectPrevious`, `selectFirst`, `selectLast`,
  `halfPageDown`, `halfPageUp`, `pageDown`, and `pageUp` also scroll help and messages. Their remaps
  and conflicts apply in those layers too. Replacing a default in one layer leaves other layers
  unchanged.
- Keys in different layers can overlap. The active higher-priority layer wins. Overlay and dialog
  layers rank above input lines, then detail, list, and global layers. Global keys are inactive
  while an input line is open; fixed Ctrl+C bindings still quit.
- `cancelHelpSearch`, `cancelInput`, `closeCommandLine`, `closeDetail`, `closeHelp`,
  `closeMessages`, `cancelOpen`, and `closeFilters` must each keep at least one portable binding
  after remaps and conflict resolution. A portable binding contains no `<C-i>`, `<C-m>`, `<C-h>`, or
  `<C-j>` at any stroke. Those controls may remain alongside a portable alternative, such as
  `<Esc>`. Giving a required command `[]`, or removing its last portable binding, stops startup.
  Non-required commands may use those controls without a portable alternative.

An unreadable file or any invalid config stops startup with the file path and reason. Invalid
configs include malformed JSON, a non-object root, a missing version, any version other than `1`,
unknown top-level fields, and `keys` or `aliases` entries that are not arrays of strings. Unknown
config ids, invalid key notation, forbidden Ctrl+C or digit bindings, user-key conflicts, missing
required close/cancel keys, ineligible alias ids, and invalid or conflicting alias names also stop
startup. Mergit does not silently fall back to defaults for an invalid file.

## Project links

- [Development](./docs/development.md)
- [Documentation](./docs/README.md)
