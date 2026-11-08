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

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  /** @type {Map<string, number>} */
  const negativeUntil = new Map();
  /** @type {Map<string, {tps: number, ttfb: number, n: number, lastInput: number}>} */
  const baselines = new Map();
  /** @type {Array<object>} */
  const recent = [];
  const counters = { requests: 0, probes: 0, probeRounds: 0, leases: 0, evictions: 0, failures: 0, slow: 0, keptNatural: 0, switched: 0 };
  /** @type {Map<string, {source: string, naturalTps: number, naturalShape: string, chosenTps: number}>} */
  const compare = new Map();
  /** @type {Map<string, {status: string, tps: number, shape: string, ttfbMs: number|null}>} */
  const naturalProbe = new Map();
  /** @type {Map<string, {at: number, tps: number}>} */
  const naturalKeep = new Map();

  const logDir = cfg.logDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'opencode-route');
  const pinsPath = path.join(logDir, 'pins.json');
  let logReady = false;
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
  let resolvePinsReady;
  const pinsReady = new Promise((resolve) => { resolvePinsReady = resolve; });
  void (async () => {
    try {
      if (!cacheCfg.persistPins) return;
      const raw = await readFile(pinsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const cutoff = Date.now() - 86_400_000;
      for (const row of parsed?.pins ?? []) {
        if (typeof row?.key !== 'string' || typeof row?.id !== 'string') continue;
        if (typeof row.at === 'number' && row.at < cutoff) continue;
        pins.set(row.key, { id: row.id, model: String(row.model ?? ''), at: Number(row.at ?? 0), provider: String(row.provider ?? ''), probeTps: Number(row.probeTps ?? 0) });
      }
    } catch { /* first run */ } finally {
      resolvePinsReady?.();
    }
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

  function log(record) {
    const row = { ts: new Date().toISOString(), ...record };
    recent.push(row);
    if (recent.length > 200) recent.shift();
    const line = `${JSON.stringify(row)}\n`;
    void (async () => {
      try {
        if (!logReady) { await mkdir(logDir, { recursive: true }); logReady = true; }
        await appendFile(path.join(logDir, 'events.jsonl'), line, 'utf8');
      } catch { /* logging must never break a request */ }
    })();
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

  async function probeOne(provider, model, candidateId) {
    const options = {
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: probeCfg.prompt }] }],
      maxTokens: probeCfg.maxTokens,
      sessionId: candidateId,
      signal: AbortSignal.timeout(probeCfg.timeoutMs),
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
    for (const candidateId of candidates) {
      if (probesThisHour() >= poolCfg.maxProbesPerHour) break;
      const result = await probeOne(provider, model, candidateId);
      const isNatural = candidateId === sessionId;
      if (isNatural) {
        naturalProbe.set(pairKey(provider, sessionId), {
          status: result.alive ? (admittable(result) ? 'ok' : 'rejected') : 'dead',
          tps: result.tps === null || result.tps === undefined ? 0 : Math.round(result.tps),
          shape: result.shape ?? 'none',
          ttfbMs: result.ttfbMs ?? null,
        });
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
    const locked = (baseline !== undefined
      && (baseline.n >= cacheCfg.lockAfterTurns || (baseline.lastInput ?? 0) >= cacheCfg.lockAfterInputTokens))
      || liveTokens >= cacheCfg.lockAfterInputTokens;
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
        compare.set(pairKey(provider, sessionId), {
          source: 'natural',
          naturalTps: Math.round(naturalEntry?.tps ?? entry.tps ?? 0),
          naturalShape: naturalEntry?.shape ?? entry.shape,
          chosenTps: Math.round(entry.tps ?? 0),
        });
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
    pins.set(key, { id, model, at: Date.now(), provider, probeTps });
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
  async function* guard(options, next) {
    const provider = options.provider;
    const model = options.model;
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    const arm = sessionId === undefined ? 'off' : armOf(sessionId);
    let pinnedId;
    if (sessionId !== undefined && !cfg.dryRun && arm !== 'control') {
      try {
        pinnedId = await ensurePin(provider, model, sessionId, options.signal);
      } catch { pinnedId = undefined; }
    }
    const iterator = next()[Symbol.asyncIterator]();
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
      const genMs = first !== null && last !== null ? last - first : 0;
      // A short window is a delivery burst, not a generation rate: 47 tokens in
      // 7 ms is not 6,700 tok/s. Keep the raw window in decodeMs/out for
      // diagnostics, but publish a rate only when it can mean something.
      const measurable = genMs >= 500 && out >= 60;
      const tps = measurable ? (out * 1000) / genMs : null;
      const kind = reason?.kind ?? (failed !== undefined ? 'thrown' : 'none');
      const ttfbMs = first === null ? null : Math.round(first - t0);
      const inputTokens = usage?.inputTokens ?? 0;
      const cacheReadTokens = usage?.cacheReadTokens ?? 0;
      const cacheBase = inputTokens + cacheReadTokens;
      const cacheHit = cacheBase > 0 ? cacheReadTokens / cacheBase : null;
      log({
        kind: 'turn',
        provider,
        model,
        sessionId,
        arm,
        pinnedId: pinnedId ?? null,
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
      let locked = false;
      if (sessionId !== undefined) {
        const key = pairKey(provider, sessionId);
        const base = baselines.get(key);
        const next = base === undefined
          ? { tps: tps ?? 0, ttfb: ttfbMs ?? 0, n: 1, lastInput: cacheBase }
          : {
            tps: tps === null ? base.tps : base.tps * 0.6 + tps * 0.4,
            ttfb: ttfbMs === null ? base.ttfb : base.ttfb * 0.6 + ttfbMs * 0.4,
            n: base.n + 1,
            lastInput: cacheBase,
          };
        baselines.set(key, next);
        locked = next.n >= cacheCfg.lockAfterTurns || next.lastInput >= cacheCfg.lockAfterInputTokens;
      }
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
    const rows = [...compare.values()].filter((row) => row.naturalTps > 0 && row.chosenTps > 0);
    const switched = rows.filter((row) => row.source === 'probe');
    const gains = switched.map((row) => row.chosenTps / row.naturalTps).sort((a, b) => a - b);
    const median = (list) => (list.length ? list[Math.floor((list.length - 1) / 2)] : 0);
    const naturalMedians = rows.map((row) => row.naturalTps).sort((a, b) => a - b);
    const chosenMedians = switched.map((row) => row.chosenTps).sort((a, b) => a - b);
    return {
      decisions: rows.length,
      keptNatural: rows.filter((row) => row.source === 'natural').length,
      switched: switched.length,
      medianNaturalWhenSwitched: Math.round(median(naturalMedians)),
      medianChosenWhenSwitched: Math.round(median(chosenMedians)),
      medianGain: gains.length ? Math.round(median(gains) * 100) / 100 : 0,
      improved: gains.filter((g) => g > 1.1).length,
      worse: gains.filter((g) => g < 0.9).length,
    };
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
      experiment: { enabled: expCfg?.enabled === true, armRatio: expCfg?.armRatio ?? null },
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

  log({
    kind: 'plugin',
    version: '1.7.6',
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
      handler: (req, res) => {
        try {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' });
            res.end();
            return;
          }
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
