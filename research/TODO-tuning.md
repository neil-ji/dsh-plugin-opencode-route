# TODO: dynamic parameter tuning (not implemented)

The reroll gate has three knobs — `windowMs`, `thresholdTps`, `maxRetries`. They were
calibrated offline once (`research/tune_reroll.mjs` over 323 first requests: 2000 ms /
150 tok/s / 3 retries gives 95% of sessions at >=150 tok/s with 1.75 attempts). They
will drift when the gateway changes.

Plan, in order:

1. Ship reroll with the calibrated constants and record one `reroll` event per attempt
   (early rate at each checkpoint, final rate, aborted, id).
2. Run the roll-vs-control experiment until it is conclusive.
3. Remove the A/B, then implement tuning:
   - sample store: `<logDir>/tuning.jsonl`, one compact row per first request;
   - nightly (or every 200 new samples) grid search over `(windowMs, thresholdTps)`
     with the constraints `P(final >= comfortTps) >= 0.92` and `meanAttempts <= 2.2`;
   - hysteresis: switch only on a >=3 point improvement with >=200 samples; clamp to
     window 1000-3000 ms, threshold 120-200, retries 2-4; keep the last three
     calibrations for audit;
   - `comfortTps` stays a user preference (150 today), never tuned;
   - expose parameters, sample count and last calibration in `/route stats` and the
     status route;
   - shadow mode while any experiment is running: record and compute, do not apply.
4. After tuning ships, design its own experiment (does the tuned point beat the fixed
   one on the next 500 sessions?).
