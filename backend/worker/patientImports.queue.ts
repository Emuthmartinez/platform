import { type Processor, Worker } from "bullmq";
import { requireImportJob } from "../src/lib/queue-protocol";
import { getRedis } from "./redis";

const PREFIX = process.env.QUEUE_PREFIX || "mapa";
export const PATIENT_IMPORTS_QUEUE = "patient-imports";

const processor: Processor = async (job) => {
	const data = requireImportJob(job.data);

	const {
		processImport,
		applyImport,
		ingestOcrImport,
		ingestFileImport,
		markImportFailed,
	} = await import("../src/services/patient-imports");
	try {
		switch (data.mode) {
			case "ocr": {
				const r = await ingestOcrImport(data.importId, data.imageUrl);
				return { mode: "ocr", importId: data.importId, counts: r.counts };
			}
			case "process": {
				const r =
					data.fileBase64 !== undefined && data.contentType !== undefined
						? await ingestFileImport(
								data.importId,
								data.contentType,
								data.fileBase64,
								data.defaultHospitalId,
							)
						: await processImport(data.importId);
				return { mode: "process", importId: data.importId, counts: r.counts };
			}
			case "apply": {
				const r = await applyImport(data.importId, data.actorId ?? null);
				return { mode: "apply", importId: data.importId, counts: r.counts };
			}
			default: {
				const _exhaustive: never = data.mode;
				throw new Error(`patient-import modo desconocido: ${String(_exhaustive)}`);
			}
		}
	} catch (err) {
		const attemptsMade = job.attemptsMade + 1;
		const maxAttempts = job.opts.attempts ?? 1;
		if (attemptsMade >= maxAttempts) {
			const msg = err instanceof Error ? err.message : "Error desconocido";

			const failedStage = data.mode === "apply" ? "apply" : "process";
			await markImportFailed(
				data.importId,
				`Falló el ${data.mode}: ${msg}`,
				failedStage,
			).catch(() => {});
		}
		throw err;
	}
};

export function createPatientImportsWorker(): Worker {
	const concurrency = Number(process.env.PATIENT_IMPORTS_CONCURRENCY || 2);

	const lockDuration = Number(process.env.LONG_JOB_LOCK_MS || 300_000);
	return new Worker(PATIENT_IMPORTS_QUEUE, processor, {
		connection: getRedis(),
		prefix: PREFIX,
		concurrency,
		lockDuration,
	});
}
