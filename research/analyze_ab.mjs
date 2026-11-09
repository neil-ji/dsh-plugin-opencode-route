#!/usr/bin/env node
// Session-level A/B report for the route picker experiment.
//
// Reads the plugin event log (`<DSH_HOME>/opencode-route/events.jsonl`), keeps
// `turn` events that carry `arm`, aggregates to one row per session, and compares
// `treatment` (probed + pinned) with `control` (neither). Sessions are the
// independent unit: a session's turns are correlated, so counting requests would
// shrink the interval artificially.
//
// Usage:
//   node research/analyze_ab.mjs [--events PATH] [--min-out 60] [--min-decode 300] \
//        [--min-turns 3] [--boot 4000] [--since ISO] [--baseline research/out/calls.jsonl]
//
// Sessions whose first turn predates the experiment start are excluded: they were
// already cache-locked when the experiment was switched on, so the picker never
// touched them and counting them would dilute the treatment arm.
//
// With --baseline it also prints the pre-experiment baseline next to the arms, as
// a sanity check (not as a control: the baseline is historical, so temporal drift
// is not cancelled — see research/README.md).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
const EVENTS = args.get('events')
  ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'opencode-route', 'events.jsonl');
const MIN_OUT = Number(args.get('min-out') ?? 60);
const MIN_TURNS = Number(args.get('min-turns') ?? 3);
const MIN_DECODE = Number(args.get('min-decode') ?? 300);
const BOOT = Number(args.get('boot') ?? 4000);

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
const n0 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.round(x));
const n2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : Math.round(x * 100) / 100);

const raw = readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean);
const events = [];
for (const line of raw) {
  try { events.push(JSON.parse(line)); } catch { /* torn tail line */ }
}

const turns = events.filter((e) => e.kind === 'turn' && typeof e.sessionId === 'string' && typeof e.arm === 'string');
if (turns.length === 0) {
  console.error(`no \`turn\` events with \`arm\` in ${EVENTS}.`);
  console.error('Enable `experiment.enabled: true` in the plugin config and run for a while.');
  process.exit(1);
}
const arms = new Set(turns.map((t) => t.arm));
if (!arms.has('treatment') || !arms.has('control')) {
  console.error(`need both arms; found: ${[...arms].join(', ') || 'none'}`);
  if (arms.has('off')) console.error('`arm: "off"` means the experiment was disabled for those turns.');
  process.exit(1);
}

// Experiment start: the earliest `plugin` event that carries an experiment config.
const starts = events
  .filter((e) => e.kind === 'plugin' && e.experiment)
  .map((e) => Date.parse(e.ts))
  .filter(Number.isFinite);
const sinceArg = args.get('since') ? Date.parse(String(args.get('since'))) : NaN;
const cutoff = Number.isFinite(sinceArg) ? sinceArg : (starts.length ? Math.min(...starts) : null);

// One row per session: turn counts, timing medians, first day (local).
const bySession = new Map();
for (const t of turns) {
  if (!bySession.has(t.sessionId)) bySession.set(t.sessionId, []);
  bySession.get(t.sessionId).push(t);
}
const allSessions = [...bySession.entries()].map(([session, list]) => {
  // decodeMs is absent on turns logged before 1.7.3; treat those as passing so an
  // older log still yields a report (the report prints the count it could check).
  const usable = list.filter((t) => t.tps !== null && t.tps !== undefined && t.out >= MIN_OUT
    && (t.decodeMs === null || t.decodeMs === undefined || t.decodeMs >= MIN_DECODE));
  const arm = list[0].arm;
  return {
    session,
    arm,
    turns: list.length,
    usable: usable.length,
    day: new Date(list[0].ts).toLocaleDateString('en-CA'),
    firstTs: Date.parse(list[0].ts),
    tps: usable.length ? med(usable.map((t) => t.tps)) : null,
    ttfb: usable.length ? med(usable.map((t) => t.ttfbMs).filter((x) => typeof x === 'number')) : null,
    cacheHit: med(list.map((t) => t.cacheHit).filter((x) => typeof x === 'number')),
    failure: list.filter((t) => t.finish === 'error' || t.finish === 'thrown').length / list.length,
  };
}).filter((s) => s.tps !== null && s.usable >= MIN_TURNS);
const sessions = cutoff === null ? allSessions : allSessions.filter((s) => s.firstTs >= cutoff);
const droppedForCutoff = allSessions.length - sessions.length;

const groups = { treatment: sessions.filter((s) => s.arm === 'treatment'), control: sessions.filter((s) => s.arm === 'control') };
if (groups.treatment.length === 0 || groups.control.length === 0) {
  console.error(`not enough comparable sessions: treatment ${groups.treatment.length}, control ${groups.control.length} (need >=${MIN_TURNS} usable turns each)`);
  process.exit(1);
}

const report = (name, list) => {
  const t = list.map((s) => s.tps);
  const ttfb = list.map((s) => s.ttfb).filter((x) => x !== null);
  console.log(`${name.padEnd(10)} sessions ${String(list.length).padStart(4)} · median tps p25 ${n0(q(t, 0.25))} p50 ${n0(med(t))} p75 ${n0(q(t, 0.75))} · TTFB p50 ${n0(med(ttfb))}ms · cache ${n0(med(list.map((s) => s.cacheHit).filter((x) => x !== null)))}% · error ${n0(mean(list.map((s) => s.failure)) * 100)}%`);
};

console.log(`# route A/B — ${path.relative(process.cwd(), EVENTS)}`);
console.log(`# ${turns.length} turn events · ${sessions.length} sessions with >=${MIN_TURNS} usable turns (out>=${MIN_OUT}, decode>=${MIN_DECODE}ms)`);
if (cutoff !== null) {
  console.log(`# 实验起点 ${new Date(cutoff).toISOString()} · 排除实验前已有会话 ${droppedForCutoff} 个`);
}
// A treatment session only counts as treated if the picker actually ran on it:
// a session that was already cache-locked keeps its natural route, so counting
// it as treatment dilutes the effect.
const routed = new Set(events
  .filter((e) => ['probe', 'probe-reject', 'probe-dead', 'pin', 'keep-natural'].includes(e.kind) && typeof e.sessionId === 'string')
  .map((e) => e.sessionId));
const treated = groups.treatment.filter((s) => routed.has(s.session));
const untouched = groups.treatment.length - treated.length;

console.log('');
report('treatment', groups.treatment);
report('treated', treated);
report('control', groups.control);

// Day-stratified bootstrap: resample sessions inside each day, so the arm
// comparison is made within the same days and daily gateway drift cancels.
const pick = (list, n) => Array.from({ length: n }, () => list[Math.floor(Math.random() * list.length)]);
function compareArms(aList, bList) {
  const days = [...new Set([...aList, ...bList].map((s) => s.day))].sort();
  const index = new Map(days.map((d) => [d, {
    a: aList.filter((s) => s.day === d),
    b: bList.filter((s) => s.day === d),
  }]));
  const ratios = [];
  const gains = [];
  for (let i = 0; i < BOOT; i += 1) {
    const a = [];
    const b = [];
    for (const d of days) {
      const cell = index.get(d);
      if (cell.a.length) a.push(...pick(cell.a, cell.a.length));
      if (cell.b.length) b.push(...pick(cell.b, cell.b.length));
    }
    if (!a.length || !b.length) continue;
    ratios.push(med(a.map((s) => s.tps)) / med(b.map((s) => s.tps)));
    gains.push(Math.exp(mean(a.map((s) => Math.log(s.tps))) - mean(b.map((s) => Math.log(s.tps)))));
  }
  ratios.sort((x, y) => x - y);
  gains.sort((x, y) => x - y);
  return {
    point: med(aList.map((s) => s.tps)) / med(bList.map((s) => s.tps)),
    lo: q(ratios, 0.025),
    hi: q(ratios, 0.975),
    gain: gains.length ? med(gains) : null,
    gainLo: q(gains, 0.025),
    gainHi: q(gains, 0.975),
    B: ratios.length,
  };
}

const itt = compareArms(groups.treatment, groups.control);
console.log(`\n会话级中位 tps 比值 treatment/control = ${n2(itt.point)}x  (day-stratified bootstrap 95% CI ${n2(itt.lo)}–${n2(itt.hi)}x, B=${itt.B})`);
console.log(`log-mean 比值 = ${n2(itt.gain)}x  (95% CI ${n2(itt.gainLo)}–${n2(itt.gainHi)}x)`);
if (treated.length > 0) {
  const pp = compareArms(treated, groups.control);
  console.log(`per-protocol（仅实际跑过选路的 ${treated.length} 个处理组会话）= ${n2(pp.point)}x  (95% CI ${n2(pp.lo)}–${n2(pp.hi)}x)`);
  console.log(`处理组中未实际处理的会话 ${untouched} 个（cache-locked，等价于对照）`);
}

// Integrity: a control session must never have produced probe traffic.
const probeSessions = new Set(events.filter((e) => e.kind === 'probe' || e.kind === 'probe-reject' || e.kind === 'probe-dead').map((e) => e.sessionId).filter(Boolean));
const violations = groups.control.filter((s) => probeSessions.has(s.session)).map((s) => s.session);
const pinnedControl = events.filter((e) => e.kind === 'pin' && groups.control.some((s) => s.session === e.sessionId));
console.log(`\n完整性: control 会话中探测过的 ${violations.length} 个 · 被 pin 的 ${pinnedControl.length} 个（应为 0）`);
if (violations.length) console.log(`  ${violations.slice(0, 5).join(', ')}…`);

// Verdict against the pre-registered rule.
console.log('\n## 判读');
if (groups.treatment.length < 20 || groups.control.length < 20) {
  console.log(`样本不足（${groups.treatment.length}/${groups.control.length} 会话），判读无效；先跑到 ≥20 会话/臂。`);
} else if (itt.lo > 1.05) {
  console.log(`有效：CI 下界 ${n2(itt.lo)}x > 1.05，且该方向与探测逻辑一致。`);
  if (treated.length > 0) console.log('per-protocol 口径见上：若它明显高于 ITT，说明效应集中在真正被选路的会话上。');
} else if (itt.hi < 1) {
  console.log(`负向：CI 上界 ${n2(itt.hi)}x < 1，选道在拖慢会话；检查 SHAPE_RANK 与缓存代价。`);
} else {
  const perArm = Math.min(groups.treatment.length, groups.control.length);
  const next = perArm >= 60
    ? '已到 60/臂仍跨 1，可以判定"当前数据不支持"'
    : perArm >= 34
      ? '补到 ≥60 会话/臂可把分辨率提到 1.1x'
      : perArm >= 20
        ? '补到 ≥34 会话/臂可检测 1.2x'
        : '先跑到 ≥20 会话/臂可判读';
  console.log(`无法证明：CI ${n2(itt.lo)}–${n2(itt.hi)}x 跨 1；${next}。`);
}

if (args.get('baseline')) {
  const base = readFileSync(String(args.get('baseline')), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const perSession = new Map();
  for (const row of base) {
    if (row.tps === null || row.out < MIN_OUT) continue;
    if (row.decodeMs !== null && row.decodeMs !== undefined && row.decodeMs < MIN_DECODE) continue;
    if (!perSession.has(row.session)) perSession.set(row.session, []);
    perSession.get(row.session).push(row.tps);
  }
  const meds = [...perSession.values()].filter((v) => v.length >= MIN_TURNS).map((v) => med(v)).filter((x) => x !== null);
  console.log(`\n## 基线对照（同一指标，历史窗口，仅作参考）`);
  console.log(`baseline   sessions ${String(meds.length).padStart(4)} · median tps p50 ${n0(med(meds))} · treatment/baseline ${n2(med(groups.treatment.map((s) => s.tps)) / med(meds))}x`);
  console.log('注意：基线是历史窗口，日间漂移未抵消，不能替代 control 臂。');
}
