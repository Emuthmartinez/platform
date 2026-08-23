import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
	ImportParseError,
	MAX_IMPORT_ROWS,
	parseImportGrid,
} from "@/services/patient-import-parse";
import { incidentOwnership } from "@/tenant/ownership";
import type { TenantScope } from "@/tenant/scope";

const { officialDeceasedLists, officialDeceasedRecords } = schema;

export const MAX_DECEASED_NAME = 120;
export const MAX_DECEASED_LOCATION = 200;
export const MAX_DECEASED_DESCRIPTION = 600;
export const MAX_SOURCE_NAME = 200;
export const MAX_LIST_TITLE = 200;

export interface RawOfficialDeceasedRow {
	name?: string;
	age?: number | string | null;
	location?: string;
	description?: string;
}

export interface OfficialDeceasedImportInput {
	title: string;
	sourceName: string;
	sourceUrl: string;
	publishedAt?: number | null;
	rows: RawOfficialDeceasedRow[];
}

export interface OfficialDeceasedImportPreview {
	totalRows: number;
	validRows: number;
	invalidRows: number;
	duplicateRows: number;
	errors: Array<{ row: number; message: string }>;
	rows: Array<{
		name: string;
		age: number | null;
		location: string;
		description: string;
	}>;
}

export interface OfficialDeceasedImportResult
	extends OfficialDeceasedImportPreview {
	listId: string;
	inserted: number;
	updated: number;
}

export interface OfficialDeceasedDTO {
	id: string;
	name: string;
	age: number | null;
	location: string;
	description: string;
	list: {
		id: string;
		title: string;
		sourceName: string;
		sourceUrl: string;
		publishedAt: number | null;
	};
	createdAt: number;
}

export interface OfficialDeceasedPage {
	people: OfficialDeceasedDTO[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
}

const HEADER_ALIASES: Readonly<Record<string, keyof RawOfficialDeceasedRow>> =
	Object.freeze({
		name: "name",
		nombre: "name",
		persona: "name",
		fallecido: "name",
		fallecida: "name",
		age: "age",
		edad: "age",
		location: "location",
		ubicacion: "location",
		lugar: "location",
		municipio: "location",
		ciudad: "location",
		description: "description",
		descripcion: "description",
		observaciones: "description",
		notas: "description",
	});

function stripAccents(value: string): string {
	return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function headerKey(value: string): string {
	return stripAccents(value.toLowerCase()).replace(/[^a-z0-9]/g, "");
}

function nonEmpty(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

export function tableToOfficialDeceasedRows(
	grid: string[][],
): RawOfficialDeceasedRow[] {
	const headerIndex = grid.findIndex((row) => row.some(nonEmpty));
	if (headerIndex === -1) {
		throw new ImportParseError("El archivo no tiene encabezados.");
	}
	const headers = grid[headerIndex] ?? [];
	const fields = headers.map((header) =>
		header ? (HEADER_ALIASES[headerKey(header)] ?? null) : null,
	);
	if (!fields.includes("name")) {
		throw new ImportParseError(
			"El archivo necesita una columna Nombre, Name o Persona.",
		);
	}

	const rows: RawOfficialDeceasedRow[] = [];
	for (let rowIndex = headerIndex + 1; rowIndex < grid.length; rowIndex++) {
		const cells = grid[rowIndex] ?? [];
		if (!cells.some(nonEmpty)) continue;
		const row: RawOfficialDeceasedRow = {};
		for (let column = 0; column < fields.length; column++) {
			const field = fields[column];
			if (!field) continue;
			const value = (cells[column] ?? "").trim();
			if (value) row[field] = value;
		}
		rows.push(row);
		if (rows.length > MAX_IMPORT_ROWS) {
			throw new ImportParseError(
				`El archivo excede el máximo de ${MAX_IMPORT_ROWS} filas.`,
			);
		}
	}
	if (rows.length === 0) {
		throw new ImportParseError("El archivo no contiene filas de datos.");
	}
	return rows;
}

export function parseOfficialDeceasedFile(
	contentType: string,
	fileBase64: string,
): RawOfficialDeceasedRow[] {
	return tableToOfficialDeceasedRows(parseImportGrid(contentType, fileBase64));
}

function cleanText(value: unknown, max: number): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function normalizeAge(value: unknown): number | null | "invalid" {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(String(value).trim());
	if (!Number.isFinite(parsed)) return "invalid";
	const age = Math.trunc(parsed);
	return age >= 0 && age <= 130 ? age : "invalid";
}

function digest(parts: string[]): string {
	return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function normalizedIdentity(value: string): string {
	return stripAccents(value.toLowerCase())
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function previewOfficialDeceasedImport(
	rows: RawOfficialDeceasedRow[],
): OfficialDeceasedImportPreview {
	const errors: OfficialDeceasedImportPreview["errors"] = [];
	const valid = new Map<string, OfficialDeceasedImportPreview["rows"][number]>();
	let duplicateRows = 0;

	rows.forEach((row, index) => {
		const name = cleanText(row.name, MAX_DECEASED_NAME);
		const age = normalizeAge(row.age);
		const location = cleanText(row.location, MAX_DECEASED_LOCATION);
		const description = cleanText(row.description, MAX_DECEASED_DESCRIPTION);
		if (!name) {
			errors.push({ row: index + 2, message: "Falta el nombre." });
			return;
		}
		if (age === "invalid") {
			errors.push({ row: index + 2, message: "La edad debe estar entre 0 y 130." });
			return;
		}
		const key = digest([
			normalizedIdentity(name),
			String(age ?? ""),
			normalizedIdentity(location),
		]);
		if (valid.has(key)) duplicateRows++;
		valid.set(key, { name, age, location, description });
	});

	return {
		totalRows: rows.length,
		validRows: valid.size,
		invalidRows: errors.length,
		duplicateRows,
		errors: errors.slice(0, 100),
		rows: [...valid.values()],
	};
}

function stableListId(sourceUrl: string): string {
	return `odl_${digest([sourceUrl]).slice(0, 32)}`;
}

function stableRecordId(
	listId: string,
	row: OfficialDeceasedImportPreview["rows"][number],
): string {
	return `odr_${digest([
		listId,
		normalizedIdentity(row.name),
		String(row.age ?? ""),
		normalizedIdentity(row.location),
	]).slice(0, 32)}`;
}

export async function importOfficialDeceased(
	input: OfficialDeceasedImportInput,
	actorId: string | null,
	scope: TenantScope,
): Promise<OfficialDeceasedImportResult> {
	const preview = previewOfficialDeceasedImport(input.rows);
	if (preview.validRows === 0 || preview.invalidRows > 0) {
		throw new ImportParseError(
			preview.invalidRows > 0
				? "Corrige las filas inválidas antes de aplicar el lote."
				: "El lote no contiene filas válidas.",
		);
	}

	const sourceUrl = new URL(input.sourceUrl).toString();
	const listId = stableListId(sourceUrl);
	const now = Date.now();
	const db = getDb();
	const ownership = incidentOwnership(scope);
	await db
		.insert(officialDeceasedLists)
		.values({
			id: listId,
			title: cleanText(input.title, MAX_LIST_TITLE),
			sourceName: cleanText(input.sourceName, MAX_SOURCE_NAME),
			sourceUrl,
			publishedAt: input.publishedAt ?? null,
			createdBy: actorId,
			createdAt: now,
			updatedAt: now,
			...ownership,
		})
		.onConflictDoUpdate({
			target: officialDeceasedLists.sourceUrl,
			set: {
				title: cleanText(input.title, MAX_LIST_TITLE),
				sourceName: cleanText(input.sourceName, MAX_SOURCE_NAME),
				publishedAt: input.publishedAt ?? null,
				updatedAt: now,
			},
		});

	const values = preview.rows.map((row) => ({
		id: stableRecordId(listId, row),
		listId,
		...row,
		createdAt: now,
		updatedAt: now,
		...ownership,
	}));
	const existingIds = new Set<string>();
	const CHUNK_SIZE = 250;
	for (let start = 0; start < values.length; start += CHUNK_SIZE) {
		const chunk = values.slice(start, start + CHUNK_SIZE);
		const existing = await db
			.select({ id: officialDeceasedRecords.id })
			.from(officialDeceasedRecords)
			.where(inArray(officialDeceasedRecords.id, chunk.map((row) => row.id)));
		existing.forEach((row) => existingIds.add(row.id));
		await db
			.insert(officialDeceasedRecords)
			.values(chunk)
			.onConflictDoUpdate({
				target: officialDeceasedRecords.id,
				set: {
					name: sql`excluded.name`,
					age: sql`excluded.age`,
					location: sql`excluded.location`,
					description: sql`excluded.description`,
					updatedAt: now,
				},
			});
	}

	return {
		...preview,
		listId,
		inserted: values.length - existingIds.size,
		updated: existingIds.size,
	};
}

function execRows<T>(result: unknown): T[] {
	return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export async function listOfficialDeceased(params: {
	page?: number;
	pageSize?: number;
	search?: string;
} = {}): Promise<OfficialDeceasedPage> {
	const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? 24), 1), 100);
	const requestedPage = Math.max(Math.trunc(params.page ?? 1), 1);
	const search = cleanText(params.search, 120);
	const pattern = `%${search}%`;
	const where = search
		? sql`WHERE (r.name ILIKE ${pattern} OR r.location ILIKE ${pattern})`
		: sql``;
	const offset = (requestedPage - 1) * pageSize;
	const db = getDb();
	const [countResult, listResult] = await Promise.all([
		db.execute(
			sql`SELECT count(*)::int AS total FROM official_deceased_records r ${where}`,
		),
		db.execute(sql`
			SELECT r.id, r.name, r.age, r.location, r.description,
			       r.created_at, l.id AS list_id, l.title, l.source_name,
			       l.source_url, l.published_at
			FROM official_deceased_records r
			JOIN official_deceased_lists l ON l.id = r.list_id
			${where}
			ORDER BY COALESCE(l.published_at, l.created_at) DESC, r.name ASC, r.id ASC
			LIMIT ${pageSize} OFFSET ${offset}
		`),
	]);
	const total = Number(execRows<{ total: number }>(countResult)[0]?.total ?? 0);
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(requestedPage, totalPages);
	type Row = {
		id: string;
		name: string;
		age: number | null;
		location: string;
		description: string;
		created_at: number | string;
		list_id: string;
		title: string;
		source_name: string;
		source_url: string;
		published_at: number | string | null;
	};
	return {
		people: execRows<Row>(listResult).map((row) => ({
			id: row.id,
			name: row.name,
			age: row.age === null ? null : Number(row.age),
			location: row.location,
			description: row.description,
			list: {
				id: row.list_id,
				title: row.title,
				sourceName: row.source_name,
				sourceUrl: row.source_url,
				publishedAt:
					row.published_at === null ? null : Number(row.published_at),
			},
			createdAt: Number(row.created_at),
		})),
		total,
		page,
		pageSize,
		totalPages,
	};
}
