/**
 * Shared dependent torture harness -- GENERIC.
 *
 * This file is verbatim across every @zakkster/lite-di-* dependent: only the
 * package name in the header comment differs. It owns the discipline every tier
 * obeys, and NOTHING package-specific:
 *
 *   - All scratch (containers, class definitions, buffers, instances) is
 *     allocated ONCE by the tier, outside every measured loop. This module hands
 *     out helpers, never per-call allocations on a hot path.
 *   - `check(cond, thunk)` builds its message string only on failure -- a
 *     template literal per iteration is an allocation and would fail the gate.
 *   - The PRNG is a seeded xorshift32. On any thrown fault a tier prints the seed
 *     so the case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     SEQUENTIALLY, never nested. `runOpsGate` opens and closes one window.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must never be seeded with 0
})();

/** Whole-suite control: inject a retained allocation into the alloc hot body. */
export const BREAK = process.env.DI_TORTURE_BREAK === '1';

/** Per-emit alloc control: inject one allocation per hot op so the 0 B gate trips. */
export const ALLOC_BREAK = process.env.DI_ALLOC_BREAK === '1';

/** Base zero-GC rules. `maxArrayBuffersGrowth` needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Cross-tier stats, written by the alloc tier (gc + alloc) and the soak tier
 * (leak), read by the runner to emit one machine-readable GATE line on stderr.
 * stdout stays exactly "ok".
 */
export const STATS = {
    leakSize: 0,
    leakTarget: 0,
    findings: 0,
    warnings: 0,
    gcMajor: 0,
    gcMinor: 0,
    gcMaxMs: 0,
    allocBytesPerOp: 0,
};

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg +
        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * measureOps with `stabilize:'deep'` makes the `maxArrayBuffersGrowth` rule
 * resolvable (ArrayBuffer backing stores live outside the V8 heap). Returns the
 * checkNoGc report, the raw summary, and the measured bytes-per-op rate.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return {
        report: checkNoGc(res.summary, RULES),
        summary: res.summary,
        bytesPerOp: res.bytesPerOp,
    };
}
