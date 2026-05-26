// Type declarations for bench-paths.mjs. Lives alongside the .mjs so TS's
// Node16 module resolution finds it for both the unit test and any future
// TS consumer. Keep in sync with the JSDoc + exports in bench-paths.mjs.

export const LAYER_NAMES: ReadonlyArray<string>;

export interface LayerPath {
  parent: string;
  basename: string;
}

export interface PathsForLayerOpts {
  env?: NodeJS.ProcessEnv;
  workloadDir?: string;
}

export function pathsForLayer(layer: string, opts?: PathsForLayerOpts): LayerPath[];

export function isActiveLayer(layer: string): boolean;
