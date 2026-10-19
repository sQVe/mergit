---
'mergit': patch
---

The app is now called Mergit. Its state and cache now live in `~/.local/state/mergit` and
`~/.cache/mergit`. To keep your data, move `~/.local/state/zeta` and `~/.cache/zeta` there. If you
set `XDG_STATE_HOME` or `XDG_CACHE_HOME`, move the `zeta` folder in each to `mergit` instead.
