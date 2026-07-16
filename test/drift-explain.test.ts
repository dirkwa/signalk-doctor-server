import { describe, it, expect } from 'vitest';
import { explainPackages, parseExplainOutput } from '../src/drift/explain.js';
import { dataDirRoot } from '../src/drift/installed-packages.js';
import type { ExecResult } from '../src/podman/exec.js';

// Shapes below are captured from live npm 11 (`npm explain --json`).

const DEPENDED_ENTRY = {
  name: '@signalk/server-api',
  version: '2.9.0',
  location: 'node_modules/@signalk/server-api',
  isWorkspace: false,
  dependents: [
    {
      type: 'prod',
      name: '@signalk/server-api',
      spec: '2.9.x',
      from: {
        name: 'signalk-server',
        version: '2.18.0',
        location: 'node_modules/signalk-server',
        dependents: [
          {
            type: 'prod',
            name: 'signalk-server',
            spec: '^2.18.0',
            from: { location: '/home/node/.signalk' },
          },
        ],
      },
    },
  ],
};

const PLUGIN_HELD_ENTRY = {
  name: '@signalk/streams',
  version: '5.1.4',
  location: 'node_modules/@signalk/streams',
  isWorkspace: false,
  dependents: [
    {
      type: 'prod',
      name: '@signalk/streams',
      spec: '^5.0.0',
      from: {
        name: 'signalk-some-plugin',
        version: '1.2.3',
        location: 'node_modules/signalk-some-plugin',
      },
    },
  ],
};

const EXTRANEOUS_ENTRY = {
  name: 'orphan-pkg',
  version: '1.5.0',
  location: 'node_modules/orphan-pkg',
  isWorkspace: false,
  dependents: [],
  extraneous: true,
};

const ROOT_DEP_ENTRY = {
  name: '@signalk/n2k-signalk',
  version: '4.6.0',
  location: 'node_modules/@signalk/n2k-signalk',
  isWorkspace: false,
  dependents: [
    {
      type: 'prod',
      name: '@signalk/n2k-signalk',
      spec: '^4.0.0',
      from: { location: '/home/node/.signalk' },
    },
  ],
};

describe('parseExplainOutput', () => {
  it('extracts direct dependents with name, version and declared range', () => {
    const out = parseExplainOutput(JSON.stringify([PLUGIN_HELD_ENTRY]));
    expect(out).toEqual([
      {
        name: '@signalk/streams',
        version: '5.1.4',
        dependents: [{ name: 'signalk-some-plugin', version: '1.2.3', spec: '^5.0.0' }],
        extraneous: false,
        heldByEmbeddedServer: false,
      },
    ]);
  });

  it('flags the leftover embedded signalk-server as a dependent', () => {
    const out = parseExplainOutput(JSON.stringify([DEPENDED_ENTRY]));
    expect(out?.[0]?.heldByEmbeddedServer).toBe(true);
    expect(out?.[0]?.dependents).toEqual([
      { name: 'signalk-server', version: '2.18.0', spec: '2.9.x' },
    ]);
  });

  it('marks extraneous packages and names the tree root as package.json', () => {
    const out = parseExplainOutput(JSON.stringify([EXTRANEOUS_ENTRY, ROOT_DEP_ENTRY]));
    const orphan = out?.find((e) => e.name === 'orphan-pkg');
    expect(orphan?.extraneous).toBe(true);
    expect(orphan?.dependents).toEqual([]);
    const rooted = out?.find((e) => e.name === '@signalk/n2k-signalk');
    expect(rooted?.dependents).toEqual([{ name: 'package.json', version: null, spec: '^4.0.0' }]);
  });

  it('prefers the top-level hoisted copy when copies at different versions exist', () => {
    // The drift scan reads exactly the top-level copy, so the explanation
    // must describe THAT copy: its version and its dependents. A nested
    // copy's holder does not constrain the hoisted one and must not leak
    // into the answer.
    const nestedCopy = {
      ...PLUGIN_HELD_ENTRY,
      version: '5.0.0',
      location: 'node_modules/other/node_modules/@signalk/streams',
      dependents: [
        {
          type: 'prod',
          name: '@signalk/streams',
          spec: '~5.0.0',
          from: { name: 'signalk-other-plugin', version: '0.9.0' },
        },
      ],
    };
    const out = parseExplainOutput(JSON.stringify([nestedCopy, PLUGIN_HELD_ENTRY]));
    expect(out).toHaveLength(1);
    expect(out?.[0]?.version).toBe('5.1.4');
    expect(out?.[0]?.dependents).toEqual([
      { name: 'signalk-some-plugin', version: '1.2.3', spec: '^5.0.0' },
    ]);
  });

  it('merges all copies only when no top-level copy exists', () => {
    const nestedA = {
      ...PLUGIN_HELD_ENTRY,
      location: 'node_modules/a/node_modules/@signalk/streams',
    };
    const nestedB = {
      ...PLUGIN_HELD_ENTRY,
      location: 'node_modules/b/node_modules/@signalk/streams',
      dependents: [
        {
          type: 'prod',
          name: '@signalk/streams',
          spec: '^5.1.0',
          from: { name: 'signalk-other-plugin', version: '0.9.0' },
        },
      ],
    };
    const out = parseExplainOutput(JSON.stringify([nestedA, nestedB]));
    expect(out).toHaveLength(1);
    expect(out?.[0]?.dependents).toEqual([
      { name: 'signalk-some-plugin', version: '1.2.3', spec: '^5.0.0' },
      { name: 'signalk-other-plugin', version: '0.9.0', spec: '^5.1.0' },
    ]);
  });

  it('is not extraneous when ANY copy of the package is required', () => {
    // One required nested copy keeps the package in the tree, whatever an
    // extraneous hoisted duplicate's flag says — OR-merging the flags would
    // produce false "removed leftover" claims.
    const requiredCopy = PLUGIN_HELD_ENTRY;
    const extraneousCopy = {
      name: '@signalk/streams',
      version: '5.0.0',
      location: 'node_modules/dead/node_modules/@signalk/streams',
      dependents: [],
      extraneous: true,
    };
    const out = parseExplainOutput(JSON.stringify([extraneousCopy, requiredCopy]));
    expect(out).toHaveLength(1);
    expect(out?.[0]?.extraneous).toBe(false);
    expect(out?.[0]?.dependents).toHaveLength(1);
  });

  it('tolerates a malformed dependents field without throwing', () => {
    const out = parseExplainOutput(
      JSON.stringify([{ name: 'weird-pkg', version: '1.0.0', dependents: {} }]),
    );
    expect(out).toEqual([
      {
        name: 'weird-pkg',
        version: '1.0.0',
        dependents: [],
        extraneous: false,
        heldByEmbeddedServer: false,
      },
    ]);
  });

  it('returns null on non-array or unparseable payloads', () => {
    expect(parseExplainOutput('{ not json')).toBeNull();
    expect(parseExplainOutput('{"error":{"summary":"No dependencies found"}}')).toBeNull();
  });
});

describe('explainPackages', () => {
  const ok = (output: string): ExecResult => ({ ok: true, exitCode: 0, output });

  it('runs npm explain --json in the data dir with stderr split off', async () => {
    let recorded: { cmd?: string[]; workingDir?: string; separate?: boolean } = {};
    const res = await explainPackages(['@signalk/streams'], (cmd, workingDir, _t, options) => {
      recorded = { cmd, workingDir, separate: options?.separateStderr };
      return Promise.resolve(ok(JSON.stringify([PLUGIN_HELD_ENTRY])));
    });
    expect(recorded.cmd).toEqual(['npm', 'explain', '--json', '@signalk/streams']);
    expect(recorded.workingDir).toBe(dataDirRoot());
    expect(recorded.separate).toBe(true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.explanations[0]?.dependents[0]?.name).toBe('signalk-some-plugin');
  });

  it('treats npm "no dependencies found" (exit 1, error payload) as zero explanations', async () => {
    const res = await explainPackages(['gone-pkg'], () =>
      Promise.resolve({
        ok: true,
        exitCode: 1,
        output: '{"error":{"summary":"No dependencies found matching gone-pkg","detail":""}}',
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.explanations).toEqual([]);
  });

  it('fails — not empty — on an unrecognized nonzero payload', async () => {
    // Only npm's "No dependencies found" no-match is benign; any other
    // garbage with a nonzero exit is a real failure, and returning [] for
    // it would read as "extraneous/clean" in the UI.
    const res = await explainPackages(['@signalk/streams'], () =>
      Promise.resolve({ ok: true, exitCode: 137, output: 'Killed' }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toMatch(/unexpected payload \(exit 137\)/);
  });

  it('fails with the transport detail when exec fails', async () => {
    const res = await explainPackages(['@signalk/streams'], () =>
      Promise.resolve({ ok: false, reason: 'unreachable', detail: 'no socket' }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toMatch(/unreachable: no socket/);
  });

  it('short-circuits on an empty name list without exec', async () => {
    let called = false;
    const res = await explainPackages([], () => {
      called = true;
      return Promise.resolve(ok('[]'));
    });
    expect(called).toBe(false);
    expect(res.ok).toBe(true);
  });
});
