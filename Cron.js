// @zakkster/lite-di-cron
// Wall-clock task scheduler over an @zakkster/lite-di-container topology. Jobs
// are DI-constructed classes registered as per-id singletons before boot; a
// single wall-clock tick walks the resolved list and fires by index. This is the
// WALL-CLOCK lane (setInterval / interval / cron-expr) -- NOT the frame loop
// (that is a rAF ticker) and NOT a virtual reactive clock (that is lite-time).
//
// The synchronous, non-promise job path is 0 B/tick (hard-gated). A job whose
// run() returns a thenable takes the async fire path, which allocates promise
// machinery by construction (recorded + pinned, never advertised as zero).
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

/**
 * Three-place VERSION sync: package.json + this const + CHANGELOG.md are bumped
 * in one commit or not at all.
 * @type {string}
 */
export const VERSION = '1.0.0-alpha.1';

/**
 * The only accepted constructor option keys. Frozen so an unknown key is an
 * error with a did-you-mean hint, never a silent ignore (fail closed).
 * @type {readonly string[]}
 */
export const OPTIONS = Object.freeze([
    'tickMs',
    'now',
    'onError',
    'catchJobErrors',
    'namespace',
    'bindingKey',
]);

/** Case-insensitive 3-char prefix used by the did-you-mean matcher. */
const PREFIX = 3;

/**
 * Default error sink. Fail closed and LOUD: with no handler configured a job
 * error is re-thrown, never swallowed and never printed (no console.* anywhere).
 * Provide `{ onError }` to observe-and-continue instead.
 * @param {unknown} err
 */
function _defaultOnError(err) {
    throw err;
}

/**
 * Cold-path did-you-mean. Builds a suggestion for an unknown option key by a
 * case-insensitive 3-char prefix match against OPTIONS. Only ever called when a
 * key is already known-bad, so it allocates nothing on the happy path.
 * @param {string} key
 * @returns {string} the matched option, or '' if none.
 */
function _suggest(key) {
    const p = String(key).slice(0, PREFIX).toLowerCase();
    for (let i = 0; i < OPTIONS.length; i++) {
        if (OPTIONS[i].slice(0, PREFIX).toLowerCase() === p) return OPTIONS[i];
    }
    return '';
}

class CronError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'CRON_ERROR') {
        super(message);
        this.name = 'CronError';
        this.code = code;
    }
}

//
// Minimal 5-field cron field parser (UTC).
// Supports: *, N, N-M, N-M/S, */S, A,B,C
//
// @param {string} field
// @param {number} min
// @param {number} max
// @returns {Set<number>}
//
function parseCronField(field, min, max) {
    const values = new Set();
    const parts = field.split(',');
    for (let p = 0; p < parts.length; p++) {
        const part = parts[p].trim();

        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i);
            continue;
        }

        const stepMatch = part.match(/^(\*|\d+)(?:-(\d+))?\/(\d+)$/);
        if (stepMatch) {
            const start = stepMatch[1] === '*' ? min : parseInt(stepMatch[1], 10);
            const end = stepMatch[2] !== undefined ? parseInt(stepMatch[2], 10) : max;
            const step = parseInt(stepMatch[3], 10);
            if (!(step > 0)) {
                throw new CronError('Invalid step in cron field: ' + part, 'INVALID_CRON');
            }
            for (let i = start; i <= end; i += step) {
                if (i >= min && i <= max) values.add(i);
            }
            continue;
        }

        const rangeMatch = part.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
            const a = parseInt(rangeMatch[1], 10);
            const b = parseInt(rangeMatch[2], 10);
            if (a > b) {
                throw new CronError('Inverted cron range: ' + part, 'INVALID_CRON');
            }
            for (let i = a; i <= b; i++) {
                if (i >= min && i <= max) values.add(i);
            }
            continue;
        }

        const n = parseInt(part, 10);
        if (Number.isNaN(n) || n < min || n > max) {
            throw new CronError('Invalid cron field value: ' + part, 'INVALID_CRON');
        }
        values.add(n);
    }
    return values;
}

/**
 * @param {string} expr
 */
function parseCronExpr(expr) {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new CronError('Cron expr must have 5 fields: ' + expr, 'INVALID_CRON');
    }
    return {
        minute: parseCronField(fields[0], 0, 59),
        hour: parseCronField(fields[1], 0, 23),
        dom: parseCronField(fields[2], 1, 31),
        month: parseCronField(fields[3], 1, 12),
        dow: parseCronField(fields[4], 0, 6),
        domStar: fields[2] === '*',
        dowStar: fields[4] === '*',
    };
}

/**
 * Module-level cache for parsed cron expressions.
 * WARNING: This cache grows indefinitely. It is strictly designed for static,
 * boot-time configurations. Do not pass dynamically generated cron strings
 * from untrusted user input or unbounded database rows here.
 *
 * @type {Map<string, ReturnType<typeof parseCronExpr>>}
 */
const cronExprCache = new Map();

function getParsedCron(expr) {
    let parsed = cronExprCache.get(expr);
    if (!parsed) {
        parsed = parseCronExpr(expr);
        cronExprCache.set(expr, parsed);
    }
    return parsed;
}

/**
 * Pack UTC y/m/d/h/min from a Date into a comparable minute-slot integer.
 * @param {Date} d
 * @returns {number}
 */
function minuteSlot(d) {
    return d.getUTCFullYear() * 1e10
        + (d.getUTCMonth() + 1) * 1e8
        + d.getUTCDate() * 1e6
        + d.getUTCHours() * 1e4
        + d.getUTCMinutes();
}

/**
 * @param {Schedule} schedule
 * @param {number} now
 * @param {number} lastRunAt
 * @param {Date} [sharedDate]
 * @param {number} [startedAt=0]
 * @returns {boolean}
 */
function shouldRun(schedule, now, lastRunAt, sharedDate, startedAt = 0) {
    if (schedule.type === 'interval') {
        const offset = schedule.offsetMs ?? 0;
        if (lastRunAt < 0) {
            return now >= startedAt + offset;
        }
        return now - lastRunAt >= schedule.everyMs;
    }

    if (schedule.type === 'every') {
        const every = schedule.everyMs;
        if (every <= 0) return false;
        if (schedule.aligned) {
            const bucket = Math.floor(now / every);
            if (lastRunAt < 0) return true;
            const lastBucket = Math.floor(lastRunAt / every);
            return bucket > lastBucket;
        }
        if (lastRunAt < 0) return true;
        return now - lastRunAt >= every;
    }

    if (schedule.type === 'cron') {
        const d = sharedDate || new Date(now);
        d.setTime(now);

        const slot = minuteSlot(d);
        let last = -1;
        if (lastRunAt >= 0) {
            d.setTime(lastRunAt);
            last = minuteSlot(d);
            d.setTime(now);
        }
        if (slot <= last) return false;

        const p = getParsedCron(schedule.expr);
        const minute = d.getUTCMinutes();
        const hour = d.getUTCHours();
        const dom = d.getUTCDate();
        const month = d.getUTCMonth() + 1;
        const dow = d.getUTCDay();

        const domRestricted = !p.domStar;
        const dowRestricted = !p.dowStar;
        const dayMatch = (domRestricted && dowRestricted)
            ? (p.dom.has(dom) || p.dow.has(dow))
            : (p.dom.has(dom) && p.dow.has(dow));

        return p.minute.has(minute)
            && p.hour.has(hour)
            && dayMatch
            && p.month.has(month);
    }

    return false;
}

/**
 * Fire one due job. Extracted from tick() so the try/catch never lands in the
 * schedule loop's frame (a try/catch in a hot body deoptimizes the whole
 * function under V8). Called only for a job that shouldRun on this tick.
 *
 * The job's OWN ctx (allocated once at resolve, mutated in place -- 0 B/tick) is
 * passed to run(). A job cannot overlap itself (the `running` guard blocks
 * re-entry until it settles), so mutating its own ctx per fire can never corrupt
 * an in-flight async continuation. This is the fix for the old shared-`_ctx`
 * aliasing bug: one ctx across all jobs, mutated every tick, corrupted any async
 * job that outlived the tick that started it.
 *
 * @param {Cron} cron
 * @param {object} job
 */
function _fireJob(cron, job) {
    let result;
    try {
        result = job.instance.run(job.ctx);
    } catch (err) {
        // Sync throw: clear the guard then route through the single job-error
        // decision (honors _catchJobErrors identically to the async lane).
        cron._handleJobError(job, err);
        return;
    }
    // A null/undefined return is the 0 B/tick sync path -- settle immediately.
    // Guard this BEFORE any `.then` access: reading `.then` off null/undefined
    // would itself throw a TypeError.
    if (result === null || result === undefined) {
        job.running = false;
        return;
    }
    // The async fire path: a thenable return settles running=false later, via the
    // per-job handlers hoisted at resolve time (no per-tick closure allocation).
    // This lane allocates promise machinery by construction -- it is pinned, not
    // gated at zero. A non-thenable return also settles here (running=false).
    //
    // A user job can return ANY thenable-shaped value; BOTH reading `.then` (it
    // may be a throwing getter) AND invoking it can throw. Fail closed: route
    // either failure through the SAME job-error path as a sync throw so the
    // running guard is never left stuck true. The `.then` READ is inside the try
    // for exactly this reason (a throwing getter must not escape unguarded).
    try {
        const then = result.then;
        if (typeof then === 'function') {
            then.call(result, job._onOk, job._onErr);
        } else {
            job.running = false;
        }
    } catch (err) {
        cron._handleJobError(job, err);
    }
}

class Cron {
    /**
     * @param {import('@zakkster/lite-di-container').Container} container
     * @param {Object} [options]
     */
    constructor(container, options) {
        if (container === null || container === undefined) {
            throw new TypeError('[lite-di-cron] container is required.');
        }
        this._container = container;

        // Option defaults. The happy path (no unknown key) does zero work beyond
        // the for-in walk; an unknown key fails closed with a did-you-mean hint.
        let tickMs = 1000;
        let now = Date.now;
        let onError = _defaultOnError;
        let catchJobErrors = true;
        let ns = 'cron';

        if (options !== null && options !== undefined) {
            for (const key in options) {
                if (OPTIONS.indexOf(key) === -1) {
                    const hint = _suggest(key);
                    throw new Error("[lite-di-cron] Unknown option '" + key + "'." +
                        (hint === '' ? '' : " Did you mean '" + hint + "'?"));
                }
            }
            if (options.tickMs !== undefined) {
                if (typeof options.tickMs !== 'number' || !(options.tickMs > 0)) {
                    throw new TypeError('[lite-di-cron] tickMs must be a positive number.');
                }
                tickMs = options.tickMs;
            }
            if (options.now !== undefined) {
                if (typeof options.now !== 'function') {
                    throw new TypeError('[lite-di-cron] now must be a function.');
                }
                now = options.now;
            }
            if (options.onError !== undefined) {
                if (typeof options.onError !== 'function') {
                    throw new TypeError('[lite-di-cron] onError must be a function.');
                }
                onError = options.onError;
            }
            if (options.catchJobErrors !== undefined) {
                catchJobErrors = !!options.catchJobErrors;
            }
            if (options.namespace !== undefined) {
                if (typeof options.namespace !== 'string' || options.namespace === '') {
                    throw new TypeError('[lite-di-cron] namespace must be a non-empty string.');
                }
                ns = options.namespace;
            } else if (options.bindingKey !== undefined) {
                if (typeof options.bindingKey !== 'string' || options.bindingKey === '') {
                    throw new TypeError('[lite-di-cron] bindingKey must be a non-empty string.');
                }
                ns = options.bindingKey;
            }
        }

        this._tickMs = tickMs;
        this._now = now;
        this._onError = onError;
        this._catchJobErrors = catchJobErrors;
        this._ns = ns;

        this._jobs = [];
        this._running = false;
        this._timer = null;
        this._tickCount = 0;
        this._startedAt = 0;

        this._pending = new Map();

        // One reusable Date for the cron minute-slot arithmetic. It is never
        // handed to a job, so it cannot be aliased across an async boundary.
        this._sharedDate = new Date(0);
    }

    _jobKey(id) {
        return this._ns + ':job:' + id;
    }

    job(id, JobClass, schedule, opts = {}) {
        if (this._running) {
            throw new CronError('Cannot register jobs after start()', 'ALREADY_STARTED');
        }
        if (!id || typeof id !== 'string') {
            throw new CronError('Job id must be a non-empty string', 'INVALID_ID');
        }
        if (this._pending.has(id)) {
            throw new CronError("Job '" + id + "' already registered", 'DUPLICATE_ID');
        }
        this._validateSchedule(schedule);

        const mode = opts.mode ?? 'sync';
        const enabled = opts.enabled ?? true;
        const deps = opts.deps ?? [];

        this._container.singleton(this._jobKey(id), JobClass, deps);
        this._pending.set(id, {schedule, mode, enabled});
        return this;
    }

    _validateSchedule(schedule) {
        if (!schedule || typeof schedule !== 'object') {
            throw new CronError('Schedule required', 'INVALID_SCHEDULE');
        }
        if (schedule.type === 'interval' || schedule.type === 'every') {
            if (!(schedule.everyMs > 0)) {
                throw new CronError('everyMs must be > 0', 'INVALID_SCHEDULE');
            }
            return;
        }
        if (schedule.type === 'cron') {
            getParsedCron(schedule.expr);
            return;
        }
        throw new CronError('Unknown schedule type: ' + schedule.type, 'INVALID_SCHEDULE');
    }

    _resolveJobs() {
        this._jobs = [];
        for (const [id, meta] of this._pending) {
            const key = this._jobKey(id);
            if (!this._container.has(key)) {
                throw new CronError("Job binding missing for '" + id + "'", 'MISMATCH');
            }
            // The job's own ctx + settle handlers are built ONCE here (cold path),
            // never per tick. Each job owns its ctx, so the schedule loop mutates
            // no shared object and the async fire path allocates no closure.
            const job = {
                id,
                instance: this._container.get(key),
                schedule: meta.schedule,
                enabled: meta.enabled,
                lastRunAt: -1,
                running: false,
                mode: meta.mode,
                ctx: {now: 0, tick: 0, cron: this},
                _onOk: null,
                _onErr: null,
            };
            job._onOk = () => { job.running = false; };
            job._onErr = (err) => { this._handleJobError(job, err); };
            this._jobs.push(job);
        }
        return this;
    }

    /**
     * The single job-error decision, shared by BOTH lanes: the sync throw path in
     * _fireJob AND the async reject path (job._onErr). Clears the running guard
     * unconditionally (finally-style -- never dependent on which branch ran), then
     * honors _catchJobErrors identically: true -> route to _onError and continue;
     * false -> re-throw. On the async lane a re-throw surfaces as an unhandled
     * rejection by construction -- loud, symmetric with the sync lane's re-throw.
     * @param {object} job
     * @param {unknown} err
     */
    _handleJobError(job, err) {
        job.running = false;
        if (this._catchJobErrors) {
            this._onError(err, job.id);
            return;
        }
        throw err;
    }

    start() {
        if (this._running) return this;
        this._resolveJobs();
        this._startedAt = this._now();
        this._tickCount = 0;
        this._running = true;
        this._timer = setInterval(() => {
            this.tick();
        }, this._tickMs);
        if (this._timer.unref) this._timer.unref();

        this.tick();
        return this;
    }

    arm() {
        if (this._running) return this;
        this._resolveJobs();
        this._startedAt = this._now();
        return this;
    }

    stop() {
        if (!this._running) return this;
        this._running = false;
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        return this;
    }

    /**
     * Walk the resolved job list and fire every due job. Hot path: no allocation
     * for a synchronous, non-promise job (0 B/tick, hard-gated). The try/catch and
     * the thenable branch live in _fireJob so this frame stays optimizable.
     * @param {number} [now]
     */
    tick(now) {
        const t = now === undefined ? this._now() : now;
        this._tickCount++;
        const tick = this._tickCount;

        const jobs = this._jobs;
        const len = jobs.length;
        const sharedDate = this._sharedDate;
        const startedAt = this._startedAt;

        for (let i = 0; i < len; i++) {
            const job = jobs[i];
            if (!job.enabled || job.running) continue;
            if (!shouldRun(job.schedule, t, job.lastRunAt, sharedDate, startedAt)) continue;

            job.lastRunAt = t;
            job.running = true;
            const jctx = job.ctx;
            jctx.now = t;
            jctx.tick = tick;
            _fireJob(this, job);
        }
    }

    setEnabled(id, enabled) {
        const job = this._jobs.find((j) => j.id === id);
        if (job) {
            job.enabled = !!enabled;
            return this;
        }
        const meta = this._pending.get(id);
        if (meta) {
            meta.enabled = !!enabled;
            return this;
        }
        throw new CronError("Unknown job '" + id + "'", 'UNKNOWN_JOB');
    }

    has(id) {
        return this._jobs.some((j) => j.id === id) || this._pending.has(id);
    }

    list() {
        if (this._jobs.length > 0) {
            return this._jobs.map((j) => ({
                id: j.id,
                enabled: j.enabled,
                lastRunAt: j.lastRunAt,
                schedule: {...j.schedule},
            }));
        }
        return [...this._pending.entries()].map(([id, meta]) => ({
            id,
            enabled: meta.enabled,
            lastRunAt: 0,
            schedule: {...meta.schedule},
        }));
    }

    get running() {
        return this._running;
    }

    get tickCount() {
        return this._tickCount;
    }

    /**
     * Drop the resolved list and pending registrations, and remove the DI job
     * bindings. Fail closed against the container boot-lock: if the container is
     * booted, drive container.reset() FIRST to unlock it, THEN unregister each
     * job key with no silent catch -- a failed unregister propagates instead of
     * leaving a torn-down binding retained.
     *
     * NOTE: container.reset() is container-GLOBAL. On a SHARED container this
     * clears ALL singletons and unlocks the boot-lock for the whole container, not
     * just cron's job keys (forced by the container API, which only unlocks via
     * reset/clear). Do not call reset() on a shared container unless you intend to
     * tear the whole container down.
     */
    reset() {
        this.stop();

        const container = this._container;
        // Gate on the boot-lock. unregister requires an unlocked container, so a
        // booted container must be reset first (this unlocks it and preserves
        // registrations); an already-unlocked one needs no reset.
        if (container.isBooted) {
            container.reset();
        }

        const ids = new Set([...this._pending.keys(), ...this._jobs.map((j) => j.id)]);
        for (const id of ids) {
            container.unregister(this._jobKey(id));
        }

        this._jobs = [];
        this._tickCount = 0;
        this._pending.clear();
    }
}

/** @param {number} everyMs @param {number} [offsetMs] */
function interval(everyMs, offsetMs = 0) {
    return {type: 'interval', everyMs, offsetMs};
}

/** @param {number} everyMs @param {{ aligned?: boolean }} [opts] */
function every(everyMs, opts = {}) {
    return {type: 'every', everyMs, aligned: opts.aligned ?? true};
}

/** @param {string} expr */
function cron(expr) {
    return {type: 'cron', expr};
}

export {
    Cron,
    CronError,
    interval,
    every,
    cron,
    shouldRun,
    parseCronExpr,
};
