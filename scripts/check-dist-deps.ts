/**
 * Guard the dist dependency contract in both directions. `vp pack` externals every import not in
 * `deps.onlyBundle`, so a packed import missing from `dependencies`/`peerDependencies`/
 * `optionalDependencies` ships as a broken external; and a `dependencies` entry no packed file
 * imports ships a package consumers install for nothing (peer and optional entries are exempt —
 * they are contracts, not installs). Packed files are the manifest's `files` entries; every
 * `.mjs`/`.js`/`.cjs`/`.d.mts`/`.d.ts` among them is scanned for `import`/`export … from`,
 * side-effect `import "x"`, `import("x")` and `require("x")`. Comments are stripped first —
 * vendored sources and JSDoc type imports must not count — and `x.require(`/`-p`-style calls are
 * not imports. Run after `vp pack` (`check:pkg` does).
 */
/// <reference types="node" />
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export type PackedFile = {
  /** Path relative to the package dir — where a finding lands. */
  readonly path: string;
  readonly source: string;
};

/** File extensions the import scan covers — every JS module or declaration npm ships. */
const SCANNED = /\.(?:mjs|cjs|js|d\.(?:m|c)?ts)$/;

/**
 * Comments blanked to spaces (line structure kept) so specifier scanning cannot match vendored
 * JSDoc like `@type {import("…")}` or a documented `from '…'`. Strings and template literals are
 * preserved — a `require("x")` needs its literal argument to be readable.
 */
export const stripComments = (source: string): string => {
  const out = source.split("");
  const blank = (i: number): void => {
    if (out[i] !== "\n") {
      out[i] = " ";
    }
  };
  type Ctx = "code" | "line" | "block" | "squ" | "dqu" | "tpl" | "re" | "reclass";
  const stack: Ctx[] = ["code"];
  const top = (): Ctx => stack.at(-1) ?? "code";
  // `/` opens a regex only where a value cannot precede it — the classic regex-vs-division
  // heuristic: after an identifier/number/`)`/`]`/`}` or a literal close it divides.
  const REGEX_KEYWORDS = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "yield",
    "await",
    "throw",
    "case",
    "do",
    "else",
  ]);
  let prev = "";
  let word = "";
  for (let i = 0; i < out.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";
    switch (top()) {
      case "line":
        if (ch === "\n") {
          stack.pop();
        } else {
          blank(i);
        }
        break;
      case "block":
        if (ch === "*" && next === "/") {
          blank(i);
          blank(i + 1);
          i += 1;
          stack.pop();
        } else {
          blank(i);
        }
        break;
      case "re":
        if (ch === "\\") {
          i += 1;
        } else if (ch === "[") {
          stack.push("reclass");
        } else if (ch === "/" || ch === "\n") {
          stack.pop();
          // The literal just closed — it is an operand, so a following `/` divides.
          prev = "x";
          word = "";
        }
        break;
      case "reclass":
        if (ch === "\\") {
          i += 1;
        } else if (ch === "]") {
          stack.pop();
        }
        break;
      case "squ":
      case "dqu":
      case "tpl": {
        const close = top() === "squ" ? "'" : top() === "dqu" ? '"' : "`";
        if (ch === "\\") {
          i += 1;
        } else if (ch === close) {
          stack.pop();
          // The literal just closed — it is an operand, so a following `/` divides.
          prev = "x";
          word = "";
        } else if (top() === "tpl" && ch === "$" && next === "{") {
          stack.push("code");
          i += 1;
        }
        break;
      }
      case "code":
        if (ch === "/" && next === "/") {
          blank(i);
          blank(i + 1);
          i += 1;
          stack.push("line");
        } else if (ch === "/" && next === "*") {
          blank(i);
          blank(i + 1);
          i += 1;
          stack.push("block");
        } else if (
          ch === "/" &&
          (prev === "" || "(,=:[!&|?{};+-*%^~<>".includes(prev) || REGEX_KEYWORDS.has(word))
        ) {
          stack.push("re");
        } else if (ch === "'") {
          stack.push("squ");
        } else if (ch === '"') {
          stack.push("dqu");
        } else if (ch === "`") {
          stack.push("tpl");
        } else if (ch === "{") {
          stack.push("code");
        } else if (ch === "}" && stack.length > 1) {
          stack.pop();
        }
        if (/[\w$]/.test(ch)) {
          word += ch;
        } else if (!/\s/.test(ch)) {
          word = "";
        }
        if (!/\s/.test(ch)) {
          prev = ch;
        }
        break;
    }
  }
  return out.join("");
};

/** Bare specifiers a file loads — matched on the comment-stripped source. */
const SPECIFIER =
  /(?<![.\w$"'])(?:import|export)\s[^"'()]*?\bfrom\s*["']([^"'\n]+)["']|(?<![.\w$"'])import\s*["']([^"'\n]+)["']|(?<![.\w$"'])import\s*\(\s*["']([^"'\n]+)["']\s*\)|(?<![.\w$"'])require\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

/** `leftpad/x` → `leftpad`; `@scope/pkg/sub` → `@scope/pkg`. */
const specifier = (name: string): string =>
  name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : (name.split("/")[0] ?? name);

const isRuntime = (spec: string): boolean =>
  !spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("bun:");

const keys = (value: unknown): ReadonlyArray<string> => (isRecord(value) ? Object.keys(value) : []);

/** Expand the manifest's `files` entries into the scannable packed files. */
export const packedSources = (dir: string, manifest: unknown): PackedFile[] => {
  const out: PackedFile[] = [];
  const collect = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) {
      return;
    }
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) {
        collect(join(rel, entry));
      }
    } else if (SCANNED.test(rel)) {
      out.push({ path: rel, source: readFileSync(abs, "utf8") });
    }
  };
  const files = isRecord(manifest) && Array.isArray(manifest["files"]) ? manifest["files"] : [];
  for (const entry of files) {
    if (typeof entry === "string") {
      collect(entry);
    }
  }
  return out;
};

/**
 * Both checks over one package: every runtime specifier a packed file imports is declared, and
 * every `dependencies` entry is imported by some packed file. `dir` is only used in messages.
 */
export function checkDistDeps(
  dir: string,
  manifest: unknown,
  packed: ReadonlyArray<PackedFile>,
): string[] {
  const errors: string[] = [];
  const pkg = isRecord(manifest) ? manifest : {};
  const runtime = keys(pkg["dependencies"]);
  const declared = new Set<string>([
    ...runtime,
    ...keys(pkg["peerDependencies"]),
    ...keys(pkg["optionalDependencies"]),
  ]);
  const used = new Set<string>();
  for (const file of packed) {
    const code = stripComments(file.source);
    for (const match of code.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
      if (!isRuntime(spec)) {
        continue;
      }
      const name = specifier(spec);
      used.add(name);
      if (!declared.has(name)) {
        errors.push(`${dir}: ${file.path} imports ${spec} — ${name} is not declared`);
      }
    }
  }
  for (const dep of runtime) {
    if (!used.has(dep)) {
      errors.push(`${dir}: dependencies entry ${dep} is imported by no packed file`);
    }
  }
  return errors;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? ".";
  const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const errors = checkDistDeps(dir, manifest, packedSources(dir, manifest));
  for (const error of errors) {
    console.error(`check-dist-deps: ${error}`);
  }
  if (errors.length > 0) {
    process.exitCode = 1;
  } else {
    const name =
      isRecord(manifest) && typeof manifest["name"] === "string" ? manifest["name"] : dir;
    console.log(`check-dist-deps ${name}: every packed import is declared, every dependency used`);
  }
}
