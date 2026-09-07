# `failing-step`

Not a whole project. This is an overlay
`extensionProject()` lays over a freshly scaffolded
one, and it holds the one thing a scaffold does not
write and the replay specs need: a workflow with a
step behind it that can be made to fail.

Two blocks, wired: started by hand, then one step.
Nothing else, because everything else would be
something to wait for between the failure and the
mend.

Started with `{ "fail": true }`, the run ends
failed. The refusal is this line, in
`lib/settleIt.ts`:

```ts
if (claim.fail) throw new Error('the ledger refused this claim');
```

That is the line a spec rewrites while the failed
run is still on screen — to

```ts
if (claim.fail) return { note: 'settled the claim anyway' };
```

— before asking for a replay, so the replay runs new
code over an input already recorded. One statement,
one line, and the only line in the file that refuses
anything: an edit made in the middle of a run should
not also be a judgement call about which line to
make it on. `test/failing-step.test.ts` holds the
file to that shape.

The handler is real and runnable either way. On a
claim not marked to fail it settles and the run
finishes, which is what makes the failure a bug in
the code rather than the fixture being broken on
purpose.

Validated as written: the real validator answered
`valid` with no errors and no warnings, and the
document compiles to one `DBOS.runStep` around
`settleIt`. The step takes the default retry
policy — three attempts, a second apart, doubling —
so the run spends a few seconds failing rather than
failing at once. A spec waiting for `failed` should
expect that.
