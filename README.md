# mboss-e2e-tests

The browser-driven suite for mBoss. It brings up the whole cloud stack — the
Next.js app, the private API, the DBOS worker, Postgres and two fixtures
standing in for the mail provider and the Entra tenant — and drives it through
a real browser, asserting on what those services actually did.

Two suites live here, and they are separate on purpose:

- **`npm test`** — vitest over the helpers and the two fixtures. No containers,
  no submodules, no browsers. Runs on a bare checkout.
- **`npm run e2e:cloud`** — Playwright over the compose stack. Needs
  `npm run stack:up` first.

## Run

```
npm ci
npm run lint          # tsc --noEmit && eslint . && prettier --check .
npm test              # the hermetic half

npx playwright install chromium
npm run stack:up      # docker compose up --build --wait
npm run e2e:cloud
npm run stack:down
```

`stack:up` builds three service images from the nested submodules, so the first
run takes a few minutes. `--wait` is itself an assertion: it exits non-zero
unless every service that declares a healthcheck reaches healthy.

The suite has no `webServer` block. A runner that started a bare Next server
would be testing something the product never runs as. Global setup does not
start the stack either — it probes the three addresses and names
`npm run stack:up` when one is not answering, then warms `/` and `/admin`,
because a cold container's first request to a route loads its bundle and opens
its connections, which can outlast an action timeout. A spec against a stack
that is down fails as a connection refusal, which is the honest failure.

## Scripts

| Script               | What it does                                     |
| -------------------- | ------------------------------------------------ |
| `npm test`           | vitest — helpers and fixtures, no containers     |
| `npm run e2e:cloud`  | The `cloud` project against the compose stack    |
| `npm run e2e:mcp`    | The `mcp` project — declared, no specs yet       |
| `npm run e2e:ext`    | The `extension` project — declared, no specs yet |
| `npm run stack:up`   | `docker compose up --build --wait`               |
| `npm run stack:down` | `docker compose down -v`                         |
| `npm run stack:logs` | Follow every service's log                       |
| `npm run lint`       | `tsc --noEmit`, ESLint, a Prettier check         |
| `npm run format`     | Rewrite with Prettier                            |

CI runs two jobs. `lint-unit` checks out without submodules and runs
`npm ci && npm run lint && npm test` — which is the only place the hermetic
claim is actually tested. `cloud` checks out `submodules: recursive`, brings
the stack up and runs the suite, uploading traces, videos and compose logs on
failure. There is no `mcp` or `extension` job: `playwright test --project=mcp`
against an empty project exits 1 with "No tests found", so a job for either
would be permanently red until its specs arrive.

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
manage and unsubscribe link a spec follows was written by the worker into an
email the mailsink captured, and read back out of the HTML by
`helpers/links.ts`. A harness that mints its own links stops testing the
minting.

The same goes for sessions. There is no cookie minter and no `next-auth`
dependency: `helpers/auth.ts` sets an identity on the mock and drives the real
three-redirect round trip, so the tenant check, the domain check and the
session cookie are all tested rather than assumed.

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

**The `mcp` and `extension` projects are declared and empty.** They exist so
the two surfaces have a home to land in rather than a config change to
remember. `playwright test --list` is content with an empty `testDir`; running
one is not, which is why neither has a CI job yet.

**`https://` on the unsubscribe URL is not asserted.** This harness's
`SITE_URL` is `http://localhost:3100` by design. Scheme-on-the-wire belongs to
a run against a real mailbox.

**The full design-token ramp is not asserted.** Tailwind emits only the theme
variables its generated CSS references, so a token nothing uses yet never
reaches the browser. That the whole ramp is declared is `mboss-web`'s unit test
to make; this suite checks the values of what actually arrives.
