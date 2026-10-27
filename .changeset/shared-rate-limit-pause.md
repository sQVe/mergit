---
'mergit': patch
---

A rate limit hit while looking up PR and issue state now pauses refresh too. Mergit sends no feed or
lookup request until the reset time, and a manual refresh waits as well.
