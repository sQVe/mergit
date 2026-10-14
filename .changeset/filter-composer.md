---
'zeta': minor
---

Press `f` in the list to open the filter composer, a `Filter` box under the chip bar. Type a
`field:value` token, such as `author:@me`, `-repo:hups-co/platform`, `age:>3d`, or `is:pr`, or pick
one from the list with `Up`, `Down`, and `Tab`. Typing also matches field and value loosely, so
`rep plat` suggests `repo:hups-co/platform`. An empty box lists your chips and the most common
values, and selects none until you press `Up` or `Down`. `Enter` adds the token as a chip and
narrows the list. The list does not change while you type. A leading `-` excludes matches. Chips of
`age` and `title` combine with and, so `age:>7d age:<30d` is a range. Chips of other fields combine
with or. Chips show above the list. To edit a chip, move to it, press `Tab`, change the text, and
press `Enter`. `Esc` cancels the edit. `Enter` on a chip removes it. `Esc` closes the composer, and
so does `Backspace` on an empty line. `F` in the list clears all filters. The last line of the box
describes the selected row. `is:new` filters for new activity. An unfinished token such as `author:`
shows no error while you type; `Enter` on a draft that cannot be read shows one.
