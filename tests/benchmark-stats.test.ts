import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareSummaries,
  nearestRank,
  relativeDelta,
  summarizeBenchmark,
  summarizeDurations
} from '../scripts/benchmark-stats.mjs';

const sample = (caseId: string, duration: number, passed = true) => ({
  caseId,
  timings: { totalToDoneMs: duration, firstModelEventMs: duration / 2 },
  behavior: { passed }
});

describe('benchmark statistics', () => {
  it('uses nearest-rank percentiles for small and odd samples', () => {
    assert.equal(nearestRank([9, 1, 5, 3], 0.5), 3);
    assert.equal(nearestRank([9, 1, 5, 3], 0.9), 9);
    assert.equal(nearestRank([8, 2, 4], 0.5), 4);
    assert.equal(nearestRank([], 0.5), null);
  });

  it('reports range and interquartile range', () => {
    assert.deepEqual(summarizeDurations([1, 2, 3, 4, 100]), {
      count: 5,
      min: 1,
      max: 100,
      p50: 3,
      p90: 100,
      iqr: 2
    });
  });

  it('keeps failed behavior in success rate but out of latency percentiles', () => {
    const summary = summarizeBenchmark([
      sample('direct', 100),
      sample('direct', 1, false),
      sample('tool', 300)
    ]);
    assert.equal(summary.overall.attempts, 3);
    assert.equal(summary.overall.successRate, 2 / 3);
    assert.equal(summary.overall.totalToDoneMs.min, 100);
    assert.equal(summary.cases.direct.successRate, 0.5);
  });

  it('computes relative before/after deltas', () => {
    assert.equal(relativeDelta(80, 100), -0.2);
    assert.equal(relativeDelta(1, 0), null);

    const baseline = summarizeBenchmark([sample('direct', 100), sample('tool', 200)]);
    const candidate = summarizeBenchmark([sample('direct', 80), sample('tool', 150)]);
    const comparison = compareSummaries(baseline, candidate);
    assert.equal(comparison.overall.p50TotalToDoneMs.relativeDelta, -0.2);
    assert.equal(comparison.cases.tool?.p50TotalToDoneMs.relativeDelta, -0.25);
  });
});
