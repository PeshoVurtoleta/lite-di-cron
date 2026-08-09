/**
 * T6 -- the zero-alloc gate (A-CRON-1), plus the honest async fire lane.
 *
 * The synchronous, NON-PROMISE tick path is the whole point of this package: the
 * schedule loop walks the resolved jobs, and for a due sync job mutates that
 * job's OWN pre-allocated ctx in place and calls run(ctx). No per-tick closure,
 * no shared-ctx aliasing, no allocation. On a booted, fully-resolved topology
 * that is ZERO retained bytes per tick -- hard-gated here two ways:
 *
 *   Lane A  measureAllocs at maxBytesPerCall:0 -- RETAINED bytes, forced-collect.
 *   Lane B  measureOps(stabilize:'deep') over 1e6 ticks -- major/pause/arrayBuffers
 *           budget via checkNoGc(maxMajor:0). PASS iff bytes/op === 0.
 *
 * The async FIRE path (a job whose run() returns a thenable) is the honest
 * boundary: settling a promise allocates machinery BY CONSTRUCTION, so it is
 * RECORDED and loosely PINNED, never gated at zero. Claiming zero there would be
 * a lie -- the "allocates nothing per tick" claim holds for sync, non-promise
 * jobs ONLY.
 *
 * DI_ALLOC_BREAK=1 injects one retained allocation PER TICK into the measured
 * body; the gate must then reject both lanes. That is the per-tick control.
 */

import { measureAllocs, checkAllocs, measureOpsAsync, checkOpsAsync }
    from '@zakkster/lite-gc-profiler';
import { Container } from '@zakkster/lite-di-container';
import { Cron, interval } from '../../Cron.js';
import { runOpsGate, ALLOC_BREAK, BREAK, check, die, STATS } from './harness.mjs';

const HOT = 1000000;      // 1e6 ticks (>> the 1e4 floor in A-CRON-1)
const PIN_ASYNC = 4096;   // B/op ceiling for the async fire lane -- recorded, pinned

const INJECT = ALLOC_BREAK || BREAK;

/** Retained sink for the break control -- survives GC so the gate must reject. */
const sink = [];

// Monotonic wall clock: advances by 1 every tick so an interval(1) job is due on
// every tick regardless of warmup/measured window boundaries. A plain number
// increment -- no allocation.
let TNOW = 0;

export async function run() {
    // Everything the hot body touches is built ONCE here, outside every window.
    const c = new Container();
    let hits = 0;
    const cr = new Cron(c, { now: () => 0 });
    class Sync { run(ctx) { hits += ctx.tick & 1; } } // non-promise return -> sync path
    cr.job('sync', Sync, interval(1, 0));
    c.boot();
    cr.arm();

    // Warm the resolved list + per-job ctx so the measured windows see steady state.
    for (let i = 0; i < 5000; i++) cr.tick(TNOW++);

    const ctxBefore = cr._jobs[0].ctx;

    // ---- Lane A: retained bytes per tick -- HARD-gated at 0 -----------------
    const la = measureAllocs(
        () => { cr.tick(TNOW++); if (INJECT) sink.push(new Float64Array(8)); },
        { iterations: 5000, batches: 12, warmup: 5000 });
    const ca = checkAllocs(la, { maxBytesPerCall: 0 });
    check(ca.verdict === 'pass' && la.bytesPerCall === 0,
        () => `T6.A1 laneA: sync tick must be 0 B/tick, measured ${la.bytesPerCall} (verdict=${ca.verdict})` +
            (INJECT ? ' (break control -- expected)' : ''));
    if (INJECT) die('T6.A1: DI_ALLOC_BREAK injected allocations but laneA gate passed');
    sink.length = 0;

    // ---- Lane B: 1e6 ticks -- major/pause/arrayBuffers budget ----------------
    const hot = () => { cr.tick(TNOW++); if (INJECT) sink.push(new Float64Array(8)); };
    const { report, summary } = runOpsGate(hot, { ops: HOT, warmup: 5000 });

    // Structural assertions no heap gate can make: the per-job ctx is never
    // reallocated, and the job settles (running never sticks) on the sync path.
    check(cr._jobs[0].ctx === ctxBefore, () => 'T6.struct: the per-job ctx was reallocated during the tick soak');
    check(cr._jobs[0].running === false, () => 'T6.struct: sync job running flag stuck after tick');

    STATS.gcMajor = summary.gc.major;
    STATS.gcMinor = summary.gc.minor;
    STATS.gcMaxMs = summary.gc.maxMs;
    STATS.allocBytesPerOp = la.bytesPerCall;

    if (!report.ok) {
        const g = summary.gc;
        die('T6.A1 laneB rejected -- verdict=' + report.verdict +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            ' abGrowth=' + summary.arrayBuffers.growthBytes +
            (INJECT ? ' (break control -- expected)' : ''));
    }
    if (INJECT) die('T6.A1: DI_ALLOC_BREAK injected allocations but laneB gate passed');

    // ---- Async fire lane -- RECORDED, loosely PINNED (never zero) -----------
    // A job whose run() returns a thenable takes the async settle path. Each op
    // fires it once and drains the microtask queue so running clears for the next.
    const ca2 = new Container();
    const crA = new Cron(ca2, { now: () => 0 });
    class Async { run() { return Promise.resolve(); } }
    crA.job('async', Async, interval(1, 0));
    ca2.boot();
    crA.arm();
    let TA = 0;
    const as = await measureOpsAsync(async () => {
        crA.tick(TA++);
        await Promise.resolve();
        await Promise.resolve();
    }, { ops: 50000, warmup: 5000 });
    const cas = checkOpsAsync(as, { maxBytesPerOp: PIN_ASYNC });
    check(cas.verdict === 'pass',
        () => `T6.async: async fire rate ${as.bytesPerOp.toFixed(3)} B/op > pin ${PIN_ASYNC}`);
    check(as.bytesPerOp > 0,
        () => 'T6.async: async fire measured 0 B/op -- the pinned lane must be non-zero (recorded honestly)');

    process.stderr.write(
        'T6 lanes: sync-tick=' + la.bytesPerCall.toFixed(3) + ' B/tick (' + HOT + ' ops)' +
        ' async-fire=' + as.bytesPerOp.toFixed(3) + ' B/op' +
        ' | laneB major=' + summary.gc.major + ' minor=' + summary.gc.minor +
        ' maxMs=' + summary.gc.maxMs.toFixed(3) + ' abGrowth=' + summary.arrayBuffers.growthBytes +
        ' | hits=' + hits + '\n');
}
