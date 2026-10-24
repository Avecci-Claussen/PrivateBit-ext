/** Appearance choice. Dark is the default for every new install, ignoring the OS. */

export const THEME_KEY = "privatebit.theme";

export type ThemeChoice = "dark" | "light" | "system";

export const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "dark", label: "Dark (default)" },
  { id: "light", label: "Light" },
  { id: "system", label: "Match system" },
];

export const DEFAULT_THEME: ThemeChoice = "dark";

export function normalizeTheme(raw: unknown): ThemeChoice {
  return raw === "light" || raw === "system" || raw === "dark" ? raw : DEFAULT_THEME;
}

/** Value written to html data-theme. Missing or "dark" both mean dark in CSS. */
export function themeAttr(choice: ThemeChoice): ThemeChoice {
  return choice;
}

/** Concrete colors after resolving Match system against prefers-color-scheme. */
export function resolvedTheme(choice: ThemeChoice, prefersDark: boolean): "dark" | "light" {
  if (choice === "light") return "light";
  if (choice === "system") return prefersDark ? "dark" : "light";
  return "dark";
}
