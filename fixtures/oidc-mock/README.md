# oidc-mock

A tenant-pinned Microsoft Entra mock: enough of the v2.0 endpoints for Auth.js v5 to
complete an authorization-code sign-in against mboss-web, plus a control surface that
chooses who signs in next.

## Why it serves HTTPS

Because it has to. `@auth/core` re-runs OIDC discovery **after** the token exchange for the
`microsoft-entra-id` provider — it reads `tid` out of the id_token and re-discovers the
tenant's issuer — and that single call is the only one in the library that does not pass
`allowInsecureRequests`. `oauth4webapi` then refuses any non-HTTPS issuer with
`OAUTH_HTTP_REQUEST_FORBIDDEN`, and it has no localhost exemption.

There is no way around it: `tid` has to be in the id_token for mboss-web's tenant check to
run at all, and a `tid` in the id_token is exactly what arms that branch. An http mock does
not sign anybody in. If this ever looks like something to simplify, that is why it is not.

The re-discovery lands back on this same tenant path whatever `tid` the id_token carried:
the library only rewrites the issuer for hosts matching `microsoftonline.com/<tenant>/v2.0`,
which this issuer does not. So the mock serves one tenant and 404s every other path, and a
wrong-tenant sign-in is rejected by mboss-web's own policy rather than by a missing route.

## Surfaces

**Protocol, HTTPS on `PORT` (8443).** `ORIGIN` is the issuer's origin, `<tid>` is
`OIDC_TENANT_ID`.

| Route                                              | Behaviour                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /<tid>/v2.0/.well-known/openid-configuration` | the discovery document; any other tenant path 404s                     |
| `GET /<tid>/discovery/v2.0/keys`                   | one RSA `sig`/`RS256` public JWK with a `kid`                          |
| `GET /<tid>/oauth2/v2.0/authorize`                 | `302` to `redirect_uri?code=…`, echoing `state` only when one was sent |
| `POST /<tid>/oauth2/v2.0/token`                    | the token response, or `401 invalid_client` / `400 invalid_grant`      |
| `GET /<tid>/openid/userinfo`                       | the same claims as JSON, for a Bearer token                            |

**Control, plain HTTP on `CONTROL_PORT` (8081).** Plain so the container healthcheck and the
Playwright process need no certificate handling.

| Route                  | Behaviour                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `POST /_test/identity` | `{email?, tid?, name?}` → `204`; absent fields fall back to the configured defaults |
| `GET /_test/identity`  | the current identity                                                                |
| `POST /_test/reset`    | `204`; restores the defaults and clears issued codes and tokens                     |
| `GET /health`          | `200 {"ok":true}`                                                                   |

One current identity, not a directory of users: the suite runs `workers: 1`, so exactly one
test is signing in at a time and each states who it means.

## Two claims details that are load-bearing

- **The id_token carries no `nonce`, ever** — not even when the authorize request sent one.
  mboss-web's provider runs `checks: ['pkce']`, so no expected nonce reaches
  `oauth4webapi`'s validator, and a `nonce` claim that is merely _present_ makes it throw.
- **The discovery document must name both `token_endpoint` and `userinfo_endpoint`**, even
  though userinfo is never called when the profile comes from the id_token: `handleOAuth`
  throws outright if either is missing.

The signature is never verified in the authorization-code flow. The mock signs RS256
properly and publishes a real JWKS anyway — an unverifiable signature would be a trap the
day that tightens.

## Regenerating the TLS pair

`tls/cert.pem` and `tls/key.pem` are checked in. They are test material, not secrets: the
compose stack mounts the certificate into `web` as a trusted root, and generating a fresh
pair at build time would hand `web` a different root on every rebuild.

Self-signed, `CA:TRUE` so it validates as its own root, and 100 years so nobody ever debugs
an expired fixture:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
  -subj '/CN=oidc-mock' \
  -addext 'subjectAltName=DNS:oidc-mock,DNS:localhost,IP:127.0.0.1' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout tls/key.pem -out tls/cert.pem
```

The SAN covers all three names the pair is reached by: `oidc-mock` from inside the compose
network, and `localhost`/`127.0.0.1` from a browser whose host resolution maps `oidc-mock`
to loopback.
