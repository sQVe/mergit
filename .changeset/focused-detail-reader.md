---
'mergit': minor
---

Press Enter on a thread to focus the detail pane at any terminal width. The pane grows into the main
reading area, and Esc returns to the same row. Press `d`, `o`, `r`, or `u` in the focused pane to
mark that thread done, open it, refresh, or undo its done. When a refresh removes the thread, the
pane stays open with a notice and Done turns off.

A config that maps `markDone`, `openInBrowser`, `refresh`, or `undoDone` to a key that starts with
`<Esc>` now stops at startup while `closeDetail` keeps Escape. Give those commands another key.
