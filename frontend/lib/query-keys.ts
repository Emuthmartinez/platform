/**
 * Fábrica central de queryKeys. TODA query usa estas claves — NUNCA arrays
 * inline. Razón: la dedup y la invalidación de TanStack Query se basan en
 * igualdad de la queryKey; dos componentes que pidan lo mismo DEBEN usar la
 * MISMA clave o se dispara doble request (el bug que teníamos: carousel + lista
 * polleaban /api/missing por separado). Centralizar las claves lo garantiza.
 *
 * Convención: [organizationId, incidentId, cacheEpoch, dominio, sub, ...params]
 * excepto earthquakes (KTD10, catálogo global). Las invalidaciones por prefijo
 * (queryClient.invalidateQueries({ queryKey: qk.missing.all })) limpian todo el
 * dominio de este incidente tras una mutación.
 */
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
  TENANT_CACHE_EPOCH,
} from "@/lib/tenant";

const TENANT = [
  COLOMBIA_ORGANIZATION_ID,
  COLOMBIA_INCIDENT_ID,
  TENANT_CACHE_EPOCH,
] as const;

function t<Rest extends readonly unknown[]>(
  ...rest: Rest
): readonly [...typeof TENANT, ...Rest] {
  return [...TENANT, ...rest] as const;
}

export const qk = {
  missing: {
    all: t("missing"),
    list: (p: { status: string; page: number; pageSize: number; q?: string }) =>
      t("missing", "list", p),
    map: (bounds: { north: number; south: number; east: number; west: number } | null) =>
      t("missing", "map", bounds),
    stats: t("missing", "stats"),
  },
  deceased: {
    all: t("deceased"),
    list: (p: { page: number; pageSize: number; q?: string }) =>
      t("deceased", "list", p),
  },
  // Dominio APARTE de `missing` (tabla y endpoints distintos, ver
  // backend/src/services/pets.ts). Invalidar mascotas nunca toca personas.
  pets: {
    all: t("pets"),
    list: (p: {
      status: string;
      page: number;
      pageSize: number;
      q?: string;
      species?: string;
    }) => t("pets", "list", p),
    map: (bounds: { north: number; south: number; east: number; west: number } | null) =>
      t("pets", "map", bounds),
    stats: t("pets", "stats"),
  },
  reports: {
    all: t("reports"),
    list: t("reports", "list"),
  },
  earthquakes: {
    all: ["g", "earthquakes"] as const,
    list: ["g", "earthquakes", "list"] as const,
  },
  hospitals: {
    all: t("hospitals"),
    list: (p?: Record<string, unknown>) => t("hospitals", "list", p ?? {}),
    patients: (hospitalId: string) => t("hospitals", hospitalId, "patients"),
    supplies: (hospitalId: string) => t("hospitals", hospitalId, "supplies"),
    patientSearch: (q: string) => t("hospitals", "patient-search", q),
  },
  chat: {
    all: t("chat"),
    list: (role?: string) => t("chat", "list", role ?? "all"),
  },
  contact: {
    all: t("contact"),
  },
  acopio: {
    all: t("acopio"),
    list: (p: { country?: string; category?: string; q?: string }) =>
      t("acopio", "list", p),
  },
  needs: {
    all: t("needs"),
    publication: (jobId: string | null) => t("needs", "publication", jobId),
  },
  geocode: (q: string) => t("geocode", q),
  offlineDrafts: t("offline-drafts"),
} as const;
