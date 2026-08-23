"use client";

import type {
  RescueMapIncident,
  RescueMapMappingAoi,
  RescueMapMappingSnapshot,
} from "@/lib/rescue-map";
import { COLOMBIA_RESCUE_INCIDENT_ID } from "@/lib/tenant";

const DB_NAME = "terremoto-colombia-rescue-map";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const PACKAGE_STORE = "packages";
const CURRENT_SNAPSHOT_ID = "current";

/** Presupuesto deliberadamente pequeño: solo geometrías y metadatos, nunca tiles. */
export const RESCUE_OFFLINE_BUDGET_BYTES = 8 * 1024 * 1024;

export interface RescueMapOfflineSnapshot {
  id: typeof CURRENT_SNAPSHOT_ID;
  incident: RescueMapIncident;
  mapping: RescueMapMappingSnapshot;
  savedAt: number;
  sourceUpdatedAt: string;
}

export interface RescueMapOfflinePackage {
  aoiId: string;
  incidentId: string;
  activationCode: string;
  savedAt: number;
  sourceUpdatedAt: string;
  sizeBytes: number;
  coverage: RescueMapMappingAoi["name"];
  event: Pick<
    RescueMapIncident["event"],
    "magnitude" | "latitude" | "longitude" | "depthKm" | "reference"
  >;
  tsunami: RescueMapIncident["tsunami"];
  publicDamageLayer: RescueMapIncident["publicDamageLayer"];
  aoi: RescueMapMappingAoi;
}

export type RescueOfflineErrorCode =
  | "unsupported"
  | "budget"
  | "quota"
  | "write";

export class RescueOfflineError extends Error {
  constructor(
    public readonly code: RescueOfflineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RescueOfflineError";
  }
}

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (!supportsIndexedDb()) {
    return Promise.reject(
      new RescueOfflineError(
        "unsupported",
        "El almacenamiento offline no está disponible en este navegador.",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PACKAGE_STORE)) {
        db.createObjectStore(PACKAGE_STORE, { keyPath: "aoiId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new RescueOfflineError("write", "No se pudo abrir el almacenamiento."),
      );
    request.onblocked = () =>
      reject(
        new RescueOfflineError(
          "write",
          "Otra pestaña está actualizando el almacenamiento offline.",
        ),
      );
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Falló una operación de IndexedDB."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Falló la transacción offline."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Se canceló la transacción offline."));
  });
}

function closeAfter<T>(db: IDBDatabase, work: Promise<T>): Promise<T> {
  return work.finally(() => db.close());
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

export function isOfflinePackageStale(
  item: RescueMapOfflinePackage,
  mapping: RescueMapMappingSnapshot,
): boolean {
  return item.sourceUpdatedAt !== mapping.lastCheckedAt;
}

export function rescuePackageCapacityIssue({
  existingBytes,
  replacedBytes,
  packageBytes,
  availableDeviceBytes,
}: {
  existingBytes: number;
  replacedBytes: number;
  packageBytes: number;
  availableDeviceBytes: number | null;
}): "budget" | "quota" | null {
  if (existingBytes - replacedBytes + packageBytes > RESCUE_OFFLINE_BUDGET_BYTES) {
    return "budget";
  }
  if (
    availableDeviceBytes !== null &&
    availableDeviceBytes < packageBytes
  ) {
    return "quota";
  }
  return null;
}

export async function loadRescueSnapshot(): Promise<RescueMapOfflineSnapshot | null> {
  if (!supportsIndexedDb()) return null;
  const db = await openDb();
  const transaction = db.transaction(SNAPSHOT_STORE, "readonly");
  const value = requestValue(
    transaction
      .objectStore(SNAPSHOT_STORE)
      .get(CURRENT_SNAPSHOT_ID) as IDBRequest<RescueMapOfflineSnapshot | undefined>,
  );
  return closeAfter(
    db,
    Promise.all([value, transactionDone(transaction)]).then(
      ([snapshot]) => {
        if (!snapshot) return null;
        if (snapshot.incident.incidentId !== COLOMBIA_RESCUE_INCIDENT_ID) {
          return null;
        }
        return snapshot;
      },
    ),
  );
}

export async function saveRescueSnapshot(
  incident: RescueMapIncident,
  mapping: RescueMapMappingSnapshot,
  savedAt = Date.now(),
): Promise<RescueMapOfflineSnapshot> {
  const snapshot: RescueMapOfflineSnapshot = {
    id: CURRENT_SNAPSHOT_ID,
    incident,
    mapping,
    savedAt,
    sourceUpdatedAt: mapping.lastCheckedAt,
  };
  const db = await openDb();
  const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
  try {
    transaction.objectStore(SNAPSHOT_STORE).put(snapshot);
    await closeAfter(db, transactionDone(transaction));
    return snapshot;
  } catch (error) {
    db.close();
    if (isQuotaError(error)) {
      throw new RescueOfflineError(
        "quota",
        "No hay espacio suficiente para actualizar el mapa offline.",
      );
    }
    throw new RescueOfflineError(
      "write",
      "No se pudo guardar la última versión del mapa.",
    );
  }
}

export async function listAllRescueOfflinePackages(): Promise<
  RescueMapOfflinePackage[]
> {
  if (!supportsIndexedDb()) return [];
  const db = await openDb();
  const transaction = db.transaction(PACKAGE_STORE, "readonly");
  const value = requestValue(
    transaction
      .objectStore(PACKAGE_STORE)
      .getAll() as IDBRequest<RescueMapOfflinePackage[]>,
  );
  return closeAfter(
    db,
    Promise.all([value, transactionDone(transaction)]).then(([items]) =>
      items.sort((a, b) => a.aoiId.localeCompare(b.aoiId)),
    ),
  );
}

export async function listRescueOfflinePackages(): Promise<
  RescueMapOfflinePackage[]
> {
  const items = await listAllRescueOfflinePackages();
  return items.filter(
    (item) => item.incidentId === COLOMBIA_RESCUE_INCIDENT_ID,
  );
}

function makePackage(
  incident: RescueMapIncident,
  mapping: RescueMapMappingSnapshot,
  aoi: RescueMapMappingAoi,
): RescueMapOfflinePackage {
  const withoutSize = {
    aoiId: aoi.id,
    incidentId: incident.incidentId,
    activationCode: mapping.activationCode,
    savedAt: Date.now(),
    sourceUpdatedAt: mapping.lastCheckedAt,
    coverage: aoi.name,
    event: {
      magnitude: incident.event.magnitude,
      latitude: incident.event.latitude,
      longitude: incident.event.longitude,
      depthKm: incident.event.depthKm,
      reference: incident.event.reference,
    },
    tsunami: incident.tsunami,
    publicDamageLayer: incident.publicDamageLayer,
    aoi,
  };
  return { ...withoutSize, sizeBytes: byteLength(withoutSize) };
}

export function estimateRescueOfflinePackageBytes(
  incident: RescueMapIncident,
  mapping: RescueMapMappingSnapshot,
  aoi: RescueMapMappingAoi,
): number {
  return makePackage(incident, mapping, aoi).sizeBytes;
}

async function ensurePackageCapacity(
  item: RescueMapOfflinePackage,
): Promise<void> {
  const existing = await listAllRescueOfflinePackages();
  const replacedSize =
    existing.find((candidate) => candidate.aoiId === item.aoiId)?.sizeBytes ?? 0;
  const existingBytes = existing.reduce(
    (sum, candidate) => sum + candidate.sizeBytes,
    0,
  );
  let availableDeviceBytes: number | null = null;
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    if (
      typeof estimate.quota === "number" &&
      typeof estimate.usage === "number"
    ) {
      availableDeviceBytes = estimate.quota - estimate.usage;
    }
  }
  const issue = rescuePackageCapacityIssue({
    existingBytes,
    replacedBytes: replacedSize,
    packageBytes: item.sizeBytes,
    availableDeviceBytes,
  });
  if (issue === "budget") {
    throw new RescueOfflineError(
      "budget",
      "El paquete supera el presupuesto offline de 8 MB.",
    );
  }
  if (issue === "quota") {
    throw new RescueOfflineError(
      "quota",
      "No hay espacio suficiente en el dispositivo para completar la descarga.",
    );
  }
}

export async function saveRescueOfflinePackage(
  incident: RescueMapIncident,
  mapping: RescueMapMappingSnapshot,
  aoi: RescueMapMappingAoi,
): Promise<RescueMapOfflinePackage> {
  const item = makePackage(incident, mapping, aoi);
  await ensurePackageCapacity(item);

  const db = await openDb();
  const transaction = db.transaction(PACKAGE_STORE, "readwrite");
  try {
    transaction.objectStore(PACKAGE_STORE).put(item);
    await closeAfter(db, transactionDone(transaction));
    if (navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => false);
    }
    return item;
  } catch (error) {
    db.close();
    if (isQuotaError(error)) {
      throw new RescueOfflineError(
        "quota",
        "No hay espacio suficiente en el dispositivo para completar la descarga.",
      );
    }
    throw new RescueOfflineError(
      "write",
      "La descarga no se completó. No se guardó un paquete parcial.",
    );
  }
}

export async function removeRescueOfflinePackage(aoiId: string): Promise<void> {
  if (!supportsIndexedDb()) return;
  const db = await openDb();
  const transaction = db.transaction(PACKAGE_STORE, "readwrite");
  transaction.objectStore(PACKAGE_STORE).delete(aoiId);
  await closeAfter(db, transactionDone(transaction));
}
