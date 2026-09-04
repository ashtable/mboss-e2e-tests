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

The handler `answerIt` is here, and typed to match
the block that names it. It used to be deliberately
absent, back when the specs that used this fixture
read the warning its absence produced. They no
longer do, and a graph that can actually run is
worth more than one that cannot: the step has a
function behind it, the function has a signature the
picker can offer, and the whole thing goes from
opening the document to finishing a run without
anything on screen being wrong on purpose.
