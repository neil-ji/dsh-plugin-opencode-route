#!/usr/bin/env node
// Baseline report for one provider/model on this machine: the "no route plugin"
// distribution that the A/B experiment is measured against.
//
// Usage:
//   node research/analyze_baseline.mjs [--calls research/out/calls.jsonl] \
//        [--min-out 60] [--min-decode 300]
//
// Sections:
//   1. call-level speed / TTFB / context size
//   2. session-level medians (the unit the experiment compares)
//   3. route-shape mix vs speed (checks the picker's SHAPE_RANK assumption)
//   4. variance decomposition: session ICC and between/within SD
//   5. daily medians — the temporal drift a before/after design would eat
//   6. selection upside (best-of-k) and the power table

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) { args.set(a.slice(2), next); i += 1; }
  else args.set(a.slice(2), true);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = args.get('calls') ?? path.join(HERE, 'out', 'calls.jsonl');
const MIN_OUT = Number(args.get('min-out') ?? 60);
const MIN_DECODE = Number(args.get('min-decode') ?? 300);

const rows = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const usable = rows.filter((r) => r.tps !== null && r.out >= MIN_OUT && r.decodeMs >= MIN_DECODE);

const q = (values, p) => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
};
const med = (a) => q(a, 0.5);
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const n0 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.round(x));
const n1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.round(x * 100) / 100);

const bySession = new Map();
for (const r of rows) {
  if (!bySession.has(r.session)) bySession.set(r.session, []);
  bySession.get(r.session).push(r);
}
const sessions = [...bySession.entries()].map(([session, calls]) => {
  const good = calls.filter((c) => c.tps !== null && c.out >= MIN_OUT && c.decodeMs >= MIN_DECODE);
  return {
    session,
    calls: calls.length,
    good: good.length,
    day: new Date(calls[0].time).toLocaleDateString('en-CA'),
    tps: good.length ? med(good.map((c) => c.tps)) : null,
    ttfb: good.length ? med(good.map((c) => c.ttfbMs).filter((x) => x !== null)) : null,
    cacheHit: med(calls.map((c) => c.cacheHit).filter((x) => x !== null)),
    first: calls[0].time,
  };
}).filter((s) => s.tps !== null && s.good >= 3);

console.log(`# baseline — ${path.relative(process.cwd(), FILE)}`);
console.log(`# ${rows.length} calls · ${usable.length} usable (out>=${MIN_OUT}, decode>=${MIN_DECODE}ms) · ${sessions.length} sessions with >=3 usable calls\n`);

console.log('## 1. 调用级');
const tps = usable.map((r) => r.tps);
const ttfb = usable.map((r) => r.ttfbMs).filter((x) => x !== null);
const ctx = rows.map((r) => r.inputTokens + r.cacheReadTokens);
const hits = rows.map((r) => r.cacheHit).filter((x) => x !== null);
console.log(`tps    p10 ${n0(q(tps, 0.1))} · p25 ${n0(q(tps, 0.25))} · p50 ${n0(med(tps))} · p75 ${n0(q(tps, 0.75))} · p90 ${n0(q(tps, 0.9))}`);
console.log(`ttfb   p10 ${n0(q(ttfb, 0.1))}ms · p50 ${n0(med(ttfb))}ms · p90 ${n0(q(ttfb, 0.9))}ms`);
console.log(`input  p50 ${n0(med(ctx))} tok · p90 ${n0(q(ctx, 0.9))} tok · cache hit p50 ${n0(med(hits))}%`);

console.log('\n## 2. 会话级（实验的比较单位）');
const stps = sessions.map((s) => s.tps);
console.log(`median tps  p10 ${n0(q(stps, 0.1))} · p25 ${n0(q(stps, 0.25))} · p50 ${n0(med(stps))} · p75 ${n0(q(stps, 0.75))} · p90 ${n0(q(stps, 0.9))}`);
const bands = [[0, 70], [70, 150], [150, Infinity]];
for (const [lo, hi] of bands) {
  const n = stps.filter((x) => x >= lo && x < hi).length;
  console.log(`  ${lo}–${hi === Infinity ? '∞' : hi} tok/s: ${n} (${n0((n / stps.length) * 100)}%)`);
}

console.log('\n## 3. 形状 vs 速度（检验 SHAPE_RANK）');
const shapeGroups = new Map();
for (const r of usable) {
  if (!shapeGroups.has(r.shape)) shapeGroups.set(r.shape, []);
  shapeGroups.get(r.shape).push(r.tps);
}
console.log('shape      calls   p25   p50   p75');
for (const [shape, values] of [...shapeGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (values.length < 20) continue;
  console.log(`${shape.padEnd(10)} ${String(values.length).padStart(5)} ${String(n0(q(values, 0.25))).padStart(5)} ${String(n0(med(values))).padStart(5)} ${String(n0(q(values, 0.75))).padStart(5)}`);
}

console.log('\n## 4. 方差分解（log tps）');
const groups = [...bySession.values()].map((calls) => calls
  .filter((c) => c.tps !== null && c.out >= MIN_OUT && c.decodeMs >= MIN_DECODE)
  .map((c) => Math.log(c.tps))).filter((g) => g.length >= 3);
let total = 0; let count = 0; let grand = 0;
for (const g of groups) { count += g.length; total += 1; grand += g.reduce((a, b) => a + b, 0); }
grand /= count;
let ssB = 0; let ssW = 0;
for (const g of groups) {
  const m = mean(g);
  ssB += g.length * (m - grand) ** 2;
  ssW += g.reduce((a, x) => a + (x - m) ** 2, 0);
}
const msB = ssB / (total - 1);
const msW = ssW / (count - total);
const k0 = (count - groups.reduce((a, g) => a + g.length ** 2, 0) / count) / (total - 1);
const icc = (msB - msW) / (msB + (k0 - 1) * msW);
console.log(`between-session SD(log) ${n1(Math.sqrt(Math.max(msB - msW, 0) / k0))} · within-session SD(log) ${n1(Math.sqrt(msW))}`);
console.log(`ICC(1) = ${n1(icc)}  (1 = 路线完全决定速度, 0 = 路线无关)`);

console.log('\n## 5. 每日中位（前后对比的风险来源）');
const byDay = new Map();
for (const r of rows) {
  const day = new Date(r.time).toLocaleDateString('en-CA');
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(r);
}
console.log('day          calls  sessions  p50-tps  p10-tps  p50-ttfb');
for (const [day, list] of [...byDay.entries()].sort()) {
  const good = list.filter((r) => r.tps !== null && r.out >= MIN_OUT && r.decodeMs >= MIN_DECODE);
  console.log(`${day}  ${String(list.length).padStart(5)}  ${String(new Set(list.map((r) => r.session)).size).padStart(8)}  ${String(n0(good.length ? med(good.map((r) => r.tps)) : null)).padStart(7)}  ${String(n0(good.length ? q(good.map((r) => r.tps), 0.1) : null)).padStart(7)}  ${String(n0(med(good.map((r) => r.ttfbMs).filter((x) => x !== null)))).padStart(8)}`);
}

console.log('\n## 6. 设计含义');
const logs = stps.map(Math.log);
let gain = 0;
const TRIALS = 20000;
for (let i = 0; i < TRIALS; i += 1) {
  const draw = [0, 0, 0, 0].map(() => logs[Math.floor(Math.random() * logs.length)]);
  gain += Math.exp(Math.max(...draw)) / Math.exp(logs[Math.floor(Math.random() * logs.length)]);
}
console.log(`完美挑选 4 条中最好一条的收益上界 ≈ ${n1(gain / TRIALS)}x（无缓存代价、无误判）`);
const sdLog = sd(logs);
console.log(`会话级 SD(log)=${n1(sdLog)} → 检测需要的会话数/臂（双侧 α=0.05, power=0.8）:`);
for (const effect of [1.1, 1.15, 1.2, 1.35]) {
  const delta = Math.log(effect);
  console.log(`  ${effect}x: ${Math.ceil((2 * (1.96 + 0.84) ** 2 * sdLog ** 2) / delta ** 2)}`);
}
const days = new Set(sessions.map((s) => s.day)).size;
console.log(`实测产出 ${n1(sessions.length / days)} 会话/天`);
