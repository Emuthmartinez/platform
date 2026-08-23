import type { RawPatientRow } from "@/services/patient-import-logic";

export const PATIENT_IMPORT_FAILED_STAGE = {
	PROCESS: "process",
	APPLY: "apply",
} as const;

export type PatientImportFailedStage =
	(typeof PATIENT_IMPORT_FAILED_STAGE)[keyof typeof PATIENT_IMPORT_FAILED_STAGE];

export const PATIENT_CONDITION = {
	STABLE: "stable",
	SERIOUS: "serious",
	CRITICAL: "critical",
	RECOVERING: "recovering",
	UNKNOWN: "unknown",
} as const;

export const PATIENT_STATUS = {
	HOSPITALIZED: "hospitalized",
	SHELTERED: "sheltered",
	DISCHARGED: "discharged",
	TRANSFERRED: "transferred",
	DECEASED: "deceased",
} as const;

export const PATIENT_CONDITIONS = new Set<string>(
	Object.values(PATIENT_CONDITION),
);
export const PATIENT_STATUSES = new Set<string>(Object.values(PATIENT_STATUS));

/**
 * Marca de aceptación de un candidato de dedup por un revisor humano (U2,
 * `POST .../dedup` con `accept:true`). Deliberadamente SIN columna nueva: se
 * guarda como el `reason` del único candidato que queda en `dedup_candidates`
 * (jsonb ya existente). `applyOneRow` (apply.ts) busca esta marca para tomar
 * el camino de "adjuntar al paciente existente" en vez de insertar uno nuevo.
 * Ver `decideImportRowDedup` en rows.ts.
 */
export const DEDUP_ACCEPTED_REASON = "accepted_by_reviewer";

/**
 * `dedup_status` que acompaña la marca anterior. Vive fuera del union
 * `DedupStatus` de patient-import-logic.ts (que modela el VEREDICTO de
 * `classifyDedup`, no una decisión humana) — la columna es `text` sin check
 * constraint, así que un valor adicional aquí es seguro.
 */
export const DEDUP_STATUS_ACCEPTED = "accepted";

export type ImportStatus =
	| "pending"
	| "queued"
	| "processing"
	| "processed"
	| "applying"
	| "applied"
	| "failed";

export interface ImportSummaryDTO {
	id: string;
	status: ImportStatus;
	source: string;
	sourceRecordId: string | null;
	integration: string | null;
	contentType: string;
	jobId: string | null;
	failedStage: PatientImportFailedStage | null;
	counts: {
		total: number;
		valid: number;
		invalid: number;
		duplicate: number;
		review: number;
		applied: number;
	};
	createdBy: string | null;
	errorSummary: string | null;
	// URL de la imagen fuente en lotes OCR (NULL en JSON/CSV/XLSX). El editor
	// de filas del admin la muestra junto al formulario (AE1).
	sourceImageUrl: string | null;
	createdAt: number;
	processedAt: number | null;
	appliedAt: number | null;
	updatedAt: number;
}

export interface ImportRowDTO {
	id: string;
	rowIndex: number;
	name: string;
	age: number | null;
	condition: string | null;
	status: string | null;
	sourceHospital: string;
	hospitalId: string | null;
	rowStatus: string;
	dedupStatus: string;
	confidence: number;
	validationErrors: string[];
	validationWarnings: string[];
	dedupCandidates: { patientId: string; name: string; reason?: string }[];
	patientId: string | null;
	// Baseline de concurrencia optimista: el cliente lo captura al renderizar
	// el editor y lo devuelve como baselineUpdatedAt en el PATCH. Sin exponerlo
	// aquí, el admin no tiene NINGÚN valor observable que usar de baseline.
	updatedAt: number;
}

export interface CreateImportInput {
	source?: string;
	sourceRecordId?: string;
	integration?: string;
	contentType?: string;
	idempotencyKey?: string;
	rows: RawPatientRow[];
	/**
	 * Hospital destino del LOTE: se estampa como `hospitalId` en el rawData de
	 * TODAS las filas al materializar staging, pisando el de la fila. Un
	 * archivo = un hospital. El caller (ruta) valida que el id exista.
	 */
	defaultHospitalId?: string;
}

export interface CreateImportResult extends ImportSummaryDTO {
	reusedExisting: boolean;
}

export interface ImportHeaderRow {
	id: string;
	status: string;
	source: string;
	sourceRecordId: string | null;
	integration: string | null;
	contentType: string;
	// Contexto OCR (NULL en lotes no-OCR): fuente de verdad de si el lote vino
	// de OCR/ICR — `editImportRow` lo usa para decidir si escribe
	// `ocr_corrections`, y copia provider/promptVersion/sourceImageUrl a cada
	// fila corregida.
	ocrProvider: string | null;
	ocrPromptVersion: string | null;
	sourceImageUrl: string | null;
	jobId: string | null;
	failedStage: string | null;
	idempotencyKeyHash: string | null;
	totalRows: number;
	validRows: number;
	invalidRows: number;
	duplicateRows: number;
	reviewRows: number;
	appliedRows: number;
	createdBy: string | null;
	errorSummary: string | null;
	createdAt: number;
	processedAt: number | null;
	appliedAt: number | null;
	updatedAt: number;
	organizationId?: string | null;
	incidentId?: string | null;
}
