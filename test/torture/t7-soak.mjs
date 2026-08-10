/**
 * T7 -- soak and retention (A-CRON-2, A-CRON-4). The AUTHORITY is FINALIZATION, not a
 * counter trick.
 *
 * Phase 1 (A-CRON-2): reset cycles. Each cycle registers a job on a FRESH container +
 * cron, boots, ticks, then calls cron.reset() ON A BOOTED CONTAINER (drive
 * container.reset() first, then unregister -- no silent catch), re-job()s the same id,
 * re-boots, and ticks again to prove the swap flow succeeds. The CRON is then tracked
 * with lite-leak WITHOUT untracking it (cleanup NOOP + numeric tag capture NOTHING, so
 * the cron -- and the container it closes over -- is held only WEAKLY). After the loop
 * we settle HARD (>= 10 gc()+tick passes) and assert the finalization residual
 * tracker.size() <= RES = max(16, CYCLES/1000): a cron that was really released is
 * collected (size--), one that leaked is not.
 *
 * (An earlier track+immediate-untrack asserted size()===0 -- a VACUOUS TAUTOLOGY:
 * unregister decrements the live counter synchronously, netting to 0 every cycle even
 * if the cron were retained forever, and it tracked a throwaway {cycle} object rather
 * than the cron. Fixed here per the promotion-ladder gate 2 -- a retention gate must
 * FAIL on a retained object.)
 *
 * Phase 2 (A-CRON-4): a single long-lived cron drives 1e6 sync ticks under a GcProfiler
 * window. maxMajor <= 0 over the soak, and peak heapUsed stays within 2x the
 * post-warmup baseline: the schedule loop accretes nothing per tick.
 *
 * DI_TORTURE_BREAK=1 retains each cron in a module sink -> size() stays ~CYCLES and
 * BLOWS RES, tripping the residual gate DIRECTLY. (Whole-suite control; in a full run an
 * earlier tier may trip first -- prove the soak in isolation:
 * DI_TORTURE_BREAK=1 node --expose-gc -e "import('./test/torture/t7-soak.mjs').then(m=>m.run())".)
 */

import { Container } from '@zakkster/lite-di-container';
import { createLeakTracker } from '@zakkster/lite-leak';
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { Cron, interval } from '../../Cron.js';
import { check, BREAK, STATS } from './harness.mjs';

const CYCLES = 200;       // >= 100 (A-CRON-2)
const SOAK_TICKS = 1000000; // 1e6 (A-CRON-4)
/** AUTHORITY residual ceiling. Clean leaves single digits; a real leak leaves ~CYCLES. */
const RES = Math.max(16, (CYCLES / 1000) | 0); // 16
const NOOP = function () {};
const clock = () => 0;

/** BREAK: retains each cron so it can NEVER be finalized -> size() stays ~CYCLES. */
const sink = [];

/** Hard settle: run FinalizationRegistry callbacks to ground before reading size(). */
async function settleHard() {
    for (let i = 0; i < 10; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 15));
    }
}

export async function run() {
    const tracker = createLeakTracker({
        name: 'cron-soak',
        onWarning: () => { STATS.warnings++; },
    });

    globalThis.gc();
    const heapBaseline = process.memoryUsage().heapUsed;

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

        await c.shutdown();

        // AUTHORITY: track the CRON without untracking; finalization decides its fate.
        // Neither NOOP nor the numeric tag closes over the cron (held-value contract).
        tracker.track(cr, NOOP, cyc);
        if (BREAK) sink.push(cr); // pin -> can NEVER be finalized -> size() stays high.
    }

    await settleHard();
    const residual = tracker.size();
    const findings = tracker.audit();
    STATS.leakSize = residual;
    STATS.leakTarget = RES;
    STATS.findings = findings.length;

    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);
    // AUTHORITY: finalization residual. A real leak would leave ~CYCLES.
    check(residual <= RES,
        () => `T7: AUTHORITY finalization residual size()=${residual} > ${RES} -- a cron outlived its shutdown`);

    // SECONDARY (NOT the authority): coarse one-time-growth backstop.
    globalThis.gc();
    const phase1Delta = process.memoryUsage().heapUsed - heapBaseline;
    check(phase1Delta < 2 * 1024 * 1024,
        () => `T7.heap: (secondary) phase-1 heap delta ${(phase1Delta / 1024).toFixed(1)} KB >= 2048 KB`);

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
        ' | AUTHORITY residual size()=' + residual + '/' + RES +
        ' | (secondary) phase-1 heap delta=' + (phase1Delta / 1024).toFixed(1) + ' KB (fires=' + fires + ')\n');
}
