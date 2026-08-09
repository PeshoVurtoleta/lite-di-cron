/**
 * T9 -- controls. Every gate above must be provably able to fail. GENERIC:
 * this tier touches no package-specific surface, so it is shared verbatim across
 * every @zakkster/lite-di-* dependent.
 *
 * Each control runs a deliberately-broken variant IN PROCESS and asserts that
 * the corresponding gate flags it. A gate that cannot fail is decorative.
 *
 * Two whole-suite controls are wired through env vars the alloc tier reads:
 *   - DI_TORTURE_BREAK=1 retains an allocation in the alloc hot body.
 *   - DI_ALLOC_BREAK=1   injects one allocation PER EMIT so the 0 B gate trips.
 * Either must make `node --expose-gc test/torture.mjs` exit non-zero.
 *
 * DI_ASCII_BREAK=1 pushes a poisoned in-memory entry into the ASCII scan set so
 * the enforcing loop itself exits non-zero, proving the ASCII gate is enforcing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { runOpsGate, ALLOC_BREAK, die } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export async function run() {
    // -- Control 1: the alloc gate. A hot body that retains an allocation every
    //    iteration MUST be rejected by runOpsGate. This is the exact mechanism
    //    DI_ALLOC_BREAK uses to trip the 0 B/emit gate in the alloc tier.
    const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (report.ok) die('T9 control 1: an allocating hot loop passed the zero-alloc gate');
    leak.length = 0; // release the control's garbage

    // -- Control 2: measureAllocs lane is not vacuous. A body that retains one
    //    object per call must fail maxBytesPerCall:0.
    const sink = [];
    const alloc = measureAllocs(() => { sink.push({ retained: true }); },
        { iterations: 2000, batches: 8, warmup: 2000 });
    const ca = checkAllocs(alloc, { maxBytesPerCall: 0 });
    if (ca.verdict === 'pass') {
        die('T9 control 2: measureAllocs passed a body that retains an object every call');
    }
    sink.length = 0;

    // -- Control 3: the retention witness bites. A tracked resource that is never
    //    untracked must leave tracker.size() > 0.
    {
        const tr = createLeakTracker({ name: 'cron-control' });
        const h = tr.track({ live: true }, function () {}, 'ctl');
        if (tr.size() === 0) {
            die('T9 control 3: lite-leak size() was 0 with a live tracked resource -- the soak gate is blind');
        }
        tr.untrack(h); // release so the control leaves nothing behind
    }

    // -- Control 4: DI_ALLOC_BREAK is honored. When set, the flag the alloc tier
    //    reads must be true, so its per-emit injection is guaranteed to fire.
    if (process.env.DI_ALLOC_BREAK === '1' && ALLOC_BREAK !== true) {
        die('T9 control 4: DI_ALLOC_BREAK=1 but the harness did not surface it');
    }

    // -- Control 5: the ASCII gate is ENFORCING, not decorative. It scans every
    //    shipped file (package.json files[]) with the same regex and fails the
    //    whole suite on any non-ASCII byte. It proves it can fail two ways: an
    //    injected U+2550 fixture that must be caught, and DI_ASCII_BREAK=1, which
    //    pushes a poisoned in-memory entry so the enforcing loop exits non-zero.
    {
        const grep = /[^\x00-\x7F]/;

        const fixture = 'banner' + String.fromCharCode(0x2550) + 'end';
        if (!grep.test(fixture)) die('T9 control 5: the ASCII grep missed a U+2550 byte');
        if (grep.test('pure ascii -> ok')) die('T9 control 5: the ASCII grep false-positived on ASCII');

        const root = fileURLToPath(new URL('../../', import.meta.url));
        const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
        const scanSet = [];
        for (const rel of pkg.files) {
            let src;
            try { src = readFileSync(root + rel, 'utf8'); } catch { continue; }
            scanSet.push([rel, src]);
        }
        if (process.env.DI_ASCII_BREAK === '1') {
            scanSet.push(['<injected>', 'poison' + String.fromCharCode(0x2550)]);
        }
        for (const [rel, src] of scanSet) {
            const m = grep.exec(src);
            if (m !== null) {
                const line = src.slice(0, m.index).split('\n').length;
                die('T9 control 5: non-ASCII byte in shipped file ' + rel + ' at line ' + line +
                    ' (U+' + src.charCodeAt(m.index).toString(16).toUpperCase() + ')');
            }
        }
    }
}
