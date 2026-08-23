"use client";

/**
 * Ficha (panel lateral, NO modal — la única excepción es el confirm de
 * unmerge/escalación, ver `modal.tsx`): miembros lado a lado + historia de
 * decisiones + vincular manualmente + deshacer fusión. §7.2 del plan.
 *
 * Dos formas de llegar aquí (`FichaTarget`, ver types.ts):
 *  - `cluster`: el caso normal — GET .../clusters/:id (miembros + historia).
 *  - `standalone`: un PRN resuelto que TODAVÍA no tiene cluster vivo (nunca
 *    pasó por una confirmación) — el backend no tiene una "ficha de un solo
 *    registro", así que se arma aquí con el `RecordDisplayDTO` que ya trajo
 *    la búsqueda. Sin historia de decisiones en ese caso (no hay ninguna).
 */
import { useState } from "react";
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { RequireCapability } from "@/src/shared/auth/admin-gate";
import { Button } from "@/src/ui";
import {
  DecisionRequestError,
  useDecisionMutation,
} from "@/src/shared/mutation/use-decision-mutation";
import { fetchClusterFicha, postUnmerge, queueQueryKey, signalsQueryKey, clusterFichaQueryKey } from "./api";
import { ManualLinkSearch } from "./manual-link-search";
import { Modal } from "./modal";
import { RecordSummary } from "./record-summary";
import type {
  ClusterMemberFichaDTO,
  DecisionHistoryEntryDTO,
  FichaTarget,
  SignalsQueueResponse,
  UnmergeResponse,
} from "./types";

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString("es", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DECISION_LABELS: Record<string, string> = {
  confirmed: "Confirmado",
  rejected: "Rechazado",
  unsure: "Marcado como inseguro",
  rescinded: "Fusión deshecha",
};

/** Decisión MÁS RECIENTE por linkId — mismo idioma que
 *  `loadPriorRejections` en person-links.ts ("ya está ordenado desc, se
 *  queda con la primera vista"): solo un link cuya decisión más reciente sea
 *  'confirmed' sigue activo hoy y admite "Deshacer fusión". */
function mostRecentDecisionByLinkId(
  decisions: DecisionHistoryEntryDTO[],
): Map<string, DecisionHistoryEntryDTO> {
  const out = new Map<string, DecisionHistoryEntryDTO>();
  for (const d of decisions) {
    if (!out.has(d.linkId)) out.set(d.linkId, d);
  }
  return out;
}

function MemberRow({ member }: { member: ClusterMemberFichaDTO }) {
  const isLive = member.removedAt === null;
  return (
    <div className={`rounded border p-2 ${isLive ? "" : "opacity-60"}`}>
      <RecordSummary record={member} />
      <p className="mt-1 text-xs text-gray-500">
        {isLive ? "Miembro vivo" : `Retirado el ${formatDate(member.removedAt!)}`} — agregado{" "}
        {formatDate(member.addedAt)} por {member.addedBy}
      </p>
    </div>
  );
}

function DecisionRow({
  decision,
  canUnmerge,
  onRequestUnmerge,
}: {
  decision: DecisionHistoryEntryDTO;
  canUnmerge: boolean;
  onRequestUnmerge: (decision: DecisionHistoryEntryDTO) => void;
}) {
  return (
    <li className="rounded border p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>{DECISION_LABELS[decision.decision] ?? decision.decision}</strong> —{" "}
          {decision.prnA} ↔ {decision.prnB}
        </span>
        <span className="text-xs text-gray-500">
          {formatDate(decision.decidedAt)} · {decision.decidedBy}
        </span>
      </div>
      {decision.note && <p className="mt-1 text-xs text-gray-600">Nota: {decision.note}</p>}
      {canUnmerge && decision.decision === "confirmed" && (
        <RequireCapability cap="person:merge">
          <Button type="button" variant="ghost" className="mt-1" onClick={() => onRequestUnmerge(decision)}>
            Deshacer fusión
          </Button>
        </RequireCapability>
      )}
    </li>
  );
}

function ClusterView({
  clusterId,
  onJumpToQueue,
  onOpenSignals,
}: {
  clusterId: string;
  onJumpToQueue: (linkId: string) => void;
  /** U15: abre la pestaña "Señales" (family-search-admin.tsx) — usado por el
   *  chip "Señales pendientes (N)" abajo. Opcional: StandaloneView no lo
   *  necesita (el plan U15 §4 acota el chip a clusters, ver ese archivo). */
  onOpenSignals?: () => void;
}) {
  const query = useQuery({
    queryKey: clusterFichaQueryKey(clusterId),
    queryFn: () => fetchClusterFicha(clusterId),
  });
  const [unmergeTarget, setUnmergeTarget] = useState<DecisionHistoryEntryDTO | null>(null);
  const [unmergeNote, setUnmergeNote] = useState("");

  // U15 — chip "Señales pendientes (N)": el contrato de GET .../clusters/:id
  // (ClusterFichaDTO, person-clusters.ts) NO trae info de señales, así que se
  // deriva client-side de lo que YA esté en cache de la cola de señales
  // (misma query key que signal-queue.tsx/shell.tsx, ver
  // api.ts:signalsQueryKey) — sin disparar una llamada nueva.
  // LIMITACIÓN documentada (plan U15 §4, deviation reportada): si el revisor
  // nunca visitó la pestaña "Señales" en esta sesión (cache vacío) o la señal
  // pendiente cae más allá de las páginas ya cargadas, el chip NO aparece
  // aunque la señal exista — el contrato actual no ofrece un total ni un
  // filtro por cluster que permita saberlo sin esa carga previa.
  const queryClient = useQueryClient();
  const cachedSignals = queryClient.getQueryData<InfiniteData<SignalsQueueResponse>>(
    signalsQueryKey(),
  );
  const pendingSignalsForCluster =
    cachedSignals?.pages
      .flatMap((p) => p.items)
      .filter((s) => s.record?.clusterId === clusterId).length ?? 0;

  const unmerge = useDecisionMutation<{ note?: string }, UnmergeResponse>({
    mutationFn: (vars) => postUnmerge(unmergeTarget!.linkId, vars.note),
    invalidateKeys: [clusterFichaQueryKey(clusterId), queueQueryKey()],
    onSuccess: () => {
      setUnmergeTarget(null);
      setUnmergeNote("");
    },
  });

  if (query.isLoading) return <p className="text-sm text-gray-500">Cargando ficha…</p>;
  if (query.isError) {
    const notFound = query.error instanceof DecisionRequestError && query.error.status === 404;
    return (
      <p role="alert" className="text-sm text-red-600">
        {notFound ? "Cluster no encontrado." : "Error al cargar la ficha del cluster."}
      </p>
    );
  }
  const ficha = query.data!.item;
  const liveMembers = ficha.members.filter((m) => m.removedAt === null);
  const historicalMembers = ficha.members.filter((m) => m.removedAt !== null);
  const activeConfirmed = mostRecentDecisionByLinkId(ficha.decisions);

  const anchorPrn = liveMembers[0]?.prn ?? "";

  function recordForPrn(prn: string): ClusterMemberFichaDTO | null {
    return ficha.members.find((m) => m.prn === prn) ?? null;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold">Cluster {ficha.clusterId}</h2>
        <p className="text-sm text-gray-500">
          Estado: {ficha.status} — creado {formatDate(ficha.createdAt)}
        </p>
        {pendingSignalsForCluster > 0 && (
          <button
            type="button"
            data-testid="cluster-ficha-signals-chip"
            className="mt-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-200"
            onClick={onOpenSignals}
            disabled={!onOpenSignals}
          >
            Señales pendientes ({pendingSignalsForCluster})
          </button>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Miembros vivos ({liveMembers.length})
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {liveMembers.map((member) => (
            <MemberRow key={member.prn} member={member} />
          ))}
        </div>
        {historicalMembers.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm text-gray-500">
              Historia de membresía ({historicalMembers.length} retirado(s))
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {historicalMembers.map((member) => (
                <MemberRow key={`${member.prn}-${member.addedAt}`} member={member} />
              ))}
            </div>
          </details>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          Historia de decisiones ({ficha.decisions.length})
        </h3>
        {ficha.decisions.length === 0 ? (
          <p className="text-sm text-gray-500">Sin decisiones registradas.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ficha.decisions.map((decision) => (
              <DecisionRow
                key={decision.id}
                decision={decision}
                canUnmerge={activeConfirmed.get(decision.linkId)?.id === decision.id}
                onRequestUnmerge={(d) => {
                  setUnmergeNote("");
                  setUnmergeTarget(d);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {anchorPrn && (
        <ManualLinkSearch
          anchorPrn={anchorPrn}
          excludePrns={liveMembers.map((m) => m.prn)}
          onJumpToQueue={onJumpToQueue}
        />
      )}

      {unmergeTarget && (
        <Modal title="Deshacer fusión — ¿confirmas?" onCancel={() => setUnmergeTarget(null)}>
          <p className="text-sm text-gray-700">
            Esto separa los dos registros; ambos vuelven a ser identidades independientes. La
            confirmación original queda en la historia (nunca se borra) y se agrega una nueva
            entrada “fusión deshecha”.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex-1 rounded border p-2">
              <RecordSummary record={recordForPrn(unmergeTarget.prnA)} label="Lado A" />
            </div>
            <div className="flex-1 rounded border p-2">
              <RecordSummary record={recordForPrn(unmergeTarget.prnB)} label="Lado B" />
            </div>
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium" htmlFor="unmerge-note">
            Nota (opcional)
            <textarea
              id="unmerge-note"
              className="min-h-16 rounded border p-2 text-sm font-normal"
              value={unmergeNote}
              onChange={(event) => setUnmergeNote(event.target.value)}
            />
          </label>
          {unmerge.error && (
            <p role="alert" className="text-sm text-red-600">
              {unmerge.error.message}
            </p>
          )}
          {unmerge.isConflict && (
            <p role="alert" className="text-sm text-amber-700">
              Este vínculo cambió de estado; recarga la ficha e inténtalo de nuevo.
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button type="button" variant="ghost" onClick={() => setUnmergeTarget(null)}>
              Cancelar
            </Button>
            <Button
              type="button"
              disabled={unmerge.isPending}
              onClick={() => unmerge.mutate({ note: unmergeNote.trim() || undefined })}
            >
              {unmerge.isPending ? "Deshaciendo…" : "Confirmar"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function StandaloneView({
  record,
  onJumpToQueue,
}: {
  record: FichaTarget & { type: "standalone" };
  onJumpToQueue: (linkId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-bold">Registro sin cluster</h2>
        <p className="text-sm text-gray-500">
          Este PRN todavía no forma parte de ningún cluster: solo se crea un cluster tras la
          PRIMERA confirmación de un vínculo. Aquí puedes proponer manualmente el primer vínculo.
        </p>
      </div>
      <div className="rounded border p-3">
        <RecordSummary record={record.record} />
      </div>
      <ManualLinkSearch
        anchorPrn={record.record.prn}
        excludePrns={[record.record.prn]}
        onJumpToQueue={onJumpToQueue}
      />
    </div>
  );
}

export function ClusterFicha({
  target,
  onJumpToQueue,
  onOpenSignals,
}: {
  target: FichaTarget;
  onJumpToQueue: (linkId: string) => void;
  /** U15: abre la pestaña "Señales" — ver el chip en ClusterView. */
  onOpenSignals?: () => void;
}) {
  return (
    <div className="rounded-lg border p-4">
      {target.type === "cluster" ? (
        <ClusterView
          clusterId={target.clusterId}
          onJumpToQueue={onJumpToQueue}
          onOpenSignals={onOpenSignals}
        />
      ) : (
        <StandaloneView record={target} onJumpToQueue={onJumpToQueue} />
      )}
    </div>
  );
}
