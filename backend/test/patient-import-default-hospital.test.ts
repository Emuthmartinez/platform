/**
 * Hospital destino del LOTE (`defaultHospitalId`) — flujo real con DB.
 *
 * El picker del panel manda un id de hospital que se estampa como
 * `hospitalId` en el rawData de TODAS las filas al materializar staging,
 * pisando el de la fila. Así un CSV sin columna hospital — o con nombres que
 * no matchean el catálogo — queda `valid` completo y se puede aplicar en
 * bloque de una vez.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * PII sintética: hospitales/nombres demo, nunca datos reales.
 */
import { randomUUID } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { makeUserWithCaps, testTenantOwnership} from "./helpers";

let app: import("express").Express;

beforeAll(async () => {
	app = (await import("@/server")).app;
});

async function makeHospital(name: string): Promise<{ id: string; name: string }> {
	const { getDb, schema } = await import("@/db");
	const db = getDb();
	const id = randomUUID();
	await db.insert(schema.hospitals).values({ id, name, createdAt: Date.now(), ...testTenantOwnership() });
	return { id, name };
}

async function rawDataOf(importId: string): Promise<Record<string, unknown>[]> {
	const { getDb, schema } = await import("@/db");
	const { asc, eq } = await import("drizzle-orm");
	const rows = await getDb()
		.select({ rawData: schema.patientImportRows.rawData })
		.from(schema.patientImportRows)
		.where(eq(schema.patientImportRows.importId, importId))
		.orderBy(asc(schema.patientImportRows.rowIndex));
	return rows.map((r) => r.rawData as Record<string, unknown>);
}

describe("defaultHospitalId — estampado por lote", () => {
	it("createImport (JSON) estampa el id en todas las filas, pisando el de la fila", async () => {
		const svc = await import("@/services/patient-imports");
		const destino = await makeHospital(`Hosp Destino ${randomUUID().slice(0, 8)}`);
		const created = await svc.createImport(
			{
				source: "test",
				rows: [
					{ name: "Demo Uno", hospital: "Nombre Que No Matchea" },
					{ name: "Demo Dos", hospitalId: "otro-id-por-fila" },
					{ name: "Demo Tres" },
				],
				defaultHospitalId: destino.id,
			},
			null,
		);
		const raw = await rawDataOf(created.id);
		expect(raw.map((r) => r.hospitalId)).toEqual([destino.id, destino.id, destino.id]);

		// Y el process resuelve TODO a valid: el id estampado existe, el nombre
		// no-matcheante de la fila ya no manda.
		const summary = await svc.processImport(created.id);
		expect(summary.counts.valid).toBe(3);
		expect(summary.counts.review).toBe(0);
		expect(summary.counts.invalid).toBe(0);
	});

	it("stageFileRows (CSV sin columna hospital) estampa y el lote queda valid", async () => {
		const svc = await import("@/services/patient-imports");
		const destino = await makeHospital(`Hosp CSV ${randomUUID().slice(0, 8)}`);
		const created = await svc.createImport(
			{ source: "test", contentType: "text/csv", rows: [] },
			null,
		);
		const csv = [
			"nombre,edad,estado,telefono,observaciones",
			"Demo Cuatro,30,hospitalizado,3000000000,",
			"Demo Cinco,,hospitalizado,,obs demo",
		].join("\n");
		await svc.stageFileRows(
			created.id,
			"text/csv",
			Buffer.from(csv, "utf8").toString("base64"),
			destino.id,
		);
		const raw = await rawDataOf(created.id);
		expect(raw).toHaveLength(2);
		for (const r of raw) expect(r.hospitalId).toBe(destino.id);

		const summary = await svc.processImport(created.id);
		expect(summary.counts.valid).toBe(2);
		expect(summary.counts.review).toBe(0);
	});

	it("HTTP: defaultHospitalId inexistente → 400 sin crear lote", async () => {
		const { token } = await makeUserWithCaps(["patient:import"]);
		const res = await request(app)
			.post("/api/public/patient-imports")
			.set("Authorization", `Bearer ${token}`)
			.send({
				rows: [{ name: "Demo Rechazo", hospital: "Hosp X" }],
				defaultHospitalId: `no-existe-${randomUUID()}`,
			});
		expect(res.status).toBe(400);
		expect(String(res.body.error ?? "")).toMatch(/hospital/i);
	});

	it("HTTP: defaultHospitalId válido → 202 y filas estampadas", async () => {
		const svc = await import("@/services/patient-imports");
		const destino = await makeHospital(`Hosp HTTP ${randomUUID().slice(0, 8)}`);
		const { token } = await makeUserWithCaps(["patient:import"]);
		const res = await request(app)
			.post("/api/public/patient-imports")
			.set("Authorization", `Bearer ${token}`)
			.send({
				rows: [{ name: "Demo Seis" }],
				defaultHospitalId: destino.id,
			});
		expect(res.status).toBe(202);
		const raw = await rawDataOf(res.body.import.id as string);
		expect(raw[0]?.hospitalId).toBe(destino.id);
		// El process del job puede correr o no según el entorno de cola del
		// test; el estampado en staging es lo que este caso asegura.
		void svc;
	});
});
