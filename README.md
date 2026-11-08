# dsh-plugin-opencode-route

**English** · A DeepSeek Harness plugin that pins every OpenCode Go session to a fast gateway route.
OpenCode Go routes a conversation by the client-supplied `x-opencode-session` header, and that
assignment is deterministic: in a controlled test on this machine (68 requests, three rounds) the
same random UUID kept landing on the same upstream 25 minutes later — three ids stayed fast
(109–266 tok/s), one stayed at 10–30 tok/s, and four answered `429 overloaded` every single time.

The plugin probes a few candidate ids before a session's first model call, leases the best one from
a shared pool (sub-agent sessions lease from the same pool), and pins it by overriding
`x-opencode-session`. Scope is an exact provider allowlist — by default only `opencode-go`.

## What it does

- **Probe once, early.** Before a session's first model call it tries 3–4 random session ids with a
  96-token request. A candidate is admissible only when it is alive, reaches first token within 5 s,
  finishes within 15 s, and — when it can be measured — reaches 70 tok/s. A window too short to
  measure is admitted on liveness alone but ranks by a conservative lower bound (`out × 2`), so it
  only wins when it can prove it is faster.
- **Measures speed, not response-id shape.** The id's format (`gw-…`, hex, `chatcmpl…`) only breaks
  ties now. It used to rank first and exempt `gw` from measuring, which put the slowest shape first
  on 18 days of local data — see `research/README.md`.
- **Never moves a session on its own.** Changing the id throws away the provider-side prompt cache,
  so a session is pinned once and keeps that route. After 2 turns or 20k tokens it is cache-locked:
  slow turns are logged, not re-routed.
- **Corrects a bad estimate once.** A short probe can read ~2× faster than the real request. If the
  first real turn lands below 60% of the probe's number, the route is dropped and re-picked while the
  context is still cheap.
- **Sub-agents covered.** Child sessions lease from the same pool instead of probing per child.
- **Fails open.** Every listener is wrapped: an internal error falls back to the untouched stream.

## Install

A DSH profile installs a bundle from a package directory; there is no build step.

1. Clone (or copy) this directory anywhere on the machine.
2. Install it into the running profile with the `plugin_manager` tool:

   ```
   plugin_manager  action=install_bundle  target=<absolute path to this directory>
   ```

   The row lands as `opencode-route`, enabled, and scoped to `opencode-go`.
3. Refresh the Web UI so the client half loads.

Requires a DSH build that exposes `llm/stream`, `llm-pi-ai/request-headers`, `webServer` and
`commands` — the plugin waits for each service rather than reading it once at load.

## Configuration

`cordis.patch.yml` ships a working default. Everything is optional:

```yaml
config:
  enabled: true
  dryRun: false            # true = observe only, never inject the header
  providers: [opencode-go] # exact allowlist; nothing else is touched
  models: []               # empty = every model of that provider
  probe: { enabled: true, candidates: 4, maxTokens: 96, timeoutMs: 25000, ttfbMaxMs: 5000, totalMaxMs: 15000 }
  thresholds: { targetTps: 150, degradeTps: 70, strikesToEvict: 2, degradeTtfbMs: 20000 }
  pool: { size: 4, ttlMs: 300000, negativeTtlMs: 60000, maxProbesPerHour: 40 }
  cache: { lockAfterTurns: 2, lockAfterInputTokens: 20000, persistPins: true }
  experiment: { enabled: false, armRatio: 0.5, salt: route-v1 }  # A/B; control = no probe, no pin
```

## How to verify it actually helps

Every decision records its own counterfactual: the probe round tests the session's **own** id
first, so the log carries both "what you would have got" and "what you got".

```bash
node scripts/effectiveness.mjs
```

```
decisions 2 · kept natural 1 · switched 1
natural route: ok 1 · rejected 1 · dead 0

session        source   natural  chosen   gain
0820e3ded68e  probe          0     163      -
a00e79b8f48f  natural      143     143   1.00
```

How to read it:

- **kept natural** — the session's own route was already acceptable, so the plugin pinned nothing and
  the prompt cache stayed warm. This is the case you want to dominate.
- **median gain** — among switched sessions with a measurable natural route, how much faster the
  chosen one was. Above 1 means the switching pays for itself.
- **dead / rejected natural** — the session would have landed on a 429 upstream or a route too slow to
  admit; switching is a straight win there.

The same numbers are available from `/route stats`.

A before/after comparison (`dryRun` for a day, then `enabled` for a day) is not enough on this
machine: daily gateway drift alone moves the session-median between 0.92× and 1.06× — a large part of
the 1.2–1.3× effect being measured. Use the A/B below instead.

## Measuring the effect, not the estimate

The probe measures a 96-token synthetic request, so `compare` tells you how well the selector
picked, not what a real session got. To measure the plugin itself, turn on the A/B:

```yaml
experiment: { enabled: true, armRatio: 0.5, salt: route-v1 }
```

Each session is assigned by a stable hash of its id: `treatment` probes and pins, `control` does
neither — no probe traffic, no header override — and every `turn` event carries `arm`. A session
never crosses arms, so the two groups run in the same days and daily gateway drift cancels.

```bash
node research/analyze_ab.mjs
```

`research/README.md` carries the pre-experiment baseline measured on this machine (446 sessions,
44k calls): session-median 151 tok/s, 2% of sessions below 70 tok/s, and a best-of-4 upside bound
of 1.33×. It also shows why a before/after comparison is not enough — day-level drift alone produces
apparent effects between 0.92× and 1.06× — and how many sessions the A/B needs (34 per arm for 1.2×).

## Observability

- **Header capsule**: one read-only badge — `● 实验 170 tok/s` — matching the native session header
  control (border-box 24px tall, 8px radius on the capsule and the arm tag, 1px border, no fill,
  fixed-width number slot, 8px horizontal padding, literal colours). The number is the session's
  weighted rate — total output tokens over total decode time, the same definition DSH's composer
  footer uses — so a single buffered burst cannot move it. It falls back to the median of the last
  three usable requests (window >= 500 ms, >= 60 output tokens, <= 1000 tok/s) on an older host, and
  rolls digit by digit when it changes. Five-digit speeds would compact to `12.2K` and seven-digit
  ones to `1.2M`, though the ceiling makes neither reachable. It sits leftmost so a changing number
  never shifts its neighbours. During an A/B a plain `实验` label marks the arm (control sessions read
  `对照组`). Hover it for a small table of the last three requests (time, speed, first token, cache) —
  the panel carries no prose. There is no manual re-pick button: the picker is fully automatic.
- **`/route`**: text dump of the pool, pins and recent requests. `/route stats` prints the
  effectiveness numbers.
- **Event log**: `%DSH_HOME%\opencode-route\events.jsonl` — `probe`, `probe-reject`, `probe-dead`,
  `probe-round`, `keep-natural`, `compare`, `pin`, `skip-pin`, `turn` (carries `arm` during an
  experiment), `evict` (carries the sessions whose pin it dropped), `corrective-repin`.
  On startup the plugin replays the tail of this log, so an existing session keeps its badge
  (pinned/locked and the last speeds) instead of looking unselected until its next turn.
- **HTTP**: `GET /opencode-route/status?session=<id>` (read-only).

## Known limits

- OpenCode Go does not document the routing algorithm beyond "send a stable session id". The header
  contract is observed behavior, not an API guarantee; if it changes, the plugin degrades to
  "measure and log" and never blocks a request.
- Whether routing is keyed by session alone or by `(session, model)` is unverified; the pool is keyed
  by both as the conservative choice.
- A short probe estimates decode speed, not what a 200k-token context will do. The corrective re-pick
  is the safety net.
- The plugin adds a handful of tiny requests per probe round; keep `maxProbesPerHour` in mind, and
  note that OpenCode monitors traffic for abuse.

## License

MIT

---

## 中文说明

OpenCode Go 按客户端发来的 `x-opencode-session` 给会话分配上游，而且分配是**确定性**的。这个
DSH 插件在会话第一次调用模型前探测若干候选 id，从共享池里租最好的一条并钉住；子 agent 会话复用
同一个池，不各自抽卡。作用域是精确的 provider 白名单，默认只有 `opencode-go`。

换道会丢一次 prompt 缓存，所以策略是**一次会话只选一次道、之后不主动换**：满 2 轮或上下文
≥ 20k token 后进入缓存锁定，慢只记录不换道；只有 429/超时才换。探针高估时允许一次纠偏。

UI 上是一个会话标题栏徽标：`● 170 tok/s`，只读；悬停出详情浮层（不占布局）。选路全自动，没有手动换路入口。

配置、观测、已知限制见上方英文部分；本地事件日志在 `%DSH_HOME%\opencode-route\events.jsonl`，
会话内可用 `/route` 查看。选路全自动，徽标只读。

许可证：MIT
