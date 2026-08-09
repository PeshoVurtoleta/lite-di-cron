// @zakkster/lite-di-cron -- QA boundary suite.
// Final-gate coverage the happy-path suite (Cron.test.js) misses: the entry-point
// boundary matrix (0, 1, N-1, N, N+1, empty, null, undefined, NaN, -0, duplicate
// dispose, dispose-during-iteration, re-entrant write, and one adversarial case),
// plus every fail-closed edge and the running-guard-never-stuck invariant across
// BOTH error lanes. Pure node:test behavioural verification -- the allocation and
// retention gates live in test/torture.mjs. Determinism: captured handlers and
// microtask flushes only, never a wall-clock sleep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { Cron, CronError, interval, every, cron, shouldRun, parseCronExpr } from '../Cron.js';

const clock = (v) => () => v;

// A minimal stand-in container that lets us drive reset() failure lanes the real
// Container cannot easily reproduce. Only the methods cron actually calls exist.
function stubContainer(overrides = {}) {
    return {
        _booted: true,
        singletons: 0,
        unregisters: 0,
        get isBooted() { return this._booted; },
        singleton() { this.singletons++; },
        has() { return true; },
        get() { return { run() {} }; },
        reset() { this._booted = false; },
        unregister() { this.unregisters++; },
        ...overrides,
    };
}

// ===========================================================================
// Boundary matrix -- job-count: 0, 1, N-1, N, N+1 (duplicate-id overrun)
// ===========================================================================

test('boundary[0 jobs]: tick() on an armed cron with zero jobs is a safe no-op that still advances tickCount', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    c.boot();
    cr.arm();
    assert.equal(cr.list().length, 0);
    assert.doesNotThrow(() => cr.tick(0));
    assert.equal(cr.tickCount, 1, 'tickCount advances even with no jobs');
    assert.doesNotThrow(() => cr.tick(1));
    assert.equal(cr.tickCount, 2);
});

test('boundary[1 job]: exactly one due job fires exactly once per due tick', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    let calls = 0;
    class J { run() { calls++; } }
    cr.job('j', J, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(calls, 1);
});

test('boundary[N-1,N]: every one of N due jobs fires once, in registration order, none dropped', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    const N = 5;
    const log = [];
    for (let i = 0; i < N; i++) {
        const label = 'j' + i;
        const Job = class { run() { log.push(label); } };
        cr.job(label, Job, interval(1, 0));
    }
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(log.length, N, 'all N jobs fired -- no tail dropped (N)');
    assert.deepEqual(log, ['j0', 'j1', 'j2', 'j3', 'j4'], 'fired by registration index (N-1 boundary is the second-to-last)');
});

test('boundary[N+1]: a duplicate job id is refused (DUPLICATE_ID) -- the id set never overruns', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    cr.job('dup', J, interval(1, 0));
    assert.throws(() => cr.job('dup', J, interval(1, 0)), (e) => e instanceof CronError && e.code === 'DUPLICATE_ID');
    assert.equal(cr.list().length, 1, 'the rejected duplicate did not grow the registration set');
});

// ===========================================================================
// Boundary matrix -- empty / null / undefined / NaN / -0 (null is not zero)
// ===========================================================================

test('boundary[empty]: an empty-string job id is rejected (INVALID_ID), never treated as a valid key', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('', J, interval(1, 0)), (e) => e instanceof CronError && e.code === 'INVALID_ID');
});

test('boundary[empty]: an empty options object uses defaults and constructs cleanly', () => {
    const c = new Container();
    assert.doesNotThrow(() => new Cron(c, {}));
});

test('boundary[null]: a null job id is rejected, not coerced to a key', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job(null, J, interval(1, 0)), (e) => e instanceof CronError && e.code === 'INVALID_ID');
});

test('boundary[null]: a null schedule is rejected (INVALID_SCHEDULE), never a silent default', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('j', J, null), (e) => e instanceof CronError && e.code === 'INVALID_SCHEDULE');
});

test('boundary[null]: tickMs=null THROWS -- null is not zero, and not the 1000ms default (fail closed)', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { tickMs: null }), TypeError);
});

test('boundary[null]: now=null THROWS -- a null clock is rejected, never silently Date.now', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { now: null }), TypeError);
});

test('boundary[null]: namespace=null THROWS -- not coerced to the "cron" default', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { namespace: null }), TypeError);
});

test('boundary[undefined]: a missing options argument is the all-defaults path', () => {
    const c = new Container();
    assert.doesNotThrow(() => new Cron(c));
    assert.doesNotThrow(() => new Cron(c, undefined));
});

test('boundary[undefined]: an undefined schedule is rejected (INVALID_SCHEDULE)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('j', J, undefined), (e) => e instanceof CronError && e.code === 'INVALID_SCHEDULE');
});

test('boundary[NaN]: tickMs=NaN THROWS -- NaN is not a positive number, never treated as 0', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { tickMs: NaN }), TypeError);
});

test('boundary[NaN]: everyMs=NaN in an interval schedule is rejected (INVALID_SCHEDULE)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('j', J, interval(NaN, 0)), (e) => e instanceof CronError && e.code === 'INVALID_SCHEDULE');
});

test('boundary[-0]: tickMs=-0 THROWS -- -0 is not > 0, rejected not defaulted', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { tickMs: -0 }), TypeError);
});

test('boundary[-0]: everyMs=-0 in an interval schedule is rejected (INVALID_SCHEDULE)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('j', J, interval(-0, 0)), (e) => e instanceof CronError && e.code === 'INVALID_SCHEDULE');
});

test('boundary[0]: tickMs=0 and everyMs=0 are both rejected -- zero is not a valid cadence', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { tickMs: 0 }), TypeError);
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('j', J, interval(0, 0)), (e) => e instanceof CronError && e.code === 'INVALID_SCHEDULE');
});

// ===========================================================================
// Fail-closed: option validation + did-you-mean; namespace/bindingKey empties
// ===========================================================================

test('boundary[empty]: namespace="" and bindingKey="" are rejected (non-empty required)', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { namespace: '' }), TypeError);
    assert.throws(() => new Cron(c, { bindingKey: '' }), TypeError);
});

test('fail-closed: onError set to a non-function throws TypeError (no silent fallback)', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { onError: 42 }), TypeError);
    assert.throws(() => new Cron(c, { onError: 'nope' }), TypeError);
});

test('did-you-mean: an unknown option with no near match throws a hintless Unknown-option error', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { zzz: 1 }), (e) => /Unknown option 'zzz'/.test(e.message) && !/Did you mean/.test(e.message));
});

// ===========================================================================
// Fail-closed: parseCronExpr on every malformed shape -- never a silent default
// ===========================================================================

test('fail-closed[cron]: empty expression is rejected (must have 5 fields)', () => {
    assert.throws(() => parseCronExpr(''), /5 fields/);
});

test('fail-closed[cron]: too many fields (6) is rejected', () => {
    assert.throws(() => parseCronExpr('* * * * * *'), /5 fields/);
});

test('fail-closed[cron]: a non-numeric field is rejected, never silently 0', () => {
    assert.throws(() => parseCronExpr('abc * * * *'), /Invalid cron field/);
});

test('fail-closed[cron]: minute 60 (one past max) is rejected -- boundary N+1 on the field range', () => {
    assert.throws(() => parseCronExpr('60 * * * *'), /Invalid cron field/);
});

test('fail-closed[cron]: day-of-month 0 (one below min) is rejected -- boundary 0 on a 1-based field', () => {
    assert.throws(() => parseCronExpr('* * 0 * *'), /Invalid cron field/);
});

test('fail-closed[cron]: a zero step (*/0) is rejected, never an infinite/degenerate set', () => {
    assert.throws(() => parseCronExpr('*/0 * * * *'), /Invalid step/);
});

test('boundary[cron min/max]: minute 0 and 59 (the exact field bounds) parse and are present', () => {
    const p = parseCronExpr('0 0 1 1 0');
    assert.ok(p.minute.has(0));
    const p2 = parseCronExpr('59 23 31 12 6');
    assert.ok(p2.minute.has(59) && p2.hour.has(23) && p2.dom.has(31) && p2.month.has(12) && p2.dow.has(6));
});

test('fail-closed[schedule]: an unknown schedule type is rejected (INVALID_SCHEDULE)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    assert.throws(() => cr.job('j', J, { type: 'weekly' }), (e) => e instanceof CronError && e.code === 'INVALID_SCHEDULE');
});

// ===========================================================================
// reset() -- fail-closed on a booted container + propagation, no half-reset
// ===========================================================================

test('reset[booted]: drives container.reset() first, unlocks the boot-lock, re-job() succeeds', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J1 { run() {} }
    cr.job('a', J1, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(c.isBooted, true);

    cr.reset();
    assert.equal(c.isBooted, false, 'reset() unlocked the container');
    assert.equal(c.has('cron:job:a'), false, 'the job binding was unregistered');

    let calls = 0;
    class J2 { run() { calls++; } }
    cr.job('a', J2, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(calls, 1, 're-job after reset must fire');
});

test('reset[dispose x2]: a second reset() is a safe no-op (duplicate dispose)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    cr.job('j', J, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    cr.reset();
    assert.doesNotThrow(() => cr.reset(), 'duplicate reset must not throw');
    assert.equal(cr.list().length, 0);
    assert.equal(cr.running, false);
});

test('reset[unregister throws]: the throw PROPAGATES, timer disarmed, running-guard not stuck (no half-reset)', () => {
    const stub = stubContainer({ unregister() { throw new Error('unregister-boom'); } });
    const cr = new Cron(stub, { now: clock(0), tickMs: 1e9 });
    class J { run() {} }
    cr.job('a', J, interval(1, 0));
    cr.start(); // arms a timer + resolves jobs
    assert.equal(cr.running, true);

    assert.throws(() => cr.reset(), /unregister-boom/, 'a failing unregister must propagate, not be silently caught');
    // stop() runs FIRST inside reset(), so even on the throw path the timer is
    // disarmed and running is cleared -- cron is not left half-reset.
    assert.equal(cr.running, false, 'timer/running cleared before the propagating throw (stop() ran first)');
    assert.equal(cr._timer, null, 'the interval timer was disarmed despite the throw');
});

test('reset[container.reset throws]: the throw PROPAGATES and the timer is already disarmed', () => {
    const stub = stubContainer({ reset() { throw new Error('reset-boom'); } });
    const cr = new Cron(stub, { now: clock(0), tickMs: 1e9 });
    class J { run() {} }
    cr.job('a', J, interval(1, 0));
    cr.start();
    assert.throws(() => cr.reset(), /reset-boom/);
    assert.equal(cr.running, false, 'stop() disarmed the timer before container.reset() threw');
    assert.equal(cr._timer, null);
});

// ===========================================================================
// Running-guard invariant under BOTH error lanes -- never stuck (Fix 1/2 core)
// ===========================================================================

test('guard[sync throw]: after a sync throw the running flag clears so the job fires again next tick', () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let calls = 0;
    class Boom { run() { calls++; throw new Error('boom'); } }
    cr.job('b', Boom, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(cr._jobs[0].running, false, 'running cleared after a sync throw');
    cr.tick(1);
    assert.equal(calls, 2, 'the job re-fires on the next tick -- not stuck');
    assert.deepEqual(errs, ['b', 'b']);
});

test('guard[async reject]: after a rejected thenable settles, running clears and the job re-fires', async () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let starts = 0;
    class J { run() { starts++; return Promise.reject(new Error('nope')); } }
    cr.job('j', J, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cr._jobs[0].running, false, 'running cleared on the reject settle path');
    assert.deepEqual(errs, ['j']);
    cr.tick(1);
    assert.equal(starts, 2, 'the job re-fires after the rejection settled');
});

test('guard[throwing .then invocation]: a thenable whose .then() throws on CALL clears running and routes to onError', () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let calls = 0;
    class Evil { run() { calls++; return { then() { throw new Error('then-call-boom'); } }; } }
    cr.job('e', Evil, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(cr._jobs[0].running, false);
    assert.deepEqual(errs, ['e']);
    cr.tick(1);
    assert.equal(calls, 2, 'not stuck -- re-fires');
});

// ===========================================================================
// ADVERSARIAL (planner did not think of it): a thenable whose `.then` is a
// THROWING GETTER. The property READ -- typeof result.then -- previously sat
// OUTSIDE _fireJob's guard, so it threw out of tick() unguarded (even with the
// default catchJobErrors:true) and left running=true stuck forever: the job was
// bricked and never fired again. Fix 1's inner try only guarded `.then`
// INVOCATION, not its ACCESS. Locked here across BOTH lanes.
// ===========================================================================

test('ADVERSARIAL[throwing .then getter, catch:true]: routes to onError, running clears, job re-fires (never bricked)', () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let calls = 0;
    class Evil {
        run() {
            calls++;
            return { get then() { throw new Error('then-getter-boom'); } };
        }
    }
    cr.job('evil', Evil, interval(1, 0));
    c.boot();
    cr.arm();
    assert.doesNotThrow(() => cr.tick(0), 'a throwing .then GETTER must not escape tick under catchJobErrors:true');
    assert.deepEqual(errs, ['evil'], 'the getter throw routes through the SAME job-error decision as a sync throw');
    assert.equal(cr._jobs[0].running, false, 'running must be cleared, not stuck true');
    cr.tick(1);
    assert.equal(calls, 2, 'the job must fire again on a later tick -- not permanently bricked');
});

test('ADVERSARIAL[throwing .then getter, catch:false]: re-throws through the SAME decision, running still clears', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0), catchJobErrors: false });
    class Evil { run() { return { get then() { throw new Error('then-getter-boom'); } }; } }
    cr.job('evil', Evil, interval(1, 0));
    c.boot();
    cr.arm();
    assert.throws(() => cr.tick(0), /then-getter-boom/, 'catchJobErrors:false re-throws the getter failure symmetrically with the sync lane');
    assert.equal(cr._jobs[0].running, false, 'running must clear even on the re-throw path (never stuck)');
});

// ===========================================================================
// Error-lane symmetry -- one decision, both lanes (catchJobErrors true/false)
// ===========================================================================

test('symmetry[catch:true]: BOTH a sync throw and an async reject route to onError and dispatch continues', async () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let after = 0;
    class SyncBoom { run() { throw new Error('s'); } }
    class AsyncBoom { run() { return Promise.reject(new Error('a')); } }
    class Ok { run() { after++; } }
    cr.job('s', SyncBoom, interval(1, 0));
    cr.job('a', AsyncBoom, interval(1, 0));
    cr.job('ok', Ok, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(after, 1, 'dispatch continued past both failing jobs');
    assert.deepEqual(errs.sort(), ['a', 's'], 'both lanes routed to onError');
});

test('symmetry[catch:false]: a sync throw re-throws out of tick (same decision the async lane would make)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0), catchJobErrors: false });
    class SyncBoom { run() { throw new Error('sync-boom'); } }
    cr.job('s', SyncBoom, interval(1, 0));
    c.boot();
    cr.arm();
    assert.throws(() => cr.tick(0), /sync-boom/);
});

// ===========================================================================
// Running-guard blocks self-overlap: a slow thenable does not re-enter
// ===========================================================================

test('overlap: a slow (unsettled) thenable job does not re-enter until it settles', async () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    let starts = 0;
    let release;
    class Slow { run() { starts++; return new Promise((res) => { release = res; }); } }
    cr.job('slow', Slow, interval(1, 0));
    c.boot();
    cr.arm();
    for (let i = 0; i < 6; i++) cr.tick(i); // many ticks, one in-flight job
    assert.equal(starts, 1, 'the in-flight job must not re-enter itself');
    assert.equal(cr._jobs[0].running, true, 'still marked running until it settles');
    release();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(cr._jobs[0].running, false);
    cr.tick(7);
    assert.equal(starts, 2, 'fires again only after the prior run settled');
});

// ===========================================================================
// dispose-during-iteration: reset() called from inside a job mid-tick
// ===========================================================================

test('dispose-during-iteration: reset() from inside a job lets the in-flight tick finish on its stale local list, then state is reset', () => {
    // tick() captures `const jobs = this._jobs` as a local; reset() reassigns
    // this._jobs = [] but cannot mutate the array object the loop already holds.
    // Locked behaviour: the in-flight dispatch runs to completion, and only the
    // post-tick state reflects the reset.
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    const log = [];
    class A { run() { log.push('a'); cr.reset(); } }
    class B { run() { log.push('b'); } }
    cr.job('a', A, interval(1, 0));
    cr.job('b', B, interval(1, 0));
    c.boot();
    cr.arm();
    assert.doesNotThrow(() => cr.tick(0));
    assert.deepEqual(log, ['a', 'b'], 'the in-flight dispatch finished even though reset() ran mid-loop');
    assert.equal(cr.list().length, 0, 'state is reset after the tick');
    assert.equal(cr.running, false);
    assert.equal(c.isBooted, false, 'reset() drove container.reset() from inside the job');
});

// ===========================================================================
// re-entrant write: job() attempted from inside a running job is refused
// ===========================================================================

test('re-entrant write: job() called from inside a running job fails closed (ALREADY_STARTED)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0), tickMs: 1e9 });
    let caught = null;
    class R {
        run() {
            class M { run() {} }
            try { cr.job('m', M, interval(1, 0)); } catch (e) { caught = e; }
        }
    }
    cr.job('r', R, interval(1, 0));
    c.boot();
    cr.start(); // start() ticks once immediately -> R.run() attempts a re-entrant job()
    assert.ok(caught instanceof CronError && caught.code === 'ALREADY_STARTED',
        'a re-entrant registration during dispatch must fail closed');
    cr.stop();
});

// ===========================================================================
// setEnabled / has / list boundary behaviour
// ===========================================================================

test('setEnabled: an unknown job id fails closed (UNKNOWN_JOB), never a silent no-op', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    cr.job('j', J, interval(1, 0));
    assert.throws(() => cr.setEnabled('nope', true), (e) => e instanceof CronError && e.code === 'UNKNOWN_JOB');
});

test('has()/list(): unknown id -> false; empty cron -> empty list', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    assert.equal(cr.has('nope'), false);
    assert.deepEqual(cr.list(), []);
});

// ===========================================================================
// shouldRun arithmetic edges: NaN now, aligned every, interval offset boundary
// ===========================================================================

test('shouldRun[NaN now]: a NaN clock reading never reports a job as due (no phantom slot-0 fire)', () => {
    assert.equal(shouldRun(interval(1000, 0), NaN, -1, undefined, 0), false);
    assert.equal(shouldRun(every(1000, { aligned: false }), NaN, 1000), false);
});

test('shouldRun[interval offset boundary]: fires exactly at startedAt+offset, not one tick before', () => {
    assert.equal(shouldRun(interval(1000, 500), 499, -1, undefined, 0), false);
    assert.equal(shouldRun(interval(1000, 500), 500, -1, undefined, 0), true);
});

test('shouldRun[every 0]: a zero-period every schedule never fires (defensive, not divide-by-zero)', () => {
    assert.equal(shouldRun({ type: 'every', everyMs: 0, aligned: false }, 1000, -1), false);
});

test('shouldRun[cron builder]: a valid cron expression round-trips through the schedule builder', () => {
    assert.equal(cron('* * * * *').type, 'cron');
    // minute-slot advance: same minute never double-fires, next minute does.
    const s = cron('* * * * *');
    assert.equal(shouldRun(s, 60000, -1), true, 'first run at a fresh minute');
    assert.equal(shouldRun(s, 60000, 60000), false, 'same minute-slot does not re-fire');
    assert.equal(shouldRun(s, 120000, 60000), true, 'the next minute fires');
});
