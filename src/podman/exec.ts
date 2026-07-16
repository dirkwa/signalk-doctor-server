import { Writable, type Readable } from 'node:stream';
import { resolveRuntime, safe } from './client.js';
import { categorizeError, type CategorizedError } from '../errors.js';

/** Keep only the tail of a process's combined output. npm can be chatty
 *  (hundreds of KB with a cold cache); the operator needs the end of the
 *  log — where npm prints its verdict — not the whole scroll. */
const MAX_OUTPUT_BYTES = 64 * 1024;

class TailCollector extends Writable {
  private chunks: Buffer[] = [];
  private total = 0;
  private truncated = false;

  override _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    // Trim from the FRONT down to the byte limit, slicing the head chunk
    // when needed, so a single oversized chunk cannot blow the bound and
    // the truncation marker is exact (never claimed at exactly the limit,
    // never omitted after a whole-chunk drop undershoots it).
    let overflow = this.total - MAX_OUTPUT_BYTES;
    while (overflow > 0) {
      const first = this.chunks[0];
      if (first === undefined) break;
      this.truncated = true;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.total -= first.length;
        overflow -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.total -= overflow;
        overflow = 0;
      }
    }
    cb();
  }

  text(): string {
    const joined = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `…(truncated)…\n${joined}` : joined;
  }
}

export interface ExecSuccess {
  ok: true;
  exitCode: number;
  /** Combined stdout+stderr, tail-truncated to MAX_OUTPUT_BYTES. */
  output: string;
}

export interface ExecFailure {
  ok: false;
  /** 'timeout' when the command outlived timeoutMs (it may still be
   *  running in the container — exec cannot be reliably killed through
   *  the compat API); otherwise the categorized transport error. */
  reason: 'timeout' | 'unreachable' | 'runtime';
  detail: string;
  /** True when the command could not be proven stopped (timeout + linger
   *  grace exhausted, or the exec record unreadable afterwards). Callers
   *  holding a mutex over the mutated resource must NOT release it while
   *  this is set — the process may still be writing. */
  stillRunning?: boolean;
  error?: CategorizedError;
}

export type ExecResult = ExecSuccess | ExecFailure;

interface ExecInspect {
  Running?: boolean;
  ExitCode?: number | null;
}

/**
 * Run one command inside a named container via the runtime's exec API and
 * wait for it to finish. Cmd is passed as an argv array — no shell is
 * involved, so arguments are never re-interpreted. Combined output is
 * collected tail-bounded; the exit code comes from ExecInspect after the
 * stream ends (with a short grace poll — podman marks Running=false a beat
 * after the stream closes).
 */
export async function execInContainer(
  containerName: string,
  cmd: string[],
  workingDir: string,
  timeoutMs: number,
): Promise<ExecResult> {
  const rt = await resolveRuntime();
  if (!rt) {
    return { ok: false, reason: 'unreachable', detail: 'no container runtime socket available' };
  }
  const container = rt.client.getContainer(containerName);

  const created = await safe(() =>
    container.exec({
      Cmd: cmd,
      WorkingDir: workingDir,
      AttachStdout: true,
      AttachStderr: true,
    }),
  );
  if (!created.ok) {
    return {
      ok: false,
      reason: 'runtime',
      detail: `${created.error.kind}: ${created.error.userMessage}`,
      error: created.error,
    };
  }
  const exec = created.value;

  const startedStream = await safe(() => exec.start({}));
  if (!startedStream.ok) {
    return {
      ok: false,
      reason: 'runtime',
      detail: `${startedStream.error.kind}: ${startedStream.error.userMessage}`,
      error: startedStream.error,
    };
  }
  const stream = startedStream.value;

  const collector = new TailCollector();
  // Both stdout and stderr land in one tail-bounded collector — the
  // operator reads them interleaved the same way a terminal would show them.
  (rt.client.modem as { demuxStream: (s: Readable, o: Writable, e: Writable) => void }).demuxStream(
    stream,
    collector,
    collector,
  );

  const finished = await new Promise<'end' | 'timeout' | Error>((resolve) => {
    const timer = setTimeout(() => {
      stream.destroy();
      resolve('timeout');
    }, timeoutMs);
    stream.on('end', () => {
      clearTimeout(timer);
      resolve('end');
    });
    stream.on('close', () => {
      clearTimeout(timer);
      resolve('end');
    });
    stream.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(err);
    });
  });

  if (finished === 'timeout') {
    // Destroying the attach stream does NOT stop the process, and the
    // compat exec API has no kill. Give the command a linger grace to
    // finish on its own; if it does, its work is real — report it as a
    // (late) completion rather than pretending it failed. Only when it
    // cannot be proven stopped do we return stillRunning so the caller
    // keeps any mutex held over the resource the command mutates.
    const grace = lingerGraceMs();
    const lingered = await waitForExit(exec, grace, 5000);
    if (lingered.kind === 'exit') {
      return { ok: true, exitCode: lingered.code, output: collector.text() };
    }
    return {
      ok: false,
      reason: 'timeout',
      stillRunning: true,
      detail:
        `command did not finish within ${Math.round(timeoutMs / 1000)}s and was still running ` +
        `after a further ${Math.round(grace / 1000)}s grace — it may still be running ` +
        'inside the container',
    };
  }
  if (finished instanceof Error) {
    const error = categorizeError(finished);
    return {
      ok: false,
      reason: 'runtime',
      detail: `${error.kind}: ${error.userMessage}`,
      error,
    };
  }

  // The exec record flips Running=false and publishes ExitCode a moment
  // after the stream closes; give it a short grace poll.
  const settled = await waitForExit(exec, 2000, 100);
  if (settled.kind === 'error') {
    return {
      ok: false,
      reason: 'runtime',
      detail: `${settled.error.kind}: ${settled.error.userMessage}`,
      error: settled.error,
    };
  }
  if (settled.kind === 'running') {
    return {
      ok: false,
      reason: 'runtime',
      stillRunning: true,
      detail: 'exec finished streaming but never reported an exit code',
    };
  }

  return { ok: true, exitCode: settled.code, output: collector.text() };
}

// How long a timed-out command may linger before we give up waiting for
// proof that it stopped. Resolved at call time (repo convention) so tests
// can shrink it without sleeping.
function lingerGraceMs(): number {
  const raw = Number(process.env.EXEC_LINGER_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

type ExitWait =
  { kind: 'exit'; code: number } | { kind: 'running' } | { kind: 'error'; error: CategorizedError };

/** Poll ExecInspect until Running=false, budgetMs is spent, or inspect
 *  itself errors. A null ExitCode on a stopped exec maps to code 1 — the
 *  record can lose the code across a runtime restart, and claiming success
 *  for it would be a lie. */
async function waitForExit(
  exec: { inspect: () => Promise<unknown> },
  budgetMs: number,
  intervalMs: number,
): Promise<ExitWait> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const inspected = await safe(() => exec.inspect());
    if (!inspected.ok) return { kind: 'error', error: inspected.error };
    const info = inspected.value as ExecInspect;
    if (info.Running !== true) {
      return { kind: 'exit', code: typeof info.ExitCode === 'number' ? info.ExitCode : 1 };
    }
    if (Date.now() >= deadline) return { kind: 'running' };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
