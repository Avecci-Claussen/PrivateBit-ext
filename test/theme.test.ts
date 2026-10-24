import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, normalizeTheme, resolvedTheme, themeAttr } from "../src/lib/theme.ts";

describe("theme resolution", () => {
  it("defaults to dark when unset or unknown", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(normalizeTheme(undefined)).toBe("dark");
    expect(normalizeTheme(null)).toBe("dark");
    expect(normalizeTheme("")).toBe("dark");
    expect(normalizeTheme("nope")).toBe("dark");
    expect(normalizeTheme({ id: "light" })).toBe("dark");
  });

  it("keeps Dark, Light and Match system", () => {
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("system")).toBe("system");
  });

  it("writes dark, light or system onto html data-theme", () => {
    expect(themeAttr("dark")).toBe("dark");
    expect(themeAttr("light")).toBe("light");
    expect(themeAttr("system")).toBe("system");
  });

  it("resolves Match system from prefers-color-scheme and ignores OS when Dark or Light is set", () => {
    expect(resolvedTheme("dark", false)).toBe("dark");
    expect(resolvedTheme("dark", true)).toBe("dark");
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("light", false)).toBe("light");
    expect(resolvedTheme("system", true)).toBe("dark");
    expect(resolvedTheme("system", false)).toBe("light");
  });
});
