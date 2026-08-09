# Cookbook -- @zakkster/lite-di-cron

Recipes, beginner to pro. This is a stub for the alpha; it grows alongside the
`@zakkster/lite-di-*` dependents line. Every snippet is runnable against the
shipped `@zakkster/lite-di-container` v2.0.0 surface.

## 1. A minimal interval job

```javascript
import { Container } from '@zakkster/lite-di-container';
import { Cron, interval } from '@zakkster/lite-di-cron';

class Beat { run(ctx) { /* fires on ctx.tick */ } }

const c = new Container();
const cron = new Cron(c, { tickMs: 1000 });
cron.job('beat', Beat, interval(1000, 0));
c.boot();
cron.start();                 // ticks immediately, then every second
```

## 2. Jobs with injected dependencies

Jobs are DI-constructed, so they receive their own deps by name:

```javascript
class Report {
  constructor(db) { this.db = db; }
  run() { /* this.db.flush() ... */ }
}

c.value('db', myDb);
cron.job('report', Report, interval(60000, 0), { deps: ['db'] });
```

## 3. Cron expressions (5-field, UTC)

```javascript
import { cron as expr } from '@zakkster/lite-di-cron';

cron.job('nightly', Nightly, expr('0 0 * * *'));   // 00:00 UTC daily
cron.job('quarter', Quarter, expr('*/15 * * * *')); // every 15 minutes
```

When BOTH day-of-month and day-of-week are restricted, a match on EITHER fires
(standard cron OR rule).

## 4. Sync vs async jobs

A `run()` that returns nothing takes the zero-alloc sync path. A `run()` that
returns a promise takes the async fire path; the job will not re-fire until it
settles (single-job-per-id, no overlap).

```javascript
class Sync  { run() { /* 0 B/tick */ } }
class Async { async run() { await doWork(); } }   // pinned lane, allocates by construction
```

## 5. Handling job errors

By default an unhandled job error re-throws (fail closed, loud -- never a silent
swallow, never a `console.*`). Provide `onError` to observe-and-continue:

```javascript
const cron = new Cron(c, {
  onError: (err, jobId) => report(err, jobId),
});
```

## 6. Test-swap flow with reset()

`reset()` gates on the container boot-lock: it unlocks the container (driving
`container.reset()` first), then drops the job bindings -- so you can re-register
and re-boot cleanly between tests.

```javascript
cron.job('a', A, interval(1000, 0));
c.boot(); cron.arm(); cron.tick(0);

cron.reset();                 // unlocks + removes bindings (no silent catch)
cron.job('a', B, interval(1000, 0));
c.boot(); cron.arm();         // swapped
```

## 7. Deterministic driving in tests

Pass an explicit `now` and drive `tick()` by hand -- no timers, fully
deterministic:

```javascript
const cron = new Cron(c, { now: () => 0 });
c.boot(); cron.arm();
cron.tick(0);
cron.tick(1000);              // advance the wall clock yourself
```
