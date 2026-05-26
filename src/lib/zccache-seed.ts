import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";

const LOCAL_DIR_ENV = "SOLDR_ZCCACHE_LOCAL_DIR";
const VENDOR_DIR_ENV = "SETUP_SOLDR_ZCCACHE_VENDOR_DIR";
const SEED_ENV = "SETUP_SOLDR_ZCCACHE_SEEDED";
const SEED_SOURCE_ENV = "SETUP_SOLDR_ZCCACHE_SEED_SOURCE";

export interface ZccacheHostTarget {
  target: string;
  archiveTarget: string;
  binaryExt: string;
  archiveExt: "tar.gz" | "zip";
}

export interface SeedZccacheOptions {
  soldrPath: string;
  actionRoot: string;
  enabled: boolean;
  strict: boolean;
  log: (msg: string) => void;
  warn?: (msg: string) => void;
  execFn?: typeof exec.exec;
  downloadFn?: typeof downloadManagedRelease;
  env?: NodeJS.ProcessEnv;
}

interface InstallStatus {
  managedVersion: string;
  pinnedPresent: boolean;
  driftFromManaged: boolean;
}

interface CapturedExec {
  code: number;
  stdout: string;
  stderr: string;
}

function normalizeArch(arch: string): string {
  if (arch === "x64") return "x86_64";
  if (arch === "arm64") return "aarch64";
  throw new Error(`unsupported architecture for zccache seed: ${arch}`);
}

export function detectHostZccacheTarget(
  platform: NodeJS.Platform = process.platform,
  archValue = process.arch,
): ZccacheHostTarget {
  const arch = normalizeArch(archValue);
  if (platform === "win32") {
    return {
      target: `${arch}-pc-windows-msvc`,
      archiveTarget: `${arch}-pc-windows-msvc`,
      binaryExt: ".exe",
      archiveExt: "zip",
    };
  }
  if (platform === "darwin") {
    return {
      target: `${arch}-apple-darwin`,
      archiveTarget: `${arch}-apple-darwin`,
      binaryExt: "",
      archiveExt: "tar.gz",
    };
  }
  if (platform === "linux") {
    // zccache publishes musl Linux archives; they are the portable host
    // binary used by soldr on GNU runners too.
    return {
      target: `${arch}-unknown-linux-gnu`,
      archiveTarget: `${arch}-unknown-linux-musl`,
      binaryExt: "",
      archiveExt: "tar.gz",
    };
  }
  throw new Error(`unsupported platform for zccache seed: ${platform}`);
}

function requiredBinaryNames(binaryExt: string): string[] {
  return ["zccache", "zccache-daemon", "zccache-fp"].map((name) => `${name}${binaryExt}`);
}

export function hasRequiredZccacheBinaries(dir: string, binaryExt: string): boolean {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  return requiredBinaryNames(binaryExt).every((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function findVendoredZccacheDir(opts: {
  actionRoot: string;
  target: ZccacheHostTarget;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = opts.env ?? process.env;
  const explicit = (env[VENDOR_DIR_ENV] ?? "").trim();
  const roots = uniqueStrings([
    explicit,
    path.join(opts.actionRoot, "vendor", "zccache", opts.target.target),
    path.join(opts.actionRoot, "vendor", "zccache", opts.target.archiveTarget),
    path.join(opts.actionRoot, "zccache", "vendor", opts.target.target),
    path.join(opts.actionRoot, "zccache", "vendor", opts.target.archiveTarget),
  ]);

  for (const root of roots) {
    for (const candidate of uniqueStrings([root, path.join(root, "bin")])) {
      if (hasRequiredZccacheBinaries(candidate, opts.target.binaryExt)) {
        return candidate;
      }
    }
  }
  return null;
}

export function managedReleaseUrl(version: string, target: ZccacheHostTarget): string {
  const normalized = version.trim().replace(/^v/i, "");
  const asset = `zccache-v${normalized}-${target.archiveTarget}.${target.archiveExt}`;
  return `https://github.com/zackees/zccache/releases/download/${normalized}/${asset}`;
}

export async function downloadManagedRelease(
  url: string,
  target: ZccacheHostTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const runnerTemp = env["RUNNER_TEMP"]?.trim() || os.tmpdir();
  const tempDir = fs.mkdtempSync(path.join(runnerTemp, "setup-soldr-zccache-"));
  const suffix = target.archiveExt === "zip" ? ".zip" : ".tar.gz";
  const archivePath = path.join(tempDir, `zccache-managed${suffix}`);
  return await tc.downloadTool(url, archivePath);
}

async function runCaptured(
  execFn: typeof exec.exec,
  command: string,
  args: string[],
): Promise<CapturedExec> {
  let stdout = "";
  let stderr = "";
  const code = await execFn(command, args, {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString("utf8");
      },
      stderr: (data: Buffer) => {
        stderr += data.toString("utf8");
      },
    },
  });
  return { code, stdout, stderr };
}

function parseInstallStatus(stdout: string): InstallStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const payload = parsed as Record<string, unknown>;
  const managedVersion = payload["managed_version"];
  if (typeof managedVersion !== "string" || !managedVersion.trim()) return null;
  return {
    managedVersion,
    pinnedPresent: payload["pinned"] !== null && payload["pinned"] !== undefined,
    driftFromManaged: payload["drift_from_managed"] === true,
  };
}

async function readInstallStatus(
  soldrPath: string,
  execFn: typeof exec.exec,
): Promise<InstallStatus | null> {
  const result = await runCaptured(execFn, soldrPath, ["install-zccache", "--status", "--json"]);
  if (result.code !== 0) return null;
  return parseInstallStatus(result.stdout);
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? (err.message || String(err)) : String(err);
}

export async function seedZccache(opts: SeedZccacheOptions): Promise<void> {
  const warn = opts.warn ?? ((msg: string): void => core.warning(msg));
  const execFn = opts.execFn ?? exec.exec;
  const downloadFn = opts.downloadFn ?? downloadManagedRelease;
  const env = opts.env ?? process.env;
  const failOrWarn = (message: string): void => {
    if (opts.strict) {
      throw new Error(message);
    }
    warn(message);
  };

  if (!opts.enabled) {
    opts.log("zccache-seed: skipped - setup-soldr passthrough mode");
    return;
  }
  if ((env[LOCAL_DIR_ENV] ?? "").trim()) {
    opts.log(`zccache-seed: skipped - ${LOCAL_DIR_ENV} already set`);
    return;
  }

  let target: ZccacheHostTarget;
  try {
    target = detectHostZccacheTarget();
  } catch (err) {
    failOrWarn(`setup-soldr: zccache seed skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const status = await readInstallStatus(opts.soldrPath, execFn);
  if (status?.pinnedPresent && !status.driftFromManaged) {
    opts.log(`zccache-seed: existing pinned zccache matches managed ${status.managedVersion}`);
    core.exportVariable(SEED_ENV, "true");
    core.exportVariable(SEED_SOURCE_ENV, "pinned-existing");
    return;
  }

  const vendored = findVendoredZccacheDir({ actionRoot: opts.actionRoot, target, env });
  const managedUrl = status ? managedReleaseUrl(status.managedVersion, target) : "";
  if (!vendored && !managedUrl) {
    failOrWarn("setup-soldr: zccache seed failed: could not determine managed zccache version");
    return;
  }

  const sourceKind = vendored ? "vendored" : "managed-release";
  let tempRoot = "";
  let source = vendored ?? "";
  try {
    if (!source) {
      opts.log(`zccache-seed: downloading managed zccache release ${managedUrl}`);
      try {
        source = await downloadFn(managedUrl, target, env);
      } catch (err) {
        const detail = errorDetail(err);
        failOrWarn(
          opts.strict
            ? "setup-soldr: zccache seed failed; refusing to continue because the managed " +
                "zccache release could not be downloaded and later isolated SOLDR_CACHE_DIR roots " +
                "would fall back to cargo-installing zccache" +
                (detail ? `: ${detail}` : "")
            : "setup-soldr: zccache seed failed; managed zccache release could not be downloaded; " +
                "later isolated SOLDR_CACHE_DIR roots may fetch zccache again" +
                (detail ? `: ${detail}` : ""),
        );
        return;
      }
      tempRoot = path.dirname(source);
    }

    opts.log(`zccache-seed: installing pinned zccache from ${sourceKind} source ${source}`);
    let install: CapturedExec;
    try {
      install = await runCaptured(execFn, opts.soldrPath, ["install-zccache", source, "--json"]);
    } catch (err) {
      const detail = errorDetail(err);
      failOrWarn(
        opts.strict
          ? "setup-soldr: zccache seed failed; refusing to continue because pinned zccache " +
              "installation errored and later isolated SOLDR_CACHE_DIR roots would fall back to " +
              "cargo-installing zccache" +
              (detail ? `: ${detail}` : "")
          : "setup-soldr: zccache seed failed; pinned zccache installation errored; later isolated " +
              "SOLDR_CACHE_DIR roots may fetch zccache again" +
              (detail ? `: ${detail}` : ""),
      );
      return;
    }
    if (install.code !== 0) {
      const detail = (install.stderr || install.stdout).trim();
      failOrWarn(
        opts.strict
          ? "setup-soldr: zccache seed failed; refusing to continue because later isolated " +
              "SOLDR_CACHE_DIR roots would fall back to cargo-installing zccache" +
              (detail ? `: ${detail}` : "")
          : "setup-soldr: zccache seed failed; later isolated SOLDR_CACHE_DIR roots may fetch zccache again" +
              (detail ? `: ${detail}` : ""),
      );
      return;
    }
  } finally {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
  core.exportVariable(SEED_ENV, "true");
  core.exportVariable(SEED_SOURCE_ENV, sourceKind);
  opts.log(`zccache-seed: pinned zccache installed from ${sourceKind}`);
}
