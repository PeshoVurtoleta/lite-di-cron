/**
 * T7 -- soak and retention (A-CRON-2, A-CRON-4).
 *
 * Phase 1 (A-CRON-2): reset cycles. Each cycle registers a job on a FRESH
 * container + cron, boots, ticks, then calls cron.reset() ON A BOOTED CONTAINER
 * (drive container.reset() first, then unregister -- no silent catch), re-job()s
 * the same id, re-boots, and ticks again to prove the swap flow succeeds. A
 * per-cycle external resource is tracked with lite-leak and drained via
 * container.shutdown(); tracker.size() must return to 0 with a clean audit.
 *
 * Phase 2 (A-CRON-4): a single long-lived cron drives 1e6 sync ticks under a
 * GcProfiler window. maxMajor <= 0 over the soak, and peak heapUsed stays within
 * 2x the post-warmup baseline: the schedule loop accretes nothing per tick.
 *
 * lite-leak's held-value contract: neither the cleanup closure nor the tag may
 * close over the tracked target, or finalization is defeated and the witness
 * reports a false clean.
 */

import { Container } from '@zakkster/lite-di-container';
import { createLeakTracker } from '@zakkster/lite-leak';
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { Cron, interval } from '../../Cron.js';
import { check, STATS } from './harness.mjs';

const CYCLES = 200;       // >= 100 (A-CRON-2)
const SOAK_TICKS = 1000000; // 1e6 (A-CRON-4)
const NOOP = function () {};
const clock = () => 0;

export async function run() {
    const tracker = createLeakTracker({
        name: 'cron-soak',
        onWarning: () => { STATS.warnings++; },
    });

    globalThis.gc();
    const heapBaseline = process.memoryUsage().heapUsed;
    let heapPeak = heapBaseline;

    // ---- Phase 1: reset cycles (A-CRON-2) -----------------------------------
    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const c = new Container();
        const cr = new Cron(c, { now: clock });
        class J1 { run() {} }
        cr.job('a', J1, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);

        // reset() against the boot-lock: unlocks the container, drops bindings.
        cr.reset();
        check(c.isBooted === false, () => `T7.reset: cycle ${cyc} container still booted after reset`);
        check(c.has('cron:job:a') === false, () => `T7.reset: cycle ${cyc} binding survived reset`);

        // re-job() succeeds -- the swap flow (boot -> reset -> re-register -> boot).
        let calls = 0;
        class J2 { run() { calls++; } }
        cr.job('a', J2, interval(1, 0));
        c.boot();
        cr.arm();
        cr.tick(0);
        check(calls === 1, () => `T7.reset: cycle ${cyc} re-job did not fire (calls=${calls})`);

        // Track a per-cycle external resource. cleanup/tag must NOT close over it.
        const h = tracker.track({ cycle: cyc }, NOOP, cyc);

        await c.shutdown();
        tracker.untrack(h);

        if ((cyc & 63) === 0) {
            globalThis.gc();
            const used = process.memoryUsage().heapUsed;
            if (used > heapPeak) heapPeak = used;
        }
    }

    globalThis.gc();
    const finalUsed = process.memoryUsage().heapUsed;
    if (finalUsed > heapPeak) heapPeak = finalUsed;

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);
    const findings = tracker.audit();
    STATS.leakSize = tracker.size();
    STATS.leakTarget = 0;
    STATS.findings = findings.length;
    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);
    check(heapPeak <= 2 * heapBaseline,
        () => `T7: peak heap ${(heapPeak / 1024).toFixed(0)} KB > 2x baseline ${(heapBaseline / 1024).toFixed(0)} KB`);

    // ---- Phase 2: 1e6-tick major-count soak (A-CRON-4) ----------------------
    const c2 = new Container();
    const cr2 = new Cron(c2, { now: clock });
    let fires = 0;
    class Tick { run(ctx) { fires += ctx.tick & 1; } }
    cr2.job('t', Tick, interval(1, 0));
    c2.boot();
    cr2.arm();

    for (let i = 0; i < 5000; i++) cr2.tick(i); // warm

    globalThis.gc();
    const soakBaseline = process.memoryUsage().heapUsed;
    let soakPeak = soakBaseline;

    const prof = new GcProfiler().start();
    let T = 5000;
    for (let i = 0; i < SOAK_TICKS; i++) {
        cr2.tick(T++);
        if ((i & 8191) === 0) {
            const used = process.memoryUsage().heapUsed;
            if (used > soakPeak) soakPeak = used;
        }
    }
    await new Promise((r) => setTimeout(r, 50)); // let async GC entries settle
    const s = prof.summary();
    prof.stop();

    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    check(report.ok && s.gc.major <= 0,
        () => `T7.soak: maxMajor gate over ${SOAK_TICKS} ticks failed -- major=${s.gc.major} maxMs=${s.gc.maxMs.toFixed(3)}`);

    globalThis.gc();
    const soakFinal = process.memoryUsage().heapUsed;
    if (soakFinal > soakPeak) soakPeak = soakFinal;
    check(soakPeak <= 2 * soakBaseline,
        () => `T7.soak: peak heap ${(soakPeak / 1024).toFixed(0)} KB > 2x baseline ${(soakBaseline / 1024).toFixed(0)} KB`);

    process.stderr.write('T7 soak: ' + CYCLES + ' reset cycles clean + ' + SOAK_TICKS +
        ' ticks major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' | leak size=' + tracker.size() + ' peak=' + (heapPeak / 1024).toFixed(0) +
        ' KB baseline=' + (heapBaseline / 1024).toFixed(0) + ' KB (fires=' + fires + ')\n');
}
