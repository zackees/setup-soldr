// Base URL for GitHub REST calls. Honors GITHUB_API_URL (set by GitHub
// Actions, GHES, act, and bosn's read-only API proxy, which may carry a path
// prefix such as http://127.0.0.1:<port>/<secret-path>). The path is joined
// onto the base rather than assuming the base is a bare origin.
export function githubApiUrl(apiPath: string, env: Record<string, string | undefined> = process.env): string {
  const base = ((env["GITHUB_API_URL"] ?? "").trim() || "https://api.github.com").replace(/\/+$/, "");
  return `${base}/${apiPath.replace(/^\/+/, "")}`;
}
