import type { FastifyBaseLogger } from 'fastify';
import { resolveRuntime, safe } from './podman/client.js';
import { isSemverTag, compareSemver } from './tagClassifier.js';

/**
 * Tagged-image retention for the doctor's own image.
 *
 * Each time the doctor is moved to a new `:<semver>` (via the updater's
 * doctor-update, the installer, or a manual pull+restart), the prior semver
 * tag is left on disk. Nothing else reclaims it: the installer's prunes are
 * dangling-only (`<none>` layers), and an old semver tag is a real RepoTag,
 * not dangling — so old doctor images accumulate (~290 MB each).
 *
 * The updater prunes the doctor's images only when IT drives the doctor-update
 * (`POST /api/doctor/update`). A manual / installer-driven doctor change never
 * triggers that, so this boot-time prune gives the doctor the same self-healing
 * the updater already has for its own image: reap superseded versions on boot,
 * regardless of how the new image arrived.
 *
 * `podman image prune` cannot express "tagged-but-not-in-my-keep-list" — it is
 * dangling-only or all-unused (`-a`, which would also delete a version the
 * operator kept for rollback). So we remove a COMPUTED keep-list by tag.
 *
 * Safety is built on protecting image IDs, not tag strings:
 *   - the running container's image is protected by ID,
 *   - the rolling tags (`:latest`, …) are protected by the ID they resolve to,
 *   - the `keep` most-recent OTHER semver tags are kept for rollback.
 * A candidate tag that shares an ID with any protected entry (the common
 * `:0.7.21` == `:latest` case) is therefore never a removal candidate, so
 * untagging it can never strand another tag's layers.
 *
 * Best-effort throughout: a failed `rmi`, a missing runtime, or a locked layer
 * degrades to a no-op. This must NEVER fail boot.
 */

/** dockerode listImages() row — only the fields we read. */
interface ImageInfo {
  Id: string;
  RepoTags?: string[] | null;
  Created: number;
}

/** Narrow a dockerode listImages() row at the boundary. A malformed row (bad
 *  RepoTags, missing Id) must be skipped rather than throw — this is best-effort
 *  pruning that must never reject the promise. */
function isImageInfo(value: unknown): value is ImageInfo {
  if (typeof value !== 'object' || value === null) return false;
  const image = value as Partial<ImageInfo>;
  return (
    typeof image.Id === 'string' &&
    typeof image.Created === 'number' &&
    (image.RepoTags === undefined ||
      image.RepoTags === null ||
      (Array.isArray(image.RepoTags) && image.RepoTags.every((tag) => typeof tag === 'string')))
  );
}

/** dockerode container inspect() — only the image-id field we read. */
interface ContainerInspect {
  Image?: string;
}

export interface RetentionOptions {
  /** How many OTHER semver tags to retain for rollback, newest-first. Default 1. */
  keep?: number;
  /** Rolling tags never to remove (the ID they resolve to is protected). */
  protectTags?: string[];
}

export interface RetentionResult {
  removed: string[];
  kept: string[];
  skipped: string[];
}

/** A fresh empty result. Not a shared singleton: the arrays are mutable, so a
 *  caller appending to a returned value must never contaminate a later no-op. */
function emptyResult(): RetentionResult {
  return { removed: [], kept: [], skipped: [] };
}

/** A locally-present `<repo>:<tag>` with its resolved image id and age. */
interface TaggedImage {
  repoTag: string;
  tag: string;
  id: string;
  created: number;
}

/**
 * Does this RepoTag's repo half match the prefix? Matches whether the local
 * RepoTag carries the `ghcr.io/` registry host or not, and accepts the prefix
 * in either form — so a fully-qualified prefix still matches the bare local
 * tag podman sometimes stores, and vice-versa.
 */
function repoMatches(repo: string, prefix: string): boolean {
  const bare = prefix.replace(/^ghcr\.io\//, '');
  return repo === prefix || repo === bare || repo === `ghcr.io/${bare}`;
}

/**
 * Remove old tagged images under `repoPrefix`, keeping the running image, the
 * rolling tags, and the `keep` most-recent semver versions.
 *
 * @param repoPrefix       the image repo, fully-qualified — e.g.
 *                         'ghcr.io/dirkwa/signalk-doctor-server'. Pass the
 *                         SELF_IMAGE const (carries the ghcr.io host);
 *                         `repoMatches` also accepts a bare prefix, but the
 *                         full ref is the convention.
 * @param runningContainer container whose image must never be removed, e.g. 'signalk-doctor-server'
 */
export async function pruneOldImagesFor(
  repoPrefix: string,
  runningContainer: string,
  opts: RetentionOptions = {},
  log?: FastifyBaseLogger,
): Promise<RetentionResult> {
  // Guard keep: a negative or non-integer value would skip the rollback-keep
  // loop and make every non-running/non-rolling semver eligible for deletion.
  // Fall back to the default rather than trusting a bad caller.
  let keep = opts.keep ?? 1;
  if (!Number.isSafeInteger(keep) || keep < 0) {
    log?.warn({ keep }, 'image-retention: invalid keep, falling back to 1');
    keep = 1;
  }
  // Always protect the common rolling tags, even on a bare call: a default
  // invocation must never be able to remove :latest / :dirkwa. Callers add
  // engine-specific rolling tags (e.g. :beta) on top.
  const protectTags = new Set<string>(['latest', 'dirkwa', ...(opts.protectTags ?? [])]);

  const rt = await resolveRuntime();
  if (!rt) return emptyResult();

  const listed = await safe(() => rt.client.listImages({}));
  if (!listed.ok) return emptyResult();

  // Collect this repo's locally-present tagged images (drop <none>). Narrow each
  // dockerode row at the boundary; a malformed row is skipped, not thrown on.
  const tagged: TaggedImage[] = [];
  const images = Array.isArray(listed.value) ? listed.value.filter(isImageInfo) : [];
  for (const img of images) {
    if (!img.RepoTags) continue;
    for (const repoTag of img.RepoTags) {
      const colon = repoTag.lastIndexOf(':');
      if (colon === -1) continue;
      const repo = repoTag.slice(0, colon);
      const tag = repoTag.slice(colon + 1);
      if (tag === '<none>' || repo === '<none>') continue;
      if (!repoMatches(repo, repoPrefix)) continue;
      tagged.push({ repoTag, tag, id: img.Id, created: img.Created });
    }
  }
  if (tagged.length === 0) return emptyResult();

  // Build the protect-by-ID set. Protecting by ID (never by tag string) is what
  // makes untagging safe when several tags share one image id.
  const protectedIds = new Set<string>();

  // (a) the running container's image id. Only `.Image` (the resolved sha256
  //     id) can match TaggedImage.id; if inspect fails or .Image is absent we
  //     degrade gracefully — the running image is also covered by a rolling tag
  //     or the keep window, so cleanup still runs rather than disabling itself.
  const inspected = await safe(() => rt.client.getContainer(runningContainer).inspect());
  if (inspected.ok) {
    const info = inspected.value as unknown as ContainerInspect;
    if (info.Image) protectedIds.add(info.Image);
  }

  // (b) the ids that rolling tags resolve to.
  for (const t of tagged) {
    if (protectTags.has(t.tag)) protectedIds.add(t.id);
  }

  // (c) the `keep` most-recent semver versions for rollback, newest-first — but
  // counted among versions NOT already protected above. The running/rolling
  // image is usually itself a semver (e.g. :0.7.21 == :latest); letting it
  // consume the keep budget would push the genuinely-previous version (:0.7.20)
  // out of the window and delete the one tag rollback needs. Skip ids already
  // protected so `keep` measures rollback depth, not total semver count.
  const semverNewestFirst = tagged
    .filter((t) => isSemverTag(t.tag))
    .sort((a, b) => compareSemver(b.tag, a.tag));
  let kept = 0;
  for (const t of semverNewestFirst) {
    if (kept >= keep) break;
    if (protectedIds.has(t.id)) continue;
    protectedIds.add(t.id);
    kept++;
  }

  // Remove every tag whose id is not protected. force:false so a still-referenced
  // layer refuses rather than cascading; safe() so any error is a no-op skip.
  const result: RetentionResult = { removed: [], kept: [], skipped: [] };
  for (const t of tagged) {
    if (protectedIds.has(t.id)) {
      result.kept.push(t.repoTag);
      continue;
    }
    const removed = await safe(() => rt.client.getImage(t.repoTag).remove({ force: false }));
    if (removed.ok) result.removed.push(t.repoTag);
    else result.skipped.push(t.repoTag);
  }

  if (result.removed.length > 0) {
    log?.info(
      { removed: result.removed, kept: result.kept, skipped: result.skipped },
      `image-retention: reclaimed ${result.removed.length} old image(s) for ${repoPrefix}`,
    );
  }
  return result;
}
