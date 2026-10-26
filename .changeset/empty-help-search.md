---
'mergit': patch
---

Backspace on an empty help search returns to help navigation without closing Help. Deleting the last
character keeps the search editor open until the next Backspace. Remap or disable this action with
`closeEmptyHelpSearch`; existing `clearHelpSearch` remaps still take precedence over its default.
