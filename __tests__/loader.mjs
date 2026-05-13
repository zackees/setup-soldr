// Custom Node ESM resolve hook: when a relative `.js` import resolves to a
// missing file but a sibling `.ts` exists, rewrite the specifier to the
// `.ts` file. Enables `node --test --experimental-strip-types` to walk our
// source graph where TypeScript ESM imports use `.js` extensions.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolve(specifier, context, nextResolve) {
  if (
    typeof specifier === "string" &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js")
  ) {
    try {
      const parentURL = context.parentURL;
      if (parentURL && parentURL.startsWith("file:")) {
        const parentPath = fileURLToPath(parentURL);
        const parentDir = path.dirname(parentPath);
        const tsPath = path.resolve(parentDir, specifier.replace(/\.js$/, ".ts"));
        if (existsSync(tsPath) && statSync(tsPath).isFile()) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
      }
    } catch {
      // fall through to default resolution
    }
  }
  return nextResolve(specifier, context);
}
