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
import { randomUUID } from 'node:crypto';
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
  const counters = { requests: 0, probes: 0, probeRounds: 0, leases: 0, evictions: 0, failures: 0, slow: 0 };

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
      const shapeA = SHAPE_RANK[a.shape] ?? 9;
      const shapeB = SHAPE_RANK[b.shape] ?? 9;
      if (shapeA !== shapeB) return shapeA - shapeB;
      return b.tps - a.tps;
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
    for (const [pinKey, pin] of pins) if (pin.id === id) pins.delete(pinKey);
    savePins();
    if (removed) counters.evictions += 1;
    if (removed) log({ kind: 'evict', id, reason });
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

  // A candidate is only worth pinning when it looks good on its own merits; when
  // every candidate is on a saturated upstream, pinning nothing is the safe move.
  function admittable(result) {
    if (!result.alive) return false;
    if (result.ttfbMs === null || result.ttfbMs > probeCfg.ttfbMaxMs) return false;
    if (result.totalMs > probeCfg.totalMaxMs) return false;
    if (result.shape === 'gw') return true;
    return result.measured === true && result.tps !== null && result.tps >= thresholds.degradeTps;
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
    const candidates = Array.from({ length: Math.max(1, probeCfg.candidates) }, () => `session-${randomUUID()}`);
    const alive = [];
    for (const candidateId of candidates) {
      if (probesThisHour() >= poolCfg.maxProbesPerHour) break;
      const result = await probeOne(provider, model, candidateId);
      if (result.alive) {
        const ok = admittable(result);
        log({
          kind: ok ? 'probe' : 'probe-reject',
          provider, model, id: candidateId, shape: result.shape,
          tps: result.tps === null ? null : Math.round(result.tps),
          ttfbMs: result.ttfbMs, totalMs: result.totalMs, measured: result.measured,
        });
        if (ok) {
          alive.push(result);
          if (result.shape === 'gw' && result.ttfbMs <= probeCfg.ttfbMaxMs) break;
          if (result.measured && result.tps >= thresholds.targetTps) break;
        }
      } else {
        log({ kind: 'probe-dead', provider, model, id: candidateId, reason: result.reason });
      }
    }
    const now = Date.now();
    const entries = alive
      .sort((a, b) => {
        const rank = (SHAPE_RANK[a.shape] ?? 9) - (SHAPE_RANK[b.shape] ?? 9);
        if (rank !== 0) return rank;
        const tpsA = a.tps ?? 0;
        const tpsB = b.tps ?? 0;
        return tpsB - tpsA;
      })
      .slice(0, poolCfg.size)
      .map((result) => ({
        id: result.id,
        tps: result.tps ?? 0,
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
    log({ kind: 'probe-round', provider, model, alive: entries.length, ids: entries.map((entry) => entry.id) });
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
  const forceRepin = new Set();
  const inflightPins = new Map();

  async function ensurePin(provider, model, sessionId, signal) {
    const key = pairKey(provider, sessionId);
    await pinsReady;
    const existing = pins.get(key);
    // A session keeps its route for as long as it lives: every switch costs one
    // full re-prefill of the whole context, which is the expensive thing here.
    if (existing !== undefined && existing.model === model && !forceRepin.has(key)) return existing.id;
    if (forceRepin.has(key)) forceRepin.delete(key);
    if (existing !== undefined) {
      // An explicit `/route repin` keeps the old id out of the pool so the round
      // cannot hand the same route back.
      invalidateId(existing.id, 'forced-repin');
    }
    const running = inflightPins.get(key);
    if (running !== undefined) return running;
    const work = ensurePinWork(provider, model, sessionId, signal).finally(() => inflightPins.delete(key));
    inflightPins.set(key, work);
    return work;
  }

  async function ensurePinWork(provider, model, sessionId, signal, force = false) {
    const key = pairKey(provider, sessionId);
    const baseline = baselines.get(key);
    const liveTokens = contextTokens(sessionId);
    const locked = (baseline !== undefined
      && (baseline.n >= cacheCfg.lockAfterTurns || (baseline.lastInput ?? 0) >= cacheCfg.lockAfterInputTokens))
      || liveTokens >= cacheCfg.lockAfterInputTokens;
    if (locked && !force) {
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
    pins.set(key, { id, model, at: Date.now(), provider, probeTps });
    savePins();
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
    let pinnedId;
    if (sessionId !== undefined && !cfg.dryRun) {
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
      const tps = genMs > 0 && out > 0 ? (out * 1000) / genMs : null;
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
        pinnedId: pinnedId ?? null,
        shape,
        out,
        tps: tps === null ? null : Math.round(tps),
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
            kind: 'repin', provider, model, sessionId, id: pinnedId,
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

  function pinFor(sessionId) {
    for (const [key, pin] of pins) if (key.endsWith(`\u0000${sessionId}`)) return pin;
    return undefined;
  }

  function statusPayload(sessionId) {
    const turns = recent
      .filter((row) => row.kind === 'turn' && (sessionId === undefined || row.sessionId === sessionId))
      .slice(-6)
      .map((row) => ({
        ts: row.ts,
        shape: row.shape,
        tps: row.tps,
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
          leased: entry.leasedTo.size,
          strikes: entry.strikes,
        });
      }
    }
    const last = turns[turns.length - 1];
    let best = 0;
    for (const row of poolRows) best = Math.max(best, row.tps);
    return {
      ts: new Date().toISOString(),
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      state: probeState.active ? 'probing' : (pin !== undefined ? 'pinned' : (locked ? 'locked' : 'idle')),
      locked,
      probe: probeState,
      pinned: pin === undefined ? null : { id: pin.id, shape: last?.shape ?? null, probeTps: Math.round(pin.probeTps ?? 0) },
      best,
      last: last ?? null,
      turns,
      pool: poolRows,
      counters: { ...counters },
    };
  }

  async function repinNow(sessionId) {
    const lastTurn = [...recent].reverse().find((row) => row.kind === 'turn' && row.sessionId === sessionId);
    let restored;
    for (const [key, pin] of pins) if (key.endsWith(`\u0000${sessionId}`)) restored = pin;
    const provider = lastTurn?.provider ?? restored?.provider ?? cfg.providers[0];
    const model = lastTurn?.model ?? restored?.model;
    if (model === undefined || model.length === 0) return { ok: false, error: '这个会话还没发过请求，先发一条消息再来选道。' };
    const key = pairKey(provider, sessionId);
    const old = pins.get(key);
    if (old !== undefined) invalidateId(old.id, 'repin-now');
    const poolKey = poolKeyOf(provider, model);
    pool.delete(poolKey);
    negativeUntil.delete(poolKey);
    const id = await ensurePinWork(provider, model, sessionId, undefined, true);
    if (id === undefined) return { ok: false, error: '这次没有找到可用路由（候选全被拒），已保持原状。' };
    const pin = pins.get(key);
    const entry = (pool.get(poolKey) ?? []).find((row) => row.id === id);
    log({ kind: 'repin-now', provider, model, sessionId, id });
    return { ok: true, id, shape: entry?.shape ?? null, tps: Math.round(pin?.probeTps ?? 0) };
  }

  log({
    kind: 'plugin',
    version: '1.6.0',
    dryRun: cfg.dryRun,
    providers: cfg.providers,
    subagentMode: cfg.subagents.mode,
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
      path: '/opencode-route/repin',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          const url = new URL(String(req.url ?? '/'), 'http://localhost');
          const sessionId = url.searchParams.get('session');
          if (sessionId === null || sessionId.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'missing session' }));
            return;
          }
          const result = await repinNow(sessionId);
          res.writeHead(result.ok ? 200 : 409, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: error?.message ?? 'repin failed' }));
        }
      },
    }), 'opencode-route: POST /opencode-route/repin');
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
      handler: (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim().toLowerCase();
        if (raw === 'repin' || raw === 'repick') {
          const sessionId = invocation?.agent?.session?.id;
          if (sessionId === undefined) return { kind: 'error', text: '没有活动会话，无法重新选道。' };
          for (const provider of cfg.providers) forceRepin.add(pairKey(provider, String(sessionId)));
          return {
            kind: 'success',
            text: '已标记重新选道：下一次模型请求会重新探测候选，并换到新路由。\n代价是该请求要重新 prefill 整个上下文（缓存失效一次）。',
          };
        }
        const lines = [];
        lines.push(`opencode-route: ${cfg.enabled ? 'on' : 'off'}${cfg.dryRun ? ' (dry run)' : ''} · providers ${cfg.providers.join(',')}`);
        lines.push(`requests=${counters.requests} probes=${counters.probes}/${counters.probeRounds} leases=${counters.leases} evictions=${counters.evictions} slow=${counters.slow}`);
        for (const [poolKey, entries] of pool) {
          const [provider, model] = poolKey.split('\u0000');
          if (entries.length === 0) continue;
          lines.push(`${provider}/${model}:`);
          for (const entry of entries) {
            lines.push(`  ${entry.id.slice(0, 18)}… ${entry.shape} ${Math.round(entry.tps)} tok/s · leased ${entry.leasedTo.size} · strikes ${entry.strikes}`);
          }
        }
        const pinRows = [...pins.entries()].slice(-8).map(([key, pin]) => `  ${key.split('\u0000')[1].slice(0, 14)}… -> ${pin.id.slice(0, 18)}…`);
        if (pinRows.length > 0) { lines.push('pins:'); lines.push(...pinRows); }
        const turns = recent.filter((row) => row.kind === 'turn').slice(-6);
        if (turns.length > 0) {
          lines.push('recent:');
          for (const row of turns) lines.push(`  ${row.sessionId?.slice(0, 12) ?? '?'} ${row.shape} ${row.tps ?? '-'} tok/s ttfb ${row.ttfbMs ?? '-'}ms hit ${row.cacheHit ?? '-'}% ${row.finish}`);
        }
        return { kind: 'success', text: lines.join('\n') };
      },
    }), 'opencode-route: /route');
  });

  ctx.effect(() => () => {
    inflightProbes.clear();
  });
}
