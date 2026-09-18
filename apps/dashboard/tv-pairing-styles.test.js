import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

describe("TV pairing viewport fallback", () => {
  it.each([
    ["./src/app/tv/pairing-screen.module.css", ".copy, .pending", ".footnote, .warning, .kicker"],
    ["./public/tv-box/tv-box.css", ".tv-pairing-copy, .tv-pairing-pending", ".tv-pairing-footnote, .tv-pairing-warning, .tv-pairing-card > .tv-kicker"],
  ])("bounds portrait helper typography by viewport height in %s", (file, copy, footnote) => {
    const css = postcss.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    const sizes = new Map();
    css.walkAtRules("media", (rule) => {
      if (rule.params !== "(max-width: 600px) and (orientation: portrait)") return;
      rule.walkDecls("font-size", (declaration) => sizes.set(declaration.parent.selector, declaration.value));
    });
    expect(sizes.get(copy)).toBe("min(0.875rem, 2.8vh)");
    expect(sizes.get(footnote)).toBe("min(0.75rem, 2.4vh)");
  });

  it.each([
    ["./src/app/tv/pairing-screen.module.css", ".stage"],
    ["./public/tv-box/tv-box.css", ".tv-pairing-stage"],
  ])("keeps a usable vh base and gates svh in %s", (file, selector) => {
    const css = postcss.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
    const declarations = [];
    css.walkDecls("--pairing-unit", (declaration) => declarations.push(declaration));
    expect(declarations).toHaveLength(2);
    const [base, override] = declarations;
    expect(base.value).toBe("min(1rem, 1.85vh, 1.9vw)");
    expect(base.parent.selector).toBe(selector);
    expect(base.parent.parent.type).toBe("root");
    expect(override.value).toBe("min(1rem, 1.85svh, 1.9vw)");
    expect(override.parent.selector).toBe(selector);
    expect(override.parent.parent.type).toBe("atrule");
    expect(override.parent.parent.name).toBe("supports");
    expect(override.parent.parent.params).toBe("(height: 1svh)");
  });
});
