/**
 * Static check for the renderer. Renderer files are browser ES modules, so they
 * are parsed with vm.SourceTextModule (run with --experimental-vm-modules)
 * instead of being executed.
 *
 * Two things are verified:
 *   1. every file parses;
 *   2. the import graph links, i.e. no module imports a name another module does
 *      not export and no relative specifier points at a missing file.
 *
 * Nothing is evaluated, so no DOM or Window API is needed.
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(here, "..", "renderer");

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

if (typeof vm.SourceTextModule !== "function") {
  console.error("check-renderer requires --experimental-vm-modules");
  process.exit(2);
}

const files = walk(rendererDir).sort();
const modules = new Map();
let failures = 0;

for (const file of files) {
  const relative = path.relative(rendererDir, file);
  const source = fs.readFileSync(file, "utf8");
  try {
    modules.set(file, new vm.SourceTextModule(source, { identifier: relative }));
    console.log(`  ok  ${relative}`);
  } catch (error) {
    failures += 1;
    console.error(` FAIL ${relative}: ${error.message}`);
  }
}

/** Resolve a relative specifier to a file in this checkout. */
function resolveSpecifier(specifier, referencingFile) {
  if (!specifier.startsWith(".")) {
    // Bare specifiers (Leaflet is loaded as a classic script, not imported) are
    // not resolvable here; report them so a mistake cannot pass silently.
    throw new Error(`cannot resolve bare import '${specifier}'`);
  }
  const base = path.resolve(path.dirname(referencingFile), specifier);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`missing module '${specifier}' (looked for ${base}.js)`);
}

if (!failures) {
  for (const [file, module] of modules) {
    try {
      await module.link(async (specifier, referencingModule) => {
        const referencing = path.resolve(rendererDir, referencingModule.identifier);
        const resolved = resolveSpecifier(specifier, referencing);
        const linked = modules.get(resolved);
        if (!linked) throw new Error(`'${specifier}' resolved to ${resolved}, which is not part of the renderer`);
        return linked;
      });
    } catch (error) {
      // A module reached through another entry point is already linked; that is
      // success, not a failure.
      if (/already been linked/i.test(error.message)) continue;
      failures += 1;
      console.error(` FAIL ${path.relative(rendererDir, file)}: ${error.message}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} renderer file(s) failed to parse or link.`);
  process.exit(1);
}
console.log(`\n${files.length} renderer file(s) parsed and linked successfully.`);
