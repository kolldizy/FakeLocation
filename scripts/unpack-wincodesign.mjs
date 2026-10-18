/**
 * Finish electron-builder's `winCodeSign` cache download without needing
 * Windows symlink privileges.
 *
 * Why this exists
 * ---------------
 * On Windows, extracting that archive fails with "Cannot create symbolic link:
 * a required privilege is not held by the client" unless the machine has
 * Developer Mode enabled (or the process runs elevated). The failing entries
 * are the macOS `darwin/**` libraries, which are irrelevant for a Windows
 * build. When that happens, the downloader aborts before its final step:
 *
 *   1. download `winCodeSign-2.6.0.7z` (sha512 verified by app-builder)
 *   2. extract it into `<cache>\winCodeSign\<random>`   <- fails here
 *   3. rename that directory to `<cache>\winCodeSign\winCodeSign-2.6.0`
 *
 * Steps 1 and 2 leave a complete Windows tool set behind (rcedit, signtool,
 * windows-10, ...), just under a random name. This script re-extracts the
 * cached archive while excluding `darwin/**` and performs step 3 for you.
 * A cache hit in `winCodeSign-2.6.0` short-circuits the download entirely, so
 * once this script has run, `npm run dist` works with no further privileges.
 *
 * Usage:
 *
 *     npm run dist            # once, to populate the cache (it will fail)
 *     node scripts/unpack-wincodesign.mjs
 *     npm run dist            # now completes
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Must match app-builder's DownloadWinCodeSign() (develar/app-builder, pkg/download/tool.go).
const ARTIFACT_NAME = "winCodeSign-2.6.0";
const ARCHIVE_SHA512 = "6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==";
// Files the build needs; if they are present, the directory is usable.
const REQUIRED_FILES = [
  ["rcedit-x64.exe"],
  ["windows-10", "x64", "signtool.exe"],
  ["windows-10", "x64", "makepri.exe"],
];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const sevenZip = path.join(root, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
const cacheRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "electron-builder",
  "Cache",
  "winCodeSign",
);
const finalDir = path.join(cacheRoot, ARTIFACT_NAME);

function log(message) {
  console.log(message);
}

function isUsable(dir) {
  return REQUIRED_FILES.every((parts) => fs.existsSync(path.join(dir, ...parts)));
}

function sha512Of(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

/** Numeric directory names are app-builder's random temp names (Go's os.MkdirTemp). */
function tempDirs() {
  return fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => path.join(cacheRoot, entry.name));
}

function archives() {
  return fs
    .readdirSync(cacheRoot)
    .filter((name) => name.toLowerCase().endsWith(".7z"))
    .map((name) => path.join(cacheRoot, name));
}

if (process.platform !== "win32") {
  log("This workaround only applies to Windows builds; nothing to do.");
  process.exit(0);
}
if (!fs.existsSync(cacheRoot)) {
  console.error(`electron-builder cache not found at ${cacheRoot}. Run "npm run dist" once, then retry.`);
  process.exit(1);
}

if (isUsable(finalDir)) {
  log(`Already in place: ${finalDir}`);
  process.exit(0);
}

// Case 1: a previous failed run left a complete extraction under a temp name.
const reusable = tempDirs().find((dir) => isUsable(dir));
if (reusable) {
  log(`Reusing complete extraction ${path.basename(reusable)} → ${ARTIFACT_NAME}`);
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(reusable, finalDir);
} else {
  // Case 2: extract one of the cached archives ourselves, minus darwin/**.
  const candidates = archives();
  if (!candidates.length) {
    console.error(`No cached archives in ${cacheRoot}. Run "npm run dist" once, then retry.`);
    process.exit(1);
  }
  if (!fs.existsSync(sevenZip)) {
    console.error(`7-Zip helper not found at ${sevenZip}. Run "npm install" first.`);
    process.exit(1);
  }

  const archive = candidates[0];
  const actual = sha512Of(archive);
  if (actual !== ARCHIVE_SHA512) {
    console.error(`Checksum mismatch for ${path.basename(archive)} — refusing to unpack.`);
    console.error(`  expected ${ARCHIVE_SHA512}`);
    console.error(`  actual   ${actual}`);
    process.exit(1);
  }

  const staging = path.join(cacheRoot, `staging-${process.pid}`);
  log(`Unpacking ${path.basename(archive)} → ${ARTIFACT_NAME} (excluding darwin/**)`);
  fs.rmSync(staging, { recursive: true, force: true });
  execFileSync(sevenZip, ["x", archive, `-o${staging}`, "-y", "-xr!darwin"], { stdio: "inherit" });

  if (!isUsable(staging)) {
    console.error(`Extraction is incomplete: ${REQUIRED_FILES.map((parts) => parts.join("/")).join(", ")} missing.`);
    process.exit(1);
  }
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(staging, finalDir);
}

// Tidy up the debris left by the failed downloads (this is what the downloader
// would have done itself: archive removed, temp directory renamed).
let removed = 0;
for (const dir of tempDirs()) {
  fs.rmSync(dir, { recursive: true, force: true });
  removed += 1;
}
for (const archive of archives()) {
  fs.rmSync(archive, { force: true });
  removed += 1;
}

log(`Ready: ${finalDir}${removed ? ` (removed ${removed} leftover download(s))` : ""}`);
log('Next: "npm run dist" or "npm run dist:dir".');
