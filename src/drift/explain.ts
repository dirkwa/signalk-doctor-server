import { execInContainer, type ExecResult, type ExecOptions } from '../podman/exec.js';
import { dataDirRoot } from './installed-packages.js';

const TARGET_CONTAINER = 'signalk-server';

// `npm explain` only reads the local tree — no registry round-trip — so it
// settles in seconds even on a Pi. Env-overridable for tests.
function explainTimeoutMs(): number {
  const raw = Number(process.env.EXPLAIN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** One DIRECT dependent of a package: who requires it and with what range.
 *  The data dir's own package.json (the tree root) is reported under the
 *  name 'package.json'. */
export interface PackageDependent {
  name: string;
  version: string | null;
  /** The semver range the dependent declares, e.g. "^2.0.0" or "2.9.x". */
  spec: string;
}

export interface PackageExplanation {
  name: string;
  version: string | null;
  dependents: PackageDependent[];
  /** Nothing depends on it — a leftover npm will sweep on the next reify. */
  extraneous: boolean;
  /** A direct dependent is `signalk-server`: the embedded server copy the
   *  pre-container appstore server-update flow installed into the data dir.
   *  It is never executed in the container stack, but its pins hold shared
   *  packages back until it is removed. */
  heldByEmbeddedServer: boolean;
}

export type ExplainResult =
  { ok: true; explanations: PackageExplanation[] } | { ok: false; detail: string };

/** Shape of one entry in `npm explain --json` output (npm 9–11). Only the
 *  fields we read; verified against live npm 11 — but treated as untrusted
 *  (every field re-checked at runtime). */
interface RawExplanation {
  name?: unknown;
  version?: unknown;
  location?: unknown;
  extraneous?: unknown;
  dependents?: unknown;
}

interface RawDependent {
  spec?: unknown;
  from?: { name?: unknown; version?: unknown };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Parse `npm explain --json` output into per-package explanations. A package
 * name can appear in several entries (hoisted + nested copies); the
 * top-level hoisted copy wins (see below), and dependents are deduped by
 * dependent name + spec. Returns null when the payload isn't the expected
 * array (the caller reports the raw detail).
 */
export function parseExplainOutput(output: string): PackageExplanation[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const copiesByName = new Map<string, RawExplanation[]>();
  for (const raw of parsed as RawExplanation[]) {
    if (!raw || typeof raw.name !== 'string' || raw.name.length === 0) continue;
    const list = copiesByName.get(raw.name) ?? [];
    list.push(raw);
    copiesByName.set(raw.name, list);
  }

  const out: PackageExplanation[] = [];
  for (const [name, copies] of copiesByName) {
    // The drift scan reads exactly the TOP-LEVEL hoisted copy
    // (<dataDir>/node_modules/<name>), so when several copies exist at
    // different resolved versions, that copy is the one the question is
    // about: its version, its dependents (a nested copy's holder does not
    // constrain the hoisted one), and its extraneous flag (npm sweeps an
    // extraneous hoisted copy even while a required nested one stays).
    // Without a top-level copy, fall back to merging all copies.
    const topLevel = copies.find((c) => c.location === `node_modules/${name}`);
    const relevant = topLevel !== undefined ? [topLevel] : copies;

    const entry: PackageExplanation = {
      name,
      version: strOrNull(relevant[0]?.version),
      dependents: [],
      extraneous: false,
      heldByEmbeddedServer: false,
    };
    let allCopiesExtraneous = true;
    for (const raw of relevant) {
      allCopiesExtraneous = allCopiesExtraneous && raw.extraneous === true;
      const rawDependents = Array.isArray(raw.dependents) ? (raw.dependents as RawDependent[]) : [];
      for (const d of rawDependents) {
        if (typeof d?.spec !== 'string') continue;
        // The tree root (the data dir's package.json) explains itself
        // without a `from.name`.
        const depName = typeof d.from?.name === 'string' ? d.from.name : 'package.json';
        const dependent: PackageDependent = {
          name: depName,
          version: strOrNull(d.from?.version),
          spec: d.spec,
        };
        if (!entry.dependents.some((e) => e.name === dependent.name && e.spec === dependent.spec)) {
          entry.dependents.push(dependent);
        }
        if (depName === 'signalk-server') entry.heldByEmbeddedServer = true;
      }
    }
    entry.extraneous = entry.dependents.length === 0 && allCopiesExtraneous;
    out.push(entry);
  }
  return out;
}

export type ExplainExec = (
  cmd: string[],
  workingDir: string,
  timeoutMs: number,
  options?: ExecOptions,
) => Promise<ExecResult>;

/**
 * Ask npm who depends on each named package in the data dir's plugin tree.
 * stderr is split off so an npm warning cannot corrupt the JSON payload.
 * Semantics verified against npm 11: exit 0 with an array for found names
 * (a mix with absent names still returns the found ones); exit 1 with an
 * error object when NO name matched — treated as "no explanations", since
 * the caller's names come from a scan that may have gone stale.
 */
export async function explainPackages(
  names: string[],
  exec: ExplainExec = (cmd, workingDir, timeoutMs, options) =>
    execInContainer(TARGET_CONTAINER, cmd, workingDir, timeoutMs, options),
): Promise<ExplainResult> {
  if (names.length === 0) return { ok: true, explanations: [] };
  const result = await exec(
    ['npm', 'explain', '--json', ...names],
    dataDirRoot(),
    explainTimeoutMs(),
    { separateStderr: true },
  );
  if (!result.ok) {
    return { ok: false, detail: `${result.reason}: ${result.detail}` };
  }
  const explanations = parseExplainOutput(result.output);
  if (explanations === null) {
    // npm exits 1 with {"error":{summary:"No dependencies found …"}} when no
    // name matched at all — the benign stale-scan case. Anything ELSE that
    // isn't the expected array is a real failure and must not masquerade as
    // "zero explanations" (the UI would read that as extraneous/clean).
    if (result.exitCode !== 0 && isNoMatchError(result.output)) {
      return { ok: true, explanations: [] };
    }
    return {
      ok: false,
      detail: `npm explain returned an unexpected payload (exit ${result.exitCode}): ${result.output.slice(0, 200)}`,
    };
  }
  return { ok: true, explanations };
}

function isNoMatchError(output: string): boolean {
  try {
    const parsed = JSON.parse(output) as { error?: { summary?: unknown } };
    return (
      typeof parsed?.error?.summary === 'string' &&
      parsed.error.summary.startsWith('No dependencies found')
    );
  } catch {
    return false;
  }
}
