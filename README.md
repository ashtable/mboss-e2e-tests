# mboss-e2e-tests

The top of mBoss's test pyramid. It brings up the whole cloud stack — the
Next.js app, the private API, the DBOS worker, Postgres and two fixtures
standing in for the mail provider and the Entra tenant — and drives it through
a real browser, asserting on what those services actually did. It also drives
the MCP server's shipped bundle as real child processes over stdio, which is
where packaging and cross-process behaviour become visible.

Three suites live here, and they are separate on purpose:

- **`npm test`** — vitest over the helpers and the two fixtures. No containers,
  no submodules, no browsers. Runs on a bare checkout.
- **`npm run e2e:cloud`** — Playwright over the compose stack. Needs
  `npm run stack:up` first.
- **`npm run e2e:mcp`** — Playwright over the MCP bundle. No browser; needs
  `npm run mcp:build` first, and Docker, because one of its specs scaffolds a
  whole app and brings up that app's own Postgres.

## Run

```
npm ci
npm run lint          # tsc --noEmit && eslint . && prettier --check .
npm test              # the hermetic half

npx playwright install chromium
npm run stack:up      # docker compose up --build --wait
npm run e2e:cloud
npm run stack:down

npm run mcp:build     # npm ci + esbuild inside mboss-mcp-server
npm run e2e:mcp
```

`stack:up` builds three service images from the nested submodules, so the first
run takes a few minutes. `--wait` is itself an assertion: it exits non-zero
unless every service that declares a healthcheck reaches healthy.

`mcp:build` runs `npm ci` and the esbuild bundle inside `mboss-mcp-server/`,
leaving `dist/server.js` and `dist/VERSION` — the single file a project vendors
and the one line the extension compares against.

The suite has no `webServer` block. A runner that started a bare Next server
would be testing something the product never runs as. Global setup starts
nothing either, and checks only what the run is about: for `cloud` it probes
the three addresses and names `npm run stack:up` when one is not answering,
then warms `/` and `/admin`, because a cold container's first request to a
route loads its bundle and opens its connections, which can outlast an action
timeout; for `mcp` it checks the bundle is built and names `npm run mcp:build`
when it is not. Which projects a run covers is read off `--project` on the
command line — `FullConfig.projects` is the declared list, not the filtered
one, so reading it would make `e2e:mcp` demand a mailsink no MCP spec talks to.

## Scripts

| Script               | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `npm test`           | vitest — helpers and fixtures, no containers     |
| `npm run e2e:cloud`  | The `cloud` project against the compose stack    |
| `npm run e2e:mcp`    | The `mcp` project against the built bundle       |
| `npm run e2e:ext`    | The `extension` project — declared, no specs yet |
| `npm run mcp:build`  | Build the MCP bundle from the nested checkout    |
| `npm run stack:up`   | `docker compose up --build --wait`               |
| `npm run stack:down` | `docker compose down -v`                         |
| `npm run stack:logs` | Follow every service's log                       |
| `npm run lint`       | `tsc --noEmit`, ESLint, a Prettier check         |
| `npm run format`     | Rewrite with Prettier                            |

CI runs three jobs. `lint-unit` checks out without submodules and runs
`npm ci && npm run lint && npm test` — which is the only place the hermetic
claim is actually tested. `cloud` checks out `submodules: recursive`, brings
the stack up and runs the suite, uploading traces, videos and compose logs on
failure. `mcp` also checks out `submodules: recursive` — for a different
reason, since `mboss-mcp-server` nests core and skills and the bundle inlines
core's source — builds the bundle and runs the MCP specs; it installs no
browser, because nothing in that project takes a `page`, but it does need
Docker, because `generated-app-durability` brings up the app it scaffolded. It
also does a full `npm install` inside that app, which is the slow part of the
job and is unavoidable: the app has to actually run. There is still no
`extension` job: `playwright test --project=extension` against an empty project
exits 1 with "No tests found", so a job for it would be permanently red until
its specs arrive.

## The stack

`docker-compose.e2e.yml`, project name `mboss-e2e`. Every value is written
inline; there is no `env_file:` anywhere, because all three service repos
gitignore their own `.env` and a fixture that only boots on a machine with
hand-populated secrets is not a fixture.

| Service     | Port                 | What it is                         |
| ----------- | -------------------- | ---------------------------------- |
| `web`       | `3100`               | `mboss-web`, production build      |
| `api`       | —                    | `mboss-nodejs-api`, internal only  |
| `dbos`      | —                    | `mboss-nodejs-dbos`, binds no port |
| `postgres`  | `5433`               | `postgres:17` on tmpfs, no volume  |
| `mailsink`  | `8025`               | the fake Twilio Email API          |
| `oidc-mock` | `8443` HTTPS, `8081` | one Entra tenant                   |

**Every published port differs from the root dev stack's**, so
`docker compose up` and `npm run stack:up` can run side by side. A harness you
have to tear the dev stack down to run is a harness people stop running.

There is a third set. `generated-app-durability` scaffolds an app and runs it
on this machine, so it needs a Postgres, an HTTP port and a mail sink of its
own: `5434`, `3200` and `8125`, chosen to miss both the dev stack's
`5432`/`3000` and this one's `5433`/`3100`. The scaffold emits `5432`, and
compose concatenates `ports` when it merges — so the spec writes a
`docker-compose.override.yml` beside it using `!override`, which replaces the
list instead of adding to it. The same file a person would write, for the same
reason.

`dbos` deliberately has no healthcheck — it binds no port, and enqueues are
durable, so a worker still booting only delays an email into a window the
specs' bounded polls absorb. It also deliberately has no `restart:` policy:
`broadcast-crash-resume` kills the container and starts it again itself, and a
restart policy would race it.

Postgres is on tmpfs with no volume. A suite that truncates before every spec
file has nothing worth keeping between runs, and a named volume would only be a
way to inherit yesterday's rows.

## The two fixtures

Both are plain `node:http`/`node:https` plus `node:crypto`, zero runtime
dependencies, written as `.ts` and run directly (`node server.ts` — Node 24.18
strips types natively). No `npm ci` layer in either Dockerfile, no second
lockfile, and the bytes the container serves are the bytes vitest imports.

### `fixtures/mailsink` — the Twilio Email API, and an inbox

`/v1/*` is the provider's surface: `POST /v1/Emails` takes a send under Basic
auth and answers `202 {operationId, operationLocation}`;
`GET /v1/Emails?operationId=` is what the worker's delivery-status reader polls.
A recipient whose local part starts with `bounce-` is reported `UNDELIVERED`;
everyone else `DELIVERED`. That prefix is the fixture's rule, not the product's
— nothing in mBoss knows about it — and it is what lets a bounce be asked for
rather than waited on.

Everything else is the harness talking to its own fixture and needs no
credentials: `GET /messages` reads the captured mail, `DELETE /messages` empties
it, and `POST /_test/delay` makes every later send take a given number of
milliseconds. That last one exists for exactly one spec:
`broadcast-crash-resume` has to kill the worker _mid_-fan-out, and forty
recipients over loopback can finish before a `docker compose kill` lands.
Slowing the fixture is a bounded, explicit knob; every wait in the specs
themselves is still a poll on observable state.

A send missing `to[0].address` or `content.subject` is refused with a 400. A
wire regression in the mailer has to go red at the send rather than be captured
silently.

It runs twice over. The cloud stack runs it as a compose service;
`generated-app-durability` runs the same file as a host process beside the app
it is watching, on the credentials that app's own `.env` carries — so the Basic
auth the sink checks is a real check on what the scaffold minted. Every read in
`helpers/mail.ts` takes the sink to read, defaulting to the compose one.

### `fixtures/oidc-mock` — one Entra tenant

Discovery, JWKS, `authorize`, `token` and `userinfo` for a single tenant, plus
a control surface (`POST /_test/identity`, `POST /_test/reset`) that says who
signs in next. The identity is state a spec sets explicitly rather than
something it hopes for; the suite runs `workers: 1`, so exactly one test is
signing in at a time.

**It serves HTTPS, and that is not decoration.** `@auth/core` re-runs OIDC
discovery after the token exchange for `microsoft-entra-id`, reading the real
tenant out of the id_token's `tid` — and that one call is the only discovery in
the library that does not pass `allowInsecureRequests`. `oauth4webapi` has no
localhost exemption, so an `http://` issuer fails the exchange with
`OAUTH_HTTP_REQUEST_FORBIDDEN`, which surfaces as an opaque
`/api/auth/error?error=Configuration`. Anyone tempted to simplify this back to
plain HTTP will get exactly that and no explanation. The certificate in
`tls/` is self-signed with `CA:TRUE` so `web` can trust it as a root via
`NODE_EXTRA_CA_CERTS`; the `openssl` line that produced it is in
`fixtures/oidc-mock/README.md`.

Two other things the mock has to get right, both proved in
`test/oidc-mock.test.ts`: the id_token carries **no `nonce` claim** even when
the authorize request sent one (Auth.js uses `checks: ['pkce']`, so
`expectNoNonce` is what reaches the verifier, and an echoed nonce throws), and
`state` is echoed only when present, because Auth.js sends none.

## Nothing here mints anything

The suite holds no `LINK_KEYS` value and never imports `mintLink`. Every
manage, unsubscribe and form link a spec follows was written by an app into an
email the mailsink captured, and read back out of the HTML by
`helpers/links.ts`. A harness that mints its own links stops testing the
minting. The `/f/<token>` link the durability spec follows across a crash was
signed with a ring the scaffold minted and this suite has never seen.

The same goes for sessions. There is no cookie minter and no `next-auth`
dependency: `helpers/auth.ts` sets an identity on the mock and drives the real
three-redirect round trip, so the tenant check, the domain check and the
session cookie are all tested rather than assumed.

## The MCP bundle

`tests/mcp/` drives the artifact `mboss-mcp-server` ships: one 18MB esbuild
bundle with no `node_modules` beside it, vendored into a project as
`.mboss/mcp/server.js` and started by the project's own Node. Nothing here
imports that repo's TypeScript — the nested checkout is a build context, the
same as the three service repos. `helpers/mcp.ts` spawns the file and speaks
the protocol to it with the official SDK's client.

The fixtures under `fixtures/projects/` hold inputs only — no `node_modules`
and nothing built — and they are used two ways. `helpers/project.ts` copies
`minimal` into a scratch directory, which is what makes twenty-five rounds of a
race a directory read rather than an install; `generated-app-durability`
scaffolds a fresh project and copies `crash-fixture`'s document and handlers
into it, which is what keeps the scaffold itself under test.

`minimal` installs nothing on purpose, so the type-check gate `project_build`
runs really runs and the only module resolutions it cannot make are
`@dbos-inc/dbos-sdk` and `vitest`; `mcp-bundle` asserts those two are the _only_
complaints, which is what keeps a real type error from hiding behind them. The
scaffolded project is fully installed, and its `project_build` has to come back
clean.

**`mcp-bundle.spec.ts`** — create → dry-run → apply → get → rename → scaffold →
build over stdio, asserting the proposal file on disk and its status flipping
to `applied`, the revision reaching 2 then 3, the one edge endpoint that moved
with a renamed node, the scaffolded handler's signature typed from the block's
own `in`/`out`, and the generated workflow carrying its DO-NOT-EDIT header and
importing the handler. Then all five resources, and every structured failure
code over the wire — `WORKFLOW_NOT_FOUND`, `NO_CURRENT_WORKFLOW`,
`REVISION_CONFLICT`, `VALIDATION_FAILED`, `PROPOSAL_NOT_FOUND`,
`PROPOSAL_STALE`, `NOT_AN_MBOSS_PROJECT`.

**`lock-contention.spec.ts`** — two server processes racing one apply from the
same `baseRevision`, twenty-five rounds. Each round: exactly one winner, the
loser refused with `REVISION_CONFLICT` rather than hung or applied, the file
still parsing, the revision advanced exactly once, the winner's whole document
on disk rather than a mixture of both, and no `.mboss/.lock` left behind. Any
single round fails the spec — a racy lock fails probabilistically, so the
repetition is the assertion. Plus the two lock cases either side of it: a lock
older than ten seconds is presumed abandoned and taken over, and a fresh one is
waited behind until it is released.

**`generated-app-durability.spec.ts`** — the promise, tested as one system, and
the only place a generated app has ever run. The scaffold writes a project (the
bundle travelling into it at `.mboss/mcp/server.js`, the path a real one is
vendored to); the checked-in `crash_fixture` document is applied through that
copy; `project_build` regenerates and type-checks it against the real installed
SDK; its own compose Postgres comes up, its migration runs, and the app starts
as a **host process**. Then: an event through `POST /events/:topic` under the
secret the scaffold minted, a form email caught by a sink running beside it, the
`/f/<token>` link read out of that mail — and the process killed with `SIGKILL`
while the run sits parked on the form. After a restart the same link still
opens, the form submits, and the run reaches `SUCCESS`.

What it then asserts is the point: every step that had finished before the kill
carries the finish time it had then, so recovery read its checkpoints back
rather than calling the handlers again; the transaction has exactly one row; the
claimant got exactly one email; and the run's recovery count went up, which is
what makes this a crash test rather than a long way of running a workflow. It
was watched failing with the kill taken out — everything else still passed and
the count stayed at one. Finally `project_debug`, driven through the bundle,
answers against a schema DBOS itself created — the first and only check on the
column names that tool maps by hand.

A second test builds the emitted `Dockerfile`. A packaging assertion only; the
image is never run, because what the durability path needs is a process this
spec can kill.

## Scaffolding, across a process boundary

`scaffolder/scaffold-project.mjs` is how the durability spec gets a real
project. Nothing in this repository may _import_ `mboss-core` — the nested
checkouts are build contexts, and `lint-unit` runs `tsc` on a tree that has none
of them — so the scaffold is reached by running it instead. Plain Node strips
the types out of core's TypeScript for free but will not follow a `.js`
specifier to a `.ts` file, so the one thing that script adds is that mapping. It
is a `.mjs` on purpose: being untyped keeps it honest about being a script
rather than looking like a module `tsc` checks, which it is not.

Checking in a snapshot of the scaffold's output would have been simpler and
would have stopped testing the scaffold on the day it changed.

## What each spec proves

Nine files in `tests/cloud/`. Each opens with `test.beforeAll(resetStack)` —
truncate `public`, empty the sink, reset the mock — and uses run-scoped
addresses, so two runs against a stack nobody truncated in between still cannot
collide.

**`admin-auth.spec.ts`** — The sign-in card verbatim, blueprint-framed with its
four registration marks like the public screens it is reached from; no site
nav; a signed-out console request lands on `/admin`, and `/admin` does not
redirect to itself. Then the real Entra round trip: an admin from the tenant
reaches the console under their own address; an account from another tenant is
refused with `AccessDenied` and holds no session afterwards; so is
`intruder@evil-autoretryai.com`, which exists to defeat a domain check that is
not anchored; and signing out closes the console behind you.

**`waitlist-journey.spec.ts`** — A browser signup reaches Postgres through the
web app and the private API, comes back as the success card, and produces a
confirmation email whose `/u/<token>` link the spec follows to pause, resume
and unsubscribe — each asserted on the chip the subscriber sees _and_ the row
the API wrote. Signing up again brings them back subscribed without a second
email. Plus: no queue position on the card; served with JavaScript off, the
form refuses to submit itself rather than dropping the signup into a native
GET; an unusable manage link renders the uniform error state and names nobody;
the manage card is deliberately not blueprint-framed; the one-click endpoint
answers a bad token without a 5xx and without rendering a page.

**`confirmation-resend.spec.ts`** — The 24-hour window from both sides,
anchored on `dbos.workflow_status`: the first `confirm:<id>:0` reaching a
terminal SUCCESS, a repeat signup adding no second workflow, and — after
`UPDATE ... now() - interval '25 hours'` — a second workflow under its own
sendKey producing a second email with a different token. Time is rewritten as
data; no clock is mocked anywhere.

**`broadcast-journey.spec.ts`** — Twelve seeded subscribers across all four
statuses plus one who joins through the front door, so every count is a number
the spec chose. The chips carry them; the compose page names the audience; a
test send reaches the admin carrying neither a manage link nor unsubscribe
headers; the real send reaches all eight and nobody else. Every message carries
its own `/u/` token, its `List-Unsubscribe` names the same token as its manage
link, and `List-Unsubscribe-Post` is the exact RFC 8058 literal. The broadcast
records the admin who pressed the button, and the console's derived note moves
from `no updates yet` to `1 update sent`.

**`broadcast-crash-resume.spec.ts`** — Forty subscribers, the worker SIGKILLed
mid-fan-out and started again, and the broadcast finishes anyway. Forty
delivery rows, all terminal; every address mailed at least once; the sink
holding **at least 40 and at most 41** — the upper bound is the accepted
duplicate window written down as a number, because the per-recipient send step
is deliberately not retried.

**`email-events.spec.ts`** — The bounce path end to end. Twilio Email has no
webhook, so the only way a bounce is heard about is the `bounce-scan` workflow
polling the provider's operation records. One recipient the mailsink refuses;
the scan reaching SUCCESS; the row `bounced` with its manage links revoked; the
console note reading `delivery bounced`; the next broadcast carrying no
delivery row for the address at all. Then the far side: that address signs up
again, comes back subscribed with `tokenVersion` untouched, and the
confirmation it gets carries a link that verifies.

**`landing.spec.ts`** — The landing copy verbatim; four registration marks per
blueprint box; no pricing, testimonial, comparison or footer nav; `/docs` and
`/changelog` are real pages.

**`design-tokens.spec.ts`** — Every token the page paints with resolves to the
design's value in a real engine; a dark-scheme preference changes nothing; the
wireframe override squares every component; a registration mark hangs outside
its box unclipped.

**`responsive.spec.ts`** — Neither the landing page, the sign-in card nor the
manage page scrolls sideways at 390px or 320px; the narrow nav wraps rather
than hiding the repo URL; the join box takes a signup from the keyboard alone
and paints the accent focus ring; nothing animates.

## Debt, written down

**Three single-process holdovers.** `landing`, `design-tokens` and `responsive`
are browser-to-web only. Nothing they assert needs the API, the worker or
Postgres, so by this harness's own admission bar they belong in `mboss-web`'s
own suite. Moving them needs an `mboss-web` commit, and deleting them would
lose real coverage nothing replaces — so they stay here, named, until someone
moves them.

**The `extension` project is declared and empty.** It exists so that surface
has a home to land in rather than a config change to remember. `playwright test
--list` is content with an empty `testDir`; running one is not, which is why it
has no CI job yet.

**The `minimal` fixture project installs nothing.** `project_build`'s type-check
therefore cannot resolve `@dbos-inc/dbos-sdk` or `vitest`, and `mcp-bundle`
asserts around exactly those two by name. That is deliberate — it keeps
twenty-five rounds of `lock-contention` copying a directory rather than
installing one — and `generated-app-durability` covers the other side: its
project is fully installed, so its `project_build` has to come back with
`tscErrors` empty.

**`https://` on the unsubscribe URL is not asserted.** This harness's
`SITE_URL` is `http://localhost:3100` by design. Scheme-on-the-wire belongs to
a run against a real mailbox.

**The full design-token ramp is not asserted.** Tailwind emits only the theme
variables its generated CSS references, so a token nothing uses yet never
reaches the browser. That the whole ramp is declared is `mboss-web`'s unit test
to make; this suite checks the values of what actually arrives.
