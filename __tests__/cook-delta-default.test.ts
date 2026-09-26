import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { restoreLayeredCookCacheArchives, selectCookSaveLayer } from "../src/lib/cook-cache.js";

// #528: the cook delta layer (`cook-delta-v2-*`) is off by default. The base
// layer (`cook-base-v2-*`) must keep restoring and saving.

function inputDefault(actionYml: string, name: string): string | null {
  const text = fs.readFileSync(actionYml, "utf8");
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start === -1) return null;
  const m = /\n    default: "([^"]*)"/.exec(text.slice(start + 1));
  return m ? m[1]! : null;
}

test("#528 cook-delta input defaults to false on the main and cook actions", () => {
  assert.equal(inputDefault("action.yml", "cook-delta"), "false");
  assert.equal(inputDefault("cook/action.yml", "cook-delta"), "false");
  // Cook itself stays on by default.
  assert.equal(inputDefault("action.yml", "prebuild-deps"), "soldr-cook");
});

test("#528 save-layer selection: base still saves, delta only when enabled", () => {
  assert.equal(selectCookSaveLayer(true, false, false), "base");
  assert.equal(selectCookSaveLayer(true, true, false), "none");
  assert.equal(selectCookSaveLayer(false, false, false), "none");
  assert.equal(selectCookSaveLayer(true, false, true), "base");
  assert.equal(selectCookSaveLayer(true, true, true), "delta");
});

async function restoreWith(deltaEnabled: boolean | undefined) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cook-delta-default-"));
  const looked: string[] = [];
  try {
    const result = await restoreLayeredCookCacheArchives({
      baseKey: "cook-base-v2-exact",
      deltaKey: "cook-delta-v2-exact",
      deltaRestoreKeys: ["cook-delta-v2-"],
      baseArchivePath: path.join(root, "base.tar.zst"),
      deltaArchivePath: path.join(root, "delta.tar.zst"),
      ...(deltaEnabled === undefined ? {} : { deltaEnabled }),
      log: () => {},
      restoreCache: async (paths, key) => {
        looked.push(key);
        fs.writeFileSync(paths[0]!, Buffer.from("payload"));
        return key;
      },
    });
    return { result, looked };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("#528 deltaEnabled=false restores only the base layer", async () => {
  const { result, looked } = await restoreWith(false);
  assert.deepEqual(looked, ["cook-base-v2-exact"]);
  assert.equal(result.base.hit, true);
  assert.equal(result.delta.hit, false);
  assert.equal(result.delta.matchedKey, "");
});

test("#528 deltaEnabled=true keeps the base+delta restore", async () => {
  const { result, looked } = await restoreWith(true);
  assert.deepEqual([...looked].sort(), ["cook-base-v2-exact", "cook-delta-v2-exact"]);
  assert.equal(result.delta.hit, true);
});

test("#528 both actions wire cook-delta into restore and save selection", () => {
  const main = fs.readFileSync("src/main.ts", "utf8");
  assert.match(main, /inputs\.cookDelta/);
  assert.match(main, /deltaEnabled: cookDeltaEnabled/);
  assert.match(main, /selectCookSaveLayer\(cookRan, baseReady, cookDeltaEnabled\)/);
  const cook = fs.readFileSync("src/cook.ts", "utf8");
  assert.match(cook, /parseBooleanInput\("cook-delta", core\.getInput\("cook-delta"\), false\)/);
  assert.match(cook, /deltaEnabled: cookDelta/);
  assert.match(cook, /selectDeferredCookSaveLayer\(cookRan, baseReady, saveCache, cookDelta\)/);
});
