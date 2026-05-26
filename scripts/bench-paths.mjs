// Layer -> on-disk paths registry for the cache-mode benchmark.
//
// Each layer resolves to one or more (parent, basename) tuples. The bench
// driver tar+zstds each tuple into <parent>/<basename>.tar.zst, then wipes
// <parent>/<basename> and restores from the archive. Parent grouping matches
// what the production save path does (e.g. cargo-registry bundles three
// sibling dirs under ~/.cargo).
//
// Sources cross-referenced against:
//   src/lib/soldr-mini-cache.ts        (mini)
//   src/lib/solo-toolchain-cache.ts    (solo-toolchain)
//   src/post.ts                        (cargo-registry, setup-cache)
//   src/lib/cook-cache.ts              (cook)
//   src/main.ts / src/post.ts          (build, target)
//
// Kept independent of src/lib so the bench can run without building the
// action bundle. The companion test asserts the layer name list is exhaustive
// vs the inventory in the issue body.

import * as path from "node:path";
import * as os from "node:os";

export const LAYER_NAMES = Object.freeze([
  "baseline",
  "soldr-mini",
  "solo-toolchain",
  "cargo-registry",
  "cook",
  "build",
  "target",
  "setup-cache",
  "all-on",
]);

/**
 * @typedef {object} LayerPath
 * @property {string} parent   - absolute path of the directory containing basename
 * @property {string} basename - the directory entry under parent that gets tarred
 */

/**
 * @typedef {object} SnapshotEntry
 * @property {string} root
 * @property {string} relpath
 * @property {"file"|"symlink"|"directory"} [kind]
 */

/**
 * @typedef {object} SnapshotDiff
 * @property {SnapshotEntry[]} [added]
 * @property {{after: SnapshotEntry}[]} [changed]
 */

/**
 * Resolve the on-disk paths for a given layer.
 *
 * @param {string} layer
 * @param {{env?: NodeJS.ProcessEnv, workloadDir?: string, soloToolchainDelta?: SnapshotDiff}} [opts]
 * @returns {LayerPath[]}
 */
export function pathsForLayer(layer, opts = {}) {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const runnerTemp = env.RUNNER_TEMP ?? os.tmpdir();
  const cargoHome = env.CARGO_HOME ?? path.join(home, ".cargo");
  const rustupHome = env.RUSTUP_HOME ?? path.join(home, ".rustup");
  const zccacheDir = env.ZCCACHE_CACHE_DIR ?? path.join(home, ".cache", "zccache");
  const workloadDir = opts.workloadDir ?? path.join(process.cwd(), "scripts", "bench-workloads", "demo-small");
  const setupCachePath = env.SETUP_SOLDR_CACHE_PATH ?? path.join(runnerTemp, "setup-soldr-cache");
  const soldrInstallDir = env.SOLDR_INSTALL_DIR ?? path.join(runnerTemp, "setup-soldr-tools");

  switch (layer) {
    case "baseline":
      return [];
    case "soldr-mini":
      return [{ parent: path.dirname(soldrInstallDir), basename: path.basename(soldrInstallDir) }];
    case "solo-toolchain":
      if (Object.prototype.hasOwnProperty.call(opts, "soloToolchainDelta")) {
        return pathsForSoloToolchainDelta(opts.soloToolchainDelta);
      }
      return [
        { parent: rustupHome, basename: "toolchains" },
        { parent: cargoHome, basename: "bin" },
      ];
    case "cargo-registry":
      return [
        { parent: cargoHome, basename: "registry" },
        { parent: cargoHome, basename: "git" },
        { parent: cargoHome, basename: ".global-cache" },
      ];
    case "cook":
      return [{ parent: path.join(workloadDir, "target", "release"), basename: "deps" }];
    case "build":
      return [{ parent: path.dirname(zccacheDir), basename: path.basename(zccacheDir) }];
    case "target":
      return [{ parent: workloadDir, basename: "target" }];
    case "setup-cache":
      return [{ parent: path.dirname(setupCachePath), basename: path.basename(setupCachePath) }];
    case "all-on": {
      const acc = [];
      for (const name of LAYER_NAMES) {
        if (name === "baseline" || name === "all-on") continue;
        for (const p of pathsForLayer(name, opts)) {
          addDedupedPath(acc, p);
        }
      }
      return acc;
    }
    default:
      throw new Error(`pathsForLayer: unknown layer '${layer}'`);
  }
}

/**
 * Convert a toolchain snapshot diff into exact path tuples for the bench
 * driver. Removed entries are intentionally ignored: there is nothing to
 * archive from the post-install filesystem for them.
 *
 * @param {SnapshotDiff | undefined} delta
 * @returns {LayerPath[]}
 */
export function pathsForSoloToolchainDelta(delta) {
  if (!delta) return [];
  const acc = [];
  for (const entry of delta.added ?? []) addSnapshotEntryPath(acc, entry);
  for (const change of delta.changed ?? []) addSnapshotEntryPath(acc, change.after);
  return acc;
}

/**
 * @param {LayerPath[]} acc
 * @param {SnapshotEntry | undefined} entry
 */
function addSnapshotEntryPath(acc, entry) {
  if (!entry?.root || !entry.relpath) return;
  const relDir = path.dirname(entry.relpath);
  const parent = relDir === "." ? entry.root : path.join(entry.root, relDir);
  addDedupedPath(acc, { parent, basename: path.basename(entry.relpath) });
}

/**
 * Dedupe both exact duplicates and paths already covered by a parent tuple.
 * This keeps all-on from snapshotting target/deps separately when target is
 * already part of the layer set.
 *
 * @param {LayerPath[]} acc
 * @param {LayerPath} candidate
 */
function addDedupedPath(acc, candidate) {
  const candidateTarget = path.resolve(candidate.parent, candidate.basename);
  for (let i = 0; i < acc.length; i++) {
    const existingTarget = path.resolve(acc[i].parent, acc[i].basename);
    if (pathCovers(existingTarget, candidateTarget)) return;
    if (pathCovers(candidateTarget, existingTarget)) {
      acc.splice(i, 1);
      i--;
    }
  }
  acc.push(candidate);
}

/**
 * @param {string} parentTarget
 * @param {string} childTarget
 */
function pathCovers(parentTarget, childTarget) {
  if (parentTarget === childTarget) return true;
  const rel = path.relative(parentTarget, childTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Whether the layer is "active" — i.e. has any paths to snapshot. Baseline
 * is intentionally empty; the bench driver skips snapshot/restore for it.
 *
 * @param {string} layer
 */
export function isActiveLayer(layer) {
  return layer !== "baseline";
}
