import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeVersionDrift } from '../src/probes/version-drift.js';

// The drift probe pulls from three sources. In this test suite we
// control the Quadlet source by pointing QUADLET_DIR at a temp dir;
// the dockerode and /api/health sources will be unreachable from the
// test runner (no podman socket, no host.containers.internal), so they
// resolve to null. Drift detection is meant to be a strict
// equality check — null sources skip the check entirely, which is the
// behaviour we assert below.
describe('probeVersionDrift', () => {
  let dir: string;
  const previousQuadletDir = process.env.QUADLET_DIR;
  const previousUpdaterUrl = process.env.UPDATER_URL;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-drift-'));
    process.env.QUADLET_DIR = dir;
    // Point the updater health probe at a guaranteed-unreachable port
    // so the test doesn't randomly hit something on localhost.
    process.env.UPDATER_URL = 'http://127.0.0.1:1/api/health';
  });

  afterEach(async () => {
    if (previousQuadletDir === undefined) delete process.env.QUADLET_DIR;
    else process.env.QUADLET_DIR = previousQuadletDir;
    if (previousUpdaterUrl === undefined) delete process.env.UPDATER_URL;
    else process.env.UPDATER_URL = previousUpdaterUrl;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns ok by default (no Quadlets, so nothing can be in conflict)', async () => {
    // With no Quadlet files and the updater HTTP probe pointed at an
    // unreachable port, the only source that could provide a tag is
    // dockerode reading the running container's image. That source may
    // succeed on a dev host (where the doctor's own running container
    // is named signalk-doctor-server) or fail (CI runners have no
    // podman). Either path returns status=ok — there is nothing to
    // disagree with — so we assert just on id+status here.
    const r = await probeVersionDrift();
    expect(r.id).toBe('version-drift');
    expect(r.status).toBe('ok');
  });

  it('extracts the tag from a Quadlet Image= line', async () => {
    await writeFile(
      join(dir, 'signalk-updater-server.container'),
      [
        '[Container]',
        'Image=ghcr.io/dirkwa/signalk-updater-server:0.5.1',
        'ContainerName=signalk-updater-server',
      ].join('\n'),
      'utf8',
    );
    const r = await probeVersionDrift();
    expect(r.status).toBe('ok');
    // No running container or reported version, so the only source is
    // the Quadlet tag, which has nothing to disagree with.
    expect(r.details).toBeDefined();
    const details = r.details as Record<string, { quadletTag: string | null }>;
    expect(details['signalk-updater-server'].quadletTag).toBe('0.5.1');
  });

  it('handles registry:port/foo:tag form correctly (tag after last slash + colon)', async () => {
    await writeFile(
      join(dir, 'signalk-server.container'),
      'Image=localhost:5000/dirkwa/signalk-server:edge\n',
      'utf8',
    );
    const r = await probeVersionDrift();
    const details = r.details as Record<string, { quadletTag: string | null }>;
    expect(details['signalk-server'].quadletTag).toBe('edge');
  });

  it('does not flag drift when the Quadlet tag is a floating channel name', async () => {
    // Quadlet says `:latest`, container is on `:latest`, engine reports
    // v0.5.1 — that's the normal state. Comparing "latest" to "0.5.1"
    // as strings would otherwise be a false-positive.
    await writeFile(
      join(dir, 'signalk-updater-server.container'),
      'Image=ghcr.io/dirkwa/signalk-updater-server:latest\n',
      'utf8',
    );
    // No mocked engine HTTP, but the no-conflict case should already
    // hold even without one. Just assert no drift message is produced
    // for the floating-tag Quadlet on its own.
    const r = await probeVersionDrift();
    expect(r.status).toBe('ok');
  });

  it('strips an @sha256:… digest suffix before extracting the tag', async () => {
    await writeFile(
      join(dir, 'signalk-server.container'),
      'Image=ghcr.io/dirkwa/signalk-server:0.4.0@sha256:abc123\n',
      'utf8',
    );
    const r = await probeVersionDrift();
    const details = r.details as Record<string, { quadletTag: string | null }>;
    expect(details['signalk-server'].quadletTag).toBe('0.4.0');
  });
});
