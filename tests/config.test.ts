import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { envInt, envTemp } from '../src/lib/agent/config.ts';

const KEY = 'AGENT_TEST_CONFIG_VAR';

afterEach(() => {
  delete process.env[KEY];
});

describe('envInt', () => {
  it('returns the fallback when unset', () => {
    assert.equal(envInt(KEY, 8192), 8192);
  });

  it('reads a valid positive integer', () => {
    process.env[KEY] = '16384';
    assert.equal(envInt(KEY, 8192), 16384);
  });

  it('rejects zero, negatives, floats, and junk, keeping the fallback', () => {
    for (const bad of ['0', '-1', '4096.5', 'lots', '']) {
      process.env[KEY] = bad;
      assert.equal(envInt(KEY, 8192), 8192, `expected fallback for "${bad}"`);
    }
  });

  it('ignores surrounding whitespace', () => {
    process.env[KEY] = '  2048  ';
    assert.equal(envInt(KEY, 8192), 2048);
  });
});

describe('envTemp', () => {
  it('returns the fallback when unset', () => {
    assert.equal(envTemp(KEY, 0.1), 0.1);
  });

  it('reads a valid temperature in [0, 2]', () => {
    process.env[KEY] = '0.7';
    assert.equal(envTemp(KEY, 0.1), 0.7);
    process.env[KEY] = '0';
    assert.equal(envTemp(KEY, 0.1), 0);
    process.env[KEY] = '2';
    assert.equal(envTemp(KEY, 0.1), 2);
  });

  it('rejects out-of-range and non-numeric values, keeping the fallback', () => {
    for (const bad of ['-0.1', '2.1', 'hot', '']) {
      process.env[KEY] = bad;
      assert.equal(envTemp(KEY, 0.1), 0.1, `expected fallback for "${bad}"`);
    }
  });
});
