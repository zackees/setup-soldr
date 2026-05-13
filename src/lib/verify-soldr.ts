// Soldr smoke-test. Owned by Agent 2.
//
// Port of .github/actions/setup-soldr/verify_soldr.py.
// Runs `soldr version --json` and asserts the binary is on PATH, returns
// the resolved version string for the action output.

import * as exec from "@actions/exec";
import { createLogger } from "./log-utils.js";

export interface VerifyResult {
  soldrVersion: string;
}

interface VersionTuple {
  major: number;
  minor: number;
  patch: number;
}

export function versionTuple(value: string): VersionTuple | null {
  const cleaned = value.trim().replace(/^v/, "");
  const parts = cleaned.split(".");
  if (parts.length < 3) return null;
  const major = parseInt(parts[0] ?? "", 10);
  const minor = parseInt(parts[1] ?? "", 10);
  const rawPatch = parts[2] ?? "";
  const patchStr = rawPatch.split("-", 1)[0] ?? "";
  const patch = parseInt(patchStr, 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
  return { major, minor, patch };
}

function compareVersions(a: VersionTuple, b: VersionTuple): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isTransientZccacheStatusFailure(combined: string): boolean {
  const lower = combined.toLowerCase();
  return lower.includes("zccache status failed") && lower.includes("daemon not running");
}

async function captureAll(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; combined: string }> {
  let stdout = "";
  let combined = "";
  const code = await exec.exec(command, args, {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data: Buffer) => {
        const s = data.toString("utf8");
        stdout += s;
        combined += s;
      },
      stderr: (data: Buffer) => {
        combined += data.toString("utf8");
      },
    },
  });
  return { code, stdout, combined };
}

export async function verifySoldr(opts: {
  soldrPath: string;
  buildCacheMode: string;
  requireRustPlan: boolean;
}): Promise<VerifyResult> {
  const logger = createLogger(process.env);
  const log = (msg: string): void => logger.log(msg);
  const { soldrPath, buildCacheMode, requireRustPlan } = opts;

  log(`Verifying soldr at ${soldrPath}`);
  const { code, stdout, combined } = await captureAll(soldrPath, ["version", "--json"]);
  if (code !== 0) {
    throw new Error(`soldr version --json failed (exit ${code}):\n${combined}`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`soldr version --json returned non-JSON output: ${(err as Error).message}`);
  }
  const soldrVersion = String(payload["soldr_version"] ?? "");
  if (!soldrVersion) {
    throw new Error("soldr version --json missing soldr_version field");
  }

  if (requireRustPlan) {
    const parsed = versionTuple(soldrVersion);
    const required: VersionTuple = { major: 0, minor: 7, patch: 10 };
    if (parsed === null || compareVersions(parsed, required) < 0) {
      throw new Error(
        `setup-soldr build-cache-mode ${JSON.stringify(buildCacheMode || "thin")} requires soldr v0.7.10 or newer for the zccache Rust artifact plan API; installed ${soldrVersion}.`,
      );
    }
  }

  // Smoke checks. cargo/rustc exit codes ignored — they're informational.
  await exec.exec("cargo", ["--version"], { ignoreReturnCode: true });
  await exec.exec("rustc", ["--version"], { ignoreReturnCode: true });

  log("+ soldr status --json");
  const status = await captureAll("soldr", ["status", "--json"]);
  if (status.code === 0) {
    if (status.stdout.trim()) {
      for (const line of status.stdout.split(/\r?\n/)) {
        if (line) log(line);
      }
    }
  } else if (!isTransientZccacheStatusFailure(status.combined)) {
    throw new Error(`soldr status --json failed (exit ${status.code}):\n${status.combined}`);
  }

  return { soldrVersion };
}
