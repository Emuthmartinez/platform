/**
 * partner-sync (U13) — endurecimiento del endpoint de ingesta síncrona de un
 * socio externo: auth por API key con scope `missing:create`, `source`
 * SIEMPRE estampado del lado servidor (nunca del body), tope de lote (50),
 * dedup por `(source, external_id)`, kill-switches (revocación de la llave +
 * `missing_person_suppressions`) y allowlist de dominios de media por socio
 * (cierra el open-redirect de `GET /api/missing/:id/photo`).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * PII sintética: nombres/emails DEMO, nunca datos reales.
 */
import { randomUUID } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import { expectNoSensitiveFields } from "./helpers";
import request from "supertest";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { createApiKey, revokeApiKey } from "@/services/api-keys";
import { colombiaTenantScope } from "@/lib/colombia-tenant";
import * as missingService from "@/services/missing";
import {
	allowedPartnerMediaUrl,
	PARTNER_MEDIA_ALLOWLIST,
} from "@/config/partner-media-allowlist";

let app: import("express").Express;

beforeAll(async () => {
	app = (await import("@/server")).app;
});

/** La única capability que este endpoint exige (reutilizada, ver el router). */
const CAP = "missing:create";

interface PartnerAccount {
	rawKey: string;
	apiKeyId: string;
	userId: string;
	email: string;
}

/**
 * Crea un rol con exactamente `caps`, un usuario activo con ese rol, y una API
 * key (`mer_sk_…`) scoped a esas mismas caps. Espeja `makeUserWithCaps` de
 * ./helpers pero devuelve una LLAVE en vez de un JWT — partner-sync se
 * autentica por `Authorization: Bearer <api-key>`, no por sesión de usuario.
 */
async function makePartnerApiKey(
	caps: string[],
	emailOverride?: string,
): Promise<PartnerAccount> {
	const db = getDb();
	const now = Date.now();
	const roleId = randomUUID();
	await db.insert(schema.roles).values({
		id: roleId,
		name: `test-partner-role-${roleId.slice(0, 8)}`,
		description: "rol de test — partner-sync",
		isSystem: false,
		createdAt: now,
	});
	for (const c of caps) {
		await db
			.insert(schema.roleCapabilities)
			.values({ roleId, capabilityKey: c })
			.onConflictDoNothing();
	}
	const userId = randomUUID();
	const email = (emailOverride ?? `partner-${userId.slice(0, 8)}@test.local`).toLowerCase();
	await db.insert(schema.users).values({
		id: userId,
		email,
		name: "DEMO Partner",
		passwordHash: null,
		roleId,
		status: "active",
		createdAt: now,
	});
	const authUser = {
		id: userId,
		email,
		roleId,
		orgId: null,
		status: "active",
		isSystemAdmin: false,
		isSuperAdmin: false,
	};
	const { apiKey, rawKey } = await createApiKey(
		authUser,
		{
			name: "clave de test — partner-sync",
			scopes: caps,
		},
		colombiaTenantScope(),
	);
	return { rawKey, apiKeyId: apiKey.id, userId, email };
}

/** `source` que el router estampa para un email de socio (ver partnerSource() en el router). */
function partnerSourceFor(email: string): string {
	return `partner:${email.trim().toLowerCase()}`;
}

async function findMissingBySourceAndExternalId(source: string, externalId: string) {
	const rows = await getDb()
		.select()
		.from(schema.missingPersons)
		.where(
			and(
				eq(schema.missingPersons.source, source),
				eq(schema.missingPersons.externalId, externalId),
			),
		);
	return rows[0] ?? null;
}

const ENDPOINT = "/api/public/partner-sync/missing";

describe("partner-sync — POST /api/public/partner-sync/missing", () => {
	it("crea un lote de 2 nuevos bajo source=partner:<email>; re-enviar el mismo lote actualiza, no duplica", async () => {
		const { rawKey, email } = await makePartnerApiKey([CAP]);
		const source = partnerSourceFor(email);
		const tag = randomUUID().slice(0, 8);
		const people = [
			{ externalId: `DEMO-batch-${tag}-1`, name: `DEMO Persona Uno ${tag}`, status: "active" as const },
			{ externalId: `DEMO-batch-${tag}-2`, name: `DEMO Persona Dos ${tag}`, status: "active" as const },
		];

		const first = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({ people });
		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ source, inserted: 2, updated: 0, skipped: 0, errors: 0 });

		for (const p of people) {
			const row = await findMissingBySourceAndExternalId(source, p.externalId);
			expect(row).toBeTruthy();
			expect(row!.name).toBe(p.name);
			expect(row!.externalId).toBe(p.externalId);
		}

		// Re-sync: mismas claves (source, external_id) -> upsert, NO duplica.
		const second = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({ people });
		expect(second.status).toBe(200);
		expect(second.body).toMatchObject({ source, inserted: 0, updated: 2, skipped: 0, errors: 0 });

		for (const p of people) {
			const row = await findMissingBySourceAndExternalId(source, p.externalId);
			expect(row).toBeTruthy();
		}
	});

	it("el `source` del body se ignora (se deriva de la sesión); cada socio escribe solo bajo el suyo", async () => {
		const partnerA = await makePartnerApiKey([CAP]);
		const partnerB = await makePartnerApiKey([CAP]);
		const sourceA = partnerSourceFor(partnerA.email);
		const sourceB = partnerSourceFor(partnerB.email);
		const externalId = `DEMO-ignore-source-${randomUUID().slice(0, 8)}`;

		const spoofedSource = "partner:atacante@evil.example";
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${partnerA.rawKey}`)
			.send({
				people: [
					{
						externalId,
						name: "DEMO Persona Origen Falsificado",
						status: "active",
						// Intento de que el body declare su propio `source`: el router
						// debe ignorarlo por completo (zod ni siquiera lo incluye en el
						// schema, pero el body puede mandarlo igual).
						source: spoofedSource,
					},
				],
			});
		expect(res.status).toBe(200);
		expect(res.body.source).toBe(sourceA);

		const row = await findMissingBySourceAndExternalId(sourceA, externalId);
		expect(row).toBeTruthy();
		const spoofed = await findMissingBySourceAndExternalId(spoofedSource, externalId);
		expect(spoofed).toBeNull();

		// El socio B, con OTRA llave, manda el MISMO externalId — debe caer bajo
		// SU propio source, sin pisar ni leer el registro de A.
		const resB = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${partnerB.rawKey}`)
			.send({ people: [{ externalId, name: "DEMO Persona De B", status: "active" }] });
		expect(resB.status).toBe(200);
		expect(resB.body.source).toBe(sourceB);
		expect(resB.body).toMatchObject({ inserted: 1 });

		const rowB = await findMissingBySourceAndExternalId(sourceB, externalId);
		expect(rowB).toBeTruthy();
		expect(rowB!.name).toBe("DEMO Persona De B");
		const rowAStillThere = await findMissingBySourceAndExternalId(sourceA, externalId);
		expect(rowAStillThere!.name).toBe("DEMO Persona Origen Falsificado");
	});

	it("photoUrl en dominio no permitido se anula; en dominio allowlisteado se guarda", async () => {
		const email = `partner-media-${randomUUID().slice(0, 8)}@test.local`;
		const { rawKey } = await makePartnerApiKey([CAP], email);
		const source = partnerSourceFor(email);

		// El allowlist es de CÓDIGO por diseño (ver config/partner-media-allowlist.ts):
		// para ejercitar la rama "permitido" end-to-end, el test inyecta una
		// entrada temporal para ESTE socio de prueba y la retira al final. No
		// representa cómo se da de alta un socio real — eso es un PR.
		PARTNER_MEDIA_ALLOWLIST[source] = ["cdn.demo-aliado-permitido.example"];
		try {
			const notAllowedId = `DEMO-media-no-${randomUUID().slice(0, 8)}`;
			const allowedId = `DEMO-media-si-${randomUUID().slice(0, 8)}`;

			const res = await request(app)
				.post(ENDPOINT)
				.set("Authorization", `Bearer ${rawKey}`)
				.send({
					people: [
						{
							externalId: notAllowedId,
							name: "DEMO Foto No Permitida",
							status: "active",
							photoUrl: "https://cdn.otro-dominio-no-listado.example/x.jpg",
						},
						{
							externalId: allowedId,
							name: "DEMO Foto Permitida",
							status: "active",
							photoUrl: "https://cdn.demo-aliado-permitido.example/x.jpg",
						},
					],
				});
			expect(res.status).toBe(200);
			expect(res.body.inserted).toBe(2);

			const notAllowedRow = await findMissingBySourceAndExternalId(source, notAllowedId);
			expect(notAllowedRow).toBeTruthy();
			expect(notAllowedRow!.photoExternalUrl).toBeNull();

			const allowedRow = await findMissingBySourceAndExternalId(source, allowedId);
			expect(allowedRow).toBeTruthy();
			expect(allowedRow!.photoExternalUrl).toBe("https://cdn.demo-aliado-permitido.example/x.jpg");
		} finally {
			PARTNER_MEDIA_ALLOWLIST[source] = [];
		}
	});

	it("un subdominio del host permitido pasa; un host que solo COMPARTE substring no", async () => {
		const email = `partner-subdomain-${randomUUID().slice(0, 8)}@test.local`;
		const { rawKey } = await makePartnerApiKey([CAP], email);
		const source = partnerSourceFor(email);
		PARTNER_MEDIA_ALLOWLIST[source] = ["aliado.example"];
		try {
			const subId = `DEMO-sub-${randomUUID().slice(0, 8)}`;
			const substrId = `DEMO-substr-${randomUUID().slice(0, 8)}`;
			const res = await request(app)
				.post(ENDPOINT)
				.set("Authorization", `Bearer ${rawKey}`)
				.send({
					people: [
						{
							externalId: subId,
							name: "DEMO Subdominio Permitido",
							status: "active",
							photoUrl: "https://fotos.aliado.example/a.jpg",
						},
						{
							externalId: substrId,
							name: "DEMO Substring No Permitido",
							status: "active",
							// "notaliado.example" CONTIENE "aliado.example" como substring
							// (notaliado.example.includes("aliado.example") === true) pero
							// NO es "aliado.example" ni un subdominio suyo. Un match por
							// substring dejaría pasar esto; el match debe ser por límite de
							// subdominio (endsWith(".aliado.example")), que aquí es falso.
							photoUrl: "https://notaliado.example/a.jpg",
						},
					],
				});
			expect(res.status).toBe(200);

			const subRow = await findMissingBySourceAndExternalId(source, subId);
			expect(subRow!.photoExternalUrl).toBe("https://fotos.aliado.example/a.jpg");

			const substrRow = await findMissingBySourceAndExternalId(source, substrId);
			expect(substrRow!.photoExternalUrl).toBeNull();
		} finally {
			PARTNER_MEDIA_ALLOWLIST[source] = [];
		}
	});

	// NOTA sobre el status esperado: el packet original de este unit pedía 422
	// para estos dos casos. El middleware `validate()` compartido de este repo
	// (backend/src/middleware/index.ts) traduce TODO fallo de zod a
	// `badRequest` -> 400, sin excepción, y ese middleware NO está en el
	// alcance de este unit (no se toca `src/middleware/*`). No hay un solo uso
	// de 422 en todo el backend (`grep -rn "422" backend/src` = vacío) — usar
	// 422 aquí exigiría desviarse del middleware compartido de validación que
	// usan TODOS los demás routers, o forzar el status a mano en este router
	// (rompiendo "mantén la forma del router exacta"). Se documenta el 400
	// real en vez del 422 del packet.
	it("lote de 51 -> 400 (tope de batch, ver nota de status arriba)", async () => {
		const { rawKey } = await makePartnerApiKey([CAP]);
		const people = Array.from({ length: 51 }, (_, i) => ({
			externalId: `DEMO-cap-${randomUUID().slice(0, 8)}-${i}`,
			name: `DEMO Persona ${i}`,
			status: "active" as const,
		}));
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({ people });
		expect(res.status).toBe(400);
	});

	it("falta externalId -> 400 (ver nota de status arriba)", async () => {
		const { rawKey } = await makePartnerApiKey([CAP]);
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({ people: [{ name: "DEMO Sin Id", status: "active" }] });
		expect(res.status).toBe(400);
	});

	it("llave sin missing:create -> 403", async () => {
		const { rawKey } = await makePartnerApiKey(["patient:read"]);
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({ people: [{ externalId: `DEMO-403-${randomUUID().slice(0, 8)}`, name: "DEMO Sin Permiso", status: "active" }] });
		expect(res.status).toBe(403);
	});

	it("llave revocada -> 401", async () => {
		const { rawKey, apiKeyId, userId } = await makePartnerApiKey([CAP]);
		await revokeApiKey(apiKeyId, userId);
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({ people: [{ externalId: `DEMO-401-${randomUUID().slice(0, 8)}`, name: "DEMO Revocada", status: "active" }] });
		expect(res.status).toBe(401);
	});

	it("llave inválida (no existe) -> 401", async () => {
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", "Bearer mer_sk_esto-no-existe-en-la-base")
			.send({ people: [{ externalId: `DEMO-401b-${randomUUID().slice(0, 8)}`, name: "DEMO Invalida", status: "active" }] });
		expect(res.status).toBe(401);
	});

	it("sin Authorization -> 401", async () => {
		const res = await request(app)
			.post(ENDPOINT)
			.send({ people: [{ externalId: `DEMO-401c-${randomUUID().slice(0, 8)}`, name: "DEMO Sin Auth", status: "active" }] });
		expect(res.status).toBe(401);
	});

	it("un registro suprimido (source, external_id) no resucita (kill-switch R27)", async () => {
		const { rawKey, email } = await makePartnerApiKey([CAP]);
		const source = partnerSourceFor(email);
		const externalId = `DEMO-suppressed-${randomUUID().slice(0, 8)}`;
		const payload = {
			people: [{ externalId, name: "DEMO Persona Suprimida", status: "active" as const }],
		};

		const created = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send(payload);
		expect(created.status).toBe(200);
		const row = await findMissingBySourceAndExternalId(source, externalId);
		expect(row).toBeTruthy();

		// Un admin borra la ficha -> removeMissing() crea la fila de supresión
		// (source, external_id) — mismo camino que usa el panel admin.
		expect(await missingService.removeMissing(row!.id)).toBe(true);
		const suppression = await getDb()
			.select()
			.from(schema.missingPersonSuppressions)
			.where(eq(schema.missingPersonSuppressions.legacyId, row!.id));
		expect(suppression).toHaveLength(1);

		// El socio re-sincroniza el MISMO registro (su sistema no sabe que se
		// suprimió del lado nuestro) -> debe quedarse suprimido, no resucitar.
		const resynced = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send(payload);
		expect(resynced.status).toBe(200);
		expect(resynced.body).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });

		const rowAfter = await findMissingBySourceAndExternalId(source, externalId);
		expect(rowAfter).toBeNull();
	});

	it("escribe el audit partner_sync.missing.upsert con conteos y sin PII de la persona", async () => {
		const { rawKey, userId, email } = await makePartnerApiKey([CAP]);
		const source = partnerSourceFor(email);
		const personName = `DEMO Auditoria ${randomUUID().slice(0, 8)}`;
		const res = await request(app)
			.post(ENDPOINT)
			.set("Authorization", `Bearer ${rawKey}`)
			.send({
				people: [
					{
						externalId: `DEMO-audit-${randomUUID().slice(0, 8)}`,
						name: personName,
						status: "active",
					},
				],
			});
		expect(res.status).toBe(200);

		const rows = await getDb()
			.select()
			.from(schema.auditLog)
			.where(eq(schema.auditLog.action, "partner_sync.missing.upsert"))
			.orderBy(desc(schema.auditLog.createdAt))
			.limit(20);
		const entry = rows.find((r) => r.actorUserId === userId);
		expect(entry).toBeTruthy();
		expect(entry!.targetType).toBe("missing_person");
		expect(entry!.targetId).toBe(source);

		const metadata = entry!.metadata as Record<string, unknown>;
		expect(metadata).toMatchObject({
			source,
			sent: 1,
			inserted: 1,
			updated: 0,
			skipped: 0,
			errors: 0,
			mediaDropped: 0,
		});
		expectNoSensitiveFields(metadata);
		// El nombre/descripción de la persona NUNCA debe terminar en el audit.
		expect(JSON.stringify(metadata)).not.toContain(personName);
	});
});

describe("partner-media-allowlist — unidad (sin DB, sin HTTP)", () => {
	it("socio sin entrada en el allowlist -> null (caso por defecto)", () => {
		expect(allowedPartnerMediaUrl("partner:sin-entrada@test.local", "https://cualquier.example/x.jpg")).toBeNull();
	});

	it("socio con lista vacía -> null", () => {
		const source = `unit-test:empty-${randomUUID().slice(0, 6)}`;
		PARTNER_MEDIA_ALLOWLIST[source] = [];
		try {
			expect(allowedPartnerMediaUrl(source, "https://aliado.example/x.jpg")).toBeNull();
		} finally {
			PARTNER_MEDIA_ALLOWLIST[source] = [];
		}
	});

	it("hostname EXACTO -> se conserva la URL", () => {
		const source = `unit-test:exact-${randomUUID().slice(0, 6)}`;
		PARTNER_MEDIA_ALLOWLIST[source] = ["aliado.example"];
		try {
			expect(allowedPartnerMediaUrl(source, "https://aliado.example/x.jpg")).toBe(
				"https://aliado.example/x.jpg",
			);
		} finally {
			PARTNER_MEDIA_ALLOWLIST[source] = [];
		}
	});

	it("subdominio limpio -> se conserva; substring sin límite de subdominio -> null", () => {
		const source = `unit-test:sub-${randomUUID().slice(0, 6)}`;
		PARTNER_MEDIA_ALLOWLIST[source] = ["aliado.example"];
		try {
			expect(allowedPartnerMediaUrl(source, "https://cdn.aliado.example/x.jpg")).toBe(
				"https://cdn.aliado.example/x.jpg",
			);
			expect(allowedPartnerMediaUrl(source, "https://notaliado.example/x.jpg")).toBeNull();
			expect(allowedPartnerMediaUrl(source, "https://aliado.example.evil.net/x.jpg")).toBeNull();
		} finally {
			PARTNER_MEDIA_ALLOWLIST[source] = [];
		}
	});

	it("null/undefined/URL inválida/esquema no-http -> null, nunca lanza", () => {
		const source = `unit-test:invalid-${randomUUID().slice(0, 6)}`;
		PARTNER_MEDIA_ALLOWLIST[source] = ["aliado.example"];
		try {
			expect(allowedPartnerMediaUrl(source, null)).toBeNull();
			expect(allowedPartnerMediaUrl(source, undefined)).toBeNull();
			expect(allowedPartnerMediaUrl(source, "no-es-una-url")).toBeNull();
			expect(allowedPartnerMediaUrl(source, "javascript:alert(1)//aliado.example")).toBeNull();
			expect(allowedPartnerMediaUrl(source, "ftp://aliado.example/x.jpg")).toBeNull();
		} finally {
			PARTNER_MEDIA_ALLOWLIST[source] = [];
		}
	});
});
