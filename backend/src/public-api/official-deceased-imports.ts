import { json, Router } from "express";
import { z } from "zod";
import { writeAudit } from "@/auth/audit";
import { badRequest } from "@/lib/errors";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import {
	CONTENT_TYPE,
	FILE_CONTENT_TYPES,
	ImportParseError,
	MAX_IMPORT_ROWS,
} from "@/services/patient-import-parse";
import * as service from "@/services/official-deceased";
import { requireTenantScope } from "@/middleware/tenant";

export const officialDeceasedImportsRouter = Router();

const largeJson = json({ limit: "4mb" });
const rowSchema = z.object({
	name: z.string().max(service.MAX_DECEASED_NAME).optional(),
	age: z.union([z.number(), z.string().max(10), z.null()]).optional(),
	location: z.string().max(service.MAX_DECEASED_LOCATION).optional(),
	description: z.string().max(service.MAX_DECEASED_DESCRIPTION).optional(),
});
const importSchema = z
	.object({
		title: z.string().trim().min(1).max(service.MAX_LIST_TITLE),
		sourceName: z.string().trim().min(1).max(service.MAX_SOURCE_NAME),
		sourceUrl: z
			.string()
			.trim()
			.url()
			.max(2048)
			.refine((value) => /^https?:\/\//i.test(value), {
				message: "sourceUrl debe usar http o https.",
			}),
		publishedAt: z.number().int().positive().nullable().optional(),
		contentType: z.enum([CONTENT_TYPE.JSON, CONTENT_TYPE.CSV, CONTENT_TYPE.XLSX]),
		fileBase64: z.string().max(4_000_000).optional(),
		rows: z.array(rowSchema).min(1).max(MAX_IMPORT_ROWS).optional(),
		dryRun: z.boolean().default(true),
	})
	.superRefine((value, ctx) => {
		const isFile = FILE_CONTENT_TYPES.has(value.contentType);
		if (isFile && !value.fileBase64) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["fileBase64"],
				message: "Falta el archivo CSV/XLSX.",
			});
		}
		if (!isFile && !value.rows) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["rows"],
				message: "Faltan las filas JSON.",
			});
		}
	});

/**
 * @swagger
 * /api/public/deceased-imports:
 *   post:
 *     summary: Preview or apply an attributed official deceased list
 *     tags: [Public:DeceasedImports]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Preview or idempotent import counts }
 *       400: { description: Invalid file or row data }
 */
officialDeceasedImportsRouter.post(
	"/",
	rateLimit({ scope: "public:official-deceased:import", limit: 20 }),
	requireCapability("missing:create"),
	largeJson,
	validate({ body: importSchema }),
	asyncHandler(async (req, res) => {
		const body = req.body as z.infer<typeof importSchema>;
		try {
			const rows = FILE_CONTENT_TYPES.has(body.contentType)
				? service.parseOfficialDeceasedFile(body.contentType, body.fileBase64 ?? "")
				: (body.rows ?? []);
			const preview = service.previewOfficialDeceasedImport(rows);
			if (body.dryRun) {
				res.json({ preview });
				return;
			}
			const result = await service.importOfficialDeceased(
				{
					title: body.title,
					sourceName: body.sourceName,
					sourceUrl: body.sourceUrl,
					publishedAt: body.publishedAt ?? null,
					rows,
				},
				req.user?.id ?? null,
				requireTenantScope(req),
			);
			await writeAudit(req, {
				action: "official_deceased.import",
				targetType: "official_deceased_list",
				targetId: result.listId,
				metadata: {
					totalRows: result.totalRows,
					validRows: result.validRows,
					inserted: result.inserted,
					updated: result.updated,
					duplicateRows: result.duplicateRows,
				},
			});
			res.json({ result });
		} catch (error) {
			if (error instanceof ImportParseError) throw badRequest(error.message);
			throw error;
		}
	}),
);
