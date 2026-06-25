import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the dockerode-shaped client seam: pruneOldImagesFor only touches
// resolveRuntime() and safe(), so a fake client + pass-through safe() drives
// every path.
const mockResolveRuntime = vi.fn();
const mockSafe = vi.fn();
vi.mock('../src/podman/client.js', () => ({
  resolveRuntime: () => mockResolveRuntime(),
  safe: (fn: () => Promise<unknown>) => mockSafe(fn),
}));

import { pruneOldImagesFor } from '../src/image-retention.js';

const PREFIX = 'ghcr.io/dirkwa/signalk-doctor-server';

interface ImageRow {
  Id: string;
  RepoTags: string[];
  Created: number;
}

/**
 * Build a dockerode-shaped client.
 * @param images          listImages() payload.
 * @param runningImageId  the running container's resolved image id (or undefined to fail inspect).
 * @param removed         collector that records every getImage(ref).remove() call.
 */
function makeClient(
  images: ImageRow[],
  runningImageId: string | undefined,
  removed: string[],
  failRemoveFor: Set<string> = new Set(),
) {
  return {
    listImages: async () => images,
    getContainer: (_name: string) => ({
      inspect: async () => {
        if (runningImageId === undefined) throw new Error('no such container');
        return { Image: runningImageId };
      },
    }),
    getImage: (ref: string) => ({
      remove: async () => {
        if (failRemoveFor.has(ref)) throw new Error(`locked: ${ref}`);
        removed.push(ref);
        return [{ Untagged: ref }];
      },
    }),
  };
}

beforeEach(() => {
  mockResolveRuntime.mockReset();
  mockSafe.mockReset();
  mockSafe.mockImplementation(async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: { kind: 'unknown', userMessage: String(err), raw: '' } };
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pruneOldImagesFor', () => {
  it('keeps running + :latest + previous semver; removes the rest', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:NEW', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:PREV', RepoTags: [`${PREFIX}:0.7.20`], Created: 400 },
      { Id: 'sha256:OLD1', RepoTags: [`${PREFIX}:0.7.18`], Created: 300 },
      { Id: 'sha256:OLD2', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, 'sha256:NEW', removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: 1 });

    expect(r.removed.sort()).toEqual([`${PREFIX}:0.7.15`, `${PREFIX}:0.7.18`]);
    expect(removed.sort()).toEqual([`${PREFIX}:0.7.15`, `${PREFIX}:0.7.18`]);
    expect(r.kept).toEqual(
      expect.arrayContaining([`${PREFIX}:0.7.21`, `${PREFIX}:latest`, `${PREFIX}:0.7.20`]),
    );
  });

  it('never removes a tag that shares an image id with a protected tag', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:NEW', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:OLD', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, 'sha256:NEW', removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: 0 });

    expect(removed).toEqual([`${PREFIX}:0.7.15`]);
    expect(r.kept).toEqual(expect.arrayContaining([`${PREFIX}:0.7.21`, `${PREFIX}:latest`]));
  });

  it('keep=1 retains exactly the immediately-previous semver', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:A', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:B', RepoTags: [`${PREFIX}:0.7.20`], Created: 400 },
      { Id: 'sha256:C', RepoTags: [`${PREFIX}:0.7.18`], Created: 300 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, 'sha256:A', removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: 1 });

    expect(r.removed).toEqual([`${PREFIX}:0.7.18`]);
    expect(r.kept).toEqual(expect.arrayContaining([`${PREFIX}:0.7.20`]));
  });

  it('an explicit protectTag keeps a non-newest version (the downgrade rollback target)', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:NEWEST', RepoTags: [`${PREFIX}:0.7.30`], Created: 600 },
      { Id: 'sha256:PREV', RepoTags: [`${PREFIX}:0.7.21`], Created: 500 },
      { Id: 'sha256:RUN', RepoTags: [`${PREFIX}:0.7.20`, `${PREFIX}:latest`], Created: 480 },
      { Id: 'sha256:OLD', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, 'sha256:RUN', removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', {
      keep: 1,
      protectTags: ['0.7.21'], // the just-replaced tag
    });

    expect(r.removed).toEqual([`${PREFIX}:0.7.15`]);
    expect(r.kept).toEqual(
      expect.arrayContaining([`${PREFIX}:0.7.21`, `${PREFIX}:0.7.30`, `${PREFIX}:0.7.20`]),
    );
  });

  it('an invalid keep (negative) falls back to 1 rather than reaping all rollback versions', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:RUN', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:PREV', RepoTags: [`${PREFIX}:0.7.20`], Created: 400 },
      { Id: 'sha256:OLD', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, 'sha256:RUN', removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: -1 });

    expect(r.removed).toEqual([`${PREFIX}:0.7.15`]);
    expect(r.kept).toEqual(expect.arrayContaining([`${PREFIX}:0.7.20`]));
  });

  it('a remove() failure on one image does not abort the rest and never throws', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:RUN', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:LOCKED', RepoTags: [`${PREFIX}:0.7.18`], Created: 300 },
      { Id: 'sha256:FREE', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({
      client: makeClient(images, 'sha256:RUN', removed, new Set([`${PREFIX}:0.7.18`])),
    });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: 0 });

    expect(r.removed).toEqual([`${PREFIX}:0.7.15`]);
    expect(r.skipped).toEqual([`${PREFIX}:0.7.18`]);
  });

  it('no runtime → clean no-op', async () => {
    mockResolveRuntime.mockResolvedValue(null);
    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server');
    expect(r).toEqual({ removed: [], kept: [], skipped: [] });
  });

  it('protects :latest and :dirkwa by default, even with no opts and no running container', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:L', RepoTags: [`${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:D', RepoTags: [`${PREFIX}:dirkwa`], Created: 480 },
      { Id: 'sha256:OLD', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, undefined, removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server');

    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual(expect.arrayContaining([`${PREFIX}:latest`, `${PREFIX}:dirkwa`]));
  });

  it('matches bare and ghcr-prefixed repos, and leaves other repos untouched', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:RUN', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:BARE', RepoTags: ['dirkwa/signalk-doctor-server:0.7.15'], Created: 200 },
      {
        Id: 'sha256:OTHER',
        RepoTags: ['ghcr.io/dirkwa/signalk-updater-server:0.7.1'],
        Created: 100,
      },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, 'sha256:RUN', removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: 0 });

    expect(removed).toEqual(['dirkwa/signalk-doctor-server:0.7.15']);
    expect(r.removed).toEqual(['dirkwa/signalk-doctor-server:0.7.15']);
  });

  it('if the running container cannot be inspected, still protects :latest + the keep window', async () => {
    const removed: string[] = [];
    const images: ImageRow[] = [
      { Id: 'sha256:NEW', RepoTags: [`${PREFIX}:0.7.21`, `${PREFIX}:latest`], Created: 500 },
      { Id: 'sha256:PREV', RepoTags: [`${PREFIX}:0.7.20`], Created: 400 },
      { Id: 'sha256:OLD', RepoTags: [`${PREFIX}:0.7.15`], Created: 200 },
    ];
    mockResolveRuntime.mockResolvedValue({ client: makeClient(images, undefined, removed) });

    const r = await pruneOldImagesFor(PREFIX, 'signalk-doctor-server', { keep: 1 });

    expect(r.removed).toEqual([`${PREFIX}:0.7.15`]);
    expect(r.kept).toEqual(
      expect.arrayContaining([`${PREFIX}:latest`, `${PREFIX}:0.7.21`, `${PREFIX}:0.7.20`]),
    );
  });
});
