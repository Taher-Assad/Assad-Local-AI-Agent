export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new RangeError('percentile must be between 0 and 1');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

export function summarizeDurations(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return { count: 0, min: null, max: null, p50: null, p90: null, iqr: null };
  }
  const q1 = nearestRank(finite, 0.25);
  const q3 = nearestRank(finite, 0.75);
  return {
    count: finite.length,
    min: Math.min(...finite),
    max: Math.max(...finite),
    p50: nearestRank(finite, 0.5),
    p90: nearestRank(finite, 0.9),
    iqr: q3 - q1
  };
}

export function relativeDelta(after, before) {
  if (!Number.isFinite(after) || !Number.isFinite(before) || before === 0) return null;
  return (after - before) / before;
}

function samplePassed(sample) {
  return sample?.behavior?.passed === true && Number.isFinite(sample?.timings?.totalToDoneMs);
}

export function summarizeSamples(samples) {
  const successful = samples.filter(samplePassed);
  return {
    attempts: samples.length,
    successes: successful.length,
    successRate: samples.length === 0 ? 0 : successful.length / samples.length,
    totalToDoneMs: summarizeDurations(
      successful.map(sample => sample.timings.totalToDoneMs)
    ),
    firstModelEventMs: summarizeDurations(
      successful.map(sample => sample.timings.firstModelEventMs)
    )
  };
}

export function summarizeBenchmark(samples) {
  const cases = {};
  for (const sample of samples) {
    (cases[sample.caseId] ??= []).push(sample);
  }
  return {
    overall: summarizeSamples(samples),
    cases: Object.fromEntries(
      Object.entries(cases).map(([caseId, caseSamples]) => [caseId, summarizeSamples(caseSamples)])
    )
  };
}

export function compareSummaries(baseline, candidate) {
  const compareMetric = (before, after) => ({
    before,
    after,
    relativeDelta: relativeDelta(after, before)
  });
  const compareGroup = (before, after) => ({
    successRate: compareMetric(before.successRate, after.successRate),
    p50TotalToDoneMs: compareMetric(before.totalToDoneMs.p50, after.totalToDoneMs.p50),
    p90TotalToDoneMs: compareMetric(before.totalToDoneMs.p90, after.totalToDoneMs.p90)
  });
  const caseIds = new Set([
    ...Object.keys(baseline.cases ?? {}),
    ...Object.keys(candidate.cases ?? {})
  ]);
  return {
    overall: compareGroup(baseline.overall, candidate.overall),
    cases: Object.fromEntries(
      [...caseIds].map(caseId => [
        caseId,
        baseline.cases?.[caseId] && candidate.cases?.[caseId]
          ? compareGroup(baseline.cases[caseId], candidate.cases[caseId])
          : null
      ])
    )
  };
}
