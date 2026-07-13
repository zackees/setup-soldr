import { readFileSync } from "node:fs";

const requiredTargets = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
];

const action = readFileSync("action.yml", "utf8");
const version = action.match(/^  version:\r?\n[\s\S]*?^    default:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
if (!version) throw new Error("could not read inputs.version default from action.yml");

const tag = version.startsWith("v") ? version : `v${version}`;
const response = await fetch(`https://api.github.com/repos/zackees/soldr/releases/tags/${tag}`, {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "setup-soldr-release-readiness" },
});
if (!response.ok) throw new Error(`default release ${tag} returned HTTP ${response.status}`);
const release = await response.json();
if (release.draft) throw new Error(`default release ${tag} is a draft`);
if (!Array.isArray(release.assets)) throw new Error(`default release ${tag} has no assets array`);

const missing = requiredTargets.filter((target) => !release.assets.some((asset) => {
  const name = typeof asset?.name === "string" ? asset.name : "";
  const url = typeof asset?.browser_download_url === "string" ? asset.browser_download_url.trim() : "";
  return name.includes(target) && /\.(tar\.zst|tar\.gz|zip)$/.test(name) && url;
}));
if (missing.length > 0) throw new Error(`default release ${tag} lacks usable assets: ${missing.join(", ")}`);

console.log(`Release readiness passed for ${tag} (${requiredTargets.length} supported targets).`);
