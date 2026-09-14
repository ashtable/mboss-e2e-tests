import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { e2eVsix } from '../helpers/vscode.js';

/**
 * Which `.vsix` the extension specs install.
 *
 * `vsce package` names its output after the
 * manifest's name and version, and the extension
 * moves that version with every branch. A name
 * spelled here would point at a package the build
 * never writes, so every extension spec would fail
 * on a missing file — or, locally, silently install
 * an old one still lying beside the checkout.
 *
 * These run against a scratch directory rather than
 * the nested checkout: the hermetic job checks out
 * no submodules.
 */

function checkout(manifest: object): string {
  const repo = mkdtempSync(join(tmpdir(), 'e2e-vsix-'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify(manifest));
  return repo;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('e2eVsix', () => {
  it('names the package after the manifest version', () => {
    vi.stubEnv('E2E_VSIX', undefined);
    const repo = checkout({ name: 'mboss-vscode', version: '0.0.8' });

    expect(e2eVsix(repo)).toBe(join(repo, 'mboss-vscode-0.0.8.vsix'));
  });

  it('takes the name from the manifest too', () => {
    vi.stubEnv('E2E_VSIX', undefined);
    const repo = checkout({ name: 'renamed', version: '1.2.3' });

    expect(e2eVsix(repo)).toBe(join(repo, 'renamed-1.2.3.vsix'));
  });

  it('prefers E2E_VSIX without reading a manifest', () => {
    vi.stubEnv('E2E_VSIX', '/elsewhere/built.vsix');
    const empty = mkdtempSync(join(tmpdir(), 'e2e-vsix-'));

    expect(e2eVsix(empty)).toBe('/elsewhere/built.vsix');
  });
});
