import crypto from "node:crypto";
/**
 * Bearer-token auth and CORS allow-list helpers for the HTTP server.
 *
 * Server side: AUTH_TOKEN (set from the add-on option `auth_token`) is required.
 * Client side (proxy, and the tools' calls back into this server): HA_DIAG_AUTH_TOKEN,
 * falling back to AUTH_TOKEN when running inside the add-on itself.
 */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
// Constant-time comparison. Hashing first makes both buffers 32 bytes so timingSafeEqual never throws
// on a length mismatch and the token length is not leaked.
export function safeEqual(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}
export function extractBearer(header) {
    if (!header)
        return null;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
    return m ? m[1] : null;
}
/** Paths reachable without a token. Everything else (including routes added later) requires it. */
export const PUBLIC_PATHS = new Set(["/", "/health"]);
export function requireBearerToken(expectedToken, warn = () => { }) {
    const expected = expectedToken?.trim() || undefined;
    return (req, res, next) => {
        if (PUBLIC_PATHS.has(req.path))
            return next();
        // CORS preflight requests never carry credentials; the cors middleware answers them.
        if (req.method === "OPTIONS")
            return next();
        if (!expected) {
            // Fail closed: no token configured means no access, rather than open access.
            res.status(503).json({ error: "Server is not configured: set the add-on option `auth_token`." });
            return;
        }
        const provided = extractBearer(req.header("authorization"));
        if (!provided || !safeEqual(provided, expected)) {
            warn(`auth rejected: ${req.method} ${req.path} from ${req.ip} (${provided ? "wrong token" : "no bearer token"})`);
            res.set("WWW-Authenticate", 'Bearer realm="ha-diag-mcp"').status(401).json({ error: "Unauthorized" });
            return;
        }
        next();
    };
}
/**
 * ALLOW_ORIGIN is a comma-separated list of exact origins (e.g. "https://app.example.com").
 * Empty means no cross-origin browser access. A wildcard is ignored on purpose.
 */
export function parseAllowedOrigins(raw) {
    const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const wildcardIgnored = parts.includes("*");
    return { origins: parts.filter((p) => p !== "*"), wildcardIgnored };
}
/** Headers for calls to this server's own /fs/* endpoints (used by the tools and by clients). */
export function addonHeaders() {
    const headers = { "Content-Type": "application/json" };
    const token = (process.env.HA_DIAG_AUTH_TOKEN || process.env.AUTH_TOKEN || "").trim();
    if (token)
        headers["Authorization"] = `Bearer ${token}`;
    return headers;
}
