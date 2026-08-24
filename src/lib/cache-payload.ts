/**
 * One payload-validation rule for every cache restore path (#475).
 *
 * A cache that misses is fine. A cache that reports a hit and hands back an
 * unusable payload is worse than no cache, because it removes the signal that
 * would tell you to investigate: the restore claims an exact key match, the
 * fallback still produces a correct build, and the only symptom is cold-path
 * time on a run nobody is timing.
 *
 * Two instances of that shape were filed before this existed -- #474 (a cook
 * layer restoring `exact=true archive=0B`, then falling back to a full
 * re-cook) and #473 (a truncated toolchain entry poisoning every later run).
 * `solo-toolchain-cache` already had the right instinct, checking that the
 * decompressed tree was non-empty; nothing else did. This makes that instinct
 * shared rather than incidental.
 *
 * Deliberately NOT content hashing: it would cost real time on every restore
 * of a multi-hundred-MB archive to catch a rare fault, and the failure modes
 * actually observed (zero-length, truncated) are caught far more cheaply.
 */

import * as fsp from "node:fs/promises";

/** Why a restored payload cannot be trusted, or `null` when it can. */
export type PayloadRejection = "missing" | "empty";

export interface PayloadCheck {
  /** Whether the caller may report this restore as a hit. */
  usable: boolean;
  /** Size on disk; 0 when the archive is missing or empty. */
  bytes: number;
  /** Set when `usable` is false. */
  rejection: PayloadRejection | null;
}

/**
 * Stat a restored archive and decide whether it may be reported as a hit.
 *
 * A zero-byte archive cannot be valid for any layer or codec, so it is the one
 * check that is safe to apply everywhere without knowing what the layer holds.
 */
export async function checkRestoredArchive(archivePath: string): Promise<PayloadCheck> {
  let bytes: number;
  try {
    bytes = (await fsp.stat(archivePath)).size;
  } catch {
    return { usable: false, bytes: 0, rejection: "missing" };
  }
  if (bytes === 0) {
    return { usable: false, bytes: 0, rejection: "empty" };
  }
  return { usable: true, bytes, rejection: null };
}

/**
 * The warning a layer emits when a matched key produced an unusable payload.
 *
 * Phrased to name the key, because the failure is indistinguishable from a
 * working cache at a glance and the key is what makes it searchable. Callers
 * should route this to `core.warning`, not an info line: a full rebuild after
 * a matched restore should not require reading raw CI logs to notice.
 */
export function unusablePayloadMessage(
  label: string,
  matchedKey: string,
  check: PayloadCheck,
): string {
  const why =
    check.rejection === "missing"
      ? "the archive is not on disk"
      : "the archive is zero bytes";
  return (
    `${label}: cache key matched but ${why}, treating as a MISS ` +
    `(key=${matchedKey}). The build will run the cold path; this is a cache ` +
    `fault, not a source change.`
  );
}

/**
 * Refuse to upload an archive that would poison the key it is saved under.
 *
 * Actions cache entries are immutable: once a key holds a bad payload, every
 * later run matches that key and gets the bad payload, and no amount of
 * re-running fixes it. That is the permanent half of #473 -- and it is why
 * validating on restore alone is not enough. A restore-side check turns a
 * poisoned entry into an honest miss on every run forever; a save-side check
 * stops it being written in the first place.
 *
 * Throws rather than returning a flag so a caller cannot accidentally ignore
 * it: the save paths already treat a thrown error as "did not save", which is
 * exactly the right outcome.
 */
export async function assertArchiveWorthSaving(
  label: string,
  archivePath: string,
): Promise<number> {
  const check = await checkRestoredArchive(archivePath);
  if (!check.usable) {
    const why = check.rejection === "missing" ? "was not written" : "is zero bytes";
    throw new Error(
      `${label}: refusing to upload an archive that ${why} (${archivePath}). ` +
        `Cache keys are immutable, so saving it would serve this payload to ` +
        `every later run that matches the key.`,
    );
  }
  return check.bytes;
}
