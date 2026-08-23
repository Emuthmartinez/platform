"use client";

import { getAppBuildSha } from "@/lib/build-identity";
import {
  decodeOfflineDraft,
  evaluateDraftQuota,
  exportOfflineDraftJson,
  newDraftFromPayload,
  type OfflineDraft,
  type OfflineDraftStatus,
  type QueuedPayload,
} from "@/lib/offline-draft-protocol";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/tenant";

export type { QueuedPayload, OfflineDraft, OfflineDraftStatus };
export {
  OfflineDraftQuotaError,
  exportOfflineDraftJson,
  mayAutoDeleteDraft,
} from "@/lib/offline-draft-protocol";

/**
 * Cola de reportes pendientes de envío, persistida en IndexedDB.
 *
 * Por qué IndexedDB y no localStorage: un reporte puede incluir una foto en
 * data URL de ~1.4 MB; varios reportes encolados superarían fácilmente la
 * cuota de localStorage (~5 MB) y bloquearían toda la cola. IndexedDB maneja
 * cadenas grandes sin problema y es asíncrono.
 *
 * U20: los registros son borradores versionados. v1 se lee y se reescribe
 * como schemaVersion 2 con status verification_required. No se borra un
 * borrador en 403 ni en fallo de migración.
 */

const DB_NAME = "emergency-offline";
const DB_VERSION = 1;
const STORE = "pending-reports";

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "localId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB no disponible"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let request: IDBRequest<T> | void;
    try {
      request = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      const r = request as IDBRequest<T> | undefined;
      resolve(r ? r.result : undefined);
      db.close();
    };
    tx.onerror = () => {
      reject(tx.error);
      db.close();
    };
    tx.onabort = () => {
      reject(tx.error);
      db.close();
    };
  });
}

function newLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

async function readAllRaw(): Promise<unknown[]> {
  if (!hasIndexedDb()) return [];
  const all = await withStore<unknown[]>("readonly", (store) => store.getAll());
  return all ?? [];
}

async function persistDecoded(rawRows: unknown[]): Promise<OfflineDraft[]> {
  const drafts: OfflineDraft[] = [];
  for (const raw of rawRows) {
    const decoded = decodeOfflineDraft(raw, {
      organizationId: COLOMBIA_ORGANIZATION_ID,
      incidentId: COLOMBIA_INCIDENT_ID,
    });
    if ("error" in decoded) continue;
    drafts.push(decoded.draft);
    if (decoded.persist) {
      try {
        await withStore("readwrite", (store) => store.put(decoded.draft));
      } catch {
        /* keep the original row; never delete on migrate failure */
      }
    }
  }
  return drafts.sort((a, b) => a.createdAt - b.createdAt);
}

/** Guarda un reporte para enviarlo más tarde. Lanza si no hay IndexedDB. */
export async function enqueueReport(
  payload: QueuedPayload,
  status: OfflineDraftStatus = "verification_required",
): Promise<OfflineDraft> {
  if (!hasIndexedDb()) {
    throw new Error("Almacenamiento offline no disponible en este navegador.");
  }
  const existing = await listPending();
  const item = newDraftFromPayload(payload, {
    localId: newLocalId(),
    createdAt: Date.now(),
    status,
    producerBuildSha: getAppBuildSha(),
  });
  evaluateDraftQuota(existing, item);
  await withStore("readwrite", (store) => store.add(item));
  return item;
}

/** Devuelve los borradores de este incidente, del más antiguo al más reciente. */
export async function listPending(): Promise<OfflineDraft[]> {
  const raw = await readAllRaw();
  const drafts = await persistDecoded(raw);
  return drafts.filter(
    (d) =>
      d.organizationId === COLOMBIA_ORGANIZATION_ID &&
      d.incidentId === COLOMBIA_INCIDENT_ID &&
      d.status !== "incompatible",
  );
}

export async function listReadyDrafts(): Promise<OfflineDraft[]> {
  const pending = await listPending();
  return pending.filter((d) => d.status === "ready");
}

export async function removePending(localId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await withStore("readwrite", (store) => store.delete(localId));
}

export async function countPending(): Promise<number> {
  const pending = await listPending();
  return pending.length;
}

export function downloadOfflineDraft(draft: OfflineDraft): void {
  const json = exportOfflineDraftJson(draft);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reporte-borrador-${draft.localId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
