import { findLastIndex, unique } from "./arrays";
import { HexclaveAssertionError } from "./errors";
import { filterUndefined } from "./objects";

export type Join<T extends string[], Separator extends string> =
  T extends [] ? ""
    : T extends [infer U extends string, ...infer Rest extends string[]]
      ? `${U}${Rest extends [any, ...any[]] ? `${Separator}${Join<Rest, Separator>}` : ""}`
      : "<error-joining-strings>";

export function typedJoin<T extends string[], Separator extends string>(strings: T, separator: Separator): Join<T, Separator> {
  return strings.join(separator) as Join<T, Separator>;
}

export function typedToLowercase<S extends string>(s: S): Lowercase<S> {
  if (typeof s !== "string") throw new HexclaveAssertionError("Expected a string for typedToLowercase", { s });
  return s.toLowerCase() as Lowercase<S>;
}
import.meta.vitest?.test("typedToLowercase", ({ expect }) => {
  expect(typedToLowercase("")).toBe("");
  expect(typedToLowercase("HELLO")).toBe("hello");
  expect(typedToLowercase("Hello World")).toBe("hello world");
  expect(typedToLowercase("hello")).toBe("hello");
  expect(typedToLowercase("123")).toBe("123");
  expect(typedToLowercase("MIXED123case")).toBe("mixed123case");
  expect(typedToLowercase("Special@Chars!")).toBe("special@chars!");
  expect(() => typedToLowercase(123 as any)).toThrow("Expected a string for typedToLowercase");
});

export function typedToUppercase<S extends string>(s: S): Uppercase<S> {
  if (typeof s !== "string") throw new HexclaveAssertionError("Expected a string for typedToUppercase", { s });
  return s.toUpperCase() as Uppercase<S>;
}
import.meta.vitest?.test("typedToUppercase", ({ expect }) => {
  expect(typedToUppercase("")).toBe("");
  expect(typedToUppercase("hello")).toBe("HELLO");
  expect(typedToUppercase("Hello World")).toBe("HELLO WORLD");
  expect(typedToUppercase("HELLO")).toBe("HELLO");
  expect(typedToUppercase("123")).toBe("123");
  expect(typedToUppercase("mixed123Case")).toBe("MIXED123CASE");
  expect(typedToUppercase("special@chars!")).toBe("SPECIAL@CHARS!");
  expect(() => typedToUppercase(123 as any)).toThrow("Expected a string for typedToUppercase");
});

export function typedCapitalize<S extends string>(s: S): Capitalize<S> {
  return s.charAt(0).toUpperCase() + s.slice(1) as Capitalize<S>;
}
import.meta.vitest?.test("typedCapitalize", ({ expect }) => {
  expect(typedCapitalize("")).toBe("");
  expect(typedCapitalize("hello")).toBe("Hello");
  expect(typedCapitalize("hello world")).toBe("Hello world");
  expect(typedCapitalize("HELLO")).toBe("HELLO");
  expect(typedCapitalize("123test")).toBe("123test");
  expect(typedCapitalize("already Capitalized")).toBe("Already Capitalized");
  expect(typedCapitalize("h")).toBe("H");
});

/**
 * Compares two strings in a way that is not dependent on the current locale.
 */
export function stringCompare(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") throw new HexclaveAssertionError(`Expected two strings for stringCompare, found ${typeof a} and ${typeof b}`, { a, b });
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return cmp(a.toUpperCase(), b.toUpperCase()) || cmp(b, a);
}
import.meta.vitest?.test("stringCompare", ({ expect }) => {
  // Equal strings
  expect(stringCompare("a", "a")).toBe(0);
  expect(stringCompare("", "")).toBe(0);

  // Case comparison - note that this function is NOT case-insensitive
  // It compares uppercase versions first, then original strings
  expect(stringCompare("a", "A")).toBe(-1); // lowercase comes after uppercase
  expect(stringCompare("A", "a")).toBe(1);  // uppercase comes before lowercase
  expect(stringCompare("abc", "ABC")).toBe(-1);
  expect(stringCompare("ABC", "abc")).toBe(1);

  // Different strings
  expect(stringCompare("a", "b")).toBe(-1);
  expect(stringCompare("b", "a")).toBe(1);

  // Strings with different lengths
  expect(stringCompare("abc", "abcd")).toBe(-1);
  expect(stringCompare("abcd", "abc")).toBe(1);

  // Strings with numbers
  expect(stringCompare("a1", "a2")).toBe(-1);
  expect(stringCompare("a10", "a2")).toBe(-1);

  // Strings with special characters
  expect(stringCompare("a", "a!")).toBe(-1);
  expect(stringCompare("a!", "a")).toBe(1);
});

/**
 * Returns all whitespace character at the start of the string.
 *
 * Uses the same definition for whitespace as `String.prototype.trim()`.
 */
export function getWhitespacePrefix(s: string): string {
  return s.substring(0, s.length - s.trimStart().length);
}
import.meta.vitest?.test("getWhitespacePrefix", ({ expect }) => {
  expect(getWhitespacePrefix("")).toBe("");
  expect(getWhitespacePrefix("hello")).toBe("");
  expect(getWhitespacePrefix(" hello")).toBe(" ");
  expect(getWhitespacePrefix("  hello")).toBe("  ");
  expect(getWhitespacePrefix("\thello")).toBe("\t");
  expect(getWhitespacePrefix("\n hello")).toBe("\n ");
  expect(getWhitespacePrefix("   ")).toBe("   ");
  expect(getWhitespacePrefix(" \t\n\r")).toBe(" \t\n\r");
});

/**
 * Returns all whitespace character at the end of the string.
 *
 * Uses the same definition for whitespace as `String.prototype.trim()`.
 */
export function getWhitespaceSuffix(s: string): string {
  return s.substring(s.trimEnd().length);
}
import.meta.vitest?.test("getWhitespaceSuffix", ({ expect }) => {
  expect(getWhitespaceSuffix("")).toBe("");
  expect(getWhitespaceSuffix("hello")).toBe("");
  expect(getWhitespaceSuffix("hello ")).toBe(" ");
  expect(getWhitespaceSuffix("hello  ")).toBe("  ");
  expect(getWhitespaceSuffix("hello\t")).toBe("\t");
  expect(getWhitespaceSuffix("hello \n")).toBe(" \n");
  expect(getWhitespaceSuffix("   ")).toBe("   ");
  expect(getWhitespaceSuffix(" \t\n\r")).toBe(" \t\n\r");
});

/**
 * Returns a string with all empty or whitespace-only lines at the start removed.
 *
 * Uses the same definition for whitespace as `String.prototype.trim()`.
 */
export function trimEmptyLinesStart(s: string): string {
  const lines = s.split("\n");
  const firstNonEmptyLineIndex = lines.findIndex((line) => line.trim() !== "");
  // If all lines are empty or whitespace-only, return an empty string
  if (firstNonEmptyLineIndex === -1) return "";
  return lines.slice(firstNonEmptyLineIndex).join("\n");
}
import.meta.vitest?.test("trimEmptyLinesStart", ({ expect }) => {
  expect(trimEmptyLinesStart("")).toBe("");
  expect(trimEmptyLinesStart("hello")).toBe("hello");
  expect(trimEmptyLinesStart("\nhello")).toBe("hello");
  expect(trimEmptyLinesStart("\n\nhello")).toBe("hello");
  expect(trimEmptyLinesStart("  \n\t\nhello")).toBe("hello");
  expect(trimEmptyLinesStart("\n\nhello\nworld")).toBe("hello\nworld");
  expect(trimEmptyLinesStart("hello\n\nworld")).toBe("hello\n\nworld");
  expect(trimEmptyLinesStart("hello\nworld\n")).toBe("hello\nworld\n");
  expect(trimEmptyLinesStart("\n  \n\nhello\n  \nworld")).toBe("hello\n  \nworld");
  // Edge case: all lines are empty
  expect(trimEmptyLinesStart("\n\n  \n\t")).toBe("");
});

/**
 * Returns a string with all empty or whitespace-only lines at the end removed.
 *
 * Uses the same definition for whitespace as `String.prototype.trim()`.
 */
export function trimEmptyLinesEnd(s: string): string {
  const lines = s.split("\n");
  const lastNonEmptyLineIndex = findLastIndex(lines, (line) => line.trim() !== "");
  return lines.slice(0, lastNonEmptyLineIndex + 1).join("\n");
}
import.meta.vitest?.test("trimEmptyLinesEnd", ({ expect }) => {
  expect(trimEmptyLinesEnd("")).toBe("");
  expect(trimEmptyLinesEnd("hello")).toBe("hello");
  expect(trimEmptyLinesEnd("hello\n")).toBe("hello");
  expect(trimEmptyLinesEnd("hello\n\n")).toBe("hello");
  expect(trimEmptyLinesEnd("hello\n  \n\t")).toBe("hello");
  expect(trimEmptyLinesEnd("hello\nworld\n\n")).toBe("hello\nworld");
  expect(trimEmptyLinesEnd("hello\n\nworld")).toBe("hello\n\nworld");
  expect(trimEmptyLinesEnd("\nhello\nworld")).toBe("\nhello\nworld");
  expect(trimEmptyLinesEnd("hello\n  \nworld\n\n  ")).toBe("hello\n  \nworld");
  // Edge case: all lines are empty
  expect(trimEmptyLinesEnd("\n\n  \n\t")).toBe("");
});

/**
 * Returns a string with all empty or whitespace-only lines trimmed at the start and end.
 *
 * Uses the same definition for whitespace as `String.prototype.trim()`.
 */
export function trimLines(s: string): string {
  return trimEmptyLinesEnd(trimEmptyLinesStart(s));
}
import.meta.vitest?.test("trimLines", ({ expect }) => {
  expect(trimLines("")).toBe("");
  expect(trimLines(" ")).toBe("");
  expect(trimLines(" \n ")).toBe("");
  expect(trimLines(" abc ")).toBe(" abc ");
  expect(trimLines("\n  \nLine1\nLine2\n \n")).toBe("Line1\nLine2");
  expect(trimLines("Line1\n   \nLine2")).toBe("Line1\n   \nLine2");
  expect(trimLines(" \n    \n\t")).toBe("");
  expect(trimLines("   Hello World")).toBe("   Hello World");
  expect(trimLines("\n")).toBe("");
  expect(trimLines("\t \n\t\tLine1 \n \nLine2\t\t\n\t  ")).toBe("\t\tLine1 \n \nLine2\t\t");
});


/**
 * A template literal tag that returns the same string as the template literal without a tag.
 *
 * Useful for implementing your own template literal tags.
 */
export function templateIdentity(strings: TemplateStringsArray | readonly string[], ...values: string[]): string {
  if (values.length !== strings.length - 1) throw new HexclaveAssertionError("Invalid number of values; must be one less than strings", { strings, values });

  return strings.reduce((result, str, i) => result + str + (values[i] ?? ''), '');
}
import.meta.vitest?.test("templateIdentity", ({ expect }) => {
  expect(templateIdentity`Hello World`).toBe("Hello World");
  expect(templateIdentity`${"Hello"}`).toBe("Hello");
  const greeting = "Hello";
  const subject = "World";
  expect(templateIdentity`${greeting}, ${subject}!`).toBe("Hello, World!");
  expect(templateIdentity`${"A"}${"B"}${"C"}`).toBe("ABC");
  expect(templateIdentity`Start${""}Middle${""}End`).toBe("StartMiddleEnd");
  expect(templateIdentity``).toBe("");
  expect(templateIdentity`Line1
Line2`).toBe("Line1\nLine2");
  expect(templateIdentity(["a ", " scientific ", "gun"], "certain", "rail")).toBe("a certain scientific railgun");
  expect(templateIdentity(["only one part"])).toBe("only one part");
  expect(() => templateIdentity(["a ", "b", "c"], "only one")).toThrow("Invalid number of values");
  expect(() => templateIdentity(["a", "b"], "x", "y")).toThrow("Invalid number of values");
});


export function deindent(code: string): string;
export function deindent(strings: TemplateStringsArray | readonly string[], ...values: any[]): string;
export function deindent(strings: string | readonly string[], ...values: any[]): string {
  if (typeof strings === "string") return deindent([strings]);
  return templateIdentity(...deindentTemplate(strings, ...values));
}

export function deindentTemplate(strings: TemplateStringsArray | readonly string[], ...values: any[]): [string[], ...string[]] {
  if (values.length !== strings.length - 1) throw new HexclaveAssertionError("Invalid number of values; must be one less than strings", { strings, values });

  const trimmedStrings = [...strings];
  trimmedStrings[0] = trimEmptyLinesStart(trimmedStrings[0] + "+").slice(0, -1);
  trimmedStrings[trimmedStrings.length - 1] = trimEmptyLinesEnd("+" + trimmedStrings[trimmedStrings.length - 1]).slice(1);

  const indentation = trimmedStrings
    .join("${SOME_VALUE}")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => getWhitespacePrefix(line).length)
    .reduce((min, current) => Math.min(min, current), Infinity);

  const deindentedStrings = trimmedStrings
    .map((string, stringIndex) => {
      return string
        .split("\n")
        .map((line, lineIndex) => stringIndex !== 0 && lineIndex === 0 ? line : line.substring(indentation))
        .join("\n");
    });

  const indentedValues = values.map((value, i) => {
    const firstLineIndentation = getWhitespacePrefix(deindentedStrings[i].split("\n").at(-1)!);
    return `${value}`.replaceAll("\n", `\n${firstLineIndentation}`);
  });

  return [deindentedStrings, ...indentedValues];
}
import.meta.vitest?.test("deindent", ({ expect }) => {
  // Test with string input
  expect(deindent("  hello")).toBe("hello");
  expect(deindent("  hello\n  world")).toBe("hello\nworld");
  expect(deindent("  hello\n    world")).toBe("hello\n  world");
  expect(deindent("\n  hello\n  world\n")).toBe("hello\nworld");

  // Test with empty input
  expect(deindent("")).toBe("");

  // Test with template literal
  expect(deindent`
    hello
    world
  `).toBe("hello\nworld");

  expect(deindent`
    hello
      world
  `).toBe("hello\n  world");

  // Test with values
  const value = "test";
  expect(deindent`
    hello ${value}
    world
  `).toBe(`hello ${value}\nworld`);

  // Test with multiline values
  expect(deindent`
    hello
      to ${"line1\n  line2"}
    world
  `).toBe(`hello\n  to line1\n    line2\nworld`);

  // Leading whitespace values
  expect(deindent`
    ${"  "}A
    ${"  "}B
    ${"  "}C
  `).toBe(`  A\n  B\n  C`);

  // Trailing whitespaces (note: there are two whitespaces each after A and after C)
  expect(deindent`
    A  
    B  ${"  "}
    C  
  `).toBe(`A  \nB    \nC  `);

  // Test with mixed indentation
  expect(deindent`
    hello
      world
        !
  `).toBe("hello\n  world\n    !");

  // Test error cases
  expect(() => deindent(["a", "b", "c"], "too", "many", "values")).toThrow("Invalid number of values");
});

export function extractScopes(scope: string, removeDuplicates=true): string[] {
  // TODO what is this for? can we move this into the OAuth code in the backend?
  const trimmedString = scope.trim();
  const scopesArray = trimmedString.split(/\s+/);
  const filtered = scopesArray.filter(scope => scope.length > 0);
  return removeDuplicates ? [...new Set(filtered)] : filtered;
}
import.meta.vitest?.test("extractScopes", ({ expect }) => {
  // Test with empty string
  expect(extractScopes("")).toEqual([]);

  // Test with single scope
  expect(extractScopes("read")).toEqual(["read"]);

  // Test with multiple scopes
  expect(extractScopes("read write")).toEqual(["read", "write"]);

  // Test with extra whitespace
  expect(extractScopes("  read  write  ")).toEqual(["read", "write"]);

  // Test with newlines and tabs
  expect(extractScopes("read\nwrite\tdelete")).toEqual(["read", "write", "delete"]);

  // Test with duplicates (default behavior)
  expect(extractScopes("read write read")).toEqual(["read", "write"]);

  // Test with duplicates (explicitly set to remove)
  expect(extractScopes("read write read", true)).toEqual(["read", "write"]);

  // Test with duplicates (explicitly set to keep)
  expect(extractScopes("read write read", false)).toEqual(["read", "write", "read"]);
});

export function mergeScopeStrings(...scopes: string[]): string {
  // TODO what is this for? can we move this into the OAuth code in the backend?
  const allScope = scopes.map((s) => extractScopes(s)).flat().join(" ");
  return extractScopes(allScope).join(" ");
}
import.meta.vitest?.test("mergeScopeStrings", ({ expect }) => {
  // Test with empty input
  expect(mergeScopeStrings()).toBe("");

  // Test with single scope string
  expect(mergeScopeStrings("read write")).toBe("read write");

  // Test with multiple scope strings
  expect(mergeScopeStrings("read", "write")).toBe("read write");

  // Test with overlapping scopes
  expect(mergeScopeStrings("read write", "write delete")).toBe("read write delete");

  // Test with extra whitespace
  expect(mergeScopeStrings("  read  write  ", "  delete  ")).toBe("read write delete");

  // Test with duplicates across strings
  expect(mergeScopeStrings("read write", "write delete", "read")).toBe("read write delete");

  // Test with empty strings
  expect(mergeScopeStrings("read write", "", "delete")).toBe("read write delete");
});

export function escapeTemplateLiteral(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}
import.meta.vitest?.test("escapeTemplateLiteral", ({ expect }) => {
  // Test with empty string
  expect(escapeTemplateLiteral("")).toBe("");

  // Test with normal string (no special characters)
  expect(escapeTemplateLiteral("hello world")).toBe("hello world");

  // Test with backtick
  const input1 = "hello `world`";
  const output1 = escapeTemplateLiteral(input1);
  // Verify backticks are escaped
  expect(output1).toBe("hello \\`world\\`");

  // Test with backslash
  const input2 = "hello \\world";
  const output2 = escapeTemplateLiteral(input2);
  // Verify backslashes are escaped
  expect(output2).toBe("hello \\\\world");

  // Test with dollar sign
  const input3 = "hello $world";
  const output3 = escapeTemplateLiteral(input3);
  // Verify dollar signs are escaped
  expect(output3).toBe("hello $world");

  // Test with dollar sign in interpolation
  const input4 = "hello ${$world";
  const output4 = escapeTemplateLiteral(input4);
  // Verify dollar signs are escaped
  expect(output4).toBe("hello \\${$world");

  // Test with multiple special characters
  const input5 = "`hello` ${world\\";
  const output5 = escapeTemplateLiteral(input5);
  // Verify all special characters are escaped
  expect(output5).toBe("\\`hello\\` \\${world\\\\");

  // Test with already escaped characters
  const input6 = "\\`hello\\`";
  const output6 = escapeTemplateLiteral(input6);
  expect(output6).toBe("\\\\\\`hello\\\\\\`");
});

/**
 * Some classes have different constructor names in different environments (eg. `Headers` is sometimes called `_Headers`,
 * so we create an object of overrides to handle these cases.
 */
const nicifiableClassNameOverrides = new Map(Object.entries({
  Headers,
} as Record<string, unknown>).map(([k, v]) => [v, k]));
export type Nicifiable = {
  getNicifiableKeys?(): PropertyKey[],
  getNicifiedObjectExtraLines?(): string[],
};
export type NicifyOptions = {
  maxDepth: number,
  currentIndent: string,
  lineIndent: string,
  multiline: boolean,
  refs: Map<unknown, string>,
  path: string,
  parent: null | {
    options: NicifyOptions,
    value: unknown,
  },
  keyInParent: PropertyKey | null,
  hideFields: PropertyKey[],
  overrides: (...args: Parameters<typeof nicify>) => string | null,
};
export function nicify(
  value: unknown,
  options: Partial<NicifyOptions> = {},
): string {
  const fullOptions: NicifyOptions = {
    maxDepth: 5,
    currentIndent: "",
    lineIndent: "  ",
    multiline: true,
    refs: new Map(),
    path: "value",
    parent: null,
    overrides: () => null,
    keyInParent: null,
    hideFields: [],
    ...filterUndefined(options),
  };
  const {
    maxDepth,
    currentIndent,
    lineIndent,
    multiline,
    refs,
    path,
    overrides,
    hideFields,
  } = fullOptions;
  const nl = `\n${currentIndent}`;

  const overrideResult = overrides(value, options);
  if (overrideResult !== null) return overrideResult;

  if (["function", "object", "symbol"].includes(typeof value) && value !== null) {
    if (refs.has(value)) {
      return `Ref<${refs.get(value)}>`;
    }
    refs.set(value, path);
  }

  const newOptions: NicifyOptions = {
    maxDepth: maxDepth - 1,
    currentIndent,
    lineIndent,
    multiline,
    refs,
    path: path + "->[unknown property]",
    overrides,
    parent: { value, options: fullOptions },
    keyInParent: null,
    hideFields: [],
  };
  const nestedNicify = (newValue: unknown, newPath: string, keyInParent: PropertyKey | null, options: Partial<NicifyOptions> = {}) => {
    return nicify(newValue, {
      ...newOptions,
      path: newPath,
      currentIndent: currentIndent + lineIndent,
      keyInParent,
      ...options,
    });
  };

  switch (typeof value) {
    case "boolean": case "number": {
      return JSON.stringify(value);
    }
    case "string": {
      const isDeindentable = (v: string) => deindent(v) === v && v.includes("\n");
      const wrapInDeindent = (v: string) => deindent`
        deindent\`
        ${currentIndent + lineIndent}${escapeTemplateLiteral(v).replaceAll("\n", nl + lineIndent)}
        ${currentIndent}\`
      `;
      if (isDeindentable(value)) {
        return wrapInDeindent(value);
      } else if (value.endsWith("\n") && isDeindentable(value.slice(0, -1))) {
        return wrapInDeindent(value.slice(0, -1)) + ' + "\\n"';
      } else {
        return JSON.stringify(value);
      }
    }
    case "undefined": {
      return "undefined";
    }
    case "symbol": {
      return value.toString();
    }
    case "bigint": {
      return `${value}n`;
    }
    case "function": {
      if (value.name) return `function ${value.name}(...) { ... }`;
      return `(...) => { ... }`;
    }
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        const extraLines = getNicifiedObjectExtraLines(value);
        const resValueLength = value.length + extraLines.length;
        if (resValueLength === 0) return "[]";  // early return in case maxDepth <= 0
        if (maxDepth <= 0) return `[...]`;
        const resValues = value.map((v, i) => nestedNicify(v, `${path}[${i}]`, i));
        resValues.push(...extraLines);
        if (resValues.length !== resValueLength) throw new HexclaveAssertionError("nicify of object: resValues.length !== resValueLength", { value, resValues, resValueLength });
        const shouldIndent = resValues.length > 4 || resValues.some(x => (resValues.length > 1 && x.length > 4) || x.includes("\n"));
        if (shouldIndent) {
          return `[${nl}${resValues.map(x => `${lineIndent}${x},${nl}`).join("")}]`;
        } else {
          return `[${resValues.join(", ")}]`;
        }
      }
      if (value instanceof Date) {
        return `Date(${nestedNicify(value.toISOString(), `${path}.toISOString()`, null)})`;
      }
      if (value instanceof URL) {
        return `URL(${nestedNicify(value.toString(), `${path}.toString()`, null)})`;
      }
      if (ArrayBuffer.isView(value)) {
        return `${value.constructor.name}([${value.toString()}])`;
      }
      if (value instanceof ArrayBuffer) {
        return `ArrayBuffer [${new Uint8Array(value).toString()}]`;
      }
      if (value instanceof Error) {
        let stack = value.stack ?? "";
        const toString = value.toString();
        if (!stack.startsWith(toString)) stack = `${toString}\n${stack}`;  // some browsers don't include the error message in the stack, some do
        stack = stack.trimEnd();
        stack = stack.replace(/\n\s+/g, `\n${lineIndent}${lineIndent}`);
        stack = stack.replace("\n", `\n${lineIndent}Stack:\n`);
        if (Object.keys(value).length > 0) {
          stack += `\n${lineIndent}Extra properties: ${nestedNicify(Object.fromEntries(Object.entries(value)), path, null)}`;
        }
        if (value.cause) {
          stack += `\n${lineIndent}Cause:\n${lineIndent}${lineIndent}${nestedNicify(value.cause, path, null, { currentIndent: currentIndent + lineIndent + lineIndent })}`;
        }
        stack = stack.replaceAll("\n", `\n${currentIndent}`);
        return stack;
      }

      const constructorName = [null, Object.prototype].includes(Object.getPrototypeOf(value)) ? null : (nicifiableClassNameOverrides.get(value.constructor) ?? value.constructor.name);
      const constructorString = constructorName ? `${constructorName} ` : "";

      const entries = getNicifiableEntries(value).filter(([k]) => !hideFields.includes(k));
      const extraLines = [
        ...getNicifiedObjectExtraLines(value),
        ...hideFields.length > 0 ? [`<some fields may have been hidden>`] : [],
      ];
      const resValueLength = entries.length + extraLines.length;
      if (resValueLength === 0) return `${constructorString}{}`;
      if (maxDepth <= 0) return `${constructorString}{ ... }`;
      const resValues = entries.map(([k, v], keyIndex) => {
        const keyNicified = nestedNicify(k, `Object.keys(${path})[${keyIndex}]`, null);
        const keyInObjectLiteral = typeof k === "string" ? nicifyPropertyString(k) : `[${keyNicified}]`;
        if (typeof v === "function" && v.name === k) {
          return `${keyInObjectLiteral}(...): { ... }`;
        } else {
          return `${keyInObjectLiteral}: ${nestedNicify(v, `${path}[${keyNicified}]`, k)}`;
        }
      });
      resValues.push(...extraLines);
      if (resValues.length !== resValueLength) throw new HexclaveAssertionError("nicify of object: resValues.length !== resValueLength", { value, resValues, resValueLength });
      const shouldIndent = resValues.length > 1 || resValues.some(x => x.includes("\n"));

      if (resValues.length === 0) return `${constructorString}{}`;
      if (shouldIndent) {
        return `${constructorString}{${nl}${resValues.map(x => `${lineIndent}${x},${nl}`).join("")}}`;
      } else {
        return `${constructorString}{ ${resValues.join(", ")} }`;
      }
    }
    default: {
      return `${typeof value}<${value}>`;
    }
  }
}

export function replaceAll(input: string, searchValue: string, replaceValue: string): string {
  if (searchValue === "") throw new HexclaveAssertionError("replaceAll: searchValue is empty");
  return input.split(searchValue).join(replaceValue);
}
import.meta.vitest?.test("replaceAll", ({ expect }) => {
  expect(replaceAll("hello world", "o", "x")).toBe("hellx wxrld");
  expect(replaceAll("aaa", "a", "b")).toBe("bbb");
  expect(replaceAll("", "a", "b")).toBe("");
  expect(replaceAll("abc", "b", "")).toBe("ac");
  expect(replaceAll("test.test.test", ".", "_")).toBe("test_test_test");
  expect(replaceAll("a.b*c", ".", "x")).toBe("axb*c");
  expect(replaceAll("a*b*c", "*", "x")).toBe("axbxc");
  expect(replaceAll("hello hello", "hello", "hi")).toBe("hi hi");
});

function nicifyPropertyString(str: string) {
  return JSON.stringify(str);
}
import.meta.vitest?.test("nicifyPropertyString", ({ expect }) => {
  // Test valid identifiers
  expect(nicifyPropertyString("validName")).toBe('"validName"');
  expect(nicifyPropertyString("_validName")).toBe('"_validName"');
  expect(nicifyPropertyString("valid123Name")).toBe('"valid123Name"');

  // Test invalid identifiers
  expect(nicifyPropertyString("123invalid")).toBe('"123invalid"');
  expect(nicifyPropertyString("invalid-name")).toBe('"invalid-name"');
  expect(nicifyPropertyString("invalid space")).toBe('"invalid space"');
  expect(nicifyPropertyString("$invalid")).toBe('"$invalid"');
  expect(nicifyPropertyString("")).toBe('""');

  // Test with special characters
  expect(nicifyPropertyString("property!")).toBe('"property!"');
  expect(nicifyPropertyString("property.name")).toBe('"property.name"');

  // Test with escaped characters
  expect(nicifyPropertyString("\\")).toBe('"\\\\"');
  expect(nicifyPropertyString('"')).toBe('"\\""');
});

function getNicifiableKeys<T extends object>(value: Nicifiable | T) {
  const overridden = ("getNicifiableKeys" in value ? value.getNicifiableKeys?.bind(value) : null)?.();
  if (overridden != null) return overridden;
  if (value instanceof Response) {
    return ['status', 'headers'];
  }
  const keys = Object.keys(value).sort();
  return unique(keys);
}
import.meta.vitest?.test("getNicifiableKeys", ({ expect }) => {
  // Test regular object
  expect(getNicifiableKeys({ b: 1, a: 2, c: 3 })).toEqual(["a", "b", "c"]);

  // Test empty object
  expect(getNicifiableKeys({})).toEqual([]);


  expect(getNicifiableKeys(new Response())).toEqual(["status", "headers"]);

  // Test object with custom getNicifiableKeys
  const customObject = {
    a: 1,
    b: 2,
    getNicifiableKeys() {
      return ["customKey1", "customKey2"];
    }
  };
  expect(getNicifiableKeys(customObject)).toEqual(["customKey1", "customKey2"]);
});

function getNicifiableEntries<T extends object>(value: Nicifiable | T): [PropertyKey, unknown][] {
  const recordLikes = [Headers];
  function isRecordLike(value: unknown): value is InstanceType<typeof recordLikes[number]> {
    return recordLikes.some(x => value instanceof x);
  }

  if (isRecordLike(value)) {
    return [...value.entries()].sort(([a], [b]) => stringCompare(`${a}`, `${b}`));
  }
  const keys = getNicifiableKeys(value);
  return keys.map((k) => [k, Object.getOwnPropertyDescriptor(value, k)?.value] as [PropertyKey, unknown]);
}

function getNicifiedObjectExtraLines<T extends object>(value: Nicifiable | T) {
  return ("getNicifiedObjectExtraLines" in value ? value.getNicifiedObjectExtraLines : null)?.() ?? [];
}
