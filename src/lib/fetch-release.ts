// GitHub release-tag resolution. Split out of resolve-setup.ts so the
// orchestrator module doesn't carry HTTP/auth wiring. The default
// fetcher hits the GitHub REST API; tests inject a stub via
// `ResolveSetupDeps.fetchReleaseTag`.

import type { SystemRustupProbeDeps } from "./toolchain.js";
import type { ToolchainSpec } from "./types.js";

/**
 * Optional injectable dependencies for tests. Production code uses defaults.
 */
export interface ResolveSetupDeps {
  fetchReleaseTag?: (repo: string, version: string, env: Record<string, string | undefined>) => Promise<string>;
  systemRustup?: SystemRustupProbeDeps;
  systemRustupOverride?: (
    cargoHome: string,
    rustupHome: string,
    toolchain: ToolchainSpec,
  ) => Promise<boolean> | boolean;
}

export async function fetchReleaseTagDefault(
  repo: string,
  version: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (version) {
    // For explicit (non-latest) versions, return as-is. Caller normalizes.
    return "";
  }
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "setup-soldr-action",
  };
  const token = (env["GITHUB_TOKEN"] ?? "").trim() || (env["INPUT_TOKEN"] ?? "").trim();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GitHub API returned HTTP ${response.status} for ${repo}`);
    }
    const payload = (await response.json()) as unknown;
    if (typeof payload !== "object" || payload === null) {
      throw new Error(`unexpected GitHub release payload for ${repo}`);
    }
    const tag = (payload as Record<string, unknown>)["tag_name"];
    const tagName = typeof tag === "string" ? tag.trim() : "";
    if (!tagName) {
      throw new Error(`failed to resolve latest soldr release tag from ${repo}`);
    }
    return tagName;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveSoldrReleaseVersion(
  repo: string,
  version: string,
  ref: string,
  env: Record<string, string | undefined>,
  deps?: ResolveSetupDeps,
): Promise<string> {
  if (ref.trim()) {
    return "";
  }
  const requested = version.trim();
  if (requested && requested.toLowerCase() !== "latest") {
    return requested.startsWith("v") ? requested : `v${requested}`;
  }
  const fetcher = deps?.fetchReleaseTag ?? fetchReleaseTagDefault;
  const tagName = await fetcher(repo, "", env);
  if (!tagName) {
    throw new Error(`failed to resolve latest soldr release tag from ${repo}`);
  }
  return tagName;
}
