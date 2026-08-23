"use client";

/**
 * "Señales" (U15, R26/AE4 — mitad de UI del router de U14): cola de
 * transiciones de status reclamadas por una fuente externa (partner-sync),
 * pendientes de que un revisor humano las confirme o las descarte. "Señal,
 * no verdad" — el claim NUNCA pisa el status guardado hasta que esta cola lo
 * decide (ver docstring de `backend/src/services/record-signals.ts`).
 *
 * Mismo idioma que U11 (`review-queue.tsx` + `match-card.tsx`), fusionados
 * aquí en un solo archivo por el alcance de U15 (el plan solo pide
 * `signal-queue.tsx`): `useInfiniteQuery` con cursor keyset — SOLO que la
 * cola aquí es más-antigua-primero (ASC, cursor `after`) en vez de por
 * banda/score (cursor `before` de person-links) — ver
 * `record-signals.router.ts:listQuery` para por qué el cursor se llama
 * `after` aunque el idioma de codificación sea el mismo `"<n>_<id>"`. Solo la
 * PRIMERA señal cargada es interactiva (`SignalCard`, con atajos de
 * teclado); decidirla la saca de `status=pending`, así que la invalidación
 * de `useDecisionMutation` refresca la cola y `items[0]` pasa a ser la
 * siguiente sola — sin bookkeeping de índice, mismo criterio que
 * review-queue.tsx.
 *
 * Discoverability (R26/AE4, el motivo de existir de U15): un "reportada
 * encontrada" de un socio NUNCA debe quedar sin ver — por eso la cola es
 * FIFO (oldest-first) y el nav badge de `app/shell.tsx` cuenta contra este
 * MISMO endpoint (ver ese archivo).
 */
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { RequireCapability } from "@/src/shared/auth/admin-gate";
import { useAdminSessionContext } from "@/src/shared/auth/admin-session-context";
import { Button } from "@/src/ui";
import { useDecisionMutation } from "@/src/shared/mutation/use-decision-mutation";
import { clusterFichaQueryKey, fetchClusterFicha, fetchSignalsPage, postSignalDecision, signalsQueryKey } from "./api";
import { RecordSummary } from "./record-summary";
import {
  signalStatusLabel,
  type FichaTarget,
  type PendingSignalDTO,
  type SignalDecisionResponse,
  type SignalDecisionValue,
  type SignalsQueueResponse,
} from "./types";

const PAGE_LIMIT = 25;

function cursorOf(signal: PendingSignalDTO): string {
  return `${signal.createdAt}_${signal.id}`;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString("es", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SIGNAL_ACTIONS: { key: "1" | "2"; decision: SignalDecisionValue; label: string }[] = [
  { key: "1", decision: "confirmar", label: "Confirmar" },
  { key: "2", decision: "descartar", label: "Descartar" },
];

const CONFLICT_ADVANCE_DELAY_MS = 900;

/**
 * Preview de cluster de la señal ACTIVA únicamente — NUNCA por cada fila de
 * la lista (evitaría un fan-out N+1 en la cola completa, mismo criterio de
 * performance que el resto del contexto). Fetch perezoso con la MISMA forma
 * de query key que usa `clusterFichaQueryKey` (`escalation-modal.tsx` and
 * `cluster-ficha.tsx`) — así que si el revisor ya abrió esa ficha esta
 * sesión, esto sale de cache sin una llamada nueva.
 */
function ClusterPreview({
  clusterId,
  onOpenFicha,
}: {
  clusterId: string;
  onOpenFicha: (target: FichaTarget) => void;
}) {
  const query = useQuery({
    queryKey: clusterFichaQueryKey(clusterId),
    queryFn: () => fetchClusterFicha(clusterId),
  });

  const liveMembers = query.data?.item.members.filter((m) => m.removedAt === null) ?? [];

  return (
    <div className="rounded border bg-gray-50 p-2 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        Este registro tiene cluster
      </p>
      {query.isLoading ? (
        <p className="text-xs text-gray-500">Cargando miembros…</p>
      ) : (
        <p className="text-xs text-gray-600">
          {liveMembers.length > 0
            ? liveMembers.map((m) => m.name || "(sin nombre)").join(", ")
            : "Sin miembros vivos."}
        </p>
      )}
      <button
        type="button"
        className="mt-1 text-xs text-blue-700 hover:underline"
        onClick={() => onOpenFicha({ type: "cluster", clusterId })}
      >
        Ver ficha
      </button>
    </div>
  );
}

function SignalCard({
  signal,
  onAdvance,
  onOpenFicha,
}: {
  signal: PendingSignalDTO;
  /** Avanza a la siguiente señal — se llama tras éxito (incluye replay
   *  idempotente, SIEMPRE tratado como éxito, mismo contrato que
   *  MatchCard/U11) y tras un 409 real (con respiro visible, ver
   *  CONFLICT_ADVANCE_DELAY_MS). */
  onAdvance: () => void;
  onOpenFicha: (target: FichaTarget) => void;
}) {
  const { can } = useAdminSessionContext();
  const canReview = can("person:review");

  const [selected, setSelected] = useState<SignalDecisionValue | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const conflictTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keyboard-first: al armar "2" (descartar, nota obligatoria) el foco salta
  // a la nota directamente — mismo criterio que "3" (inseguro) en MatchCard.
  useEffect(() => {
    if (selected === "descartar") noteRef.current?.focus();
  }, [selected]);

  const decision = useDecisionMutation<
    { decision: SignalDecisionValue; note?: string },
    SignalDecisionResponse
  >({
    mutationFn: (vars) => postSignalDecision(signal.id, vars),
    invalidateKeys: [signalsQueryKey()],
    onSuccess: () => onAdvance(),
  });

  // 409 real: se muestra el aviso un momento y LUEGO se avanza — mismo
  // criterio que MatchCard (throughput de la cola con feedback visible).
  useEffect(() => {
    if (!decision.isConflict) return;
    conflictTimerRef.current = setTimeout(onAdvance, CONFLICT_ADVANCE_DELAY_MS);
    return () => {
      if (conflictTimerRef.current) clearTimeout(conflictTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision.isConflict]);

  function commit(decisionOverride?: SignalDecisionValue) {
    const target = decisionOverride ?? selected;
    if (!target || decision.isPending) return;
    if (target === "descartar" && note.trim().length === 0) {
      setNoteError(true);
      return;
    }
    setNoteError(false);
    // La nota SOLO se manda para 'descartar' — nunca para 'confirmar', ni
    // siquiera si quedó texto sin limpiar de una selección anterior a "2"
    // (mismo criterio que commit() en MatchCard).
    decision.mutate({ decision: target, note: target === "descartar" ? note.trim() : undefined });
  }

  function selectAction(next: SignalDecisionValue) {
    setNoteError(false);
    if (selected !== "descartar" || next !== "descartar") {
      setNote("");
    }
    setSelected(next);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Guard de scope: el listener es global (window), pero SearchPanel se
      // monta siempre por encima de esta tarjeta (family-search-admin.tsx) —
      // sin esto, un Enter en el buscador comete la decisión armada de la
      // tarjeta de FONDO y además le hace preventDefault al submit del
      // buscador. Solo se procesa el evento si no vino de ningún foco
      // específico (target === document.body, el caso "nada enfocado") o si
      // vino de dentro de esta tarjeta. Mismo criterio que MatchCard.
      const target = event.target as HTMLElement | null;
      // `instanceof Node` además de null-check: un evento sintético puede traer
      // window (u otro no-Node) como target, y `contains()` lanza sobre eso.
      const inScope =
        target === document.body || (target instanceof Node && containerRef.current?.contains(target));
      if (!inScope) return;
      if (decision.isPending || !canReview || decision.isConflict) return;
      const isTextField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

      if (event.key === "Enter") {
        if (isTextField && event.shiftKey) return; // permite salto de línea en la nota
        event.preventDefault();
        commit();
        return;
      }
      if (isTextField) return; // 1/2 no deben interceptar la escritura en la nota
      const action = SIGNAL_ACTIONS.find((a) => a.key === event.key);
      if (action) {
        event.preventDefault();
        selectAction(action.decision);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, note, decision.isPending, canReview, decision.isConflict]);

  if (decision.isConflict) {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-6 text-center"
      >
        <p className="font-medium text-amber-800">Esta señal ya fue decidida por otra persona.</p>
        <p className="text-sm text-amber-700">Pasando a la siguiente señal…</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} data-testid="signal-card" className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="rounded border p-3">
        <RecordSummary record={signal.record} label="Registro" />
      </div>

      <div className="flex flex-col gap-2 rounded border bg-gray-50 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="signal-claimed-status">
            <strong>El socio reporta:</strong> {signalStatusLabel(signal.claimedStatus)}
          </span>
          <span data-testid="signal-stored-status">
            <strong>Estado local:</strong> {signalStatusLabel(signal.storedStatus)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            Fuente: {signal.source}
          </span>
          <span className="text-xs text-gray-500">{formatDate(signal.createdAt)}</span>
        </div>
      </div>

      {signal.record?.clusterId && (
        <ClusterPreview clusterId={signal.record.clusterId} onOpenFicha={onOpenFicha} />
      )}

      {decision.error && (
        <p role="alert" className="text-sm text-red-600">
          {decision.error.message}
        </p>
      )}

      <RequireCapability
        cap="person:review"
        fallback={
          <p className="text-sm text-gray-500">
            No tienes permiso para decidir señales (person:review) — solo lectura.
          </p>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {SIGNAL_ACTIONS.map((action) => (
              <Button
                key={action.decision}
                type="button"
                variant={selected === action.decision ? "primary" : "ghost"}
                disabled={decision.isPending}
                onClick={() => {
                  selectAction(action.decision);
                  // 'confirmar' no lleva nota — commit inmediato al hacer
                  // click (mismo criterio que confirmar/rechazar en
                  // MatchCard); 'descartar' arma y espera la nota.
                  if (action.decision !== "descartar") commit(action.decision);
                }}
              >
                {action.key} · {action.label}
              </Button>
            ))}
          </div>

          {selected === "descartar" && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium" htmlFor="signal-card-note">
                Nota (obligatoria)
              </label>
              <textarea
                id="signal-card-note"
                data-testid="signal-card-note"
                ref={noteRef}
                className="min-h-16 rounded border p-2 text-sm"
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  if (event.target.value.trim().length > 0) setNoteError(false);
                }}
                placeholder="¿Por qué se descarta esta señal?"
              />
              {noteError && (
                <p role="alert" className="text-xs text-red-600">
                  La nota es obligatoria para descartar una señal.
                </p>
              )}
              <Button type="button" disabled={decision.isPending} onClick={() => commit("descartar")}>
                {decision.isPending ? "Enviando…" : "Enviar decisión"}
              </Button>
            </div>
          )}

          <p className="text-xs text-gray-500">
            Atajos de teclado: 1 confirmar · 2 descartar · Enter confirma la selección.
          </p>
        </div>
      </RequireCapability>
    </div>
  );
}

export function SignalQueue({ onOpenFicha }: { onOpenFicha: (target: FichaTarget) => void }) {
  const query = useInfiniteQuery({
    queryKey: signalsQueryKey(),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchSignalsPage({ after: pageParam, limit: PAGE_LIMIT }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SignalsQueueResponse) =>
      lastPage.items.length === PAGE_LIMIT
        ? cursorOf(lastPage.items[lastPage.items.length - 1]!)
        : undefined,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const [active, ...upcoming] = items;

  if (query.isLoading) {
    return <p className="text-sm text-gray-500">Cargando señales…</p>;
  }

  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {query.error instanceof Error ? query.error.message : "Error al cargar las señales."}
      </p>
    );
  }

  if (!active) {
    return (
      <div className="rounded border border-dashed p-8 text-center text-sm text-gray-500">
        No hay señales pendientes.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SignalCard key={active.id} signal={active} onAdvance={() => {}} onOpenFicha={onOpenFicha} />

      {upcoming.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Próximas señales ({upcoming.length} cargada{upcoming.length === 1 ? "" : "s"})
          </p>
          <ul className="flex flex-col gap-2">
            {upcoming.map((signal) => (
              <li
                key={signal.id}
                data-testid="signal-preview-item"
                className="rounded border p-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{signal.record?.name || "(sin nombre)"}</span>
                  <span className="text-xs text-gray-500">
                    {signalStatusLabel(signal.claimedStatus)} · {signal.source}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="ghost"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Cargando…" : "Cargar más"}
          </Button>
        </div>
      )}
    </div>
  );
}
