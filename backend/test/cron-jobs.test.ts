/**
 * Enrutado de Cron Triggers (U4).
 *
 * Test unitario puro — no toca red ni base de datos. No se importa
 * `src/worker.ts`: crea un servidor HTTP e importa `cloudflare:node` en ámbito
 * de módulo, y ninguna de las dos cosas existe bajo Node. Por eso la decisión
 * de enrutado vive en `services/cron-jobs.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CRON_EARTHQUAKES,
  CRON_EXPRESSIONS,
  CRON_GEOCODE,
  CRON_PERSON_RECONCILE,
  cronIdempotencyKey,
  dispatchCron,
  listCronIncidentScopes,
} from "@/services/cron-jobs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchCron", () => {
  it("enruta la expresión de sismos a su handler y a ningún otro", async () => {
    const sismos = vi.fn(async () => {});
    const geocode = vi.fn(async () => {});

    await dispatchCron(CRON_EARTHQUAKES, 1_700_000_000_000, {
      [CRON_EARTHQUAKES]: sismos,
      [CRON_GEOCODE]: geocode,
    });

    expect(sismos).toHaveBeenCalledOnce();
    expect(sismos).toHaveBeenCalledWith(1_700_000_000_000);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("enruta la expresión de geocode a su handler y a ningún otro", async () => {
    const sismos = vi.fn(async () => {});
    const geocode = vi.fn(async () => {});

    await dispatchCron(CRON_GEOCODE, 1_700_000_000_000, {
      [CRON_EARTHQUAKES]: sismos,
      [CRON_GEOCODE]: geocode,
    });

    expect(geocode).toHaveBeenCalledOnce();
    expect(sismos).not.toHaveBeenCalled();
  });

  it("enruta la expresión de reconciliación de PRNs a su handler y a ningún otro", async () => {
    const sismos = vi.fn(async () => {});
    const geocode = vi.fn(async () => {});
    const reconcile = vi.fn(async () => {});

    await dispatchCron(CRON_PERSON_RECONCILE, 1_700_000_000_000, {
      [CRON_EARTHQUAKES]: sismos,
      [CRON_GEOCODE]: geocode,
      [CRON_PERSON_RECONCILE]: reconcile,
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(1_700_000_000_000);
    expect(sismos).not.toHaveBeenCalled();
    expect(geocode).not.toHaveBeenCalled();
  });

  it("una expresión desconocida registra outcome unhandled y no lanza", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sismos = vi.fn(async () => {});
    const onUnhandled = vi.fn().mockResolvedValue(undefined);

    await expect(
      dispatchCron(
        "0 3 * * *",
        1_700_000_000_000,
        {
          [CRON_EARTHQUAKES]: sismos,
        },
        { onUnhandled },
      ),
    ).resolves.toBe("unhandled");

    expect(sismos).not.toHaveBeenCalled();
    expect(onUnhandled).toHaveBeenCalledWith("0 3 * * *");
    expect(JSON.stringify(error.mock.calls)).toContain("unhandled");
    expect(JSON.stringify(error.mock.calls)).toContain("0 3 * * *");
  });

  it("propaga el fallo del handler (el reintento de Cloudflare es deseable)", async () => {
    const boom = vi.fn(async () => {
      throw new Error("USGS caído");
    });

    await expect(
      dispatchCron(CRON_EARTHQUAKES, 1, { [CRON_EARTHQUAKES]: boom }),
    ).rejects.toThrow("USGS caído");
  });

  it("builds a tenant + job-kind + schedule-window idempotency key", () => {
    const first = cronIdempotencyKey({
      organizationId: "org_mallanet",
      incidentId: "inc_terremoto_colombia_2026",
      jobKind: "earthquakes",
      scheduledTimeMs: 1_700_000_000_000,
    });
    const sameWindow = cronIdempotencyKey({
      organizationId: "org_mallanet",
      incidentId: "inc_terremoto_colombia_2026",
      jobKind: "earthquakes",
      scheduledTimeMs: 1_700_000_000_000 + 60_000,
    });
    const nextWindow = cronIdempotencyKey({
      organizationId: "org_mallanet",
      incidentId: "inc_terremoto_colombia_2026",
      jobKind: "earthquakes",
      scheduledTimeMs: 1_700_000_000_000 + 5 * 60_000,
    });
    expect(first).toBe(sameWindow);
    expect(nextWindow).not.toBe(first);
    expect(first).toContain("org_mallanet");
    expect(first).toContain("earthquakes");
  });

  it("enumerates Colombia as the only current cron incident", () => {
    const scopes = listCronIncidentScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.organizationId).toBe("org_mallanet");
    expect(scopes[0]?.incidentId).toBe("inc_terremoto_colombia_2026");
  });
});

describe("wrangler.jsonc", () => {
  /**
   * El fallo real que este test persigue no es un typo: es editar una lista sin
   * la otra. Un cron declarado en el JSON y no en el código no ejecuta nada y
   * NO falla de forma visible — solo deja de pasar lo que debía pasar.
   */
  it("declara exactamente las expresiones que el código enruta", () => {
    const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
    const raw = readFileSync(path, "utf8");
    // wrangler.jsonc lleva comentarios de línea; se quitan para poder parsear.
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      triggers?: { crons?: string[] };
    };

    expect(config.triggers?.crons).toEqual([...CRON_EXPRESSIONS]);
  });

  it("no declara `routes` (aborta el deploy tras subir el codigo)", () => {
    const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
    const raw = readFileSync(path, "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as Record<
      string,
      unknown
    >;

    expect(config).not.toHaveProperty("routes");
  });
});
