---
'mergit': minor
---

The list takes more Vim keys, and three keys moved. `g` became `gg`, `z` became `za` (Space still
folds), and `Z` became `zR` to open all groups and `zM` to fold them. New keys: `zo` opens a node
and `zc` folds it. `zz`, `zt`, and `zb` put the selected row in the middle, at the top, or at the
bottom. Ctrl+d and Ctrl+u move half a page, and Ctrl+f and Ctrl+b move a page. Counts work on these
keys, such as `5zz` or `3Ctrl+d`. `gx` opens the selected thread in the browser. `:q` and `:qa`
quit. While a count or key sequence is pending, its keys show at the right of the status line. Esc
cancels it. A key that does not finish it cancels it, does not run, and shows a short notice.
