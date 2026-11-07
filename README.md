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
  finishes within 15 s, and is either the `gw` shape or measures at least 70 tok/s.
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

The same numbers are in the UI: hover the header chip (决策 / 保留 / 换道 / 中位提升) or run `/route stats`.

A strict A/B is still possible if you want one: set `dryRun: true` for a day, then `enabled` for a
day, and compare the per-session median `tps` of `turn` events in the two windows. The built-in
counterfactual usually makes that unnecessary.

## Observability

- **Header chip**: `● 170 tok/s hex32` plus `↻`. Hover for the pinned id, probe value, pool best,
  cache lock state, candidate pool and the last three requests. `↻` re-picks immediately.
- **`/route`**: text dump of the pool, pins and recent requests. `/route repin` forces a re-pick,
  `/route stats` prints the effectiveness numbers.
- **Event log**: `%DSH_HOME%\opencode-route\events.jsonl` — `probe`, `probe-reject`, `probe-dead`,
  `probe-round`, `keep-natural`, `compare`, `pin`, `skip-pin`, `turn`, `evict`, `repin`.
- **HTTP**: `GET /opencode-route/status?session=<id>`, `POST /opencode-route/repin?session=<id>`.

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

UI 上是一个会话标题栏徽标：`● 170 tok/s hex32` + `↻` 重选按钮，悬停出详情浮层（不占布局）。

配置、观测、已知限制见上方英文部分；本地事件日志在 `%DSH_HOME%\opencode-route\events.jsonl`，
会话内可用 `/route` 查看，或直接点徽标上的 `↻`。

许可证：MIT
