import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { getHospital } from "@/services/hospitals";
import {
	classifyDedup,
	type DedupCandidate,
	type DedupStatus,
	mapCondition,
	mapStatus,
	nameKey,
	type NormalizedRow,
	normalizeAge,
	normalizeName,
	resolveHospitalAlias,
	validateRow,
} from "@/services/patient-import-logic";
import type { PatientCondition, PatientStatus } from "@/services/patients";
import { loadHeader, type StagingRow, tenantScopeFromImportHeader, toRowDTO } from "./internal";
import { incidentOwnership } from "@/tenant/ownership";
import {
	DEDUP_ACCEPTED_REASON,
	DEDUP_STATUS_ACCEPTED,
	type ImportRowDTO,
} from "./types";

const { patientImportRows, hospitals, hospitalPatients, ocrCorrections } =
	schema;

/**
 * Fila cargada para edición/decisión: superconjunto de `StagingRow` (el DTO de
 * salida) con los campos internos que las transiciones necesitan pero que
 * jamás se exponen: `normalizedKey`/`documentHash` (para recalcular dedup) y
 * `updatedAt` (baseline optimista — ver `editImportRow`).
 */
interface RowRecord extends StagingRow {
	normalizedKey: string;
	documentHash: string | null;
	updatedAt: number;
}

async function loadRow(
	importId: string,
	rowId: string,
): Promise<RowRecord | null> {
	const db = getDb();
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
			normalizedKey: patientImportRows.normalizedKey,
			documentHash: patientImportRows.documentHash,
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
		.where(
			and(
				eq(patientImportRows.id, rowId),
				eq(patientImportRows.importId, importId),
			),
		)
		.limit(1);
	return (rows[0] as RowRecord | undefined) ?? null;
}

function toDTOFromRecord(
	base: RowRecord,
	overrides: Partial<RowRecord>,
): ImportRowDTO {
	return toRowDTO({ ...base, ...overrides });
}

/**
 * `rowStatus` que corresponde a un veredicto de dedup: 'unique' se traduce a
 * 'valid' (nombres distintos porque 'unique' es un concepto de dedup, no del
 * ciclo de vida de la fila); 'duplicate'/'needs_review' se quedan igual.
 * Mismo mapeo en `decideImportRowDedup` (accept:false) y `editImportRow`.
 */
function rowStatusForDedupVerdict(status: DedupStatus): "valid" | DedupStatus {
	return status === "unique" ? "valid" : status;
}

/**
 * Candidatos de dedup para UNA fila (equivalente de un solo elemento a las
 * `loadHospitalCandidates`/`loadDocumentHashCandidates` de `process.ts`, que
 * no se tocan aquí — están pensadas para el batch y cachean entre filas). Sin
 * dedup intra-lote: una edición de fila no vuelve a mirar las demás filas del
 * mismo lote, solo `hospital_patients` ya aplicados.
 */
async function loadCandidatePoolForRow(
	hospitalId: string | null,
	normalizedKey: string,
	documentHash: string | null,
): Promise<DedupCandidate[]> {
	const db = getDb();
	const byName: DedupCandidate[] = [];
	if (hospitalId && normalizedKey) {
		const patients = await db
			.select({
				id: hospitalPatients.id,
				name: hospitalPatients.name,
				age: hospitalPatients.age,
				documentHash: hospitalPatients.documentHash,
			})
			.from(hospitalPatients)
			.where(eq(hospitalPatients.hospitalId, hospitalId));
		for (const p of patients) {
			if (nameKey(p.name) !== normalizedKey) continue;
			byName.push({
				patientId: p.id,
				name: p.name,
				age: p.age ?? null,
				documentHash: p.documentHash ?? null,
			});
		}
	}
	const byDoc: DedupCandidate[] = [];
	if (documentHash) {
		const patients = await db
			.select({
				id: hospitalPatients.id,
				name: hospitalPatients.name,
				age: hospitalPatients.age,
				documentHash: hospitalPatients.documentHash,
			})
			.from(hospitalPatients)
			.where(eq(hospitalPatients.documentHash, documentHash));
		for (const p of patients) {
			byDoc.push({
				patientId: p.id,
				name: p.name,
				age: p.age ?? null,
				documentHash: p.documentHash ?? null,
			});
		}
	}
	const seen = new Set<string>();
	const merged: DedupCandidate[] = [];
	for (const c of [...byName, ...byDoc]) {
		if (seen.has(c.patientId)) continue;
		seen.add(c.patientId);
		merged.push(c);
	}
	return merged;
}

/**
 * Resuelve `sourceHospital` (texto) a un id único del catálogo, o null si no
 * hay match único — mismo criterio que `resolveHospitalIdsForBatch` en
 * process.ts (alias → nombre exacto case-insensitive), pero para UNA fila (no
 * hay batch que cachear).
 */
async function resolveHospitalForRow(
	sourceHospitalText: string,
): Promise<string | null> {
	const txt = sourceHospitalText.trim();
	if (!txt) return null;
	const db = getDb();
	const canonical = (resolveHospitalAlias(txt) ?? txt).toLowerCase();
	const matches = (await db
		.select({ id: hospitals.id })
		.from(hospitals)
		.where(eq(sql<string>`lower(${hospitals.name})`, canonical))) as {
		id: string;
	}[];
	return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

/* ================================================== confirm / reject ==== */

/**
 * `needs_review → valid`. Idempotente si ya está `valid`. 409 si está en
 * cualquier otro estado (terminal `invalid`, o `duplicate`/`applied`, que no
 * pasan por confirm). 400 (NO 422 — el repo no usa ese status; `validate()`
 * ya mapea toda falla de zod a 400, así que una fila con errores de
 * validación remanentes sigue esa misma convención) si quedan errores.
 */
export async function confirmImportRow(
	importId: string,
	rowId: string,
): Promise<ImportRowDTO> {
	const header = await loadHeader(importId);
	if (!header) throw notFound("Lote de importación no encontrado.");
	const row = await loadRow(importId, rowId);
	if (!row) throw notFound("Fila no encontrada.");

	if (row.rowStatus === "valid") return toDTOFromRecord(row, {});
	if (row.rowStatus !== "needs_review") {
		throw conflict(
			`No se puede confirmar una fila en estado "${row.rowStatus}" (needs_review es el único estado de origen).`,
		);
	}
	const errors = Array.isArray(row.validationErrors)
		? (row.validationErrors as string[])
		: [];
	if (errors.length > 0) {
		throw badRequest(
			`No se puede confirmar: quedan errores de validación (${errors.join("; ")}). Corrígelos con PATCH antes de confirmar.`,
		);
	}

	const db = getDb();
	const now = Date.now();
	const updated = await db
		.update(patientImportRows)
		.set({ rowStatus: "valid", updatedAt: now })
		.where(
			and(
				eq(patientImportRows.id, rowId),
				eq(patientImportRows.importId, importId),
				eq(patientImportRows.rowStatus, "needs_review"),
			),
		)
		.returning({ id: patientImportRows.id });
	if (updated[0]) return toDTOFromRecord(row, { rowStatus: "valid", updatedAt: now });

	const reread = await loadRow(importId, rowId);
	if (reread?.rowStatus === "valid") return toDTOFromRecord(reread, {});
	throw conflict(
		"La fila cambió de estado mientras se confirmaba; recárgala e inténtalo de nuevo.",
	);
}

/**
 * `needs_review|valid → invalid` (terminal). Idempotente si ya está
 * `invalid`. 409 en cualquier otro estado.
 */
export async function rejectImportRow(
	importId: string,
	rowId: string,
): Promise<ImportRowDTO> {
	const header = await loadHeader(importId);
	if (!header) throw notFound("Lote de importación no encontrado.");
	const row = await loadRow(importId, rowId);
	if (!row) throw notFound("Fila no encontrada.");

	if (row.rowStatus === "invalid") return toDTOFromRecord(row, {});
	if (row.rowStatus !== "needs_review" && row.rowStatus !== "valid") {
		throw conflict(
			`No se puede rechazar una fila en estado "${row.rowStatus}".`,
		);
	}

	const db = getDb();
	const now = Date.now();
	const updated = await db
		.update(patientImportRows)
		.set({ rowStatus: "invalid", updatedAt: now })
		.where(
			and(
				eq(patientImportRows.id, rowId),
				eq(patientImportRows.importId, importId),
				inArray(patientImportRows.rowStatus, ["needs_review", "valid"]),
			),
		)
		.returning({ id: patientImportRows.id });
	if (updated[0]) return toDTOFromRecord(row, { rowStatus: "invalid", updatedAt: now });

	const reread = await loadRow(importId, rowId);
	if (reread?.rowStatus === "invalid") return toDTOFromRecord(reread, {});
	throw conflict(
		"La fila cambió de estado mientras se rechazaba; recárgala e inténtalo de nuevo.",
	);
}

/* ========================================================= dedup ======== */

export interface DedupDecisionInput {
	accept: boolean;
	patientId?: string;
}

/**
 * Decisión humana sobre los candidatos de dedup de una fila.
 *
 * `accept:true` — guarda el candidato elegido en `dedup_candidates` (marcado
 * con `reason: DEDUP_ACCEPTED_REASON`; sin columna nueva — ver types.ts) y
 * pasa la fila a `valid`. `applyOneRow` (apply.ts) lee esa marca para
 * ADJUNTAR al paciente existente en vez de insertar uno nuevo.
 *
 * `accept:false` — limpia `dedup_candidates` y re-clasifica: con lista vacía
 * `classifyDedup` siempre da "unique" (ver patient-import-logic.ts), así que
 * la fila queda `valid` salvo que la reclasificación (por robustez ante
 * futuros cambios de `classifyDedup`) diga otra cosa.
 */
export async function decideImportRowDedup(
	importId: string,
	rowId: string,
	decision: DedupDecisionInput,
): Promise<ImportRowDTO> {
	const header = await loadHeader(importId);
	if (!header) throw notFound("Lote de importación no encontrado.");
	const row = await loadRow(importId, rowId);
	if (!row) throw notFound("Fila no encontrada.");

	const existingCandidates = Array.isArray(row.dedupCandidates)
		? (row.dedupCandidates as DedupCandidate[])
		: [];
	const db = getDb();
	const now = Date.now();

	if (decision.accept) {
		if (!decision.patientId) {
			throw badRequest("Falta patientId para aceptar el candidato.");
		}
		if (decision.patientId.startsWith("row:")) {
			// Ver process.ts: los candidatos intra-lote se marcan `row:<id>` (otra
			// fila del MISMO lote, sin paciente real todavía) — no hay a qué
			// adjuntar hasta que esa otra fila se aplique.
			throw badRequest(
				"No se puede aceptar un candidato del mismo lote (aún no aplicado).",
			);
		}
		const candidate = existingCandidates.find(
			(c) => c.patientId === decision.patientId,
		);
		if (!candidate) {
			throw badRequest(
				"El patientId indicado no es uno de los candidatos de esta fila.",
			);
		}

		if (
			row.rowStatus === "valid" &&
			row.dedupStatus === DEDUP_STATUS_ACCEPTED &&
			existingCandidates.length === 1 &&
			existingCandidates[0]?.patientId === decision.patientId
		) {
			return toDTOFromRecord(row, {});
		}
		if (row.rowStatus !== "needs_review" && row.rowStatus !== "duplicate") {
			throw conflict(
				`No se puede decidir dedup en una fila en estado "${row.rowStatus}".`,
			);
		}

		const acceptedCandidates: DedupCandidate[] = [
			{
				patientId: candidate.patientId,
				name: candidate.name,
				age: candidate.age ?? null,
				documentHash: null,
				reason: DEDUP_ACCEPTED_REASON,
			},
		];
		const updated = await db
			.update(patientImportRows)
			.set({
				dedupStatus: DEDUP_STATUS_ACCEPTED,
				dedupCandidates: acceptedCandidates,
				rowStatus: "valid",
				updatedAt: now,
			})
			.where(
				and(
					eq(patientImportRows.id, rowId),
					eq(patientImportRows.importId, importId),
					inArray(patientImportRows.rowStatus, ["needs_review", "duplicate"]),
				),
			)
			.returning({ id: patientImportRows.id });
		if (updated[0]) {
			return toDTOFromRecord(row, {
				rowStatus: "valid",
				dedupStatus: DEDUP_STATUS_ACCEPTED,
				dedupCandidates: acceptedCandidates,
				updatedAt: now,
			});
		}
		const reread = await loadRow(importId, rowId);
		if (reread?.rowStatus === "valid" && reread.dedupStatus === DEDUP_STATUS_ACCEPTED) {
			return toDTOFromRecord(reread, {});
		}
		throw conflict(
			"La fila cambió de estado mientras se decidía el dedup; recárgala e inténtalo de nuevo.",
		);
	}

	// accept: false
	if (
		row.rowStatus === "valid" &&
		row.dedupStatus === "unique" &&
		existingCandidates.length === 0
	) {
		return toDTOFromRecord(row, {});
	}
	if (row.rowStatus !== "needs_review" && row.rowStatus !== "duplicate") {
		throw conflict(
			`No se puede decidir dedup en una fila en estado "${row.rowStatus}".`,
		);
	}
	const normRow: NormalizedRow = {
		name: row.name,
		normalizedKey: row.normalizedKey,
		age: row.age,
		condition: (row.condition ?? "unknown") as PatientCondition,
		status: (row.status ?? "hospitalized") as PatientStatus,
		sourceHospital: row.sourceHospital,
		hospitalIdHint: row.hospitalId,
		documentDigits: null,
		documentHash: row.documentHash,
		notes: "",
		contact: "",
		warnings: [],
	};
	const verdict = classifyDedup(normRow, []);
	const nextRowStatus = rowStatusForDedupVerdict(verdict.status);

	const updated = await db
		.update(patientImportRows)
		.set({
			dedupStatus: verdict.status,
			dedupCandidates: verdict.candidates,
			confidence: verdict.confidence,
			rowStatus: nextRowStatus,
			updatedAt: now,
		})
		.where(
			and(
				eq(patientImportRows.id, rowId),
				eq(patientImportRows.importId, importId),
				inArray(patientImportRows.rowStatus, ["needs_review", "duplicate"]),
			),
		)
		.returning({ id: patientImportRows.id });
	if (updated[0]) {
		return toDTOFromRecord(row, {
			rowStatus: nextRowStatus,
			dedupStatus: verdict.status,
			dedupCandidates: verdict.candidates,
			confidence: verdict.confidence,
		});
	}
	const reread = await loadRow(importId, rowId);
	if (reread?.rowStatus === nextRowStatus) return toDTOFromRecord(reread, {});
	throw conflict(
		"La fila cambió de estado mientras se decidía el dedup; recárgala e inténtalo de nuevo.",
	);
}

/* ============================================================ edit ====== */

export interface EditImportRowInput {
	name?: string;
	age?: number | string | null;
	condition?: string;
	status?: string;
	sourceHospital?: string;
	hospitalId?: string;
	// `updated_at` de la fila TAL COMO LA VIO el cliente al renderizar el
	// editor. Sin esto la concurrencia optimista solo protege el interior de
	// una llamada: dos revisores con la fila abierta re-leerían baselines
	// frescas en el servicio y el último pisaría al primero sin 409.
	baselineUpdatedAt?: number;
}

function stringifyForCorrection(value: string | number | null): string {
	return value === null || value === undefined ? "" : String(value);
}

/**
 * Id determinista de una corrección OCR: sha256 de (rowId, campo, valor del
 * modelo, valor corregido, `updated_at` de la fila ANTES de esta edición). El
 * último componente es la clave de la idempotencia: mientras la escritura
 * final (la que avanza `updated_at`) no se haya confirmado, reintentar el
 * MISMO PATCH recalcula el mismo id → `ON CONFLICT DO NOTHING` colapsa a una
 * sola fila. Una edición real POSTERIOR parte de un `updated_at` distinto →
 * id distinto → nueva fila de corrección (es un evento nuevo, no un retry).
 */
export function deterministicCorrectionId(
	rowId: string,
	field: string,
	modelValue: string,
	correctedValue: string,
	preEditUpdatedAt: number,
): string {
	return createHash("sha256")
		.update(
			`${rowId}:${field}:${modelValue}:${correctedValue}:${preEditUpdatedAt}`,
		)
		.digest("hex");
}

/**
 * PATCH de una fila `needs_review`/`valid` (`invalid` es terminal — 409).
 *
 * Concurrencia SIN transacción interactiva (Neon HTTP driver, ver apply.ts):
 * la escritura final es UNA sola UPDATE condicionada por
 * `row_status IN (needs_review, valid) AND updated_at = <baseline leída al
 * principio>`. Esa baseline hace doble función: (a) token de concurrencia
 * optimista — una edición CONCURRENTE que ya escribió cambia `updated_at`, así
 * que la segunda pierde la carrera (0 filas) y recibe 409; (b) el
 * "updated_at previo" del id determinista de `ocr_corrections` — un
 * reintento del MISMO PATCH tras un corte relee la MISMA baseline (nadie más
 * escribió), recalcula el MISMO id de corrección (colapsa vía ON CONFLICT) y
 * esta vez sí completa la UPDATE final.
 */
export async function editImportRow(
	importId: string,
	rowId: string,
	edits: EditImportRowInput,
	actorId: string,
): Promise<ImportRowDTO> {
	const header = await loadHeader(importId);
	if (!header) throw notFound("Lote de importación no encontrado.");
	const row = await loadRow(importId, rowId);
	if (!row) throw notFound("Fila no encontrada.");
	if (row.rowStatus !== "needs_review" && row.rowStatus !== "valid") {
		throw conflict(
			`No se puede editar una fila en estado "${row.rowStatus}" (invalid es terminal).`,
		);
	}
	// Chequeo de baseline del CLIENTE, ANTES de tocar ocr_corrections: si la
	// fila cambió desde que el revisor la leyó, 409 inmediato — así una edición
	// perdedora no deja filas de corrección de una edición que nunca aterrizó.
	// (El reintento del MISMO PATCH tras un corte pasa: la escritura final no
	// llegó a ejecutarse, así que updated_at no cambió.)
	if (
		edits.baselineUpdatedAt !== undefined &&
		edits.baselineUpdatedAt !== row.updatedAt
	) {
		throw conflict(
			"La fila cambió desde que la leíste (edición concurrente); recárgala e inténtalo de nuevo.",
		);
	}

	const nextName = edits.name !== undefined ? normalizeName(edits.name) : row.name;
	const nextAge = edits.age !== undefined ? normalizeAge(edits.age) : row.age;

	const warnings: string[] = [];
	let nextCondition = (row.condition ?? "unknown") as PatientCondition;
	if (edits.condition !== undefined) {
		const mapped = mapCondition(edits.condition);
		nextCondition = mapped.value;
		if (mapped.warning) warnings.push(mapped.warning);
	}
	let nextStatus = (row.status ?? "hospitalized") as PatientStatus;
	if (edits.status !== undefined) {
		const mapped = mapStatus(edits.status);
		nextStatus = mapped.value;
		if (mapped.warning) warnings.push(mapped.warning);
	}

	let nextSourceHospital = row.sourceHospital;
	let nextHospitalId: string | null = row.hospitalId;
	if (edits.hospitalId !== undefined) {
		const hospital = await getHospital(edits.hospitalId);
		if (!hospital) {
			throw badRequest("El hospital indicado (hospitalId) no existe en el catálogo.");
		}
		nextHospitalId = edits.hospitalId;
	} else if (edits.sourceHospital !== undefined) {
		nextSourceHospital = edits.sourceHospital.trim().slice(0, 200);
		nextHospitalId = await resolveHospitalForRow(nextSourceHospital);
	}

	const nextNormalizedKey = nameKey(nextName);

	const normRow: NormalizedRow = {
		name: nextName,
		normalizedKey: nextNormalizedKey,
		age: nextAge,
		condition: nextCondition,
		status: nextStatus,
		sourceHospital: nextSourceHospital,
		hospitalIdHint: nextHospitalId,
		documentDigits: null,
		documentHash: row.documentHash,
		notes: "",
		contact: "",
		warnings,
	};
	const { errors, hospitalUnresolved } = validateRow(
		normRow,
		nextHospitalId !== null,
	);

	let nextRowStatus: string;
	let nextDedupStatus: string;
	let nextDedupCandidates: DedupCandidate[];
	let nextConfidence: number;

	if (errors.length > 0) {
		// A diferencia de process.ts (donde errores de validación → invalid),
		// una edición con errores se queda en revisión: el revisor puede
		// corregir de nuevo. Solo el reject explícito lleva a "invalid".
		nextRowStatus = "needs_review";
		nextDedupStatus = "pending";
		nextDedupCandidates = [];
		nextConfidence = 0;
	} else if (hospitalUnresolved) {
		nextRowStatus = "needs_review";
		nextDedupStatus = "needs_review";
		nextDedupCandidates = [];
		nextConfidence = 0;
		warnings.push(
			"No se pudo resolver el hospital indicado a uno único; requiere revisión manual antes de aplicar.",
		);
	} else {
		const pool = await loadCandidatePoolForRow(
			nextHospitalId,
			nextNormalizedKey,
			row.documentHash,
		);
		const verdict = classifyDedup(normRow, pool);
		nextDedupStatus = verdict.status;
		nextDedupCandidates = verdict.candidates;
		nextConfidence = verdict.confidence;
		nextRowStatus = rowStatusForDedupVerdict(verdict.status);
	}

	// --- Correcciones OCR (solo lotes OCR; ver ingest.ts) — ANTES de la
	// escritura final del estado, una fila por campo REALMENTE cambiado (no
	// se registra nada para campos ausentes del body o sin cambio real).
	if (header.ocrProvider) {
		const changed: { field: string; modelValue: string; correctedValue: string }[] = [];
		if (edits.name !== undefined && nextName !== row.name) {
			changed.push({ field: "name", modelValue: row.name, correctedValue: nextName });
		}
		if (edits.age !== undefined && nextAge !== row.age) {
			changed.push({
				field: "age",
				modelValue: stringifyForCorrection(row.age),
				correctedValue: stringifyForCorrection(nextAge),
			});
		}
		if (edits.condition !== undefined && nextCondition !== row.condition) {
			changed.push({
				field: "condition",
				modelValue: row.condition ?? "",
				correctedValue: nextCondition,
			});
		}
		if (edits.status !== undefined && nextStatus !== row.status) {
			changed.push({
				field: "status",
				modelValue: row.status ?? "",
				correctedValue: nextStatus,
			});
		}
		if (
			edits.sourceHospital !== undefined &&
			nextSourceHospital !== row.sourceHospital
		) {
			changed.push({
				field: "sourceHospital",
				modelValue: row.sourceHospital,
				correctedValue: nextSourceHospital,
			});
		}
		if (edits.hospitalId !== undefined && nextHospitalId !== row.hospitalId) {
			changed.push({
				field: "hospitalId",
				modelValue: row.hospitalId ?? "",
				correctedValue: nextHospitalId ?? "",
			});
		}

		if (changed.length > 0) {
			const db = getDb();
			const documentR2Key = header.sourceImageUrl ?? null;
			await db
				.insert(ocrCorrections)
				.values(
					changed.map((c) => ({
						id: deterministicCorrectionId(
							rowId,
							c.field,
							c.modelValue,
							c.correctedValue,
							row.updatedAt,
						),
						importRowId: rowId,
						field: c.field,
						modelValue: c.modelValue,
						correctedValue: c.correctedValue,
						documentR2Key,
						provider: header.ocrProvider ?? "",
						promptVersion: header.ocrPromptVersion ?? "",
						correctedBy: actorId,
						correctedAt: Date.now(),
						...incidentOwnership(tenantScopeFromImportHeader(header)),
					})),
				)
				.onConflictDoNothing();
		}
	}

	const db = getDb();
	const now = Date.now();
	const updated = await db
		.update(patientImportRows)
		.set({
			name: nextName,
			normalizedKey: nextNormalizedKey,
			age: nextAge,
			condition: nextCondition,
			status: nextStatus,
			sourceHospital: nextSourceHospital,
			hospitalId: nextHospitalId,
			validationErrors: errors,
			validationWarnings: warnings,
			dedupStatus: nextDedupStatus,
			dedupCandidates: nextDedupCandidates,
			confidence: nextConfidence,
			rowStatus: nextRowStatus,
			updatedAt: now,
		})
		.where(
			and(
				eq(patientImportRows.id, rowId),
				eq(patientImportRows.importId, importId),
				inArray(patientImportRows.rowStatus, ["needs_review", "valid"]),
				eq(patientImportRows.updatedAt, row.updatedAt),
			),
		)
		.returning({ id: patientImportRows.id });

	if (updated[0]) {
		return toDTOFromRecord(row, {
			name: nextName,
			age: nextAge,
			condition: nextCondition,
			status: nextStatus,
			sourceHospital: nextSourceHospital,
			hospitalId: nextHospitalId,
			rowStatus: nextRowStatus,
			dedupStatus: nextDedupStatus,
			confidence: nextConfidence,
			validationErrors: errors,
			validationWarnings: warnings,
			dedupCandidates: nextDedupCandidates,
			// El cliente refresca su baseline con esto: sin él, el siguiente
			// guardado llevaría una baseline obsoleta y recibiría un 409 falso.
			updatedAt: now,
		});
	}

	// Carrera perdida (0 filas): baseline obsoleta. Releer — solo es un reintento
	// idempotente si la fila YA contiene EXACTAMENTE los valores que esta
	// petición quería escribir (el mismo PATCH duplicado por reintento de red
	// DESPUÉS de que la primera copia completara la UPDATE final). Comparar solo
	// el estado sería demasiado débil: dos ediciones concurrentes DISTINTAS
	// suelen aterrizar ambas en "valid" y la perdedora fingiría éxito sin
	// escribir nada. Cualquier diferencia de valores → 409.
	const reread = await loadRow(importId, rowId);
	if (
		reread &&
		reread.rowStatus === nextRowStatus &&
		reread.name === nextName &&
		reread.age === nextAge &&
		reread.condition === nextCondition &&
		reread.status === nextStatus &&
		reread.sourceHospital === nextSourceHospital &&
		reread.hospitalId === nextHospitalId
	) {
		return toDTOFromRecord(reread, {});
	}
	throw conflict(
		"La fila cambió mientras se editaba (edición concurrente); recárgala e inténtalo de nuevo.",
	);
}
