// Release-readiness helpers shared by the action installer and the v0 rollout
// contract. A concrete version is always exact: retrying a just-published
// release is allowed, choosing a different release is not.

export const REQUIRED_RELEASE_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
] as const;

export type ReleasePayload = Record<string, unknown>;

function assetHasTarget(asset: unknown, target: string): boolean {
  if (typeof asset !== "object" || asset === null) return false;
  const record = asset as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"] : "";
  const url = typeof record["browser_download_url"] === "string" ? record["browser_download_url"].trim() : "";
  return (
    name.includes(target) &&
    (name.endsWith(".tar.zst") || name.endsWith(".tar.gz") || name.endsWith(".zip")) &&
    url.length > 0
  );
}

/** Throws when a release cannot safely become setup-soldr's default. */
export function assertReleaseReady(
  release: ReleasePayload,
  requiredTargets: readonly string[] = REQUIRED_RELEASE_TARGETS,
): void {
  const tag = typeof release["tag_name"] === "string" ? release["tag_name"].trim() : "";
  if (!tag) throw new Error("release payload has no tag_name");
  if (release["draft"] === true) throw new Error(`release ${tag} is still a draft`);

  const assets = release["assets"];
  if (!Array.isArray(assets)) throw new Error(`release ${tag} has no assets array`);
  const missing = requiredTargets.filter((target) => !assets.some((asset) => assetHasTarget(asset, target)));
  if (missing.length > 0) {
    throw new Error(`release ${tag} is missing usable assets for: ${missing.join(", ")}`);
  }
}

export function isRetryableReleaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/HTTP\s+(\d{3})\b/)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code === 404 || code >= 500;
}

export async function retryReleaseRequest<T>(
  request: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableReleaseError(error)) break;
      options.onRetry?.(attempt, error);
      await sleep(delayMs);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`release request failed after ${attempts} attempts: ${detail}`);
}
