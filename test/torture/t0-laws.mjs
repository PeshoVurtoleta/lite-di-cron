/**
 * T0 -- cron schedule laws.
 *
 * Properties that must hold for ANY topology: DI-constructed jobs, per-id
 * singletons, dispatch in registration order, the running-guard against
 * self-overlap, schedule arithmetic fidelity, and config fail-closed with a
 * did-you-mean hint.
 */

import { Container } from '@zakkster/lite-di-container';
import { Cron, interval, every, cron, shouldRun } from '../../Cron.js';
import { makePrng, SEED, check } from './harness.mjs';

const clock = (v) => () => v;

export async function run() {
    const prng = makePrng(SEED);

    // -- Law 1: due jobs fire in registration order ---------------------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        const log = [];
        class A { run() { log.push('A'); } }
        class B { run() { log.push('B'); } }
        class D { run() { log.push('D'); } }
        cr.job('a', A, interval(1000, 0));
        cr.job('b', B, interval(1000, 0));
        cr.job('d', D, interval(1000, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        check(log.length === 3, () => `T0.order: expected 3 fires, got ${log.length}`);
        check(log[0] === 'A' && log[1] === 'B' && log[2] === 'D',
            () => `T0.order: wrong order: ${log.join(',')}`);
    }

    // -- Law 2: DI-constructed jobs receive their injected deps ---------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        c.value('prefix', '>>');
        let seen = null;
        class J {
            constructor(prefix) { this.prefix = prefix; }
            run(ctx) { seen = this.prefix + ctx.tick; }
        }
        cr.job('j', J, interval(1000, 0), { deps: ['prefix'] });
        c.boot();
        cr.arm();
        cr.tick(0);
        check(seen === '>>1', () => `T0.deps: injected dep not applied, got ${seen}`);
    }

    // -- Law 3: singleton job -- one instance across many ticks ---------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        let built = 0;
        let calls = 0;
        class J { constructor() { built++; } run() { calls++; } }
        cr.job('j', J, interval(1, 0));
        c.boot();
        cr.arm();
        for (let i = 0; i < 100; i++) cr.tick(i);
        check(built === 1, () => `T0.singleton: job built ${built} times, expected 1`);
        check(calls === 100, () => `T0.singleton: job fired ${calls} times, expected 100`);
    }

    // -- Law 4: the running-guard blocks self-overlap -------------------------
    // An async job whose promise has not settled must NOT be re-fired.
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        let starts = 0;
        let release = null;
        class J {
            run() { starts++; return new Promise((res) => { release = res; }); }
        }
        cr.job('j', J, interval(1, 0));
        c.boot();
        cr.arm();
        for (let i = 0; i < 10; i++) cr.tick(i); // due every tick, but in-flight
        check(starts === 1, () => `T0.guard: overlapping fire not blocked, starts=${starts}`);
        release(); // settle
        await Promise.resolve(); await Promise.resolve();
        cr.tick(11);
        check(starts === 2, () => `T0.guard: job did not re-fire after settle, starts=${starts}`);
    }

    // -- Law 5: enabled gating -- disabled jobs never fire --------------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        let calls = 0;
        class J { run() { calls++; } }
        cr.job('j', J, interval(1, 0), { enabled: false });
        c.boot();
        cr.arm();
        cr.tick(0); cr.tick(1);
        check(calls === 0, () => `T0.enabled: a disabled job fired ${calls} times`);
        cr.setEnabled('j', true);
        cr.tick(2);
        check(calls === 1, () => `T0.enabled: re-enabled job fired ${calls} times, expected 1`);
    }

    // -- Law 6: schedule arithmetic fidelity (pure shouldRun) -----------------
    {
        // interval: offset delays the first run only, then fires by everyMs gap.
        check(shouldRun(interval(1000, 500), 400, -1, undefined, 0) === false,
            () => 'T0.sched: interval fired before its offset');
        check(shouldRun(interval(1000, 500), 500, -1, undefined, 0) === true,
            () => 'T0.sched: interval did not fire at its offset');
        check(shouldRun(interval(1000, 0), 2000, 1000, undefined, 0) === true,
            () => 'T0.sched: interval did not fire after everyMs elapsed');
        check(shouldRun(interval(1000, 0), 1400, 1000, undefined, 0) === false,
            () => 'T0.sched: interval fired before everyMs elapsed');
        // every(aligned): fires when the wall-clock bucket advances.
        check(shouldRun(every(1000), 1000, -1) === true,
            () => 'T0.sched: aligned every did not fire on first tick');
        check(shouldRun(every(1000), 1999, 1000) === false,
            () => 'T0.sched: aligned every fired inside the same bucket');
        check(shouldRun(every(1000), 2000, 1000) === true,
            () => 'T0.sched: aligned every did not fire on bucket advance');
    }

    // -- Law 7: cron day OR/AND rule ------------------------------------------
    {
        const sd = new Date(0);
        // 2021-01-01 is a Friday (dow=5). dom=1.
        const jan1 = Date.UTC(2021, 0, 1, 0, 0, 0);
        // BOTH dom and dow restricted -> OR: dom=1 matches even though dow!=1.
        check(shouldRun(cron('0 0 1 * 1'), jan1, -1, sd) === true,
            () => 'T0.cron: OR-rule (dom OR dow) did not fire when dom matched');
        // Only dom restricted (dow=*) -> AND semantics collapse to dom match.
        check(shouldRun(cron('0 0 2 * *'), jan1, -1, sd) === false,
            () => 'T0.cron: dom=2 fired on the 1st');
    }

    // -- Law 8: config is fail-closed with a did-you-mean hint (A-CRON-3) ------
    {
        const c = new Container();
        let msg = '';
        try { new Cron(c, { tickMS: 5 }); } catch (e) { msg = e.message; }
        check(/Unknown option 'tickMS'/.test(msg) && /'tickMs'/.test(msg),
            () => `T0.config: did-you-mean missing, got: ${msg}`);
        let ok = true;
        try { new Cron(c, { tickMs: 5, namespace: 'x' }); } catch { ok = false; }
        check(ok, () => 'T0.config: valid options were rejected');
        let te = false;
        try { new Cron(c, { onError: 7 }); } catch (e) { te = e instanceof TypeError; }
        check(te, () => 'T0.config: a non-function onError was not rejected');
    }

    // -- A seeded random corpus: N jobs on interval(1) all fire every tick -----
    for (let g = 0; g < 40; g++) {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        const nJobs = 1 + (prng() % 6);
        let calls = 0;
        for (let j = 0; j < nJobs; j++) {
            class J { run() { calls++; } }
            cr.job('j' + j, J, interval(1, 0));
        }
        c.boot();
        cr.arm();
        const ticks = 5;
        for (let t = 0; t < ticks; t++) cr.tick(t);
        check(calls === nJobs * ticks,
            () => `T0.corpus: graph ${g} fired ${calls} != ${nJobs * ticks} (seed=${SEED})`);
    }
}
