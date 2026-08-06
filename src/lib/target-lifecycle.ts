import * as path from "node:path";

export interface TargetLifecycleContract {
  schemaVersion: number;
  canonicalTarget: string;
  cacheIdentity: string;
  supportedOperations: string[];
  environment: Record<string, string>;
  toolchain: Record<string, unknown>;
  platform: Record<string, unknown>;
}

export interface TargetHooks {
  build: string;
  clippy: string;
  testNoRun: string;
  pep517Wheel: string;
  pep517Sdist: string;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Convert Soldr's snake-case JSON into setup-soldr's stable output contract. */
export function normalizeTargetPlan(fallbackTarget: string, raw: unknown): TargetLifecycleContract {
  const root = objectRecord(raw);
  const targetPlan = objectRecord(root["target_plan"]);
  const target = String(targetPlan["canonical_target"] ?? root["rust_triple"] ?? fallbackTarget).trim();
  const supported = Array.isArray(targetPlan["supported_operations"])
    ? targetPlan["supported_operations"].filter((v): v is string => typeof v === "string")
    : [];
  return {
    schemaVersion: Number(targetPlan["schema_version"] ?? root["schema_version"] ?? 1),
    canonicalTarget: target,
    cacheIdentity: String(targetPlan["cache_identity"] ?? target),
    supportedOperations: supported,
    environment: stringRecord(root["env"]),
    toolchain: objectRecord(targetPlan["toolchain"]),
    platform: objectRecord(targetPlan["platform"]),
  };
}

const FLAG_SUFFIXES = ["_RUSTFLAGS", "_CFLAGS", "_CXXFLAGS", "_LDFLAGS"];

/** Merge target-scoped flags without discarding project-provided flags. */
export function mergeTargetEnvironment(
  existing: Record<string, string | undefined>,
  planned: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(existing).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  for (const [key, value] of Object.entries(planned)) {
    const prior = existing[key]?.trim() ?? "";
    const next = value.trim();
    if (FLAG_SUFFIXES.some((suffix) => key.endsWith(suffix)) && prior && next) {
      merged[key] = `${prior} ${next}`;
    } else {
      merged[key] = next || prior;
    }
  }
  return merged;
}

export function buildTargetHooks(target: string): TargetHooks {
  const canonical = target.trim();
  return {
    build: `soldr build --target ${canonical}`,
    clippy: `soldr cargo clippy --target ${canonical}`,
    testNoRun: `soldr cargo test --no-run --target ${canonical}`,
    pep517Wheel: "python -m build --wheel",
    pep517Sdist: "python -m build --sdist",
  };
}

export function targetArtifactDirectory(workspace: string, target: string): string {
  return path.join(workspace, "target", target);
}
