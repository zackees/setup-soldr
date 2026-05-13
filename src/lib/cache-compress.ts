// Tar+zstd cache compression helpers. Owned by Agent 2.
//
// Used by src/main.ts (restore: auto-detect .tar.zst, decompress in place)
// and src/post.ts (save: tar+zstd the cache dir).
//
// Acceptance criterion #1 + #2 of zackees/setup-soldr#70: post-job tar+zstd
// at level configured by target-cache-compress-level, restore auto-detects
// zstd vs gzip magic bytes for back-compat.

export type CompressMagic = "zstd" | "gzip" | "unknown";

/**
 * Read the first 4 bytes of a file and identify the compression codec.
 *   zstd:  0x28 B5 2F FD
 *   gzip:  0x1F 8B
 */
export async function detectCompressMagic(path: string): Promise<CompressMagic> {
  void path;
  throw new Error("not implemented: detectCompressMagic");
}

/**
 * Decompress <cache-dir>.tar.zst (or .tar.gz) into <cache-dir>.
 */
export async function decompressCache(opts: { archivePath: string; targetDir: string }): Promise<void> {
  void opts;
  throw new Error("not implemented: decompressCache");
}

/**
 * tar -cf - <cache-dir> | zstd -T0 -<level> > <cache-dir>.tar.zst
 */
export async function compressCache(opts: {
  cacheDir: string;
  codec: "auto" | "zstd" | "none";
  level: string;
}): Promise<string | null> {
  void opts;
  throw new Error("not implemented: compressCache");
}
