import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
	hashIdempotencyKey,
	isUniqueViolation,
	loadHeader,
	stampDefaultHospital,
	type StagingRow,
	toCreateImportResult,
	toRowDTO,
	toSummary,
} from "./internal";
import type {
	CreateImportInput,
	CreateImportResult,
	ImportHeaderRow,
	ImportRowDTO,
	ImportSummaryDTO,
	PatientImportFailedStage,
} from "./types";
import { incidentOwnership } from "@/tenant/ownership";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import type { TenantScope } from "@/tenant/scope";

const { patientImports, patientImportRows } = schema;

/** Lote ya creado con esta Idempotency-Key por este actor, o `null`. Mismo
 *  lookup en el pre-check de `createImport` y en su catch de carrera (colisión
 *  del índice único sobre `(created_by, idempotency_key_hash)`). */
async function findByIdempotencyKey(
	actorId: string,
	idempotencyKeyHash: string,
): Promise<ImportHeaderRow | null> {
	const db = getDb();
	const existing = await db
		.select()
		.from(patientImports)
		.where(
			and(
				eq(patientImports.createdBy, actorId),
				eq(patientImports.idempotencyKeyHash, idempotencyKeyHash),
			),
		)
		.limit(1);
	return (existing[0] as ImportHeaderRow | undefined) ?? null;
}

export async function createImport(
	input: CreateImportInput,
	actorId: string | null,
	scope: TenantScope = colombiaTenantScope(),
): Promise<CreateImportResult> {
	const db = getDb();
	const now = Date.now();
	const id = randomUUID();
	const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

	if (idempotencyKeyHash && actorId) {
		const existing = await findByIdempotencyKey(actorId, idempotencyKeyHash);
		if (existing) return toCreateImportResult(existing, true);
	}

	try {
		// SIN transacción interactiva (falla en el driver HTTP de Neon bajo
		// Workers): header primero, filas después en tandas. Un corte entre los
		// dos pasos deja un lote con menos filas que totalRows — el process lo
		// detecta (guard de integridad) y lo marca fallido en vez de procesar a
		// medias; reintentar con la misma Idempotency-Key devuelve el existente.
		await db.insert(patientImports).values({
			id,
			status: "pending",
			source: (input.source ?? "api").slice(0, 120),
			sourceRecordId: input.sourceRecordId?.trim()
				? input.sourceRecordId.trim().slice(0, 200)
				: null,
			integration: input.integration?.trim()
				? input.integration.trim().slice(0, 120)
				: null,
			contentType: (input.contentType ?? "application/json").slice(0, 120),
			idempotencyKeyHash,
			totalRows: input.rows.length,
			createdBy: actorId,
			createdAt: now,
			updatedAt: now,
			...incidentOwnership(scope),
		});

		// Lote con hospital destino: el id elegido pisa el de cada fila.
		const rows = stampDefaultHospital(input.rows, input.defaultHospitalId);
		const CHUNK = 100;
		for (let start = 0; start < rows.length; start += CHUNK) {
			await db.insert(patientImportRows).values(
				rows.slice(start, start + CHUNK).map((raw, offset) => ({
					id: randomUUID(),
					importId: id,
					rowIndex: start + offset,
					rawData: raw as Record<string, unknown>,
					createdAt: now,
					updatedAt: now,
					...incidentOwnership(scope),
				})),
			);
		}
	} catch (err) {
		if (!isUniqueViolation(err) || !idempotencyKeyHash || !actorId) throw err;
		const existing = await findByIdempotencyKey(actorId, idempotencyKeyHash);
		if (existing) return toCreateImportResult(existing, true);
		throw err;
	}

	const header = await loadHeader(id);
	if (!header) throw new Error(`patient_import ${id} no existe`);
	return toCreateImportResult(header, false);
}

export async function getImport(id: string): Promise<ImportSummaryDTO | null> {
	const header = await loadHeader(id);
	return header ? toSummary(header) : null;
}

export async function setImportJob(id: string, jobId: string): Promise<void> {
	const db = getDb();
	await db
		.update(patientImports)
		.set({ jobId, updatedAt: Date.now() })
		.where(eq(patientImports.id, id));
}

/** Atomically reserve one retry so two operators cannot enqueue it twice. */
export async function claimImportRetry(id: string): Promise<boolean> {
	const db = getDb();
	const claimed = await db
		.update(patientImports)
		.set({
			status: "queued",
			failedStage: null,
			updatedAt: Date.now(),
		})
		.where(
			and(
				eq(patientImports.id, id),
				eq(patientImports.status, "failed"),
				eq(patientImports.failedStage, "process"),
			),
		)
		.returning({ id: patientImports.id });
	return Boolean(claimed[0]);
}

export async function markImportQueued(
	id: string,
	jobId: string,
): Promise<void> {
	const db = getDb();
	await db
		.update(patientImports)
		.set({
			jobId,
			status: sql`case when ${patientImports.status} = 'pending' then 'queued' else ${patientImports.status} end`,
			updatedAt: Date.now(),
		})
		.where(eq(patientImports.id, id));
}

export async function listImportRows(
	importId: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<ImportRowDTO[]> {
	const db = getDb();
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const offset = Math.max(opts.offset ?? 0, 0);
	const rows = await db
		.select({
			id: patientImportRows.id,
			rowIndex: patientImportRows.rowIndex,
			name: patientImportRows.name,
			age: patientImportRows.age,
			condition: patientImportRows.condition,
			status: patientImportRows.status,
			sourceHospital: patientImportRows.sourceHospital,
			hospitalId: patientImportRows.hospitalId,
			rowStatus: patientImportRows.rowStatus,
			dedupStatus: patientImportRows.dedupStatus,
			confidence: patientImportRows.confidence,
			validationErrors: patientImportRows.validationErrors,
			validationWarnings: patientImportRows.validationWarnings,
			dedupCandidates: patientImportRows.dedupCandidates,
			patientId: patientImportRows.patientId,
			updatedAt: patientImportRows.updatedAt,
		})
		.from(patientImportRows)
		.where(eq(patientImportRows.importId, importId))
		.orderBy(asc(patientImportRows.rowIndex))
		.limit(limit)
		.offset(offset);
	return (rows as StagingRow[]).map(toRowDTO);
}

export async function markImportFailed(
	importId: string,
	summary: string,
	failedStage?: PatientImportFailedStage,
): Promise<void> {
	const db = getDb();
	await db
		.update(patientImports)
		.set({
			status: "failed",
			failedStage: failedStage ?? null,
			errorSummary: summary.slice(0, 500),
			updatedAt: Date.now(),
		})
		.where(eq(patientImports.id, importId));
}

/** Mark the terminal DLQ state without overwriting the processor's root cause. */
export async function markImportDeadLettered(
	importId: string,
	fallbackSummary: string,
	failedStage: PatientImportFailedStage,
): Promise<void> {
	const db = getDb();
	await db
		.update(patientImports)
		.set({
			status: "failed",
			failedStage,
			errorSummary: sql`coalesce(${patientImports.errorSummary}, ${fallbackSummary.slice(0, 500)})`,
			updatedAt: Date.now(),
		})
		.where(eq(patientImports.id, importId));
}
