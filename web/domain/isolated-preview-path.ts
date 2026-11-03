import { isWorkspaceDemoPath } from "./workspace-demo/demo-path";

export function isIsolatedPreviewPath(pathname: string | null | undefined): boolean {
  return (
    pathname === "/demo-spaces" ||
    Boolean(pathname?.startsWith("/demo-spaces/")) ||
    isWorkspaceDemoPath(pathname) ||
    pathname === "/updates/preview" ||
    Boolean(pathname?.startsWith("/updates/preview/"))
  );
}
