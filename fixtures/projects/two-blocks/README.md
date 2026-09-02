# `two-blocks`

Not a whole project. This is an overlay
`extensionProject()` lays over a freshly scaffolded
one, and it holds the one thing a scaffold does not
write and the Inspector specs need: a workflow with
blocks already on it.

Two of them, wired, because that is the smallest
graph on which "click a block" means anything —
`sermon-helper`'s draft is deliberately empty and
must stay that way, so a spec that has to select
something cannot use it.

The handler `answerIt` is deliberately absent from
`lib/`. A graph whose code behind does not exist yet
is an ordinary state, and core says so with a
warning rather than an error, so its absence costs
these specs nothing.
