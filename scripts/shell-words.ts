/// <reference types="node" />
/**
 * A small POSIX-shell lexer/parser the toolchain gate tokenizes commands with. It returns the
 * pipelines a script carries — a `|`-joined command list per `;`, `&`, `&&`, `||`, newline or
 * grouping operator — with each command's argv words, the scripts inside its `$(…)`/backquote/
 * `<(…)`/`>(…)` substitutions (parsed recursively), and its heredoc bodies (a body fed to a shell
 * is itself a script for the caller to parse). Quoting and `\` escapes hide nothing: single and
 * double quotes, backslash-newline continuations, `#` comments at a word boundary and leading
 * `NAME=value` assignments are all handled. GitHub's `${{ … }}` expressions stay verbatim inside a
 * word, spaces included, so a templated token still compares as one word. Malformed input never
 * throws: an unterminated quote or substitution swallows the rest of the text.
 */

export type Command = {
  readonly argv: ReadonlyArray<string>;
  /** The pipelines inside this command's `$(…)`, backquote and `<(…)`/`>(…)` words, in order. */
  readonly substitutions: ReadonlyArray<ReadonlyArray<Pipeline>>;
  /** Raw heredoc bodies this command declared (`<<EOF`, `<<-'X'`); empty for most commands. */
  readonly heredocs: ReadonlyArray<string>;
};

/** One `|`-joined chain of commands. */
export type Pipeline = ReadonlyArray<Command>;

type Token =
  | { readonly kind: "word"; readonly text: string; readonly subs: Array<ReadonlyArray<Pipeline>> }
  | { readonly kind: "op"; readonly op: string }
  | { readonly kind: "redir" }
  | { readonly kind: "body"; readonly body: string };

const isWordBreak = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/**
 * The text between `source[open]` (`(`) and its matching `)`, quote- and escape-aware. Counts every
 * unquoted paren so `$( (a) )`, `$(x <(y))` and nested `$(…)` nest correctly; an unclosed run
 * consumes the rest of the input.
 */
const balancedBody = (
  source: string,
  open: number,
): { readonly inner: string; readonly end: number } => {
  let depth = 1;
  let j = open + 1;
  let inner = "";
  while (j < source.length) {
    const c = source[j] ?? "";
    if (c === "\\") {
      inner += c + (source[j + 1] ?? "");
      j += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      inner += c;
      j += 1;
      while (j < source.length && source[j] !== quote) {
        const q = source[j] ?? "";
        inner += q;
        if (q === "\\") {
          inner += source[j + 1] ?? "";
          j += 1;
        }
        j += 1;
      }
      inner += source[j] ?? "";
      j += 1;
      continue;
    }
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        return { inner, end: j + 1 };
      }
    }
    inner += c;
    j += 1;
  }
  return { inner, end: j };
};

/** The backquote body after `source[open]` (`` ` ``), honoring `\` escapes. */
const backquoteBody = (
  source: string,
  open: number,
): { readonly inner: string; readonly end: number } => {
  let j = open + 1;
  let inner = "";
  while (j < source.length && source[j] !== "`") {
    const c = source[j] ?? "";
    inner += c;
    if (c === "\\") {
      inner += source[j + 1] ?? "";
      j += 1;
    }
    j += 1;
  }
  return { inner, end: j + 1 };
};

/**
 * The scanner: raw text → tokens. `pending` holds the heredoc delimiters declared on the line; the
 * newline that ends it feeds them their bodies instead of separating commands.
 */
const scan = (source: string): Token[] => {
  const tokens: Token[] = [];
  const pending: Array<{ readonly delimiter: string; readonly strip: boolean }> = [];
  let i = 0;
  let word = "";
  let subs: Array<ReadonlyArray<Pipeline>> = [];
  let inWord = false;

  const endWord = (): void => {
    if (inWord) {
      tokens.push({ kind: "word", text: word, subs });
      word = "";
      subs = [];
      inWord = false;
    }
  };
  const op = (code: string): void => {
    endWord();
    tokens.push({ kind: "op", op: code });
  };

  /** `$(…)`/`<(…)`/`>(…)`: `i` at the marker's first char; the script inside is parsed. */
  const substitution = (marker: "$(" | "<(" | ">("): void => {
    const { inner, end } = balancedBody(source, i + 1);
    subs.push(parse(inner));
    word += `${marker + inner})`;
    i = end;
  };

  /** The heredoc bodies pending on this line: raw lines up to each delimiter. */
  const readHeredocs = (): void => {
    for (const { delimiter, strip } of pending) {
      let body = "";
      while (i < source.length) {
        const nl = source.indexOf("\n", i);
        const line = nl === -1 ? source.slice(i) : source.slice(i, nl);
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
          i = nl === -1 ? source.length : nl + 1;
          break;
        }
        body += `${line}\n`;
        i = nl === -1 ? source.length : nl + 1;
      }
      tokens.push({ kind: "body", body });
    }
    pending.length = 0;
  };

  while (i < source.length) {
    const c = source[i] ?? "";
    if (!inWord) {
      if (isWordBreak(c)) {
        if (c === "\n") {
          if (pending.length > 0) {
            i += 1;
            readHeredocs();
            op("\n");
            continue;
          }
          op("\n");
        }
        i += 1;
        continue;
      }
      if (c === "#") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl;
        continue;
      }
      if (c === ";") {
        op(";");
        i += 1;
        continue;
      }
      if (c === "&") {
        op(source[i + 1] === "&" ? "&&" : "&");
        i += source[i + 1] === "&" ? 2 : 1;
        continue;
      }
      if (c === "|") {
        const two = source[i + 1];
        op(two === "|" ? "||" : two === "&" ? "|&" : "|");
        i += two === "|" || two === "&" ? 2 : 1;
        continue;
      }
      if (c === "(" || c === ")" || c === "{" || c === "}") {
        op(c);
        i += 1;
        continue;
      }
      /* Redirections: `<`/`>` at a boundary are operators whose target stays an argv word —
         they never split a command. `<<` declares a heredoc instead. `<(`/`>(` substitute. */
      if (c === ">" || c === "<") {
        if (source[i + 1] === "(") {
          inWord = true;
          substitution(c === "<" ? "<(" : ">(");
          continue;
        }
        if (c === "<" && source[i + 1] === "<") {
          let j = i + 2;
          let strip = false;
          if (source[j] === "-") {
            strip = true;
            j += 1;
          }
          while (j < source.length && (source[j] === " " || source[j] === "\t")) {
            j += 1;
          }
          let delimiter = "";
          if (source[j] === "'" || source[j] === '"') {
            const quote = source[j] ?? "";
            j += 1;
            while (j < source.length && source[j] !== quote && source[j] !== "\n") {
              delimiter += source[j];
              j += 1;
            }
            j += 1;
          } else {
            while (
              j < source.length &&
              !isWordBreak(source[j] ?? "") &&
              !";|&<>()".includes(source[j] ?? "")
            ) {
              delimiter += source[j];
              j += 1;
            }
          }
          if (delimiter !== "") {
            pending.push({ delimiter, strip });
          }
          i = j;
          continue;
        }
        let j = i + 1;
        if (
          (c === ">" && (source[j] === ">" || source[j] === "&" || source[j] === "|")) ||
          (c === "<" && (source[j] === "&" || source[j] === ">" || source[j] === "<"))
        ) {
          j += 1;
        }
        tokens.push({ kind: "redir" });
        i = j;
        continue;
      }
      if (c === "\\" && source[i + 1] === "\n") {
        // A backslash-newline continuation at a word boundary starts no word.
        i += 2;
        continue;
      }
      inWord = true;
      continue;
    }
    // Inside a word.
    if (c === "\\") {
      const next = source[i + 1] ?? "";
      if (next !== "\n") {
        word += next;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== "'") {
        word += source[j];
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        const q = source[j] ?? "";
        if (q === "\\") {
          word += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (q === "`") {
          const { inner, end } = backquoteBody(source, j);
          subs.push(parse(inner));
          word += source.slice(j, end);
          j = end;
          continue;
        }
        if (q === "$") {
          if (source[j + 1] === "(") {
            const { inner, end } = balancedBody(source, j + 1);
            subs.push(parse(inner));
            word += source.slice(j, end);
            j = end;
            continue;
          }
          if (source[j + 1] === "{" && source[j + 2] === "{") {
            const close = source.indexOf("}}", j + 2);
            const stop = close === -1 ? source.length : close + 2;
            word += source.slice(j, stop);
            j = stop;
            continue;
          }
        }
        word += q;
        j += 1;
      }
      i = j < source.length ? j + 1 : j;
      continue;
    }
    if (c === "`") {
      const { inner, end } = backquoteBody(source, i);
      subs.push(parse(inner));
      word += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$") {
      if (source[i + 1] === "(") {
        substitution("$(");
        continue;
      }
      if (source[i + 1] === "{") {
        if (source[i + 2] === "{") {
          const close = source.indexOf("}}", i + 2);
          const stop = close === -1 ? source.length : close + 2;
          word += source.slice(i, stop);
          i = stop;
          continue;
        }
        let depth = 1;
        let j = i + 2;
        while (j < source.length && depth > 0) {
          const b = source[j] ?? "";
          if (b === "{") {
            depth += 1;
          } else if (b === "}") {
            depth -= 1;
          }
          j += 1;
        }
        word += source.slice(i, j);
        i = j;
        continue;
      }
      word += c;
      i += 1;
      continue;
    }
    if (c === "<" && source[i + 1] === "(") {
      substitution("<(");
      continue;
    }
    if (c === ">" && source[i + 1] === "(") {
      substitution(">(");
      continue;
    }
    if (isWordBreak(c) || ";&|(){}<>".includes(c)) {
      endWord();
      continue;
    }
    word += c;
    i += 1;
  }
  endWord();
  if (pending.length > 0) {
    readHeredocs();
  }
  return tokens;
};

/**
 * Parse a shell script into its pipelines: each `|`-joined command list per `;`, `&`, `&&`, `||`,
 * newline or grouping token. Leading `NAME=value` words bind to the command they precede — they
 * never become commands themselves (their substitutions still count).
 */
export const parse = (source: string): ReadonlyArray<Pipeline> => {
  const pipelines: Pipeline[] = [];
  let commands: Command[] = [];
  let argv: string[] = [];
  let subs: Array<ReadonlyArray<Pipeline>> = [];
  let heredocs: string[] = [];
  let leading = true;

  const endCommand = (): void => {
    if (argv.length > 0 || heredocs.length > 0 || subs.length > 0) {
      commands.push({ argv, substitutions: subs, heredocs });
    }
    argv = [];
    subs = [];
    heredocs = [];
    leading = true;
  };
  const endPipeline = (): void => {
    endCommand();
    if (commands.length > 0) {
      pipelines.push(commands);
    }
    commands = [];
  };

  for (const token of scan(source)) {
    if (token.kind === "word") {
      if (leading && ASSIGNMENT.test(token.text)) {
        subs.push(...token.subs);
        continue;
      }
      leading = false;
      argv.push(token.text);
      subs.push(...token.subs);
      continue;
    }
    if (token.kind === "body") {
      heredocs.push(token.body);
      continue;
    }
    if (token.kind === "redir") {
      continue;
    }
    if (token.op === "|" || token.op === "|&") {
      endCommand();
      continue;
    }
    endPipeline();
  }
  endPipeline();
  return pipelines;
};
