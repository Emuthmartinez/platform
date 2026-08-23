"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, Info, Layers3 } from "lucide-react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import {
  externalLinkProps,
  latestSourceTime,
  selectedProduct,
  subscribeToConnectivity,
  subscribeToMobileViewport,
} from "./helpers";
import { getRescueMapCopy } from "./copy";
import RescueMapRail from "./RescueMapRail";
import type { RescueMapModeOption } from "./RescueMapMapModes";
import {
  isRescueMapIncident,
  isRescueMapMappingSnapshot,
  type RescueMapIncident,
  type RescueMapMappingSnapshot,
  type RescueMapMode,
} from "@/lib/rescue-map";
import {
  COLOMBIA_RESCUE_DATA_PATHS,
} from "@/lib/tenant";
import {
  RESCUE_VIEW_STATE_KEY,
  RESCUE_VIEW_STATE_LEGACY_KEY,
} from "@/lib/browser-storage-registry";
import { migrateLegacyLocalStorage } from "@/lib/incident-storage";
import {
  loadRescueSnapshot,
  saveRescueSnapshot,
} from "@/lib/rescue-map-offline";

const INCIDENT_PATH = COLOMBIA_RESCUE_DATA_PATHS[0];
const MAPPING_PATH = COLOMBIA_RESCUE_DATA_PATHS[1];
const OFFLINE_REFRESH_INTERVAL_MS = 5_000;

const RescueMapCanvas = dynamic(() => import("./RescueMapCanvas"), {
  ssr: false,
  loading: () => (
    <div className="e-rescue-map-loading" role="status">
      Cargando mapa / <span lang="en">Loading map</span>
    </div>
  ),
});

// Composition root for the rescue map page. Keeps the data, refresh, and
// selection state; delegates layout/rendering of the operational rail
// (aside) to `RescueMapRail`. The map stage below is intentionally still
// in this file because it owns the canvas and only carries a few
// declaratively-rendered siblings.
export default function RescueMapExperience({
  initialIncident,
  initialMapping,
}: {
  initialIncident: RescueMapIncident;
  initialMapping: RescueMapMappingSnapshot;
}) {
  // El selector global del header traduce la página completa. Mantener una
  // segunda preferencia local produciría combinaciones inconsistentes.
  const language = "es" as const;
  // Arranca en "map" (OSM): la imagen Esri de referencia sale oscura y con
  // nubes sobre la cordillera y como primera impresión parece un mapa roto.
  // La capa satelital sigue a un clic en "Referencia".
  const [mode, setMode] = useState<RescueMapMode>("map");
  const [incident, setIncident] = useState(initialIncident);
  const [mapping, setMapping] = useState(initialMapping);
  const [selectedAoiId, setSelectedAoiId] = useState<string | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const isOnline = useSyncExternalStore(
    subscribeToConnectivity,
    () => navigator.onLine,
    () => true,
  );
  const isMobile = useSyncExternalStore(
    subscribeToMobileViewport,
    () => window.matchMedia("(max-width: 767px)").matches,
    () => false,
  );
  const [usingCachedData, setUsingCachedData] = useState(false);
  const [lastLocalUpdate, setLastLocalUpdate] = useState<number>(
    Date.parse(latestSourceTime(initialIncident, initialMapping)),
  );
  const [updateNotice, setUpdateNotice] = useState(false);
  const [viewStateLoaded, setViewStateLoaded] = useState(false);
  const railContentRef = useRef<HTMLDivElement>(null);
  const sourceUpdatedRef = useRef(
    latestSourceTime(initialIncident, initialMapping),
  );
  const text = getRescueMapCopy(language);

  const selectedAoi = useMemo(
    () => mapping.aois.find((aoi) => aoi.id === selectedAoiId) ?? null,
    [mapping.aois, selectedAoiId],
  );
  const product = selectedProduct(selectedAoi);
  const image = product?.images[0] ?? null;
  const selectAoi = useCallback((aoiId: string) => {
    setSelectedAoiId(aoiId);
    setSheetExpanded(true);
    requestAnimationFrame(() => {
      railContentRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedAoiId(null), []);

  useEffect(() => {
    sourceUpdatedRef.current = latestSourceTime(incident, mapping);
  }, [incident, mapping]);

  useEffect(() => {
    const className = "rescue-map-sheet-expanded";
    document.body.classList.toggle(className, isMobile && sheetExpanded);
    return () => document.body.classList.remove(className);
  }, [isMobile, sheetExpanded]);

  useEffect(() => {
    const restoreViewState = () => {
      try {
        migrateLegacyLocalStorage(
          RESCUE_VIEW_STATE_LEGACY_KEY,
          RESCUE_VIEW_STATE_KEY,
        );
        const raw = window.localStorage.getItem(RESCUE_VIEW_STATE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as {
            mode?: unknown;
            selectedAoiId?: unknown;
          };
          if (
            saved.mode === "map" ||
            saved.mode === "reference" ||
            (saved.mode === "before" && initialMapping.imagery.before) ||
            (saved.mode === "after" && initialMapping.imagery.after)
          ) {
            setMode(saved.mode);
          }
          if (
            typeof saved.selectedAoiId === "string" &&
            initialMapping.aois.some((aoi) => aoi.id === saved.selectedAoiId)
          ) {
            setSelectedAoiId(saved.selectedAoiId);
          }
        }
      } catch {
        // Estado opcional: un valor corrupto no bloquea el mapa.
      } finally {
        setViewStateLoaded(true);
      }
    };
    const restoreTimer = window.setTimeout(restoreViewState, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [initialMapping]);

  useEffect(() => {
    if (!viewStateLoaded) return;
    try {
      window.localStorage.setItem(
        RESCUE_VIEW_STATE_KEY,
        JSON.stringify({ mode, selectedAoiId }),
      );
    } catch {
      // El mapa sigue funcional si el navegador bloquea localStorage.
    }
  }, [mode, selectedAoiId, viewStateLoaded]);

  const refreshStaticData = useCallback(async (announce: boolean) => {
    try {
      // Son assets JSON públicos del mismo origen, no una llamada a la API.
      const [incidentResponse, mappingResponse] = await Promise.all([
        fetch(INCIDENT_PATH, { cache: "no-store" }),
        fetch(MAPPING_PATH, { cache: "no-store" }),
      ]);
      if (!incidentResponse.ok || !mappingResponse.ok) return;
      const [incidentJson, mappingJson] = await Promise.all([
        incidentResponse.json() as Promise<unknown>,
        mappingResponse.json() as Promise<unknown>,
      ]);
      if (
        !isRescueMapIncident(incidentJson) ||
        !isRescueMapMappingSnapshot(mappingJson)
      ) {
        return;
      }

      const mappingWithStale = mappingJson as RescueMapMappingSnapshot & {
        __swStaleAt?: unknown;
      };
      const staleAt =
        typeof mappingWithStale.__swStaleAt === "number"
          ? mappingWithStale.__swStaleAt
          : null;
      const nextSourceUpdated = latestSourceTime(incidentJson, mappingJson);
      const hasNewInformation = nextSourceUpdated > sourceUpdatedRef.current;
      setIncident(incidentJson);
      setMapping(mappingJson);
      setUsingCachedData(staleAt !== null);
      setLastLocalUpdate(staleAt ?? Date.now());
      if (hasNewInformation && announce) setUpdateNotice(true);
      sourceUpdatedRef.current = nextSourceUpdated;
      if (staleAt === null) {
        await saveRescueSnapshot(incidentJson, mappingJson);
      }
    } catch {
      // La vista conserva el snapshot inicial o el último guardado.
    }
  }, []);

  useEffect(() => {
    let active = true;
    const online = navigator.onLine;

    loadRescueSnapshot()
      .then((snapshot) => {
        if (!active || !snapshot) return;
        if (snapshot.sourceUpdatedAt > sourceUpdatedRef.current) {
          setIncident(snapshot.incident);
          setMapping(snapshot.mapping);
          sourceUpdatedRef.current = snapshot.sourceUpdatedAt;
        }
        setLastLocalUpdate(snapshot.savedAt);
      })
      .catch(() => {});

    const refreshTimer = online
      ? window.setTimeout(() => void refreshStaticData(false), 0)
      : null;

    const onOnline = () => {
      void refreshStaticData(true);
    };
    const onOffline = () => {
      setUsingCachedData(true);
    };
    const onServiceWorkerMessage = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === "rescue-map-data-updated"
      ) {
        void refreshStaticData(true);
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage);
    return () => {
      active = false;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      navigator.serviceWorker?.removeEventListener(
        "message",
        onServiceWorkerMessage,
      );
    };
  }, [refreshStaticData]);

  useEffect(() => {
    if (!usingCachedData) return;
    const retryTimer = window.setInterval(
      () => void refreshStaticData(true),
      OFFLINE_REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(retryTimer);
  }, [refreshStaticData, usingCachedData]);

  const baseModes: RescueMapModeOption[] = [
    { id: "map", label: text.map, available: true },
    { id: "reference", label: text.reference, available: true },
  ];
  const comparisonModes: RescueMapModeOption[] = [
    { id: "before", label: text.before, available: Boolean(mapping.imagery.before) },
    { id: "after", label: text.after, available: Boolean(mapping.imagery.after) },
  ];

  // En una reapertura controlada por el service worker Chromium puede marcar
  // `navigator.onLine` como true porque la navegación respondió desde caché.
  // La marca añadida por el network-first de los JSON es la señal fiable:
  // si llegó una copia stale, la fuente operativa no fue alcanzable.
  const effectivelyOffline = !isOnline || usingCachedData;
  const connectionLabel = effectivelyOffline
    ? text.offline
    : usingCachedData
      ? text.cached
      : text.online;
  const imageNeedsConnection = effectivelyOffline;
  const currentProvider =
    mode === "reference"
      ? text.referenceSource
      : mode === "map"
        ? text.mapSource
        : mode === "before"
          ? text.before
          : text.after;

  return (
    <main
      id="main"
      className="e-rescue-page"
      data-incident-id={incident.incidentId}
      data-status={incident.status}
      data-map-activation={mapping.activationCode}
    >
      <a className="e-rescue-skip" href="#mapa-de-rescate-canvas">
        {text.skip}
      </a>

      <section className="e-rescue-map-stage" aria-label={text.currentView}>
        <ErrorBoundary
          fallback={
            <div
              id="mapa-de-rescate-canvas"
              className="e-rescue-map-loading"
              role="region"
              aria-label={text.mapFailure}
              tabIndex={0}
            >
              {text.mapFailure}
            </div>
          }
        >
          <RescueMapCanvas
            mapping={mapping}
            mode={mode}
            language={language}
            selectedAoiId={selectedAoiId}
            epicenter={{
              longitude: incident.event.longitude,
              latitude: incident.event.latitude,
              magnitude: incident.event.magnitude,
            }}
            isOnline={!effectivelyOffline}
            mobileViewport={isMobile}
            mobileSheetExpanded={isMobile && sheetExpanded}
            onSelectAoi={selectAoi}
          />
        </ErrorBoundary>

        <div
          className="e-rescue-map-status"
          data-online={String(!effectivelyOffline)}
          aria-live="polite"
          aria-atomic="true"
        >
          <span>
            {imageNeedsConnection ? text.imageryOffline : text.currentView}
          </span>
          <strong>
            {selectedAoi ? selectedAoi.name[language] : text.officialAreas}
          </strong>
          <small>
            {currentProvider} · {connectionLabel}
          </small>
        </div>

        <details
          className="e-rescue-map-legend"
          aria-label={language === "es" ? "Leyenda del mapa" : "Map legend"}
        >
          <summary>
            <Layers3 aria-hidden size={17} strokeWidth={2.2} />
            <span>{text.legend}</span>
            <ChevronDown
              className="e-rescue-disclosure-chevron"
              aria-hidden
              size={16}
              strokeWidth={2.2}
            />
          </summary>
          <div className="e-rescue-map-legend-panel">
            <span>
              <i className="e-rescue-key" data-kind="epicenter" aria-hidden />
              {text.legendEpicenter}
            </span>
            <span>
              <i className="e-rescue-key" data-kind="damage" aria-hidden />
              {text.legendDamage}
            </span>
            <span>
              <i className="e-rescue-key" data-kind="movement" aria-hidden />
              {text.legendMovement}
            </span>
          </div>
        </details>

        <details className="e-rescue-attribution">
          <summary aria-label={text.attribution}>
            <span>
              {mode === "map"
                ? "© OpenStreetMap"
                : "© Esri y colaboradores"}{" "}
              · Leaflet
            </span>
            <Info aria-hidden size={15} strokeWidth={2.2} />
          </summary>
          <div className="e-rescue-attribution-body">
            {mode === "map" ? (
              <>
                ©{" "}
                <a
                  href="https://www.openstreetmap.org/copyright"
                  {...externalLinkProps}
                >
                  OpenStreetMap
                </a>{" "}
                contributors
              </>
            ) : (
              <>
                Tiles © Esri, Maxar, Earthstar Geographics and the GIS User
                Community
              </>
            )}
            {" · "}
            <a href="https://leafletjs.com/" {...externalLinkProps}>
              Leaflet
            </a>
          </div>
        </details>
      </section>

      <RescueMapRail
        language={language}
        incident={incident}
        mapping={mapping}
        mode={mode}
        setMode={setMode}
        selectedAoi={selectedAoi}
        product={product}
        image={image}
        selectedAoiId={selectedAoiId}
        selectAoi={selectAoi}
        clearSelection={clearSelection}
        isMobile={isMobile}
        sheetExpanded={sheetExpanded}
        onToggleSheet={(event) => {
          setSheetExpanded((expanded) => !expanded);
          if (event.detail > 0) event.currentTarget.blur();
        }}
        railContentRef={railContentRef}
        effectivelyOffline={effectivelyOffline}
        connectionLabel={connectionLabel}
        imageNeedsConnection={imageNeedsConnection}
        lastLocalUpdate={lastLocalUpdate}
        updateNotice={updateNotice}
        baseModes={baseModes}
        comparisonModes={comparisonModes}
        incidentPath={INCIDENT_PATH}
        mappingPath={MAPPING_PATH}
      />
    </main>
  );
}
