"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useTurnstile } from "@/hooks/useTurnstile";
import { qk } from "@/lib/query-keys";
import {
  downloadOfflineDraft,
  listPending,
  removePending,
  type OfflineDraft,
} from "@/lib/offline-queue";
import {
  postReportToServer,
  type ReportSubmission,
} from "./post-report";
import type { EmergencyReport } from "@/lib/types";

function statusCopy(status: OfflineDraft["status"]): string {
  switch (status) {
    case "ready":
      return "Listo para enviar";
    case "verification_required":
      return "Requiere tu confirmación";
    case "expired":
      return "Caducado (30 días). Expórtalo o elimínalo.";
    case "incompatible":
      return "No corresponde a este incidente";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export default function OfflineDraftBanner({
  onAccepted,
}: {
  onAccepted: (report: EmergencyReport | undefined) => void;
}) {
  const qc = useQueryClient();
  const { mountRef, getToken, enabled } = useTurnstile();
  const draftsQuery = useQuery({
    queryKey: qk.offlineDrafts,
    queryFn: listPending,
  });
  const drafts = draftsQuery.data ?? [];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: qk.offlineDrafts });
  }, [qc]);

  const sendDraft = useCallback(
    async (draft: OfflineDraft) => {
      if (draft.status === "expired" || draft.status === "incompatible") return;
      setBusyId(draft.localId);
      setError(null);
      try {
        const turnstileToken = enabled ? await getToken() : undefined;
        const submission: ReportSubmission = {
          ...draft.payload,
          turnstileToken,
        };
        const outcome = await postReportToServer(submission);
        if (outcome.status === "ok") {
          await removePending(draft.localId);
          onAccepted(outcome.report);
          await refresh();
          return;
        }
        if (outcome.status === "drop") {
          setError(outcome.error);
          return;
        }
        setError(
          "Sin conexión. El borrador sigue en este dispositivo. Inténtalo de nuevo.",
        );
      } finally {
        setBusyId(null);
      }
    },
    [enabled, getToken, onAccepted, refresh],
  );

  const deleteDraft = useCallback(
    async (draft: OfflineDraft) => {
      const ok = window.confirm(
        "¿Eliminar este borrador de este dispositivo? No se puede deshacer.",
      );
      if (!ok) return;
      await removePending(draft.localId);
      await refresh();
    },
    [refresh],
  );

  if (drafts.length === 0) return null;

  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-[var(--qi-warning)] bg-[var(--qi-warning-surface)] px-4 py-3 text-sm"
      style={{ color: "var(--qi-warning-strong)" }}
    >
      <p className="flex items-center gap-2 font-semibold">
        <WifiOff size={16} aria-hidden="true" />
        {drafts.length === 1
          ? "1 borrador en este dispositivo"
          : `${drafts.length} borradores en este dispositivo`}
      </p>
      <p className="mt-1 text-[var(--etext2)]">
        No se envían solos. Revisa, exporta o envía cada uno. El envío pide
        verificación humana de nuevo.
      </p>
      {enabled ? <div ref={mountRef} className="mt-2" /> : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--etext)]">
          {error}
        </p>
      ) : null}
      <ul className="mt-3 grid gap-2">
        {drafts.map((draft) => (
          <li
            key={draft.localId}
            className="rounded-lg border border-[var(--eborder)] bg-[var(--esurf)] px-3 py-2 text-[var(--etext)]"
          >
            <p className="text-xs text-[var(--etext2)]">
              {new Date(draft.createdAt).toLocaleString("es")} ·{" "}
              {statusCopy(draft.status)}
            </p>
            <p className="mt-1 font-medium">{draft.payload.place}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="e-btn-secondary rounded-lg px-3 py-1.5 text-xs"
                style={{ minHeight: 0 }}
                disabled={
                  busyId === draft.localId ||
                  draft.status === "expired" ||
                  draft.status === "incompatible"
                }
                onClick={() => void sendDraft(draft)}
              >
                Enviar
              </button>
              <button
                type="button"
                className="e-btn-secondary rounded-lg px-3 py-1.5 text-xs"
                style={{ minHeight: 0 }}
                onClick={() => downloadOfflineDraft(draft)}
              >
                Exportar
              </button>
              <button
                type="button"
                className="e-btn-secondary rounded-lg px-3 py-1.5 text-xs"
                style={{ minHeight: 0 }}
                onClick={() => void deleteDraft(draft)}
              >
                Eliminar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
