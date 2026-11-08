#!/usr/bin/env node
// Rebuild per-model-call timing from DSH durable session logs.
//
// The durable log keeps the whole chunk stream of every assistant message
// (`data.stream`), including `time0` + `dt[]` per block, so TTFB and decode
// speed can be reconstructed exactly — no plugin needed, and with the same
// formula the route picker uses for its own `turn` events:
//
//   ttfb    = firstTokenAt - stepStartAt
//   decode  = lastTokenAt  - firstTokenAt
//   tps     = outputTokens * 1000 / decode
//
// Usage:
//   node research/collect_sessions.mjs [--root DIR] [--out DIR] \
//        [--provider opencode-go] [--model deepseek-v4.1-flash] [--all]
//
// Writes <out>/calls.jsonl (one row per assistant message) and prints a summary.
// Requires the `zstd` binary (brew install zstd); the v3/v4 session files are
// multi-frame zstd streams.

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) { args.set(a.slice(2), next); i += 1; }
  else args.set(a.slice(2), true);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = args.get('root') ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const OUT = args.get('out') ?? path.join(HERE, 'out');
const PROVIDER = args.get('all') ? undefined : (args.get('provider') ?? 'opencode-go');
const MODEL = args.get('all') ? undefined : (args.get('model') ?? 'deepseek-v4.1-flash');

async function findSessionFiles(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await findSessionFiles(full, acc);
    else if (/^session\.v[34]\.jsonl\.zstd$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function tokenSpan(stream) {
  if (!Array.isArray(stream)) return null;
  let first = null;
  let last = null;
  const touch = (start, end) => {
    if (first === null || start < first) first = start;
    if (last === null || end > last) last = end;
  };
  for (const entry of stream) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.time0 === 'number' && Array.isArray(entry.dt)) {
      let sum = 0;
      for (const d of entry.dt) sum += typeof d === 'number' && d >= 0 ? d : 0;
      touch(entry.time0, entry.time0 + sum);
    } else if (typeof entry.time === 'number' && entry.chunk) {
      const type = entry.chunk.type;
      if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') {
        touch(entry.time, entry.time);
      }
    }
  }
  return first === null ? null : { first, last };
}

function shapeOf(id) {
  if (!id) return 'none';
  if (id.startsWith('gw-')) return 'gw';
  if (id.startsWith('chatcmpl')) return 'chatcmpl';
  if (id.startsWith('msg_')) return 'msg';
  if (/^[0-9a-f]{32}$/.test(id)) return 'hex32';
  if (/^[0-9a-f]{40}$/.test(id)) return 'hex40';
  if (/^[0-9a-f]{48,56}$/.test(id)) return 'hex48';
  return 'other';
}

function scanFile(file) {
  return new Promise((resolve) => {
    const child = spawn('zstd', ['-dc', file]);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const steps = new Map();
    const calls = [];
    const turnEnds = [];
    let header = null;
    let stepEvents = 0;
    child.on('error', () => resolve({ calls: [], header: null, stepEvents: 0, turnEnds: [] }));
    rl.on('line', (line) => {
      if (!line.startsWith('{"type":"session"')
        && !line.startsWith('{"type":"step/start"')
        && !line.startsWith('{"type":"turn/end"')
        && !line.startsWith('{"type":"assistant/message"')) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'session') { header = ev; return; }
      if (ev.type === 'turn/end') { turnEnds.push(ev.data?.reason?.kind ?? 'unknown'); return; }
      if (ev.type === 'step/start') {
        stepEvents += 1;
        steps.set(`${ev.data?.turn}:${ev.data?.step}`, ev.time);
        return;
      }
      const data = ev.data ?? {};
      const message = data.message ?? {};
      const source = message.source ?? {};
      if (PROVIDER !== undefined && source.provider !== PROVIDER) return;
      if (MODEL !== undefined && source.model !== MODEL) return;
      const usage = data.usage ?? {};
      const span = tokenSpan(data.stream);
      const start = steps.get(`${data.turn}:${data.step}`) ?? null;
      const out = Number(usage.outputTokens ?? 0);
      const inputTokens = Number(usage.inputTokens ?? 0);
      const cacheReadTokens = Number(usage.cacheReadTokens ?? 0);
      const cacheBase = inputTokens + cacheReadTokens;
      const decodeMs = span ? span.last - span.first : null;
      const ttfbMs = span && start !== null ? span.first - start : null;
      let finishKind = null;
      let failureCode = null;
      if (Array.isArray(data.stream)) {
        for (const entry of data.stream) {
          if (entry?.chunk?.type === 'finish') {
            finishKind = entry.chunk.reason?.kind ?? null;
            failureCode = entry.chunk.reason?.failure?.code ?? null;
          }
        }
      }
      calls.push({
        session: path.basename(path.dirname(file)),
        provider: source.provider ?? null,
        model: source.model ?? null,
        turn: data.turn ?? null,
        step: data.step ?? null,
        time: ev.time ?? null,
        responseId: source.replayState?.response?.responseId ?? null,
        shape: shapeOf(source.replayState?.response?.responseId),
        stopReason: source.replayState?.response?.stopReason ?? null,
        out,
        inputTokens,
        cacheReadTokens,
        cacheHit: cacheBase > 0 ? Math.round((cacheReadTokens / cacheBase) * 100) : null,
        decodeMs: decodeMs !== null && decodeMs >= 0 ? decodeMs : null,
        ttfbMs,
        tps: decodeMs !== null && decodeMs > 0 && out > 0 ? Math.round((out * 1000) / decodeMs) : null,
        finishKind,
        failureCode,
        createdAt: header?.createdAt ?? null,
        delegationDepth: header?.delegationDepth ?? null,
      });
    });
    child.on('close', () => resolve({ calls, header, stepEvents, turnEnds }));
  });
}

const files = (await findSessionFiles(ROOT)).sort();
if (files.length === 0) {
  console.error(`no session.v3/v4.jsonl.zstd under ${ROOT}`);
  process.exit(1);
}
console.error(`scanning ${files.length} session files under ${ROOT}…`);

const all = [];
let steps = 0;
const turnEnds = new Map();
let done = 0;
for (const file of files) {
  const result = await scanFile(file);
  if (result.calls.length > 0) {
    for (const call of result.calls) all.push(call);
    steps += result.stepEvents;
    for (const kind of result.turnEnds) turnEnds.set(kind, (turnEnds.get(kind) ?? 0) + 1);
  }
  done += 1;
  if (done % 100 === 0) console.error(`  ${done}/${files.length} sessions, ${all.length} calls`);
}

await mkdir(OUT, { recursive: true });
const target = path.join(OUT, 'calls.jsonl');
await writeFile(target, `${all.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');

const withTps = all.filter((c) => c.tps !== null);
const times = all.map((c) => c.time).filter(Number.isFinite).sort((a, b) => a - b);
console.log(JSON.stringify({
  out: target,
  sessions: new Set(all.map((c) => c.session)).size,
  calls: all.length,
  callsWithTiming: withTps.length,
  steps,
  stepsWithoutMessage: steps - all.length,
  turnEnds: [...turnEnds.entries()].sort((a, b) => b[1] - a[1]),
  firstAt: times.length ? new Date(times[0]).toISOString() : null,
  lastAt: times.length ? new Date(times.at(-1)).toISOString() : null,
}, null, 2));
