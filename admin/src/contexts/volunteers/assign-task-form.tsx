"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/src/ui";
import { adminFetch } from "../../shared/http/admin-fetch";
import { useModelList, modelQueryKey } from "../models/ui/use-model-list";

/**
 * Formulario "Asignar" de una tarea (bajo la tabla cuando el modelo es
 * volunteer-tasks): elige un voluntario registrado y el backend crea la
 * asignación con token y le envía el correo de bienvenida con el link.
 * Errores visibles: 400 si el contacto no es correo, 503 si falta SMTP.
 */
export function AssignTaskForm({
  taskId,
  taskTitle,
  onClose,
}: {
  taskId: string;
  taskTitle: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const volunteers = useModelList("volunteers");
  const [volunteerId, setVolunteerId] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await adminFetch(
        `/api/models/volunteer-tasks/${encodeURIComponent(taskId)}/assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volunteerId }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { error?: string; sentTo?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Error ${res.status}`);
      return body;
    },
    onSuccess: (body) => {
      setSentTo(body?.sentTo ?? null);
      queryClient.invalidateQueries({ queryKey: modelQueryKey("volunteer-tasks") });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  if (sentTo) {
    return (
      <div className="grid gap-2 rounded border border-green-200 bg-green-50 p-3 text-sm">
        <p className="font-medium text-green-800">
          Asignación enviada a {sentTo}. La tarea quedó en estado &quot;assigned&quot;.
        </p>
        <div>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 rounded-2xl border border-border-soft bg-white p-4 shadow-sm sm:grid-cols-2"
    >
      <p className="text-sm text-gray-600 sm:col-span-2">
        Asignar <strong>{taskTitle}</strong> a un voluntario. Recibirá el correo de
        bienvenida con el mapa y los botones de respuesta.
      </p>
      <label className="text-sm">
        <span className="mb-1 block font-medium">Voluntario</span>
        <select
          className="w-full rounded-lg border border-border-soft bg-white px-3 py-2"
          required
          value={volunteerId}
          onChange={(event) => setVolunteerId(event.target.value)}
        >
          <option value="">
            {volunteers.isLoading ? "Cargando voluntarios…" : "— Elige un voluntario —"}
          </option>
          {(volunteers.data ?? []).map((v) => (
            <option key={String(v.id)} value={String(v.id)}>
              {String(v.name)} — {String(v.contact)}
            </option>
          ))}
        </select>
      </label>
      {mutation.error && (
        <p role="alert" className="text-sm text-red-600 sm:col-span-2">
          {mutation.error.message}
        </p>
      )}
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={mutation.isPending || !volunteerId}>
          {mutation.isPending ? "Enviando…" : "Asignar y enviar correo"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
