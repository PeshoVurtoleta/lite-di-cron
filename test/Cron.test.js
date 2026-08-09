// @zakkster/lite-di-cron -- node:test suite.
// Behavioural coverage plus a node:test case per assertion A-CRON-1..4. The full
// allocation and retention gates live in test/torture.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { measureAllocs, checkAllocs, measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { Cron, CronError, interval, every, cron, shouldRun, parseCronExpr, VERSION } from '../Cron.js';

const clock = (v) => () => v;

test('VERSION is a three-place-synced string', () => {
    assert.equal(typeof VERSION, 'string');
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('constructor requires a container', () => {
    assert.throws(() => new Cron(null), /container is required/);
    assert.throws(() => new Cron(undefined), /container is required/);
});

test('due jobs fire in registration order', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    const log = [];
    class A { run() { log.push('a'); } }
    class B { run() { log.push('b'); } }
    cr.job('a', A, interval(1000, 0));
    cr.job('b', B, interval(1000, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.deepEqual(log, ['a', 'b']);
});

test('DI-constructed jobs receive injected deps', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    c.value('cfg', { tag: 'T' });
    let seen;
    class J { constructor(cfg) { this.cfg = cfg; } run() { seen = this.cfg.tag; } }
    cr.job('j', J, interval(1000, 0), { deps: ['cfg'] });
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(seen, 'T');
});

test('a singleton job is built once across many ticks', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    let built = 0;
    let calls = 0;
    class J { constructor() { built++; } run() { calls++; } }
    cr.job('j', J, interval(1, 0));
    c.boot();
    cr.arm();
    for (let i = 0; i < 50; i++) cr.tick(i);
    assert.equal(built, 1);
    assert.equal(calls, 50);
});

test('the running-guard blocks self-overlap until the job settles', async () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    let starts = 0;
    let release;
    class J { run() { starts++; return new Promise((res) => { release = res; }); } }
    cr.job('j', J, interval(1, 0));
    c.boot();
    cr.arm();
    for (let i = 0; i < 5; i++) cr.tick(i);
    assert.equal(starts, 1, 'in-flight async job must not re-fire');
    release();
    await Promise.resolve(); await Promise.resolve();
    cr.tick(6);
    assert.equal(starts, 2);
});

test('setEnabled gates dispatch; a disabled job never fires', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    let calls = 0;
    class J { run() { calls++; } }
    cr.job('j', J, interval(1, 0), { enabled: false });
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(calls, 0);
    cr.setEnabled('j', true);
    cr.tick(1);
    assert.equal(calls, 1);
});

test('list() and has() reflect pending then resolved state', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class J { run() {} }
    cr.job('j', J, interval(1000, 0));
    assert.equal(cr.has('j'), true);
    assert.equal(cr.list().length, 1);
    c.boot();
    cr.arm();
    assert.equal(cr.list()[0].id, 'j');
});

test('schedule builders + shouldRun arithmetic', () => {
    assert.deepEqual(interval(1000, 500), { type: 'interval', everyMs: 1000, offsetMs: 500 });
    assert.equal(every(1000).aligned, true);
    assert.equal(cron('* * * * *').type, 'cron');
    assert.equal(shouldRun(interval(1000, 500), 400, -1, undefined, 0), false);
    assert.equal(shouldRun(interval(1000, 500), 500, -1, undefined, 0), true);
    assert.equal(shouldRun(every(1000), 2000, 1000), true);
    assert.equal(shouldRun(every(1000), 1999, 1000), false);
});

test('parseCronExpr rejects malformed expressions (fail closed)', () => {
    assert.throws(() => parseCronExpr('* * *'), /5 fields/);
    assert.throws(() => parseCronExpr('99 * * * *'), /Invalid cron field/);
    assert.throws(() => parseCronExpr('5-1 * * * *'), /Inverted cron range/);
});

test('start() fires immediately and stop() halts the timer', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0), tickMs: 100000 });
    let calls = 0;
    class J { run() { calls++; } }
    cr.job('j', J, interval(1, 0));
    c.boot();
    cr.start();
    assert.equal(calls, 1, 'start() ticks once immediately');
    assert.equal(cr.running, true);
    cr.stop();
    assert.equal(cr.running, false);
});

test('job() after start() fails closed', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0), tickMs: 100000 });
    class J { run() {} }
    cr.job('a', J, interval(1, 0));
    c.boot();
    cr.start();
    assert.throws(() => cr.job('b', J, interval(1, 0)), CronError);
    cr.stop();
});

test('catchJobErrors:true routes to onError; dispatch continues', () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let after = 0;
    class Boom { run() { throw new Error('boom'); } }
    class Ok { run() { after++; } }
    cr.job('boom', Boom, interval(1, 0));
    cr.job('ok', Ok, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(after, 1);
    assert.deepEqual(errs, ['boom']);
});

test('the default onError re-throws (fail closed + loud, no console)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class Boom { run() { throw new Error('boom'); } }
    cr.job('boom', Boom, interval(1, 0));
    c.boot();
    cr.arm();
    assert.throws(() => cr.tick(0), /boom/);
});

test('catchJobErrors:false re-throws out of tick', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0), catchJobErrors: false });
    class Boom { run() { throw new Error('boom'); } }
    cr.job('boom', Boom, interval(1, 0));
    c.boot();
    cr.arm();
    assert.throws(() => cr.tick(0), /boom/);
});

// ---- Fix 1 regression: a thenable whose .then throws on invocation ----------
test('Fix 1: a thenable whose .then throws clears running and is handled (never stuck)', () => {
    const c = new Container();
    const errs = [];
    const cr = new Cron(c, { now: clock(0), onError: (e, id) => errs.push(id) });
    let calls = 0;
    // run() returns a pathological thenable: invoking .then() throws synchronously.
    class Evil {
        run() {
            calls++;
            return { then() { throw new Error('then-boom'); } };
        }
    }
    cr.job('evil', Evil, interval(1, 0));
    c.boot();
    cr.arm();
    cr.tick(0);
    assert.equal(calls, 1);
    assert.deepEqual(errs, ['evil'], 'a throwing .then routes through _catchJobErrors like a sync throw');
    assert.equal(cr._jobs[0].running, false, 'running must be cleared, not stuck true');
    cr.tick(1);
    assert.equal(calls, 2, 'the job must be able to fire again on a later tick');
});

// ---- Fix 2 regression: async reject honors catchJobErrors symmetrically -----
// A controllable thenable lets us capture the exact rejection handler the code
// wired (job._onErr) and drive it directly. Invoking it reproduces precisely what
// a rejecting promise does to the async lane -- deterministically, with no global
// unhandled rejection escaping into the runner.
test('Fix 2: async reject uses the SAME _catchJobErrors decision as the sync lane', () => {
    // catchJobErrors:false -> the async reject re-throws (would become an unhandled
    // rejection by construction), exactly like the sync lane, and NOT to onError.
    const cFalse = new Container();
    const errsFalse = [];
    const crFalse = new Cron(cFalse, {
        now: clock(0), catchJobErrors: false, onError: (e, id) => errsFalse.push(id),
    });
    let onErrFalse;
    class AsyncBoomFalse {
        run() { return { then(_ok, onErr) { onErrFalse = onErr; } }; }
    }
    crFalse.job('ab', AsyncBoomFalse, interval(1, 0));
    cFalse.boot();
    crFalse.arm();
    crFalse.tick(0);
    assert.equal(typeof onErrFalse, 'function', 'the async lane wired a reject handler');
    let thrown;
    try { onErrFalse(new Error('async-boom')); } catch (e) { thrown = e; }
    assert.equal(thrown && thrown.message, 'async-boom',
        'catchJobErrors:false must re-throw the async reject (symmetric with sync)');
    assert.deepEqual(errsFalse, [], 'catchJobErrors:false must NOT route the async reject to onError');
    assert.equal(crFalse._jobs[0].running, false, 'running must clear on the reject settle path');

    // catchJobErrors:true -> the SAME decision routes to onError and continues.
    const cTrue = new Container();
    const errsTrue = [];
    const crTrue = new Cron(cTrue, {
        now: clock(0), catchJobErrors: true, onError: (e, id) => errsTrue.push(id),
    });
    let onErrTrue;
    class AsyncBoomTrue {
        run() { return { then(_ok, onErr) { onErrTrue = onErr; } }; }
    }
    crTrue.job('ab', AsyncBoomTrue, interval(1, 0));
    cTrue.boot();
    crTrue.arm();
    crTrue.tick(0);
    assert.doesNotThrow(() => onErrTrue(new Error('async-boom')),
        'catchJobErrors:true must not re-throw the async reject');
    assert.deepEqual(errsTrue, ['ab'], 'catchJobErrors:true must route the async reject to onError');
    assert.equal(crTrue._jobs[0].running, false, 'running must clear on the reject settle path');
});

// ---- A-CRON-3: unknown option key throws with a did-you-mean hint -----------
test('A-CRON-3: unknown option throws with a did-you-mean hint', () => {
    const c = new Container();
    assert.throws(() => new Cron(c, { tickMS: 5 }), /Unknown option 'tickMS'.*'tickMs'/);
    assert.throws(() => new Cron(c, { namespac: 'x' }), /Unknown option 'namespac'.*'namespace'/);
    assert.doesNotThrow(() => new Cron(c, { tickMs: 5, namespace: 'x' }));
    assert.throws(() => new Cron(c, { now: 7 }), TypeError);
});

// ---- A-CRON-2: reset() on a booted container -- re-job succeeds, size->0 -----
test('A-CRON-2: reset() unlocks the boot-lock, re-job succeeds, tracker.size()->0 over 100 cycles', async () => {
    const tracker = createLeakTracker({ name: 'cron-test' });
    const NOOP = function () {};
    for (let cyc = 0; cyc < 100; cyc++) {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        class J1 { run() {} }
        cr.job('a', J1, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);

        cr.reset(); // booted container -> drives container.reset() first
        assert.equal(c.isBooted, false);
        assert.equal(c.has('cron:job:a'), false);

        let calls = 0;
        class J2 { run() { calls++; } }
        cr.job('a', J2, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        assert.equal(calls, 1, 're-job after reset must fire');

        const h = tracker.track({ cycle: cyc }, NOOP, cyc);
        await c.shutdown();
        tracker.untrack(h);
    }
    assert.equal(tracker.size(), 0);
    assert.equal(tracker.audit().length, 0);
});

// ---- A-CRON-1: the sync, non-promise tick path is 0 B/op --------------------
test('A-CRON-1: a sync (non-promise) job ticks at 0 B/op', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    let hits = 0;
    class Sync { run(ctx) { hits += ctx.tick & 1; } }
    cr.job('s', Sync, interval(1, 0));
    c.boot();
    cr.arm();
    let T = 0;
    for (let i = 0; i < 5000; i++) cr.tick(T++); // warm
    const la = measureAllocs(() => { cr.tick(T++); },
        { iterations: 5000, batches: 8, warmup: 5000 });
    const ca = checkAllocs(la, { maxBytesPerCall: 0 });
    assert.equal(ca.verdict, 'pass', `sync tick measured ${la.bytesPerCall} B/call`);
    assert.equal(la.bytesPerCall, 0);
    assert.ok(hits >= 0);
});

// ---- A-CRON-4: soak -- maxMajor <= 0 over a long sync tick run ---------------
test('A-CRON-4: a long sync tick soak collects no major GC (maxMajor<=0)', () => {
    const c = new Container();
    const cr = new Cron(c, { now: clock(0) });
    class Tick { run() {} }
    cr.job('t', Tick, interval(1, 0));
    c.boot();
    cr.arm();
    let T = 0;
    const res = measureOps((i) => { cr.tick(T++); }, { ops: 300000, warmup: 5000, stabilize: 'deep' });
    const report = checkNoGc(res.summary, { maxMajor: 0, maxPauseMs: 4 });
    assert.ok(report.ok && res.summary.gc.major <= 0,
        `soak major=${res.summary.gc.major} maxMs=${res.summary.gc.maxMs.toFixed(3)}`);
});
