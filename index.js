// OpenCode Go route picker.
//
// OpenCode Go routes each conversation by the client-supplied `x-opencode-session`
// header. A 2026-11-07 controlled experiment on this machine (68 requests, three
// rounds) showed the assignment is deterministic per id: the same random UUID kept
// landing on the same upstream 25 minutes later (fast stayed fast, one route stayed
// at 10-30 tok/s, four ids answered 429 "overloaded" every single time).
//
// This plugin exploits that: before a session's first model call it probes a few
// candidate ids, leases the best one from a shared pool, and pins it for that
// session by overriding `x-opencode-session`. Sub-agent sessions lease from the
// same pool, so a fan-out does not probe once per child.
//
// Scope is enforced: every listener and every probe checks the provider allowlist,
// and only `opencode-go` is enabled by default.
//
// It never reads credentials: probe calls go through ctx.llm, so the configured
// provider resolves its own key.

import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const name = 'opencode-route';
export const inject = ['llm'];

const DEFAULTS = {
  enabled: true,
  dryRun: false,
  providers: ['opencode-go'],
  models: [],
  logDir: '',
  probe: {
    enabled: true,
    candidates: 4,
    maxTokens: 96,
    timeoutMs: 25000,
    roundMaxMs: 8000,   // whole round, so one hung candidate cannot stall a request
    ttfbMaxMs: 5000,    // a candidate slower than this to first token is not worth pinning
    totalMaxMs: 15000,
    prompt: 'Write the integers from 1 to 40 in order, separated by single spaces, and nothing else.',
  },
  thresholds: {
    targetTps: 150,     // a probe at or above this stops the round immediately
    degradeTps: 70,     // a live response below this counts as a strike
    strikesToEvict: 2,
    degradeTtfbMs: 20000,
  },
  pool: {
    size: 4,
    ttlMs: 300000,      // an entry is worth leasing for five minutes
    negativeTtlMs: 60000, // when every candidate was dead, wait this long before probing again
    maxProbesPerHour: 40,
  },
  cache: {
    // Switching routes throws away the provider-side prompt cache: the next
    // request re-prefills the whole context at full input price. So a session is
    // pinned once, early, and then never moved on its own.
    lockAfterTurns: 2,
    lockAfterInputTokens: 20000,
    persistPins: true,
  },
  subagents: {
    mode: 'pool',       // pool | own
  },
  reroll: {
    // Abort-and-reroll on a session's first request: buffer a short window, and
    // if the running rate is below the threshold, drop the attempt and retry on
    // a fresh routing id. Off by default; the A/B arm decides who gets it.
    enabled: false,
    windowMs: 2000,
    thresholdTps: 150,
    maxRetries: 3,
    maxPromptTokens: 60000,
  },
  experiment: {
    // A/B for measuring the route effect. A session is assigned by a stable hash
    // of its id, so it never crosses arms: `treatment` probes and pins, `control`
    // does neither (no probe traffic, no header override), and both log `turn`
    // events carrying `arm`. Off by default: `arm` stays "off" and behaviour is
    // exactly the ordinary picker.
    enabled: false,
    armRatio: 0.5,      // share of sessions assigned to `treatment`
    salt: 'route-v1',   // fixed for one experiment; changing it reshuffles arms
  },
};

function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isTokenChunk(chunk) {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== '';
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined;
    default:
      return false;
  }
}

export function shapeOf(responseId) {
  if (!responseId) return 'none';
  if (responseId.startsWith('gw-')) return 'gw';
  if (responseId.startsWith('chatcmpl')) return 'chatcmpl';
  if (responseId.startsWith('msg_')) return 'msg';
  if (/^[0-9a-f]{32}$/.test(responseId)) return 'hex32';
  if (/^[0-9a-f]{40}$/.test(responseId)) return 'hex40';
  if (/^[0-9a-f]{48,56}$/.test(responseId)) return 'hex48';
  return 'other';
}

const pairKey = (provider, sessionId) => `${provider}\u0000${sessionId}`;
const poolKeyOf = (provider, model) => `${provider}\u0000${model}`;
// No single stream generates faster than this; above it the number is buffering.
const PLAUSIBLE_TPS = 1000;

// Per-session maps are advisory caches: cap them so a long-lived process cannot
// grow without bound. Pins get an age sweep instead of an order-based cap, so a
// session that is still in use never loses its route.
const MAP_CAP = 2000;
const STALE_MS = 86_400_000;
const PRUNE_MS = 600_000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;

const SHAPE_RANK = { gw: 0, hex32: 1, hex40: 1, hex48: 2, msg: 2, chatcmpl: 3, other: 3, none: 4 };

export function apply(ctx, config = {}) {
  const cfg = merge(DEFAULTS, config);
  const thresholds = cfg.thresholds;
  const poolCfg = cfg.pool;
  const probeCfg = cfg.probe;
  const cacheCfg = cfg.cache;
  const expCfg = cfg.experiment;

  /** @type {Map<string, {id: string, model: string, at: number, provider: string}>} */
  const pins = new Map();
  /** @type {Map<string, Array<{id: string, tps: number, shape: string, probedAt: number, lastOkAt: number, strikes: number, leasedTo: Set<string>, ttfbMs?: number}>>} */
  const pool = new Map();
  /** @type {Map<string, Promise<void>>} */
  const inflightProbes = new Map();
  /** @type {WeakSet<object>} */
  const probing = new WeakSet();
  const rerolling = new WeakSet();
  /** @type {Map<string, number>} */
  const negativeUntil = new Map();
  /** @type {Map<string, {tps: number, ttfb: number, n: number, lastInput: number}>} */
  const baselines = new Map();
  /** @type {Array<object>} */
  const recent = [];
  const counters = { requests: 0, probes: 0, probeRounds: 0, leases: 0, evictions: 0, failures: 0, slow: 0, keptNatural: 0, switched: 0 };
  /** @type {Map<string, {source: string, naturalTps: number, naturalShape: string, chosenTps: number}>} */
  const compare = new Map();
  let compareSummary = null;
  /** @type {Map<string, {status: string, tps: number, shape: string, ttfbMs: number|null}>} */
  const naturalProbe = new Map();
  /** @type {Map<string, {at: number, tps: number}>} */
  const naturalKeep = new Map();

  const logDir = cfg.logDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'opencode-route');
  const pinsPath = path.join(logDir, 'pins.json');
  let logReady = false;
  let logBytes = 0;
  let logQueue = Promise.resolve();
  let hourWindow = { start: Date.now(), count: 0 };
  let saveTimer;
  let probeState = { active: false, startedAt: 0, candidates: 0 };

  // Pins survive a restart: re-pinning a long context would cost one full
  // re-prefill per session, which is exactly what this file avoids.
  function savePins() {
    if (!cacheCfg.persistPins) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void (async () => {
        try {
          await mkdir(logDir, { recursive: true });
          const cutoff = Date.now() - 86_400_000;
          const rows = [...pins.entries()]
            .filter(([, pin]) => pin.at >= cutoff)
            .map(([key, pin]) => ({ key, ...pin }));
          await writeFile(pinsPath, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), pins: rows }, null, 2), 'utf8');
        } catch { /* persistence is best effort */ }
      })();
    }, 400);
    saveTimer.unref?.();
  }

  // Every pin decision waits for the restored pins, otherwise the first request
  // after a restart would look pinless, skip the header, and miss the cache.
  // `recent` and `baselines` are what the badge and the lock decision read; both
  // live in memory, so a restart used to show an existing session as "待选"
  // until its next turn. Replay the tail of the event log instead.
  async function restoreFromLog() {
    let raw;
    try { raw = await readFile(path.join(logDir, 'events.jsonl'), 'utf8'); } catch { return; }
    const cutoff = Date.now() - 86_400_000;
    const TAIL = 524_288;
    const tail = raw.length > TAIL ? raw.slice(-TAIL) : raw;
    const lines = tail.split('\n');
    if (tail.length !== raw.length) lines.shift(); // the first line is likely torn
    const turns = [];
    const compares = [];
    for (const line of lines) {
      if (line.length === 0 || line.charCodeAt(0) !== 123) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.sessionId !== 'string' || typeof row?.provider !== 'string') continue;
      if (typeof row.ts !== 'string' || Date.parse(row.ts) < cutoff) continue;
      if (row.kind === 'turn') turns.push(row);
      else if (row.kind === 'compare') compares.push(row);
    }
    for (const row of turns.slice(-200)) recent.push(row);
    for (const row of turns) {
      const key = pairKey(row.provider, row.sessionId);
      const prev = baselines.get(key);
      baselines.set(key, {
        tps: typeof row.tps === 'number' ? row.tps : (prev?.tps ?? 0),
        ttfb: typeof row.ttfbMs === 'number' ? row.ttfbMs : (prev?.ttfb ?? 0),
        n: (prev?.n ?? 0) + 1,
        lastInput: Number(row.inputTokens ?? 0) + Number(row.cacheReadTokens ?? 0),
        at: Number.isNaN(Date.parse(row.ts)) ? Date.now() : Date.parse(row.ts),
        out: (prev?.out ?? 0) + (Number(row.decodeMs ?? 0) > 0 ? Number(row.out ?? 0) : 0),
        decode: (prev?.decode ?? 0) + Number(row.decodeMs ?? 0),
      });
    }
    for (const row of compares) {
      compare.set(pairKey(row.provider, row.sessionId), {
        at: Date.now(),
        source: String(row.source ?? 'probe'),
        naturalTps: Number(row.naturalTps ?? 0),
        naturalShape: String(row.naturalShape ?? 'none'),
        chosenTps: Number(row.chosenTps ?? 0),
      });
      compareSummary = null;
    }
    capMap(baselines);
    capMap(compare);
  }

  let resolvePinsReady;
  const pinsReady = new Promise((resolve) => { resolvePinsReady = resolve; });
  // A status call can arrive before the pin/log restore finishes; answering then
  // would report "idle" and flip to "pinned" a moment later. Wait for the store,
  // bounded so a broken one cannot hang the endpoint.
  const statusReady = Promise.race([
    pinsReady,
    new Promise((resolve) => { const timer = setTimeout(resolve, 2000); timer?.unref?.(); }),
  ]);
  void (async () => {
    try {
      if (cacheCfg.persistPins) {
        const raw = await readFile(pinsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const cutoff = Date.now() - 86_400_000;
        for (const row of parsed?.pins ?? []) {
          if (typeof row?.key !== 'string' || typeof row?.id !== 'string') continue;
          if (typeof row.at === 'number' && row.at < cutoff) continue;
          pins.set(row.key, { id: row.id, model: String(row.model ?? ''), at: Number(row.at ?? 0), provider: String(row.provider ?? ''), probeTps: Number(row.probeTps ?? 0) });
        }
        capMap(pins);
      }
    } catch { /* first run */ }
    try { await restoreFromLog(); } catch { /* a broken log must not block startup */ }
    resolvePinsReady?.();
  })();

  const isScope = (provider, model) =>
    cfg.enabled
    && Array.isArray(cfg.providers) && cfg.providers.includes(provider)
    && (cfg.models.length === 0 || cfg.models.includes(model));

  // A session's arm is a pure function of its id: deterministic across restarts
  // and independent of request order, so a session cannot drift between arms.
  function armOf(sessionId) {
    if (!expCfg?.enabled) return 'off';
    const digest = createHash('sha256').update(`${expCfg.salt}:${String(sessionId)}`).digest();
    return digest.readUInt32BE(0) / 2 ** 32 < expCfg.armRatio ? 'treatment' : 'control';
  }

  function capMap(map) {
    while (map.size > MAP_CAP) map.delete(map.keys().next().value);
  }

  function pruneStale() {
    const cutoff = Date.now() - STALE_MS;
    for (const [key, pin] of pins) if ((pin.at ?? 0) < cutoff) pins.delete(key);
    for (const [key, base] of baselines) if ((base.at ?? 0) < cutoff) baselines.delete(key);
  }

  function log(record) {
    const row = { ts: new Date().toISOString(), ...record };
    recent.push(row);
    if (recent.length > 200) recent.shift();
    const line = `${JSON.stringify(row)}\n`;
    // Serialize writes: one chain orders the lines and makes rotation safe. The
    // byte count tracks what actually reached the file, not what is queued,
    // otherwise a burst would rotate before the file exists.
    logQueue = logQueue.then(async () => {
      try {
        if (!logReady) { await mkdir(logDir, { recursive: true }); logReady = true; }
        const file = path.join(logDir, 'events.jsonl');
        if (logBytes > LOG_MAX_BYTES) {
          try {
            await rm(path.join(logDir, 'events.1.jsonl'), { force: true });
            await rename(file, path.join(logDir, 'events.1.jsonl'));
          } catch { /* a missing file just means nothing to rotate */ }
          logBytes = 0;
        }
        await appendFile(file, line, 'utf8');
        logBytes += Buffer.byteLength(line);
      } catch { /* logging must never break a request */ }
    });
  }

  function probesThisHour() {
    const now = Date.now();
    if (now - hourWindow.start > 3_600_000) hourWindow = { start: now, count: 0 };
    return hourWindow.count;
  }

  function freshEntries(poolKey) {
    const now = Date.now();
    return (pool.get(poolKey) ?? []).filter((entry) => now - entry.probedAt <= poolCfg.ttlMs);
  }

  function pickEntry(poolKey, sessionId) {
    const entries = freshEntries(poolKey);
    if (entries.length === 0) return undefined;
    return [...entries].sort((a, b) => {
      const loadA = a.leasedTo.size - (a.leasedTo.has(sessionId) ? 1 : 0);
      const loadB = b.leasedTo.size - (b.leasedTo.has(sessionId) ? 1 : 0);
      if (loadA !== loadB) return loadA - loadB;
      const scoreA = entryScore(a);
      const scoreB = entryScore(b);
      if (scoreA !== scoreB) return scoreB - scoreA;
      const ttfbA = a.ttfbMs ?? Infinity;
      const ttfbB = b.ttfbMs ?? Infinity;
      if (ttfbA !== ttfbB) return ttfbA - ttfbB;
      return (SHAPE_RANK[a.shape] ?? 9) - (SHAPE_RANK[b.shape] ?? 9);
    })[0];
  }

  function releaseLease(sessionId) {
    for (const entries of pool.values()) for (const entry of entries) entry.leasedTo.delete(sessionId);
  }

  function invalidateId(id, reason) {
    let removed = false;
    for (const [poolKey, entries] of pool) {
      const kept = entries.filter((entry) => entry.id !== id);
      if (kept.length !== entries.length) { pool.set(poolKey, kept); removed = true; }
    }
    // A shared route is leased by several sessions, so one failure can drop the
    // pins of sessions that did nothing wrong. Keep the list in the event log:
    // the A/B analysis needs to know how often that diluted the treatment arm.
    const unpinned = [];
    for (const [pinKey, pin] of pins.entries()) {
      if (pin.id !== id) continue;
      unpinned.push(pinKey.slice(pinKey.indexOf('\u0000') + 1));
      pins.delete(pinKey);
    }
    savePins();
    if (removed) counters.evictions += 1;
    if (removed || unpinned.length > 0) {
      log({
        kind: 'evict',
        id,
        reason,
        unpinnedSessions: unpinned.length,
        unpinned: unpinned.slice(0, 20),
      });
    }
  }

  async function probeOne(provider, model, candidateId, roundSignal) {
    const timeout = AbortSignal.timeout(probeCfg.timeoutMs);
    const signal = roundSignal !== undefined && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeout, roundSignal])
      : timeout;
    const options = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: probeCfg.prompt }] }],
      maxTokens: probeCfg.maxTokens,
      sessionId: candidateId,
      signal,
    };
    probing.add(options);
    counters.probes += 1;
    hourWindow.count += 1;
    let first = null;
    let usage = null;
    let finish = null;
    const t0 = performance.now();
    let endedAt = null;
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (isTokenChunk(chunk)) {
          if (first === null) first = performance.now();
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        } else if (chunk.type === 'finish') {
          finish = chunk;
          endedAt = performance.now();
        }
      }
    } catch (error) {
      return { id: candidateId, alive: false, reason: error?.message ?? String(error) };
    }
    const reason = finish?.reason;
    const ttfbMs = first === null ? null : Math.round(first - t0);
    if (reason?.kind === 'error' || reason?.kind === 'aborted') {
      return { id: candidateId, alive: false, reason: reason.failure?.code ?? reason.kind, ttfbMs };
    }
    const out = usage?.outputTokens ?? 0;
    const end = endedAt ?? performance.now();
    const decodeMs = first === null ? 0 : end - first;
    if (out <= 0 || decodeMs <= 0) return { id: candidateId, alive: false, reason: 'no-output', ttfbMs };
    // Streaming can arrive in a burst, so a short window says nothing about speed.
    const measured = out >= 24 && decodeMs >= 500;
    const tps = measured ? (out * 1000) / decodeMs : null;
    const responseId = finish?.replayState?.response?.responseId ?? null;
    return {
      id: candidateId,
      alive: true,
      measured,
      tps,
      shape: shapeOf(responseId),
      out,
      ttfbMs,
      totalMs: Math.round(end - t0),
    };
  }

  // A probe that delivered its tokens in under 500 ms cannot be measured
  // reliably, but it did move that many tokens inside that window, so
  // out * 1000 / 500 is a burst-proof lower bound. Ranking uses this score;
  // the response id's shape is only a last-resort tie-break. The shape used to
  // be the primary key (`gw` first, often without a measurement); 18 days of
  // local data showed `gw` was the slowest of the four common shapes, so that
  // preference is gone (see research/README.md).
  const NOMINAL_WINDOW_MS = 500;

  function lowerBoundTps(result) {
    return (result.out * 1000) / NOMINAL_WINDOW_MS;
  }

  function scoreOf(result) {
    return result.measured === true && typeof result.tps === 'number' ? result.tps : lowerBoundTps(result);
  }

  function entryScore(entry) {
    return typeof entry.tps === 'number' && entry.tps > 0 ? entry.tps : (entry.lowerTps ?? 0);
  }

  // A candidate is only worth pinning when it looks good on its own merits; when
  // every candidate is on a saturated upstream, pinning nothing is the safe move.
  // A window too short to measure is admitted on liveness alone (there is no
  // evidence it is bad) but still ranks by its conservative lower bound, so it
  // only wins when it can prove it is faster.
  function admittable(result) {
    if (!result.alive) return false;
    if (result.ttfbMs === null || result.ttfbMs > probeCfg.ttfbMaxMs) return false;
    if (result.totalMs > probeCfg.totalMaxMs) return false;
    if (result.measured !== true) return result.out >= 24;
    return result.tps !== null && result.tps >= thresholds.degradeTps;
  }

  async function probeRound(provider, model, sessionId) {
    counters.probeRounds += 1;
    probeState = { active: true, startedAt: Date.now(), candidates: probeCfg.candidates };
    try {
      await probeRoundInner(provider, model, sessionId);
    } finally {
      probeState = { active: false, startedAt: 0, candidates: 0 };
    }
  }

  async function probeRoundInner(provider, model, sessionId) {
    const poolKey = poolKeyOf(provider, model);
    // The session's own id is candidate zero: it is the counterfactual "what you
    // would have got without this plugin", and when it is already good the round
    // stops there and the session is never moved (so its cache stays warm).
    const candidates = [sessionId, ...Array.from({ length: Math.max(1, probeCfg.candidates) }, () => `session-${randomUUID()}`)]
      .filter((id, index, all) => typeof id === 'string' && all.indexOf(id) === index);
    const alive = [];
    // One hung candidate must not stall the request that triggered the round:
    // bound the whole round and let the abort signal reach the in-flight probe.
    const controller = new AbortController();
    const roundMs = Math.max(1000, probeCfg.roundMaxMs ?? 8000);
    const deadline = Date.now() + roundMs;
    const timer = setTimeout(() => controller.abort(), roundMs);
    timer?.unref?.();
    try {
      for (const candidateId of candidates) {
        if (controller.signal.aborted || Date.now() > deadline - 500) break;
        if (probesThisHour() >= poolCfg.maxProbesPerHour) break;
        const result = await probeOne(provider, model, candidateId, controller.signal);
        const isNatural = candidateId === sessionId;
        if (isNatural) {
          naturalProbe.set(pairKey(provider, sessionId), {
            status: result.alive ? (admittable(result) ? 'ok' : 'rejected') : 'dead',
            tps: result.tps === null || result.tps === undefined ? 0 : Math.round(result.tps),
            shape: result.shape ?? 'none',
            ttfbMs: result.ttfbMs ?? null,
          });
          capMap(naturalProbe);
        }
        if (result.alive) {
          const ok = admittable(result);
          log({
            kind: ok ? 'probe' : 'probe-reject',
            provider, model, sessionId, id: candidateId, natural: candidateId === sessionId, shape: result.shape,
            tps: result.tps === null ? null : Math.round(result.tps),
            ttfbMs: result.ttfbMs, totalMs: result.totalMs, measured: result.measured,
          });
          if (ok) {
            alive.push(result);
            // One rule for every shape: stop when this candidate already reaches
            // the target. A slow `gw` no longer ends the search early.
            if (scoreOf(result) >= thresholds.targetTps) break;
          }
        } else {
          log({ kind: 'probe-dead', provider, model, sessionId, id: candidateId, natural: candidateId === sessionId, reason: result.reason });
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const now = Date.now();
    const entries = alive
      .sort((a, b) => {
        const scoreA = scoreOf(a);
        const scoreB = scoreOf(b);
        if (scoreA !== scoreB) return scoreB - scoreA;
        const ttfbA = a.ttfbMs ?? Infinity;
        const ttfbB = b.ttfbMs ?? Infinity;
        if (ttfbA !== ttfbB) return ttfbA - ttfbB;
        return (SHAPE_RANK[a.shape] ?? 9) - (SHAPE_RANK[b.shape] ?? 9);
      })
      .slice(0, poolCfg.size)
      .map((result) => ({
        id: result.id,
        tps: result.tps ?? 0,
        // Zero when the probe was measurable; otherwise the conservative lower
        // bound that ranked it, so the pool keeps a usable speed after a restart
        // of the round without pretending it is a measurement.
        lowerTps: result.measured === true ? 0 : Math.round(lowerBoundTps(result)),
        shape: result.shape,
        probedAt: now,
        lastOkAt: now,
        strikes: 0,
        leasedTo: new Set(sessionId ? [sessionId] : []),
        ttfbMs: result.ttfbMs,
      }));
    if (entries.length > 0) {
      pool.set(poolKey, entries);
      negativeUntil.delete(poolKey);
    } else {
      negativeUntil.set(poolKey, now + poolCfg.negativeTtlMs);
    }
    log({ kind: 'probe-round', provider, model, sessionId, alive: entries.length, ids: entries.map((entry) => entry.id) });
  }

  async function ensurePool(poolKey, provider, model, sessionId) {
    if (freshEntries(poolKey).length > 0) return;
    if (!probeCfg.enabled) return;
    const blockedUntil = negativeUntil.get(poolKey) ?? 0;
    if (Date.now() < blockedUntil) return;
    const running = inflightProbes.get(poolKey);
    if (running !== undefined) { await running; return; }
    const round = probeRound(provider, model, sessionId).finally(() => inflightProbes.delete(poolKey));
    inflightProbes.set(poolKey, round);
    await round;
  }

  // Context already on the wire, so a mid-session install can refuse to move a
  // session that would pay a large re-prefill.
  function contextTokens(sessionId) {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId);
      if (agent === undefined) return 0;
      const pressure = ctx.get('tokenMeter')?.contextPressure?.(agent.session);
      return pressure?.pressureTokens ?? 0;
    } catch { return 0; }
  }

  // Probe results are optimistic: a 64-token burst can look 2x faster than the
  // real request. A misestimate is corrected once, while the context is cheap.
  const repinAllowance = new Map();
  const inflightPins = new Map();

  async function ensurePin(provider, model, sessionId, signal) {
    // The reroll experiment replaces the picker entirely: treatment rerolls the
    // first request, control does nothing, and no probe traffic runs at all.
    if (cfg.reroll?.enabled) return undefined;
    if (armOf(sessionId) === 'control') return undefined;
    const key = pairKey(provider, sessionId);
    await pinsReady;
    const existing = pins.get(key);
    const kept = naturalKeep.get(key);
    if (kept !== undefined && Date.now() - kept.at < 600000) return undefined;
    // A session keeps its route for as long as it lives: every switch costs one
    // full re-prefill of the whole context, which is the expensive thing here.
    if (existing !== undefined && existing.model === model) return existing.id;
    // A model switch is the only thing that moves a pinned session on its own;
    // otherwise the picker is fully automatic (there is no manual re-pick).
    if (existing !== undefined) invalidateId(existing.id, 'model-changed');
    const running = inflightPins.get(key);
    if (running !== undefined) return running;
    const work = ensurePinWork(provider, model, sessionId, signal).finally(() => inflightPins.delete(key));
    inflightPins.set(key, work);
    return work;
  }

  async function ensurePinWork(provider, model, sessionId, signal) {
    const key = pairKey(provider, sessionId);
    const baseline = baselines.get(key);
    const liveTokens = contextTokens(sessionId);
    // A session's first request has no prompt cache on the provider side yet,
    // whatever the prompt size, so switching routes costs nothing there. Only a
    // session that already called the model has a cache worth protecting.
    const hasHistory = baseline !== undefined && (baseline.n ?? 0) > 0;
    const locked = hasHistory
      && (baseline.n >= cacheCfg.lockAfterTurns
        || (baseline.lastInput ?? 0) >= cacheCfg.lockAfterInputTokens
        || liveTokens >= cacheCfg.lockAfterInputTokens);
    if (locked) {
      log({
        kind: 'skip-pin', provider, model, sessionId, reason: 'cache-locked',
        turns: baseline?.n ?? 0, lastInput: baseline?.lastInput ?? 0, liveTokens,
      });
      return undefined;
    }
    const poolKey = poolKeyOf(provider, model);
    const work = (async () => {
      await ensurePool(poolKey, provider, model, sessionId);
      const entry = pickEntry(poolKey, sessionId);
      if (entry === undefined) return undefined;
      if (entry.id === sessionId) {
        // The session's own route won the round: pin nothing, keep the cache.
        const naturalEntry = (pool.get(poolKey) ?? []).find((row) => row.id === sessionId);
        counters.keptNatural += 1;
        naturalKeep.set(key, { at: Date.now(), tps: Math.round(entry.tps ?? 0) });
        capMap(naturalKeep);
        compare.set(pairKey(provider, sessionId), {
          source: 'natural',
          naturalTps: Math.round(naturalEntry?.tps ?? entry.tps ?? 0),
          naturalShape: naturalEntry?.shape ?? entry.shape,
          chosenTps: Math.round(entry.tps ?? 0),
        });
        compareSummary = null;
        capMap(compare);
        log({
          kind: 'keep-natural', provider, model, sessionId,
          tps: Math.round(entry.tps ?? 0), shape: entry.shape, ttfbMs: entry.ttfbMs ?? null,
        });
        log({
          kind: 'compare', provider, model, sessionId, source: 'natural',
          naturalStatus: naturalProbe.get(key)?.status ?? 'unknown',
          naturalTps: Math.round(naturalEntry?.tps ?? entry.tps ?? 0),
          naturalShape: naturalEntry?.shape ?? entry.shape,
          chosenTps: Math.round(entry.tps ?? 0), chosenShape: entry.shape,
        });
        return undefined;
      }
      // Never replace a route that is already working with a demonstrably worse one.
      if (baseline !== undefined && baseline.ttfb > 0 && entry.ttfbMs !== undefined) {
        const worseTtfb = entry.ttfbMs > baseline.ttfb * 1.2;
        const notFaster = (entry.tps ?? 0) < baseline.tps * 1.1;
        if (worseTtfb && notFaster) {
          log({
            kind: 'skip-pin', provider, model, sessionId, id: entry.id,
            reason: 'worse-than-baseline', entryTtfbMs: entry.ttfbMs, baselineTtfbMs: Math.round(baseline.ttfb),
            entryTps: Math.round(entry.tps ?? 0), baselineTps: Math.round(baseline.tps),
          });
          return undefined;
        }
      }
      releaseLease(sessionId);
      entry.leasedTo.add(sessionId);
      counters.leases += 1;
      return entry.id;
    })();
    const deadline = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), Math.max(2000, probeCfg.timeoutMs * Math.max(1, probeCfg.candidates)));
      timer.unref?.();
      signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    });
    const id = await Promise.race([work.catch(() => undefined), deadline]);
    if (typeof id !== 'string' || id.length === 0) return undefined;
    let probeTps = 0;
    for (const entries of pool.values()) for (const entry of entries) if (entry.id === id) probeTps = entry.tps;
    const naturalEntry = (pool.get(poolKeyOf(provider, model)) ?? []).find((row) => row.id === sessionId);
    counters.switched += 1;
    compare.set(key, {
      source: 'probe',
      naturalTps: Math.round(naturalEntry?.tps ?? 0),
      naturalShape: naturalEntry?.shape ?? 'none',
      chosenTps: Math.round(probeTps),
    });
    compareSummary = null;
    capMap(compare);
    pins.set(key, { id, model, at: Date.now(), provider, probeTps });
    capMap(pins);
    naturalKeep.delete(key);
    savePins();
    log({
      kind: 'compare', provider, model, sessionId, source: 'probe',
      naturalStatus: naturalProbe.get(key)?.status ?? 'unknown',
      naturalTps: Math.round(naturalEntry?.tps ?? 0),
      naturalShape: naturalEntry?.shape ?? 'none',
      chosenTps: Math.round(probeTps), chosenShape: entryShapeOf(id),
    });
    log({ kind: 'pin', provider, model, sessionId, id });
    return id;
  }

  function noteSuccess(id, tps, shape, provider, model, ttfbMs, locked) {
    for (const entries of pool.values()) {
      for (const entry of entries) {
        if (entry.id !== id) continue;
        entry.lastOkAt = Date.now();
        entry.tps = entry.tps * 0.6 + tps * 0.4;
        entry.strikes = 0;
        if (shape !== 'none') entry.shape = shape;
      }
    }
    const slow = tps < thresholds.degradeTps;
    const late = ttfbMs !== null && ttfbMs !== undefined && ttfbMs > thresholds.degradeTtfbMs;
    if (!slow && !late) return;
    // Once a session owns a large cached prefix, moving it costs a full re-prefill;
    // a slow turn is cheaper than that. Only hard failures move a locked session.
    if (locked) {
      counters.slow += 1;
      log({ kind: 'cache-locked-slow', provider, model, id, tps: Math.round(tps), ttfbMs: ttfbMs ?? null });
      return;
    }
    counters.slow += 1;
    for (const entries of pool.values()) {
      for (const entry of entries) {
        if (entry.id !== id) continue;
        if (late && ttfbMs > thresholds.degradeTtfbMs * 2) {
          invalidateId(id, `ttfb:${Math.round(ttfbMs)}ms`);
          continue;
        }
        entry.strikes += 1;
        if (entry.strikes >= thresholds.strikesToEvict) {
          invalidateId(id, slow ? `slow:${Math.round(tps)}tps` : `ttfb:${Math.round(ttfbMs)}ms`);
        }
      }
    }
    void provider; void model;
  }

  function noteFailure(id, code, provider, model) {
    counters.failures += 1;
    const evict = code === undefined
      || /RATE_LIMIT|OVERLOAD|UNAVAILABLE|SERVER|TIMEOUT|EMPTY_RESPONSE|QUOTA/.test(String(code));
    if (evict && id !== undefined) invalidateId(id, `failure:${code ?? 'unknown'}`);
    void provider; void model;
  }

  // ---- one model call -----------------------------------------------------
  function chunkChars(chunk) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text.length;
    if (chunk.type === 'tool-call-delta') return (chunk.argumentsDelta?.length ?? 0) + (chunk.name?.length ?? 0);
    return 0;
  }

  function mergedSignal(a, b) {
    if (a === undefined) return b;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
    return b;
  }

  // Buffers the first window of the accepted attempt, so an aborted attempt is
  // never shown. `timing` reports the real first/last token of the accepted
  // stream to the guard, whose own timestamps would otherwise start at the
  // flush (2 s late).
  async function* reroll(options, next, timing) {
    const windowMs = Math.max(300, Math.min(10000, Number(cfg.reroll.windowMs ?? 2000)));
    const threshold = Math.max(10, Number(cfg.reroll.thresholdTps ?? 150));
    const maxRetries = Math.max(0, Math.min(6, Number(cfg.reroll.maxRetries ?? 3)));
    let attempt = 0;
    while (true) {
      const own = attempt > 0;
      const id = own ? `session-${randomUUID()}` : options.sessionId;
      const controller = new AbortController();
      const o2 = own ? { ...options, sessionId: id, signal: mergedSignal(options.signal, controller.signal) } : options;
      if (own) rerolling.add(o2);
      const attemptStart = performance.now();
      const iterator = (own ? ctx.llm.stream(o2) : next())[Symbol.asyncIterator]();
      const buffered = [];
      let first = null;
      let last = null;
      let chars = 0;
      let slow = false;
      let early = null;
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done === true) break;
          const chunk = step.value;
          if (isTokenChunk(chunk)) {
            const now = performance.now();
            if (first === null) first = now;
            last = now;
            chars += chunkChars(chunk);
            buffered.push(chunk);
            if (early === null && now - first >= windowMs) {
              early = Math.round((chars / 4) / ((now - first) / 1000));
              if (early < threshold) { slow = true; break; }
            }
          } else {
            buffered.push(chunk);
          }
        }
      } finally {
        if (slow) {
          try { await iterator.return?.(); } catch { /* stop consuming */ }
          if (own) controller.abort();
        }
      }
      const retry = slow && attempt < maxRetries;
      if (retry) {
        log({
          kind: 'reroll', provider: options.provider, model: options.model,
          sessionId: options.sessionId, attempt, id, early, aborted: true, final: null,
        });
        attempt += 1;
        continue;
      }
      // Accept: flush the buffer, then stream the rest with the real timing.
      timing.first = first;
      timing.last = last;
      timing.start = attemptStart;
      for (const chunk of buffered) yield chunk;
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        const chunk = step.value;
        if (isTokenChunk(chunk)) {
          const now = performance.now();
          if (first === null) first = now;
          last = now;
          chars += chunkChars(chunk);
        }
        yield chunk;
      }
      timing.first = first;
      timing.last = last;
      log({
        kind: 'reroll', provider: options.provider, model: options.model,
        sessionId: options.sessionId, attempt, id, early, aborted: false,
        final: first !== null && last !== null && last > first ? Math.round((chars / 4) * 1000 / (last - first)) : null,
      });
      return;
    }
  }

  async function* guard(options, next) {
    const provider = options.provider;
    const model = options.model;
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    const arm = sessionId === undefined ? 'off' : armOf(sessionId);
    let pinnedId;
    const timing = { first: null, last: null, start: null };
    const baseline = sessionId === undefined ? undefined : baselines.get(pairKey(provider, sessionId));
    const useReroll = Boolean(cfg.reroll?.enabled)
      && !cfg.dryRun
      && arm === 'treatment'
      && sessionId !== undefined
      && (baseline?.n ?? 0) === 0
      && pins.get(pairKey(provider, sessionId)) === undefined
      && contextTokens(sessionId) <= Number(cfg.reroll.maxPromptTokens ?? 60000);
    if (sessionId !== undefined && !cfg.dryRun && arm !== 'control' && !useReroll) {
      try {
        pinnedId = await ensurePin(provider, model, sessionId, options.signal);
      } catch { pinnedId = undefined; }
    }
    const iterator = (useReroll ? reroll(options, next, timing) : next())[Symbol.asyncIterator]();
    let first = null;
    let last = null;
    let usage = null;
    let finish = null;
    let failed;
    const t0 = performance.now();
    try {
      while (true) {
        const step = await iterator.next();
        if (step.done === true) break;
        const chunk = step.value;
        if (isTokenChunk(chunk)) {
          const now = performance.now();
          if (first === null) first = now;
          last = now;
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        } else if (chunk.type === 'finish') {
          finish = chunk;
        }
        yield chunk;
      }
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      counters.requests += 1;
      const reason = finish?.reason;
      const responseId = finish?.replayState?.response?.responseId ?? null;
      const shape = shapeOf(responseId);
      const out = usage?.outputTokens ?? 0;
      const firstAt = timing.first ?? first;
      const lastAt = timing.last ?? last;
      const genMs = firstAt !== null && lastAt !== null ? lastAt - firstAt : 0;
      // A short window is a delivery burst, not a generation rate: 47 tokens in
      // 7 ms is not 6,700 tok/s. A long window is not enough either — 1,608
      // tokens buffered in 692 ms reads as 2,322 tok/s — so the implied rate must
      // also be physically plausible. Keep decodeMs/out for diagnostics.
      const rate = genMs > 0 ? (out * 1000) / genMs : 0;
      const measurable = genMs >= 500 && out >= 60 && rate <= PLAUSIBLE_TPS;
      const tps = measurable ? rate : null;
      const kind = reason?.kind ?? (failed !== undefined ? 'thrown' : 'none');
      const ttfbMs = firstAt === null ? null : Math.round(firstAt - (timing.start ?? t0));
      const inputTokens = usage?.inputTokens ?? 0;
      const cacheReadTokens = usage?.cacheReadTokens ?? 0;
      const cacheBase = inputTokens + cacheReadTokens;
      const cacheHit = cacheBase > 0 ? cacheReadTokens / cacheBase : null;
      // Update the baseline first so the turn can record whether the session is
      // locked: the analyzer needs to separate "treatment that was actually
      // routed" from "treatment that was already cache-locked".
      let locked = false;
      if (sessionId !== undefined) {
        const key = pairKey(provider, sessionId);
        const base = baselines.get(key);
        // DSH's own footer is a weighted session rate (total output / total
        // decode), which is why it never shows a burst: keep the same sums.
        const next = base === undefined
          ? { tps: tps ?? 0, ttfb: ttfbMs ?? 0, n: 1, lastInput: cacheBase, out: genMs > 0 ? out : 0, decode: genMs > 0 ? genMs : 0, at: Date.now() }
          : {
            tps: tps === null ? base.tps : base.tps * 0.6 + tps * 0.4,
            ttfb: ttfbMs === null ? base.ttfb : base.ttfb * 0.6 + ttfbMs * 0.4,
            n: base.n + 1,
            lastInput: cacheBase,
            at: Date.now(),
            out: (base.out ?? 0) + (genMs > 0 ? out : 0),
            decode: (base.decode ?? 0) + (genMs > 0 ? genMs : 0),
          };
        baselines.set(key, next);
        capMap(baselines);
        locked = next.n >= cacheCfg.lockAfterTurns || next.lastInput >= cacheCfg.lockAfterInputTokens;
      }
      log({
        kind: 'turn',
        provider,
        model,
        sessionId,
        arm,
        pinnedId: pinnedId ?? null,
        locked,
        shape,
        out,
        tps: tps === null ? null : Math.round(tps),
        decodeMs: genMs > 0 ? Math.round(genMs) : null,
        ttfbMs,
        inputTokens,
        cacheReadTokens,
        cacheHit: cacheHit === null ? null : Math.round(cacheHit * 100),
        finish: kind,
        failure: reason?.failure?.code ?? null,
      });
      if (pinnedId !== undefined) {
        if (kind === 'error' || kind === 'thrown') noteFailure(pinnedId, reason?.failure?.code, provider, model);
        else if (tps !== null) noteSuccess(pinnedId, tps, shape, provider, model, ttfbMs, locked);
      }
      // A short probe can read ~2x faster than the real request. While the
      // context is still cheap, take one corrective switch instead of living
      // with a route that measurably underperforms its own probe.
      if (pinnedId === undefined && sessionId !== undefined && kind !== 'error' && kind !== 'thrown' && tps !== null && out >= 60) {
        const keepKey = pairKey(provider, sessionId);
        const kept = naturalKeep.get(keepKey);
        const keepBase = baselines.get(keepKey);
        if (kept !== undefined
          && tps < thresholds.degradeTps
          && (keepBase?.n ?? 0) <= 3
          && (repinAllowance.get(keepKey) ?? 0) < 1) {
          repinAllowance.set(keepKey, 1);
          capMap(repinAllowance);
          naturalKeep.delete(keepKey);
          log({
            kind: 'natural-slow', provider, model, sessionId,
            probeTps: kept.tps, realTps: Math.round(tps),
          });
        }
      }
      if (pinnedId !== undefined && sessionId !== undefined && kind !== 'error' && kind !== 'thrown' && tps !== null && out >= 60) {
        const key = pairKey(provider, sessionId);
        const pin = pins.get(key);
        const base = baselines.get(key);
        const early = (base?.n ?? 0) <= 2 && (base?.lastInput ?? 0) < cacheCfg.lockAfterInputTokens;
        const probeTps = pin?.probeTps ?? 0;
        const allowed = (repinAllowance.get(key) ?? 0) < 1;
        if (early && allowed && probeTps >= 100 && tps < probeTps * 0.6 && tps < thresholds.targetTps) {
          repinAllowance.set(key, 1);
          capMap(repinAllowance);
          log({
            kind: 'corrective-repin', provider, model, sessionId, id: pinnedId,
            reason: 'probe-overestimated', probeTps: Math.round(probeTps), realTps: Math.round(tps),
          });
          invalidateId(pinnedId, `misestimate:probe${Math.round(probeTps)}-real${Math.round(tps)}`);
        }
      }
    }
  }

  ctx.on('llm/stream', (options, next) => {
    try {
      if (rerolling.has(options)) return next();
      if (!isScope(options.provider, options.model) || probing.has(options)) return next();
      return guard(options, next);
    } catch {
      return next();
    }
  });

  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    const out = next();
    try {
      if (cfg.dryRun || !cfg.enabled) return out;
      if (!isScope(request.provider, request.model)) return out;
      if (request.sessionId === undefined) return out;
      // A control session never receives a pin, even if one survived from an
      // earlier run with the experiment disabled.
      if (armOf(request.sessionId) === 'control') return out;
      const pin = pins.get(pairKey(request.provider, request.sessionId));
      if (pin !== undefined && !out.has('x-opencode-session')) out.set('x-opencode-session', pin.id);
    } catch { /* never break header preparation */ }
    return out;
  });

  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.session?.id;
    if (id === undefined) return;
    for (const provider of cfg.providers) pins.delete(pairKey(provider, String(id)));
    releaseLease(String(id));
  });

  function entryShapeOf(id) {
    for (const entries of pool.values()) for (const entry of entries) if (entry.id === id) return entry.shape;
    return 'none';
  }

  function pinFor(sessionId) {
    for (const [key, pin] of pins) if (key.endsWith(`\u0000${sessionId}`)) return pin;
    return undefined;
  }

  function summarizeCompare() {
    if (compareSummary !== null) return compareSummary;
    const rows = [...compare.values()].filter((row) => row.naturalTps > 0 && row.chosenTps > 0);
    const switched = rows.filter((row) => row.source === 'probe');
    const gains = switched.map((row) => row.chosenTps / row.naturalTps).sort((a, b) => a - b);
    const median = (list) => (list.length ? list[Math.floor((list.length - 1) / 2)] : 0);
    const naturalMedians = rows.map((row) => row.naturalTps).sort((a, b) => a - b);
    const chosenMedians = switched.map((row) => row.chosenTps).sort((a, b) => a - b);
    compareSummary = {
      decisions: rows.length,
      keptNatural: rows.filter((row) => row.source === 'natural').length,
      switched: switched.length,
      medianNaturalWhenSwitched: Math.round(median(naturalMedians)),
      medianChosenWhenSwitched: Math.round(median(chosenMedians)),
      medianGain: gains.length ? Math.round(median(gains) * 100) / 100 : 0,
      improved: gains.filter((g) => g > 1.1).length,
      worse: gains.filter((g) => g < 0.9).length,
    };
    return compareSummary;
  }

  // Controlled check: probe the same prompt under several route ids, interleaved
  // and repeated. If between-id variance is no larger than within-id variance,
  // the session id does not control speed and the picker has nothing to select on.
  async function routeTest(provider, model, naturalId) {
    const ids = [naturalId ?? `session-${randomUUID()}`,
      `session-${randomUUID()}`, `session-${randomUUID()}`, `session-${randomUUID()}`];
    const rounds = Math.max(2, Math.min(6, Number(probeCfg.testRounds ?? 3)));
    const prompt = 'Write the integers from 1 to 120 in order, separated by single spaces, and nothing else.';
    const rows = [];
    for (let r = 0; r < rounds; r += 1) {
      const order = [...ids].sort(() => Math.random() - 0.5);
      for (const id of order) {
        const options = {
          provider, model, sessionId: id, maxTokens: 220,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: AbortSignal.timeout(25000),
        };
        probing.add(options);
        try {
          let first = null;
          let last = null;
          let usage = null;
          for await (const chunk of ctx.llm.stream(options)) {
            if (isTokenChunk(chunk)) {
              const now = performance.now();
              if (first === null) first = now;
              last = now;
            } else if (chunk.type === 'usage') usage = chunk.usage;
          }
          const out = usage?.outputTokens ?? 0;
          const decodeMs = first !== null && last !== null ? last - first : 0;
          const tps = decodeMs >= 300 && out >= 40 ? (out * 1000) / decodeMs : null;
          rows.push({ id, tps, out, decodeMs });
        } catch (error) {
          rows.push({ id, tps: null, out: 0, decodeMs: 0, error: String(error?.message ?? error) });
        } finally {
          probing.delete(options);
        }
      }
    }
    const measured = rows.filter((row) => row.tps !== null && row.tps > 0);
    const byId = new Map();
    for (const row of measured) {
      if (!byId.has(row.id)) byId.set(row.id, []);
      byId.get(row.id).push(row.tps);
    }
    const groups = [...byId.entries()].filter(([, list]) => list.length >= 2);
    if (groups.length < 2) {
      return `样本不足：${rows.length} 次请求里只有 ${measured.length} 次可测，${groups.length} 个 id 达到 2 次。再跑一次 /route test。`;
    }
    const logs = groups.map(([id, list]) => [id, list.map((x) => Math.log(x))]);
    const all = logs.flatMap(([, list]) => list);
    const grand = all.reduce((a, b) => a + b, 0) / all.length;
    const k = logs.length;
    const n = all.length;
    let ssb = 0;
    let ssw = 0;
    for (const [, list] of logs) {
      const mean = list.reduce((a, b) => a + b, 0) / list.length;
      ssb += list.length * (mean - grand) ** 2;
      ssw += list.reduce((a, x) => a + (x - mean) ** 2, 0);
    }
    const msb = ssb / (k - 1);
    const msw = ssw / Math.max(1, n - k);
    const icc = Math.max(0, (msb - msw) / (msb + ((n - k) / (k - 1)) * msw));
    const lines = [];
    for (const [id, list] of groups) {
      const sorted = [...list].sort((a, b) => a - b);
      const mid = sorted[Math.floor((sorted.length - 1) / 2)];
      lines.push(`${id === naturalId ? 'natural ' : 'random  '}${id.slice(0, 20)}  n=${list.length}  med ${Math.round(mid)}`);
    }
    lines.push(`between-id SD(log) ${Math.sqrt(Math.max(msb - msw, 0) / (n / k)).toFixed(3)} · within-id SD(log) ${Math.sqrt(msw).toFixed(3)} · ICC ${icc.toFixed(2)}`);
    lines.push(icc >= 0.5
      ? '结论：id 之间的差异明显大于同一 id 的重复波动 → 路由确实影响速度，探针值得继续。'
      : '结论：id 之间的差异和同一 id 的重复波动差不多 → 速度不是 id 决定的，按探针选路没有可选的信号。');
    return lines.join('\n');
  }

  function statusPayload(sessionId) {
    const turns = recent
      .filter((row) => row.kind === 'turn' && (sessionId === undefined || row.sessionId === sessionId))
      .slice(-6)
      .map((row) => ({
        ts: row.ts,
        shape: row.shape,
        tps: row.tps,
        decodeMs: row.decodeMs ?? null,
        out: row.out ?? 0,
        ttfbMs: row.ttfbMs,
        cacheHit: row.cacheHit,
        finish: row.finish,
        failure: row.failure,
      }));
    const pin = sessionId === undefined ? undefined : pinFor(sessionId);
    const baseline = sessionId === undefined ? undefined : baselines.get(pairKey(pin?.provider ?? cfg.providers[0] ?? '', sessionId));
    const locked = baseline !== undefined
      && (baseline.n >= cacheCfg.lockAfterTurns || (baseline.lastInput ?? 0) >= cacheCfg.lockAfterInputTokens);
    const poolRows = [];
    for (const [key, entries] of pool) {
      const [provider, model] = key.split('\u0000');
      for (const entry of entries) {
        poolRows.push({
          provider, model,
          shape: entry.shape,
          tps: Math.round(entry.tps),
          lowerTps: entry.lowerTps ?? 0,
          leased: entry.leasedTo.size,
          strikes: entry.strikes,
        });
      }
    }
    const last = turns[turns.length - 1];
    let best = 0;
    for (const row of poolRows) best = Math.max(best, row.tps, row.lowerTps);
    return {
      ts: new Date().toISOString(),
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      arm: sessionId === undefined ? 'off' : armOf(String(sessionId)),
      reroll: {
    // Abort-and-reroll on a session's first request: buffer a short window, and
    // if the running rate is below the threshold, drop the attempt and retry on
    // a fresh routing id. Off by default; the A/B arm decides who gets it.
    enabled: false,
    windowMs: 2000,
    thresholdTps: 150,
    maxRetries: 3,
    maxPromptTokens: 60000,
  },
  experiment: { enabled: expCfg?.enabled === true, armRatio: expCfg?.armRatio ?? null },
      rate: baseline === undefined || !((baseline.decode ?? 0) > 0)
        ? null
        : {
          out: Math.round(baseline.out ?? 0),
          decodeMs: Math.round(baseline.decode ?? 0),
          tps: Math.round(((baseline.out ?? 0) * 1000) / (baseline.decode ?? 1)),
        },
      state: probeState.active ? 'probing' : (pin !== undefined ? 'pinned' : (locked ? 'locked' : 'idle')),
      locked,
      probe: probeState,
      pinned: pin === undefined ? null : { id: pin.id, shape: last?.shape ?? null, probeTps: Math.round(pin.probeTps ?? 0) },
      compare: sessionId === undefined ? null : (compare.get(pairKey(pin?.provider ?? cfg.providers[0] ?? '', sessionId)) ?? null),
      stats: summarizeCompare(),
      best,
      last: last ?? null,
      turns,
      pool: poolRows,
      counters: { ...counters },
    };
  }

  ctx.effect(() => {
    const timer = setInterval(pruneStale, PRUNE_MS);
    timer?.unref?.();
    return () => clearInterval(timer);
  });

  log({
    kind: 'plugin',
    version: '1.9.0',
    dryRun: cfg.dryRun,
    providers: cfg.providers,
    subagentMode: cfg.subagents.mode,
    experiment: expCfg?.enabled ? { armRatio: expCfg.armRatio, salt: expCfg.salt } : null,
    cache: cfg.cache,
    logDir,
  });

  // The composer pill reads this: same origin, no credentials, never cached.
  // Both carriers wait for their service: at boot this plugin activates before
  // webServer/commands exist, and a plain ctx.get() here would silently skip
  // the registrations for the whole process lifetime.
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/opencode-route/status',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' });
            res.end();
            return;
          }
          await statusReady;
          const url = new URL(String(req.url ?? '/'), 'http://localhost');
          const sessionId = url.searchParams.get('session') ?? undefined;
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(statusPayload(sessionId ?? undefined)));
        } catch {
          res.writeHead(500);
          res.end();
        }
      },
    }), 'opencode-route: GET /opencode-route/status');
    log({ kind: 'plugin-services', webServer: true, port: webCtx.webServer?.getOrigin?.() ?? null });
  });

  // `/route` prints the live state so the feature is observable without a UI build.
  ctx.inject(['commands'], (cmdCtx) => {
    log({ kind: 'plugin-services', commands: true });
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'route',
      description: 'Show OpenCode Go route pins, the lease pool, and recent speeds',
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim().toLowerCase();
        if (raw === 'test' || raw === '自测') {
          const lastTurn = [...recent].reverse().find((row) => row.kind === 'turn' && row.provider === cfg.providers[0]);
          const model = lastTurn?.model;
          if (model === undefined) return { kind: 'error', text: '先在这个会话里发一条消息，再运行 /route test。' };
          const sessionId = invocation?.agent?.session?.id;
          return { kind: 'success', text: await routeTest(lastTurn.provider, model, sessionId === undefined ? undefined : String(sessionId)) };
        }
        if (raw === 'stats' || raw === '效果' || raw === '验证') {
          const s = summarizeCompare();
          const lines = [
            `选路 ${s.decisions} 次：保留原路由 ${s.keptNatural} 次，换路 ${s.switched} 次`,
            `换路的会话里：原路由中位 ${s.medianNaturalWhenSwitched} tok/s → 现在中位 ${s.medianChosenWhenSwitched} tok/s，中位提升 ${s.medianGain}×`,
            `其中明显变快 ${s.improved} 次，明显变慢 ${s.worse} 次`,
          ];
          return { kind: 'success', text: lines.join('\n') };
        }
        const lines = [];
        lines.push(`opencode-route: ${cfg.enabled ? 'on' : 'off'}${cfg.dryRun ? ' (dry run)' : ''} · providers ${cfg.providers.join(',')}`);
        lines.push(`requests=${counters.requests} probes=${counters.probes}/${counters.probeRounds} leases=${counters.leases} evictions=${counters.evictions} slow=${counters.slow}`);
        for (const [poolKey, entries] of pool) {
          const [provider, model] = poolKey.split('\u0000');
          if (entries.length === 0) continue;
          lines.push(`${provider}/${model}:`);
          for (const entry of entries) {
            const speed = entry.tps > 0 ? String(Math.round(entry.tps)) : `~${entry.lowerTps ?? 0}`;
            lines.push(`  ${entry.id.slice(0, 18)}… ${speed} tok/s · ${entry.leasedTo.size} 个会话在用`);
          }
        }
        const pinRows = [...pins.entries()].slice(-8).map(([key, pin]) => `  ${key.split('\u0000')[1].slice(0, 14)}… -> ${pin.id.slice(0, 18)}…`);
        if (pinRows.length > 0) { lines.push('pins:'); lines.push(...pinRows); }
        const turns = recent.filter((row) => row.kind === 'turn').slice(-6);
        if (turns.length > 0) {
          lines.push('recent:');
          for (const row of turns) lines.push(`  ${row.sessionId?.slice(0, 12) ?? '?'} ${row.tps ?? '-'} tok/s · 首字 ${row.ttfbMs ?? '-'}ms · 缓存 ${row.cacheHit ?? '-'}% · ${row.finish}`);
        }
        return { kind: 'success', text: lines.join('\n') };
      },
    }), 'opencode-route: /route');
  });

  ctx.effect(() => () => {
    inflightProbes.clear();
  });
}
