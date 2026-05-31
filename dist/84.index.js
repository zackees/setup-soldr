"use strict";
exports.id = 84;
exports.ids = [84];
exports.modules = {

/***/ 18084:
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


// Wire `soldr load` into the cargo-registry-cache restore path on Windows
// runners where Defender's per-CreateFile scan + NTFS overhead dominate
// the wall clock for serial tar extraction. See zackees/setup-soldr#260
// and zackees/soldr#575.
//
// Strategy:
// - Detect the archive's first tar entry. If it's `SOLDR_MANIFEST.pb`,
//   the archive was produced by `soldr save` and we can use `soldr load`
//   for parallel extraction.
// - Otherwise fall through to the existing tar/zstd path so legacy
//   archives keep working.
//
// The detection avoids fully decompressing the archive — we only read
// the first ~2 KiB of decompressed bytes (one tar block of 512 bytes
// minimum, plus zstd frame slack).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CARGO_REGISTRY_VIA_SOLDR_ENV = exports.MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP = exports.MIN_SOLDR_VERSION_FOR_LOAD = void 0;
exports.cargoRegistryViaSoldrEnvOn = cargoRegistryViaSoldrEnvOn;
exports.semverGte = semverGte;
exports.detectSoldrManifest = detectSoldrManifest;
exports.tryLoadViaSoldr = tryLoadViaSoldr;
exports.trySaveViaSoldr = trySaveViaSoldr;
const fs = __importStar(__webpack_require__(51455));
const exec = __importStar(__webpack_require__(95236));
/** Min soldr version with parallel-extract `soldr load`. Released in 0.7.46 alongside zackees/soldr#575. */
exports.MIN_SOLDR_VERSION_FOR_LOAD = "0.7.46";
/**
 * Min soldr version safe to use for `soldr save`/`soldr load` round-trip
 * on cargo-registry cache. 0.7.47 includes zackees/soldr#591 (+x bit
 * preservation); 0.7.46 alone would corrupt executable cache files
 * (cargo `build-script-build` failed `execve` with EACCES). (#263)
 */
exports.MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP = "0.7.47";
/**
 * Env var that opts cargo-registry-cache into the `soldr save`/`soldr load`
 * round-trip. Default off so the v0.9.20 wire-in stays dormant and the
 * legacy tar+zstd path keeps running until #263's measurement validates
 * the Windows wall-clock improvement.
 */
exports.CARGO_REGISTRY_VIA_SOLDR_ENV = "SOLDR_CARGO_REGISTRY_VIA_SOLDR";
/** True when [[CARGO_REGISTRY_VIA_SOLDR_ENV]] is set to a truthy value. */
function cargoRegistryViaSoldrEnvOn() {
    const raw = (process.env[exports.CARGO_REGISTRY_VIA_SOLDR_ENV] ?? "").trim().toLowerCase();
    return raw !== "" && raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}
/** Filename of the manifest at the root of every `soldr save` archive. */
const SOLDR_MANIFEST_NAME = "SOLDR_MANIFEST.pb";
/** Parse a `MAJOR.MINOR.PATCH` prefix from a version string. */
function parseSemver(value) {
    const m = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/** Compare two semvers; `true` if `value >= minimum`. */
function semverGte(value, minimum) {
    const got = parseSemver(value);
    const want = parseSemver(minimum);
    if (!got || !want)
        return false;
    for (let i = 0; i < 3; i += 1) {
        if (got[i] > want[i])
            return true;
        if (got[i] < want[i])
            return false;
    }
    return true;
}
/**
 * Sniff whether the archive's first tar entry is `SOLDR_MANIFEST.pb`,
 * indicating a `soldr save` archive. Returns `false` on any read or
 * decode error — the caller should fall through to the legacy path.
 *
 * Uses synchronous `tar -tf` + `head -1` via `spawnSync` so the
 * subprocesses are guaranteed to be reaped before this function
 * returns (avoiding test-runner timeout from leaked descriptors).
 */
async function detectSoldrManifest(archivePath) {
    const { spawnSync } = await Promise.resolve(/* import() */).then(__webpack_require__.t.bind(__webpack_require__, 31421, 23));
    // We invoke tar with `-tf <archive>` directly — bsdtar (Windows) and
    // GNU tar (Linux/macOS) both auto-detect zstd by magic byte on modern
    // versions. Bounded by `timeout: 5000ms`; if tar takes longer than
    // that on a single header read, we treat the archive as not-soldr.
    let res;
    try {
        res = spawnSync("tar", ["-tf", archivePath], {
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 1024 * 1024,
        });
    }
    catch {
        return false;
    }
    if (res.error || res.status !== 0)
        return false;
    const first = (res.stdout ?? "").split(/\r?\n/, 2)[0]?.trim();
    return first === SOLDR_MANIFEST_NAME;
}
/**
 * Attempt to invoke `soldr load` for parallel extraction. Returns
 * `{ used: false }` when the binary isn't available, the version is
 * too old, or the archive isn't in soldr format. Throws only on a
 * genuine extraction failure (so the caller can decide to fall back).
 */
async function tryLoadViaSoldr(opts) {
    const t0 = Date.now();
    const noOp = { used: false, durationMs: 0 };
    const log = opts.log ?? (() => undefined);
    if (!opts.soldrPath) {
        if (opts.debug)
            log(`[debug] soldr-load-shim: no soldr binary path supplied`);
        return noOp;
    }
    if (!semverGte(opts.soldrVersion, exports.MIN_SOLDR_VERSION_FOR_LOAD)) {
        if (opts.debug) {
            log(`[debug] soldr-load-shim: soldr ${opts.soldrVersion} < ${exports.MIN_SOLDR_VERSION_FOR_LOAD}; falling back to tar+zstd`);
        }
        return noOp;
    }
    try {
        const st = await fs.stat(opts.archivePath);
        if (!st.isFile())
            return noOp;
    }
    catch {
        return noOp;
    }
    const isSoldrFormat = await detectSoldrManifest(opts.archivePath);
    if (!isSoldrFormat) {
        if (opts.debug) {
            log(`[debug] soldr-load-shim: ${opts.archivePath} is not a soldr-format archive (no SOLDR_MANIFEST.pb); falling back to tar+zstd`);
        }
        return noOp;
    }
    const args = ["load", "--archive", opts.archivePath, "--cache-dir", opts.targetDir];
    if (opts.autoDefenderExclude && process.platform === "win32") {
        args.push("--auto-defender-exclude");
    }
    if (opts.profileExtract) {
        args.push("--profile-extract");
    }
    if (opts.debug)
        log(`[debug] soldr-load-shim: invoking ${opts.soldrPath} ${args.join(" ")}`);
    await exec.exec(opts.soldrPath, args);
    return { used: true, durationMs: Date.now() - t0 };
}
/**
 * Attempt to bundle the cache directory via `soldr save` so the matching
 * `soldr load` (in main.ts) can pick up the parallel-extract path. Returns
 * `{ used: false }` when gated off (env var, missing binary, too-old
 * version, extras present, or any throw). Produces a soldr-format archive
 * with `SOLDR_MANIFEST.pb` at the root + `cache/...` entries. (#263)
 */
async function trySaveViaSoldr(opts) {
    const t0 = Date.now();
    const noOp = { used: false, archivePath: null, archiveBytes: 0, durationMs: 0 };
    const log = opts.log ?? (() => undefined);
    if (!cargoRegistryViaSoldrEnvOn()) {
        if (opts.debug) {
            log(`[debug] soldr-save-shim: ${exports.CARGO_REGISTRY_VIA_SOLDR_ENV} not set; deferring to legacy tar+zstd save`);
        }
        return noOp;
    }
    if (!opts.soldrPath) {
        if (opts.debug)
            log(`[debug] soldr-save-shim: no soldr binary path supplied`);
        return noOp;
    }
    if (!semverGte(opts.soldrVersion, exports.MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP)) {
        if (opts.debug) {
            log(`[debug] soldr-save-shim: soldr ${opts.soldrVersion} < ${exports.MIN_SOLDR_VERSION_FOR_SAVE_ROUNDTRIP}; falling back to legacy save`);
        }
        return noOp;
    }
    if (opts.extraBasenames && opts.extraBasenames.length > 0) {
        if (opts.debug) {
            log(`[debug] soldr-save-shim: extraBasenames=[${opts.extraBasenames.join(",")}] not yet supported by soldr save; falling back to legacy`);
        }
        return noOp;
    }
    try {
        const st = await fs.stat(opts.cacheDir);
        if (!st.isDirectory())
            return noOp;
    }
    catch {
        return noOp;
    }
    const args = [
        "save",
        "--cache-dir",
        opts.cacheDir,
        "--out",
        opts.archivePath,
    ];
    if (opts.debug)
        log(`[debug] soldr-save-shim: invoking ${opts.soldrPath} ${args.join(" ")}`);
    try {
        await exec.exec(opts.soldrPath, args);
    }
    catch (err) {
        if (opts.debug) {
            log(`[debug] soldr-save-shim: invocation threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        return noOp;
    }
    let archiveBytes = 0;
    try {
        archiveBytes = (await fs.stat(opts.archivePath)).size;
    }
    catch {
        // Soldr save claimed success but archive vanished — fall back.
        return noOp;
    }
    return { used: true, archivePath: opts.archivePath, archiveBytes, durationMs: Date.now() - t0 };
}


/***/ })

};
;