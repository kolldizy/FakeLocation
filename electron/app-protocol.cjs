/**
 * Renderer asset server for the `app://` scheme, kept free of any `electron`
 * import so it can be unit-tested with plain Node.
 *
 * The only privileged thing this module does is decide which file inside
 * `renderer/` answers a request. Everything outside that directory is refused,
 * including paths that try to escape with `..`, absolute paths, encoded
 * separators or a Windows drive letter.
 */

const fs = require("node:fs");
const path = require("node:path");

const APP_SCHEME = "app";
const APP_HOST = "bundle";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Privilege flags passed to `protocol.registerSchemesAsPrivileged`. */
const APP_SCHEME_PRIVILEGES = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Keep in sync with the meta tag in renderer/index.html: the header and the
  // meta policy are both enforced, and whichever is stricter wins.
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://services.arcgisonline.com",
  "connect-src 'self' https://nominatim.openstreetmap.org",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join("; ");

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(String(filePath)).toLowerCase()] || "application/octet-stream";
}

/**
 * Map a URL pathname onto a file inside `rendererRoot`.
 * @returns {string|null} the absolute path, or null when the request must be refused.
 */
function resolveRendererFile(rendererRoot, requestPath) {
  if (typeof requestPath !== "string") return null;
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  // Normalise backslashes so a Windows-style path cannot dodge the checks.
  const normalised = decoded.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalised)) return null; // absolute Windows path
  if (normalised.startsWith("//")) return null; // UNC path

  const relative = normalised.replace(/^\/+/, "");
  if (!relative) return null;

  const root = path.resolve(rendererRoot);
  const candidate = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) return null;
  return candidate;
}

/** Directory-style requests resolve to index.html. */
function normaliseRequestPath(pathname) {
  if (!pathname || pathname === "/") return "/index.html";
  return pathname;
}

/**
 * Produce an HTTP response for a renderer request.
 *
 * @param {{ url: string, rendererRoot: string, isDevelopment?: boolean, log?: (level: string, message: string) => void }} options
 * @returns {Promise<{ status: number, filePath: string|null, body?: Buffer, headers: Record<string,string> }>}
 */
async function serveRendererRequest({ url, rendererRoot, isDevelopment = false, log = () => {} }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { status: 400, filePath: null, headers: {} };
  }

  if (parsed.host !== APP_HOST) {
    return { status: 404, filePath: null, headers: {} };
  }

  const filePath = resolveRendererFile(rendererRoot, normaliseRequestPath(parsed.pathname));
  if (!filePath) {
    log("warn", `blocked an out-of-tree renderer request: ${parsed.pathname}`);
    return { status: 403, filePath: null, headers: {} };
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return { status: 404, filePath, headers: {} };
    const body = await fs.promises.readFile(filePath);
    return {
      status: 200,
      filePath,
      body,
      headers: {
        "content-type": contentTypeFor(filePath),
        "cache-control": isDevelopment ? "no-store" : "no-cache",
        "content-security-policy": CONTENT_SECURITY_POLICY,
      },
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: 404, filePath, headers: {} };
    log("error", `renderer asset failed: ${error.message}`);
    return { status: 500, filePath, headers: {} };
  }
}

/** Adapt `serveRendererRequest` to Electron's `protocol.handle` contract. */
function createProtocolHandler({ rendererRoot, isDevelopment, log }) {
  return async (request) => {
    const result = await serveRendererRequest({ url: request.url, rendererRoot, isDevelopment, log });
    if (result.status !== 200) {
      return new Response(result.status === 404 ? "Not found" : "Forbidden", { status: result.status });
    }
    return new Response(result.body, { status: 200, headers: result.headers });
  };
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME_PRIVILEGES,
  CONTENT_SECURITY_POLICY,
  MIME_TYPES,
  contentTypeFor,
  resolveRendererFile,
  normaliseRequestPath,
  serveRendererRequest,
  createProtocolHandler,
};
