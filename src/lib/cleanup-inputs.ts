export function parseBooleanInput(name: string, raw: string, defaultValue: boolean): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`invalid '${name}' input: '${raw}'. Expected true or false.`);
}

export function parseOptionalSeconds(name: string, raw: string): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid '${name}' input: '${raw}'. Expected a non-negative integer.`);
  }
  return Number(value);
}
