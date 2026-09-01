import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Creating a real mBoss project, the way the
 * extension will.
 *
 * The durability spec needs a project that a
 * scaffold made rather than one somebody checked
 * in — a snapshot of the scaffold's output would
 * stop testing the scaffold on the day it changed.
 * But nothing in this repository may *import*
 * `mboss-core`: the nested checkouts are build
 * contexts, and `lint-unit` runs `tsc` on a
 * checkout that has none of them. So the scaffold
 * is reached across a process boundary instead,
 * which is what this file is.
 *
 * It is a `.mjs` on purpose. Plain Node strips the
 * types out of core's TypeScript for free but will
 * not follow a `.js` specifier to a `.ts` file, so
 * the one thing this script adds is that mapping —
 * and being untyped keeps it honest about being a
 * script rather than looking like a module `tsc`
 * checks, which it is not.
 *
 * Usage:
 *
 *   node scaffolder/scaffold-project.mjs '<json>'
 *
 * where the JSON is `{ dir, name, bundle?,
 * version? }` — `bundle` and `version` being the
 * paths of a built `server.js` and its `VERSION`,
 * which land in the project at `.mboss/mcp/`.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js')) {
      const asTypeScript = new URL(
        `${specifier.slice(0, -3)}.ts`,
        context.parentURL,
      );

      if (
        asTypeScript.protocol === 'file:' &&
        existsSync(fileURLToPath(asTypeScript))
      ) {
        return nextResolve(asTypeScript.href, context);
      }
    }

    return nextResolve(specifier, context);
  },
});

const CORE_SCAFFOLD = new URL(
  '../mboss-mcp-server/mboss-core/src/scaffold/index.ts',
  import.meta.url,
);

async function main() {
  const request = JSON.parse(process.argv[2] ?? '{}');

  if (!existsSync(fileURLToPath(CORE_SCAFFOLD))) {
    throw new Error(
      `${fileURLToPath(CORE_SCAFFOLD)} is not there — ` +
        'the nested checkouts are missing; run `git submodule update ' +
        '--init --recursive`',
    );
  }

  const { scaffoldProject } = await import(CORE_SCAFFOLD.href);

  await scaffoldProject(request.dir, {
    name: request.name,
    mcpBundle: request.bundle
      ? {
          server: readFileSync(request.bundle, 'utf8'),
          version: readFileSync(request.version, 'utf8').trim(),
        }
      : undefined,
  });
}

await main();
