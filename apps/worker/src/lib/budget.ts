/**
 * Stage budgets + stage logging (RFL.QUEUE.8). One hung stage must never
 * hold a worker slot forever: every external step in the audit pipeline is
 * raced against a budget (AbortSignal.timeout under the hood) and reports
 * one start line and one end line with the job/business prefix.
 */

export class StageTimeoutError extends Error {
  override readonly name = "StageTimeoutError";
  constructor(
    readonly stage: string,
    readonly budgetMs: number,
  ) {
    super(`${stage} timed out after ${budgetMs}ms`);
  }
}

export class StageAbortedError extends Error {
  override readonly name = "StageAbortedError";
  constructor(readonly stage: string) {
    super(`${stage} aborted: job abandoned`);
  }
}

export function isStageTimeout(err: unknown): err is StageTimeoutError {
  return err instanceof StageTimeoutError;
}

/**
 * Race `run` against `budgetMs` (and an optional outer abort signal — the
 * queue's per-job controller). The underlying promise is abandoned on
 * timeout; `signal` is handed to `run` so stages that accept one can stop
 * real work early. Rejects with StageTimeoutError / StageAbortedError.
 */
export async function withBudget<T>(
  stage: string,
  budgetMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  if (outer?.aborted) throw new StageAbortedError(stage);
  // A plain setTimeout drives the abort (not AbortSignal.timeout): identical
  // semantics, but it runs on the event-loop timer the test clock can fake,
  // so budgets are provable under fake time.
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort(new StageTimeoutError(stage, budgetMs));
      reject(new StageTimeoutError(stage, budgetMs));
    }, budgetMs);
    const onOuterAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new StageAbortedError(stage));
    };
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    };
    run(signal).then(
      (value) => {
        if (settled) return;
        settled = true;
        done();
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        done();
        reject(err);
      },
    );
  });
}

/** `[job:<id> biz:<id>]` — one start line, one end line per stage. */
export interface StageLogger {
  readonly prefix: string;
  start(stage: string): number;
  end(stage: string, startedAt: number, note?: string): void;
}

export function stageLogger(jobId: string, businessId: string | null): StageLogger {
  const prefix = `[job:${jobId} biz:${businessId ?? "-"}]`;
  return {
    prefix,
    start(stage) {
      console.log(`${prefix} stage=${stage} start`);
      return Date.now();
    },
    end(stage, startedAt, note) {
      console.log(
        `${prefix} stage=${stage} end ms=${Date.now() - startedAt}${note ? ` ${note}` : ""}`,
      );
    },
  };
}

/**
 * Run a stage under a budget with start/end logging. On timeout returns
 * `fallback` (recorded in `timedOut`) instead of throwing — for stages the
 * audit can continue without (PSI, screenshots, path checks, agents).
 */
export async function budgetedStage<T>(opts: {
  log: StageLogger;
  stage: string;
  budgetMs: number;
  run: (signal: AbortSignal) => Promise<T>;
  fallback: T;
  timedOut: string[];
  signal?: AbortSignal;
}): Promise<T> {
  const t0 = opts.log.start(opts.stage);
  try {
    const value = await withBudget(opts.stage, opts.budgetMs, opts.run, opts.signal);
    opts.log.end(opts.stage, t0);
    return value;
  } catch (err) {
    if (err instanceof StageAbortedError) throw err;
    if (isStageTimeout(err)) {
      opts.timedOut.push(opts.stage);
      opts.log.end(opts.stage, t0, `TIMEOUT budget=${opts.budgetMs}ms`);
      return opts.fallback;
    }
    opts.log.end(
      opts.stage,
      t0,
      `ERROR ${err instanceof Error ? err.message : String(err)}`,
    );
    return opts.fallback;
  }
}
