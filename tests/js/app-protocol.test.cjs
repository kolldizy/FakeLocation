/**
 * Tests for the renderer asset server (`app://` scheme).
 *
 * These run in plain Node: `app-protocol.cjs` has no Electron dependency, so the
 * path-traversal rules that protect the renderer directory are testable directly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  APP_ORIGIN,
  CONTENT_SECURITY_POLICY,
  contentTypeFor,
  normaliseRequestPath,
  resolveRendererFile,
  serveRendererRequest,
} = require("../../electron/app-protocol.cjs");

const RENDERER_ROOT = path.join(__dirname, "..", "..", "renderer");

test("resolveRendererFile maps plain paths inside the renderer directory", () => {
  const resolved = resolveRendererFile(RENDERER_ROOT, "/index.html");
  assert.equal(resolved, path.join(RENDERER_ROOT, "index.html"));

  const nested = resolveRendererFile(RENDERER_ROOT, "/js/app.js");
  assert.equal(nested, path.join(RENDERER_ROOT, "js", "app.js"));
});

test("resolveRendererFile refuses traversal, absolute and UNC paths", () => {
  const hostile = [
    "/../package.json",
    "/../../etc/passwd",
    "/js/../../electron/main.cjs",
    "/%2e%2e/%2e%2e/package.json",
    "..\\..\\package.json",
    "/C:/Windows/System32/drivers/etc/hosts",
    "//server/share/file.js",
    "/js/app.js\0.png",
  ];
  for (const candidate of hostile) {
    assert.equal(resolveRendererFile(RENDERER_ROOT, candidate), null, `expected refusal for ${candidate}`);
  }
});

test("resolveRendererFile refuses malformed percent-encoding and empty paths", () => {
  assert.equal(resolveRendererFile(RENDERER_ROOT, "/%E0%A4%A"), null);
  assert.equal(resolveRendererFile(RENDERER_ROOT, ""), null);
  assert.equal(resolveRendererFile(RENDERER_ROOT, undefined), null);
});

test("normaliseRequestPath defaults to index.html", () => {
  assert.equal(normaliseRequestPath("/"), "/index.html");
  assert.equal(normaliseRequestPath(""), "/index.html");
  assert.equal(normaliseRequestPath("/styles.css"), "/styles.css");
});

test("content types cover the asset kinds the renderer uses", () => {
  assert.match(contentTypeFor("index.html"), /^text\/html/);
  assert.match(contentTypeFor("js/app.js"), /^text\/javascript/);
  assert.match(contentTypeFor("styles.css"), /^text\/css/);
  assert.equal(contentTypeFor("leaflet/images/marker-icon.png"), "image/png");
  assert.equal(contentTypeFor("unknown.bin"), "application/octet-stream");
});

test("index.html is served with the same CSP as the meta tag", async () => {
  const result = await serveRendererRequest({ url: `${APP_ORIGIN}/index.html`, rendererRoot: RENDERER_ROOT });
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
  assert.match(result.body.toString("utf8"), /<title>Location Studio/);
  assert.match(result.headers["content-security-policy"], /script-src 'self'/);
  assert.doesNotMatch(result.headers["content-security-policy"], /unsafe-eval/);
});

test("the meta CSP and the header CSP cannot drift apart", () => {
  // Both policies are enforced and the stricter one wins, so a host allowed in
  // only one of them is silently blocked — which is exactly how a basemap host
  // once stayed unloadable while every header-side check still passed.
  const html = fs.readFileSync(path.join(RENDERER_ROOT, "index.html"), "utf8");
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/);
  assert.ok(meta, "index.html should carry a Content-Security-Policy meta tag");

  const asDirectives = (policy) =>
    Object.fromEntries(
      policy
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...values] = part.split(/\s+/);
          return [name, values.sort().join(" ")];
        })
    );
  assert.deepEqual(asDirectives(meta[1]), asDirectives(CONTENT_SECURITY_POLICY));
});

test("unknown hosts and out-of-tree requests never return a body", async () => {
  const wrongHost = await serveRendererRequest({ url: "app://elsewhere/index.html", rendererRoot: RENDERER_ROOT });
  assert.equal(wrongHost.status, 404);
  assert.equal(wrongHost.body, undefined);

  // The URL parser normalises `..` before this module sees it; the raw resolver
  // (tested above) is what refuses traversal outright.
  const escape = await serveRendererRequest({ url: `${APP_ORIGIN}/../package.json`, rendererRoot: RENDERER_ROOT });
  assert.notEqual(escape.status, 200);
  assert.equal(escape.body, undefined);

  const backslash = await serveRendererRequest({ url: `${APP_ORIGIN}/%5C..%5C..%5Cpackage.json`, rendererRoot: RENDERER_ROOT });
  assert.notEqual(backslash.status, 200);
  assert.equal(backslash.body, undefined);
});

test("a missing asset is a 404, a directory is not served as a file", async () => {
  const missing = await serveRendererRequest({ url: `${APP_ORIGIN}/nope.js`, rendererRoot: RENDERER_ROOT });
  assert.equal(missing.status, 404);

  const directory = await serveRendererRequest({ url: `${APP_ORIGIN}/js`, rendererRoot: RENDERER_ROOT });
  assert.equal(directory.status, 404);
});

test("the served root resolves to the renderer directory and nothing above it", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-protocol-"));
  try {
    fs.writeFileSync(path.join(temp, "index.html"), "<!doctype html><title>temp</title>");
    fs.writeFileSync(path.join(path.dirname(temp), `${path.basename(temp)}-secret.txt`), "secret");

    const ok = await serveRendererRequest({ url: `${APP_ORIGIN}/index.html`, rendererRoot: temp });
    assert.equal(ok.status, 200);

    const sibling = await serveRendererRequest({
      url: `${APP_ORIGIN}/${path.basename(temp)}-secret.txt`,
      rendererRoot: temp,
    });
    assert.notEqual(sibling.status, 200);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(temp), `${path.basename(temp)}-secret.txt`), { force: true });
  }
});
