import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareSummaries,
  summarizeBenchmark
} from './benchmark-stats.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const workloadPath = path.join(projectRoot, 'benchmarks', 'chat-workload.json');
const fixturesDir = path.join(projectRoot, 'benchmarks', 'fixtures');
const MODEL_DERIVED_EVENTS = new Set([
  'text',
  'tool_call',
  'tool_result',
  'task_update',
  'artifact',
  'awaiting_review',
  'verification',
  'permission_denied',
  'error',
  'done'
]);

function parseArgs(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:3000',
    model: 'qwen3.5:9b',
    warmups: 1,
    runs: 7,
    label: 'benchmark',
    output: null,
    baseline: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--compare') {
      if (!value || !argv[index + 2]) throw new Error('--compare requires two result paths');
      return { compare: [value, argv[index + 2]] };
    }
    const mapping = {
      '--base-url': 'baseUrl',
      '--model': 'model',
      '--warmups': 'warmups',
      '--runs': 'runs',
      '--label': 'label',
      '--output': 'output',
      '--out': 'output',
      '--baseline': 'baseline'
    };
    const key = mapping[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (!value) throw new Error(`${argument} requires a value`);
    options[key] = key === 'warmups' || key === 'runs' ? Number(value) : value;
    index += 1;
  }
  if (!Number.isInteger(options.warmups) || options.warmups < 0) {
    throw new Error('--warmups must be a non-negative integer');
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error('--runs must be a positive integer');
  }
  return options;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotWorkspace(root) {
  const snapshot = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) snapshot[relative] = sha256(fs.readFileSync(absolute));
    }
  };
  visit(root);
  return snapshot;
}

function parseSseBlock(block) {
  let eventName = null;
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  const payload = JSON.parse(data.join('\n'));
  return { event: eventName ?? payload.type, data: payload };
}

async function readSse(response, requestStartedAt) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response did not include an SSE body');
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let firstEventMs = null;
  let firstModelEventMs = null;
  let doneMs = null;

  const accept = parsed => {
    if (!parsed) return;
    const elapsed = performance.now() - requestStartedAt;
    firstEventMs ??= elapsed;
    if (MODEL_DERIVED_EVENTS.has(parsed.data.type)) firstModelEventMs ??= elapsed;
    if (parsed.data.type === 'done') doneMs = elapsed;
    events.push({ elapsedMs: elapsed, event: parsed.event, data: parsed.data });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.trim()) accept(parseSseBlock(block));
    }
  }
  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) accept(parseSseBlock(buffer));
  return { events, firstEventMs, firstModelEventMs, doneMs };
}

function assertBehavior(testCase, response, stream, before, after) {
  const failures = [];
  const eventData = stream.events.map(event => event.data);
  const types = eventData.map(event => event.type);
  const finalText = eventData.filter(event => event.type === 'text').map(event => event.content).join('\n');
  const terminal = eventData.findLast(event => event.type === 'done');
  const errors = eventData.filter(event => event.type === 'error');
  const toolCalls = eventData.filter(event => event.type === 'tool_call');
  const toolResults = eventData.filter(event => event.type === 'tool_result');
  const artifacts = eventData.filter(event => event.type === 'artifact').map(event => event.artifact);

  if (response.status !== 200) failures.push(`HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    failures.push('missing text/event-stream response header');
  }
  if (errors.length > 0) failures.push(`error event: ${errors[0].content}`);
  if (!terminal) failures.push('missing terminal done event');
  if (stream.doneMs === null) failures.push('missing completion timing');
  if (JSON.stringify(before) !== JSON.stringify(after)) failures.push('workspace mutated');

  if (testCase.kind === 'direct' || testCase.kind === 'history') {
    if (finalText.trim() !== testCase.expectedMarker) {
      failures.push(`expected exact marker ${testCase.expectedMarker}`);
    }
    if (toolCalls.length > 0) failures.push('unexpected tool call');
  } else if (testCase.kind === 'read-tool') {
    if (!toolCalls.some(call => call.name === 'read_file')) failures.push('read_file was not called');
    if (!toolResults.some(result => result.name === 'read_file' && result.result?.includes(testCase.expectedMarker))) {
      failures.push('read_file result did not contain fixture marker');
    }
    if (!finalText.includes(testCase.expectedMarker)) failures.push('final text omitted fixture marker');
    if (toolCalls.some(call => ['write_file', 'edit_file', 'run_command'].includes(call.name))) {
      failures.push('mutating tool was called');
    }
  } else if (testCase.kind === 'planning') {
    if (!artifacts.some(artifact => artifact?.kind === testCase.expectedArtifactKind)) {
      failures.push(`missing ${testCase.expectedArtifactKind} artifact`);
    }
    if (terminal?.runStatus !== testCase.expectedRunStatus) {
      failures.push(`expected run status ${testCase.expectedRunStatus}`);
    }
    if (!types.includes('awaiting_review')) failures.push('missing awaiting_review event');
    if (toolCalls.length > 0) failures.push('planning case executed a tool');
  }

  return {
    passed: failures.length === 0,
    failures,
    eventTypes: types,
    finalText,
    runStatus: terminal?.runStatus ?? null,
    toolCalls: toolCalls.map(call => ({ name: call.name, args: call.args })),
    toolDurations: toolResults.map(result => ({ name: result.name, duration: result.duration })),
    artifacts: artifacts.map(artifact => ({ kind: artifact?.kind, status: artifact?.status }))
  };
}

async function runCase(testCase, options, rotation, warmup) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'antigraphity-benchmark-'));
  try {
    if (testCase.fixture) {
      fs.copyFileSync(path.join(fixturesDir, testCase.fixture), path.join(workspace, testCase.fixture));
    }
    const before = snapshotWorkspace(workspace);
    const body = {
      message: testCase.message,
      history: testCase.history ?? [],
      model: options.model,
      workspace,
      settings: {
        executionMode: testCase.kind === 'planning' ? 'planning' : 'fast',
        artifactReviewPolicy: 'request-review',
        commandExecutionPolicy: 'request-review',
        allowList: [],
        denyList: []
      }
    };
    const requestStartedAt = performance.now();
    const response = await fetch(`${options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const headersMs = performance.now() - requestStartedAt;
    const stream = await readSse(response, requestStartedAt);
    const after = snapshotWorkspace(workspace);
    const behavior = assertBehavior(testCase, response, stream, before, after);
    return {
      caseId: testCase.id,
      rotation,
      warmup,
      httpStatus: response.status,
      timings: {
        responseHeadersMs: headersMs,
        firstEventMs: stream.firstEventMs,
        firstModelEventMs: stream.firstModelEventMs,
        totalToDoneMs: stream.doneMs
      },
      behavior
    };
  } catch (error) {
    return {
      caseId: testCase.id,
      rotation,
      warmup,
      httpStatus: null,
      timings: {},
      behavior: { passed: false, failures: [error instanceof Error ? error.message : String(error)] }
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function rotate(values, count) {
  const offset = count % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function printSummary(summary) {
  const format = value => value === null ? '-' : `${Math.round(value)}ms`;
  console.log('\ncase                 ok       p50       p90');
  console.log('------------------------------------------------');
  for (const [caseId, result] of Object.entries(summary.cases)) {
    console.log(`${caseId.padEnd(20)} ${(result.successRate * 100).toFixed(0).padStart(3)}% ${format(result.totalToDoneMs.p50).padStart(9)} ${format(result.totalToDoneMs.p90).padStart(9)}`);
  }
  const overall = summary.overall;
  console.log(`${'overall'.padEnd(20)} ${(overall.successRate * 100).toFixed(0).padStart(3)}% ${format(overall.totalToDoneMs.p50).padStart(9)} ${format(overall.totalToDoneMs.p90).padStart(9)}`);
}

function printComparison(comparison) {
  const percent = delta => delta === null ? '-' : `${(delta * 100).toFixed(1)}%`;
  console.log('comparison            p50 delta   p90 delta');
  console.log('---------------------------------------------');
  console.log(`${'overall'.padEnd(21)} ${percent(comparison.overall.p50TotalToDoneMs.relativeDelta).padStart(9)} ${percent(comparison.overall.p90TotalToDoneMs.relativeDelta).padStart(11)}`);
  for (const [caseId, result] of Object.entries(comparison.cases)) {
    if (!result) continue;
    console.log(`${caseId.padEnd(21)} ${percent(result.p50TotalToDoneMs.relativeDelta).padStart(9)} ${percent(result.p90TotalToDoneMs.relativeDelta).padStart(11)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.compare) {
    const [beforePath, afterPath] = options.compare;
    const before = JSON.parse(fs.readFileSync(path.resolve(beforePath), 'utf8'));
    const after = JSON.parse(fs.readFileSync(path.resolve(afterPath), 'utf8'));
    printComparison(compareSummaries(before.summary, after.summary));
    return;
  }

  const workloadRaw = fs.readFileSync(workloadPath, 'utf8');
  const workload = JSON.parse(workloadRaw);
  const samples = [];
  const totalRotations = options.warmups + options.runs;
  for (let rotation = 0; rotation < totalRotations; rotation += 1) {
    const warmup = rotation < options.warmups;
    console.log(`${warmup ? 'warmup' : 'measure'} rotation ${rotation + 1}/${totalRotations}`);
    for (const testCase of rotate(workload.cases, rotation)) {
      const sample = await runCase(testCase, options, rotation, warmup);
      console.log(`  ${testCase.id}: ${sample.behavior.passed ? 'ok' : `failed (${sample.behavior.failures.join('; ')})`}`);
      samples.push(sample);
    }
  }

  const measured = samples.filter(sample => !sample.warmup);
  const summary = summarizeBenchmark(measured);
  const report = {
    version: 1,
    label: options.label,
    createdAt: new Date().toISOString(),
    model: options.model,
    baseUrl: options.baseUrl,
    workloadHash: sha256(workloadRaw),
    parameters: { warmups: options.warmups, runs: options.runs },
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    samples,
    summary
  };
  printSummary(summary);

  const outputPath = path.resolve(options.output ?? path.join(os.tmpdir(), `antigraphity-${options.label}-${Date.now()}.json`));
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nreport: ${outputPath}`);

  if (options.baseline) {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(options.baseline), 'utf8'));
    printComparison(compareSummaries(baseline.summary, summary));
  }
  if (summary.overall.successRate !== 1) process.exitCode = 1;
}

await main();
