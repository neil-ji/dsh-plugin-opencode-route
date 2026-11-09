# dsh-plugin-opencode-route

An OpenCode Go routing experiment for DSH: on a session's first request, if the
stream is slower than the comfort threshold, abort it and retry on a fresh
routing id — the same thing you would do by hand ("this session is slow, start a
new one"), automated and hidden from the conversation.

## What it does

- **One lever.** OpenCode Go pins a conversation to an upstream backend through
  the `x-opencode-session` header; a different id is a different draw. The plugin
  only ever changes that id.
- **Abort and reroll.** A treatment session's *first* request is let through as
  usual. The plugin buffers the first `windowMs` (2 s) of tokens, computes the
  running rate, and if it is below `thresholdTps` (150 tok/s) it drops the
  attempt and retries on a fresh id, up to `maxRetries` (3) times. The buffered
  window is never shown, so the user only sees the accepted attempt. The accepted
  stream is replayed at its original cadence, one window behind, so downstream
  (including DSH's own token-rate statistics) sees the real timing instead of a
  2 s burst.
- **First request only.** Once a session has called the model, its prompt cache
  is worth protecting: later turns are never moved. A first prompt larger than
  `maxPromptTokens` (60k) is skipped too, because every retry pays a full
  prefill.
- **A/B.** Sessions are bucketed by `sha256(salt:sessionId)`; `treatment` gets
  reroll, `control` is untouched. Both log `turn` events carrying `arm`, so the
  effect can be measured.
- **No credentials.** Every attempt goes through `ctx.llm`; the provider
  resolves its own key.

Parameters were tuned on 323 real first requests (`research/tune_reroll.mjs`):
2000 ms / 150 tok/s / 3 retries puts 95% of sessions at >=150 tok/s with 1.75
attempts and a 7% false-reject rate. Re-tuning is designed but not applied —
see `research/TODO-tuning.md`.

## Install

```bash
dsh plugin add dsh-plugin-opencode-route --profile <name>
```

## Configuration

`cordis.patch.yml` ships a working default. Everything is optional:

```yaml
config:
  enabled: true
  dryRun: false              # true = observe only, never reroll
  providers: [opencode-go]   # exact allowlist; nothing else is touched
  models: []                 # empty = every model of that provider
  reroll: { enabled: true, windowMs: 2000, thresholdTps: 150, maxRetries: 3, maxPromptTokens: 60000 }
  experiment: { enabled: true, armRatio: 0.5, salt: route-v1 }
```

## Observability

- **Header capsule**: a read-only badge in the session header. The number is the
  session's weighted rate — total output tokens over total decode time, the same
  definition DSH's composer footer uses — falling back to the median of the last
  three usable requests. During an A/B a plain `实验组` label marks the arm
  (control sessions read `对照组`). Hover it for the last three requests (time,
  speed, first token, cache). No prose, no manual action.
- **`/route`**: dump of the current arm, parameters, counters and recent turns.
  `/route stats` prints the reroll counters; `/route test` runs a controlled
  check of whether the routing id moves the speed at all (four ids, interleaved
  and repeated, reporting between-id vs within-id variance).
- **Event log**: `%DSH_HOME%\opencode-route\events.jsonl` — `plugin`, `turn`
  (one per model call), `reroll` (one per attempt, with the early and final
  rate). Rotates at 8 MB into `events.1.jsonl`; writes are serialized.
- **HTTP**: `GET /opencode-route/status?session=<id>` (read-only).

## Measuring the effect

`research/analyze_ab.mjs` reads the event log, aggregates to one row per
session, and reports the day-stratified bootstrap ratio between the arms. The
early sessions of this experiment measured the old probe/pin picker (no
detectable effect); the reroll experiment starts from the version that shipped
it. Use `--since <timestamp>` to analyse that cohort only.

`research/README.md` keeps the baseline study (446 sessions / 44k calls) that
motivated the design; it is history, not the current behaviour.

## Known limits

- The provider may keep generating for a moment after an abort; the plugin can
  only stop consuming the stream.
- A buffered first window adds `windowMs` to the first visible token of every
  treatment session.
- `x-opencode-session` is observed behaviour, not a documented API; if it ever
  stops controlling the backend, `/route test` will show an ICC near zero.
- A session's arm is a pure hash of its id, so arms can be uneven at small n.

## License

MIT

## 中文说明

**做什么**：OpenCode Go 通过 `x-opencode-session` 把会话绑定到某个后端。插件在会话的
**第一次请求**上缓冲 2 秒，算出实际速率；低于 150 tok/s 就中止这次尝试，换一个新 id
重发，最多重试 3 次。被中止的尝试不会显示，用户只会看到最终那次。

只动第一次请求：之后上下文缓存已经值得保护，不再换路；首条 prompt 超过 60k 也不重试
（每次重试都要重新 prefill）。

**参数来自实验**：323 个真实首请求的网格搜索（`research/tune_reroll.mjs`）给出
2000ms / 150 tok/s / 3 次：95% 的会话落在 ≥150 tok/s，平均 1.75 次尝试，误杀 7%。

**观测**：会话标题栏只读徽标（会话加权速率，悬停看最近三次）；`/route` 看状态，
`/route stats` 看重试统计，`/route test` 验证 id 是否真的影响速度。

**A/B**：按 `sha256(salt:sessionId)` 分桶，处理组重试、对照组不动，两边都记 `turn`。
动态调参见 `research/TODO-tuning.md`（已设计，未启用）。
