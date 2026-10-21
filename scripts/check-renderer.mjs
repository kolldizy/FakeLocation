/**
 * Static check for the renderer. Renderer files are browser ES modules, so they
 * are parsed with vm.SourceTextModule (run with --experimental-vm-modules)
 * instead of being executed.
 *
 * Three things are verified:
 *   1. every file parses;
 *   2. the import graph links, i.e. no module imports a name another module does
 *      not export and no relative specifier points at a missing file;
 *   3. the DOM contract holds: every id a module looks up exists exactly once in
 *      index.html, and every nav entry has the section its template builds.
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

/* --------------------------------------------------------------- DOM contract */

/**
 * The renderer reaches the document only through `$("id")` and
 * `document.getElementById("id")`, so the id list in index.html is a hard contract:
 * a missing id is a null at run time, usually thrown from inside a subscriber, which
 * shows the user a frozen panel rather than an error.
 *
 * Ids built from a template are checked against the nav entries instead, because
 * `view-${view}` is exactly how the workspaces are switched.
 */
const htmlFile = path.join(rendererDir, "index.html");
if (!fs.existsSync(htmlFile)) {
  failures += 1;
  console.error(" FAIL renderer/index.html is missing; the DOM contract cannot be checked");
} else {
  const html = fs.readFileSync(htmlFile, "utf8");
  const declared = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    declared.set(match[1], (declared.get(match[1]) || 0) + 1);
  }

  for (const [id, count] of declared) {
    if (count > 1) {
      failures += 1;
      console.error(` FAIL index.html: id "${id}" is declared ${count} times`);
    }
  }

  const navViews = [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
  for (const view of navViews) {
    if (!declared.has(`view-${view}`)) {
      failures += 1;
      console.error(` FAIL index.html: nav entry "${view}" has no #view-${view} section`);
    }
  }
  console.log(`  ok  ${navViews.length} nav view(s) each have their section`);

  let looked = 0;
  for (const file of files) {
    const relative = path.relative(rendererDir, file);
    const source = fs.readFileSync(file, "utf8");
    const refs = new Set();
    for (const pattern of [
      /\$\(\s*"([^"]+)"/g,
      /\$\(\s*'([^']+)'/g,
      /getElementById\(\s*"([^"]+)"/g,
      /getElementById\(\s*'([^']+)'/g,
    ]) {
      for (const match of source.matchAll(pattern)) refs.add(match[1]);
    }
    for (const id of refs) {
      looked += 1;
      if (!declared.has(id)) {
        failures += 1;
        console.error(` FAIL ${relative}: $("${id}") has no element with that id in index.html`);
      }
    }
  }
  console.log(`  ok  ${looked} id lookup(s) resolved against ${declared.size} declared id(s)`);
}

if (failures) {
  console.error(`\n${failures} renderer check(s) failed.`);
  process.exit(1);
}
console.log(`\n${files.length} renderer file(s) parsed, linked, and matched the DOM in index.html.`);
