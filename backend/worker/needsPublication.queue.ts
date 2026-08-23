import { Worker, type Processor } from "bullmq";
import { requireNeedsJob } from "../src/lib/queue-protocol";
import {
  NEEDS_PUBLICATION_QUEUE,
  type NeedPublicationJob,
} from "../src/modules/needs/infrastructure/needs-publication-queue";
import { getRedis } from "./redis";

const PREFIX = process.env.QUEUE_PREFIX || "mapa";

const processor: Processor<NeedPublicationJob> = async (job) => {
  const data = requireNeedsJob(job.data);
  const { publishNeed } = await import("../src/modules/needs/needs-module");
  await job.updateProgress(10);
  const result = data.location
    ? await publishNeed.executeAtLocation(data.need, data.location)
    : await publishNeed.execute(data.need);
  await job.updateProgress(100);
  return result;
};

export function createNeedsPublicationWorker(): Worker<NeedPublicationJob> {
  return new Worker(NEEDS_PUBLICATION_QUEUE, processor, {
    connection: getRedis(),
    prefix: PREFIX,
    concurrency: 2,
    limiter: { max: 1, duration: 1_000 },
  });
}
