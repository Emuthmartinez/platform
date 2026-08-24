/**
 * Consumidor de Cloudflare Queues (lib/queue-consumer.ts) — escenarios del
 * plan U2/U3. Las funciones de consumo son puras respecto al transporte
 * (mensajes fake con ack/retry grabados); persistDeadLetter se prueba de
 * integración contra la base local.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import "./helpers"; // fija env ANTES de cargar la app / db
import { desc, eq } from "drizzle-orm";
import {
  classifyQueue,
  consumeDlqBatch,
  consumeImportsBatch,
  consumeMatcherBatch,
  consumeNeedsBatch,
  consumeUnknownQueueBatch,
  persistDeadLetter,
  type IncomingQueueMessage,
} from "@/lib/queue-consumer";
import { QUEUE_PROTOCOL_FIXTURES } from "@/lib/queue-protocol-schema";
import { getDb, schema } from "@/db";

interface FakeMessage extends IncomingQueueMessage {
  acked: boolean;
  retried: boolean;
}

function fakeMessage(id: string, body: unknown, attempts = 1): FakeMessage {
  const message: FakeMessage = {
    id,
    body,
    attempts,
    acked: false,
    retried: false,
    ack() {
      message.acked = true;
    },
    retry() {
      message.retried = true;
    },
  };
  return message;
}

describe("classifyQueue", () => {
  it("reconoce los nombres exactos y rechaza un substring", () => {
    expect(classifyQueue("mallanet-platform-needs")).toBe("needs");
    expect(classifyQueue("mallanet-platform-needs-staging")).toBe("needs");
    expect(classifyQueue("mallanet-platform-needs-dlq")).toBe("needs-dlq");
    expect(classifyQueue("mallanet-platform-needs-dlq-staging")).toBe("needs-dlq");
    expect(classifyQueue("mallanet-platform-imports")).toBe("imports");
    expect(classifyQueue("mallanet-platform-matcher-staging")).toBe("matcher");
    expect(classifyQueue("needs-publication")).toBe("needs");
    expect(classifyQueue("patient-imports")).toBe("imports");
    expect(classifyQueue("otra-cola")).toBe("unknown");
    expect(classifyQueue("foo-needs-bar")).toBe("unknown");
  });
});

describe("consumeNeedsBatch", () => {
  it("un batch de uno publica y hace ack", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("m1", {
      jobId: "need-demo-1",
      need: { title: "Demo" },
    });
    await consumeNeedsBatch(
      { queue: "mallanet-platform-needs", messages: [message] },
      { publish, markCompleted },
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledWith(
      "need-demo-1",
      { ok: true },
      expect.objectContaining({
        organizationId: "org_mallanet",
        incidentId: "inc_terremoto_colombia_2026",
      }),
    );
    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
  });

  it("no repite una publicación completada si solo falla guardar su estado", async () => {
    const publish = vi.fn().mockResolvedValue({ id: "external-1", status: "pending" });
    const markCompleted = vi.fn().mockRejectedValue(new Error("db caída"));
    const message = fakeMessage("m-status", {
      jobId: "need-demo-status",
      need: { title: "Demo" },
    });

    await consumeNeedsBatch(
      { queue: "mallanet-platform-needs", messages: [message] },
      { publish, markCompleted },
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
  });

  it("ack por mensaje: un fallo no reentrega a sus compañeros de lote", async () => {
    const publish = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("tercero caido"))
      .mockResolvedValueOnce({ ok: true });
    const ok1 = fakeMessage("m1", {});
    const bad = fakeMessage("m2", {});
    const ok2 = fakeMessage("m3", {});
    await consumeNeedsBatch(
      { queue: "mallanet-platform-needs", messages: [ok1, bad, ok2] },
      { publish },
    );
    expect(ok1.acked).toBe(true);
    expect(ok2.acked).toBe(true);
    expect(bad.acked).toBe(false);
    expect(bad.retried).toBe(true);
  });

  it("un fallo de publicación hace retry() en vez de lanzar el batch", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("boom"));
    const message = fakeMessage("m1", {});
    await expect(
      consumeNeedsBatch({ queue: "mallanet-platform-needs", messages: [message] }, { publish }),
    ).resolves.toBeUndefined();
    expect(message.retried).toBe(true);
  });

  it("acepta un envelope v2 y no pisa un tenant extranjero", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true });
    const message = fakeMessage("m-v2", QUEUE_PROTOCOL_FIXTURES.needsV2OtherTenant);
    await consumeNeedsBatch(
      { queue: "mallanet-platform-needs", messages: [message] },
      { publish },
    );
    expect(publish).toHaveBeenCalledWith({
      jobId: "need-other-v2",
      need: { title: "Demo" },
      location: undefined,
    });
    expect(message.acked).toBe(true);
  });

  it("un cuerpo malformado o de versión no soportada hace retry (poison)", async () => {
    const publish = vi.fn();
    const malformed = fakeMessage("bad", "not-an-object");
    const unsupported = fakeMessage("v99", QUEUE_PROTOCOL_FIXTURES.unsupportedVersion);
    const wrongFamily = fakeMessage("wf", QUEUE_PROTOCOL_FIXTURES.wrongFamilyOnNeeds);
    await consumeNeedsBatch(
      { queue: "mallanet-platform-needs", messages: [malformed, unsupported, wrongFamily] },
      { publish },
    );
    expect(publish).not.toHaveBeenCalled();
    expect(malformed.retried).toBe(true);
    expect(unsupported.retried).toBe(true);
    expect(wrongFamily.retried).toBe(true);
  });
});

describe("consumeImportsBatch", () => {
  it("acepta el cuerpo v1 y el envelope v2", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const v1 = fakeMessage("imp-1", QUEUE_PROTOCOL_FIXTURES.importsV1);
    const v2 = fakeMessage("imp-2", QUEUE_PROTOCOL_FIXTURES.importsV2);
    await consumeImportsBatch(
      { queue: "mallanet-platform-imports", messages: [v1, v2] },
      { run },
    );
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      importId: "imp-demo-1",
      mode: "process",
    }));
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      importId: "imp-demo-v2",
      mode: "apply",
    }));
    expect(v1.acked).toBe(true);
    expect(v2.acked).toBe(true);
  });
});

describe("consumeMatcherBatch", () => {
  it("acepta el cuerpo v1 y el envelope v2", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const v1 = fakeMessage("m-1", QUEUE_PROTOCOL_FIXTURES.matcherV1);
    const v2 = fakeMessage("m-2", QUEUE_PROTOCOL_FIXTURES.matcherV2);
    await consumeMatcherBatch(
      { queue: "mallanet-platform-matcher", messages: [v1, v2] },
      { run },
    );
    expect(run).toHaveBeenCalledWith({ prn: "PRN-DEMO-0001" });
    expect(run).toHaveBeenCalledWith({ prn: "PRN-DEMO-0002" });
    expect(v1.acked).toBe(true);
    expect(v2.acked).toBe(true);
  });
});

describe("consumeDlqBatch", () => {
  it("persiste con cola, id, intentos y payload", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("dead-1", { need: { title: "X" } }, 6);
    await consumeDlqBatch(
      { queue: "mallanet-platform-needs-dlq", messages: [message] },
      persist,
    );
    expect(persist).toHaveBeenCalledWith({
      queue: "mallanet-platform-needs-dlq",
      messageId: "dead-1",
      attempts: 6,
      payload: { need: "[redacted]" },
    });
    expect(message.acked).toBe(true);
  });

  it("hace retry si no puede persistir el recibo (no ack silencioso)", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("db caida"));
    const message = fakeMessage("dead-2", {});
    await consumeDlqBatch(
      { queue: "mallanet-platform-needs-dlq", messages: [message] },
      persist,
    );
    expect(persist).toHaveBeenCalledTimes(3);
    expect(message.acked).toBe(false);
    expect(message.retried).toBe(true);
  });

  it("preserva errorSummary anidado en un envelope v2 y redacta fileBase64", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage(
      "dead-v2",
      {
        ...QUEUE_PROTOCOL_FIXTURES.importsV2,
        payload: {
          ...QUEUE_PROTOCOL_FIXTURES.importsV2.payload,
          fileBase64: "QUFBQQ==",
          errorSummary: "Falló el apply: timeout",
        },
      },
      4,
    );
    await consumeDlqBatch(
      { queue: "mallanet-platform-imports-dlq", messages: [message] },
      persist,
    );
    expect(persist).toHaveBeenCalledWith({
      queue: "mallanet-platform-imports-dlq",
      messageId: "dead-v2",
      attempts: 4,
      payload: expect.objectContaining({
        family: "imports",
        payload: expect.objectContaining({
          importId: "imp-demo-v2",
          fileBase64: "[redacted]",
          errorSummary: "Falló el apply: timeout",
        }),
      }),
    });
    expect(JSON.stringify(persist.mock.calls)).not.toContain("QUFBQQ==");
    expect(message.acked).toBe(true);
  });

  it("marca como fallido el job de necesidad cuando agota reintentos", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const onNeedDeadLetter = vi.fn().mockResolvedValue(undefined);
    const body = { jobId: "need-dead-1", need: { title: "Demo" } };
    const message = fakeMessage("dead-need", body, 6);

    await consumeDlqBatch(
      { queue: "mallanet-platform-needs-dlq", messages: [message] },
      persist,
      { onNeedDeadLetter },
    );

    expect(onNeedDeadLetter).toHaveBeenCalledWith(
      {
        jobId: "need-dead-1",
        need: { title: "Demo" },
        location: undefined,
      },
      expect.objectContaining({
        organizationId: "org_mallanet",
        incidentId: "inc_terremoto_colombia_2026",
        hostname: "internal",
      }),
    );
    expect(message.acked).toBe(true);
  });
});

describe("consumeUnknownQueueBatch", () => {
  it("persiste un recibo de cuarentena y hace ack", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage("unk-1", { need: { title: "X" } });
    await consumeUnknownQueueBatch(
      { queue: "cola-inventada", messages: [message] },
      persist,
    );
    expect(persist).toHaveBeenCalledWith({
      queue: "cola-inventada",
      messageId: "unk-1",
      attempts: 1,
      payload: { reason: "unknown_queue", body: { need: "[redacted]" } },
      action: "queue.quarantine",
      reason: "unknown_queue",
    });
    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
  });

  it("hace retry si no puede persistir el recibo (no ack silencioso)", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("db caida"));
    const message = fakeMessage("unk-2", {});
    await consumeUnknownQueueBatch(
      { queue: "cola-inventada", messages: [message] },
      persist,
    );
    expect(persist).toHaveBeenCalledTimes(3);
    expect(message.acked).toBe(false);
    expect(message.retried).toBe(true);
  });
});

describe("persistDeadLetter (integración)", () => {
  beforeAll(async () => {
    const { ensureSeed } = await import("./helpers");
    await ensureSeed();
  });

  it("escribe la carta muerta en audit_log con action queue.dead_letter", async () => {
    const messageId = `test-dead-${Date.now()}`;
    await persistDeadLetter({
      queue: "mallanet-platform-needs-dlq-staging",
      messageId,
      attempts: 6,
      payload: { need: { title: "DEMO carta muerta" } },
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "queue.dead_letter"))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(5);
    const mine = rows.find(
      (row) => (row.metadata as { messageId?: string } | null)?.messageId === messageId,
    );
    expect(mine).toBeDefined();
    expect(mine!.targetType).toBe("queue");
    expect(mine!.targetId).toBe("mallanet-platform-needs-dlq-staging");
    expect((mine!.metadata as { attempts?: number }).attempts).toBe(6);
    expect((mine!.metadata as { payload?: { need?: string } }).payload).toEqual({
      need: "[redacted]",
    });
  });

  it("preserva errorSummary y no copia fileBase64 al audit_log", async () => {
    const messageId = `test-dead-import-${Date.now()}`;
    await persistDeadLetter({
      queue: "mallanet-platform-imports-dlq-staging",
      messageId,
      attempts: 4,
      payload: {
        importId: "imp-demo-1",
        mode: "process",
        fileBase64: "QUFBQQ==",
        errorSummary: "Falló el process: timeout",
      },
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "queue.dead_letter"))
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(5);
    const mine = rows.find(
      (row) => (row.metadata as { messageId?: string } | null)?.messageId === messageId,
    );
    expect(mine).toBeDefined();
    const metadata = mine!.metadata as {
      payload?: { fileBase64?: string; importId?: string };
      errorSummary?: string;
    };
    expect(metadata.payload?.importId).toBe("imp-demo-1");
    expect(metadata.payload?.fileBase64).toBe("[redacted]");
    expect(metadata.errorSummary).toBe("Falló el process: timeout");
    expect(JSON.stringify(mine!.metadata)).not.toContain("QUFBQQ==");
  });
});
