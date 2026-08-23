"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@/src/ui";
import { adminFetch } from "../../shared/http/admin-fetch";
import { modelQueryKey } from "../models/ui/use-model-list";

/**
 * Formulario "Contactar" de un voluntario (se renderiza bajo la tabla cuando
 * el modelo es volunteers). Llama al BFF /api/models/volunteers/<id>/message;
 * el backend envía el correo y marca el registro pending → contacted.
 *
 * Si el contacto no parece un correo (p.ej. WhatsApp), el backend responde
 * 400 y aquí se muestra su mensaje — nunca se silencia el fallo.
 */
export function VolunteerMessageForm({
  id,
  contact,
  onClose,
}: {
  id: string;
  contact: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (input: { subject: string; message: string }) => {
      const res = await adminFetch(
        `/api/models/volunteers/${encodeURIComponent(id)}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { error?: string; sentTo?: string }
        | null;
      if (!res.ok) throw new Error(body?.error ?? `Error ${res.status}`);
      return body;
    },
    onSuccess: (body) => {
      setSentTo(body?.sentTo ?? contact);
      queryClient.invalidateQueries({ queryKey: modelQueryKey("volunteers") });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ subject, message });
  }

  if (sentTo) {
    return (
      <div className="grid gap-2 rounded border border-green-200 bg-green-50 p-3 text-sm">
        <p className="font-medium text-green-800">Mensaje enviado a {sentTo}.</p>
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
      <p className="text-sm text-ink-muted sm:col-span-2">
        Enviar correo a <strong>{contact}</strong>. Al enviarse, el registro pasa a
        &quot;Contactado&quot; si estaba pendiente.
      </p>
      <Input
        label="Asunto"
        required
        value={subject}
        onChange={(event) => setSubject(event.target.value)}
      />
      <label className="text-sm sm:col-span-2">
        <span className="mb-1 block font-medium">Mensaje</span>
        <textarea
          className="w-full rounded-lg border border-border-soft bg-white px-3 py-2"
          rows={4}
          required
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      {mutation.error && (
        <p role="alert" className="text-sm text-red-600 sm:col-span-2">
          {mutation.error.message}
        </p>
      )}
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Enviando…" : "Enviar correo"}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
