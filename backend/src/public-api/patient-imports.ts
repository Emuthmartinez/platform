import { json, Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { writeAudit } from "@/auth/audit";
import {
	badRequest,
	notFound,
	notImplemented,
	serviceUnavailable,
	unsupportedMediaType,
} from "@/lib/errors";
import { enqueuePatientImport } from "@/lib/queues";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import { requireTenantScope } from "@/middleware/tenant";
import { getHospital } from "@/services/hospitals";
import { getMinimaxOcrConfig } from "@/services/ocr/minimax-config";
import {
	FILE_CONTENT_TYPES,
	isOcrPendingContentType,
	isSupportedImportContentType,
	MAX_IMPORT_ROWS,
} from "@/services/patient-import-parse";
import * as service from "@/services/patient-imports";
import { logUpstreamFailure } from "@/lib/db-error";

export const patientImportsRouter = Router();

const jsonLargeBatch = json({ limit: "4mb" });

const rowSchema = z
	.object({
		hospital: z.string().trim().max(200).optional(),
		hospitalId: z.string().trim().max(120).optional(),
		name: z.string().trim().max(200).optional(),
		age: z
			.union([z.number(), z.string().max(10)])
			.nullable()
			.optional(),
		condition: z.string().trim().max(60).optional(),
		status: z.string().trim().max(60).optional(),

		documentId: z.string().trim().max(60).optional(),
		notes: z.string().max(600).optional(),
		contact: z.string().max(120).optional(),
	})
	.passthrough();

const MAX_FILE_BASE64_LEN = 4_000_000;

function isImageContentType(contentType: string | undefined): boolean {
	return (contentType?.trim().toLowerCase() ?? "").startsWith("image/");
}

const UNSUPPORTED_CONTENT_TYPE_MESSAGE =
	"Formato no soportado. Envía JSON, CSV, XLSX o imágenes (JPG/PNG); si tienes un PDF, " +
	"fotografía o exporta sus páginas como imagen.";

/**
 * Rechaza content-types sin ruta de procesamiento (p.ej. application/pdf)
 * ANTES del zod validator, con 415 en vez de dejarlos "pasar" la validación
 * de forma y morir más abajo con 501 (la contradicción que tenía PDF: el
 * validator lo aceptaba como OCR-pendiente, pero el router jamás implementó
 * rasterizado de PDF). `isSupportedImportContentType` es la única fuente de
 * verdad de qué se acepta; este middleware es su único punto de aplicación.
 */
function rejectUnsupportedContentType(
	req: Request,
	_res: Response,
	next: NextFunction,
): void {
	const contentType = (req.body as { contentType?: unknown } | undefined)
		?.contentType;
	if (
		typeof contentType === "string" &&
		!isSupportedImportContentType(contentType)
	) {
		next(unsupportedMediaType(UNSUPPORTED_CONTENT_TYPE_MESSAGE));
		return;
	}
	next();
}

const createSchema = z
	.object({
		source: z.string().trim().max(120).optional(),

		sourceRecordId: z.string().trim().max(200).optional(),
		integration: z.string().trim().max(120).optional(),

		// Hospital destino del LOTE: se estampa como hospitalId en todas las
		// filas (pisa el de la fila). Así un CSV sin columna hospital — o con
		// nombres que no matchean el catálogo — queda válido en un paso.
		defaultHospitalId: z.string().trim().min(1).max(120).optional(),

		// La aceptación de contentType (JSON/CSV/XLSX/image) se aplica ANTES de
		// este validator, en `rejectUnsupportedContentType` (415). Aquí solo se
		// acota forma/longitud para que zod no filtre basura arbitraria.
		contentType: z.string().trim().max(120).optional(),

		rows: z
			.array(rowSchema)
			.min(1, "Envía al menos una fila.")
			.max(MAX_IMPORT_ROWS, `Máximo ${MAX_IMPORT_ROWS} filas por lote.`)
			.optional(),

		fileBase64: z
			.string()
			.max(MAX_FILE_BASE64_LEN, "Archivo demasiado grande.")
			.optional(),

		imageUrl: z
			.string()
			.trim()
			.max(2048)
			.url("imageUrl debe ser una URL válida.")
			.refine((v) => /^https?:\/\//i.test(v), {
				message: "imageUrl debe ser http o https.",
			})
			.optional(),
	})
	.superRefine((val, ctx) => {
		if (
			val.defaultHospitalId !== undefined &&
			val.contentType !== undefined &&
			isOcrPendingContentType(val.contentType)
		) {
			// El staging OCR no estampa el hospital: rechazar explícito antes
			// que aceptar un campo que no tendría efecto.
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["defaultHospitalId"],
				message: "defaultHospitalId no aplica a importaciones OCR/ICR.",
			});
		}
		if (val.imageUrl !== undefined && !isImageContentType(val.contentType)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["imageUrl"],
				message: "imageUrl solo aplica a contentType image/* (OCR/ICR).",
			});
		}

		if (
			val.contentType !== undefined &&
			isOcrPendingContentType(val.contentType)
		)
			return;
		const isFile =
			val.contentType !== undefined && FILE_CONTENT_TYPES.has(val.contentType);
		if (isFile) {
			if (!val.fileBase64) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["fileBase64"],
					message: "Para CSV/XLSX envía el archivo en fileBase64.",
				});
			}
			if (val.rows !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["rows"],
					message: "Para CSV/XLSX usa fileBase64, no rows.",
				});
			}
		} else {
			if (!val.rows) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["rows"],
					message: "Envía al menos una fila.",
				});
			}
			if (val.fileBase64 !== undefined) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["fileBase64"],
					message: "fileBase64 solo aplica a CSV/XLSX.",
				});
			}
		}
	});

const idempotencyKeyHeader = z.object({
	"idempotency-key": z.string().trim().min(1).max(200).optional(),
});

const idParams = z.object({ id: z.string().trim().min(1, "Falta el id.") });
const rowsQuery = z.object({
	limit: z.coerce.number().int().min(1).max(500).optional(),
	offset: z.coerce.number().int().min(0).optional(),
});

const rowParams = z.object({
	id: z.string().trim().min(1, "Falta el id del lote."),
	rowId: z.string().trim().min(1, "Falta el id de la fila."),
});

// Whitelist de campos editables de una fila en revisión (U2): nombre, edad,
// condición/estado clínico y hospital (texto libre o id resuelto del
// catálogo). Documento/notas/contacto NO son editables aquí — fuera de
// alcance de la resolución de revisión OCR.
const editRowBodySchema = z
	.object({
		name: z.string().trim().min(1).max(200).optional(),
		age: z
			.union([z.number(), z.string().max(10)])
			.nullable()
			.optional(),
		condition: z.string().trim().max(60).optional(),
		status: z.string().trim().max(60).optional(),
		sourceHospital: z.string().trim().max(200).optional(),
		hospitalId: z.string().trim().min(1).max(120).optional(),
		// updated_at de la fila tal como la vio el cliente (concurrencia
		// optimista real: sin esto, dos revisores con la fila abierta se pisan).
		baselineUpdatedAt: z.number().int().positive().optional(),
	})
	.refine(
		(o) => Object.keys(o).filter((k) => k !== "baselineUpdatedAt").length > 0,
		"Envía al menos un campo a editar.",
	);

const dedupDecisionSchema = z
	.object({
		accept: z.boolean(),
		patientId: z.string().trim().min(1).max(120).optional(),
	})
	.refine((o) => !o.accept || Boolean(o.patientId), {
		message: "Falta patientId para aceptar el candidato.",
		path: ["patientId"],
	});

/**
 * @swagger
 * /api/public/patient-imports:
 *   post:
 *     summary: Crear lote de importación (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       202: { description: Lote encolado }
 *       400: { description: Payload inválido }
 *       415: { description: Content-type no soportado (p.ej. application/pdf) }
 *       501: { description: OCR no habilitado }
 */
patientImportsRouter.post(
	"/",
	rateLimit({ scope: "public:patient-import:create", limit: 30 }),
	requireCapability("patient:import"),
	jsonLargeBatch,
	rejectUnsupportedContentType,
	validate({ body: createSchema }),
	asyncHandler(async (req, res) => {
		const parsedHeaders = idempotencyKeyHeader.safeParse(req.headers);
		if (!parsedHeaders.success) throw badRequest("Idempotency-Key inválido.");
		const headers = parsedHeaders.data;
		const parsed = req.body as z.infer<typeof createSchema>;
		const scope = requireTenantScope(req);

		if (
			parsed.contentType !== undefined &&
			isOcrPendingContentType(parsed.contentType)
		) {
			// isOcrPendingContentType ya solo reconoce image/*: `rejectUnsupportedContentType`
			// rechazó cualquier otro content-type (PDF incluido) más arriba con 415, así
			// que llegar aquí implica isImage === true. No hay rama "PDF sin OCR" que cubrir.
			const ocrConfig = getMinimaxOcrConfig();
			if (!ocrConfig) {
				throw notImplemented(
					"Importación por OCR/ICR (imagen) no está habilitada en este servidor. " +
						"El reconocimiento de imágenes y de texto manuscrito requiere revisión humana. " +
						"Por ahora envía datos tabulares: JSON (rows) o un archivo CSV/XLSX (fileBase64).",
				);
			}
			if (!parsed.imageUrl) {
				throw badRequest(
					"Para OCR/ICR de imagen envía imageUrl (URL http/https). No se acepta base64 ni rows en esta fase.",
				);
			}
			if (parsed.fileBase64 !== undefined || parsed.rows !== undefined) {
				throw badRequest(
					"Para OCR/ICR de imagen usa solo imageUrl (sin fileBase64 ni rows).",
				);
			}

			const created = await service.createImport(
				{
					source: parsed.source,
					sourceRecordId: parsed.sourceRecordId,
					integration: parsed.integration,
					contentType: parsed.contentType,
					rows: [],
					idempotencyKey: headers["idempotency-key"],
				},
				req.user?.id ?? null,
				scope,
			);
			const { reusedExisting, ...summary } = created;
			if (reusedExisting) {
				res.status(202).json({ import: summary, jobId: summary.jobId });
				return;
			}
			let ocrJobId: string;
			try {
				ocrJobId = await enqueuePatientImport(
					{
						importId: summary.id,
						mode: "ocr",
						imageUrl: parsed.imageUrl,
					},
					scope,
				);
			} catch (err) {
				logUpstreamFailure("patient-imports.enqueue-ocr", err);
				await service.markImportFailed(
					summary.id,
					"No se pudo encolar el OCR/ICR.",
					"process",
				);
				throw serviceUnavailable(
					"No se pudo encolar la importación OCR. Inténtalo de nuevo.",
				);
			}
			await service.markImportQueued(summary.id, ocrJobId);

			await writeAudit(req, {
				action: "patient-import.create",
				targetType: "patient-import",
				targetId: summary.id,
				metadata: {
					source: summary.source,
					contentType: summary.contentType,
					ocr: true,
				},
			});
			res.status(202).json({
				import: { ...summary, status: "queued", jobId: ocrJobId },
				jobId: ocrJobId,
			});
			return;
		}

		const isFile =
			parsed.contentType !== undefined &&
			FILE_CONTENT_TYPES.has(parsed.contentType);

		// Validar el hospital destino ANTES de crear nada: un id inexistente
		// dejaría todo el lote en revisión, justo lo que el picker evita.
		if (parsed.defaultHospitalId !== undefined) {
			const hospital = await getHospital(parsed.defaultHospitalId);
			if (!hospital) {
				throw badRequest(
					"El hospital indicado (defaultHospitalId) no existe en el catálogo.",
				);
			}
		}

		const created = await service.createImport(
			{
				source: parsed.source,
				sourceRecordId: parsed.sourceRecordId,
				integration: parsed.integration,
				contentType: parsed.contentType,
				rows: isFile ? [] : (parsed.rows ?? []),
				idempotencyKey: headers["idempotency-key"],
				defaultHospitalId: parsed.defaultHospitalId,
			},
			req.user?.id ?? null,
			scope,
		);
		const { reusedExisting, ...summary } = created;
		if (reusedExisting) {
			res.status(202).json({ import: summary, jobId: summary.jobId });
			return;
		}
		let jobId: string;
		try {
			jobId = await enqueuePatientImport(
				isFile
					? {
							importId: summary.id,
							mode: "process",
							contentType: parsed.contentType,
							fileBase64: parsed.fileBase64,
							defaultHospitalId: parsed.defaultHospitalId,
						}
					: { importId: summary.id, mode: "process" },
				scope,
			);
		} catch (err) {
			logUpstreamFailure("patient-imports.enqueue-process", err);
			await service.markImportFailed(
				summary.id,
				"No se pudo encolar el procesamiento.",
				"process",
			);
			throw serviceUnavailable(
				"No se pudo encolar la importación. Inténtalo de nuevo.",
			);
		}

		await service.markImportQueued(summary.id, jobId);
		await writeAudit(req, {
			action: "patient-import.create",
			targetType: "patient-import",
			targetId: summary.id,

			metadata: isFile
				? { source: summary.source, contentType: summary.contentType }
				: { rows: summary.counts.total, source: summary.source },
		});
		res
			.status(202)
			.json({ import: { ...summary, status: "queued", jobId }, jobId });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}:
 *   get:
 *     summary: Estado y contadores de un lote (capability patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Resumen del lote (sin PII) }
 *       404: { description: No encontrado }
 */
patientImportsRouter.get(
	"/:id",
	rateLimit({ scope: "public:patient-import:get", limit: 120 }),
	requireCapability("patient:import"),
	validate({ params: idParams }),
	asyncHandler(async (req, res) => {
		const summary = await service.getImport((req.params as { id: string }).id);
		if (!summary) throw notFound("Lote de importación no encontrado.");
		res.json({ import: summary });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/rows:
 *   get:
 *     summary: Filas redactadas del lote (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer } }
 *       - { name: offset, in: query, schema: { type: integer } }
 *     responses:
 *       200: { description: Filas redactadas del lote }
 *       404: { description: No encontrado }
 */
patientImportsRouter.get(
	"/:id/rows",
	rateLimit({ scope: "public:patient-import:rows", limit: 120 }),
	requireCapability("patient:import"),
	validate({ params: idParams, query: rowsQuery }),
	asyncHandler(async (req, res) => {
		const id = (req.params as { id: string }).id;
		const exists = await service.getImport(id);
		if (!exists) throw notFound("Lote de importación no encontrado.");
		const q = req.query as z.infer<typeof rowsQuery>;
		const rows = await service.listImportRows(id, {
			limit: q.limit,
			offset: q.offset,
		});
		res.json({ items: rows });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/retry:
 *   post:
 *     summary: Reintentar el procesamiento de un lote fallido (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       202: { description: Procesamiento encolado }
 *       400: { description: El lote no es reanudable }
 *       404: { description: No encontrado }
 *       503: { description: No se pudo encolar }
 */
patientImportsRouter.post(
	"/:id/retry",
	rateLimit({ scope: "public:patient-import:retry", limit: 30 }),
	requireCapability("patient:import"),
	validate({ params: idParams }),
	asyncHandler(async (req, res) => {
		const id = (req.params as { id: string }).id;
		const scope = requireTenantScope(req);
		const summary = await service.getImport(id);
		if (!summary) throw notFound("Lote de importación no encontrado.");
		if (summary.status !== "failed" || summary.failedStage !== "process") {
			throw badRequest(
				`El lote está en estado "${summary.status}"; solo se puede reintentar un fallo de procesamiento.`,
			);
		}
		if (summary.counts.total === 0) {
			throw badRequest(
				"El lote no conserva filas de staging; vuelve a crearlo desde el archivo o imagen original.",
			);
		}
		if (!(await service.claimImportRetry(id))) {
			throw badRequest("El lote ya fue reintentado por otro operador.");
		}

		let jobId: string;
		try {
			jobId = await enqueuePatientImport(
				{ importId: id, mode: "process" },
				scope,
			);
		} catch (err) {
			logUpstreamFailure("patient-imports.enqueue-retry", err);
			await service.markImportFailed(
				id,
				summary.errorSummary ?? "No se pudo encolar el reintento.",
				"process",
			);
			throw serviceUnavailable(
				"No se pudo encolar el reintento. Inténtalo de nuevo.",
			);
		}
		await service.setImportJob(id, jobId);
		await writeAudit(req, {
			action: "patient-import.retry",
			targetType: "patient-import",
			targetId: id,
			metadata: { failedStage: summary.failedStage, rows: summary.counts.total },
		});
		res.status(202).json({ jobId });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/apply:
 *   post:
 *     summary: Aplicar filas válidas del lote (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       202: { description: Apply encolado }
 *       400: { description: El lote aún no está procesado o no es reanudable }
 *       404: { description: No encontrado }
 *       503: { description: No se pudo encolar (cola no disponible) }
 */
patientImportsRouter.post(
	"/:id/apply",
	rateLimit({ scope: "public:patient-import:apply", limit: 30 }),
	requireCapability("patient:import"),
	validate({ params: idParams }),
	asyncHandler(async (req, res) => {
		const id = (req.params as { id: string }).id;
		const scope = requireTenantScope(req);
		const summary = await service.getImport(id);
		if (!summary) throw notFound("Lote de importación no encontrado.");

		if (
			!["processed", "applied"].includes(summary.status) &&
			!(summary.status === "failed" && summary.failedStage === "apply")
		) {
			throw badRequest(
				`El lote está en estado "${summary.status}"; debe estar "processed" o fallido en etapa "apply" para aplicar.`,
			);
		}
		let jobId: string;
		try {
			jobId = await enqueuePatientImport(
				{
					importId: id,
					mode: "apply",
					actorId: req.user?.id ?? null,
				},
				scope,
			);
		} catch (err) {
			logUpstreamFailure("patient-imports.enqueue-apply", err);
			throw serviceUnavailable(
				"No se pudo encolar el apply. Inténtalo de nuevo.",
			);
		}
		await service.setImportJob(id, jobId);
		await writeAudit(req, {
			action: "patient-import.apply",
			targetType: "patient-import",
			targetId: id,
			metadata: { valid: summary.counts.valid },
		});
		res.status(202).json({ jobId });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/rows/{rowId}:
 *   patch:
 *     summary: Editar una fila en revisión (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: rowId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Fila actualizada, re-validada y re-clasificada }
 *       400: { description: Payload inválido o hospitalId inexistente }
 *       404: { description: Lote o fila no encontrados }
 *       409: { description: Fila en estado terminal o edición concurrente (baseline obsoleta) }
 */
patientImportsRouter.patch(
	"/:id/rows/:rowId",
	rateLimit({ scope: "public:patient-import:row-edit", limit: 60 }),
	requireCapability("patient:import"),
	validate({ params: rowParams, body: editRowBodySchema }),
	asyncHandler(async (req, res) => {
		const { id, rowId } = req.params as z.infer<typeof rowParams>;
		const edits = req.body as z.infer<typeof editRowBodySchema>;
		const row = await service.editImportRow(id, rowId, edits, req.user!.id);
		await writeAudit(req, {
			action: "patient-import.row.edit",
			targetType: "patient-import-row",
			targetId: rowId,
			metadata: { importId: id, fields: Object.keys(edits).filter((k) => k !== "baselineUpdatedAt") },
		});
		res.json({ row });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/rows/{rowId}/confirm:
 *   post:
 *     summary: Confirmar una fila needs_review sin errores (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: rowId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Fila confirmada (valid) }
 *       400: { description: Quedan errores de validación }
 *       404: { description: Lote o fila no encontrados }
 *       409: { description: Fila en estado no confirmable }
 */
patientImportsRouter.post(
	"/:id/rows/:rowId/confirm",
	rateLimit({ scope: "public:patient-import:row-confirm", limit: 60 }),
	requireCapability("patient:import"),
	validate({ params: rowParams }),
	asyncHandler(async (req, res) => {
		const { id, rowId } = req.params as z.infer<typeof rowParams>;
		const row = await service.confirmImportRow(id, rowId);
		await writeAudit(req, {
			action: "patient-import.row.confirm",
			targetType: "patient-import-row",
			targetId: rowId,
			metadata: { importId: id },
		});
		res.json({ row });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/rows/{rowId}/reject:
 *   post:
 *     summary: Rechazar una fila (needs_review|valid → invalid, terminal) (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: rowId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Fila rechazada (invalid) }
 *       404: { description: Lote o fila no encontrados }
 *       409: { description: Fila en estado no rechazable }
 */
patientImportsRouter.post(
	"/:id/rows/:rowId/reject",
	rateLimit({ scope: "public:patient-import:row-reject", limit: 60 }),
	requireCapability("patient:import"),
	validate({ params: rowParams }),
	asyncHandler(async (req, res) => {
		const { id, rowId } = req.params as z.infer<typeof rowParams>;
		const row = await service.rejectImportRow(id, rowId);
		await writeAudit(req, {
			action: "patient-import.row.reject",
			targetType: "patient-import-row",
			targetId: rowId,
			metadata: { importId: id },
		});
		res.json({ row });
	}),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/rows/{rowId}/dedup:
 *   post:
 *     summary: Decidir un candidato de deduplicación (patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: rowId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Decisión aplicada (valid con candidato aceptado, o re-clasificada) }
 *       400: { description: Payload inválido o patientId fuera de los candidatos de la fila }
 *       404: { description: Lote o fila no encontrados }
 *       409: { description: Fila en estado no decidible }
 */
patientImportsRouter.post(
	"/:id/rows/:rowId/dedup",
	rateLimit({ scope: "public:patient-import:row-dedup", limit: 60 }),
	requireCapability("patient:import"),
	validate({ params: rowParams, body: dedupDecisionSchema }),
	asyncHandler(async (req, res) => {
		const { id, rowId } = req.params as z.infer<typeof rowParams>;
		const decision = req.body as z.infer<typeof dedupDecisionSchema>;
		const row = await service.decideImportRowDedup(id, rowId, decision);
		await writeAudit(req, {
			action: "patient-import.row.dedup",
			targetType: "patient-import-row",
			targetId: rowId,
			metadata: { importId: id, accept: decision.accept },
		});
		res.json({ row });
	}),
);
