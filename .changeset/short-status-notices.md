---
'mergit': patch
---

At 80 columns, the status line no longer overlaps or cuts off its items. A state file that Mergit
cannot read now shows a short reason and the file path as a message, kept in `:messages`, and the
status line shows "state not saved". The GitHub CLI and sign-in notices show in full as a message
when the list is on screen, and the status line keeps a short marker that names `r`.
