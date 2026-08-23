"use client";

/**
 * Escalación de fusión ANCLADA (R18): confirmar este vínculo uniría dos
 * clusters que ya tienen identidad propia — se necesita `person:merge` para
 * completarlo. Única señal disponible hoy: el 403 de
 * POST .../decision con el mensaje distintivo de
 * `AnchoredMergeEscalationError` (ver person-links.ts) — la cola NO trae un
 * flag "esto es una fusión anclada" de antemano (QueueItemDTO solo tiene
 * `link`/`a`/`b`/`priorRejection`, sin info de anclaje), así que este modal
 * SOLO puede aparecer DESPUÉS de que el revisor intenta "Confirmar
 * coincidencia" — no hay forma de pre-advertir antes del intento con el
 * contrato actual. Documentado en el informe de U11 como el fallback que el
 * propio plan autorizaba explícitamente.
 */
import { useQuery } from "@tanstack/react-query";
import { RequireCapability } from "@/src/shared/auth/admin-gate";
import { Button } from "@/src/ui";
import { clusterFichaQueryKey, fetchClusterFicha } from "./api";
import { Modal } from "./modal";
import { RecordSummary } from "./record-summary";
import type { ClusterFichaDTO, QueueItemDTO } from "./types";

function ClusterColumn({ clusterId, fallback, title }: { clusterId: string | null; fallback: QueueItemDTO["a"]; title: string }) {
  const query = useQuery({
    queryKey: clusterFichaQueryKey(clusterId ?? ""),
    queryFn: () => fetchClusterFicha(clusterId!),
    enabled: Boolean(clusterId),
  });

  return (
    <div className="flex-1 rounded border p-3">
      <h3 className="mb-2 text-sm font-semibold text-gray-700">{title}</h3>
      {!clusterId && <RecordSummary record={fallback} />}
      {clusterId && query.isLoading && <p className="text-sm text-gray-500">Cargando cluster…</p>}
      {clusterId && query.isError && (
        <p role="alert" className="text-sm text-red-600">
          No se pudo cargar el cluster.
        </p>
      )}
      {clusterId && query.data && (
        <ClusterMembersList item={query.data.item} />
      )}
    </div>
  );
}

function ClusterMembersList({ item }: { item: ClusterFichaDTO }) {
  const live = item.members.filter((m) => m.removedAt === null);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-500">{live.length} miembro(s) vivo(s)</p>
      {live.map((member) => (
        <div key={member.prn} className="rounded border bg-gray-50 p-2">
          <RecordSummary record={member} />
        </div>
      ))}
    </div>
  );
}

export function EscalationModal({
  item,
  isPending,
  onCancel,
  onConfirm,
}: {
  item: QueueItemDTO;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="Fusión anclada — se requiere confirmación adicional" onCancel={onCancel}>
      <p className="text-sm text-gray-700">
        Esta confirmación uniría dos clusters que ya tienen identidad propia (cada uno tiene
        más de un registro vivo o ya tiene otro vínculo confirmado). Revisa ambos clusters
        completos antes de continuar — esta acción requiere el permiso{" "}
        <code className="rounded bg-gray-100 px-1">person:merge</code>.
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <ClusterColumn clusterId={item.a?.clusterId ?? null} fallback={item.a} title="Cluster A" />
        <ClusterColumn clusterId={item.b?.clusterId ?? null} fallback={item.b} title="Cluster B" />
      </div>

      <div className="flex items-center justify-end gap-2 border-t pt-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <RequireCapability
          cap="person:merge"
          fallback={
            <p className="text-xs text-gray-500">
              No tienes permiso para completar una fusión anclada (person:merge).
            </p>
          }
        >
          <Button type="button" disabled={isPending} onClick={onConfirm}>
            {isPending ? "Confirmando…" : "Confirmar fusión anclada"}
          </Button>
        </RequireCapability>
      </div>
    </Modal>
  );
}
