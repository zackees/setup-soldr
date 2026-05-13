// Preload hook: register the .js -> .ts resolve loader so node --test can
// follow our TypeScript ESM source graph without ahead-of-time compilation.
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
