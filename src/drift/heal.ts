import { loadDriftReport } from './store.js';
import { dataDirRoot } from './installed-packages.js';
import { execInContainer, type ExecOptions, type ExecResult } from '../podman/exec.js';
import { explainPackages, type PackageDependent, type PackageExplanation } from './explain.js';
import type { DriftPackage, DriftReport } from './types.js';

const TARGET_CONTAINER = 'signalk-server';

// npm update on a cold-cache Pi over marina WiFi is legitimately slow;
// give it ten minutes before declaring the job stuck. Env-overridable so
// tests don't wait.
function healTimeoutMs(): number {
  const raw = Number(process.env.HEAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

/** One data-dir copy the heal will try to move: currently `from`, npm's
 *  latest is `latest`, and the plugin ranges decide where `npm update`
 *  actually lands (anywhere from `from` to `latest`). */
export interface HealTarget {
  name: string;
  from: string;
  latest: string | null;
}

export interface HealPackageOutcome {
  name: string;
  from: string;
  /** Data-dir version after the update + rescan; null when the package no
   *  longer has a data-dir copy (npm dedupe can hoist it away entirely). */
  to: string | null;
  latest: string | null;
  /** 'updated' — version moved; 'range-limited' — unchanged and still
   *  behind, the dependents' declared ranges exclude anything newer (a
   *  plugin-author fix, not an operator problem); 'unchanged' — unchanged
   *  for any other reason (e.g. offline rescan carried the old state). */
  outcome: 'updated' | 'range-limited' | 'unchanged';
  /** Direct dependents (name@version + declared range), from `npm explain`
   *  run before the update. Attached to non-updated outcomes so the
   *  operator sees WHO holds the package back. Absent when the explain
   *  pass failed (attribution is best-effort). */
  heldBy?: PackageDependent[];
  /** A dependent is the leftover embedded `signalk-server` from the
   *  pre-container appstore server-update flow — removable in the
   *  container stack, where the running server always comes from the
   *  image. */
  heldByEmbeddedServer?: boolean;
  /** Pre-update, nothing depended on this copy; any npm reify sweeps such
   *  leftovers, so a `to: null` outcome here means "removed dead weight",
   *  not "hoisted elsewhere". */
  wasExtraneous?: boolean;
}

export interface HealSuccess {
  ok: true;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  targets: HealTarget[];
  /** npm's exit code (0 here — nonzero is reported as a failure). Null
   *  only for the nothing-to-heal short-circuit, where npm never ran. */
  exitCode: number | null;
  outputTail: string;
  packages: HealPackageOutcome[];
}

export type HealFailureReason =
  /** No drift report on disk — the scanner has never run. */
  | 'no-report'
  /** Exec transport failed (no socket / container gone / API error / timeout). */
  | 'exec'
  /** npm ran but exited nonzero. Post-state is still rescanned and reported. */
  | 'npm';

export interface HealFailure {
  ok: false;
  reason: HealFailureReason;
  detail: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode?: number;
  outputTail?: string;
  /** Post-state when we got far enough to rescan (npm failures included —
   *  npm can partially succeed before erroring). */
  packages?: HealPackageOutcome[];
  /** True when npm could not be proven stopped (exec timeout + linger
   *  grace exhausted). The route keeps the shared operation lock in place
   *  so no other mutation can race the still-running npm; the operator
   *  waits or force-clears via the recovery surface. */
  lockRetained?: boolean;
}

export type HealResult = HealSuccess | HealFailure;

/** The data-dir copies worth updating: present, compared, and behind.
 *  'unknown' (no comparison) and 'prerelease' (same triple, different
 *  prerelease state) are excluded — `npm update` has no defined win there. */
export function selectHealTargets(report: DriftReport): HealTarget[] {
  const targets: HealTarget[] = [];
  for (const p of report.packages) {
    const c = p.dataDir?.classification;
    if (p.dataDir && (c === 'patch' || c === 'minor' || c === 'major')) {
      targets.push({ name: p.name, from: p.dataDir.installed, latest: p.latest });
    }
  }
  return targets;
}

function findPackage(report: DriftReport | null, name: string): DriftPackage | undefined {
  return report?.packages.find((p) => p.name === name);
}

function outcomeFor(
  target: HealTarget,
  after: DriftReport | null,
  npmSucceeded: boolean,
  explanation: PackageExplanation | undefined,
): HealPackageOutcome {
  // Attribution from the pre-update explain pass, best-effort. `held` only
  // makes sense on outcomes that DIDN'T move — attaching dependents to an
  // updated entry would imply they hold something back. `swept` rides on
  // every outcome: it is what turns an updated `to: null` into "removed
  // leftover" rather than "hoisted away".
  const held =
    explanation !== undefined && explanation.dependents.length > 0
      ? {
          heldBy: explanation.dependents,
          ...(explanation.heldByEmbeddedServer ? { heldByEmbeddedServer: true } : {}),
        }
      : {};
  const swept = explanation?.extraneous ? { wasExtraneous: true } : {};
  const pkg = findPackage(after, target.name);
  if (pkg === undefined) {
    // No post-state for this package (report missing, or the rescan
    // couldn't read it) — absence of DATA is not absence of the COPY, so
    // never claim an update from it.
    return {
      name: target.name,
      from: target.from,
      to: target.from,
      latest: target.latest,
      outcome: 'unchanged',
      ...held,
      ...swept,
    };
  }
  const to = pkg.dataDir?.installed ?? null;
  const latest = pkg.latest ?? target.latest;
  if (to !== null && to !== target.from) {
    return { name: target.name, from: target.from, to, latest, outcome: 'updated', ...swept };
  }
  if (to === null) {
    // The package WAS rescanned and its data-dir copy is gone — either npm
    // dedupe decided the plugin can use a hoisted/parent copy, or (with
    // wasExtraneous) the reify swept a leftover nothing depended on.
    return { name: target.name, from: target.from, to, latest, outcome: 'updated', ...swept };
  }
  // 'range-limited' is a claim about the plugins' declared ranges, and it is
  // only provable when npm processed every named package (exit 0) AND the
  // post-state was actually compared ('unknown' proves nothing). After a
  // failed run an unchanged package may simply never have been reached —
  // call that 'unchanged', not "waiting on a plugin author".
  const classification = pkg.dataDir?.classification;
  const stillBehind =
    classification === 'patch' || classification === 'minor' || classification === 'major';
  return {
    name: target.name,
    from: target.from,
    to,
    latest,
    outcome: npmSucceeded && stillBehind ? 'range-limited' : 'unchanged',
    ...held,
    ...swept,
  };
}

/** Seams the tests inject fakes through; loadReport/exec default to the
 *  real store and container exec. `rescan` has NO default on purpose: a
 *  silent no-op there would make every successful update classify as
 *  range-limited (the post-state would equal the pre-state), so the caller
 *  must wire the real scanner explicitly. */
export interface HealDeps {
  loadReport: () => Promise<DriftReport | null>;
  exec: (
    cmd: string[],
    workingDir: string,
    timeoutMs: number,
    options?: ExecOptions,
  ) => Promise<ExecResult>;
  /** Re-scan drift after the update so outcomes reflect reality (the
   *  installed side of the scan is a local container read — works offline). */
  rescan: () => Promise<void>;
}

export type HealRunDeps = Pick<HealDeps, 'rescan'> & Partial<Omit<HealDeps, 'rescan'>>;

function withDefaults(deps: HealRunDeps): HealDeps {
  return {
    loadReport: deps.loadReport ?? loadDriftReport,
    exec:
      deps.exec ??
      ((cmd, workingDir, timeoutMs, options) =>
        execInContainer(TARGET_CONTAINER, cmd, workingDir, timeoutMs, options)),
    rescan: deps.rescan,
  };
}

/**
 * Update the drifting data-dir (plugin-tree) copies of the tracked packages
 * inside the signalk-server container, respecting every plugin's declared
 * semver range: `npm update <pkg>…` moves each named package to the highest
 * version the ranges of its dependents allow — and deliberately NOT
 * `npm install <pkg>@latest`, which would override those ranges and can
 * break plugins. The image's copies are never touched (that heal is an
 * image update via the Updater).
 *
 * The doctor deliberately doesn't mount the data dir, so npm runs inside
 * the signalk-server container via the exec API — the same npm and the same
 * tree the appstore itself uses.
 */
export async function runDataDirHeal(runDeps: HealRunDeps): Promise<HealResult> {
  const deps = withDefaults(runDeps);
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const done = (): { finishedAt: string; durationMs: number } => ({
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  });

  const report = await deps.loadReport();
  if (report === null) {
    return {
      ok: false,
      reason: 'no-report',
      detail: 'no drift report yet — run a scan from the Drift tab first',
      startedAt,
      ...done(),
    };
  }

  const targets = selectHealTargets(report);
  if (targets.length === 0) {
    return {
      ok: true,
      startedAt,
      ...done(),
      targets,
      exitCode: null,
      outputTail: '',
      packages: [],
    };
  }

  // Attribution pass BEFORE the update: who depends on each target, with
  // what range. Dependents don't change during `npm update` (only resolved
  // versions do), so the pre-state attribution stays valid for whatever
  // outcome each target ends with. Best-effort — a failed explain costs
  // the outcome labels their heldBy detail, never the heal.
  const explainResult = await explainPackages(
    targets.map((t) => t.name),
    deps.exec,
  );
  const explanations = new Map<string, PackageExplanation>(
    explainResult.ok ? explainResult.explanations.map((e) => [e.name, e]) : [],
  );

  const cmd = [
    'npm',
    'update',
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'warn',
    ...targets.map((t) => t.name),
  ];
  const execResult = await deps.exec(cmd, dataDirRoot(), healTimeoutMs());

  if (!execResult.ok) {
    // 'unreachable' means npm never started — the pre-heal report is still
    // the truth. Every other exec failure (timeout, runtime error mid-run)
    // can arrive AFTER npm began mutating the tree, so rescan and report
    // outcomes for what actually landed; range-limited is never claimed
    // here (npmSucceeded=false) since npm didn't finish its pass.
    if (execResult.reason === 'unreachable') {
      return {
        ok: false,
        reason: 'exec',
        detail: `${execResult.reason}: ${execResult.detail}`,
        startedAt,
        ...done(),
      };
    }
    // The rescan is best-effort here: if it throws, the failure below must
    // STILL be returned — a rejected runner would make the route see no
    // result and release the mutex even though npm may still be running
    // (the exact CC-5 breach lockRetained exists to prevent).
    let packages: HealPackageOutcome[] | undefined;
    try {
      await deps.rescan();
      const afterFailed = await deps.loadReport();
      packages = targets.map((t) => outcomeFor(t, afterFailed, false, explanations.get(t.name)));
    } catch {
      packages = undefined;
    }
    return {
      ok: false,
      reason: 'exec',
      detail: `${execResult.reason}: ${execResult.detail}`,
      startedAt,
      ...done(),
      packages,
      lockRetained: execResult.stillRunning === true,
    };
  }

  // Rescan regardless of npm's exit code — npm can partially succeed before
  // erroring, and the report (plus the outcomes below) must reflect what is
  // actually on disk now.
  await deps.rescan();
  const after = await deps.loadReport();
  const packages = targets.map((t) =>
    outcomeFor(t, after, execResult.exitCode === 0, explanations.get(t.name)),
  );

  if (execResult.exitCode !== 0) {
    return {
      ok: false,
      reason: 'npm',
      detail: `npm update exited with code ${execResult.exitCode}`,
      startedAt,
      ...done(),
      exitCode: execResult.exitCode,
      outputTail: execResult.output,
      packages,
    };
  }

  return {
    ok: true,
    startedAt,
    ...done(),
    targets,
    exitCode: execResult.exitCode,
    outputTail: execResult.output,
    packages,
  };
}
