/**
 * T3 -- lifecycle and fail-closed sequencing.
 *
 * The register -> boot -> arm -> tick -> reset -> re-register contract, the
 * boot-lock-aware reset() (A-CRON-2: drive container.reset() FIRST, then
 * unregister with no silent catch), and the job-error routing (catchJobErrors +
 * onError; the default onError re-throws -- fail closed and LOUD, never a
 * console.* and never a silent swallow).
 */

import { Container } from '@zakkster/lite-di-container';
import { Cron, CronError, interval } from '../../Cron.js';
import { check } from './harness.mjs';

const clock = (v) => () => v;

export async function run() {
    // -- register -> boot -> tick -> reset -> re-register -> boot -> tick ------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        let calls = 0;
        class J { run() { calls++; } }
        cr.job('a', J, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        check(calls === 1, () => `T3.cycle: first tick fired ${calls}, expected 1`);

        // reset() on a BOOTED container: must unlock (container.reset first), then
        // unregister the job bindings -- no silent catch.
        cr.reset();
        check(c.isBooted === false, () => 'T3.reset: container still booted after cron.reset()');
        check(c.has('cron:job:a') === false, () => 'T3.reset: job binding survived reset()');
        check(cr.has('a') === false, () => 'T3.reset: pending registration survived reset()');

        // Re-register the same id and boot again -- the swap flow works.
        let calls2 = 0;
        class J2 { run() { calls2++; } }
        cr.job('a', J2, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        check(calls2 === 1, () => `T3.reset: re-registered job fired ${calls2}, expected 1`);
    }

    // -- reset() on an UN-booted container still clears bindings ---------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) });
        class J { run() {} }
        cr.job('a', J, interval(1, 0));
        // never booted
        cr.reset();
        check(c.has('cron:job:a') === false, () => 'T3.reset-unbooted: binding survived reset()');
        check(cr.has('a') === false, () => 'T3.reset-unbooted: registration survived reset()');
    }

    // -- job() after start() is a fail-closed error ---------------------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0), tickMs: 100000 });
        class J { run() {} }
        cr.job('a', J, interval(1, 0));
        c.boot();
        cr.start();
        let threw = false;
        try { cr.job('b', J, interval(1, 0)); } catch (e) { threw = e instanceof CronError; }
        check(threw, () => 'T3.lock: job() after start() did not fail closed');
        cr.stop();
        check(cr.running === false, () => 'T3.lock: stop() did not clear running');
    }

    // -- catchJobErrors: true routes to onError, dispatch survives ------------
    {
        const c = new Container();
        const errs = [];
        const cr = new Cron(c, {
            now: clock(0),
            onError: (err, id) => errs.push(id + '/' + err.message),
        });
        let after = 0;
        class Boom { run() { throw new Error('boom'); } }
        class Ok { run() { after++; } }
        cr.job('boom', Boom, interval(1, 0));
        cr.job('ok', Ok, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        check(after === 1, () => 'T3.err: dispatch did not continue past a throwing job');
        check(errs.length === 1 && /boom\/boom/.test(errs[0]),
            () => `T3.err: onError not routed: ${errs.join(',')}`);
    }

    // -- catchJobErrors: false re-throws out of tick --------------------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0), catchJobErrors: false });
        class Boom { run() { throw new Error('boom'); } }
        cr.job('boom', Boom, interval(1, 0));
        c.boot();
        cr.arm();
        let threw = false;
        try { cr.tick(0); } catch (e) { threw = /boom/.test(e.message); }
        check(threw, () => 'T3.err: catchJobErrors:false did not re-throw out of tick');
    }

    // -- default onError re-throws (fail closed + loud, no console) ------------
    {
        const c = new Container();
        const cr = new Cron(c, { now: clock(0) }); // no onError -> _defaultOnError
        class Boom { run() { throw new Error('boom'); } }
        cr.job('boom', Boom, interval(1, 0));
        c.boot();
        cr.arm();
        let threw = false;
        try { cr.tick(0); } catch (e) { threw = /boom/.test(e.message); }
        check(threw, () => 'T3.err: the default onError swallowed a job error instead of re-throwing');
    }

    // -- async job rejection routes to onError, then re-fires after settle -----
    {
        const c = new Container();
        const errs = [];
        const cr = new Cron(c, { now: clock(0), onError: (err, id) => errs.push(id) });
        let starts = 0;
        class J { run() { starts++; return Promise.reject(new Error('nope')); } }
        cr.job('j', J, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        await Promise.resolve(); await Promise.resolve();
        check(errs.length === 1 && errs[0] === 'j', () => `T3.async: rejection not routed: ${errs.join(',')}`);
        check(cr._jobs[0].running === false, () => 'T3.async: running flag not cleared after rejection settle');
        cr.tick(1);
        check(starts === 2, () => `T3.async: job did not re-fire after a settled rejection, starts=${starts}`);
    }
}
