// Private decoder entrypoint. Run only in the source-free preparation sandbox.
import { decodeDataArchive } from "./lib/data-cache-decode.js";

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) {
  process.stderr.write("usage: data-cache-decode <archive.zst> <decoded.tar>\n");
  process.exitCode = 2;
} else {
  decodeDataArchive(input, output).catch((error: unknown) => {
    process.stderr.write(`data archive decoding failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
