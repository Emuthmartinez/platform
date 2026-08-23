import {
  ACOPIO_EDIT_TOKENS_KEY,
  ACOPIO_EDIT_TOKENS_LEGACY_KEY,
} from "@/lib/browser-storage-registry";

function readMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    migrateLegacy();
    const raw = window.localStorage.getItem(ACOPIO_EDIT_TOKENS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function migrateLegacy(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(ACOPIO_EDIT_TOKENS_KEY) !== null) return;
    const legacy = window.localStorage.getItem(ACOPIO_EDIT_TOKENS_LEGACY_KEY);
    if (legacy === null) return;
    window.localStorage.setItem(ACOPIO_EDIT_TOKENS_KEY, legacy);
    window.localStorage.removeItem(ACOPIO_EDIT_TOKENS_LEGACY_KEY);
  } catch {
    /* private mode / blocked storage */
  }
}

export function saveAcopioEditToken(reportId: string, token: string): void {
  if (typeof window === "undefined") return;
  const next = { ...readMap(), [reportId]: token };
  window.localStorage.setItem(ACOPIO_EDIT_TOKENS_KEY, JSON.stringify(next));
}

export function getAcopioEditToken(reportId: string): string | null {
  const token = readMap()[reportId];
  return token && token.length > 0 ? token : null;
}

export function acopioReportId(centerId: string): string | null {
  return centerId.startsWith("report:") ? centerId.slice("report:".length) : null;
}
