/**
 * Edición de pacientes tras la carga — iterar el dato al ganar confianza:
 * cédula/documento (se guarda SOLO su HMAC, misma clave que la importación),
 * traslado de hospital (validado), y la señal `hasDocument` en el DTO admin
 * (jamás en la búsqueda pública).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * PII sintética: hospitales/nombres/cédulas demo, nunca datos reales.
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
	const id = randomUUID();
	await getDb()
		.insert(schema.hospitals)
		.values({ id, name, createdAt: Date.now(), ...testTenantOwnership() });
	return { id, name };
}

const CAPS = ["patient:read", "patient:create", "patient:edit"];

describe("pacientes — edición iterativa", () => {
	it("create con documentId guarda solo la huella y expone hasDocument", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hosp = await makeHospital(`Hosp Edit A ${randomUUID().slice(0, 8)}`);
		const res = await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({
				hospitalId: hosp.id,
				name: "Demo Editable Uno",
				documentId: `10.${Math.floor(1000000 + Math.random() * 8999999)}-1`,
			});
		expect(res.status).toBe(201);
		expect(res.body.item.hasDocument).toBe(true);
		expect(JSON.stringify(res.body)).not.toContain("100000001");

		const { getDb, schema } = await import("@/db");
		const { eq } = await import("drizzle-orm");
		const row = await getDb()
			.select({ documentHash: schema.hospitalPatients.documentHash })
			.from(schema.hospitalPatients)
			.where(eq(schema.hospitalPatients.id, res.body.item.id as string))
			.limit(1);
		expect(row[0]?.documentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("PATCH añade cédula después (hasDocument pasa a true) y null la borra", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hosp = await makeHospital(`Hosp Edit B ${randomUUID().slice(0, 8)}`);
		const created = await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: hosp.id, name: "Demo Editable Dos" });
		expect(created.status).toBe(201);
		expect(created.body.item.hasDocument).toBe(false);
		const id = created.body.item.id as string;

		const withDoc = await request(app)
			.patch(`/api/public/patients/${id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ documentId: `20${Math.floor(Math.random() * 1e7)}` });
		expect(withDoc.status).toBe(200);
		expect(withDoc.body.item.hasDocument).toBe(true);

		const cleared = await request(app)
			.patch(`/api/public/patients/${id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ documentId: null });
		expect(cleared.status).toBe(200);
		expect(cleared.body.item.hasDocument).toBe(false);
	});

	it("PATCH con documento de OTRO paciente → 409 (señal de mismo registro)", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hosp = await makeHospital(`Hosp Edit C ${randomUUID().slice(0, 8)}`);
		const doc = `30${Math.floor(Math.random() * 1e7)}`;
		const a = await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: hosp.id, name: "Demo Dup A", documentId: doc });
		expect(a.status).toBe(201);
		const b = await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: hosp.id, name: "Demo Dup B" });
		expect(b.status).toBe(201);

		const res = await request(app)
			.patch(`/api/public/patients/${b.body.item.id as string}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ documentId: doc });
		expect(res.status).toBe(409);
		expect(String(res.body.error)).toMatch(/documento/i);
	});

	it("PATCH hospitalId traslada; hospital inexistente → 400", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const origen = await makeHospital(`Hosp Origen ${randomUUID().slice(0, 8)}`);
		const destino = await makeHospital(`Hosp Destino ${randomUUID().slice(0, 8)}`);
		const created = await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: origen.id, name: "Demo Traslado" });
		const id = created.body.item.id as string;

		const moved = await request(app)
			.patch(`/api/public/patients/${id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: destino.id });
		expect(moved.status).toBe(200);
		expect(moved.body.item.hospitalId).toBe(destino.id);

		const bad = await request(app)
			.patch(`/api/public/patients/${id}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: `no-existe-${randomUUID()}` });
		expect(bad.status).toBe(400);
	});

	it("documento con menos de 4 dígitos → 400", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hosp = await makeHospital(`Hosp Edit D ${randomUUID().slice(0, 8)}`);
		const created = await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: hosp.id, name: "Demo Doc Corto" });
		const res = await request(app)
			.patch(`/api/public/patients/${created.body.item.id as string}`)
			.set("Authorization", `Bearer ${token}`)
			.send({ documentId: "A-1" });
		expect(res.status).toBe(400);
	});

	it("la búsqueda pública NO expone hasDocument", async () => {
		const { token } = await makeUserWithCaps(CAPS);
		const hosp = await makeHospital(`Hosp Público ${randomUUID().slice(0, 8)}`);
		const name = `Demo Búsqueda ${randomUUID().slice(0, 6)}`;
		await request(app)
			.post("/api/public/patients")
			.set("Authorization", `Bearer ${token}`)
			.send({ hospitalId: hosp.id, name, documentId: `40${Math.floor(Math.random() * 1e7)}` });

		const res = await request(app).get(
			`/api/patients/search?q=${encodeURIComponent(name)}`,
		);
		expect(res.status).toBe(200);
		expect(res.body.results.length).toBeGreaterThan(0);
		for (const r of res.body.results) {
			expect(r.patient).not.toHaveProperty("hasDocument");
			expect(r.patient).not.toHaveProperty("notes");
		}
	});
});
