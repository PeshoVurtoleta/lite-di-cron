# Changelog

All notable changes to `@zakkster/lite-di-cron` are documented here. The format
follows Keep a Changelog; the project uses semantic versioning. The version is
synced in three places at once: `package.json`, the `VERSION` const in `Cron.js`,
and this file's top entry.

## [1.0.0] - 2026-08-11

Promotion to stable. The public surface is frozen exactly as shipped at
`1.0.0-alpha.1` -- the `Cron` class (`job`, `arm`, `start`, `stop`, `tick`,
`setEnabled`, `has`, `list`, `running`, `tickCount`), the schedule builders
`interval` / `every` / `cron`, the pure `shouldRun` predicate and `parseCronExpr`,
the `CronError` type, plus `VERSION` and the frozen `OPTIONS`. No exports added or
removed.

### Changed
- The retention gate is now a real finalization residual, not a `size() === 0`
  tautology. The soak tracks each reset cycle WITHOUT untracking, settles hard, and
  asserts the finalization residual stays within a fixed ceiling (`size() <= 16`)
  that does NOT scale with cycle count -- so a per-cycle leak trips it directly, not
  merely a heap backstop. Behavior unchanged; this is the gate that now PROVES
  leak-freedom.

### Proven
- Downstream consumer: `examples/scheduled-jobs.mjs`, a self-verifying reference app
  that boots a real container, registers jobs as boot-locked singletons on real
  schedules, drives `tick(now)` by hand, and asserts due-firing, `setEnabled`
  gating, and job-error routing with `node:assert`. `npm run example` is a hard gate
  folded into `verify` / `prepublishOnly`.
- `node --expose-gc test/torture.mjs`: the synchronous (non-promise) `tick` fire
  path measures 0.000 B/tick over 1,000,000 ticks; the async fire path is PINNED and
  allocates promise machinery by construction (this run 0.844 B/op, recorded, never
  advertised as zero). A soak of 200 reset cycles plus 1,000,000 ticks leaves the
  finalization residual within the ceiling (this run `size() 1/16`),
  `gc major=0 minor=0`. The `DI_ALLOC_BREAK` (per-tick alloc) and `DI_TORTURE_BREAK`
  (whole-suite) controls plus the ASCII-source gate each force a non-zero exit.
- `node:test`: 70/70 pass.

### API frozen at 1.0.0
The public surface is exactly the `Cron` class, the schedule builders (`interval`,
`every`, `cron`, `shouldRun`, `parseCronExpr`), the `CronError` type, `VERSION`, and
`OPTIONS`. Deliberately NOT included -- any would be a post-1.0.0 (1.1) change, never
a 1.0.x slip:
- NOT a frame loop -- for per-frame cadence synced to the display use
  `@zakkster/lite-di-ticker`; this is a wall-clock scheduler.
- NOT a virtual, reactive clock -- that is `@zakkster/lite-time`; this fires on real
  wall-clock time.
- NOT a distributed or persistent job queue -- no retries, no backpressure, no
  cross-process coordination; it is an in-process dispatcher.
- NOT the container -- wiring, lifetimes, and teardown live in
  `@zakkster/lite-di-container` (peer). The async fire path stays PINNED (allocates
  by construction; never gated at 0).

## [1.0.0-alpha.1] - 2026-08-09

First scoped release, built on the shipped `@zakkster/lite-di-container` v2.0.0
surface (`singleton`, `get`, `has`, `isBooted`, `boot`, `reset`, `unregister`).

### Added
- `Cron` class: a wall-clock task scheduler over a container topology. Jobs are
  classes with a `run(ctx)` method, registered as boot-locked per-id singletons;
  a single `tick()` walks the resolved list and fires each due job by index.
- `job(id, JobClass, schedule, opts?)` -- pre-start registration; delegates the
  binding to `container.singleton`. Duplicate id or a bad schedule throws.
- `arm()` / `start()` / `stop()` -- resolve-and-record, resolve-arm-tick, and
  clear-timer. `start()` arms an unref'd `setInterval(tickMs)` and ticks once.
- `tick(now?)` -- fires every due job. 0 bytes/tick on the synchronous,
  non-promise fire path (hard-gated at zero). A `run()` returning a thenable takes
  the async fire path, which allocates promise machinery by construction (pinned,
  recorded, never advertised as zero).
- Schedule builders `interval(everyMs, offsetMs?)`, `every(everyMs, { aligned? })`,
  `cron(expr)` (5-field UTC); the pure predicate `shouldRun`; and `parseCronExpr`.
- `setEnabled`, `has`, `list`, `running`, `tickCount`, `VERSION`, `OPTIONS`.

### Fixed (from the staged source)
- `reset()` now gates on the container boot-lock: it drives `container.reset()`
  FIRST to unlock, then unregisters each job key with NO silent catch -- a failed
  unregister propagates instead of leaving a torn-down binding retained.
- `tick()` no longer allocates per fire: the per-job settle handlers are hoisted
  to resolve time, and each job owns its ctx. The old shared `_ctx` (mutated every
  tick across all jobs) aliased any async job that outlived its tick -- a latent
  corruption bug, now removed.
- Constructor validates option keys with a did-you-mean hint, drops the bogus
  `LANES` export, and removes the `console.error` default (no `console.*`
  anywhere -- the default `onError` re-throws, fail closed and loud).

### Fail-closed contract
- The default `onError` re-throws; there is no silent swallow and no `console.*`.
- Unknown constructor option keys throw with a case-insensitive did-you-mean hint;
  bad option types throw a `TypeError`.
- `reset()` never silently swallows a failed unregister.
- A malformed cron expression / schedule throws at registration.

### Proven
- `node --expose-gc test/torture.mjs`: T0 schedule laws, T3 lifecycle +
  reset-against-boot-lock + job-error routing (A-CRON-2, A-CRON-3), T5 fuzz (32
  seeds, differential shouldRun replay), T6 the 0 B/tick gate over 1e6 ticks plus
  the recorded async fire lane (A-CRON-1), T7 soak (200 reset cycles clean +
  1e6-tick maxMajor<=0 soak, lite-leak size 0, peak <= 2x baseline, A-CRON-4), T9
  controls (ASCII + per-tick alloc break + whole-suite break, A-CRON-3 fail-closed).
- Per-lane allocation: sync `tick` 0.000 B/tick (hard gate); async fire ~0.8 B/op
  (recorded, pinned, not gated).
- ASCII-only source; zero runtime dependencies (the container is a peer
  dependency, not bundled).

[1.0.0]: https://www.npmjs.com/package/@zakkster/lite-di-cron
[1.0.0-alpha.1]: https://www.npmjs.com/package/@zakkster/lite-di-cron
