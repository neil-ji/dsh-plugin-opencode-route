#!/usr/bin/env node
// Grid search for the reroll gate (windowMs, thresholdTps), measured on the
// first request of real sessions only — the only place the gate ever runs.
// Run: node research/tune_reroll.mjs
// Tune the abort-and-reroll parameters from real durable logs, with no plugin
// traffic of its own. For every assistant message it reconstructs the chunk
// timeline (`time0` + `dt[]`) and records the running rate at several early
// checkpoints beside the final rate. A grid search then scores each
// (window, threshold) pair by the final rate it would accept, the attempts it
// needs, and how often it rejects a call that would have been good.
import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : path.join(os.homedir(), '.dsh', 'sessions');
const PROVIDER = 'opencode-go';
const MODEL = 'deepseek-v4.1-flash';
const WINDOWS = [500, 800, 1000, 1500, 2000, 3000];
const THRESHOLDS = [80, 100, 120, 140, 150, 160, 180, 200];
const RETRIES = 3;
const TARGET = 150;

async function files(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await files(full, acc);
    else if (/^session\.v[34]\.jsonl\.zstd$/.test(e.name)) acc.push(full);
  }
  return acc;
}

function scan(file) {
  return new Promise((resolve) => {
    const child = spawn('zstd', ['-dc', file]);
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const steps = new Map();
    const rows = [];
    child.on('error', () => resolve(rows));
    rl.on('line', (line) => {
      if (!line.startsWith('{"type":"step/start"') && !line.startsWith('{"type":"assistant/message"')) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'step/start') { steps.set(`${ev.data?.turn}:${ev.data?.step}`, ev.time); return; }
      const d = ev.data ?? {};
      const src = d.message?.source ?? {};
      if (src.provider !== PROVIDER || src.model !== MODEL) return;
      const out = Number(d.usage?.outputTokens ?? 0);
      // The policy only ever runs on a session's first request, so tune on those.
      if (d.turn !== 1 || d.step !== 1) return;
      const stream = d.stream;
      if (!Array.isArray(stream) || out < 60) return;
      const times = [];
      for (const entry of stream) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.time0 === 'number' && Array.isArray(entry.dt)) {
          let t = entry.time0;
          for (const dt of entry.dt) { times.push(t); t += typeof dt === 'number' && dt >= 0 ? dt : 0; }
        } else if (typeof entry.time === 'number' && entry.chunk) {
          const type = entry.chunk.type;
          if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') times.push(entry.time);
        }
      }
      if (times.length < 10) return;
      times.sort((a, b) => a - b);
      const first = times[0];
      const last = times[times.length - 1];
      const decode = last - first;
      if (decode < 500) return;
      const row = { out, decode, final: Math.round((out * 1000) / decode), early: {} };
      // dt[] counts chunks, not tokens; each chunk carries out/len(times) tokens.
      const perChunk = out / times.length;
      for (const w of WINDOWS) {
        const span = Math.min(w, decode); // a stream shorter than the window is already done
        const until = first + span;
        let n = 0;
        for (const t of times) { if (t > until) break; n += 1; }
        row.early[w] = Math.round((n * perChunk * 1000) / span);
      }
      rows.push(row);
    });
    rl.on('close', () => resolve(rows));
  });
}

const all = await files(ROOT);
const stats = await Promise.all(all.map(async (f) => ({ f, m: (await stat(f)).mtimeMs })));
stats.sort((a, b) => b.m - a.m);
const recent = stats.slice(0, 400).map((s) => s.f);
const rows = [];
for (const f of recent) rows.push(...(await scan(f)));
console.log(`# ${rows.length} measured calls from ${recent.length} files`);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const finals = rows.map((r) => r.final);
console.log(`# final tps p10 ${q(finals, 0.1)} p50 ${q(finals, 0.5)} p90 ${q(finals, 0.9)} · >=${TARGET}: ${(finals.filter((x) => x >= TARGET).length / finals.length * 100).toFixed(0)}%`);

// Grid: simulate "accept the first attempt whose early rate >= T, else retry,
// up to RETRIES extra tries; if none passes, keep the last one".
const rand = (n) => Math.floor(Math.random() * n);
const out = [];
for (const w of WINDOWS) {
  for (const t of THRESHOLDS) {
    let accepted = 0, good = 0, attempts = 0, rejectGood = 0, acceptBad = 0;
    const finalsAfter = [];
    for (let i = 0; i < 2000; i += 1) {
      let chosen = null;
      let used = 0;
      for (let r = 0; r <= RETRIES; r += 1) {
        const row = rows[rand(rows.length)];
        used += 1;
        if (row.early[w] >= t) { chosen = row; break; }
        chosen = row;
      }
      attempts += used;
      finalsAfter.push(chosen.final);
      if (chosen.final >= TARGET) { good += 1; accepted += 1; }
      else {
        accepted += 1;
        // this accepted row had a low final but passed the gate
        acceptBad += 1;
      }
    }
    // false rejects: fraction of calls that pass final target but fail the gate
    const passFinal = rows.filter((r) => r.final >= TARGET);
    const falseReject = passFinal.length ? passFinal.filter((r) => r.early[w] < t).length / passFinal.length : 0;
    out.push({
      w, t,
      meanFinal: Math.round(mean(finalsAfter)),
      goodRate: +(good / accepted).toFixed(2),
      meanAttempts: +(attempts / accepted).toFixed(2),
      falseReject: +(falseReject * 100).toFixed(0),
    });
  }
}
out.sort((a, b) => (b.goodRate * 100 + b.meanFinal) - (a.goodRate * 100 + a.meanFinal));
console.log('\nwindow  thr  meanFinal  P(final>=150)  attempts  falseReject%');
for (const r of out.slice(0, 14)) {
  console.log(`${String(r.w).padStart(5)}  ${String(r.t).padStart(3)}  ${String(r.meanFinal).padStart(8)}  ${String(r.goodRate * 100).padStart(12)}  ${String(r.meanAttempts).padStart(8)}  ${String(r.falseReject).padStart(11)}`);
}
