import { describe, it, expect } from 'vitest';
import { runDataDirHeal, selectHealTargets } from '../src/drift/heal.js';
import type { ExecResult } from '../src/podman/exec.js';
import type { DriftLocation, DriftPackage, DriftReport } from '../src/drift/types.js';

function loc(installed: string, classification: DriftLocation['classification']): DriftLocation {
  return { installed, classification };
}

function pkg(
  name: string,
  image: DriftLocation | null,
  dataDir: DriftLocation | null,
  latest: string | null,
): DriftPackage {
  return { name, image, dataDir, latest, etag: null, lastFetchedAt: null };
}

function report(packages: DriftPackage[]): DriftReport {
  return {
    signalkImageTag: 'ghcr.io/dirkwa/signalk-server:dirkwa-abc1234',
    lastScannedAt: new Date().toISOString(),
    lastSuccessfulScanAt: new Date().toISOString(),
    online: true,
    lastFetchError: null,
    packages,
  };
}

/** loadReport seam that serves `before` until rescan() runs, `after` from
 *  then on — the exact sequence the engine sees in production. */
function reportSequence(before: DriftReport, after: DriftReport) {
  let rescanned = false;
  return {
    loadReport: () => Promise.resolve(rescanned ? after : before),
    rescan: () => {
      rescanned = true;
      return Promise.resolve();
    },
    wasRescanned: () => rescanned,
  };
}

const okExec =
  (record: { cmd?: string[]; workingDir?: string }, output = '') =>
  (cmd: string[], workingDir: string): Promise<ExecResult> => {
    record.cmd = cmd;
    record.workingDir = workingDir;
    return Promise.resolve({ ok: true, exitCode: 0, output });
  };

describe('selectHealTargets', () => {
  it('picks only data-dir copies that are behind', () => {
    const r = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
      pkg('@signalk/streams', loc('6.8.0', 'up-to-date'), loc('5.1.3', 'major'), '6.8.0'),
      pkg('@canboat/ts-pgns', loc('1.11.17', 'patch'), null, '1.11.18'), // image drift only
      pkg('@canboat/canboatjs', loc('3.20.0', 'up-to-date'), loc('3.20.0', 'up-to-date'), '3.20.0'),
      pkg('@signalk/path-metadata', null, loc('1.0.0', 'unknown'), null), // not compared
    ]);
    expect(selectHealTargets(r)).toEqual([
      { name: '@signalk/server-api', from: '2.24.0', latest: '2.30.0' },
      { name: '@signalk/streams', from: '5.1.3', latest: '6.8.0' },
    ]);
  });
});

describe('runDataDirHeal', () => {
  it('runs a range-respecting npm update in the data dir and reports per-package outcomes', async () => {
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
      pkg('@signalk/streams', loc('6.8.0', 'up-to-date'), loc('5.1.3', 'major'), '6.8.0'),
      pkg('@signalk/n2k-signalk', loc('4.6.0', 'up-to-date'), loc('4.4.0', 'minor'), '4.6.0'),
    ]);
    const after = report([
      // moved within range → updated
      pkg(
        '@signalk/server-api',
        loc('2.30.0', 'up-to-date'),
        loc('2.30.0', 'up-to-date'),
        '2.30.0',
      ),
      // plugin pins ^5 → stays and still classifies major → range-limited
      pkg('@signalk/streams', loc('6.8.0', 'up-to-date'), loc('5.1.3', 'major'), '6.8.0'),
      // npm dedupe hoisted the copy away entirely → updated (to: null)
      pkg('@signalk/n2k-signalk', loc('4.6.0', 'up-to-date'), null, '4.6.0'),
    ]);
    const seq = reportSequence(before, after);
    const recorded: { cmd?: string[]; workingDir?: string } = {};

    const res = await runDataDirHeal({
      loadReport: seq.loadReport,
      rescan: seq.rescan,
      exec: okExec(recorded, 'changed 2 packages'),
    });

    expect(recorded.cmd).toEqual([
      'npm',
      'update',
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'warn',
      '@signalk/server-api',
      '@signalk/streams',
      '@signalk/n2k-signalk',
    ]);
    expect(recorded.workingDir).toBe('/home/node/.signalk');
    expect(seq.wasRescanned()).toBe(true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.exitCode).toBe(0);
    expect(res.packages).toEqual([
      {
        name: '@signalk/server-api',
        from: '2.24.0',
        to: '2.30.0',
        latest: '2.30.0',
        outcome: 'updated',
      },
      {
        name: '@signalk/streams',
        from: '5.1.3',
        to: '5.1.3',
        latest: '6.8.0',
        outcome: 'range-limited',
      },
      {
        name: '@signalk/n2k-signalk',
        from: '4.4.0',
        to: null,
        latest: '4.6.0',
        outcome: 'updated',
      },
    ]);
  });

  it('short-circuits ok with no exec when nothing is healable', async () => {
    const clean = report([
      pkg('@signalk/streams', loc('5.1.3', 'major'), null, '6.8.0'), // image-only drift
      pkg('@canboat/canboatjs', loc('3.20.0', 'up-to-date'), loc('3.20.0', 'up-to-date'), '3.20.0'),
    ]);
    let execCalled = false;
    const res = await runDataDirHeal({
      loadReport: () => Promise.resolve(clean),
      rescan: () => Promise.resolve(),
      exec: () => {
        execCalled = true;
        return Promise.resolve({ ok: true, exitCode: 0, output: '' });
      },
    });
    expect(execCalled).toBe(false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.targets).toEqual([]);
    expect(res.packages).toEqual([]);
  });

  it('fails with no-report when the scanner has never run', async () => {
    const res = await runDataDirHeal({
      loadReport: () => Promise.resolve(null),
      rescan: () => Promise.resolve(),
      exec: () => Promise.resolve({ ok: true, exitCode: 0, output: '' }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no-report');
  });

  it('skips the rescan only for unreachable (npm never started)', async () => {
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
    ]);
    let rescanned = false;
    const res = await runDataDirHeal({
      loadReport: () => Promise.resolve(before),
      rescan: () => {
        rescanned = true;
        return Promise.resolve();
      },
      exec: () => Promise.resolve({ ok: false, reason: 'unreachable', detail: 'no socket' }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('exec');
    expect(res.detail).toMatch(/unreachable: no socket/);
    expect(rescanned).toBe(false);
    expect(res.lockRetained).toBeFalsy();
  });

  it('rescans after a mid-run exec failure and retains the lock while npm may still run', async () => {
    // A timeout can fire after npm already started mutating the tree: the
    // report must be rescanned (partial work is on disk), no range-limited
    // claim may be made, and lockRetained must tell the route to keep the
    // shared operation lock until the operator confirms npm is gone.
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
      pkg('@signalk/n2k-signalk', loc('4.6.0', 'up-to-date'), loc('4.4.0', 'minor'), '4.6.0'),
    ]);
    const after = report([
      pkg(
        '@signalk/server-api',
        loc('2.30.0', 'up-to-date'),
        loc('2.30.0', 'up-to-date'),
        '2.30.0',
      ),
      pkg('@signalk/n2k-signalk', loc('4.6.0', 'up-to-date'), loc('4.4.0', 'minor'), '4.6.0'),
    ]);
    const seq = reportSequence(before, after);
    const res = await runDataDirHeal({
      loadReport: seq.loadReport,
      rescan: seq.rescan,
      exec: () =>
        Promise.resolve({
          ok: false,
          reason: 'timeout',
          stillRunning: true,
          detail: 'command did not finish within 600s',
        }),
    });
    expect(seq.wasRescanned()).toBe(true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('exec');
    expect(res.lockRetained).toBe(true);
    // Partial work is reported, but never as range-limited.
    expect(res.packages?.map((p) => p.outcome)).toEqual(['updated', 'unchanged']);
  });

  it('keeps lockRetained even when the post-failure rescan throws', async () => {
    // If the rescan rejection escaped, the route would see a rejected
    // runner (no result) and release the mutex while npm may still be
    // mutating the tree — the exact CC-5 breach lockRetained prevents.
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
    ]);
    const res = await runDataDirHeal({
      loadReport: () => Promise.resolve(before),
      rescan: () => Promise.reject(new Error('scanner exploded')),
      exec: () =>
        Promise.resolve({
          ok: false,
          reason: 'timeout',
          stillRunning: true,
          detail: 'command did not finish within 600s',
        }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.lockRetained).toBe(true);
    expect(res.packages).toBeUndefined();
  });

  it('attributes non-updated outcomes with dependents from the explain pass', async () => {
    const stuck = report([
      pkg('@signalk/streams', loc('6.8.0', 'up-to-date'), loc('5.1.4', 'major'), '6.8.0'),
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.9.0', 'minor'), '2.30.0'),
    ]);
    const explainJson = JSON.stringify([
      {
        name: '@signalk/streams',
        version: '5.1.4',
        dependents: [{ spec: '^5.0.0', from: { name: 'signalk-some-plugin', version: '1.2.3' } }],
      },
      {
        name: '@signalk/server-api',
        version: '2.9.0',
        dependents: [{ spec: '2.9.x', from: { name: 'signalk-server', version: '2.18.0' } }],
      },
    ]);
    const seq = reportSequence(stuck, stuck); // npm moves nothing
    const res = await runDataDirHeal({
      loadReport: seq.loadReport,
      rescan: seq.rescan,
      exec: (cmd) =>
        Promise.resolve(
          cmd[1] === 'explain'
            ? { ok: true, exitCode: 0, output: explainJson }
            : { ok: true, exitCode: 0, output: 'up to date' },
        ),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const streams = res.packages.find((p) => p.name === '@signalk/streams');
    expect(streams?.outcome).toBe('range-limited');
    expect(streams?.heldBy).toEqual([
      { name: 'signalk-some-plugin', version: '1.2.3', spec: '^5.0.0' },
    ]);
    expect(streams?.heldByEmbeddedServer).toBeUndefined();
    const api = res.packages.find((p) => p.name === '@signalk/server-api');
    expect(api?.heldByEmbeddedServer).toBe(true);
    expect(api?.heldBy).toEqual([{ name: 'signalk-server', version: '2.18.0', spec: '2.9.x' }]);
  });

  it('heals fine without attribution when the explain pass fails', async () => {
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
    ]);
    const after = report([
      pkg(
        '@signalk/server-api',
        loc('2.30.0', 'up-to-date'),
        loc('2.30.0', 'up-to-date'),
        '2.30.0',
      ),
    ]);
    const seq = reportSequence(before, after);
    const res = await runDataDirHeal({
      loadReport: seq.loadReport,
      rescan: seq.rescan,
      exec: (cmd) =>
        Promise.resolve(
          cmd[1] === 'explain'
            ? { ok: false, reason: 'runtime', detail: 'exec hiccup' }
            : { ok: true, exitCode: 0, output: 'changed 1 package' },
        ),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.packages[0]?.outcome).toBe('updated');
    expect(res.packages[0]?.heldBy).toBeUndefined();
  });

  it('reports unchanged — never updated — when the post-scan lacks the package', async () => {
    // Absence of post-state (rescan could not read the package) is not
    // absence of the copy; claiming "updated (hoisted away)" from missing
    // data would be a lie.
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
    ]);
    const seq = reportSequence(before, report([]));
    const res = await runDataDirHeal({
      loadReport: seq.loadReport,
      rescan: seq.rescan,
      exec: okExec({}),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.packages).toEqual([
      {
        name: '@signalk/server-api',
        from: '2.24.0',
        to: '2.24.0',
        latest: '2.30.0',
        outcome: 'unchanged',
      },
    ]);
  });

  it('reports npm failure but still rescans and carries per-package outcomes', async () => {
    // npm can partially succeed before erroring; the outcomes must reflect
    // what actually landed on disk, not pretend nothing happened.
    const before = report([
      pkg('@signalk/server-api', loc('2.30.0', 'up-to-date'), loc('2.24.0', 'minor'), '2.30.0'),
      pkg('@signalk/n2k-signalk', loc('4.6.0', 'up-to-date'), loc('4.4.0', 'minor'), '4.6.0'),
    ]);
    const after = report([
      pkg(
        '@signalk/server-api',
        loc('2.30.0', 'up-to-date'),
        loc('2.30.0', 'up-to-date'),
        '2.30.0',
      ),
      pkg('@signalk/n2k-signalk', loc('4.6.0', 'up-to-date'), loc('4.4.0', 'minor'), '4.6.0'),
    ]);
    const seq = reportSequence(before, after);
    const res = await runDataDirHeal({
      loadReport: seq.loadReport,
      rescan: seq.rescan,
      exec: () => Promise.resolve({ ok: true, exitCode: 1, output: 'ERESOLVE unable to resolve' }),
    });
    expect(seq.wasRescanned()).toBe(true);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('npm');
    expect(res.exitCode).toBe(1);
    expect(res.outputTail).toMatch(/ERESOLVE/);
    expect(res.packages?.map((p) => p.outcome)).toEqual(['updated', 'unchanged']);
  });
});
