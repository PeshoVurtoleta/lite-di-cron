# @zakkster/lite-di-cron

> Wall-clock task scheduler over an @zakkster/lite-di-container topology. Jobs are DI-constructed classes registered as boot-locked per-id singletons; a single tick walks the resolved list and fires each due job by index. The synchronous, non-promise fire path allocates 0 bytes/tick -- hard-gated.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-di-cron.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-di-cron)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-tick-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-di-cron?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-di-cron)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-di-cron?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-cron)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-di-cron?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-cron)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The scheduler the DI ecosystem was missing

`@zakkster/lite-di-container` already builds, wires, and tears down your object
graph. What it did not have was a way to run those objects on a schedule -- jobs
with their own injected dependencies, built once at boot, torn down with
everything else. Every plain `setInterval` sits outside the container: its
callback is a loose closure the container never sees, never validates, and never
tears down.

`lite-di-cron` is that missing piece. Jobs are classes registered as per-id
singletons; the container constructs and caches them at boot; a single `tick()`
walks the resolved list and fires each due job by index into that job's own
pre-allocated context. No per-tick closure, no shared mutable context to corrupt
an in-flight async job, and no allocation on the synchronous fire path.

This is the WALL-CLOCK lane -- `setInterval`, a fixed interval, or a 5-field UTC
cron expression. It is NOT the frame loop (that is a requestAnimationFrame
ticker) and NOT a virtual reactive clock (that is `@zakkster/lite-time`).

```bash
npm install @zakkster/lite-di-cron
```

Peer dependency (not bundled, install it alongside):

```bash
npm install @zakkster/lite-di-container
```

```javascript
import { Container } from '@zakkster/lite-di-container';
import { Cron, interval, cron } from '@zakkster/lite-di-cron';

class Heartbeat { constructor(log) { this.log = log; } run(ctx) { this.log.push('beat ' + ctx.tick); } }
class Nightly { run() { /* roll logs */ } }

const c = new Container();
c.value('log', []);

const scheduler = new Cron(c, { tickMs: 1000 });
scheduler.job('heartbeat', Heartbeat, interval(1000, 0), { deps: ['log'] })
         .job('nightly', Nightly, cron('0 0 * * *'));   // 00:00 UTC daily
c.boot();
scheduler.start();                       // ticks immediately, then every second
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The dispatch model](#the-dispatch-model)
- [API reference](#api-reference)
  - [Constructor](#constructor)
  - [Methods](#methods)
  - [Schedule builders](#schedule-builders)
  - [Constants](#constants)
- [Composability with the container](#composability-with-the-container)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

A plain scheduler and a DI container solve different halves of the same problem
and never meet. `setInterval` fires, but its callback is a closure registered at
runtime -- outside the container's lifecycle, invisible to boot-time validation,
and leaked when you forget to clear it. The container wires and tears down your
services, but has no scheduling primitive.

The `singleton` bindings the container shipped in v2.0.0 -- construct a class once,
cache it, tear it down in reverse order -- are exactly what a job registry needs.
This package is that use case: a set of job classes registered per id, resolved
once at boot, and dispatched by a wall-clock tick that allocates nothing on the
synchronous path.

## What you get

- Jobs that are first-class container citizens: constructed with their own
  injected dependencies, cached at boot, torn down on shutdown.
- A synchronous `tick` that allocates zero bytes for a non-promise job -- one
  schedule check plus an in-place context mutation, no per-tick closure.
- Three schedule shapes: a drifting `interval`, an aligned `every`, and a 5-field
  UTC `cron` expression.
- Single-job-per-id dispatch: a job cannot overlap itself; an in-flight async job
  is not re-fired until it settles.
- Fail-closed behavior end to end: unknown options throw with a did-you-mean hint,
  an unhandled job error re-throws (never a silent swallow, never a `console.*`),
  and `reset()` respects the container's boot-lock.

## The dispatch model

<details>
<summary>How a single tick turns into an index loop (click to expand)</summary>

Registration is cold and happens before start. `job(id, Class, schedule, opts)`
delegates to `container.singleton(`${namespace}:job:${id}`, Class, deps)` and
records the schedule. Nothing is constructed yet.

`arm()` (or `start()`) resolves each job exactly once: it reads the cached
instance from the container, and builds -- ONCE, on this cold path -- that job's
own reusable `ctx` object and its two bound settle handlers. `tick(now?)` is then
a flat loop over the resolved list:

```javascript
for (let i = 0; i < len; i++) {
    const job = jobs[i];
    if (!job.enabled || job.running) continue;
    if (!shouldRun(job.schedule, t, job.lastRunAt, sharedDate, startedAt)) continue;
    job.lastRunAt = t;
    job.running = true;
    const jctx = job.ctx;
    jctx.now = t;           // mutate this job's OWN ctx in place -- 0 B
    jctx.tick = tick;
    _fireJob(this, job);    // try/catch + thenable branch live here, off the loop frame
}
```

The schedule check is pure arithmetic. The context is each job's own object,
mutated in place -- no per-tick allocation. Because a job cannot re-fire while it
is `running`, mutating its own ctx per fire can never corrupt an in-flight async
continuation (the fix for the old shared-`_ctx` aliasing bug: one context across
all jobs, mutated every tick, corrupted any async job that outlived its tick). The
`try/catch` and the thenable branch live in `_fireJob`, extracted so the loop
frame stays optimizable under V8. A `run()` that returns a thenable settles via
the job's pre-bound handlers -- no closure per fire.

</details>

## API reference

### Constructor

```typescript
new Cron(container: Container, options?: {
  tickMs?: number; now?: () => number; onError?: OnError;
  catchJobErrors?: boolean; namespace?: string; bindingKey?: string;
})
```

Valid keys: `tickMs` (default 1000), `now` (default `Date.now`), `onError`,
`catchJobErrors` (default true), `namespace` (default `'cron'`), and `bindingKey`
(an alias for `namespace`). An unknown key throws with a case-insensitive
3-char-prefix did-you-mean hint (`Unknown option 'tickMS'. Did you mean 'tickMs'?`).
A non-function `now`/`onError`, a non-positive `tickMs`, or an empty `namespace`
is a `TypeError`. A null/undefined container is a `TypeError`. The default
`onError` re-throws (fail closed and loud -- there is no `console.*` anywhere).

### Methods

```typescript
job(id: string, JobClass: JobClass, schedule: Schedule, opts?: JobOptions): this
arm(): this
start(): this
stop(): this
tick(now?: number): void
setEnabled(id: string, enabled: boolean): this
has(id: string): boolean
list(): JobInfo[]
reset(): void
```

- `job` -- pre-start registration only; delegates to `container.singleton`.
  `opts.deps` are injected into the class; `opts.enabled` defaults to true.
  Duplicate id or a malformed schedule throws a `CronError`. Chainable.
- `arm` -- resolve the job list and record the start time; no timer armed.
- `start` -- resolve, record the start time, arm an unref'd `setInterval(tickMs)`,
  and tick once immediately.
- `stop` -- clear the interval timer.
- `tick` -- fire every due job. 0 bytes/tick for a synchronous, non-promise job.
  Pass an explicit `now` to drive it deterministically (tests, custom loops).
- `setEnabled` / `has` / `list` -- job introspection and enable/disable.
- `reset` -- drop the resolved list + pending registrations and remove the DI job
  bindings. Fail closed against the boot-lock: if the container is booted,
  `container.reset()` runs FIRST to unlock it, then each job key is unregistered
  with NO silent catch. Note: `container.reset()` is container-GLOBAL -- on a
  SHARED container it clears ALL singletons and unlocks the boot-lock for the whole
  container, not just cron's job keys (the container API only unlocks via
  reset/clear). Do not call `reset()` on a shared container unless you mean to tear
  the whole container down.

### Schedule builders

```typescript
interval(everyMs: number, offsetMs?: number): IntervalSchedule
every(everyMs: number, opts?: { aligned?: boolean }): EverySchedule
cron(expr: string): CronSchedule
```

- `interval` -- fires every `everyMs` (drifting from the last run); `offsetMs`
  delays only the FIRST run, relative to start.
- `every` -- aligned (default) fires when the wall-clock bucket
  `floor(now / everyMs)` advances; unaligned behaves like a simple gap.
- `cron` -- 5-field UTC expression (`*, N, N-M, N-M/S, */S, A,B,C`). When BOTH
  day-of-month and day-of-week are restricted, a match on EITHER fires (standard
  cron OR rule); otherwise AND.

### Constants

| Export    | Type                | Meaning                                             |
| --------- | ------------------- | --------------------------------------------------- |
| `VERSION` | `string`            | Three-place-synced version (`1.0.0-alpha.1`).       |
| `OPTIONS` | `readonly string[]` | Frozen list of the only valid constructor options.  |

## Composability with the container

A full pipeline: values and singletons wired in the container, jobs DI-constructed
by the scheduler, reverse-order teardown at the end.

```javascript
import { Container } from '@zakkster/lite-di-container';
import { Cron, interval, cron } from '@zakkster/lite-di-cron';

class Clock { now() { return Date.now(); } }
class Sweep {
  constructor(clock, db) { this.clock = clock; this.db = db; }
  run() { this.db.purgeOlderThan(this.clock.now() - 86400000); }
}
class Report {
  constructor(db) { this.db = db; }
  async run() { await this.db.emitDailyReport(); }   // async fire path (pinned lane)
}

const c = new Container();
c.singleton('clock', Clock);
c.value('db', myDb);

const scheduler = new Cron(c, { tickMs: 1000, onError: (e, id) => report(e, id) });
scheduler.job('sweep', Sweep, interval(3600000, 0), { deps: ['clock', 'db'] })
         .job('report', Report, cron('0 0 * * *'), { deps: ['db'] });
c.boot();
scheduler.start();                      // hot path: 0 B/tick for the sync sweep

await c.shutdown();                      // tears down Clock/Sweep/Report in reverse order
```

## Zero-GC design notes

<details>
<summary>Per-lane allocation, measured and gated (click to expand)</summary>

The synchronous, non-promise fire path is the whole point of the package, so it is
gated at exactly zero -- not "small", zero -- two independent ways in
`test/torture.mjs`: `measureAllocs` at `maxBytesPerCall: 0` (retained bytes,
forced collection) and `measureOps(stabilize: 'deep')` over 1,000,000 ticks with
`checkNoGc(maxMajor: 0)` (no major GC, no ArrayBuffer growth). The async fire path
-- a `run()` that returns a thenable -- is the honest boundary: settling a promise
allocates machinery by construction, so its rate is RECORDED and loosely pinned,
never claimed to be zero. The "allocates nothing per tick" claim holds for
synchronous, non-promise jobs ONLY.

| Lane                              | Allocation      | How it is gated                            |
| --------------------------------- | --------------- | ------------------------------------------ |
| `tick` (sync, non-promise job)    | 0.000 B/tick    | HARD gate at 0 over 1e6 ticks, maxMajor 0  |
| async fire (`run()` -> thenable)  | ~0.8 B/op       | PINNED (recorded, not gated at zero)       |

What makes 0 B/tick possible: the container owns the job instance (nothing to
build per tick), each job's context object and its two settle handlers are
allocated once at resolve time (not per fire), the schedule check is pure
arithmetic, and the loop mutates that context in place. The `try/catch` and the
thenable branch are extracted to `_fireJob` so the loop frame stays optimizable.
Because a job is guarded from re-firing until it settles, its own context is never
touched by two overlapping fires -- so the per-job context is safe to reuse and
zero-alloc at the same time.

Numbers reproduce with `node --expose-gc test/torture.mjs` (gated by
`@zakkster/lite-gc-profiler`; retention proven by `@zakkster/lite-leak`).

</details>

## Design decisions worth knowing

- **One context per job, not one shared context.** The staged source mutated a
  single `_ctx` every tick and handed it to every job. An async job that outlived
  its tick then read a context the next tick had already overwritten -- latent
  corruption. Each job now owns its context; the running-guard means no two fires
  of the same job overlap, so per-job reuse is both correct and zero-alloc.
- **Settle handlers hoisted off the fire path.** A job's `onOk`/`onErr` handlers
  are bound once at resolve time, so an async fire allocates no closure per tick;
  the promise machinery it does allocate is the honest, pinned cost.
- **`reset()` respects the boot-lock.** The container refuses `unregister` while
  booted. `reset()` drives `container.reset()` FIRST to unlock, then unregisters
  each job key with no silent catch -- a failed unregister propagates rather than
  leaving a torn-down binding retained.
- **Fail closed on job errors.** With no `onError` configured, an unhandled job
  error re-throws (loud) rather than being printed or swallowed -- there is no
  `console.*` anywhere. Provide `onError` to observe-and-continue. Both lanes go
  through the SAME decision: with the default `onError` (which re-throws), a
  rejection on the ASYNC job lane degrades to a process-level unhandled rejection
  (loud, not silent) -- symmetric intent with the sync lane's re-throw.
- **Fail closed on any thenable.** A job may return any thenable; if invoking its
  `.then()` itself throws, the running guard is still cleared and the error routes
  through the same `catchJobErrors` decision -- the guard is never left stuck.
- **Fail closed on configuration.** Unknown option keys throw with a did-you-mean
  hint; bad option types throw. There is no silent-ignore default.
- **Deterministic by injection.** Pass `now` and drive `tick()` by hand for a
  fully deterministic schedule in tests -- no timers, no wall-clock flakiness.

## Testing

- `npm test` -- 19 `node:test` cases (behavioural coverage plus a case per
  assertion A-CRON-1..4).
- `npm run torture` -- `node --expose-gc test/torture.mjs`: T0 schedule laws, T3
  lifecycle + reset-against-boot-lock + job-error routing, T5 fuzz (32 seeds,
  differential `shouldRun` replay), T6 the 0 B/tick gate (1e6 ticks) + the async
  fire lane, T7 soak (200 reset cycles + a 1e6-tick `maxMajor<=0` soak, lite-leak
  retention + heap bound), T9 controls (each gate proven able to fail:
  `DI_ASCII_BREAK`, `DI_ALLOC_BREAK`, `DI_TORTURE_BREAK`).
- `npm run example` -- [`examples/scheduled-jobs.mjs`](examples/scheduled-jobs.mjs): a
  shipped, self-verifying reference consumer. A scheduled-jobs service with DI-constructed
  jobs on interval / aligned-bucket / UTC-cron schedules, driven DETERMINISTICALLY by an
  injected clock + explicit `tick(now)` (no real timers). It asserts the exact firing
  sequence, `setEnabled` skipping, the `start`/`stop`/`running`/`tickCount` timer lane,
  the pure `shouldRun`/`parseCronExpr` helpers, `CronError` codes (duplicate id, malformed
  cron), onError job-error isolation, `reset()` unlocking the boot-lock, and the
  fail-closed construction guards -- all with `node:assert`, so a broken contract exits
  non-zero. It is the downstream proof that the 1.0.0 API works in anger.
- `npm run verify` -- all three, in order. `prepublishOnly` runs `verify`.

## What this is not

- Not a frame loop. For per-frame cadence synced to the display, use a
  requestAnimationFrame ticker; this is a wall-clock scheduler.
- Not a virtual, reactive clock. For a clock you advance by hand and subscribe to,
  use `@zakkster/lite-time`; this fires jobs on real wall-clock time.
- Not a distributed or persistent job queue. No retries, no backpressure, no
  cross-process coordination; this is an in-process wall-clock dispatcher.
- Not the container. Wiring, lifetimes, scopes, and teardown live in
  `@zakkster/lite-di-container` (the peer dependency).

## Ecosystem

- `@zakkster/lite-di-container` -- the DI container this scheduler is built on
  (peer dependency).
- `@zakkster/lite-di-event-bus` -- the sibling DI fan-out primitive.
- `@zakkster/lite-gc-profiler` -- the allocation/GC gate used to prove 0 B/tick.
- `@zakkster/lite-leak` -- the retention witness used in the soak tier.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
