// opencode-route — OpenCode Go route experiment for DSH.
//
// The only lever is the `x-opencode-session` request header: it pins a
// conversation to one upstream backend, and a different id is a different draw.
// This plugin does not pick a route up front. On a session's first request it
// lets the natural attempt run, buffers the first window, and aborts + retries
// on a fresh id when the running rate is below the comfort threshold. The user
// only ever sees the accepted attempt.
//
// It never reads credentials: every attempt goes through ctx.llm, so the
// configured provider resolves its own key.

import { appendFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
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
  reroll: {
    enabled: true,
    windowMs: 2000,      // buffer this much of the first attempt, then decide
    thresholdTps: 150,   // below this the attempt is dropped and retried
    maxRetries: 3,       // total attempts = 1 + maxRetries
    maxPromptTokens: 60000, // a larger first prompt is not worth re-prefilling
  },
  experiment: {
    // A session is assigned by a stable hash of its id, so it never crosses
    // arms: `treatment` rerolls, `control` is untouched. Both log `turn` events
    // carrying `arm`.
    enabled: true,
    armRatio: 0.5,
    salt: 'route-v1',
  },
};

// No single stream generates faster than this; above it the number is buffering.
const PLAUSIBLE_TPS = 1000;
// Bookkeeping is a cache: cap it so a long-lived process stays bounded.
const MAP_CAP = 2000;
const STALE_MS = 86_400_000;
const PRUNE_MS = 600_000;
const LOG_MAX_BYTES = 8 * 1024 * 1024;

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

function chunkChars(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text.length;
  if (chunk.type === 'tool-call-delta') return (chunk.argumentsDelta?.length ?? 0) + (chunk.name?.length ?? 0);
  return 0;
}

export function apply(ctx, config = {}) {
  const cfg = merge(DEFAULTS, config);
  const expCfg = cfg.experiment;

  const baselines = new Map();
  const recent = [];
  const counters = { requests: 0, attempts: 0, aborted: 0, failures: 0 };
  // Options issued by this plugin (reroll retries, /route test) must not be
  // re-wrapped by the same listener.
  const bypass = new WeakSet();

  const logDir = cfg.logDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'opencode-route');
  let logReady = false;
  let logBytes = 0;
  let logQueue = Promise.resolve();

  function capMap(map) {
    while (map.size > MAP_CAP) map.delete(map.keys().next().value);
  }

  function pruneStale() {
    const cutoff = Date.now() - STALE_MS;
    for (const [key, base] of baselines) if ((base.at ?? 0) < cutoff) baselines.delete(key);
  }

  function log(record) {
    const row = { ts: new Date().toISOString(), ...record };
    recent.push(row);
    if (recent.length > 200) recent.shift();
    const line = `${JSON.stringify(row)}\n`;
    // Serialize writes: one chain orders the lines and makes rotation safe. The
    // byte count tracks what reached the file, so a burst cannot rotate before
    // the file exists.
    logQueue = logQueue.then(async () => {
      try {
        if (!logReady) { await mkdir(logDir, { recursive: true }); logReady = true; }
        const file = path.join(logDir, 'events.jsonl');
        if (logBytes > LOG_MAX_BYTES) {
          try {
            await rm(path.join(logDir, 'events.1.jsonl'), { force: true });
            await rename(file, path.join(logDir, 'events.1.jsonl'));
          } catch { /* a missing file means nothing to rotate */ }
          logBytes = 0;
        }
        await appendFile(file, line, 'utf8');
        logBytes += Buffer.byteLength(line);
      } catch { /* logging must never break a request */ }
    });
  }

  // `recent` and `baselines` are what the badge and the rate read; both live in
  // memory, so replay the log tail to keep them across a restart.
  async function restoreFromLog() {
    let raw;
    try { raw = await readFile(path.join(logDir, 'events.jsonl'), 'utf8'); } catch { return; }
    const cutoff = Date.now() - STALE_MS;
    const TAIL = 524_288;
    const tail = raw.length > TAIL ? raw.slice(-TAIL) : raw;
    const lines = tail.split('\n');
    if (tail.length !== raw.length) lines.shift();
    const turns = [];
    for (const line of lines) {
      if (line.length === 0 || line.charCodeAt(0) !== 123) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.kind !== 'turn' || typeof row.sessionId !== 'string' || typeof row.provider !== 'string') continue;
      if (typeof row.ts !== 'string' || Date.parse(row.ts) < cutoff) continue;
      turns.push(row);
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
        out: (prev?.out ?? 0) + (Number(row.decodeMs ?? 0) > 0 ? Number(row.out ?? 0) : 0),
        decode: (prev?.decode ?? 0) + Number(row.decodeMs ?? 0),
        at: Number.isNaN(Date.parse(row.ts)) ? Date.now() : Date.parse(row.ts),
      });
    }
    capMap(baselines);
  }

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  // A status call can arrive before the log replay finishes; wait for it,
  // bounded so a broken log cannot hang the endpoint.
  const statusReady = Promise.race([
    ready,
    new Promise((resolve) => { const timer = setTimeout(resolve, 2000); timer?.unref?.(); }),
  ]);
  void (async () => {
    try { await restoreFromLog(); } catch { /* a broken log must not block startup */ }
    resolveReady?.();
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

  // Context already on the wire, so a large first prompt is not worth
  // re-prefilling for a reroll.
  function contextTokens(sessionId) {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId);
      if (agent === undefined) return 0;
      const pressure = ctx.get('tokenMeter')?.contextPressure?.(agent.session);
      return pressure?.pressureTokens ?? 0;
    } catch { return 0; }
  }

  function mergedSignal(a, b) {
    if (a === undefined) return b;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
    return b;
  }

  // Buffers the first window of the accepted attempt, so an aborted attempt is
  // never shown. `timing` reports the real first/last token of the accepted
  // stream to the guard, whose own timestamps would otherwise start at the
  // flush.
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
      if (own) bypass.add(o2);
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
          buffered.push(chunk);
          if (!isTokenChunk(chunk)) continue;
          const now = performance.now();
          if (first === null) first = now;
          last = now;
          chars += chunkChars(chunk);
          if (early === null && now - first >= windowMs) {
            early = Math.round((chars / 4) / ((now - first) / 1000));
            if (early < threshold) { slow = true; break; }
          }
        }
      } finally {
        if (slow) {
          try { await iterator.return?.(); } catch { /* stop consuming */ }
          if (own) controller.abort();
        }
      }
      counters.attempts += 1;
      if (slow && attempt < maxRetries) {
        counters.aborted += 1;
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
    const timing = { first: null, last: null, start: null };
    const baseline = sessionId === undefined ? undefined : baselines.get(pairKey(provider, sessionId));
    const useReroll = Boolean(cfg.reroll?.enabled)
      && !cfg.dryRun
      && arm === 'treatment'
      && sessionId !== undefined
      && (baseline?.n ?? 0) === 0
      && contextTokens(sessionId) <= Number(cfg.reroll.maxPromptTokens ?? 60000);
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
      // A short window is a delivery burst, not a generation rate; a long window
      // with an implausible rate is buffering. Keep decodeMs/out for diagnostics.
      const rate = genMs > 0 ? (out * 1000) / genMs : 0;
      const measurable = genMs >= 500 && out >= 60 && rate <= PLAUSIBLE_TPS;
      const tps = measurable ? rate : null;
      const kind = reason?.kind ?? (failed !== undefined ? 'thrown' : 'none');
      const ttfbMs = firstAt === null ? null : Math.round(firstAt - (timing.start ?? t0));
      const inputTokens = usage?.inputTokens ?? 0;
      const cacheReadTokens = usage?.cacheReadTokens ?? 0;
      const cacheBase = inputTokens + cacheReadTokens;
      const cacheHit = cacheBase > 0 ? cacheReadTokens / cacheBase : null;
      let locked = false;
      if (sessionId !== undefined) {
        const key = pairKey(provider, sessionId);
        const base = baselines.get(key);
        const next2 = base === undefined
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
        baselines.set(key, next2);
        capMap(baselines);
        locked = next2.n >= 2 || next2.lastInput >= 20000;
      }
      log({
        kind: 'turn',
        provider,
        model,
        sessionId,
        arm,
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
    }
  }

  ctx.on('llm/stream', (options, next) => {
    try {
      if (bypass.has(options)) return next();
      if (!isScope(options.provider, options.model)) return next();
      return guard(options, next);
    } catch {
      return next();
    }
  });

  // Controlled check: does the routing id move the speed at all? Probes the same
  // prompt under four interleaved ids and compares between-id with within-id
  // variance. Exposed as /route test.
  async function routeTest(provider, model, naturalId) {
    const ids = [naturalId ?? `session-${randomUUID()}`,
      `session-${randomUUID()}`, `session-${randomUUID()}`, `session-${randomUUID()}`];
    const rounds = Math.max(2, Math.min(6, Number(cfg.reroll.testRounds ?? 3)));
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
        bypass.add(options);
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
      ? '结论：id 之间的差异明显大于同一 id 的重复波动 → 路由确实影响速度，reroll 有可抽的池子。'
      : '结论：id 之间的差异和同一 id 的重复波动差不多 → 速度不由 id 决定，reroll 抽不到东西。');
    return lines.join('\n');
  }

  function statusPayload(sessionId) {
    const turns = recent
      .filter((row) => row.kind === 'turn' && (sessionId === undefined || row.sessionId === sessionId))
      .slice(-6)
      .map((row) => ({
        ts: row.ts,
        sessionId: row.sessionId,
        shape: row.shape,
        tps: row.tps,
        decodeMs: row.decodeMs ?? null,
        out: row.out ?? 0,
        ttfbMs: row.ttfbMs,
        cacheHit: row.cacheHit,
        finish: row.finish,
        failure: row.failure,
      }));
    const provider = cfg.providers[0] ?? '';
    const baseline = sessionId === undefined ? undefined : baselines.get(pairKey(provider, sessionId));
    const last = turns[turns.length - 1];
    return {
      ts: new Date().toISOString(),
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      arm: sessionId === undefined ? 'off' : armOf(String(sessionId)),
      experiment: { enabled: expCfg?.enabled === true, armRatio: expCfg?.armRatio ?? null },
      reroll: {
        enabled: cfg.reroll?.enabled === true,
        windowMs: cfg.reroll?.windowMs ?? null,
        thresholdTps: cfg.reroll?.thresholdTps ?? null,
        maxRetries: cfg.reroll?.maxRetries ?? null,
      },
      rate: baseline === undefined || !((baseline.decode ?? 0) > 0)
        ? null
        : {
          out: Math.round(baseline.out ?? 0),
          decodeMs: Math.round(baseline.decode ?? 0),
          tps: Math.round(((baseline.out ?? 0) * 1000) / (baseline.decode ?? 1)),
        },
      last: last ?? null,
      turns,
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
    version: '1.10.1',
    dryRun: cfg.dryRun,
    providers: cfg.providers,
    reroll: cfg.reroll?.enabled ? { windowMs: cfg.reroll.windowMs, thresholdTps: cfg.reroll.thresholdTps, maxRetries: cfg.reroll.maxRetries } : null,
    experiment: expCfg?.enabled ? { armRatio: expCfg.armRatio, salt: expCfg.salt } : null,
    logDir,
  });

  // The composer pill reads this: same origin, no credentials, never cached.
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
          res.end(JSON.stringify(statusPayload(sessionId)));
        } catch {
          res.writeHead(500);
          res.end();
        }
      },
    }), 'opencode-route: GET /opencode-route/status');
  });

  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'route',
      description: 'Show the OpenCode Go reroll state and recent speeds',
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
          const lines = [
            `尝试 ${counters.attempts} 次：中止 ${counters.aborted} 次，成功 ${counters.attempts - counters.aborted} 次`,
            `参数：窗口 ${cfg.reroll.windowMs}ms · 阈值 ${cfg.reroll.thresholdTps} tok/s · 最多重试 ${cfg.reroll.maxRetries} 次`,
            `实验：${expCfg?.enabled ? `on · 处理组 ${Math.round((expCfg.armRatio ?? 0) * 100)}% · salt ${expCfg.salt}` : 'off'}`,
          ];
          return { kind: 'success', text: lines.join('\n') };
        }
        const sessionId = invocation?.agent?.session?.id;
        const data = statusPayload(sessionId === undefined ? undefined : String(sessionId));
        const lines = [];
        lines.push(`opencode-route: ${cfg.enabled ? 'on' : 'off'}${cfg.dryRun ? ' (dry run)' : ''} · providers ${cfg.providers.join(',')}`);
        lines.push(`reroll ${data.reroll.enabled ? `${data.reroll.windowMs}ms / ${data.reroll.thresholdTps} tok/s / ${data.reroll.maxRetries} retries` : 'off'} · arm ${data.arm}`);
        lines.push(`requests=${counters.requests} attempts=${counters.attempts} aborted=${counters.aborted}`);
        if (data.rate !== null) lines.push(`session rate ${data.rate.tps} tok/s (${data.rate.out} tok / ${data.rate.decodeMs}ms)`);
        if (data.turns.length > 0) {
          lines.push('recent:');
          for (const row of data.turns) {
            lines.push(`  ${row.sessionId ?? ''} ${row.tps ?? '-'} tok/s · 首字 ${row.ttfbMs ?? '-'}ms · 缓存 ${row.cacheHit ?? '-'}% · ${row.finish}`);
          }
        }
        return { kind: 'success', text: lines.join('\n') };
      },
    }), 'opencode-route: /route');
  });
}

function pairKey(provider, sessionId) {
  return `${provider}\u0000${sessionId}`;
}
