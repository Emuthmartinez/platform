/**
 * La red de durabilidad tiene dos propiedades que NO pueden romperse:
 *
 *  1. NUNCA lanza. Corre dentro del `catch` de un route; si explotara,
 *     enmascararia el error original y el usuario dejaria de recibir su 503.
 *  2. NO persiste credenciales. El `turnstileToken` viaja en el body de todos
 *     los formularios publicos y no es contenido del formulario.
 *
 * El resto (que el payload lleve nombre y contacto) es DELIBERADO: ese es
 * justamente el dato que se perdio el 2026-08-11 y que existe para no perder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { colombiaTenantScope } from "@/lib/colombia-tenant";

const insert = vi.fn();
vi.mock("@/db", () => ({
  getDb: () => ({ insert: (t: unknown) => ({ values: (v: unknown) => insert(t, v) }) }),
  schema: { failedSubmissions: "failed_submissions_table" },
}));

const { captureFailedSubmission } = await import("@/lib/failed-submission");

describe("captureFailedSubmission", () => {
  // Cuerpo de bloque a proposito: `() => insert.mockReset()` DEVUELVE el mock,
  // y vitest trata el valor devuelto por el hook como algo que esperar, lo que
  // hace que el rechazo del test siguiente se reporte como fallo del hook.
  beforeEach(() => {
    insert.mockReset();
  });

  it("guarda el envio y el SQLSTATE, quitando el turnstileToken", async () => {
    insert.mockResolvedValue(undefined);
    const drizzleErr = Object.assign(new Error("Failed query: ...\nparams: x"), {
      cause: Object.assign(new Error("nope"), { code: "42703" }),
    });

    const ok = await captureFailedSubmission(
      "volunteers",
      { name: "NOMBRE-PLACEHOLDER", contact: "CONTACTO-PLACEHOLDER", turnstileToken: "TOKEN-PLACEHOLDER" },
      drizzleErr,
      colombiaTenantScope("localhost"),
    );

    expect(ok).toBe(true);
    const [, values] = insert.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(values.form).toBe("volunteers");
    expect(values.errorCode).toBe("42703"); // desenvuelto desde `cause`
    expect(values.organizationId).toBeTruthy();
    expect(values.incidentId).toBeTruthy();
    // El dato de la persona SE GUARDA: es el objetivo del modulo.
    expect(values.payload).toMatchObject({
      name: "NOMBRE-PLACEHOLDER",
      contact: "CONTACTO-PLACEHOLDER",
    });
    // La credencial NO.
    expect(values.payload).not.toHaveProperty("turnstileToken");
    expect(values.replayedAt).toBeNull();
  });

  it("si la propia captura falla, devuelve false y NO lanza", async () => {
    // mockImplementation y no mockRejectedValue: este ultimo crea la promesa
    // rechazada al configurar el mock, y vitest la ve como unhandled rejection
    // antes de que el modulo llegue a consumirla.
    insert.mockImplementation(async () => {
      throw new Error("base caida");
    });
    // Si esto lanzara, el route perderia su 503 y el usuario veria un 500 raro.
    const ok = await captureFailedSubmission(
      "missing",
      { name: "x" },
      new Error("original"),
      colombiaTenantScope("localhost"),
    );
    expect(ok).toBe(false);
  });

  it("sin TenantScope no inserta y no lanza", async () => {
    const ok = await captureFailedSubmission("volunteers", { name: "x" }, new Error("original"));
    expect(ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
