# No dependencies, so no npm ci layer and no
# lockfile to keep in step: Node 24 strips the
# types and runs the same file the unit tests
# import.
FROM node:24.18.0-slim

WORKDIR /app
COPY server.ts .
# The self-signed pair is checked in — it is test
# material, not a secret, and generating it at
# build time would give `web` a different root to
# trust on every rebuild.
COPY tls ./tls

# 8443 is the OIDC protocol surface (HTTPS);
# 8081 is the plain-HTTP control surface.
EXPOSE 8443 8081
CMD ["node", "server.ts"]
