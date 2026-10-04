// Decode untrusted cache data only in the credential-free preparation container.
// This file is bundled separately; it imports no action SDK or repository code.
import * as fs from "node:fs";
import { Decompress } from "fzstd";

export interface DecodedDataArchive {
  compressedBytes: number;
  inflatedBytes: number;
}

export async function decodeDataArchive(input: string, output: string, maxInflatedBytes = 8 * 1024 ** 3): Promise<DecodedDataArchive> {
  if (!Number.isSafeInteger(maxInflatedBytes) || maxInflatedBytes <= 0) {
    throw new Error("invalid data archive inflation bound");
  }
  const metadata = fs.lstatSync(input);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 209_715_200) {
    throw new Error("data archive must be a bounded regular file");
  }
  const destination = fs.openSync(output, "wx", 0o600);
  let inflatedBytes = 0;
  let compressedBytes = 0;
  const decoder = new Decompress((chunk) => {
    if (chunk.length > maxInflatedBytes - inflatedBytes) {
      throw new Error("data archive exceeds inflation bound");
    }
    inflatedBytes += chunk.length;
    for (let offset = 0; offset < chunk.length;) {
      const written = fs.writeSync(destination, chunk, offset, chunk.length - offset);
      if (written <= 0) throw new Error("data archive output made no progress");
      offset += written;
    }
  });
  try {
    for await (const chunk of fs.createReadStream(input)) {
      if (chunk.length > 209_715_200 - compressedBytes) throw new Error("data archive exceeds compressed bound");
      compressedBytes += chunk.length;
      decoder.push(chunk, false);
    }
    if (compressedBytes !== metadata.size) throw new Error("data archive changed during decoding");
    decoder.push(new Uint8Array(), true);
    return { compressedBytes, inflatedBytes };
  } finally {
    fs.closeSync(destination);
  }
}
