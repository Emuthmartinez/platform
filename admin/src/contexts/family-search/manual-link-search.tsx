"use client";

/**
 * Búsqueda-y-adjuntar manual (R16, §7.2/§7.4 del plan): busca por nombre o
 * PRN sobre `records/search` y propone un vínculo con `propose`. El endpoint
 * `propose` es PAR A PAR (prnA/prnB) — el backend no tiene un verbo "adjuntar
 * a este cluster" (ver `manualProposeLink` en person-links.ts) — así que U11
 * ancla la propuesta al PRN que la ficha ya tiene abierta (prop `anchorPrn`).
 * Con clusters de >2 miembros esto crea un link nuevo contra ESE miembro
 * específico, no contra "el cluster" en abstracto; documentado como
 * deviation en el informe de U11.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@/src/ui";
import { fetchRecordsSearch, postPropose, queueQueryKey, recordsSearchQueryKey } from "./api";
import { RecordSummary } from "./record-summary";

export function ManualLinkSearch({
  anchorPrn,
  excludePrns,
  onJumpToQueue,
}: {
  /** El PRN al que se ancla cada propuesta nueva — normalmente el primer
   *  miembro vivo del cluster que se está viendo. */
  anchorPrn: string;
  /** PRNs a excluir de los resultados (miembros ya presentes en este
   *  cluster/registro — proponerse a sí mismo ya lo rechaza el backend con
   *  400, pero mejor no ofrecerlo siquiera). */
  excludePrns: string[];
  onJumpToQueue: (linkId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [confirmation, setConfirmation] = useState<{ linkId: string } | null>(null);
  const queryClient = useQueryClient();

  const search = useQuery({
    queryKey: recordsSearchQueryKey(submittedQuery),
    queryFn: () => fetchRecordsSearch(submittedQuery),
    enabled: submittedQuery.trim().length >= 2,
  });

  const propose = useMutation({
    mutationFn: (targetPrn: string) => postPropose(anchorPrn, targetPrn),
    onSuccess: async (result) => {
      setConfirmation({ linkId: result.item.id });
      await queryClient.invalidateQueries({ queryKey: queueQueryKey() });
    },
  });

  const results = (search.data?.results ?? []).filter((r) => !excludePrns.includes(r.prn));

  return (
    <div className="flex flex-col gap-3 rounded border p-3">
      <p className="text-sm font-medium">Vincular otro registro manualmente</p>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setConfirmation(null);
          setSubmittedQuery(query.trim());
        }}
      >
        <Input
          label="Buscar por nombre o PRN"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit">Buscar</Button>
      </form>

      {search.isLoading && submittedQuery && <p className="text-sm text-gray-500">Buscando…</p>}
      {search.isError && (
        <p role="alert" className="text-sm text-red-600">
          Error al buscar registros.
        </p>
      )}

      {results.length > 0 && (
        <ul className="flex flex-col gap-2">
          {results.map((record) => (
            <li
              key={record.prn}
              className="flex items-center justify-between gap-2 rounded border p-2"
            >
              <RecordSummary record={record} />
              <Button type="button" disabled={propose.isPending} onClick={() => propose.mutate(record.prn)}>
                {propose.isPending ? "Adjuntando…" : "Adjuntar"}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {submittedQuery && !search.isLoading && !search.isError && results.length === 0 && (
        <p className="text-sm text-gray-500">Sin resultados para “{submittedQuery}”.</p>
      )}

      {propose.isError && (
        <p role="alert" className="text-sm text-red-600">
          {propose.error instanceof Error ? propose.error.message : "No se pudo crear la propuesta."}
        </p>
      )}

      {confirmation && (
        <p
          role="status"
          className="rounded border border-green-300 bg-green-50 p-2 text-sm text-green-800"
        >
          Propuesta creada — pendiente en la cola de revisión.{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => onJumpToQueue(confirmation.linkId)}
          >
            Ir a la cola
          </button>
        </p>
      )}
    </div>
  );
}
