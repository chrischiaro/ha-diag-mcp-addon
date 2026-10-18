import fs from "node:fs";
import path from "node:path";

/**
 * Read-only mode for a second, separately-exposed instance of the server.
 *
 * READ_ONLY=true makes the process:
 *   - skip the write tools (ha_write_file, ha_replace_in_file, ha_call_service) so they are never advertised,
 *   - refuse the /fs/write and /fs/replace routes,
 *   - serve /fs/read, /fs/find and /fs/grep only for an allow-listed set of paths under /config,
 *     after resolving symlinks, and never for hidden or secrets files.
 *
 * Nothing here is a substitute for a separate token and network exposure; see README "Read-only instance".
 */

export const READ_ONLY = /^(1|true|yes|on)$/i.test((process.env.READ_ONLY ?? "").trim());

/** Tools that change anything (files or Home Assistant state). Not registered in read-only mode. */
export const WRITE_TOOLS = new Set(["ha_write_file", "ha_replace_in_file", "ha_call_service"]);

// Top-level entries under /config that read-only callers may reach. Directories allow everything below them
// (still subject to the deny rules). Extend with READ_ONLY_EXTRA_PATHS (comma-separated, relative to /config).
const DEFAULT_ALLOWED = [
  "configuration.yaml",
  "automations.yaml",
  "scripts.yaml",
  "scenes.yaml",
  "groups.yaml",
  "customize.yaml",
  "ui-lovelace.yaml",
  "home-assistant.log",
  "home-assistant.log.1",
  "packages",
  "blueprints",
  "custom_components",
  "dashboards",
  "esphome",
];

export type PolicyResult =
  | { ok: true; real: string; rel: string }
  | { ok: false; status: number; error: string };

const DENIED: PolicyResult = { ok: false, status: 403, error: "Access denied: path is not available in read-only mode" };

export function createReadPolicy(root = "/config", extra: string[] = []) {
  const allowed = new Set([...DEFAULT_ALLOWED, ...extra.map((s) => s.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean)]);

  /** Decide on a path relative to the real config root ("" is the root itself). */
  function allowedRel(rel: string, opts: { allowRoot?: boolean } = {}): boolean {
    if (rel === "") return !!opts.allowRoot;
    const segs = rel.split(path.sep);
    if (segs.some((s) => s === ".." || s.startsWith("."))) return false; // .storage, .cloud, .git, .ssh, ...
    const base = segs[segs.length - 1];
    if (/^secrets.*\.ya?ml$/i.test(base)) return false; // secrets.yaml anywhere (also in packages/ or esphome/)
    if (/\.(key|pem|crt|p12|pfx|db|db-wal|db-shm)$/i.test(base)) return false;
    return allowed.has(segs[0]);
  }

  /**
   * Resolve a caller-supplied path to a real path and check it. Symlinks are resolved first, so a link inside an
   * allowed directory that points at secrets.yaml or outside /config is refused. Missing files give the same
   * answer as denied ones so the response does not reveal what exists.
   */
  function resolve(input: unknown, opts: { allowRoot?: boolean } = {}): PolicyResult {
    if (typeof input !== "string" || input.includes("\0")) return DENIED;
    let realRoot: string;
    let real: string;
    try {
      realRoot = fs.realpathSync(root);
      const normalized = path.normalize(input);
      const lexicalOk = normalized === root || normalized.startsWith(root + "/");
      if (!lexicalOk) return DENIED;
      real = fs.realpathSync(normalized);
    } catch {
      return DENIED;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return DENIED;
    const rel = path.relative(realRoot, real);
    if (!allowedRel(rel, opts)) return DENIED;
    return { ok: true, real, rel };
  }

  return { resolve, allowedRel };
}

export const readPolicy = createReadPolicy(
  "/config",
  (process.env.READ_ONLY_EXTRA_PATHS ?? "").split(",")
);

/** Regexes run on the event loop; keep patterns short on the public instance. */
export const MAX_READ_ONLY_PATTERN_LENGTH = 200;
