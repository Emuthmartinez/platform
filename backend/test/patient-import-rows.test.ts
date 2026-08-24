/**
 * U2 — edición, confirmación, rechazo y decisión de dedup de filas de
 * importación (`patient_import_rows`). Cubre el contrato de claim/conflict
 * (concurrencia SIN transacción interactiva — ver rows.ts/apply.ts) y la
 * captura de correcciones OCR en `ocr_corrections`.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * PII sintética: hospitales/nombres/cédulas demo, nunca datos reales.
 *
 * Nota de convención (verificada contra el repo, no contra el plan original):
 * el middleware `validate()` mapea TODA falla de zod a 400, y no hay ningún
 * 422 en `backend/src` — así que "confirmar con errores pendientes" y demás
 * casos que el plan U2 describía como 422 se prueban aquí como 400
 * (`badRequest`), la familia de error real que usa el resto del repo para
 * "los datos no pasan validación".
 */
import { randomUUID } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { PROMPT_VERSION } from "@/services/ocr/minimax-config";
import { makeUserWithCaps, testTenantOwnership} from "./helpers";

let app: import("express").Express;
let svc: typeof import("@/services/patient-imports");
let rowsInternal: typeof import("@/services/patient-imports/rows");
let db: typeof import("@/db");

const CAPS = ["patient:import"];
const IMAGE_URL = "https://example.test/demo-scan.jpg";
const OCR_MODEL = "demo-minimax-vision-1";
const DUMMY_OCR_CONFIG = {
	apiKey: "demo-key-not-real",
	baseUrl: "https://example.test/ocr",
	model: "demo-config-model",
	maxTokens: 512,
	timeoutMs: 5000,
	prompt: "demo prompt",
};

beforeAll(async () => {
	app = (await import("@/server")).app;
	svc = await import("@/services/patient-imports");
	rowsInternal = await import("@/services/patient-imports/rows");
	db = await import("@/db");
});

async function makeHospital(name: string): Promise<{ id: string; name: string }> {
	const id = randomUUID();
	await db
		.getDb()
		.insert(db.schema.hospitals)
		.values({ id, name, createdAt: Date.now(), ...testTenantOwnership() });
	return { id, name };
}

/** Lote OCR con UNA fila needs_review (contexto OCR persistido en el header). */
async function makeOcrRow(opts: {
	name: string;
	hospitalName: string;
	age?: number;
	actorId?: string | null;
}) {
	const created = await svc.createImport(
		{ source: "demo-ocr", contentType: "image/jpeg", rows: [] },
		opts.actorId ?? null,
	);
	await svc.ingestOcrImport(created.id, IMAGE_URL, {
		config: DUMMY_OCR_CONFIG,
		extract: async () => ({
			rows: [{ name: opts.name, hospital: opts.hospitalName, age: opts.age }],
			model: OCR_MODEL,
			needsHumanReview: true,
			warnings: ["Extracted via OCR/ICR — mandatory human review required before apply."],
		}),
	});
	const rows = await svc.listImportRows(created.id);
	const row = rows[0];
	if (!row) throw new Error("fixture: fila OCR no creada");
	return { importId: created.id, rowId: row.id };
}

/** Lote JSON (no-OCR) con las filas dadas, ya procesado. */
async function makeJsonImport(
	rowsInput: { name?: string; hospital?: string; age?: number }[],
	actorId: string | null = null,
) {
	const created = await svc.createImport(
		{ source: "demo-json", rows: rowsInput },
		actorId,
	);
	await svc.processImport(created.id);
	const stagedRows = await svc.listImportRows(created.id);
	return { importId: created.id, rows: stagedRows };
}

async function rawRow(rowId: string) {
	const { eq } = await import("drizzle-orm");
	const rows = await db
		.getDb()
		.select()
		.from(db.schema.patientImportRows)
		.where(eq(db.schema.patientImportRows.id, rowId))
		.limit(1);
	return rows[0];
}

async function rawHeader(importId: string) {
	const { eq } = await import("drizzle-orm");
	const rows = await db
		.getDb()
		.select()
		.from(db.schema.patientImports)
		.where(eq(db.schema.patientImports.id, importId))
		.limit(1);
	return rows[0];
}

async function corrections(rowId: string) {
	const { eq } = await import("drizzle-orm");
	return db
		.getDb()
		.select()
		.from(db.schema.ocrCorrections)
		.where(eq(db.schema.ocrCorrections.importRowId, rowId));
}

describe("PATCH /:id/rows/:rowId — edición", () => {
	it("editar el nombre de una fila needs_review de OCR → valid; una fila de ocr_corrections con valores modelo/corregido y provider/prompt del header", async () => {
		const { token, id: actorId } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp OCR Edit ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo OCR Original",
			hospitalName: hospital.name,
			age: 40,
		});

		const before = await rawRow(rowId);
		expect(before?.rowStatus).toBe("needs_review");

		const res = await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${rowId}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ name: "Demo OCR Corregido" });
		expect(res.status).toBe(200);
		expect(res.body.row.rowStatus).toBe("valid");
		expect(res.body.row.name).toBe("Demo OCR Corregido");

		const rows = await corrections(rowId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.field).toBe("name");
		expect(rows[0]?.modelValue).toBe("Demo OCR Original");
		expect(rows[0]?.correctedValue).toBe("Demo OCR Corregido");
		expect(rows[0]?.provider).toBe(OCR_MODEL);
		expect(rows[0]?.promptVersion.length).toBeGreaterThan(0);
		expect(rows[0]?.correctedBy).toBe(actorId);

		// El header persiste el contexto OCR (ingest.ts, item 1 del plan):
		// provider = modelo de la extracción, promptVersion = PROMPT_VERSION,
		// sourceImageUrl = la imageUrl recibida.
		const header = await rawHeader(importId);
		expect(header?.ocrProvider).toBe(OCR_MODEL);
		expect(header?.ocrPromptVersion).toBe(PROMPT_VERSION);
		expect(header?.sourceImageUrl).toBe(IMAGE_URL);
	});

	it("editar SIN tocar el hospital (ya resuelto) no genera corrección de hospitalId/sourceHospital", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp OCR NoTouch ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Solo Nombre",
			hospitalName: hospital.name,
			age: 22,
		});
		await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${rowId}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ name: "Demo Solo Nombre Editado" });

		const rows = await corrections(rowId);
		const fields = rows.map((r) => r.field);
		expect(fields).toEqual(["name"]);
		expect(fields).not.toContain("hospitalId");
		expect(fields).not.toContain("sourceHospital");
	});

	it("editar introduciendo un error de validación (limpiar el hospital) → sigue needs_review con el error listado; el nombre editado SÍ se guarda", async () => {
		// El plan original describía este caso como "edad inválida", pero
		// `validateRow` (patient-import-logic.ts) no valida rango de edad —
		// `normalizeAge` simplemente normaliza a null. El único campo editable
		// que SÍ puede producir un error de validación real es el hospital
		// (name vacío también, pero el schema HTTP ya exige min(1) ahí). Se usa
		// limpiar `sourceHospital` para ejercer el mismo contrato: la fila
		// sigue en needs_review con el error listado, no salta a "invalid".
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp OCR Err ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Con Error",
			hospitalName: hospital.name,
			age: 30,
		});

		const res = await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${rowId}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ name: "Demo Con Error Editado", sourceHospital: "" });
		expect(res.status).toBe(200);
		expect(res.body.row.rowStatus).toBe("needs_review");
		expect(res.body.row.name).toBe("Demo Con Error Editado");
		expect(res.body.row.validationErrors.length).toBeGreaterThan(0);
		expect(res.body.row.validationErrors.join(" ")).toMatch(/hospital/i);

		// El nombre SÍ cambió aunque la fila se quedó en revisión — y sí genera
		// corrección (name cambió), pero NO para sourceHospital (edición
		// intencional a "", no "sin tocar", así que igual cuenta como cambio;
		// se verifica que el campo con error real no rompe el resto).
		const rows = await corrections(rowId);
		const fields = rows.map((r) => r.field).sort();
		expect(fields).toEqual(["name", "sourceHospital"]);
	});

	it("editar en un lote NO-OCR (JSON) → no hay filas ocr_corrections", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp JSON ${randomUUID().slice(0, 8)}`);
		// hospital "Nombre Que No Matchea" no resuelve → needs_review sin OCR.
		const { rows } = await makeJsonImport([
			{ name: "Demo JSON Uno", hospital: `Hospital Fantasma ${randomUUID().slice(0, 6)}` },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		expect(row.rowStatus).toBe("needs_review");
		const importId = (await rawRow(row.id))?.importId;
		if (!importId) throw new Error("fixture sin importId");
		expect((await rawHeader(importId))?.ocrProvider).toBeNull();

		const res = await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${row.id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ name: "Demo JSON Uno Editado", hospitalId: hospital.id });
		expect(res.status).toBe(200);
		expect(res.body.row.rowStatus).toBe("valid");

		expect(await corrections(row.id)).toHaveLength(0);
	});

	it("PATCH sobre una fila invalid (terminal) → 409", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Terminal ${randomUUID().slice(0, 8)}`);
		const { rows } = await makeJsonImport([{ name: "Demo Terminal", hospital: hospital.name }]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		const importId = (await rawRow(row.id))?.importId as string;
		await svc.rejectImportRow(importId, row.id);

		const res = await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${row.id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ name: "Nuevo Nombre" });
		expect(res.status).toBe(409);
	});

	it("edición concurrente (misma baseline del cliente) → una gana, la otra 409", async () => {
		const hospital = await makeHospital(`Hosp Race ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Race Original",
			hospitalName: hospital.name,
			age: 50,
		});
		const actorId = (await makeUserWithCaps(CAPS)).id;
		// Ambos "revisores" leyeron la MISMA versión de la fila (baseline del
		// cliente). Sin baselineUpdatedAt el servicio re-lee una baseline fresca
		// por llamada y el último escritor pisa al primero sin 409 — que es
		// exactamente el escenario de UI que R20 prohíbe.
		const baseline = (await rawRow(rowId))?.updatedAt as number;

		const [r1, r2] = await Promise.allSettled([
			svc.editImportRow(
				importId,
				rowId,
				{ name: "Demo Race A", baselineUpdatedAt: baseline },
				actorId,
			),
			svc.editImportRow(
				importId,
				rowId,
				{ name: "Demo Race B", baselineUpdatedAt: baseline },
				actorId,
			),
		]);
		const outcomes = [r1, r2];
		const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
		const rejected = outcomes.filter((o) => o.status === "rejected");
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		const rejection = (rejected[0] as PromiseRejectedResult).reason as {
			status?: number;
		};
		expect(rejection.status).toBe(409);
		// El ganador quedó escrito; el perdedor no dejó corrección huérfana.
		const finalRow = await rawRow(rowId);
		const winnerName = (
			fulfilled[0] as PromiseFulfilledResult<{ name: string }>
		).value.name;
		expect(finalRow?.name).toBe(winnerName);
		const corr = await corrections(rowId);
		expect(corr.filter((c) => c.field === "name").length).toBe(1);
	});

	it("idempotencia de reintento: el mismo PATCH tras un corte simulado entre insert de corrección y escritura de estado → exactamente UNA fila de ocr_corrections; estado final correcto", async () => {
		const { deterministicCorrectionId } = rowsInternal;
		const hospital = await makeHospital(`Hosp Retry ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Retry Original",
			hospitalName: hospital.name,
			age: 28,
		});
		const actorId = (await makeUserWithCaps(CAPS)).id;
		const header = await svc.getImport(importId);
		const before = await rawRow(rowId);
		if (!before || !header) throw new Error("fixture incompleto");

		// Simula el corte: la "primera" pasada ya insertó la corrección con el
		// id determinista (rowId, campo, valor modelo, valor corregido,
		// updated_at PRE-edición) pero nunca llegó a la UPDATE final — la fila
		// sigue needs_review con el updated_at original.
		const correctionId = deterministicCorrectionId(
			rowId,
			"name",
			"Demo Retry Original",
			"Demo Retry Corregido",
			before.updatedAt,
		);
		await db.getDb().insert(db.schema.ocrCorrections).values({
			id: correctionId,
			importRowId: rowId,
			field: "name",
			modelValue: "Demo Retry Original",
			correctedValue: "Demo Retry Corregido",
			documentR2Key: IMAGE_URL,
			provider: OCR_MODEL,
			promptVersion: PROMPT_VERSION,
			correctedBy: actorId,
			correctedAt: Date.now(),
      ...testTenantOwnership(),
    });
		expect(await corrections(rowId)).toHaveLength(1);

		// "Reintento": el MISMO PATCH que produjo esa corrección.
		const result = await svc.editImportRow(
			importId,
			rowId,
			{ name: "Demo Retry Corregido" },
			actorId,
		);
		expect(result.rowStatus).toBe("valid");
		expect(result.name).toBe("Demo Retry Corregido");

		const rows = await corrections(rowId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(correctionId);
	});
});

describe("POST /:id/rows/:rowId/confirm", () => {
	it("confirmar con errores de validación pendientes → 400 (el repo no usa 422)", async () => {
		// Una fila con `validateRow` en rojo (p.ej. sin hospital) en un lote NO-OCR
		// termina "invalid" directo en process.ts (terminal, ni pasa por
		// needs_review) — no hay forma de llegar a "needs_review con errores"
		// salvo por una EDICIÓN que los introduce (editImportRow, a propósito,
		// no auto-rechaza — ver rows.ts). Se arma ese camino real: fila OCR
		// needs_review limpia, se edita quitando el hospital (queda needs_review
		// CON error), y AHÍ se intenta confirmar.
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Confirm Err ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Confirm Con Error",
			hospitalName: hospital.name,
			age: 27,
		});
		const withError = await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${rowId}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ sourceHospital: "" });
		expect(withError.status).toBe(200);
		expect(withError.body.row.rowStatus).toBe("needs_review");
		expect(withError.body.row.validationErrors.length).toBeGreaterThan(0);

		const res = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${rowId}/confirm`)
			.set("Authorization", `Bearer ${token}`);
		expect(res.status).toBe(400);
	});

	it("confirmar una fila needs_review limpia → valid", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Confirm ${randomUUID().slice(0, 8)}`);
		// hospital text ambiguo a propósito? No: usamos hospitalId directo vía
		// edit primero para dejarla needs_review→limpia sin errores; más simple:
		// usar una fila OCR (siempre needs_review) con datos completos y sin
		// error de validación.
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Confirmable",
			hospitalName: hospital.name,
			age: 33,
		});
		const rowBefore = await rawRow(rowId);
		expect(rowBefore?.validationErrors).toEqual([]);

		const res = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${rowId}/confirm`)
			.set("Authorization", `Bearer ${token}`);
		expect(res.status).toBe(200);
		expect(res.body.row.rowStatus).toBe("valid");

		// Idempotente.
		const again = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${rowId}/confirm`)
			.set("Authorization", `Bearer ${token}`);
		expect(again.status).toBe(200);
		expect(again.body.row.rowStatus).toBe("valid");
	});

	it("confirmación concurrente (misma fila needs_review limpia) → ambas coinciden en valid (protocolo claim-then-reread: idempotente, NO 409)", async () => {
		const hospital = await makeHospital(`Hosp Confirm Race ${randomUUID().slice(0, 8)}`);
		const { importId, rowId } = await makeOcrRow({
			name: "Demo Confirm Race",
			hospitalName: hospital.name,
			age: 37,
		});
		const rowBefore = await rawRow(rowId);
		expect(rowBefore?.validationErrors).toEqual([]);

		// A diferencia de editImportRow (que compara updatedAt Y valores exactos
		// tras perder la carrera), confirmImportRow no lleva baseline de
		// cliente: el claim solo exige `rowStatus = 'needs_review'`. Las DOS
		// llamadas concurrentes apuntan al MISMO estado destino ("valid"), así
		// que la perdedora, al releer, encuentra la fila YA en el estado que ella
		// misma quería escribir — responde éxito idempotente, no 409 (ver
		// rows.ts:191 y el `reread` de confirmImportRow). Contrato distinto al de
		// editImportRow, que sí puede dar 409 al perdedor porque compara valores
		// de edición potencialmente distintos.
		const [r1, r2] = await Promise.allSettled([
			svc.confirmImportRow(importId, rowId),
			svc.confirmImportRow(importId, rowId),
		]);
		const outcomes = [r1, r2];
		expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
		const statuses = outcomes.map(
			(o) => (o as PromiseFulfilledResult<{ rowStatus: string }>).value.rowStatus,
		);
		expect(statuses).toEqual(["valid", "valid"]);

		const finalRow = await rawRow(rowId);
		expect(finalRow?.rowStatus).toBe("valid");
	});
});

describe("POST /:id/rows/:rowId/reject", () => {
	it("reject → invalid; el apply del lote la salta; PATCH posterior → 409", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Reject ${randomUUID().slice(0, 8)}`);
		const { importId, rows } = await makeJsonImport([
			{ name: "Demo Reject Uno", hospital: hospital.name, age: 44 },
			{ name: "Demo Reject Dos", hospital: hospital.name, age: 45 },
		]);
		const [rowA, rowB] = rows;
		if (!rowA || !rowB) throw new Error("fixture incompleto");
		expect(rowA.rowStatus).toBe("valid");
		expect(rowB.rowStatus).toBe("valid");

		const res = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${rowA.id}/reject`)
			.set("Authorization", `Bearer ${token}`);
		expect(res.status).toBe(200);
		expect(res.body.row.rowStatus).toBe("invalid");

		const summary = await svc.applyImport(importId, null);
		expect(summary.counts.applied).toBe(1); // solo rowB

		const rejectedAfterApply = await rawRow(rowA.id);
		expect(rejectedAfterApply?.rowStatus).toBe("invalid");
		expect(rejectedAfterApply?.patientId).toBeNull();

		const patched = await request(app)
			.patch(`/api/public/patient-imports/${importId}/rows/${rowA.id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ name: "No debería aplicar" });
		expect(patched.status).toBe(409);
	});

	it("reject es idempotente", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Reject Idem ${randomUUID().slice(0, 8)}`);
		const { importId, rows } = await makeJsonImport([
			{ name: "Demo Reject Idem", hospital: hospital.name },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		const first = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${row.id}/reject`)
			.set("Authorization", `Bearer ${token}`);
		const second = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${row.id}/reject`)
			.set("Authorization", `Bearer ${token}`);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(second.body.row.rowStatus).toBe("invalid");
	});

	it("rechazo concurrente (misma fila) → ambas coinciden en invalid (mismo protocolo claim-then-reread idempotente que confirm)", async () => {
		const hospital = await makeHospital(`Hosp Reject Race ${randomUUID().slice(0, 8)}`);
		const { importId, rows } = await makeJsonImport([
			{ name: "Demo Reject Race", hospital: hospital.name, age: 41 },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		expect(row.rowStatus).toBe("valid");

		// Mismo protocolo que confirmImportRow (rows.ts:241): el claim solo exige
		// rowStatus IN (needs_review, valid), sin baseline de cliente. Las DOS
		// llamadas concurrentes apuntan al MISMO destino terminal ("invalid"), así
		// que la perdedora releída ya está en el estado que quería escribir →
		// éxito idempotente, no 409.
		const [r1, r2] = await Promise.allSettled([
			svc.rejectImportRow(importId, row.id),
			svc.rejectImportRow(importId, row.id),
		]);
		const outcomes = [r1, r2];
		expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
		const statuses = outcomes.map(
			(o) => (o as PromiseFulfilledResult<{ rowStatus: string }>).value.rowStatus,
		);
		expect(statuses).toEqual(["invalid", "invalid"]);

		const finalRow = await rawRow(row.id);
		expect(finalRow?.rowStatus).toBe("invalid");
	});
});

describe("POST /:id/rows/:rowId/dedup", () => {
	// Nota: sin test de carrera concurrente para decideImportRowDedup (comparte
	// el mismo protocolo claim-then-reread que confirm/reject, rows.ts:299) —
	// a diferencia de esos dos, su claim exige un `patientId` de un candidato
	// real sembrado en `hospital_patients`, así que montar la carrera pide
	// fixtures adicionales que no valía la pena replicar aquí; el idioma
	// transfiere igual si alguien lo necesita más adelante.
	it("aceptar candidato → apply adjunta al paciente existente; hospital_patients no crece", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Dedup Accept ${randomUUID().slice(0, 8)}`);
		const patientName = `Demo Dedup Existente ${randomUUID().slice(0, 6)}`;
		const existingPatientId = randomUUID();
		await db.getDb().insert(db.schema.hospitalPatients).values({
			id: existingPatientId,
			hospitalId: hospital.id,
			name: patientName,
			age: 60,
			condition: "stable",
			status: "hospitalized",
			notes: "",
			contact: "",
			admittedAt: Date.now(),
			updatedAt: Date.now(),
      ...testTenantOwnership(),
    });

		const { eq, and } = await import("drizzle-orm");
		const countBefore = (
			await db
				.getDb()
				.select({ id: db.schema.hospitalPatients.id })
				.from(db.schema.hospitalPatients)
				.where(eq(db.schema.hospitalPatients.hospitalId, hospital.id))
		).length;

		// Misma edad conocida → classifyDedup da "duplicate" (sameAge).
		const { importId, rows } = await makeJsonImport([
			{ name: patientName, hospital: hospital.name, age: 60 },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		expect(row.rowStatus).toBe("duplicate");
		expect(row.dedupCandidates.map((c) => c.patientId)).toContain(existingPatientId);

		const decide = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${row.id}/dedup`)
			.set("Authorization", `Bearer ${token}`)
			.send({ accept: true, patientId: existingPatientId });
		expect(decide.status).toBe(200);
		expect(decide.body.row.rowStatus).toBe("valid");

		const summary = await svc.applyImport(importId, null);
		expect(summary.counts.applied).toBe(1);

		const applied = await rawRow(row.id);
		expect(applied?.rowStatus).toBe("applied");
		expect(applied?.patientId).toBe(existingPatientId);

		const countAfter = (
			await db
				.getDb()
				.select({ id: db.schema.hospitalPatients.id })
				.from(db.schema.hospitalPatients)
				.where(
					and(
						eq(db.schema.hospitalPatients.hospitalId, hospital.id),
						eq(db.schema.hospitalPatients.name, patientName),
					),
				)
		).length;
		expect(countAfter).toBe(1); // ningún paciente nuevo insertado
		expect(countBefore).toBe(1);
	});

	it("rechazar candidato → dedup_candidates se limpia y la fila re-clasifica a valid", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Dedup Reject ${randomUUID().slice(0, 8)}`);
		const patientName = `Demo Dedup Rechazo ${randomUUID().slice(0, 6)}`;
		await db.getDb().insert(db.schema.hospitalPatients).values({
			id: randomUUID(),
			hospitalId: hospital.id,
			name: patientName,
			age: 19,
			condition: "stable",
			status: "hospitalized",
			notes: "",
			contact: "",
			admittedAt: Date.now(),
			updatedAt: Date.now(),
      ...testTenantOwnership(),
    });

		const { importId, rows } = await makeJsonImport([
			{ name: patientName, hospital: hospital.name, age: 19 },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		expect(row.rowStatus).toBe("duplicate");
		expect(row.dedupCandidates.length).toBeGreaterThan(0);

		const res = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${row.id}/dedup`)
			.set("Authorization", `Bearer ${token}`)
			.send({ accept: false });
		expect(res.status).toBe(200);
		expect(res.body.row.rowStatus).toBe("valid");
		expect(res.body.row.dedupCandidates).toEqual([]);
	});

	it("accept:true sin patientId → 400; patientId fuera de los candidatos → 400", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hospital = await makeHospital(`Hosp Dedup Bad ${randomUUID().slice(0, 8)}`);
		const patientName = `Demo Dedup Malo ${randomUUID().slice(0, 6)}`;
		await db.getDb().insert(db.schema.hospitalPatients).values({
			id: randomUUID(),
			hospitalId: hospital.id,
			name: patientName,
			age: 71,
			condition: "stable",
			status: "hospitalized",
			notes: "",
			contact: "",
			admittedAt: Date.now(),
			updatedAt: Date.now(),
      ...testTenantOwnership(),
    });
		const { importId, rows } = await makeJsonImport([
			{ name: patientName, hospital: hospital.name, age: 71 },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");

		const missingPatientId = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${row.id}/dedup`)
			.set("Authorization", `Bearer ${token}`)
			.send({ accept: true });
		expect(missingPatientId.status).toBe(400);

		const wrongPatientId = await request(app)
			.post(`/api/public/patient-imports/${importId}/rows/${row.id}/dedup`)
			.set("Authorization", `Bearer ${token}`)
			.send({ accept: true, patientId: randomUUID() });
		expect(wrongPatientId.status).toBe(400);
	});
});

describe("capability — patient:import", () => {
	async function makeConfirmableRow() {
		const hospital = await makeHospital(`Hosp Cap ${randomUUID().slice(0, 8)}`);
		const { importId, rows } = await makeJsonImport([
			{ name: "Demo Cap", hospital: hospital.name },
		]);
		const row = rows[0];
		if (!row) throw new Error("fixture vacío");
		return { importId, rowId: row.id };
	}

	it("sin auth → 401 en las cuatro rutas", async () => {
		const { importId, rowId } = await makeConfirmableRow();
		const base = `/api/public/patient-imports/${importId}/rows/${rowId}`;
		expect((await request(app).patch(base).send({ name: "X" })).status).toBe(401);
		expect((await request(app).post(`${base}/confirm`)).status).toBe(401);
		expect((await request(app).post(`${base}/reject`)).status).toBe(401);
		expect(
			(await request(app).post(`${base}/dedup`).send({ accept: false })).status,
		).toBe(401);
	});

	it("capability equivocada → 403 en las cuatro rutas", async () => {
		const { importId, rowId } = await makeConfirmableRow();
		const { token } = await makeUserWithCaps(["patient:read"]);
		const base = `/api/public/patient-imports/${importId}/rows/${rowId}`;
		const bearer = `Bearer ${token}`;
		expect(
			(await request(app).patch(base).set("Authorization", bearer).send({ name: "X" }))
				.status,
		).toBe(403);
		expect(
			(await request(app).post(`${base}/confirm`).set("Authorization", bearer)).status,
		).toBe(403);
		expect(
			(await request(app).post(`${base}/reject`).set("Authorization", bearer)).status,
		).toBe(403);
		expect(
			(
				await request(app)
					.post(`${base}/dedup`)
					.set("Authorization", bearer)
					.send({ accept: false })
			).status,
		).toBe(403);
	});
});
