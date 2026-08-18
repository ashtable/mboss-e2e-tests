# mboss-e2e-tests

The browser-driven suite for mBoss. It drives the whole cloud stack — the
Next.js app, the private API, the DBOS worker and Postgres — through a real
browser, and it asserts on what those services actually did.

This is an early slice, not the finished harness. See
[What is not here yet](#what-is-not-here-yet).

## Run

The suite has no `webServer` of its own. Bring the stack up from the
superproject first:

```
cd ..                      # the mboss superproject
docker compose up -d       # postgres, dbos, api, web
docker compose ps          # postgres, api and web healthy; dbos running
```

Then, here:

```
npm ci
npx playwright install chromium
npm run test:cloud
```

`E2E_BASE_URL` overrides the target, which defaults to
`http://localhost:3000`.

## Scripts

| Script               | What it does                             |
| -------------------- | ---------------------------------------- |
| `npm run test:cloud` | The `cloud` project against the stack    |
| `npm run lint`       | `tsc --noEmit`, ESLint, a Prettier check |
| `npm run format`     | Rewrite with Prettier                    |

There is no `npm test`. Nothing in this repo runs without containers, and a
script that exits zero without testing anything is worse than a missing one.

CI runs `npm run lint` and nothing else — no browsers, no containers. The
compile is the part that can be proved hermetically, and a spec that does not
compile is a spec that never ran.

## The admin session

`helpers/session.ts` mints an Auth.js session cookie directly, with the same
`AUTH_SECRET` the compose `web` service holds. It is the app's own crypto used
by a test, not a bypass: no code path is added to `mboss-web`, and a wrong
secret produces a cookie the app reads as "not signed in".

Two couplings follow from that, and both are quiet when they break:

- **`AUTH_SECRET` must match the stack's.** The default here is
  `dev-auth-secret`, which is also the compose default. Set the variable in
  both places if you change it.
- **`next-auth` is pinned to the exact version `mboss-web` resolved**
  (`5.0.0-beta.32`). The session cookie is an encrypted JWE whose format and
  salt belong to the library, so a beta bump on one side alone breaks the
  minter silently. Bump both together. The full harness removes the coupling
  by nesting `mboss-web` and importing its version.

## Fresh addresses, every run

Every spec that signs up uses `wl-${Date.now()}@example.test`.

The stack has no mail sink, so the worker's confirmation send reaches the real
SendGrid with a placeholder key and fails. A DBOS step error is checkpointed
and terminal, and a confirmation workflow's id derives from a 24-hour send key
— so a second signup from the same address inside that window attaches to the
already-failed workflow rather than starting a new one. Reusing an address is
therefore a dead end for a day, and it looks like an unrelated flake.

## What each spec proves

**`design-tokens.spec.ts`** — Every token the page paints with resolves to the
design's value in a real engine, and the load-bearing ones and the faces arrive
at all; a dark-scheme preference changes nothing; the wireframe override squares
every component; a registration mark hangs outside its box unclipped.

**`landing.spec.ts`** — The landing copy verbatim; four registration marks per
blueprint box; no pricing, testimonial, comparison or footer nav; `/docs` and
`/changelog` are real pages.

**`waitlist-join.spec.ts`** — A browser signup reaches Postgres through the
web app and the private API, and comes back as the success card with today's
date; the card offers no queue position.

**`manage.spec.ts`** — An unusable manage link renders the uniform error state
and names nobody; the manage card is deliberately not blueprint-framed.

**`admin-signin.spec.ts`** — The sign-in card verbatim; no site nav; a
signed-out console request lands on `/admin`, and `/admin` does not redirect
to itself.

**`admin-console.spec.ts`** — A minted session opens the console; the chips
carry the API's live counts; a fresh signup reaches the table with its derived
note; a broadcast records the admin who sent it.

## What this suite cannot prove

Two journeys are out of reach from the root compose, which is the development
stack and never grows test-only services:

- **The confirmation email → manage link.** Capturing the signed link needs a
  mail sink standing in for SendGrid. Only the _invalid_ token path is proved
  here; pause, resume and unsubscribe are proved at the unit layer in
  `mboss-web`.
- **The wrong-tenant sign-in rejection.** Driving it needs a mock OIDC issuer
  able to mint a token with an arbitrary `tid`. The policy that decides it is a
  pure function with its own unit tests in `mboss-web`.

Both belong to the full harness below.

One more, for a different reason: **the full design-token ramp**. Tailwind
emits only the theme variables its generated CSS references, so a token nothing
uses yet never reaches the browser to be asserted on. That the whole ramp is
declared is `mboss-web`'s unit test to make; this suite checks the values of
what actually arrives.

## What is not here yet

The finished harness adds:

- `docker-compose.e2e.yml` and its tmpfs Postgres, so a run starts from an
  empty database instead of the development one.
- `fixtures/mailsink/` — a fake SendGrid v3 endpoint that captures sends.
- `fixtures/oidc-mock/` — a tenant-pinned issuer with a configurable `tid`.
- `helpers/compose.ts`, `db.ts`, `mail.ts`, `links.ts` — direct Postgres
  access, compose control from inside the suite, and link extraction.
- `mboss-web`, `mboss-nodejs-api` and `mboss-nodejs-dbos` nested here as build
  contexts, which is also what removes the `next-auth` version coupling.
- The `mcp` and `extension` Playwright projects, and the remaining cloud specs:
  `confirmation-resend`, `broadcast-journey`, `broadcast-crash-resume`,
  `email-events`.

The six specs here are the seed of `tests/cloud/`, and the shape the harness
inherits: `retries: 0`, `workers: 1`, one project named `cloud`.
