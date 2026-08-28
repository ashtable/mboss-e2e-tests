# The sink has no dependencies, so there is no
# npm ci layer and no lockfile to keep in step:
# Node 24 strips the types and runs the same file
# the unit tests import.
FROM node:24.18.0-slim

WORKDIR /app
COPY server.ts .

EXPOSE 8025
CMD ["node", "server.ts"]
