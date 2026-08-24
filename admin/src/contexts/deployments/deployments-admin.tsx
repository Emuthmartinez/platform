"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Button, Input } from "@/src/ui";
import {
  useCreateDeployment,
  useDeleteDeployment,
  useDeploymentCatalog,
} from "./use-deployments";

export function DeploymentsAdmin() {
  const { data, isLoading, isError } = useDeploymentCatalog();
  const create = useCreateDeployment();
  const remove = useDeleteDeployment();
  const [hostname, setHostname] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [incidentId, setIncidentId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const incidentsForOrg = useMemo(
    () => (data?.incidents ?? []).filter((row) => row.organizationId === organizationId),
    [data?.incidents, organizationId],
  );

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!hostname.trim() || !organizationId || !incidentId) {
      setError("Hostname, organización e incidente son obligatorios.");
      return;
    }
    try {
      await create.mutateAsync({
        hostname: hostname.trim(),
        organizationId,
        incidentId,
      });
      setHostname("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el deployment.");
    }
  }

  async function onDelete(host: string) {
    if (!confirm(`¿Borrar el deployment ${host}? El hostname dejará de resolver inquilino.`)) return;
    setError(null);
    try {
      await remove.mutateAsync(host);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo borrar.");
    }
  }

  if (isLoading) return <p className="mt-4 text-sm text-gray-500">Cargando deployments…</p>;
  if (isError) return <p className="mt-4 text-sm text-red-600">No se pudieron cargar los deployments.</p>;

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Deployments</h1>
        <p className="mt-1 text-sm text-gray-500">
          Cada hostname canónico apunta a una organización y un incidente. El
          hostname en uso de este entorno no se puede borrar.
        </p>
      </div>

      <form onSubmit={(e) => void onCreate(e)} className="rounded border bg-gray-50 p-4">
        <h2 className="text-lg font-semibold">Añadir hostname</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input
            label="Hostname"
            value={hostname}
            onChange={(ev) => setHostname(ev.target.value)}
            placeholder="preview.example.org"
          />
          <label className="text-sm">
            Organización
            <select
              className="mt-1 w-full rounded border px-2 py-1"
              value={organizationId}
              onChange={(ev) => {
                setOrganizationId(ev.target.value);
                setIncidentId("");
              }}
            >
              <option value="">—</option>
              {(data?.organizations ?? []).map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Incidente
            <select
              className="mt-1 w-full rounded border px-2 py-1"
              value={incidentId}
              onChange={(ev) => setIncidentId(ev.target.value)}
              disabled={!organizationId}
            >
              <option value="">—</option>
              {incidentsForOrg.map((inc) => (
                <option key={inc.id} value={inc.id}>
                  {inc.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <Button type="submit" className="mt-3" disabled={create.isPending}>
          Crear
        </Button>
      </form>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-3 py-2 font-semibold">Hostname</th>
              <th className="px-3 py-2 font-semibold">Organización</th>
              <th className="px-3 py-2 font-semibold">Incidente</th>
              <th className="px-3 py-2 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((row) => (
              <tr key={row.hostname} className="border-b last:border-0">
                <td className="px-3 py-2 font-medium">{row.hostname}</td>
                <td className="px-3 py-2">{row.organizationName}</td>
                <td className="px-3 py-2">{row.incidentName}</td>
                <td className="px-3 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => void onDelete(row.hostname)}
                  >
                    Borrar
                  </Button>
                </td>
              </tr>
            ))}
            {(data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-gray-500">
                  Sin deployments.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
