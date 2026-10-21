import { useEffect, useState } from "react";

/** History-based router for three routes. */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const onChange = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onChange);
    // A child effect may have navigated before this subscription.
    onChange();
    return () => window.removeEventListener("popstate", onChange);
  }, []);

  return pathname;
}
