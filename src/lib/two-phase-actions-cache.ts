import * as fsp from "node:fs/promises";
import { getCacheServiceVersion } from "@actions/cache/lib/internal/config.js";
import * as cacheHttpClient from "@actions/cache/lib/internal/cacheHttpClient.js";
import * as cacheUtils from "@actions/cache/lib/internal/cacheUtils.js";
import * as twirp from "@actions/cache/lib/internal/shared/cacheTwirpClient.js";

type CompressionMethod = Awaited<ReturnType<typeof cacheUtils.getCompressionMethod>>;

export interface ReservedCacheArchive {
  archivePath: string;
  archiveBytes: number;
  inflatedBytes?: number;
  fileCount?: number;
  sourceFiles?: number;
  deletedCacheFiles?: number;
  compressMs?: number;
}

export interface TwoPhaseCacheResult {
  status: "saved" | "skipped-reservation" | "failed";
  cacheId?: number;
  archive?: ReservedCacheArchive;
  error?: string;
}

export interface TwoPhaseCacheOptions {
  paths: string[];
  key: string;
  enableCrossOsArchive?: boolean;
  log?: (message: string) => void;
  produce: () => Promise<ReservedCacheArchive>;
  reserve?: () => Promise<Reservation | null>;
  upload?: (reservation: Reservation, archive: ReservedCacheArchive) => Promise<number | undefined>;
}

export interface Reservation {
  service: "v1" | "v2";
  compressionMethod: CompressionMethod;
  version?: string;
  cacheId?: number;
  signedUploadUrl?: string;
}

function log(options: TwoPhaseCacheOptions, message: string): void {
  options.log?.(`two-phase-cache: ${message}`);
}

async function reserve(options: TwoPhaseCacheOptions): Promise<Reservation | null> {
  const compressionMethod = await cacheUtils.getCompressionMethod();
  const enableCrossOsArchive = options.enableCrossOsArchive ?? false;
  if (getCacheServiceVersion() === "v2") {
    const version = cacheUtils.getCacheVersion(options.paths, compressionMethod, enableCrossOsArchive);
    const response = await twirp.internalCacheTwirpClient().CreateCacheEntry({
      key: options.key,
      version,
    });
    if (!response.ok || !response.signedUploadUrl) return null;
    return {
      service: "v2",
      compressionMethod,
      version,
      signedUploadUrl: response.signedUploadUrl,
    };
  }

  const response = await cacheHttpClient.reserveCache(options.key, options.paths, {
    compressionMethod,
    enableCrossOsArchive,
  });
  const cacheId = response.result?.cacheId;
  if (typeof cacheId !== "number") return null;
  return { service: "v1", compressionMethod, cacheId };
}

/**
 * Reserve an exact Actions cache key before producing the archive. The
 * producer is never called after a reservation conflict, which is the key
 * property missing from the public saveCache convenience API.
 */
export async function saveReservedCache(options: TwoPhaseCacheOptions): Promise<TwoPhaseCacheResult> {
  let reservation: Reservation | null;
  try {
    reservation = options.reserve ? await options.reserve() : await reserve(options);
  } catch (error) {
    log(options, `reservation failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "skipped-reservation" };
  }
  if (!reservation) {
    log(options, `reservation conflict for key=${options.key}`);
    return { status: "skipped-reservation" };
  }

  let archive: ReservedCacheArchive;
  try {
    archive = await options.produce();
  } catch (error) {
    log(options, `archive production failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (options.upload) {
      const cacheId = await options.upload(reservation, archive);
      return { status: "saved", cacheId, archive };
    }
    if (reservation.service === "v1") {
      await cacheHttpClient.saveCache(reservation.cacheId!, archive.archivePath, "", {
        archiveSizeBytes: archive.archiveBytes,
      });
      return { status: "saved", cacheId: reservation.cacheId, archive };
    }

    await cacheHttpClient.saveCache(-1, archive.archivePath, reservation.signedUploadUrl, {
      archiveSizeBytes: archive.archiveBytes,
      uploadChunkSize: 64 * 1024 * 1024,
      uploadConcurrency: 8,
      useAzureSdk: true,
    });
    const finalized = await twirp.internalCacheTwirpClient().FinalizeCacheEntryUpload({
      key: options.key,
      version: reservation.version!,
      sizeBytes: `${archive.archiveBytes}`,
    });
    if (!finalized.ok) throw new Error(finalized.message || "cache finalization failed");
    return { status: "saved", cacheId: Number.parseInt(finalized.entryId, 10), archive };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error), archive };
  } finally {
    await fsp.rm(archive.archivePath, { force: true }).catch(() => undefined);
  }
}

export function isReservationConflict(result: TwoPhaseCacheResult): boolean {
  return result.status === "skipped-reservation";
}
