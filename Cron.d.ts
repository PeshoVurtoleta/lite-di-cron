// Type declarations for @zakkster/lite-di-cron.
// The container is a peer dependency; its Container type is imported by name.

import type { Container } from '@zakkster/lite-di-container';

/** Three-place-synced version string (package.json + VERSION const + CHANGELOG). */
export declare const VERSION: string;

/** The only accepted constructor option keys. Frozen. */
export declare const OPTIONS: readonly string[];

/** The context object a job's run() receives. Mutated in place per fire (0 B). */
export interface CronContext {
    /** Wall-clock ms of the tick that fired this job. */
    now: number;
    /** Monotonic tick counter at the moment of this fire. */
    tick: number;
    /** The owning scheduler. */
    cron: Cron;
}

/** A job class the container constructs; its instances run on schedule. */
export interface Job {
    /**
     * Run the job. Return nothing (or a non-thenable) for the zero-alloc sync
     * path; return a thenable to take the async fire path (the job is guarded
     * from re-firing until it settles).
     */
    run(ctx: CronContext): unknown;
}

/** Constructor signature the scheduler registers under a job id. */
export type JobClass = new (...deps: any[]) => Job;

/** An interval schedule: fires every everyMs, offsetMs delays the first run only. */
export interface IntervalSchedule { type: 'interval'; everyMs: number; offsetMs: number; }

/** An aligned/relative fixed-cadence schedule. */
export interface EverySchedule { type: 'every'; everyMs: number; aligned: boolean; }

/** A 5-field UTC cron-expression schedule. */
export interface CronSchedule { type: 'cron'; expr: string; }

export type Schedule = IntervalSchedule | EverySchedule | CronSchedule;

/** Per-job registration options. */
export interface JobOptions {
    /** Advisory mode tag stored on the resolved job; dispatch is unified. */
    mode?: 'sync' | 'async';
    /** Whether the job is enabled at boot. Default true. */
    enabled?: boolean;
    /** Dependency tokens injected into the job class constructor. */
    deps?: string[];
}

/** Reporter for a thrown or rejected job. Defaults to a re-throw (fail closed). */
export type OnError = (err: unknown, jobId: string) => void;

export interface CronOptions {
    /** Interval between auto-ticks when start() is used. Default 1000. */
    tickMs?: number;
    /** Wall-clock source. Default Date.now. */
    now?: () => number;
    /** Error sink for a thrown/rejected job. Defaults to re-throw (no console.*). */
    onError?: OnError;
    /** Whether a thrown sync job is routed to onError rather than propagating. Default true. */
    catchJobErrors?: boolean;
    /** DI binding-key namespace for job singletons. Default 'cron'. */
    namespace?: string;
    /** Alias for namespace. */
    bindingKey?: string;
}

/** A single-field cron entry the job fired on. */
export interface JobInfo {
    id: string;
    enabled: boolean;
    lastRunAt: number;
    schedule: Schedule;
}

export declare class CronError extends Error {
    constructor(message: string, code?: string);
    code: string;
}

/**
 * A wall-clock task scheduler over an @zakkster/lite-di-container topology. Jobs
 * are DI-constructed classes registered as per-id singletons before boot; a
 * single tick walks the resolved list and fires each due job by index. The
 * synchronous, non-promise fire path is 0 B/tick; a thenable return takes the
 * async fire path (recorded + pinned, never advertised as zero).
 */
export declare class Cron {
    constructor(container: Container, options?: CronOptions);

    /** Register a job. Pre-start only; delegates the binding to container.singleton. */
    job(id: string, JobClass: JobClass, schedule: Schedule, opts?: JobOptions): this;

    /** Resolve the job list and record the start time, without arming a timer. */
    arm(): this;

    /** Resolve, record the start time, arm a setInterval, and tick once immediately. */
    start(): this;

    /** Clear the interval timer. */
    stop(): this;

    /** Walk the resolved list and fire every due job. Optional explicit wall clock. */
    tick(now?: number): void;

    /** Enable or disable a job by id (resolved or pending). */
    setEnabled(id: string, enabled: boolean): this;

    /** Whether a job id is registered (resolved or pending). */
    has(id: string): boolean;

    /** Snapshot of the resolved (or pending) jobs. Allocates. */
    list(): JobInfo[];

    /** Whether the interval timer is armed. */
    readonly running: boolean;

    /** The monotonic tick counter. */
    readonly tickCount: number;

    /**
     * Drop the resolved list and pending registrations and remove the DI job
     * bindings. Fail closed against the boot-lock: if the container is booted,
     * container.reset() runs FIRST to unlock it, then each job key is
     * unregistered with no silent catch.
     */
    reset(): void;
}

/** Build an interval schedule. offsetMs delays the FIRST run only. */
export declare function interval(everyMs: number, offsetMs?: number): IntervalSchedule;

/** Build a fixed-cadence schedule. aligned (default) fires on wall-clock buckets. */
export declare function every(everyMs: number, opts?: { aligned?: boolean }): EverySchedule;

/** Build a 5-field UTC cron-expression schedule. */
export declare function cron(expr: string): CronSchedule;

/** Pure schedule predicate: is a job due at `now` given its last run? */
export declare function shouldRun(
    schedule: Schedule, now: number, lastRunAt: number, sharedDate?: Date, startedAt?: number,
): boolean;

/** Parse a 5-field UTC cron expression into a matcher record. Throws on malformed input. */
export declare function parseCronExpr(expr: string): {
    minute: Set<number>; hour: Set<number>; dom: Set<number>;
    month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean;
};
