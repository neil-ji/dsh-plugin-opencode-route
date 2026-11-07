#!/usr/bin/env node
// Effectiveness report for dsh-plugin-opencode-route.
//
// Every route decision logs a `compare` event carrying both numbers:
//   naturalTps    — what the session's own id measured during the probe round
//                   (the counterfactual: what you would have got without the plugin)
//   naturalStatus — ok / rejected / dead; a dead natural id is a 429 or an
//                   unreachable upstream, which the plugin clearly improved on
//   chosenTps     — the route actually used afterwards
//   source        — "natural" (kept the session's own route) or "probe" (switched)
//
// Usage:
//   node scripts/effectiveness.mjs [%DSH_HOME%/opencode-route/events.jsonl]
//
// The honest reading:
//   * keptNatural high  -> the plugin mostly stays out of the way
//   * medianGain > 1    -> switching actually buys speed, not just churn
//   * worse > 0         -> probe error; the corrective re-pick exists for that

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2]
  ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'opencode-route', 'events.jsonl');

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}

const rows = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (event.kind === 'compare') rows.push(event);
  } catch { /* skip a torn line */ }
}

if (rows.length === 0) {
  console.log('no route decisions recorded yet — open a new session and send one message.');
  process.exit(0);
}

const bySession = new Map();
for (const row of rows) {
  const key = row.sessionId ?? '?';
  if (!bySession.has(key)) bySession.set(key, row); // first decision wins
}

const decisions = [...bySession.values()];
const switched = decisions.filter((row) => row.source === 'probe');
const kept = decisions.filter((row) => row.source === 'natural');
const comparable = switched.filter((row) => row.naturalTps > 0 && row.chosenTps > 0);
const deadNatural = decisions.filter((row) => row.naturalStatus === 'dead').length;
const rejectedNatural = decisions.filter((row) => row.naturalStatus === 'rejected').length;
const median = (list) => {
  if (list.length === 0) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const fmt = (n) => (Number.isFinite(n) ? Math.round(n) : '-');

console.log(`decisions ${decisions.length} · kept natural ${kept.length} · switched ${switched.length}`);
console.log(`natural route: ok ${decisions.length - deadNatural - rejectedNatural} · rejected ${rejectedNatural} · dead ${deadNatural}\n`);
console.log('session        source   natural  chosen   gain');
for (const row of decisions.slice(-30)) {
  const gain = row.naturalTps > 0 && row.chosenTps > 0 ? (row.chosenTps / row.naturalTps).toFixed(2) : '-';
  console.log(
    `${String(row.sessionId).slice(-12)}  ${String(row.source).padEnd(7)}  ${String(fmt(row.naturalTps)).padStart(7)}  ${String(fmt(row.chosenTps)).padStart(6)}  ${String(gain).padStart(5)}`,
  );
}

if (comparable.length > 0) {
  const gains = comparable.map((row) => row.chosenTps / row.naturalTps);
  console.log('');
  console.log(`switched with a measurable natural route: ${comparable.length}`);
  console.log(`  median natural ${fmt(median(comparable.map((r) => r.naturalTps)))} tok/s -> median chosen ${fmt(median(comparable.map((r) => r.chosenTps)))} tok/s`);
  console.log(`  median gain ${median(gains).toFixed(2)}x   improved ${gains.filter((g) => g > 1.1).length}   worse ${gains.filter((g) => g < 0.9).length}`);
} else if (switched.length > 0) {
  console.log('\nevery switch happened because the natural route was unusable (dead, rejected, or too slow to measure).');
}
