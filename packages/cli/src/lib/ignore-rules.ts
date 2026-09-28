// A small .gitignore/.dockerignore matcher for `hexclave deploy`'s source
// packaging. Implements the commonly-used gitignore syntax: comments, blank
// lines, negation (!), directory-only patterns (trailing /), anchoring
// (patterns containing a slash are relative to the ignore file's directory),
// the *, ?, ** wildcards, backslash escapes (\#, \!, \ ), and character
// classes ([abc], [a-z], [!a-z]). Matching what users' .gitignore files
// actually mean matters here: a pattern we under-match would make the CLI
// upload files the user believes are ignored.

export type IgnoreRule = {
  negated: boolean,
  dirOnly: boolean,
  regex: RegExp,
};

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

// Converts one glob segment ("*.log", "foo?", "[a-z]bc", ...) to a regex
// fragment that never crosses a "/" boundary.
function globSegmentToRegex(segment: string): string {
  let result = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (char === "\\" && i + 1 < segment.length) {
      // Backslash escape: the next character is literal (gitignore uses this
      // for \#, \!, and trailing "\ ").
      result += escapeRegExpChar(segment[i + 1]);
      i++;
    } else if (char === "*") {
      result += "[^/]*";
    } else if (char === "?") {
      result += "[^/]";
    } else if (char === "[") {
      // Character class: find the closing bracket (a ']' directly after the
      // opening '[' or '[!' is literal, per fnmatch). An unterminated '[' is
      // treated as a literal bracket.
      let j = i + 1;
      let negatedClass = false;
      if (segment[j] === "!" || segment[j] === "^") {
        negatedClass = true;
        j++;
      }
      let classEnd = segment[j] === "]" ? segment.indexOf("]", j + 1) : segment.indexOf("]", j);
      if (classEnd === -1) {
        result += escapeRegExpChar(char);
      } else {
        const inner = segment.slice(j, classEnd);
        // Keep '-' ranges; escape everything regex-special except '-'.
        const safeInner = [...inner].map((c) => (c === "-" ? "-" : escapeRegExpChar(c))).join("");
        result += `[${negatedClass ? "^" : ""}${safeInner}]`;
        i = classEnd;
      }
    } else {
      result += escapeRegExpChar(char);
    }
  }
  return result;
}

export function parseIgnorePattern(line: string): IgnoreRule | undefined {
  let pattern = line.replace(/\r$/, "");
  // Trailing spaces are ignored unless backslash-escaped (git semantics); the
  // lookbehind keeps an escaped "\ " so the escape handling below can turn it
  // into a literal space.
  pattern = pattern.replace(/(?<!\\) +$/, "");
  if (pattern === "" || pattern.startsWith("#")) {
    return undefined;
  }
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === "") {
    return undefined;
  }
  // A pattern containing a slash (after stripping the trailing one) is
  // anchored to the ignore file's directory; otherwise it matches at any depth.
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  const segments = pattern.split("/");
  const regexParts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "**") {
      // "**" as a full segment matches zero or more path segments.
      regexParts.push(i === segments.length - 1 ? ".*" : "(?:[^/]+/)*");
    } else {
      regexParts.push(globSegmentToRegex(segment) + (i === segments.length - 1 ? "" : "/"));
    }
  }
  const body = regexParts.join("");
  const prefix = anchored ? "" : "(?:[^/]+/)*";
  return {
    negated,
    dirOnly,
    regex: new RegExp(`^${prefix}${body}$`),
  };
}

export function parseIgnoreFile(content: string): IgnoreRule[] {
  return content
    .split("\n")
    .map(parseIgnorePattern)
    .filter((rule): rule is IgnoreRule => rule !== undefined);
}

/**
 * Evaluates the rules against a path relative to the directory the rules are
 * anchored at (POSIX separators, no leading "/"). Last matching rule wins,
 * like git. Note that like git, a negation can't rescue a file inside an
 * ignored directory — the walker prunes ignored directories entirely.
 */
export function isIgnoredByRules(rules: IgnoreRule[], relativePath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.regex.test(relativePath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}
