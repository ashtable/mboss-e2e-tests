# `timer-then-answer`

Not a whole project. This is an overlay
`extensionProject()` lays over a freshly scaffolded
one, and it holds the one thing a scaffold does not
write and the cancel-and-resume spec needs: a
workflow that parks long enough to be caught
mid-flight.

Three blocks: started by hand, a sixty-second wait
on the clock, then the same `answerIt` step
`two-blocks` has — handler and types copied from
there unchanged, because the point of this fixture
is the wait and a second kind of step behind it
would only be a second thing that could go wrong.

Sixty seconds is chosen from both ends. Long enough
that a spec can see the run parked, cancel it, and
resume it while the clock is still out; short enough
that waiting the remainder out for the answer stays
inside one test's patience.

The wait carries no type of its own. The value flows
through it, and both edges name `Enquiry` — the
shape core's own timer fixture uses.

Validated as written: the real validator answered
`valid` with no errors and no warnings, and the
generated workflow reads

```ts
async function timerThenAnswerFn(evt: Enquiry): Promise<void> {
  await DBOS.sleep(60000);
  const answerItOut = await DBOS.runStep(...);
}
```

— the sleep in the workflow body, not inside a step.
That is the whole reason the fixture exists. The
wake-up time is written to the database, so the wait
survives the process being killed; a sleep that
lived inside a step would look identical on screen,
degrade to a wall-clock wait, and prove nothing
about resuming.
