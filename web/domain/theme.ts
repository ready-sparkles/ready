export const READY_THEME_STORAGE_KEY = "ready:appearance";
export const READY_FIXED_LIGHT_PATHS = [
  "/",
  "/about",
  "/updates",
  "/admin",
  "/demo",
  "/docs",
  "/pricing",
  "/privacy",
  "/terms",
  "/login",
  "/signup",
] as const;

export type ReadyTheme = "light" | "dark";

export function isReadyTheme(value: unknown): value is ReadyTheme {
  return value === "light" || value === "dark";
}

export function readStoredTheme(storage: Pick<Storage, "getItem"> | null): ReadyTheme {
  if (storage === null) {
    return "light";
  }

  try {
    const storedTheme = storage.getItem(READY_THEME_STORAGE_KEY);

    return isReadyTheme(storedTheme) ? storedTheme : "light";
  } catch (error) {
    if (error instanceof Error) {
      return "light";
    }

    return "light";
  }
}

export function supportsReadyAppearance(pathname: string | null | undefined): boolean {
  const trimmedPathname = pathname?.trim() ?? "";
  const normalizedPathname = trimmedPathname.length > 0 ? trimmedPathname : "/";

  return !READY_FIXED_LIGHT_PATHS.some((fixedPath) =>
    fixedPath === "/"
      ? normalizedPathname === fixedPath
      : normalizedPathname === fixedPath || normalizedPathname.startsWith(`${fixedPath}/`),
  );
}

export function applyReadyTheme(input: { root: HTMLElement; theme: ReadyTheme }): void {
  const element = input.root;
  element.dataset.theme = input.theme;
  element.classList.toggle("dark", input.theme === "dark");
  element.style.colorScheme = input.theme;
}
