import { describe, expect, test } from 'vitest';

import {
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  composeArgs,
} from '../helpers/compose.js';

/**
 * Only the argument building is tested here.
 *
 * `up`, `down`, `kill` and `start` are three-line
 * execFile wrappers; a unit test of one would
 * assert that a mock was called, which proves
 * nothing about docker. What they get wrong in
 * practice is the arguments, and that is a pure
 * function.
 */

describe('composeArgs', () => {
  test('names the compose file and the project', () => {
    // The project name is what lets a spec address
    // the stack regardless of what the checkout
    // directory is called — compose would
    // otherwise derive it from the directory.
    expect(composeArgs('ps')).toEqual([
      'compose',
      '-f',
      COMPOSE_FILE,
      '-p',
      COMPOSE_PROJECT,
      'ps',
    ]);
  });

  test('passes the rest of the command through in order', () => {
    expect(composeArgs('up', '--build', '--wait')).toEqual([
      'compose',
      '-f',
      COMPOSE_FILE,
      '-p',
      COMPOSE_PROJECT,
      'up',
      '--build',
      '--wait',
    ]);
  });

  test('builds the crash-resume pair', () => {
    expect(composeArgs('kill', 'dbos').slice(-2)).toEqual(['kill', 'dbos']);
    expect(composeArgs('start', 'dbos').slice(-2)).toEqual(['start', 'dbos']);
  });
});
