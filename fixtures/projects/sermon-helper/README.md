# `sermon-helper`

Not a whole project. This is the overlay
`extensionProject()` lays over a freshly scaffolded
one, and it holds only the two things a scaffold
does not write and the extension specs need:

- `lib/types.ts` — the eleven type names every block
  in the fake agent's spec is typed against.
- `.mboss/workflows/sermon_helper.workflow.json` —
  an empty draft at revision 1.

The draft is what makes the preview visible. A
proposal is drawn on the canvas showing the workflow
it names, and the canvas is an editor for a file, so
a proposal for a workflow with no file on disk has
nowhere to appear. Starting from an empty draft is
also the flow the design describes: create a
workflow, look at the empty graph, ask the agent to
fill it in, and watch the preview arrive over it.

The agent's dry run is made against `revision 1`, so
this file must stay empty and at that revision. Give
it nodes and the run comes back as a conflict; take
the file away and the counts the preview banner
names stop being a pure addition.
