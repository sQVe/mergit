---
'mergit': patch
---

Send every GitHub request and browser open to the `GH_HOST` server. When `GH_HOST` is unset or
empty, use the only host `gh` is signed in to, or github.com. Stop reading `gh` output past 4 MiB
per stream, kill the process, and show a size error.
