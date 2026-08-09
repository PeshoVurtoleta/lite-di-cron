/**
 * T5 -- differential fuzz over random schedule topologies.
 *
 * 32 seeds. Each seed materialises a random set of sync jobs, each on a random
 * interval / every schedule, into a Container + Cron, boots it, then drives a
 * deterministic wall-clock tick sequence. The invariant checked every tick:
 *
 *   cron's actual per-job fire count === a reference replay of shouldRun over the
 *   SAME now sequence and the SAME lastRunAt update rule.
 *
 * A divergence would mean the schedule loop mis-fired (dropped or doubled a due
 * job, or leaked a running flag). On any divergence the seed is printed for
 * replay. Sync jobs settle in-frame, so no async overlap is in play here (the
 * running-guard against overlap is covered in T0/T3).
 */

import { Container } from '@zakkster/lite-di-container';
import { Cron, interval, every, shouldRun } from '../../Cron.js';
import { SEED, makePrng, die } from './harness.mjs';

const SEEDS = 32;
const TICKS = 400;

export async function run() {
    let s = (SEED >>> 0) || 1;

    for (let seed = 0; seed < SEEDS; seed++) {
        s = (s * 1664525 + 1013904223) >>> 0 || 1;
        const rnd = makePrng(s);

        const c = new Container();
        const cr = new Cron(c, { now: () => 0 });
        const nJobs = 1 + (rnd() % 6);
        const specs = [];
        for (let j = 0; j < nJobs; j++) {
            const kind = rnd() % 2;
            const everyMs = 1 + (rnd() % 5);
            const schedule = kind === 0
                ? interval(everyMs, 0)
                : every(everyMs, { aligned: false });
            const counter = { n: 0 };
            // A distinct class per job; the closure counts this job's fires.
            const Job = class { run() { counter.n++; } };
            cr.job('j' + j, Job, schedule);
            specs.push({ schedule, counter, refLast: -1, expected: 0 });
        }
        c.boot();
        cr.arm(); // startedAt = 0

        for (let t = 0; t < TICKS; t++) {
            // Reference replay -- mirror cron's lastRunAt update exactly.
            for (let j = 0; j < specs.length; j++) {
                const sp = specs[j];
                if (shouldRun(sp.schedule, t, sp.refLast, undefined, 0)) {
                    sp.refLast = t;
                    sp.expected++;
                }
            }
            try {
                cr.tick(t);
            } catch (e) {
                die('T5 fuzz: tick threw at seed=' + s + ' t=' + t + ': ' + e.message);
            }
        }

        for (let j = 0; j < specs.length; j++) {
            const sp = specs[j];
            if (sp.counter.n !== sp.expected) {
                die('T5 fuzz: job ' + j + ' fired ' + sp.counter.n + ' != expected ' +
                    sp.expected + ' at seed=' + s + ' type=' + sp.schedule.type);
            }
        }

        await c.shutdown();
    }

    process.stderr.write('T5 fuzz: ' + (SEEDS * TICKS) + ' ticks clean across ' + SEEDS + ' seeds\n');
}
