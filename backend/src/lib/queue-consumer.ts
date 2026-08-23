/**
 * Consumidor de Cloudflare Queues — lógica extraída de `src/worker.ts` para
 * poder testearla (worker.ts importa `cloudflare:node` en ámbito de módulo y
 * no se puede cargar desde un test; mismo motivo que services/cron-jobs.ts).
 *
 * U20: nombres exactos (queue-registry), Zod dual-decoder (queue-protocol)
 * antes de código de dominio, DLQ con recibo redactado, y cuarentena para
 * colas desconocidas. El productor sigue emitiendo el cuerpo v1.
 */
import { getDb, schema } from "@/db";
import {
  decodeImportJob,
  decodeMatcherJob,
  decodeNeedsJob,
  extractPreservedErrorSummary,
  redactQueuePayload,
  type ImportJobBody,
  type MatcherJobBody,
} from "@/lib/queue-protocol";
import { lookupQueueKind, type QueueKind } from "@/lib/queue-registry";
import type { NeedPublicationJob } from "@/modules/needs/infrastructure/needs-publication-queue";

export type { QueueKind } from "@/lib/queue-registry";
export type { ImportJobBody, MatcherJobBody } from "@/lib/queue-protocol";

/** Forma mínima del mensaje que entrega el runtime de Queues. */
export interface IncomingQueueMessage {
  id: string;
  body: unknown;
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** Forma mínima del batch que entrega el runtime de Queues. */
export interface IncomingQueueBatch {
  queue: string;
  messages: readonly IncomingQueueMessage[];
}

/**
 * Clasifica una cola por nombre exacto. Un substring ya no alcanza: un nombre
 * no registrado es `unknown` y va a cuarentena, no a un consumidor equivocado.
 */
export function classifyQueue(name: string): QueueKind {
  return lookupQueueKind(name);
}

export interface NeedsConsumerDeps {
  /** Publica una necesidad (inyectable para tests; en prod, publishNeed). */
  publish(job: NeedPublicationJob): Promise<unknown>;
  /** Confirma el resultado durable para el status público de Queues. */
  markCompleted?(jobId: string, result: unknown): Promise<void>;
}

function retryInvalid(message: IncomingQueueMessage, family: string, reason: string): void {
  console.error(`[queue:${family}] mensaje ${message.id} ${reason} — reintento.`);
  message.retry();
}

/** Procesa un batch de publicaciones. Ack por mensaje; fallo → retry(). */
export async function consumeNeedsBatch(
  batch: IncomingQueueBatch,
  deps: NeedsConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    const decoded = decodeNeedsJob(message.body);
    if (!decoded.ok) {
      retryInvalid(message, "needs", decoded.reason);
      continue;
    }
    const job = decoded.job;
    let result: unknown;
    try {
      result = await deps.publish(job);
    } catch (err) {
      console.error(
        `[queue:needs] mensaje ${message.id} falló (intento ${message.attempts ?? "?"}):`,
        err instanceof Error ? err.message : String(err),
      );
      message.retry();
      continue;
    }
    if (job.jobId && deps.markCompleted) {
      try {
        await deps.markCompleted(job.jobId, result);
      } catch (err) {
        // La publicación externa ya ocurrió: reintentar el mensaje podría
        // duplicarla. Dejamos el fallo observable sin repetir el side effect.
        console.error(
          `[queue:needs] se publicó ${job.jobId}, pero no se pudo guardar su estado:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    message.ack();
  }
}

export interface ImportsConsumerDeps {
  /** Ejecuta el job (inyectable para tests; en prod, patient-imports). */
  run(job: ImportJobBody): Promise<unknown>;
}

/** Procesa un batch de importaciones. Ack por mensaje; fallo → retry(). */
export async function consumeImportsBatch(
  batch: IncomingQueueBatch,
  deps: ImportsConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    const decoded = decodeImportJob(message.body);
    if (!decoded.ok) {
      retryInvalid(message, "imports", decoded.reason);
      continue;
    }
    try {
      await deps.run(decoded.job);
      message.ack();
    } catch (err) {
      console.error(
        `[queue:imports] ${decoded.job.mode} de ${decoded.job.importId} falló (intento ${message.attempts ?? "?"}):`,
        err instanceof Error ? err.message : String(err),
      );
      message.retry();
    }
  }
}

export interface MatcherConsumerDeps {
  /** Procesa un sweep del matcher para un PRN (inyectable para tests; en
   *  prod, services/matcher.processMatcherMessage). */
  run(job: MatcherJobBody): Promise<unknown>;
}

/**
 * Procesa un batch de sweeps del matcher. Ack por mensaje; fallo → retry().
 * Un cuerpo inválido también hace retry() — si nunca adquiere forma válida,
 * agota reintentos y queda visible vía el DLQ.
 */
export async function consumeMatcherBatch(
  batch: IncomingQueueBatch,
  deps: MatcherConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    const decoded = decodeMatcherJob(message.body);
    if (!decoded.ok) {
      retryInvalid(message, "matcher", decoded.reason);
      continue;
    }
    try {
      await deps.run(decoded.job);
      message.ack();
    } catch (err) {
      console.error(
        `[queue:matcher] sweep de ${decoded.job.prn} falló (intento ${message.attempts ?? "?"}):`,
        err instanceof Error ? err.message : String(err),
      );
      message.retry();
    }
  }
}

export interface DeadLetterEntry {
  queue: string;
  messageId: string;
  attempts: number | null;
  payload: unknown;
  action?: "queue.dead_letter" | "queue.quarantine";
  reason?: string;
}

export type PersistDeadLetter = (entry: DeadLetterEntry) => Promise<void>;

const DLQ_PERSIST_ATTEMPTS = 3;

/**
 * Persiste una carta muerta o una cuarentena. El payload se redacta aquí
 * para que ningún llamador copie un cuerpo ciudadano a `audit_log`.
 * Conserva `errorSummary` del procesador de importación si viaja en el cuerpo.
 */
export async function persistDeadLetter(entry: DeadLetterEntry): Promise<void> {
  const errorSummary = extractPreservedErrorSummary(entry.payload);
  await getDb()
    .insert(schema.auditLog)
    .values({
      actorUserId: null,
      action: entry.action ?? "queue.dead_letter",
      targetType: "queue",
      targetId: entry.queue,
      metadata: {
        messageId: entry.messageId,
        attempts: entry.attempts,
        reason: entry.reason ?? "reintentos agotados (max_retries)",
        payload: redactQueuePayload(entry.payload),
        ...(errorSummary ? { errorSummary } : {}),
      },
      ipHash: null,
      createdAt: Date.now(),
    });
}

async function persistBounded(
  persist: PersistDeadLetter,
  entry: DeadLetterEntry,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DLQ_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      await persist(entry);
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  console.error({
    t: "queue_dlq_persist_lost",
    queue: entry.queue,
    message_id: entry.messageId,
    persist_attempts: DLQ_PERSIST_ATTEMPTS,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return false;
}

export interface DlqHooks {
  /** Marca terminalmente fallida una publicación de necesidades. */
  onNeedDeadLetter?(job: NeedPublicationJob): Promise<void>;
  /**
   * Carta muerta de un job de importación: espejo del "último intento" del
   * processor BullMQ — marca el lote como fallido para que el panel lo
   * muestre en vez de dejarlo "processing" para siempre. Best-effort.
   */
  onImportDeadLetter?(job: ImportJobBody): Promise<void>;
}

/**
 * Procesa un batch del DLQ. Ack solo si el recibo quedó escrito (U20/KTD18).
 * Los consumidores DLQ de wrangler tienen `max_retries: 0`: si la persistencia
 * falla tras los reintentos acotados, retry() pide otro isolate; Cloudflare
 * puede entonces descartar el mensaje. El log `queue_dlq_persist_lost` es la
 * alerta. No se copia el cuerpo ciudadano: el payload se redacta antes.
 */
export async function consumeDlqBatch(
  batch: IncomingQueueBatch,
  persist: PersistDeadLetter,
  hooks: DlqHooks = {},
): Promise<void> {
  for (const message of batch.messages) {
    const persisted = await persistBounded(persist, {
      queue: batch.queue,
      messageId: message.id,
      attempts: message.attempts ?? null,
      payload: redactQueuePayload(message.body),
    });
    if (!persisted) {
      message.retry();
      continue;
    }
    const kind = classifyQueue(batch.queue);
    if (hooks.onImportDeadLetter && (kind === "imports-dlq" || kind === "imports")) {
      const importDecoded = decodeImportJob(message.body);
      if (importDecoded.ok) {
        try {
          await hooks.onImportDeadLetter(importDecoded.job);
        } catch (err) {
          console.error(
            `[queue:dlq] no se pudo marcar fallido el lote ${importDecoded.job.importId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    if (hooks.onNeedDeadLetter && (kind === "needs-dlq" || kind === "needs")) {
      const needDecoded = decodeNeedsJob(message.body);
      if (needDecoded.ok && needDecoded.job.jobId && needDecoded.job.need) {
        try {
          await hooks.onNeedDeadLetter(needDecoded.job);
        } catch (err) {
          console.error(
            `[queue:dlq] no se pudo marcar fallida la publicación ${needDecoded.job.jobId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    message.ack();
  }
}

/**
 * Cola no registrada: persistir un recibo de cuarentena y ack solo si el
 * recibo quedó escrito. Si la persistencia falla, retry() — no ack silencioso.
 */
export async function consumeUnknownQueueBatch(
  batch: IncomingQueueBatch,
  persist: PersistDeadLetter,
): Promise<void> {
  console.error({
    t: "queue_quarantine",
    queue: batch.queue,
    messages: batch.messages.length,
    outcome: "unhandled",
  });
  for (const message of batch.messages) {
    const persisted = await persistBounded(persist, {
      queue: batch.queue,
      messageId: message.id,
      attempts: message.attempts ?? null,
      payload: {
        reason: "unknown_queue",
        body: redactQueuePayload(message.body),
      },
      action: "queue.quarantine",
      reason: "unknown_queue",
    });
    if (persisted) {
      message.ack();
      continue;
    }
    message.retry();
  }
}
