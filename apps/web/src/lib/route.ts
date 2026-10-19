export type Route =
  | { name: "runs" }
  | { name: "new" }
  | { name: "run"; id: string; issue?: string }
  | { name: "map"; id: string };

/** `#/` -> runs list, `#/runs/<id>?issue=<issueId>` -> inspector. */
export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  if (path === "/new") return { name: "new" };
  const map = /^\/runs\/([^/]+)\/map$/.exec(path);
  if (map) return { name: "map", id: decodeURIComponent(map[1]!) };
  const match = /^\/runs\/([^/]+)$/.exec(path);
  if (!match) return { name: "runs" };
  const issue = new URLSearchParams(query).get("issue") ?? undefined;
  return { name: "run", id: decodeURIComponent(match[1]!), issue };
}

export function runHash(id: string, issue?: string): string {
  const base = `#/runs/${encodeURIComponent(id)}`;
  return issue ? `${base}?issue=${encodeURIComponent(issue)}` : base;
}

export function mapHash(id: string): string {
  return `#/runs/${encodeURIComponent(id)}/map`;
}
