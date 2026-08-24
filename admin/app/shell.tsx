"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/src/ui";
import { AdminGate } from "../src/shared/auth/admin-gate";
import { useAdminSessionContext } from "../src/shared/auth/admin-session-context";
import { MODELS } from "../src/contexts/models/model-registry";
import { fetchSignalsPage, signalsQueryKey } from "../src/contexts/family-search/api";

/**
 * Shell autenticado: header con email + logout y navegación lateral filtrada por
 * capacidad (solo aparecen los modelos que el usuario puede leer; admin "*" ve
 * todo). Envuelve el contenido en AdminGate (login si no hay sesión).
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <AdminGate>
      <AuthedShell>{children}</AuthedShell>
    </AdminGate>
  );
}

/**
 * U15 (R26/AE4 — discoverability): conteo de señales pendientes para el
 * badge del enlace "Búsqueda de familias". `GET /api/public/record-signals`
 * (record-signals.router.ts) NO expone un total — solo `items` de la página
 * pedida — así que se pide una página CHICA (`NAV_BADGE_PAGE_LIMIT`) y se usa
 * `items.length` como aproximación: si llega exactamente al límite puede
 * haber más de las que se pidieron, así que el badge muestra "9+" en ese
 * caso (nunca un número exacto que podría estar mal) — mismo estilo que
 * cualquier badge de notificación con overflow. Cadencia de refetch: family-
 * search no tenía un polling propio del que heredar (review-queue.tsx usa
 * solo fetch-on-mount/invalidación); se toma prestada la cadencia de
 * `useSupplyBoard` (hospital-supplies/use-hospital-supplies.ts,
 * `refetchInterval: 60_000`) como el precedente más cercano de "badge
 * auxiliar liviano" en este repo — ver informe de U15 para la deviation.
 */
const NAV_BADGE_PAGE_LIMIT = 10;
const NAV_BADGE_POLL_MS = 60_000;

function usePendingSignalsBadge(enabled: boolean): string | null {
  // Key = signalsQueryKey() + un sufijo — a propósito UN string MÁS LARGO que
  // el key que usa signal-queue.tsx (["family-search-signals"]) y no el
  // mismo: TanStack Query invalida por coincidencia PARCIAL (prefijo), así
  // que `invalidateKeys: [signalsQueryKey()]` de useDecisionMutation (en
  // signal-queue.tsx) también refresca ESTA query sin cambios adicionales —
  // confirmar/descartar una señal actualiza el badge al instante, sin
  // esperar los 60s del polling.
  const query = useQuery({
    queryKey: [...signalsQueryKey(), "nav-badge"] as const,
    queryFn: () => fetchSignalsPage({ limit: NAV_BADGE_PAGE_LIMIT }),
    enabled,
    refetchInterval: enabled ? NAV_BADGE_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  const count = query.data?.items.length ?? 0;
  if (count === 0) return null;
  return count >= NAV_BADGE_PAGE_LIMIT ? "9+" : String(count);
}

function AuthedShell({ children }: { children: ReactNode }) {
  const { user, can, logout } = useAdminSessionContext();
  const pathname = usePathname();
  const visible = MODELS.filter((m) => can(m.readCapability));
  // Gateado a person:search (misma capacidad mínima que el link/panel) — sin
  // ella la query ni se dispara, evitando un 403 previsible contra el BFF.
  const pendingSignalsBadge = usePendingSignalsBadge(can("person:search"));

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between bg-brand-navy px-6 py-3 text-white">
        <Link href="/" className="text-lg font-bold">
          Terremoto Colombia · Administración
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-white/70">{user?.email}</span>
          <Button
            type="button"
            variant="ghost"
            className="text-white hover:bg-white/10"
            onClick={() => void logout()}
          >
            Salir
          </Button>
        </div>
      </header>

      <div className="flex flex-1">
        <nav className="w-52 shrink-0 border-r border-border-soft bg-white p-4">
          <ul className="flex flex-col gap-1">
            {visible.map((m) => (
              <NavLink key={m.path} href={`/${m.path}`} label={m.label} pathname={pathname} />
            ))}
            {can("patient:import") && (
              <NavLink href="/patient-imports" label="Importar pacientes" pathname={pathname} />
            )}
            {can("missing:create") && (
              <NavLink href="/deceased-imports" label="Importar fallecidos" pathname={pathname} />
            )}
            {/* Family Search (U9/U11/U15): cola de revisión de coincidencias +
                señales de estado de socios + ficha de identidad.
                person:search es la capacidad de lectura mínima del contexto
                (person:review/person:merge gatean acciones puntuales dentro
                de la pantalla). El badge (U15, R26/AE4) es el requisito de
                discoverability: un "reportada encontrada" de un socio nunca
                debe quedar sin ver — ver usePendingSignalsBadge arriba. */}
            {can("person:search") && (
              <NavLink
                href="/family-search"
                label="Búsqueda de familias"
                pathname={pathname}
                badge={pendingSignalsBadge}
              />
            )}
            {/* Insumos hospitalarios: agregado restringido sobre el modelo
                hospital — misma capacidad de lectura que /hospitals. */}
            {can("hospital:read") && (
              <NavLink
                href="/hospital-supplies"
                label="Insumos hospitalarios"
                pathname={pathname}
              />
            )}
            {can("volunteer:read") && (
              <NavLink
                href="/volunteer-analytics"
                label="Analítica de voluntarios"
                pathname={pathname}
              />
            )}
            {visible.length === 0 && (
              <li className="px-3 py-2 text-sm text-ink-muted">Sin permisos de lectura.</li>
            )}
          </ul>

          {/* Self-service: gestionar TUS propias API keys. apikey:manage está
              sembrada en todos los roles, así que cualquier usuario invitado lo ve. */}
          {can("apikey:manage") && (
            <ul className="mt-1 flex flex-col gap-1">
              <NavLink href="/api-keys" label="API Keys" pathname={pathname} />
            </ul>
          )}

          {/* Superadmin: réplica pública + catálogo de deployments. */}
          {(can("mirror:manage") || can("deployment:manage")) && (
            <ul className="mt-1 flex flex-col gap-1">
              {can("mirror:manage") && (
                <NavLink href="/hub-credentials" label="Réplica pública" pathname={pathname} />
              )}
              {can("deployment:manage") && (
                <NavLink href="/deployments" label="Deployments" pathname={pathname} />
              )}
            </ul>
          )}

          {/* Administración RBAC — cada enlace gateado por su capacidad. La
              gestión de usuarios (incluida la invitación) vive en /users. */}
          {(can("role:read") ||
            can("user:read") ||
            can("user:invite") ||
            can("grant:read") ||
            can("audit:read")) && (
            <>
              <h3 className="mt-6 mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Administración
              </h3>
              <ul className="flex flex-col gap-1">
                {(can("user:read") || can("user:invite")) && (
                  <NavLink href="/users" label="Usuarios" pathname={pathname} />
                )}
                {can("role:read") && <NavLink href="/roles" label="Roles" pathname={pathname} />}
                {can("grant:read") && <NavLink href="/grants" label="Grants" pathname={pathname} />}
                {can("audit:read") && (
                  <NavLink href="/audit" label="Auditoría" pathname={pathname} />
                )}
              </ul>
            </>
          )}
        </nav>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  label,
  pathname,
  badge,
}: {
  href: string;
  label: string;
  pathname: string;
  /** U15: conteo de señales pendientes ("9+" en overflow), null = sin
   *  badge (cero pendientes NO renderiza nada, ver usePendingSignalsBadge). */
  badge?: string | null;
}) {
  const active = pathname === href;
  return (
    <li>
      <Link
        href={href}
        className={[
          "flex items-center justify-between gap-2 rounded-full px-3 py-2 text-sm",
          active ? "bg-brand-navy text-white" : "hover:bg-brand-blue-light",
        ].join(" ")}
      >
        <span>{label}</span>
        {badge && (
          <span
            data-testid="nav-pending-signals-badge"
            className="rounded-full bg-crisis px-1.5 py-0.5 text-xs font-semibold leading-none text-white"
          >
            {badge}
          </span>
        )}
      </Link>
    </li>
  );
}
