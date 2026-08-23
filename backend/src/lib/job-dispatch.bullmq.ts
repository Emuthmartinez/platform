/**
 * Rama BullMQ del seam de despacho (`job-dispatch.ts`), en su propio módulo
 * para que se pueda importar de forma PEREZOSA.
 *
 * Es el motivo de la separación: `bullmq` e `ioredis` necesitan sockets
 * persistentes y no corren en Cloudflare Workers. Mientras solo se alcancen por
 * `await import()` dentro de la rama Node, no entran en el bundle del Worker.
 * Si algún día alguien los importa arriba en un módulo de `src/`, vuelven al
 * bundle sin que nadie se entere — de ahí este comentario.
 */
import type { Queue } from "bullmq";
import type IORedisType from "ioredis";
import { env } from "@/config/env";
import {
  COLOMBIA_INCIDENT_ID,
  COLOMBIA_ORGANIZATION_ID,
} from "@/lib/colombia-tenant";
import type { DispatchOptions, JobRoute } from "./job-dispatch";

let connection: IORedisType | null = null;
const queues = new Map<string, Queue>();

async function getQueue(queueName: string, url: string): Promise<Queue> {
  const existing = queues.get(queueName);
  if (existing) return existing;

  const { Queue: BullQueue } = await import("bullmq");
  const { default: IORedis } = await import("ioredis");

  connection ??= new IORedis(url, {
    // Requerido por BullMQ.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const queue = new BullQueue(queueName, {
    connection,
    prefix: env.QUEUE_PREFIX,
    streams: { events: { maxLen: 1000 } },
  });
  queues.set(queueName, queue);
  return queue;
}

export async function enqueueViaBullmq(
  route: JobRoute,
  payload: unknown,
  options: DispatchOptions,
  url: string,
): Promise<string> {
  const queue = await getQueue(route.queueName, url);
  const job = await queue.add("publish", payload, {
    jobId: options.id,
    attempts: options.attempts ?? 3,
    backoff: { type: "exponential", delay: options.backoffMs ?? 10_000 },
    removeOnComplete: env.QUEUE_REMOVE_ON_COMPLETE,
    removeOnFail: env.QUEUE_REMOVE_ON_FAIL,
  });
  return job.id!;
}

/** Estado de un job de BullMQ. `null` si no existe (o si expiró por removeOn*). */
export async function getBullmqJobState(
  route: JobRoute,
  id: string,
  url: string,
): Promise<{
  jobId: string;
  state: string;
  progress: unknown;
  result: unknown;
  failedReason: string | null;
  organizationId: string;
  incidentId: string;
} | null> {
  const queue = await getQueue(route.queueName, url);
  const job = await queue.getJob(id);
  if (!job) return null;
  const data =
    typeof job.data === "object" && job.data !== null
      ? (job.data as Record<string, unknown>)
      : {};
  const organizationId =
    typeof data.organizationId === "string" && data.organizationId.trim()
      ? data.organizationId.trim()
      : COLOMBIA_ORGANIZATION_ID;
  const incidentId =
    typeof data.incidentId === "string" && data.incidentId.trim()
      ? data.incidentId.trim()
      : COLOMBIA_INCIDENT_ID;
  return {
    jobId: id,
    state: await job.getState(),
    progress: job.progress,
    result: job.returnvalue ?? null,
    failedReason: job.failedReason ?? null,
    organizationId,
    incidentId,
  };
}
