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
 * Resolve the on-disk paths for a given layer.
 *
 * @param {string} layer
 * @param {{env?: NodeJS.ProcessEnv, workloadDir?: string}} [opts]
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
      return [{ parent: workloadDir, basename: "target" }];
    case "build":
      return [{ parent: path.dirname(zccacheDir), basename: path.basename(zccacheDir) }];
    case "target":
      return [{ parent: workloadDir, basename: "target" }];
    case "setup-cache":
      return [{ parent: path.dirname(setupCachePath), basename: path.basename(setupCachePath) }];
    case "all-on": {
      const seen = new Set();
      const acc = [];
      for (const name of LAYER_NAMES) {
        if (name === "baseline" || name === "all-on") continue;
        for (const p of pathsForLayer(name, opts)) {
          const key = `${p.parent}::${p.basename}`;
          if (seen.has(key)) continue;
          seen.add(key);
          acc.push(p);
        }
      }
      return acc;
    }
    default:
      throw new Error(`pathsForLayer: unknown layer '${layer}'`);
  }
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
