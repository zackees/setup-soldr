// Python-default JSON serialization. Used for the toolchain signature
// digest that feeds the action's cache key — the legacy Python action
// used `json.dumps(value, sort_keys=True)` with default separators
// (", " between items, ": " between key/value, NOT compact). Hash
// stability across the Py→TS port requires byte-for-byte parity.

/**
 * Mirror Python's `json.dumps(value, sort_keys=True)` with default
 * separators. Exposed so the digest used in the action's setup-cache
 * key matches the legacy implementation exactly.
 */
export function pythonDefaultJson(value: unknown): string {
  return formatDefaultJson(value);
}

function formatDefaultJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatDefaultJson(item));
    return `[${parts.join(", ")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}: ${formatDefaultJson(obj[key])}`,
    );
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(value);
}
