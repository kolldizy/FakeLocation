/**
 * Copies the runtime front-end assets into renderer/vendor so the app never
 * depends on a CDN at runtime (offline use, strict CSP, reproducible builds).
 *
 * Runs automatically after `npm install`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const vendor = path.join(root, "renderer", "vendor");

const assets = [
  { from: "node_modules/leaflet/dist/leaflet.js", to: "leaflet/leaflet.js" },
  { from: "node_modules/leaflet/dist/leaflet.css", to: "leaflet/leaflet.css" },
  { from: "node_modules/leaflet/dist/images/marker-icon.png", to: "leaflet/images/marker-icon.png" },
  { from: "node_modules/leaflet/dist/images/marker-icon-2x.png", to: "leaflet/images/marker-icon-2x.png" },
  { from: "node_modules/leaflet/dist/images/marker-shadow.png", to: "leaflet/images/marker-shadow.png" },
  { from: "node_modules/leaflet/dist/images/layers.png", to: "leaflet/images/layers.png" },
  { from: "node_modules/leaflet/dist/images/layers-2x.png", to: "leaflet/images/layers-2x.png" },
];

let copied = 0;
const missing = [];

for (const asset of assets) {
  const source = path.join(root, asset.from);
  const target = path.join(vendor, asset.to);
  if (!fs.existsSync(source)) {
    missing.push(asset.from);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied += 1;
}

if (missing.length) {
  console.warn(
    `[vendor] ${missing.length} asset(s) were not found - run "npm install" first:\n  ` + missing.join("\n  ")
  );
}
console.log(`[vendor] ${copied} asset(s) copied into renderer/vendor/`);
