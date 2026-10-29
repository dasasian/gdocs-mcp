import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DOC_NAME_PREFIX,
  EVAL_ACCOUNT,
  createdDocIds,
  evalClients,
  findUntrashedEvalDocs,
  isQuotaError,
  QUOTA_RETRY_DELAY_MS,
  trashDocById,
} from './lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const TASKS_DIR = path.join(REPO_ROOT, 'eval', 'tasks');
const DEFAULT_CONCURRENCY = 5;
const FULL_CONCURRENCY = 3;
const RUN_TIMEOUT_MS = Number(process.env.GDOCS_EVAL_RUN_TIMEOUT_MS ?? 10 * 60_000);
const QUOTA_MARKER = 'Quota exceeded';
const DEFAULT_MODELS = ['haiku'];
const FULL_MODELS = ['sonnet', 'haiku'];
const DEFAULT_RUNS = 1;
const FULL_RUNS = 3;

const { values: options } = parseArgs({
  options: {
    full: { type: 'boolean', default: false },
    tag: { type: 'string' },
    task: { type: 'string' },
    model: { type: 'string' },
    runs: { type: 'string' },
    'check-graders': { type: 'boolean', default: false },
  },
});

const liveChildren = new Set();
const inFlightWork = new Set();
let interrupted = false;

const describeDuration = (ms) => (ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`);

const killProcessGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadTasks() {
  const files = (await readdir(TASKS_DIR)).filter((file) => file.endsWith('.mjs')).sort();
  const tasks = [];
  for (const file of files) tasks.push(await import(path.join(TASKS_DIR, file)));
  return tasks;
}

function selectTasks(tasks) {
  const wantedNames = options.task?.split(',');
  const selected = tasks.filter((task) =>
    (!options.tag || task.tags.includes(options.tag)) && (!wantedNames || wantedNames.includes(task.name)));
  if (!selected.length) throw new Error(`no task matches --tag ${options.tag ?? '-'} --task ${options.task ?? '-'}; have: ${tasks.map((task) => task.name).join(', ')}`);
  return selected;
}

async function runPool(items, work, concurrency) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !interrupted) {
      const inFlight = work(queue.shift());
      inFlightWork.add(inFlight);
      try {
        await inFlight;
      } finally {
        inFlightWork.delete(inFlight);
      }
    }
  });
  await Promise.all(workers);
}

function runClaude({ prompt, model, mcpConfigPath, cwd }) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--allowedTools', 'mcp__gdocs',
    '--disable-slash-commands',
    '--tools', '',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    liveChildren.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, RUN_TIMEOUT_MS);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ output, exitCode, timedOut });
    });
  });
}

function summariseLog(output) {
  const toolCalls = [];
  const errorResults = [];
  let costUsd = 0;
  let finalText = '';
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') toolCalls.push(`${block.name.replace('mcp__gdocs__', '')}(${JSON.stringify(block.input).slice(0, 160)})`);
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result' && block.is_error) errorResults.push(JSON.stringify(block.content).slice(0, 300));
      }
    }
    if (event.type === 'result') {
      costUsd = event.total_cost_usd ?? 0;
      finalText = event.result ?? '';
    }
  }
  return { toolCalls, errorResults, costUsd, finalText };
}

async function attemptRun({ task, model, runNumber }, { clients, workDir, mcpConfigPath }) {
  const docName = `${DOC_NAME_PREFIX}${task.name} ${model} ${runNumber}`;
  let failures = [];
  let blocked = null;
  let summary = { toolCalls: [], errorResults: [], costUsd: 0, finalText: '' };
  let hitQuota = false;
  try {
    const context = await task.setup(clients, docName);
    const { output, exitCode, timedOut } = await runClaude({ prompt: task.prompt(context), model, mcpConfigPath, cwd: workDir });
    await writeFile(path.join(workDir, `log ${task.name} ${model} ${runNumber}.jsonl`), output);
    summary = summariseLog(output);
    hitQuota = output.includes(QUOTA_MARKER);
    failures = await task.grade(clients, context);
    if (timedOut) failures.push(`timed out after ${describeDuration(RUN_TIMEOUT_MS)}`);
    else if (exitCode !== 0) failures.push(`claude exited ${exitCode}`);
  } catch (error) {
    blocked = { kind: isQuotaError(error) ? 'quota' : 'harness error', message: error.message };
  }
  return { failures, blocked, hitQuota, ...summary };
}

const outcomeOf = (result) => (result.blocked ? 'could not run' : result.failures.length ? 'fail' : 'pass');

async function executeRun(run, environment) {
  const first = await attemptRun(run, environment);
  return { ...run, ...first, quota: first.hitQuota && first.failures.length > 0 };
}

async function retryQuotaRun(result, environment) {
  await sleep(QUOTA_RETRY_DELAY_MS);
  const second = await attemptRun(result, environment);
  return { ...result, ...second, quota: true, costUsd: result.costUsd + second.costUsd };
}

async function trashAllCreatedDocs(clients) {
  const trashFailures = [];
  for (const documentId of [...createdDocIds]) {
    try {
      await trashDocById(clients, documentId);
    } catch (error) {
      trashFailures.push(`${documentId}: ${error.message}`);
    }
  }
  return trashFailures;
}

async function checkGraders(tasks, clients) {
  const broken = [];
  await runPool(tasks, async (task) => {
    try {
      const context = await task.setup(clients, `${DOC_NAME_PREFIX}check-graders ${task.name}`);
      const failures = await task.grade(clients, context);
      console.log(`${failures.length ? 'ok    ' : 'BROKEN'} ${task.name}${failures.length ? `  (fails on untouched doc: ${failures[0]})` : '  (passes on an untouched doc)'}`);
      if (!failures.length) broken.push(task.name);
    } catch (error) {
      console.log(`BROKEN ${task.name}  (${isQuotaError(error) ? 'could not run, quota: ' : 'threw: '}${error.message})`);
      broken.push(task.name);
    }
  }, DEFAULT_CONCURRENCY);
  return broken;
}

function printReport(results, tasks, models) {
  const cell = (task, model) => {
    const mine = results.filter((result) => result.task.name === task.name && result.model === model);
    const passed = mine.filter((result) => outcomeOf(result) === 'pass').length;
    const quotaCount = mine.filter((result) => result.quota).length;
    const blockedCount = mine.filter((result) => result.blocked).length;
    return `${passed}/${mine.length}${quotaCount ? ` (${quotaCount} quota)` : ''}${blockedCount ? ` (${blockedCount} could not run)` : ''}`;
  };
  const nameWidth = Math.max(...tasks.map((task) => task.name.length), 4);
  console.log(`\n${'task'.padEnd(nameWidth)}  ${models.map((model) => model.padEnd(12)).join('')}`);
  for (const task of tasks) console.log(`${task.name.padEnd(nameWidth)}  ${models.map((model) => cell(task, model).padEnd(12)).join('')}`);

  const failed = results.filter((result) => outcomeOf(result) === 'fail');
  const blocked = results.filter((result) => result.blocked);
  for (const result of failed) {
    console.log(`\nFAIL ${result.task.name} / ${result.model} / run ${result.runNumber}${result.quota ? ' [quota retry]' : ''}`);
    for (const failure of result.failures) console.log(`  grader: ${failure}`);
    console.log(`  tools: ${result.toolCalls.length ? result.toolCalls.join(' -> ') : '(none)'}`);
    for (const errorResult of result.errorResults) console.log(`  error result: ${errorResult}`);
  }
  for (const result of blocked) {
    console.log(`\nCOULD NOT RUN ${result.task.name} / ${result.model} / run ${result.runNumber}: ${result.blocked.kind}`);
    console.log(`  the harness's own Google call failed, not the server: ${result.blocked.message.slice(0, 300)}`);
  }
  const quotaPassed = results.filter((result) => result.quota && outcomeOf(result) === 'pass');
  if (quotaPassed.length) console.log(`\nquota: ${quotaPassed.length} run(s) hit Google's write quota and passed on retry`);
  const totalCost = results.reduce((sum, result) => sum + result.costUsd, 0);
  console.log(`\n${results.length - failed.length - blocked.length} passed, ${failed.length} failed, ${blocked.length} could not run (harness Google call failed after retries)`);
  console.log(`total cost: $${totalCost.toFixed(4)}`);
  return { failedCount: failed.length, blockedCount: blocked.length };
}

async function main() {
  const tasks = selectTasks(await loadTasks());
  const clients = await evalClients();
  let exitCode = 0;
  let cleanUpOnce;
  const cleanUp = () => {
    cleanUpOnce ??= trashAllCreatedDocs(clients);
    return cleanUpOnce;
  };
  const onSignal = async (signal) => {
    console.error(`\n${signal}: stopping runs and trashing created docs`);
    interrupted = true;
    for (const child of liveChildren) killProcessGroup(child);
    await Promise.allSettled([...inFlightWork]);
    const trashFailures = await cleanUp();
    for (const failure of trashFailures) console.error(`could not trash ${failure}`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  const workDir = await mkdtemp(path.join(tmpdir(), 'gdocs-eval-'));
  const mcpConfigPath = path.join(workDir, 'mcp.json');
  await writeFile(mcpConfigPath, JSON.stringify({
    mcpServers: { gdocs: { command: 'node', args: [SERVER_ENTRY], env: { GDOCS_DEFAULT_ACCOUNT: EVAL_ACCOUNT } } },
  }));

  try {
    if (options['check-graders']) {
      const broken = await checkGraders(tasks, clients);
      console.log(broken.length ? `\n${broken.length} broken grader(s): ${broken.join(', ')}` : '\nevery grader fails on its untouched doc');
      exitCode = broken.length ? 1 : 0;
    } else {
      const models = options.model?.split(',') ?? (options.full ? FULL_MODELS : DEFAULT_MODELS);
      const runsPerTask = Number(options.runs ?? (options.full ? FULL_RUNS : DEFAULT_RUNS));
      if (!Number.isInteger(runsPerTask) || runsPerTask < 1) throw new Error(`--runs must be a positive integer, got ${options.runs}`);
      const runs = tasks.flatMap((task) => models.flatMap((model) =>
        Array.from({ length: runsPerTask }, (_, index) => ({ task, model, runNumber: index + 1 }))));
      console.log(`${runs.length} runs: ${tasks.length} tasks x ${models.join('+')} x ${runsPerTask}`);

      const environment = { clients, workDir, mcpConfigPath };
      const results = [];
      await runPool(runs, async (run) => {
        const result = await executeRun(run, environment);
        results.push(result);
        console.log(`${{ pass: 'pass', fail: 'FAIL', 'could not run': 'NORUN' }[outcomeOf(result)]}  ${run.task.name} / ${run.model} / ${run.runNumber}${result.quota ? ' [quota]' : ''}`);
      }, options.full ? FULL_CONCURRENCY : DEFAULT_CONCURRENCY);
      for (const quotaRun of results.filter((result) => result.quota)) {
        console.log(`retrying alone after ${QUOTA_RETRY_DELAY_MS / 1000}s: ${quotaRun.task.name} / ${quotaRun.model} / ${quotaRun.runNumber}`);
        results[results.indexOf(quotaRun)] = await retryQuotaRun(quotaRun, environment);
      }
      const { failedCount, blockedCount } = printReport(results, tasks, models);
      exitCode = failedCount || blockedCount ? 1 : 0;
      if (failedCount || blockedCount) console.log(`logs of the failed runs: ${workDir}`);
    }
  } finally {
    const trashFailures = await cleanUp();
    for (const failure of trashFailures) console.error(`could not trash ${failure}`);
    if (trashFailures.length) exitCode = 1;
    if (interrupted) exitCode = 130;
    let strays = [];
    try {
      strays = await findUntrashedEvalDocs(clients);
    } catch (error) {
      console.error(`could not scan for stray eval docs: ${error.message}`);
      exitCode = exitCode || 1;
    }
    if (strays.length) {
      console.log(`\nstray eval docs still in Drive (not trashed by this tool):`);
      for (const stray of strays) console.log(`  ${stray.id}  ${stray.name}`);
    }
    if (exitCode === 0) await rm(workDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
