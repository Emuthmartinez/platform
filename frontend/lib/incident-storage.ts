/**
 * Incident-scoped localStorage keys, with a one-time copy from a legacy key.
 * Do not use this helper for auth or session tokens.
 */
export function migrateLegacyLocalStorage(
  legacyKey: string,
  scopedKey: string,
): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(scopedKey) !== null) return;
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy === null) return;
    window.localStorage.setItem(scopedKey, legacy);
    window.localStorage.removeItem(legacyKey);
  } catch {
    /* private mode / blocked storage */
  }
}

export function readLocalStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage */
  }
}
