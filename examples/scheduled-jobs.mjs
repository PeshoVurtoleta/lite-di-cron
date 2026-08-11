/**
 * Reference app -- a wall-clock scheduled-jobs service (gate-3 downstream consumer).
 *
 * Proves @zakkster/lite-di-cron "in anger": DI-constructed job classes registered under
 * a boot-locked topology, scheduled by interval / aligned-bucket / 5-field UTC cron, and
 * fired by a single tick that walks the resolved list. The whole run is DETERMINISTIC:
 * an injected clock (`now`) plus explicit `tick(now)` calls drive time by hand -- no real
 * timers, no wall-clock flakiness -- so every firing is asserted exactly.
 *
 * It exercises every public export and method end-to-end, not in fragments:
 *   - new Cron(container, { tickMs, now, onError })   + OPTIONS + VERSION
 *   - job(id, JobClass, schedule, { deps, enabled })  (DI-constructed jobs, chainable)
 *   - the schedule builders interval() / every() / cron()
 *   - arm() + tick(now)                               (deterministic driving)
 *   - start() / stop() / running / tickCount          (the real-timer lane)
 *   - setEnabled() / has() / list()
 *   - reset()                                         (unlock the boot-lock, drop bindings)
 *   - the pure helpers shouldRun() and parseCronExpr()
 *   - CronError (.code) on a duplicate id / a malformed schedule / job after start
 *   - error isolation: with an onError a throwing job is routed to it and the tick
 *     continues; with the DEFAULT onError a job error re-throws (loud fail-closed)
 *   - the fail-closed contract: unknown option, non-function now, non-positive tickMs,
 *     empty namespace, null container, job() after start -- all throw.
 *
 * (Out of this example's scope, exercised by the test/torture suite instead: the async
 * fire lane where run() returns a thenable, catchJobErrors:false, and a custom namespace.)
 *
 * It is self-verifying: every claim is asserted with node:assert, so a broken contract
 * exits non-zero. Run it: `npm run example` (or `node examples/scheduled-jobs.mjs`).
 * ASCII-only; the only imports are the two @zakkster packages and node:assert.
 *
 * NOTE: @zakkster/lite-di-container is a PEER dependency of this package -- install it
 * alongside (`npm i @zakkster/lite-di-container`) to run this example from a tarball.
 */

import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import {
    Cron, CronError, interval, every, cron, shouldRun, parseCronExpr, OPTIONS, VERSION,
} from '@zakkster/lite-di-cron';

/** Tiny ASCII logger -- a demo prints, but never from library source. */
const out = (line) => process.stdout.write(line + '\n');

/** Shared throw asserter -- returns the caught error for message/code checks. */
const throwsOn = (fn, label) => {
    let e = null;
    try { fn(); } catch (err) { e = err; }
    assert.ok(e instanceof Error, label + ' MUST fail closed (throw)');
    return e;
};

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z -- a UTC midnight
let clock = T0;                            // the injected wall clock, advanced by hand

// A test sink the jobs record into. In a real app these are your log roller,
// metrics flusher, report mailer, etc.
const sink = { fired: [] };
class Heartbeat { constructor(s) { this.s = s; } run() { this.s.fired.push('hb'); } }
class MinuteRollup { constructor(s) { this.s = s; } run() { this.s.fired.push('min'); } }
class Nightly { constructor(s) { this.s = s; } run() { this.s.fired.push('night'); } }

// ---------------------------------------------------------------------------
// Wire the container + scheduler. Registration is PRE-START only (static topology).
// ---------------------------------------------------------------------------
const c = new Container();
c.value('sink', sink);
const scheduler = new Cron(c, { tickMs: 1000, now: () => clock, onError: () => {} });
scheduler.job('hb', Heartbeat, interval(1000), { deps: ['sink'] })
    .job('min', MinuteRollup, every(60000, { aligned: true }), { deps: ['sink'] })
    .job('night', Nightly, cron('0 0 * * *'), { deps: ['sink'] });
c.boot();
scheduler.arm(); // resolve the job list + record the start time; no timer armed

out('scheduled-jobs reference app -- @zakkster/lite-di-cron v' + VERSION);
assert.ok(Object.isFrozen(OPTIONS), 'OPTIONS must be frozen');
assert.deepEqual([...OPTIONS], ['tickMs', 'now', 'onError', 'catchJobErrors', 'namespace', 'bindingKey']);
assert.ok(typeof VERSION === 'string' && VERSION.length > 0);
assert.deepEqual(scheduler.list().map((j) => j.id), ['hb', 'min', 'night']);
assert.ok(scheduler.has('hb') && !scheduler.has('nope'));
assert.equal(scheduler.running, false, 'arm() does not arm a timer');

// ---------------------------------------------------------------------------
// 1. Deterministic driving. Advance the clock and tick by hand. hb fires every
//    1000ms; min fires when the 60s bucket advances; night fires at UTC midnight.
// ---------------------------------------------------------------------------
for (const dt of [0, 1000, 2000, 60000, DAY]) { clock = T0 + dt; scheduler.tick(clock); }
out('\n-- firings ----------------------------------------------------------');
out('sequence: ' + sink.fired.join(' '));
assert.deepEqual(sink.fired, ['hb', 'min', 'night', 'hb', 'hb', 'hb', 'min', 'hb', 'min', 'night'],
    'each job fired on exactly its due ticks, in registration order');
assert.equal(scheduler.tickCount, 5, 'five tick() calls');

// ---------------------------------------------------------------------------
// 2. setEnabled -- a disabled job is skipped; the others still fire.
// ---------------------------------------------------------------------------
scheduler.setEnabled('hb', false);
assert.equal(scheduler.list().find((j) => j.id === 'hb').enabled, false);
sink.fired = [];
clock = T0 + 2 * DAY; scheduler.tick(clock); // all three would be due, but hb is off
assert.deepEqual(sink.fired, ['min', 'night'], 'the disabled job did not fire');
scheduler.setEnabled('hb', true);

// ---------------------------------------------------------------------------
// 3. Pure helpers -- shouldRun() and parseCronExpr(), usable without a Cron.
// ---------------------------------------------------------------------------
assert.equal(shouldRun(interval(1000), T0 + 1000, T0), true, 'due at the interval boundary');
assert.equal(shouldRun(interval(1000), T0 + 500, T0), false, 'not yet due before it');
assert.ok(parseCronExpr('0 0 * * *'), 'a valid cron expression parses');
const badExpr = throwsOn(() => parseCronExpr('not a cron'), 'a malformed cron expression');
assert.ok(badExpr instanceof CronError, 'parseCronExpr throws a CronError on malformed input');

// ---------------------------------------------------------------------------
// 4. CronError on a duplicate id -- carries a machine-readable .code.
// ---------------------------------------------------------------------------
const dup = throwsOn(() => scheduler.job('hb', Heartbeat, interval(1000)), 'a duplicate job id');
assert.ok(dup instanceof CronError && dup.code === 'DUPLICATE_ID', 'duplicate id -> CronError DUPLICATE_ID');

// ---------------------------------------------------------------------------
// 5. The real-timer lane -- start() ticks once immediately and arms an unref'd
//    interval; stop() clears it. (Fresh scheduler so the deterministic one above
//    is undisturbed.)
// ---------------------------------------------------------------------------
{
    const c2 = new Container();
    let t2 = 0;
    let beats = 0;
    class Beat { run() { beats += 1; } }
    const s2 = new Cron(c2, { tickMs: 1000, now: () => t2 });
    s2.job('beat', Beat, interval(1000));
    c2.boot();
    s2.start();
    assert.equal(s2.running, true, 'start() arms the timer');
    assert.ok(s2.tickCount >= 1 && beats >= 1, 'start() ticks once immediately');
    s2.stop();
    assert.equal(s2.running, false, 'stop() clears the timer');
}

// ---------------------------------------------------------------------------
// 6. Error isolation -- with an onError, a throwing job is caught and the tick
//    continues to the next job (catchJobErrors is on by default).
// ---------------------------------------------------------------------------
{
    const c3 = new Container();
    let t3 = 0;
    const errors = [];
    let goodRan = 0;
    class Bad { run() { throw new Error('backup target unreachable'); } }
    class Good { run() { goodRan += 1; } }
    const s3 = new Cron(c3, { now: () => t3, onError: (e) => errors.push(e.message) });
    s3.job('bad', Bad, interval(1000)).job('good', Good, interval(1000));
    c3.boot();
    s3.arm();
    t3 = 0; s3.tick(t3);
    assert.deepEqual(errors, ['backup target unreachable'], 'the throwing job was routed to onError');
    assert.equal(goodRan, 1, 'the tick continued to the next job after the throw');
    out('\n-- error isolation --------------------------------------------------');
    out('a throwing job was routed to onError; the next job still ran');
}

// ---------------------------------------------------------------------------
// 7a. A job registered enabled:false never fires (fresh scheduler).
// ---------------------------------------------------------------------------
{
    const cOff = new Container();
    let tOff = 0;
    let offRan = 0;
    class Off { run() { offRan += 1; } }
    const sOff = new Cron(cOff, { now: () => tOff });
    sOff.job('off', Off, interval(1000), { enabled: false });
    cOff.boot();
    sOff.arm();
    assert.equal(sOff.list().find((j) => j.id === 'off').enabled, false);
    tOff = 0; sOff.tick(tOff); tOff = 1000; sOff.tick(tOff);
    assert.equal(offRan, 0, 'a job registered enabled:false never fires');
}

// ---------------------------------------------------------------------------
// 7b. The DEFAULT onError is loud: with no onError provided, a job error re-throws
//     out of tick() (fail closed, never a silent swallow).
// ---------------------------------------------------------------------------
{
    const cDef = new Container();
    let tDef = 0;
    class Bad { run() { throw new Error('scheduled backup failed'); } }
    const sDef = new Cron(cDef, { now: () => tDef }); // no onError -> default re-throws
    sDef.job('bad', Bad, interval(1000));
    cDef.boot();
    sDef.arm();
    tDef = 0;
    throwsOn(() => sDef.tick(tDef), 'the default onError re-throws a job error');
}

// ---------------------------------------------------------------------------
// 7c. FAIL-CLOSED construction + topology guards.
// ---------------------------------------------------------------------------
const optErr = throwsOn(() => new Cron(c, { tikMs: 1000 }), 'an unknown option key');
assert.match(optErr.message, /Unknown option/, 'unknown option is named');
throwsOn(() => new Cron(c, { now: 5 }), 'a non-function now');
throwsOn(() => new Cron(c, { tickMs: 0 }), 'a non-positive tickMs');
throwsOn(() => new Cron(c, { namespace: '' }), 'an empty namespace');
throwsOn(() => new Cron(null), 'a null container');
// job() after start() is a CronError with a machine-readable code. The guard needs a
// STARTED scheduler, so use a fresh one (the deterministic scheduler stays undisturbed).
{
    const cStarted = new Container();
    let tS = 0;
    class Once { run() {} }
    const sStarted = new Cron(cStarted, { now: () => tS });
    sStarted.job('a', Once, interval(1000));
    cStarted.boot();
    sStarted.start();
    const late = throwsOn(() => sStarted.job('late', Once, interval(1000)), 'job() after start');
    assert.ok(late instanceof CronError && late.code === 'ALREADY_STARTED',
        'job() after start -> CronError ALREADY_STARTED');
    sStarted.stop();
}
out('\n-- fail-closed ------------------------------------------------------');
out('enabled:false skip, default-onError re-throw, unknown option, non-function now, ' +
    'non-positive tickMs, empty namespace, null container, job()-after-start (ALREADY_STARTED) all held');

// ---------------------------------------------------------------------------
// 8. reset() -- unlock the boot-lock and drop the DI job bindings. After reset the
//    job keys are gone and the container is unlocked (fail-closed: a failed
//    unregister would propagate, never a silent swallow).
// ---------------------------------------------------------------------------
// The DI binding key is `${namespace}:job:${id}` -- 'cron:job:hb' by default. It exists
// while registered and must be GONE from the container itself after reset (not merely
// from cron's own state -- reset() runs container.unregister with no silent catch).
assert.equal(c.has('cron:job:hb'), true, 'the job binding is registered on the container');
scheduler.reset();
assert.ok(!scheduler.has('hb') && !scheduler.has('night'), 'reset() dropped cron state');
assert.equal(c.has('cron:job:hb'), false, 'reset() unregistered the job binding from the container');
assert.equal(c.isBooted, false, 'reset() unlocked the container');
out('\nreference app: OK (every contract asserted)');
