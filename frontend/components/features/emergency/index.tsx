"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  MAP_REPORT_TYPE_KEYS,
  REPORT_TYPE_KEYS,
  type EmergencyReport,
  type ReportType,
} from "@/lib/types";
import { distanceMeters } from "@/lib/format";
import { chipFitPoints } from "./chip-fit";
import { deploymentConfig } from "@/lib/deployment-config";
import { qk } from "@/lib/query-keys";
import {
  ADMIN_SESSION_TOKEN_KEY,
  CONFIRMED_REPORTS_KEY,
  CONFIRMED_REPORTS_LEGACY_KEY,
} from "@/lib/browser-storage-registry";
import { migrateLegacyLocalStorage } from "@/lib/incident-storage";
import { flushReadyDrafts } from "@/lib/offline-draft-flush";
import { OfflineDraftQuotaError } from "@/lib/offline-draft-protocol";
import {
  useReports,
  useMissingMap,
  useEarthquakes,
  useConfirmReport,
  useResolveReport,
  type ReportsResponse,
} from "@/hooks/emergency";
import { usePetsMap } from "@/hooks/pets";
import { useCollectionCenters, ACOPIO_DEFAULT_FILTERS } from "@/hooks/acopio";
import { useLowBandwidthMode } from "@/hooks/useLowBandwidthMode";
import { useMissingStats } from "@/hooks/missing";
import type { MapBounds } from "@/components/features/map";
import type { GeocodeResult } from "@/components/features/emergency/AddressSearch";
import {
  countPending,
  enqueueReport,
  listReadyDrafts,
  removePending,
  type QueuedPayload,
} from "@/lib/offline-queue";
import {
  postReportToServer,
  type ReportSubmission,
} from "./post-report";
import MapPanel from "./MapPanel";
import MapTutorialButton from "./MapTutorial";
import ReportComposer, { type ReportComposerSubmit } from "./ReportComposer";
import OfflineDraftBanner from "./OfflineDraftBanner";
import AdminPanel from "./AdminPanel";
import { Check, Link2 } from "lucide-react";

const DUPLICATE_RADIUS_M = 50;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const OPEN_EMERGENCY_REPORT_EVENT = "open-emergency-report";

// Centro por defecto del mapa (config/deployment.config.json → mapCenter).
// Las búsquedas de direcciones priorizan resultados cercanos a este punto.
const DEFAULT_MAP_CENTER: [number, number] = deploymentConfig.mapCenter;
const AFFECTED_CENTER: { lat: number; lng: number } = {
  lat: DEFAULT_MAP_CENTER[0],
  lng: DEFAULT_MAP_CENTER[1],
};
const POLL_INTERVAL_MS = 10_000;
const LOW_BANDWIDTH_POLL_INTERVAL_MS = 45_000;
// Debounce de bounds del mapa: evita un request por cada frame de pan/zoom.
const MAP_BOUNDS_DEBOUNCE_MS = 350;

export default function EmergencyApp() {
  const qc = useQueryClient();
  const network = useLowBandwidthMode(
    POLL_INTERVAL_MS,
    LOW_BANDWIDTH_POLL_INTERVAL_MS,
  );

  // --- Datos vía TanStack Query ---
  const reportsQuery = useReports(network.pollIntervalMs);
  const reports = useMemo(
    () => reportsQuery.data?.reports ?? [],
    [reportsQuery.data],
  );
  const persistent = reportsQuery.data?.persistent ?? true;

  // Bounds del mapa: ref para el valor inmediato + estado debounced que alimenta
  // la query de marcadores (un request por cada ~350ms de pan, no por frame).
  const [debouncedBounds, setDebouncedBounds] = useState<MapBounds | null>(null);
  const boundsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missingMapQuery = useMissingMap(debouncedBounds);
  // Mismo queryKey que EarthquakesPanel: TanStack deduplica por clave,
  // asi que tener dos consumidores no dispara una segunda peticion.
  const { data: earthquakesEnvelope } = useEarthquakes(60_000);
  const earthquakes = earthquakesEnvelope?.earthquakes;
  const missingMapMarkers = useMemo(
    () => missingMapQuery.data ?? [],
    [missingMapQuery.data],
  );
  // Mascotas: query y capa APARTE de las personas (endpoint y tabla propios).
  const petsMapQuery = usePetsMap(debouncedBounds);
  const petMapMarkers = useMemo(() => petsMapQuery.data ?? [], [petsMapQuery.data]);
  // Visibles por defecto: la capa solo se pinta si hay marcadores, así que
  // encenderla no añade ruido cuando todavía no hay mascotas reportadas.
  const [showPetsOnMap, setShowPetsOnMap] = useState(true);
  const togglePets = useCallback(() => setShowPetsOnMap((v) => !v), []);

  // Centros de acopio oficiales (capa verde, /api/acopio — siempre montado).
  const acopioQuery = useCollectionCenters(ACOPIO_DEFAULT_FILTERS);
  const acopioCenters = useMemo(
    () =>
      (acopioQuery.data?.items ?? []).filter(
        (center) => center.verificationLevel === "official",
      ),
    [acopioQuery.data],
  );
  const [showAcopioOnMap, setShowAcopioOnMap] = useState(true);
  const toggleAcopio = useCallback(() => setShowAcopioOnMap((v) => !v), []);

  const confirmMutation = useConfirmReport();
  const resolveMutation = useResolveReport();

  // Helper: actualiza la lista de reportes en cache (updates optimistas).
  const patchReports = useCallback(
    (fn: (prev: EmergencyReport[]) => EmergencyReport[]) => {
      qc.setQueryData<ReportsResponse>(qk.reports.list, (prev) =>
        prev
          ? { ...prev, reports: fn(prev.reports) }
          : {
              reports: fn([]),
              persistent: true,
              total: 0,
              page: 1,
              pageSize: 500,
              totalPages: 1,
            },
      );
    },
    [qc],
  );

  const [draft, setDraft] = useState<{ lat: number; lng: number } | null>(null);
  // Filtro multi-selección inclusivo: se muestran TODOS los tipos elegidos
  // (unión). Por defecto solo viene activo un tipo; el resto se enciende al
  // tocar su chip (cada chip prende/apaga su capa en el mapa).
  const [selectedTypes, setSelectedTypes] = useState<Set<ReportType>>(
    () => new Set<ReportType>(MAP_REPORT_TYPE_KEYS),
  );
  const [confirmed, setConfirmed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      migrateLegacyLocalStorage(
        CONFIRMED_REPORTS_LEGACY_KEY,
        CONFIRMED_REPORTS_KEY,
      );
      const stored = localStorage.getItem(CONFIRMED_REPORTS_KEY);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });
  // Modo "colocar reporte": el próximo toque del mapa ubica el reporte. Evita
  // que un clic accidental abra el formulario.
  const [placing, setPlacing] = useState(false);
  // El formulario de reporte está abierto (independiente de si ya hay ubicación).
  const [reportOpen, setReportOpen] = useState(false);
  // Pedido de encuadre del mapa a los pines de un filtro (se actualiza al tocar
  // un chip de tipo).
  const [fitRequest, setFitRequest] = useState<{
    points: { lat: number; lng: number }[];
    ts: number;
  } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [queuedFlash, setQueuedFlash] = useState(false);
  const flushingRef = useRef(false);
  const [adminToken, setAdminToken] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : sessionStorage.getItem(ADMIN_SESSION_TOKEN_KEY),
  );
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [focus, setFocus] = useState<{
    lat: number;
    lng: number;
    ts: number;
    id?: string;
  } | null>(() => {
    // Enlace profundo: si la URL trae lat/lng (link compartido de un reporte),
    // arrancamos con el foco en ese punto para que el mapa vuele hasta él.
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const latRaw = params.get("lat");
    const lngRaw = params.get("lng");
    if (!latRaw || !lngRaw) return null;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, ts: Date.now() };
  });
  // Query compartida (qk.missing.stats): un solo poll de /api/missing/stats para
  // toda la página — la navbar y el carousel usan la MISMA clave, así que
  // TanStack dedup a un único request y una única entrada de caché.
  const missingStats = useMissingStats().data ?? null;

  const isAdmin = Boolean(adminToken);

  // Esc cierra en cascada: primero "elegir en el mapa", luego el formulario de
  // reporte, luego el login de admin. Usamos fase de CAPTURA porque Leaflet
  // tiene su propio handler de teclado en el contenedor del mapa que se come el
  // Escape; capturar en window lo intercepta antes, sin depender del foco.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (placing) setPlacing(false);
      else if (reportOpen) {
        setReportOpen(false);
        setDraft(null);
      } else if (showAdminLogin) setShowAdminLogin(false);
      else return;
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [placing, reportOpen, showAdminLogin]);

  const loginAdmin = useCallback((token: string) => {
    sessionStorage.setItem(ADMIN_SESSION_TOKEN_KEY, token);
    setAdminToken(token);
    setShowAdminLogin(false);
  }, []);

  const logoutAdmin = useCallback(() => {
    sessionStorage.removeItem(ADMIN_SESSION_TOKEN_KEY);
    setAdminToken(null);
  }, []);

  const handleBoundsChange = useCallback((bounds: MapBounds) => {
    if (boundsTimer.current) clearTimeout(boundsTimer.current);
    boundsTimer.current = setTimeout(() => {
      setDebouncedBounds(bounds);
    }, MAP_BOUNDS_DEBOUNCE_MS);
  }, []);

  const handleConfirm = useCallback(
    (id: string) => {
      setConfirmed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        try {
          localStorage.setItem(CONFIRMED_REPORTS_KEY, JSON.stringify([...next]));
        } catch {
          /* localStorage puede no estar disponible */
        }
        return next;
      });
      patchReports((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, confirmations: r.confirmations + 1 } : r,
        ),
      );
      confirmMutation.mutate(id, {
        onError: () => {
          // El servidor rechazó (dedup u otro): refrescamos para reconciliar.
          qc.invalidateQueries({ queryKey: qk.reports.all });
        },
      });
    },
    [patchReports, confirmMutation, qc],
  );

  // Auto-flush only `ready` drafts (Turnstile off / local). Migrated v1
  // drafts stay as verification_required until the person sends them.
  const flushPending = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const ready = await listReadyDrafts();
      await flushReadyDrafts({
        drafts: ready,
        post: postReportToServer,
        remove: removePending,
        onAccepted: (created) => {
          if (!created) return;
          patchReports((prev) =>
            prev.some((r) => r.id === created.id) ? prev : [created, ...prev],
          );
        },
      });
    } finally {
      flushingRef.current = false;
      try {
        setPendingCount(await countPending());
        void qc.invalidateQueries({ queryKey: qk.offlineDrafts });
      } catch {
        /* IndexedDB no disponible: dejamos el contador como está */
      }
    }
  }, [patchReports, qc]);

  // Cuenta pendientes al cargar, intenta enviarlos y reintenta al recuperar la
  // conexión (el evento "online" del navegador).
  useEffect(() => {
    flushPending();
    const onOnline = () => flushPending();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [flushPending]);

  // Mientras queden pendientes, reintenta periódicamente por si la conexión
  // volvió de forma intermitente sin disparar el evento "online".
  useEffect(() => {
    if (pendingCount === 0) return;
    const id = setInterval(() => flushPending(), 15_000);
    return () => clearInterval(id);
  }, [pendingCount, flushPending]);

  // Oculta el aviso de "reporte guardado" tras unos segundos.
  useEffect(() => {
    if (!queuedFlash) return;
    const id = setTimeout(() => setQueuedFlash(false), 5000);
    return () => clearTimeout(id);
  }, [queuedFlash]);

  const handlePick = useCallback(
    (lat: number, lng: number) => {
      // El clic en el mapa solo crea un reporte cuando el usuario activó el
      // modo "colocar" con el botón "+ Reportar". Un clic normal no hace nada.
      if (placing) {
        setDraft({ lat, lng });
        setPlacing(false);
      }
    },
    [placing],
  );

  // El buscador de direcciones solo navega (vuela el mapa al punto); ya no abre
  // el formulario, para crear se usa el botón "+ Reportar".
  const handleAddressSelect = useCallback((result: GeocodeResult) => {
    setFocus({ lat: result.lat, lng: result.lng, ts: Date.now() });
  }, []);

  // "+ Reportar" abre el modal SIN ubicación: el usuario la elige con "Elegir
  // en el mapa" o "Usar mi ubicación". El clic suelto en el mapa NO abre nada
  // (sin aperturas accidentales).
  const startReport = useCallback(() => {
    setPlacing(false);
    setDraft(null);
    setReportOpen(true);
  }, []);

  useEffect(() => {
    const openEmergencyReport = () => {
      document
        .getElementById("mapa")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      startReport();
    };

    window.addEventListener(OPEN_EMERGENCY_REPORT_EVENT, openEmergencyReport);
    return () =>
      window.removeEventListener(
        OPEN_EMERGENCY_REPORT_EVENT,
        openEmergencyReport,
      );
  }, [startReport]);

  const closeReport = useCallback(() => {
    setReportOpen(false);
    setDraft(null);
    setPlacing(false);
  }, []);

  // Al PRENDER un chip volamos solo a SUS pines ("muéstrame dónde está X").
  // Al apagarlo el mapa no se mueve: re-encuadrar a la unión de lo seleccionado
  // sacaba al usuario de su ciudad ante cualquier toque (los tipos tienen
  // pines en todo el país). Sin pines del tipo, no movemos el mapa.
  const handleChipClick = useCallback(
    (type: ReportType) => {
      const next = new Set(selectedTypes);
      const activating = !next.has(type);
      if (activating) next.add(type);
      else next.delete(type);
      setSelectedTypes(next);
      const points = chipFitPoints(type, activating, reports, missingMapMarkers);
      if (points) setFitRequest({ points, ts: Date.now() });
    },
    [selectedTypes, reports, missingMapMarkers],
  );

  const [shareCopied, setShareCopied] = useState(false);
  const shareMap = useCallback(async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Mapa de Emergencia y Rescate", url });
        return;
      } catch {
        // el usuario canceló o falló: intentamos copiar al portapapeles
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      /* sin permisos de portapapeles: no hacemos nada */
    }
  }, []);

  const handleSubmit = useCallback(
    async (payload: ReportComposerSubmit) => {
      if (!draft) return;

      // Detección de duplicados: mismo tipo, < 50 m, en las últimas 24 h.
      const candidates = reports.filter(
        (r) =>
          r.type === payload.type &&
          Date.now() - r.createdAt < DUPLICATE_WINDOW_MS &&
          distanceMeters(draft, r) < DUPLICATE_RADIUS_M,
      );
      if (candidates.length > 0) {
        const near = candidates[0]!;
        const ok =
          typeof window === "undefined" ||
          window.confirm(
            `Ya existe un reporte similar muy cerca (${Math.round(
              distanceMeters(draft, near),
            )} m): "${near.place}".\n\n¿Aun así quieres publicar el tuyo?`,
          );
        if (!ok) {
          throw new Error("Publicación cancelada para evitar duplicado.");
        }
      }

      const full: ReportSubmission = {
        ...payload,
        lat: draft.lat,
        lng: draft.lng,
      };
      const outcome = await postReportToServer(full);

      if (outcome.status === "drop") {
        // Datos rechazados por el servidor: el formulario muestra el error.
        throw new Error(outcome.error);
      }

      if (outcome.status === "queue") {
        // Sin conexión o servidor no disponible: guardamos el reporte en el
        // dispositivo y lo reintentamos automáticamente al recuperar la red.
        try {
          const queuedPayload: QueuedPayload = {
            type: full.type,
            lat: full.lat,
            lng: full.lng,
            place: full.place,
            affected: full.affected,
            needs: full.needs,
            photo: full.photo,
            volunteerCode: full.volunteerCode,
          };
          await enqueueReport(
            queuedPayload,
            process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
              ? "verification_required"
              : "ready",
          );
        } catch (err) {
          if (err instanceof OfflineDraftQuotaError) {
            throw err;
          }
          throw new Error(
            "No hay conexión y no se pudo guardar el reporte en este dispositivo. Inténtalo de nuevo.",
          );
        }
        setReportOpen(false);
        setDraft(null);
        setPendingCount(await countPending());
        void qc.invalidateQueries({ queryKey: qk.offlineDrafts });
        setQueuedFlash(true);
        return;
      }

      // outcome.status === "ok"
      setReportOpen(false);
      setDraft(null);
      // Update optimista: el reporte propio se ve al instante aunque el CDN
      // sirva una versión cacheada de la lista durante unos segundos.
      if (outcome.report) {
        const created = outcome.report;
        patchReports((prev) =>
          prev.some((r) => r.id === created.id) ? prev : [created, ...prev],
        );
      }
    },
    [draft, reports, patchReports, qc],
  );

  const handleResolve = useCallback(
    (id: string) => {
      if (!adminToken) {
        setShowAdminLogin(true);
        return;
      }
      const previous = reports;
      patchReports((prev) => prev.filter((r) => r.id !== id));
      resolveMutation.mutate(
        { id, adminToken },
        {
          onError: (err) => {
            // 401: token vencido → cerramos sesión, restauramos y pedimos login.
            if (
              typeof err === "object" &&
              err !== null &&
              "status" in err &&
              (err as { status?: number }).status === 401
            ) {
              logoutAdmin();
              patchReports(() => previous);
              setShowAdminLogin(true);
            }
          },
        },
      );
    },
    [adminToken, reports, patchReports, resolveMutation, logoutAdmin],
  );

  const counts = useMemo(() => {
    const base = Object.fromEntries(
      REPORT_TYPE_KEYS.map((key) => [key, 0]),
    ) as Record<ReportType, number>;
    for (const report of reports) {
      if (base[report.type] !== undefined) base[report.type] += 1;
    }
    // Total consolidado de desaparecidos activos en la base de datos.
    if (missingStats) {
      base.missing = missingStats.active;
    }
    return base;
  }, [reports, missingStats]);

  const showMissingOnMap = selectedTypes.has("missing");

  const mapReports = useMemo(() => {
    return reports.filter(
      (r) => r.type !== "critical" && selectedTypes.has(r.type),
    );
  }, [reports, selectedTypes]);

  return (
    <section
      id="mapa"
      className="mx-auto w-full max-w-[1760px] px-4 py-10 sm:px-6 lg:px-10"
    >
      <div className="mx-auto mb-5 flex w-full max-w-[1760px] flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="qi-h2">Mapa de reportes en tiempo real</h2>
          <p className="mt-1 text-sm text-[var(--etext2)]">
            Toca un punto del mapa para reportar o ver el estado de una zona.
          </p>
        </div>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <button
            type="button"
            onClick={shareMap}
            aria-label="Compartir el mapa"
            title="Compartir el mapa"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-[var(--eborder)] bg-[var(--esurf)] px-4 py-2 text-sm font-semibold text-[var(--etext)] shadow-sm transition hover:bg-[var(--einput)]"
          >
            {shareCopied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Link2 size={16} aria-hidden="true" />
            )}
            <span>{shareCopied ? "Copiado" : "Compartir"}</span>
          </button>
          <MapTutorialButton variant="toolbar" />
          <button
            type="button"
            onClick={startReport}
            className="inline-flex min-h-10 items-center rounded-full bg-red-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700"
          >
            Reportar Información
          </button>
        </div>
      </div>
      <OfflineDraftBanner
          onAccepted={(created) => {
            if (!created) return;
            patchReports((prev) =>
              prev.some((r) => r.id === created.id) ? prev : [created, ...prev],
            );
          }}
        />
      {network.isConstrained && (
        <div
          className="mb-3 rounded-xl border px-3 py-2 text-sm"
          style={{
            borderColor: "var(--qi-warning)",
            background: "var(--qi-warning-surface)",
            color: "var(--qi-warning-strong)",
          }}
        >
          {network.isOnline
            ? `Conexión lenta: actualizando cada ${Math.round(
                network.pollIntervalMs / 1000,
              )} s para ahorrar datos.`
            : "Sin conexión: mostrando datos guardados cuando estén disponibles."}
        </div>
      )}
      <div className={`e-map-grid ${placing ? "is-placing" : ""}`}>
        <MapPanel
          mapReports={mapReports}
          earthquakes={earthquakes ?? []}
          missingMapMarkers={missingMapMarkers}
          showMissingOnMap={showMissingOnMap}
          petMapMarkers={petMapMarkers}
          showPetsOnMap={showPetsOnMap}
          onTogglePets={togglePets}
          acopioCenters={acopioCenters}
          showAcopioOnMap={showAcopioOnMap}
          onToggleAcopio={toggleAcopio}
          draft={draft}
          confirmed={confirmed}
          isAdmin={isAdmin}
          focus={focus}
          fitRequest={fitRequest}
          center={DEFAULT_MAP_CENTER}
          selectedTypes={selectedTypes}
          counts={counts}
          addressBias={
            focus ? { lat: focus.lat, lng: focus.lng } : AFFECTED_CENTER
          }
          placing={placing}
          shareCopied={shareCopied}
          onBoundsChange={handleBoundsChange}
          onPick={handlePick}
          onResolve={handleResolve}
          onConfirm={handleConfirm}
          onAddressSelect={handleAddressSelect}
          onChipClick={handleChipClick}
          onCancelPlacing={() => setPlacing(false)}
          onShare={shareMap}
          onStartReport={startReport}
        />
      </div>

      {!persistent && (
        <p
          className="mt-3 rounded-lg px-3 py-2 text-xs"
          style={{
            background: "var(--qi-warning-surface)",
            color: "var(--qi-warning-strong)",
          }}
        >
          Modo demo: los reportes no se están guardando de forma permanente.
          Conecta la base de datos (Neon) en Vercel para compartirlos entre todos
          los usuarios.
        </p>
      )}

      <ReportComposer
        open={reportOpen}
        coords={draft}
        hidden={placing}
        queuedFlash={queuedFlash}
        onPickOnMap={() => setPlacing(true)}
        onClearLocation={() => setDraft(null)}
        onCancel={closeReport}
        onCoordsChange={(c) => setDraft(c)}
        onSubmit={handleSubmit}
      />

      <AdminPanel
        open={showAdminLogin}
        onCancel={() => setShowAdminLogin(false)}
        onSuccess={loginAdmin}
      />
    </section>
  );
}
