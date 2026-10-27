---
'mergit': patch
---

Send every GitHub request and browser open to the `GH_HOST` server, or github.com when it is unset
or empty. Stop reading `gh` output past 4 MiB per stream, end the process, and show a size error.
