"use client";

/**
 * Panel de edición de UNA fila de un lote de importación, expandido inline
 * dentro de `ImportRowsTable` (sin pantalla nueva). Cubre R1/R2/R3/R5 del
 * Phase 0: editar los campos normalizados, confirmar/rechazar la fila, y
 * decidir los candidatos de deduplicación — todo contra los cuatro endpoints
 * nuevos de U2 (`PATCH .../rows/:rowId`, `POST .../confirm|reject|dedup`).
 *
 * Cada acción usa `useDecisionMutation` (U5's contribución al patrón
 * compartido, ver `@/src/shared/mutation/use-decision-mutation`): en vuelo →
 * botón deshabilitado; 409 → "modificada/decidida por otra persona" + refetch
 * de la lista; cualquier otro error → inline reintentable.
 */
import { useState } from "react";
import { RequireCapability } from "@/src/shared/auth/admin-gate";
import { Button, Input } from "@/src/ui";
import {
  jsonRequestInit,
  requestDecisionJson,
  useDecisionMutation,
} from "@/src/shared/mutation/use-decision-mutation";
import { useModelList } from "../models/ui/use-model-list";
import { scopedQueryKey } from "@/src/lib/query-scope";
import type { ImportRow } from "./import-rows-table";

// Mismos valores/etiquetas que `frontend/lib/hospitals-meta.ts`
// (PATIENT_CONDITION_META / PATIENT_STATUS_META) — sin paquete compartido
// entre admin y frontend, se mantiene el mismo copy a mano a propósito.
const CONDITION_LABELS: Record<string, string> = {
  stable: "Estable",
  serious: "Grave",
  critical: "Crítico",
  recovering: "En recuperación",
  unknown: "Sin determinar",
};

const STATUS_LABELS: Record<string, string> = {
  hospitalized: "Hospitalizado",
  sheltered: "En refugio",
  discharged: "Dado de alta",
  transferred: "Transferido",
  deceased: "Fallecido",
};

const ROW_STATUS_LABELS: Record<string, string> = {
  valid: "Válida",
  invalid: "Inválida",
  duplicate: "Duplicada",
  needs_review: "Revisar",
  applying: "Aplicando",
  applied: "Aplicada",
};

interface EditPayload {
  name: string;
  age: string | null;
  condition: string;
  status: string;
  hospitalId?: string;
  sourceHospital?: string;
  // `updated_at` de la fila tal como la vio este editor — el token de
  // concurrencia optimista real (ver rows.ts `editImportRow`): una baseline
  // obsoleta → 409 en vez de pisar una edición concurrente en silencio.
  baselineUpdatedAt?: number;
}

interface DedupDecisionPayload {
  accept: boolean;
  patientId?: string;
}

function rowsQueryKey(importId: string) {
  return scopedQueryKey("patient-import-rows", importId);
}

export function RowEditor({
  importId,
  row,
  sourceImageUrl,
}: {
  importId: string;
  row: ImportRow;
  /** Imagen completa del lote OCR (header.sourceImageUrl), si la hay — vista
   * completa; el recorte por región queda para Phase 3. */
  sourceImageUrl?: string | null;
}) {
  // Copia local de la fila: se actualiza con CADA respuesta de mutación
  // exitosa (guardar/confirmar/rechazar/dedup) para reflejar de inmediato el
  // nuevo estado sin esperar el refetch de la lista — que igual se dispara
  // (`invalidateKeys`) para mantener la tabla sincronizada.
  const [currentRow, setCurrentRow] = useState(row);

  const [name, setName] = useState(row.name ?? "");
  const [age, setAge] = useState(row.age !== null && row.age !== undefined ? String(row.age) : "");
  const [condition, setCondition] = useState(row.condition ?? "unknown");
  const [status, setStatus] = useState(row.status ?? "hospitalized");
  const [hospitalId, setHospitalId] = useState(row.hospitalId ?? "");
  const [sourceHospitalText, setSourceHospitalText] = useState(row.sourceHospital ?? "");

  // Baseline de concurrencia optimista: el `updatedAt` que este editor vio al
  // abrirse. Se envía tal cual en el PATCH (`baselineUpdatedAt`) — si el
  // servidor ve un valor distinto, la fila cambió desde que se leyó y
  // responde 409 en vez de pisar la edición concurrente. El guard
  // `typeof === "number"` en `submitSave` es defensivo (dato JSON no
  // tipo-chequeado en runtime); `ImportRow.updatedAt` ya es un campo real.
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState(row.updatedAt);

  const hospitals = useModelList("hospitals");

  function resetFormFrom(next: ImportRow): void {
    setName(next.name ?? "");
    setAge(next.age !== null && next.age !== undefined ? String(next.age) : "");
    setCondition(next.condition ?? "unknown");
    setStatus(next.status ?? "hospitalized");
    setHospitalId(next.hospitalId ?? "");
    setSourceHospitalText(next.sourceHospital ?? "");
  }

  const rowUrl = `/api/admin/patient-imports/${encodeURIComponent(importId)}/rows/${encodeURIComponent(row.id)}`;

  const save = useDecisionMutation<EditPayload, { row: ImportRow }>({
    mutationFn: (payload) =>
      requestDecisionJson<{ row: ImportRow }>(rowUrl, jsonRequestInit("PATCH", payload)),
    invalidateKeys: [rowsQueryKey(importId)],
    onSuccess: (result) => {
      setCurrentRow(result.row);
      resetFormFrom(result.row);
      setBaselineUpdatedAt(result.row.updatedAt);
    },
  });

  const confirm = useDecisionMutation<undefined, { row: ImportRow }>({
    mutationFn: () => requestDecisionJson<{ row: ImportRow }>(`${rowUrl}/confirm`, jsonRequestInit("POST")),
    invalidateKeys: [rowsQueryKey(importId)],
    onSuccess: (result) => {
      setCurrentRow(result.row);
      setBaselineUpdatedAt(result.row.updatedAt);
    },
  });

  const reject = useDecisionMutation<undefined, { row: ImportRow }>({
    mutationFn: () => requestDecisionJson<{ row: ImportRow }>(`${rowUrl}/reject`, jsonRequestInit("POST")),
    invalidateKeys: [rowsQueryKey(importId)],
    onSuccess: (result) => {
      setCurrentRow(result.row);
      setBaselineUpdatedAt(result.row.updatedAt);
    },
  });

  const dedup = useDecisionMutation<DedupDecisionPayload, { row: ImportRow }>({
    mutationFn: (decision) =>
      requestDecisionJson<{ row: ImportRow }>(`${rowUrl}/dedup`, jsonRequestInit("POST", decision)),
    invalidateKeys: [rowsQueryKey(importId)],
    onSuccess: (result) => {
      setCurrentRow(result.row);
      setBaselineUpdatedAt(result.row.updatedAt);
    },
  });

  // Tras un 409 el `invalidateKeys` de arriba refetchea la lista del padre
  // (ImportRowsTable) — este efecto detecta que la fila vigente cambió (le
  // llega por props) mientras hay un conflicto activo y resincroniza TODO
  // (form + baseline) con esa versión fresca, para que reintentar guardar use
  // la baseline correcta en vez de repetir el mismo 409.
  const anyConflict = save.isConflict || confirm.isConflict || reject.isConflict || dedup.isConflict;
  // Las cuatro mutaciones actúan sobre la MISMA fila — mientras cualquiera
  // esté en vuelo, se deshabilitan todos los botones de acción para no
  // disparar escrituras concurrentes (p. ej. guardar y confirmar a la vez).
  const anyPending = save.isPending || confirm.isPending || reject.isPending || dedup.isPending;
  // Ajuste DURANTE el render (patrón "adjust state when props change" de
  // react.dev, exigido por react-hooks/set-state-in-effect): la condición se
  // autoextingue en cuanto currentRow alcanza a la prop, así que esto corre
  // exactamente una vez por versión fresca de la fila.
  if (anyConflict && row.updatedAt !== currentRow.updatedAt) {
    setCurrentRow(row);
    resetFormFrom(row);
    setBaselineUpdatedAt(row.updatedAt);
  }

  function submitSave(): void {
    const payload: EditPayload = {
      name: name.trim(),
      age: age.trim() === "" ? null : age.trim(),
      condition,
      status,
    };
    if (typeof baselineUpdatedAt === "number") {
      payload.baselineUpdatedAt = baselineUpdatedAt;
    }
    if (hospitalId) {
      payload.hospitalId = hospitalId;
    } else {
      payload.sourceHospital = sourceHospitalText.trim();
    }
    save.mutate(payload);
  }

  const canEditRow = currentRow.rowStatus === "needs_review" || currentRow.rowStatus === "valid";
  const canConfirm = currentRow.rowStatus === "needs_review";
  const canReject = currentRow.rowStatus === "needs_review" || currentRow.rowStatus === "valid";
  const canDecideDedup = currentRow.dedupCandidates.length > 0;

  return (
    <div className="flex flex-col gap-4 rounded border bg-gray-50 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          Fila #{currentRow.rowIndex + 1} — estado actual:{" "}
          <span data-testid="row-editor-status">
            {ROW_STATUS_LABELS[currentRow.rowStatus] ?? currentRow.rowStatus}
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-4 md:flex-row">
        {sourceImageUrl && (
          <div className="shrink-0 md:w-64">
            <p className="text-xs font-medium text-gray-500">Imagen fuente</p>
            {/* Vista completa de la imagen del lote OCR. El recorte a la
                región exacta de esta fila (layout_cluster_id) es Phase 3.
                Se evita next/image para no enviar un documento sensible al
                optimizador/proxy de imágenes. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sourceImageUrl}
              alt={`Imagen fuente del lote (fila ${currentRow.rowIndex + 1})`}
              className="mt-1 max-h-96 w-full rounded border object-contain"
            />
          </div>
        )}

        <RequireCapability
          cap="patient:import"
          fallback={
            <p className="text-sm text-gray-500">
              No tienes permiso para editar esta fila (patient:import).
            </p>
          }
        >
          <div className="flex flex-1 flex-col gap-3">
            {canEditRow ? (
              <>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input label="Nombre" value={name} onChange={(event) => setName(event.target.value)} />
                  <Input label="Edad" value={age} onChange={(event) => setAge(event.target.value)} />
                  <label className="text-sm font-medium">
                    Condición
                    <select
                      className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                      value={condition}
                      onChange={(event) => setCondition(event.target.value)}
                    >
                      {Object.entries(CONDITION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm font-medium">
                    Estado clínico
                    <select
                      className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                    >
                      {Object.entries(STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="text-sm font-medium">
                  Hospital (catálogo)
                  <select
                    className="mt-1 block w-full rounded border px-3 py-2 text-sm"
                    value={hospitalId}
                    onChange={(event) => setHospitalId(event.target.value)}
                  >
                    <option value="">— sin resolver / usar texto libre —</option>
                    {[...(hospitals.data ?? [])].map((h) => (
                      <option key={String(h.id)} value={String(h.id)}>
                        {String(h.name ?? h.id)}
                      </option>
                    ))}
                  </select>
                </label>
                {!hospitalId && (
                  <Input
                    label="Hospital (texto, si no está en el catálogo)"
                    value={sourceHospitalText}
                    onChange={(event) => setSourceHospitalText(event.target.value)}
                  />
                )}

                <div className="flex items-center gap-2">
                  <Button type="button" disabled={anyPending} onClick={submitSave}>
                    {save.isPending ? "Guardando…" : "Guardar cambios"}
                  </Button>
                  {canConfirm && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={anyPending || currentRow.validationErrors.length > 0}
                      onClick={() => confirm.mutate(undefined)}
                    >
                      {confirm.isPending ? "Confirmando…" : "Confirmar"}
                    </Button>
                  )}
                  {canReject && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={anyPending}
                      onClick={() => reject.mutate(undefined)}
                    >
                      {reject.isPending ? "Rechazando…" : "Rechazar"}
                    </Button>
                  )}
                </div>

                {save.isConflict && (
                  <p role="alert" className="text-sm text-amber-700">
                    Esta fila fue modificada por otra persona. Se recargaron los datos.
                  </p>
                )}
                {save.error && (
                  <p role="alert" className="text-sm text-red-600">
                    {save.error.message}
                  </p>
                )}
                {confirm.isConflict && (
                  <p role="alert" className="text-sm text-amber-700">
                    Esta fila fue decidida por otra persona. Se recargaron los datos.
                  </p>
                )}
                {confirm.error && (
                  <p role="alert" className="text-sm text-red-600">
                    {confirm.error.message}
                  </p>
                )}
                {reject.isConflict && (
                  <p role="alert" className="text-sm text-amber-700">
                    Esta fila fue decidida por otra persona. Se recargaron los datos.
                  </p>
                )}
                {reject.error && (
                  <p role="alert" className="text-sm text-red-600">
                    {reject.error.message}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-500">
                Fila en estado terminal ({ROW_STATUS_LABELS[currentRow.rowStatus] ?? currentRow.rowStatus}
                ) — no editable.
              </p>
            )}

            {currentRow.validationErrors.length > 0 && (
              <div className="text-sm text-red-600">
                {currentRow.validationErrors.map((error) => (
                  <span key={error} className="block">
                    {error}
                  </span>
                ))}
              </div>
            )}
            {currentRow.validationWarnings.length > 0 && (
              <div className="text-sm text-amber-700">
                {currentRow.validationWarnings.map((warning) => (
                  <span key={warning} className="block">
                    {warning}
                  </span>
                ))}
              </div>
            )}

            {canDecideDedup && (
              <div className="rounded border bg-white p-3">
                <p className="text-sm font-medium">Candidatos de deduplicación</p>
                <ul className="mt-1 flex flex-col gap-2 text-sm">
                  {currentRow.dedupCandidates.map((candidate) => (
                    <li key={candidate.patientId} className="flex items-center justify-between gap-2">
                      <span>
                        posible duplicado de <strong>{candidate.name}</strong>
                        {candidate.reason ? ` (${candidate.reason})` : ""}
                      </span>
                      <Button
                        type="button"
                        disabled={anyPending}
                        onClick={() => dedup.mutate({ accept: true, patientId: candidate.patientId })}
                      >
                        {dedup.isPending ? "Guardando…" : "Aceptar"}
                      </Button>
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-2"
                  disabled={anyPending}
                  onClick={() => dedup.mutate({ accept: false })}
                >
                  {dedup.isPending ? "Guardando…" : "No es duplicado"}
                </Button>
                {dedup.isConflict && (
                  <p role="alert" className="mt-2 text-sm text-amber-700">
                    Esta fila fue decidida por otra persona. Se recargaron los datos.
                  </p>
                )}
                {dedup.error && (
                  <p role="alert" className="mt-2 text-sm text-red-600">
                    {dedup.error.message}
                  </p>
                )}
              </div>
            )}
          </div>
        </RequireCapability>
      </div>
    </div>
  );
}
