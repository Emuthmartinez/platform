import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { invalidate } from "@/lib/cache";
import type { DedupCandidate } from "@/services/patient-import-logic";
import type { PatientCondition, PatientStatus } from "@/services/patients";
import { ensurePrn, enqueueMatcherSweep } from "@/services/person-records";
import type { TenantScope } from "@/tenant/scope";
import { incidentOwnership } from "@/tenant/ownership";
import { getImport } from "./create";
import {
	assertImportState,
	loadHeader,
	PATIENT_IMPORT_FAILED_STAGE,
	tenantScopeFromImportHeader,
} from "./internal";
import {
	DEDUP_ACCEPTED_REASON,
	DEDUP_STATUS_ACCEPTED,
	type ImportSummaryDTO,
	PATIENT_CONDITION,
	PATIENT_CONDITIONS,
	PATIENT_STATUS,
	PATIENT_STATUSES,
} from "./types";

const { patientImports, patientImportRows, hospitalPatients } = schema;

/**
 * APPLY SIN TRANSACCIONES INTERACTIVAS (fallan en el driver HTTP de Neon bajo
 * Workers). En su lugar, una máquina de estados idempotente y REANUDABLE por
 * fila:
 *
 *   1. claim  — UPDATE condicional pasa la fila valid→applying (una sentencia,
 *               atómica; sustituye al SELECT … FOR UPDATE). Re-ejecutar un
 *               apply reclama también las filas que quedaron en 'applying' por
 *               un crash anterior.
 *   2. insert — el id del paciente es DETERMINISTA (derivado del id de la
 *               fila), así que reintentarlo tras un crash es un no-op
 *               (ON CONFLICT (id)); el dedupe por documento conserva su
 *               ON CONFLICT (document_hash).
 *   3. mark   — la fila queda 'applied' (con patientId) o 'duplicate'.
 *
 * Cualquier corte entre pasos se recupera re-lanzando el apply: el estado en
 * base de datos determina qué falta, nunca se duplica un paciente.
 */

interface ApplyableRow {
	id: string;
	name: string | null;
	age: number | null;
	condition: string | null;
	status: string | null;
	hospitalId: string | null;
	documentHash: string | null;
	dedupStatus: string;
	dedupCandidates: unknown;
}

/**
 * Busca la marca de aceptación de dedup (U2, `POST .../dedup` accept:true) en
 * `dedup_candidates`: un único candidato con `reason: DEDUP_ACCEPTED_REASON`.
 * Ver `decideImportRowDedup` en rows.ts — es quien la escribe.
 */
function findAcceptedDedupPatientId(dedupCandidates: unknown): string | null {
	if (!Array.isArray(dedupCandidates)) return null;
	const accepted = (dedupCandidates as Partial<DedupCandidate>[]).find(
		(c) => c?.reason === DEDUP_ACCEPTED_REASON,
	);
	return accepted?.patientId ?? null;
}

function normalizePatientCondition(value: string | null): PatientCondition {
	return PATIENT_CONDITIONS.has(value ?? "")
		? (value as PatientCondition)
		: PATIENT_CONDITION.UNKNOWN;
}

function normalizePatientStatus(value: string | null): PatientStatus {
	return PATIENT_STATUSES.has(value ?? "")
		? (value as PatientStatus)
		: PATIENT_STATUS.HOSPITALIZED;
}

/**
 * Id de paciente DETERMINISTA por fila de staging: sha256 de la fila con
 * formato uuid. Es lo que hace idempotente el insert entre reintentos — el
 * mismo row siempre produce el mismo id, y un re-insert choca en (id).
 */
export function deterministicPatientId(rowId: string): string {
	const hex = createHash("sha256")
		.update(`patient-import-row:${rowId}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Resultado de aplicar una fila: el paciente resultante y su PRN (si
 *  `ensurePrn` lo alcanzó a estampar aquí mismo — best-effort, puede ser
 *  `null`). `applyImport` acumula los PRN de TODAS las filas de la corrida y
 *  hace un único `enqueueMatcherSweep` al final (AE2/U8), mismo idioma de
 *  lote que `upsertExternalMissingBatch` en missing.ts. */
interface ApplyRowResult {
	patientId: string;
	prn: string | null;
}

/**
 * Aplica UNA fila con claim + insert idempotente + marca. Devuelve el
 * paciente aplicado (id + PRN) si la fila terminó aplicada, null si quedó
 * duplicada o no aplica.
 */
async function applyOneRow(
	rowId: string,
	scope: TenantScope,
): Promise<ApplyRowResult | null> {
	const db = getDb();
	const now = Date.now();

	// 1. CLAIM atómico: valid|applying → applying. Incluir 'applying' permite
	//    REANUDAR una fila que un crash dejó a medias.
	const claimed = await db
		.update(patientImportRows)
		.set({ rowStatus: "applying", updatedAt: now })
		.where(
			and(
				eq(patientImportRows.id, rowId),
				inArray(patientImportRows.rowStatus, ["valid", "applying"]),
				isNull(patientImportRows.patientId),
			),
		)
		.returning({
			id: patientImportRows.id,
			name: patientImportRows.name,
			age: patientImportRows.age,
			condition: patientImportRows.condition,
			status: patientImportRows.status,
			hospitalId: patientImportRows.hospitalId,
			documentHash: patientImportRows.documentHash,
			dedupStatus: patientImportRows.dedupStatus,
			dedupCandidates: patientImportRows.dedupCandidates,
		});
	const row = claimed[0] as ApplyableRow | undefined;
	if (!row?.hospitalId || !row.name) {
		// Sin hospital o sin nombre no es aplicable; devolver la fila a 'valid'
		// dejaría un bucle — se marca inválida de forma visible.
		if (row) {
			await db
				.update(patientImportRows)
				.set({ rowStatus: "invalid", updatedAt: now })
				.where(eq(patientImportRows.id, rowId));
		}
		return null;
	}

	// --- Camino de ADJUNTAR (U2): la fila trae un candidato de dedup aceptado
	// por un revisor humano (rows.ts, decideImportRowDedup). Se adjunta al
	// paciente EXISTENTE — SIN insert nuevo, SIN pisar sus campos (conservador:
	// el revisor eligió "es el mismo paciente", no "actualiza sus datos").
	const acceptedPatientId = findAcceptedDedupPatientId(row.dedupCandidates);
	if (row.dedupStatus === DEDUP_STATUS_ACCEPTED && acceptedPatientId) {
		const existing = await db
			.select({ id: hospitalPatients.id })
			.from(hospitalPatients)
			.where(eq(hospitalPatients.id, acceptedPatientId))
			.limit(1);
		if (!existing[0]) {
			// El paciente aceptado ya no existe (borrado entre el accept y el
			// apply) — no hay a qué adjuntar. Reintentar en bucle no lo arregla;
			// se marca inválida de forma visible, igual que sin hospital/nombre.
			await db
				.update(patientImportRows)
				.set({ rowStatus: "invalid", updatedAt: now })
				.where(eq(patientImportRows.id, rowId));
			return null;
		}
		await db
			.update(patientImportRows)
			.set({ patientId: acceptedPatientId, rowStatus: "applied", updatedAt: now })
			.where(eq(patientImportRows.id, rowId));
		// Capa de identidad: best-effort e idempotente (el paciente existente
		// normalmente ya tiene PRN; ensurePrn nunca falla el apply). El sweep va
		// en LOTE al final de applyImport, no aquí (ver ApplyRowResult).
		const acceptedPrn = await ensurePrn(
			"hospital_patient",
			acceptedPatientId,
			scope,
		);
		return { patientId: acceptedPatientId, prn: acceptedPrn };
	}

	const patientId = deterministicPatientId(row.id);

	// 2a. ¿Reanudación? Si un crash anterior ya insertó este paciente, solo
	//     falta la marca.
	const already = await db
		.select({ id: hospitalPatients.id })
		.from(hospitalPatients)
		.where(eq(hospitalPatients.id, patientId))
		.limit(1);

	let inserted = Boolean(already[0]);
	if (!inserted) {
		const name = row.name.trim().slice(0, 120);
		const age =
			row.age === null || row.age === undefined
				? null
				: Math.max(0, Math.trunc(Number(row.age)));
		const condition = normalizePatientCondition(row.condition);
		const status = normalizePatientStatus(row.status);
		const ownership = incidentOwnership(scope);
		const result = (await db.execute(sql`
      insert into hospital_patients
        (id, hospital_id, name, age, condition, status, notes, contact, document_hash, admitted_at, updated_at, organization_id, incident_id)
      values
        (${patientId}, ${row.hospitalId}, ${name}, ${age}, ${condition}, ${status}, '', '', ${row.documentHash ?? null}, ${now}, ${now}, ${ownership.organizationId}, ${ownership.incidentId})
      on conflict (document_hash) where document_hash is not null do nothing
      returning id
    `)) as unknown as { rows: { id: string }[] };
		inserted = Boolean(result.rows[0]);
	}

	// 3. Marca final (idempotente).
	if (!inserted) {
		await db
			.update(patientImportRows)
			.set({ rowStatus: "duplicate", dedupStatus: "duplicate", updatedAt: now })
			.where(eq(patientImportRows.id, rowId));
		return null;
	}
	await db
		.update(patientImportRows)
		.set({ patientId, rowStatus: "applied", updatedAt: now })
		.where(eq(patientImportRows.id, rowId));
	// Capa de identidad: cada fila aplicada entra al registro PRN y al barrido
	// del matcher (AE2/U8, en lote al final de applyImport). Best-effort:
	// nunca falla el apply.
	const prn = await ensurePrn("hospital_patient", patientId, scope);
	return { patientId, prn };
}

export async function applyImport(
	importId: string,
	actorId: string | null,
): Promise<ImportSummaryDTO> {
	const db = getDb();

	// Claim del header como UPDATE condicional (sustituye al FOR UPDATE):
	// processed | applied | applying | (failed en etapa apply) → applying.
	const claimedHeader = await db
		.update(patientImports)
		.set({ status: "applying", failedStage: null, updatedAt: Date.now() })
		.where(
			and(
				eq(patientImports.id, importId),
				sql`(${patientImports.status} in ('processed', 'applied', 'applying')
             or (${patientImports.status} = 'failed' and ${patientImports.failedStage} = ${PATIENT_IMPORT_FAILED_STAGE.APPLY}))`,
			),
		)
		.returning({ id: patientImports.id });
	if (!claimedHeader[0]) {
		const header = await loadHeader(importId);
		if (!header) throw new Error(`patient_import ${importId} no existe`);
		if (
			header.status === "failed" &&
			header.failedStage !== PATIENT_IMPORT_FAILED_STAGE.APPLY
		) {
			throw new Error(
				'Solo se puede reanudar un lote fallido durante la etapa "apply".',
			);
		}
		assertImportState(header, ["processed", "applied", "failed", "applying"], "aplicar");
	}

	const header = await loadHeader(importId);
	if (!header) throw new Error(`patient_import ${importId} no existe`);
	const scope = tenantScopeFromImportHeader(header);

	// Candidatas: las 'valid' pendientes Y las 'applying' huérfanas de un
	// crash anterior (reanudación).
	const toApply = (await db
		.select({ id: patientImportRows.id })
		.from(patientImportRows)
		.where(
			and(
				eq(patientImportRows.importId, importId),
				inArray(patientImportRows.rowStatus, ["valid", "applying"]),
				isNull(patientImportRows.patientId),
			),
		)) as { id: string }[];

	// AE2/U8: acumula los PRN de esta corrida y hace UN solo sweep al final —
	// mismo idioma de lote que upsertExternalMissingBatch en missing.ts, en vez
	// de un enqueueMatcherSweep por fila.
	const sweepPrns: string[] = [];
	for (const row of toApply) {
		const applied = await applyOneRow(row.id, scope);
		if (applied?.prn) sweepPrns.push(applied.prn);
	}
	if (sweepPrns.length > 0) {
		await enqueueMatcherSweep([...new Set(sweepPrns)], scope);
	}

	const now = Date.now();
	const appliedCount = (await db
		.select({ n: sql<number>`count(*)::int` })
		.from(patientImportRows)
		.where(
			and(
				eq(patientImportRows.importId, importId),
				eq(patientImportRows.rowStatus, "applied"),
			),
		)) as { n: number }[];

	await db
		.update(patientImports)
		.set({
			status: "applied",
			appliedRows: appliedCount[0]?.n ?? 0,
			appliedAt: now,
			updatedAt: now,
		})
		.where(eq(patientImports.id, importId));

	void actorId;
	invalidate();
	const summary = await getImport(importId);
	if (!summary) throw new Error(`patient_import ${importId} no existe`);
	return summary;
}

export async function purgeAppliedRawData(opts: {
	olderThanMs: number;
	confirm?: boolean;
}): Promise<{ matched: number; purged: number }> {
	if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
		throw new Error("purgeAppliedRawData: olderThanMs debe ser un número >= 0");
	}
	const db = getDb();
	const cutoff = Date.now() - opts.olderThanMs;

	const appliedOld = db
		.select({ id: patientImports.id })
		.from(patientImports)
		.where(
			and(
				eq(patientImports.status, "applied"),
				lt(patientImports.appliedAt, cutoff),
			),
		);
	const targetWhere = and(
		inArray(patientImportRows.importId, appliedOld),
		sql`${patientImportRows.rawData} <> '{}'::jsonb`,
	);

	const counted = (await db
		.select({ n: sql<number>`count(*)::int` })
		.from(patientImportRows)
		.where(targetWhere)) as { n: number }[];
	const matched = counted[0]?.n ?? 0;

	if (!opts.confirm) return { matched, purged: 0 };

	await db
		.update(patientImportRows)
		.set({ rawData: {}, updatedAt: Date.now() })
		.where(targetWhere);
	return { matched, purged: matched };
}
