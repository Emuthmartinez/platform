/**
 * Drizzle schema — the single source of truth for the database.
 *
 * This MIRRORS the schema currently created lazily (CREATE TABLE IF NOT EXISTS)
 * across lib/*.ts. The goal of moving it here: make the schema explicit,
 * versioned and reviewable, and let `drizzle-kit` generate real migration
 * files (which the gated migrate Job in infra/k8s/ then applies) instead of
 * relying on scattered runtime DDL.
 *
 * Conventions captured from the existing code:
 *   - String IDs: `id TEXT PRIMARY KEY` (app generates crypto.randomUUID()).
 *   - Timestamps are epoch-MILLISECONDS stored as BIGINT (bigint mode:"number"
 *     — values stay within Number.MAX_SAFE_INTEGER; lib/db.ts already parses
 *     oid 20 as a JS number for driver parity).
 *   - Coordinates: DOUBLE PRECISION (`doublePrecision`).
 *
 * 16 tables total. The only real relation is hospital_patients -> hospitals.
 * (12 canónicas + contact_messages, analytics_events, damage_candidates,
 * unidentified_persons; estas 4 existen en prod aunque parte sean legado.)
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  doublePrecision,
  boolean,
  bigserial,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  AnyPgColumn,
} from "drizzle-orm/pg-core";

// epoch-ms timestamp stored as BIGINT, surfaced as a JS number.
const epochMs = (name: string) => bigint(name, { mode: "number" });

/* ----------------------------------------------------------- organizations */
// Accountable operator (KTD23). Seeded first tenant is Mallanet.org.
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: epochMs("created_at").notNull(),
});

/* --------------------------------------------------------------- incidents */
// Operational response period owned by one organization (KTD14, KTD23).
// Unique (organization_id, id) is the FK target for every incident-scoped table.
export const incidents = pgTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [unique("incidents_organization_id_id_unique").on(t.organizationId, t.id)],
);

/* ------------------------------------------------------------- deployments */
// Canonical hostname → organization + active incident (KTD7 lookup source).
// Hostname is stored already canonical: lowercase, no trailing dot.
export const deployments = pgTable(
  "deployments",
  {
    hostname: text("hostname").primaryKey(),
    organizationId: text("organization_id").notNull(),
    incidentId: text("incident_id").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "deployments_incident_ownership_fk",
      columns: [t.organizationId, t.incidentId],
      foreignColumns: [incidents.organizationId, incidents.id],
    }).onDelete("restrict"),
    check(
      "deployments_hostname_canonical",
      sql`${t.hostname} = lower(${t.hostname}) AND right(${t.hostname}, 1) <> '.'`,
    ),
  ],
);

/** Nullable expand columns. U8 tighten sets NOT NULL after backfill. */
export function incidentOwnershipColumns() {
  return {
    organizationId: text("organization_id"),
    incidentId: text("incident_id"),
  };
}

export function incidentOwnershipFk(
  tableName: string,
  t: { organizationId: AnyPgColumn; incidentId: AnyPgColumn },
) {
  return foreignKey({
    name: `${tableName}_incident_ownership_fk`,
    columns: [t.organizationId, t.incidentId],
    foreignColumns: [incidents.organizationId, incidents.id],
  }).onDelete("restrict");
}

/* ------------------------------------------------------------------ reports */
export const reports = pgTable(
  "reports",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    place: text("place").notNull(),
    affected: integer("affected").notNull().default(0),
    needs: text("needs").notNull().default(""),
    photo: text("photo"),
    confirmations: integer("confirmations").notNull().default(0),
    // Atribución opcional: voluntario que reporta (resuelto desde su código
    // único en el route). Nunca se expone en el DTO público del reporte.
    volunteerId: text("volunteer_id").references(() => volunteers.id, {
      onDelete: "set null",
    }),
    createdAt: epochMs("created_at").notNull(),
    // Set when this row's `photo` has been moved off the DB (base64) / external
    // host and onto R2. NULL = not yet migrated. Lets the image-rehost worker
    // claim only un-migrated rows (FOR UPDATE SKIP LOCKED) and be re-runnable.
    photoMigratedAt: epochMs("photo_migrated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_reports_created_at").on(t.createdAt.desc()),
    // Partial index: cheap scan for the rehost worker's "WHERE photo_migrated_at
    // IS NULL AND photo IS NOT NULL" claim query.
    index("idx_reports_photo_pending")
      .on(t.id)
      .where(sql`photo_migrated_at IS NULL AND photo IS NOT NULL`),
    incidentOwnershipFk("reports", t),
  ],
);

export const reportConfirmations = pgTable(
  "report_confirmations",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    ipHash: text("ip_hash").notNull(),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.ipHash] }),
    incidentOwnershipFk("report_confirmations", t),
  ],
);

/* ----------------------------------------------------------- missing_persons */
export const missingPersons = pgTable(
  "missing_persons",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    age: integer("age"),
    nationality: text("nationality").notNull().default(""),
    description: text("description").notNull().default(""),
    lastSeen: text("last_seen").notNull().default(""),
    contact: text("contact").notNull().default(""),
    photo: text("photo"),
    status: text("status").notNull().default("active"),
    resolutionNote: text("resolution_note"),
    resolutionPhoto: text("resolution_photo"),
    resolvedAt: epochMs("resolved_at"),
    externalId: text("external_id"),
    source: text("source"),
    sourceUrl: text("source_url"),
    photoExternalUrl: text("photo_external_url"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    // hashIp(req) del creador anónimo (como contact_messages / donations).
    // Único rastro de responsabilidad del alta pública; NULL en filas previas
    // y en altas de sync externo (allí la procedencia es source/external_id).
    ipHash: text("ip_hash"),
    // Cédula SOLO como huella: tipo + HMAC (mismo secreto y normalización que
    // hospital_patients.document_hash, así los hashes son joinables). El número
    // crudo jamás se guarda. SIN índice único a propósito: dos reportes con la
    // misma cédula son señal legítima de duplicado (propuesta del matcher),
    // no un conflicto. tipo ∈ {CC,TI,CE,PA,RC,NUIP,sin_documento}.
    tipoDocumento: text("tipo_documento"),
    documentHash: text("document_hash"),
    createdAt: epochMs("created_at").notNull(),
    // See reports.photoMigratedAt. Covers BOTH base64 `photo` and external
    // `photo_external_url` being moved onto R2. NULL = pending.
    photoMigratedAt: epochMs("photo_migrated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_missing_status_created").on(t.status, t.createdAt.desc()),
    index("idx_missing_map_coords").on(t.lat, t.lng),
    index("idx_missing_photo_pending")
      .on(t.id)
      .where(
        sql`photo_migrated_at IS NULL AND (photo IS NOT NULL OR photo_external_url IS NOT NULL)`,
      ),
    uniqueIndex("missing_persons_source_external_id_idx")
      .on(t.source, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("idx_missing_document_hash")
      .on(t.documentHash)
      .where(sql`document_hash IS NOT NULL`),
    incidentOwnershipFk("missing_persons", t),
  ],
);

export const missingPersonSuppressions = pgTable(
  "missing_person_suppressions",
  {
    legacyId: text("legacy_id").primaryKey(),
    source: text("source"),
    externalId: text("external_id"),
    reason: text("reason").notNull(),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("missing_person_suppressions_source_external_idx")
      .on(t.source, t.externalId)
      .where(sql`source IS NOT NULL AND external_id IS NOT NULL`),
    incidentOwnershipFk("missing_person_suppressions", t),
  ],
);

/* ------------------------------------------------ official_deceased_lists */
/**
 * Official lists of confirmed deceased people are separate from hospitals and
 * from citizen missing-person reports. This separation prevents a forensic
 * source from increasing hospital patient counts or missing-person totals.
 *
 * The source URL is the stable import identity. The application derives the
 * row IDs from this list ID and the normalized row content, so a retry is
 * idempotent without an interactive transaction.
 */
export const officialDeceasedLists = pgTable(
  "official_deceased_lists",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url").notNull(),
    publishedAt: epochMs("published_at"),
    createdBy: text("created_by"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_official_deceased_lists_source_url").on(t.sourceUrl),
    incidentOwnershipFk("official_deceased_lists", t),
  ],
);

export const officialDeceasedRecords = pgTable(
  "official_deceased_records",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => officialDeceasedLists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    age: integer("age"),
    location: text("location").notNull().default(""),
    description: text("description").notNull().default(""),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_official_deceased_records_list").on(t.listId, t.createdAt.desc()),
    index("idx_official_deceased_records_name").on(t.name),
    incidentOwnershipFk("official_deceased_records", t),
  ],
);

/* -------------------------------------------------------------- missing_pets */
/**
 * Mascotas desaparecidas o encontradas. TABLA APARTE de `missing_persons`, no una
 * columna discriminadora en ella. La razón NO es estética:
 *
 *  1. El conteo público de personas desaparecidas no puede incluir animales
 *     jamás. Con dos tablas eso es imposible POR CONSTRUCCIÓN — ninguna consulta
 *     de personas puede devolver una mascota aunque alguien olvide un WHERE.
 *  2. Los despliegues aquí no son atómicos ni ordenados: la migración la corre
 *     una persona a mano y el deploy del backend es otro botón manual (ver
 *     CLAUDE.md). Una tabla nueva es INERTE hasta que hay código que la lee, así
 *     que cualquier orden de despliegue degrada bien. Una columna `kind` nueva en
 *     `missing_persons` tendría un orden letal: backend con `WHERE kind='person'`
 *     desplegado ANTES de la migración rompe TODAS las consultas de personas en
 *     un sitio que la gente usa para buscar a su familia.
 *
 * A propósito NO replica la maquinaria de `missing_persons`: sin `source`/
 * `external_id` (no hay feeds externos de mascotas), sin tabla de supresiones,
 * sin federación de hub y sin índice parcial para el worker de rehost de fotos.
 * Es CRUD y nada más. Si algún día aparece un feed real de mascotas, eso se
 * diseña entonces, no se copia ahora "por si acaso".
 */
export const missingPets = pgTable(
  "missing_pets",
  {
    id: text("id").primaryKey(),
    // Puede ir vacío: quien ENCUENTRA un animal casi nunca sabe su nombre. La UI
    // muestra "Sin nombre" en ese caso, en vez de obligar a inventar uno.
    name: text("name").notNull().default(""),
    species: text("species").notNull().default(""),
    breed: text("breed").notNull().default(""),
    color: text("color").notNull().default(""),
    sex: text("sex"),
    /** Edad en años. Misma semántica que missing_persons.age. */
    age: integer("age"),
    description: text("description").notNull().default(""),
    lastSeen: text("last_seen").notNull().default(""),
    contact: text("contact").notNull().default(""),
    /**
     * Número de microchip. NUNCA se serializa al cliente — el DTO solo expone
     * `hasMicrochip`. Publicarlo permitiría a un tercero "demostrar" que la
     * mascota es suya citando el número del propio anuncio; guardándolo pero sin
     * mostrarlo sigue sirviendo para verificar a quien la reclama.
     */
    microchip: text("microchip"),
    photo: text("photo"),
    status: text("status").notNull().default("active"),
    resolutionNote: text("resolution_note"),
    resolutionPhoto: text("resolution_photo"),
    resolvedAt: epochMs("resolved_at"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    createdAt: epochMs("created_at").notNull(),
    /**
     * Se rellena cuando `persistPhotoDataUrl` sube la foto a R2. Aquí es
     * informativo: a diferencia de missing_persons NO hay índice parcial ni
     * worker que reclame filas pendientes (ver cabecera).
     */
    photoMigratedAt: epochMs("photo_migrated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_pets_status_created").on(t.status, t.createdAt.desc()),
    index("idx_pets_map_coords").on(t.lat, t.lng),
    incidentOwnershipFk("missing_pets", t),
  ],
);

/* ------------------------------------------------------------- chat_messages */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default("Anónimo"),
    role: text("role").notNull().default("ciudadano"),
    text: text("text").notNull(),
    replyTo: text("reply_to"),
    replyPreview: text("reply_preview"),
    threadRootId: text("thread_root_id"),
    // Nullable en prod: filas antiguas se rellenan con UPDATE en lib/chat.ts.
    threadBumpedAt: epochMs("thread_bumped_at"),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
    // Nota: prod conserva 3 columnas legado (reply_to_id/name/text) ya en
    // desuso (sustituidas por reply_to/reply_preview). Se omiten a propósito.
  },
  (t) => [
    index("idx_chat_thread_bumped").on(t.threadBumpedAt.desc()),
    index("idx_chat_reply").on(t.replyTo),
    incidentOwnershipFk("chat_messages", t),
  ],
);

/* ----------------------------------------------------------------- hospitals */
export const hospitals = pgTable(
  "hospitals",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id"),
    name: text("name").notNull(),
    facilityType: text("facility_type").notNull().default("hospital"),
    state: text("state").notNull().default(""),
    municipality: text("municipality").notNull().default(""),
    address: text("address").notNull().default(""),
    level: text("level"),
    priorityZone: text("priority_zone").notNull().default("P3"),
    isPriority: boolean("is_priority").notNull().default(false),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    // Partial unique index: external_id unique WHERE NOT NULL.
    uniqueIndex("idx_hospitals_external")
      .on(t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("idx_hospitals_state").on(t.state, t.priorityZone, t.name),
    incidentOwnershipFk("hospitals", t),
  ],
);

export const hospitalPatients = pgTable(
  "hospital_patients",
  {
    id: text("id").primaryKey(),
    hospitalId: text("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    age: integer("age"),
    condition: text("condition").notNull().default("unknown"),
    status: text("status").notNull().default("hospitalized"),
    notes: text("notes").notNull().default(""),
    contact: text("contact").notNull().default(""),
    // HMAC del documento/cédula normalizado. Permite dedup exacta sin guardar el
    // documento crudo en la tabla final.
    documentHash: text("document_hash"),
    admittedAt: epochMs("admitted_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_hospital_patients_hospital").on(
      t.hospitalId,
      t.status,
      t.admittedAt.desc(),
    ),
    index("idx_hospital_patients_document_hash")
      .on(t.hospitalId, t.documentHash)
      .where(sql`document_hash IS NOT NULL`),
    uniqueIndex("idx_hospital_patients_document_hash_unique")
      .on(t.documentHash)
      .where(sql`document_hash IS NOT NULL`),
    incidentOwnershipFk("hospital_patients", t),
  ],
);

/* --------------------------------------------------------- patient_imports */
// Staging para la importación autenticada de pacientes hospitalarios (#151).
// Un `patient_imports` = un lote subido por una integración/admin; sus filas
// (`patient_import_rows`) pasan por normalización → validación → deduplicación
// en el worker ANTES de escribirse en `hospital_patients` (apply idempotente).
// La cabecera lleva solo contadores + estado + procedencia (sin PII de paciente).
export const patientImports = pgTable(
  "patient_imports",
  {
    id: text("id").primaryKey(),
    // pending → queued → processing → processed → applying → applied | failed
    status: text("status").notNull().default("pending"),
    // Etapa que produjo `failed` (process|apply). Permite reanudar solo fallos de
    // apply parcial sin re-aplicar staging posiblemente incompleto de process.
    failedStage: text("failed_stage"),
    // Etiqueta DECLARADA del origen del lote (no es PII, no es confiable, no es
    // autoría). La declara el cliente; la autoría verificada es `created_by`. No
    // usar para auth/dedup. Ver docs/rfcs/0007-procedencia-ingesta-pacientes.md.
    source: text("source").notNull().default("api"),
    // Identificador del registro/lote en el sistema de origen declarado. No es
    // autoridad de identidad: solo trazabilidad/provenance del lote.
    sourceRecordId: text("source_record_id"),
    // Integración/canal declarado por quien sube el lote (p.ej. api-key, hospital,
    // telegram, csv-manual). No reemplaza `created_by` ni se usa para permisos.
    integration: text("integration"),
    // Formato del payload de entrada. JSON se materializa directo; CSV/XLSX se
    // parsea en el worker; imagen OCR se extrae en el worker y queda en revisión.
    contentType: text("content_type").notNull().default("application/json"),
    // Contexto OCR persistido en el ingest (antes se descartaba): sin esto,
    // ocr_corrections no tiene provider/prompt que copiar y el editor de filas
    // no tiene imagen que mostrar. NULL en lotes no-OCR.
    ocrProvider: text("ocr_provider"),
    ocrPromptVersion: text("ocr_prompt_version"),
    sourceImageUrl: text("source_image_url"),
    // jobId de BullMQ del último job (process/apply) para trazabilidad.
    jobId: text("job_id"),
    // Hash SHA-256 del header Idempotency-Key. No guardamos la key cruda; el
    // índice único scoped evita duplicar lotes por retry del mismo usuario.
    idempotencyKeyHash: text("idempotency_key_hash"),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    invalidRows: integer("invalid_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    reviewRows: integer("review_rows").notNull().default(0),
    appliedRows: integer("applied_rows").notNull().default(0),
    // AUTORÍA VERIFICADA: user.id que creó el lote, derivado de req.user en el
    // route (NO del body) → no spoofeable. (NULL = sistema). No es PII de paciente.
    createdBy: text("created_by"),
    // Resumen de error legible (NUNCA stack traces ni PII).
    errorSummary: text("error_summary"),
    createdAt: epochMs("created_at").notNull(),
    processedAt: epochMs("processed_at"),
    appliedAt: epochMs("applied_at"),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_patient_imports_status").on(t.status, t.createdAt.desc()),
    uniqueIndex("idx_patient_imports_actor_idempotency")
      .on(t.createdBy, t.idempotencyKeyHash)
      .where(sql`idempotency_key_hash IS NOT NULL`),
    incidentOwnershipFk("patient_imports", t),
  ],
);

// Una fila staging por paciente del lote. Guarda el dato CRUDO (restringido, en
// jsonb) + los campos normalizados + el resultado de validación/dedup. El dato
// crudo y los campos sensibles (cédula/documento, notas, contacto) NUNCA se
// exponen en respuestas públicas/de baja confianza — solo el estado y los
// errores/avisos de revisión.
export const patientImportRows = pgTable(
  "patient_import_rows",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => patientImports.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    // Texto crudo del hospital tal como vino en el input (para resolverlo).
    sourceHospital: text("source_hospital").notNull().default(""),
    // Hospital resuelto (FK lógica a hospitals.id; NULL = no resoluble todavía).
    hospitalId: text("hospital_id"),
    // Nombre normalizado (trim/colapso de espacios).
    name: text("name").notNull().default(""),
    // Clave de bloqueo para dedup: nombre en minúsculas, sin acentos ni signos.
    normalizedKey: text("normalized_key").notNull().default(""),
    age: integer("age"),
    condition: text("condition"),
    status: text("status"),
    // Dato CRUDO de entrada + campos sensibles (documento/notas/contacto).
    // RESTRINGIDO: no se serializa hacia respuestas públicas.
    rawData: jsonb("raw_data").notNull().default({}),
    // HMAC del documento/cédula normalizado. El crudo queda solo en raw_data.
    documentHash: text("document_hash"),
    validationErrors: jsonb("validation_errors").notNull().default([]),
    validationWarnings: jsonb("validation_warnings").notNull().default([]),
    // pending | unique | duplicate | needs_review
    dedupStatus: text("dedup_status").notNull().default("pending"),
    // Candidatos de duplicado (allowlist: patientId + name + reason). Sin PII extra.
    dedupCandidates: jsonb("dedup_candidates").notNull().default([]),
    confidence: doublePrecision("confidence").notNull().default(0),
    // pending | valid | invalid | duplicate | needs_review | applied | skipped
    rowStatus: text("row_status").notNull().default("pending"),
    // hospital_patients.id final tras el apply (idempotencia: set = ya aplicada).
    patientId: text("patient_id"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_patient_import_rows_import").on(t.importId, t.rowIndex),
    index("idx_patient_import_rows_status").on(t.importId, t.rowStatus),
    incidentOwnershipFk("patient_import_rows", t),
  ],
);

/* ---------------------------------------------------------- ocr_corrections */
// Log INMUTABLE de correcciones humanas sobre filas OCR: cada edición de un
// campo extraído por OCR guarda el par (valor del modelo, valor corregido).
// Es el activo de aprendizaje de la Fase 3 (eval sets, few-shot por layout) —
// no hay path de UPDATE y no hay FK a las filas staging a propósito: el log
// sobrevive a la limpieza de lotes. `id` es determinista (hash de fila+campo+
// valores+updated_at previo) con ON CONFLICT DO NOTHING: un retry del mismo
// PATCH colapsa a una fila; una re-edición posterior real es otro evento.
export const ocrCorrections = pgTable(
  "ocr_corrections",
  {
    id: text("id").primaryKey(),
    importRowId: text("import_row_id").notNull(),
    field: text("field").notNull(),
    modelValue: text("model_value").notNull().default(""),
    correctedValue: text("corrected_value").notNull().default(""),
    // Referencia R2 del documento fuente (para re-evaluar la corrección).
    documentR2Key: text("document_r2_key"),
    // Cluster de layout (Fase 3). NULL hasta que exista el fingerprinting.
    layoutClusterId: text("layout_cluster_id"),
    provider: text("provider").notNull().default(""),
    promptVersion: text("prompt_version").notNull().default(""),
    // users.id del revisor. Atribución obligatoria (es una decisión humana).
    correctedBy: text("corrected_by").notNull(),
    correctedAt: epochMs("corrected_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_ocr_corrections_row").on(t.importRowId),
    incidentOwnershipFk("ocr_corrections", t),
  ],
);

/* ------------------------------------------------------- hospital_supplies */
export const hospitalSupplyStatuses = pgTable(
  "hospital_supply_statuses",
  {
    id: text("id").primaryKey(),
    hospitalId: text("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    status: text("status").notNull().default("unknown"),
    publicNote: text("public_note").notNull().default(""),
    restrictedNote: text("restricted_note").notNull().default(""),
    staleAfterHours: integer("stale_after_hours").notNull().default(12),
    lastUpdatedAt: epochMs("last_updated_at").notNull(),
    lastConfirmedAt: epochMs("last_confirmed_at").notNull(),
    updatedBy: text("updated_by").notNull().default("equipo_operativo"),
    source: text("source").notNull().default("admin_panel"),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_hospital_supply_status_unique").on(
      t.hospitalId,
      t.category,
    ),
    index("idx_hospital_supply_status_stale").on(
      t.category,
      t.status,
      t.lastConfirmedAt,
    ),
    index("idx_hospital_supply_status_hospital").on(t.hospitalId),
    incidentOwnershipFk("hospital_supply_statuses", t),
  ],
);

export const hospitalSupplyNeeds = pgTable(
  "hospital_supply_needs",
  {
    id: text("id").primaryKey(),
    hospitalId: text("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    itemType: text("item_type").notNull(),
    quantity: integer("quantity"),
    unit: text("unit").notNull().default(""),
    urgency: text("urgency").notNull().default("yellow"),
    status: text("status").notNull().default("active"),
    publicNote: text("public_note").notNull().default(""),
    restrictedNote: text("restricted_note").notNull().default(""),
    lastConfirmedAt: epochMs("last_confirmed_at").notNull(),
    updatedBy: text("updated_by").notNull().default("equipo_operativo"),
    source: text("source").notNull().default("admin_panel"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_hospital_supply_needs_active").on(
      t.hospitalId,
      t.status,
      t.urgency,
      t.updatedAt.desc(),
    ),
    index("idx_hospital_supply_needs_category").on(t.category, t.status),
    incidentOwnershipFk("hospital_supply_needs", t),
  ],
);

export const hospitalSupplyHelpRequests = pgTable(
  "hospital_supply_help_requests",
  {
    id: text("id").primaryKey(),
    hospitalId: text("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    message: text("message").notNull().default(""),
    urgency: text("urgency").notNull().default("yellow"),
    status: text("status").notNull().default("open"),
    requestedBy: text("requested_by").notNull().default("poc_hospitalario"),
    source: text("source").notNull().default("admin_panel"),
    restrictedNote: text("restricted_note").notNull().default(""),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_hospital_supply_help_open").on(
      t.status,
      t.urgency,
      t.createdAt.desc(),
    ),
    index("idx_hospital_supply_help_hospital").on(t.hospitalId),
    incidentOwnershipFk("hospital_supply_help_requests", t),
  ],
);

export const hospitalPocAssignments = pgTable(
  "hospital_poc_assignments",
  {
    id: text("id").primaryKey(),
    hospitalId: text("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull().default("POC hospitalario"),
    role: text("role").notNull().default("hospital_poc"),
    restrictedContact: text("restricted_contact").notNull().default(""),
    accessTokenHash: text("access_token_hash").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_hospital_poc_assignments_hospital").on(t.hospitalId, t.active),
    index("idx_hospital_poc_assignments_token").on(
      t.hospitalId,
      t.accessTokenHash,
      t.active,
    ),
    incidentOwnershipFk("hospital_poc_assignments", t),
  ],
);

export const hospitalSupplyEvents = pgTable(
  "hospital_supply_events",
  {
    id: text("id").primaryKey(),
    hospitalId: text("hospital_id")
      .notNull()
      .references(() => hospitals.id, { onDelete: "cascade" }),
    category: text("category"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    action: text("action").notNull(),
    actor: text("actor").notNull().default("equipo_operativo"),
    source: text("source").notNull().default("admin_panel"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_hospital_supply_events_hospital").on(
      t.hospitalId,
      t.createdAt.desc(),
    ),
    index("idx_hospital_supply_events_entity").on(t.entityType, t.entityId),
    incidentOwnershipFk("hospital_supply_events", t),
  ],
);

/* ----------------------------------------------------------------- donations */
export const donations = pgTable(
  "donations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    amountUsd: integer("amount_usd").notNull(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: epochMs("created_at").notNull(),
    // Ciclo de vida de la donación. Hoy la app nunca lo muta (insert-only), por
    // eso worker/tables.ts la trata como append-only ("ignore").
    status: text("status").notNull().default("intent"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("donations_created_at_idx").on(t.createdAt.desc()),
    incidentOwnershipFk("donations", t),
  ],
);

/* ------------------------------------------------------------ click_counters */
export const clickCounters = pgTable(
  "click_counters",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    ...incidentOwnershipColumns(),
  },
  (t) => [incidentOwnershipFk("click_counters", t)],
);

export const clickCounterDedup = pgTable(
  "click_counter_dedup",
  {
    counterKey: text("counter_key").notNull(),
    ipHash: text("ip_hash").notNull(),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.counterKey, t.ipHash] }),
    incidentOwnershipFk("click_counter_dedup", t),
  ],
);

/* ------------------------------------------------------------- geocode_cache */
export const geocodeCache = pgTable("geocode_cache", {
  normalizedKey: text("normalized_key").primaryKey(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  label: text("label").notNull().default(""),
  updatedAt: epochMs("updated_at").notNull(),
});

/* ----------------------------------------------------------- sync_state/runs */
export const syncState = pgTable("sync_state", {
  source: text("source").primaryKey(),
  nextPage: integer("next_page").notNull().default(1),
  totalPages: integer("total_pages"),
  lastRunAt: epochMs("last_run_at"),
  lastCycleCompletedAt: epochMs("last_cycle_completed_at"),
  updatedAt: epochMs("updated_at").notNull(),
});

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    source: text("source").notNull(),
    trigger: text("trigger"),
    ok: boolean("ok").notNull(),
    fetched: integer("fetched").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    fromPage: integer("from_page"),
    toPage: integer("to_page"),
    nextPage: integer("next_page"),
    cycleCompleted: boolean("cycle_completed"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: epochMs("started_at").notNull(),
    finishedAt: epochMs("finished_at").notNull(),
  },
  (t) => [index("idx_sync_runs_started").on(t.startedAt.desc())],
);

/* ----------------------------------------------------- contact_messages */
// Bandeja de contacto del panel admin. La DDL viva está en
// lib/contact-inbox.ts (CREATE TABLE IF NOT EXISTS); se refleja aquí para
// centralizar el esquema.
export const contactMessages = pgTable(
  "contact_messages",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    read: boolean("read").notNull().default(false),
    ipHash: text("ip_hash"),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("contact_messages_created_at_idx").on(t.createdAt.desc()),
    index("contact_messages_unread_idx").on(t.read, t.createdAt.desc()),
    incidentOwnershipFk("contact_messages", t),
  ],
);

/* ----------------------------------------------------- volunteers */
// Voluntarios registrados desde /voluntario. Contexto humanitario:
// `ip_hash` es un HASH (hashIp()), NUNCA la IP cruda — solo para
// rate-limit/anti-abuso, no identifica a la persona por sí solo.
export const volunteers = pgTable(
  "volunteers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    contact: text("contact").notNull(),
    // Código único de 6 dígitos: lo conoce el voluntario (se muestra una vez
    // al registrarse) y el equipo. Credencial para check-ins y atribución.
    code: text("code").notNull(),
    offer: text("offer").notNull(),
    zone: text("zone").notNull(),
    availability: text("availability"),
    offerTypes: jsonb("offer_types").$type<string[]>(),
    digitalSkills: jsonb("digital_skills").$type<string[]>(),
    crisisExperience: boolean("crisis_experience"),
    fieldCity: text("field_city"),
    rescueTraining: boolean("rescue_training"),
    fieldRole: text("field_role"),
    ownVehicle: boolean("own_vehicle"),
    // De dónde llegó el registro: utm:*, referrer externo o "directo".
    source: text("source"),
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
    ipHash: text("ip_hash"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("volunteers_created_at_idx").on(t.createdAt.desc()),
    index("volunteers_status_idx").on(t.status, t.createdAt.desc()),
    uniqueIndex("volunteers_code_unique").on(t.code),
    incidentOwnershipFk("volunteers", t),
  ],
);

/* -------------------------------------------------- volunteer_checkins */
// Check-in de voluntario en un punto físico (centro de acopio, refugio):
// qué dejó (caja/espacio) + foto de evidencia. La credencial es el código
// único del voluntario (volunteers.code), verificado en el route.
export const volunteerCheckins = pgTable(
  "volunteer_checkins",
  {
    id: text("id").primaryKey(),
    volunteerId: text("volunteer_id")
      .notNull()
      .references(() => volunteers.id, { onDelete: "cascade" }),
    place: text("place").notNull(),
    note: text("note").notNull().default(""),
    photo: text("photo"),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("volunteer_checkins_volunteer_idx").on(t.volunteerId, t.createdAt.desc()),
    index("volunteer_checkins_created_at_idx").on(t.createdAt.desc()),
    incidentOwnershipFk("volunteer_checkins", t),
  ],
);

/* ----------------------------------------------------- volunteer_tasks */
// Tareas que el equipo crea en el panel y asigna a voluntarios por email
// (flujo "hombre del medio": recoger en un punto físico y entregar en otro).
// Los puntos son opcionales: una tarea digital no tiene traslado.
export const volunteerTasks = pgTable(
  "volunteer_tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").notNull().default("terreno"), // digital | terreno
    city: text("city"),
    originName: text("origin_name"),
    originLat: doublePrecision("origin_lat"),
    originLng: doublePrecision("origin_lng"),
    destName: text("dest_name"),
    destLat: doublePrecision("dest_lat"),
    destLng: doublePrecision("dest_lng"),
    transportNote: text("transport_note"),
    status: text("status").notNull().default("open"), // open | assigned | done | cancelled
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("volunteer_tasks_status_idx").on(t.status, t.createdAt.desc()),
    incidentOwnershipFk("volunteer_tasks", t),
  ],
);

/* ----------------------------------------------------- volunteer_assignments */
// Asignación tarea↔voluntario. El `token` es la credencial del link del
// correo (sin cuentas): quien lo tiene ve y responde SU asignación.
export const volunteerAssignments = pgTable(
  "volunteer_assignments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    volunteerId: text("volunteer_id").notNull(),
    token: text("token").notNull().unique(),
    status: text("status").notNull().default("offered"), // offered | accepted | done | declined
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("volunteer_assignments_task_idx").on(t.taskId),
    index("volunteer_assignments_volunteer_idx").on(t.volunteerId),
    incidentOwnershipFk("volunteer_assignments", t),
  ],
);

/* ----------------------------------------------------- data_deletion_requests */
// Solicitudes de eliminación de datos personales (GDPR/CCPA).
// Los usuarios pueden solicitar que eliminemos sus datos personales;
// estas solicitudes quedan registradas en esta tabla.
export const dataDeletionRequests = pgTable(
  "data_deletion_requests",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    details: text("details"),
    status: text("status").notNull().default("pending"),
    ipHash: text("ip_hash"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("ddr_created_at_idx").on(t.createdAt.desc()),
    index("ddr_status_idx").on(t.status, t.createdAt.desc()),
    incidentOwnershipFk("data_deletion_requests", t),
  ],
);

/* ----------------------------------------------------- analytics_events */
// Eventos de analítica. Presente en prod; sin acceso desde el código de la
// app (legado/externo). Se documenta para que el esquema cubra prod.
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    path: text("path").notNull(),
    label: text("label").notNull().default(""),
    referrer: text("referrer").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    screen: text("screen").notNull().default(""),
    language: text("language").notNull().default(""),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [incidentOwnershipFk("analytics_events", t)],
);

/* ---------------------------------------------------- damage_candidates */
// Candidatos de daño estructural. Presente en prod; legado/externo.
export const damageCandidates = pgTable(
  "damage_candidates",
  {
    id: text("id").primaryKey(),
    buildingId: text("building_id").notNull(),
    name: text("name").notNull().default(""),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    damageLevel: text("damage_level").notNull(),
    confidence: doublePrecision("confidence").notNull().default(0),
    reviewStatus: text("review_status").notNull().default("needs_review"),
    sourceBefore: text("source_before").notNull().default(""),
    sourceAfter: text("source_after").notNull().default(""),
    sourceUrl: text("source_url").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [incidentOwnershipFk("damage_candidates", t)],
);

/* ------------------------------------------------- unidentified_persons */
// Personas no identificadas. Presente en prod; legado/externo.
export const unidentifiedPersons = pgTable(
  "unidentified_persons",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("alive"),
    name: text("name").notNull().default(""),
    surname: text("surname").notNull().default(""),
    locationFound: text("location_found").notNull().default(""),
    description: text("description").notNull().default(""),
    contactName: text("contact_name").notNull().default(""),
    contactPhone: text("contact_phone").notNull().default(""),
    photo: text("photo"),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [incidentOwnershipFk("unidentified_persons", t)],
);

/* =====================================================================
 * Federación opcional con un hub central externo (ver ENABLE_HUB_FEDERATION).
 * Espejo READ-ONLY de los datos de OTROS sitios socios. Ver
 * Módulo opcional; desactivado por defecto.
 *
 * Una tabla por tipo del hub (catálogo cerrado de 5), espejando sus DTOs
 * `*Public`. NUNCA se mezclan con las tablas nativas (evita duplicación: ya
 * somos fuente del hub). Columnas comunes de federación:
 *   hub_id   uuid del hub (identidad estable, UNIQUE -> idempotencia del upsert)
 *   source   sitio socio que lo publicó (excluimos los nuestros al ingerir)
 *   external_id  id del socio dentro de su sistema (puede venir null)
 *   ingested_at  cuándo lo trajimos; updated_at  high-water de cambios vistos
 * Columnas de imagen (mismo patrón que las nativas; la foto se copia a R2):
 *   photo_external_url  la URL del socio (efímera, puede dar 404)
 *   photo_url           la URL de R2 tras copiar
 *   photo_migrated_at   sellado cuando ya está en R2 (NULL = pendiente)
 *   photo_broken        true si la fuente devolvió 404/permanente
 * ===================================================================== */

// Columnas compartidas por todas las tablas hub_*. Se hace spread en cada una.
const hubCommon = {
  id: text("id").primaryKey(), // crypto.randomUUID() local
  hubId: text("hub_id").notNull(), // uuid del hub (único)
  source: text("source").notNull().default(""),
  externalId: text("external_id"),
  city: text("city"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  hubCreatedAt: text("hub_created_at"), // created_at del hub (ISO, tal cual)
  ingestedAt: epochMs("ingested_at").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
  ...incidentOwnershipColumns(),
};

// Columnas de imagen compartidas (solo en los tipos con foto).
const hubPhoto = {
  photoExternalUrl: text("photo_external_url"),
  photoUrl: text("photo_url"),
  photoMigratedAt: epochMs("photo_migrated_at"),
  photoBroken: boolean("photo_broken").notNull().default(false),
};

export const hubMissingPersons = pgTable(
  "hub_missing_persons",
  {
    ...hubCommon,
    ...hubPhoto,
    name: text("name").notNull().default(""),
    status: text("status"), // LOOKING_FOR_SOMEONE, etc.
    message: text("message"),
    placeName: text("place_name"),
  },
  (t) => [
    uniqueIndex("idx_hub_missing_hubid").on(t.hubId),
    index("idx_hub_missing_source").on(t.source),
    index("idx_hub_missing_photo_pending")
      .on(t.id)
      .where(sql`photo_migrated_at IS NULL AND photo_external_url IS NOT NULL`),
    incidentOwnershipFk("hub_missing_persons", t),
  ],
);

export const hubCheckins = pgTable(
  "hub_checkins",
  {
    ...hubCommon,
    ...hubPhoto,
    name: text("name").notNull().default(""),
    status: text("status"), // SAFE, NEEDS_HELP, LOOKING_FOR_SOMEONE
    message: text("message"),
    placeName: text("place_name"),
  },
  (t) => [
    uniqueIndex("idx_hub_checkins_hubid").on(t.hubId),
    index("idx_hub_checkins_source").on(t.source),
    incidentOwnershipFk("hub_checkins", t),
  ],
);

export const hubHelpRequests = pgTable(
  "hub_help_requests",
  {
    ...hubCommon,
    category: text("category"), // medical, food, water, ...
    description: text("description"),
    urgency: text("urgency"), // LOW..CRITICAL
    status: text("status"), // OPEN, IN_PROGRESS, RESOLVED
    placeName: text("place_name"),
  },
  (t) => [
    uniqueIndex("idx_hub_helpreq_hubid").on(t.hubId),
    index("idx_hub_helpreq_source").on(t.source),
    incidentOwnershipFk("hub_help_requests", t),
  ],
);

export const hubHelpOffers = pgTable(
  "hub_help_offers",
  {
    ...hubCommon,
    category: text("category"), // transportation, food, ...
    description: text("description"),
    availability: text("availability"),
    available: boolean("available"),
  },
  (t) => [
    uniqueIndex("idx_hub_helpoffer_hubid").on(t.hubId),
    index("idx_hub_helpoffer_source").on(t.source),
    incidentOwnershipFk("hub_help_offers", t),
  ],
);

export const hubDamagedBuildings = pgTable(
  "hub_damaged_buildings",
  {
    ...hubCommon,
    ...hubPhoto,
    placeName: text("place_name"),
    name: text("name"),
    description: text("description"),
    severity: text("severity"), // CRACKS, PARTIAL, COLLAPSE_RISK, COLLAPSED
  },
  (t) => [
    uniqueIndex("idx_hub_damaged_hubid").on(t.hubId),
    index("idx_hub_damaged_source").on(t.source),
    incidentOwnershipFk("hub_damaged_buildings", t),
  ],
);

/* ------------------------------------------------------- hub_sync_state */
// Cursor de paginación por tipo del hub (created_at|id). Igual que sync_state
// pero para la federación: el backfill/incremental reanudan desde aquí.
export const hubSyncState = pgTable(
  "hub_sync_state",
  {
    type: text("type").primaryKey(),
    cursor: text("cursor"),
    lastRunAt: epochMs("last_run_at"),
    cycleCompletedAt: epochMs("cycle_completed_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [incidentOwnershipFk("hub_sync_state", t)],
);

/* ============================================================================
 * AUTH / RBAC — superficie autenticada `api/public/*` (integraciones + admin)
 * ============================================================================
 * Motor de roles+capacidades portado de un diseño RBAC estándar (PermissionGrant
 * + resolución centralizada con short-circuit de admin y cache por-request) PERO con los
 * roles guardados en la DB (creados por admins), no como enum en código.
 *
 * Modelo de decisión (capa que protege cada endpoint nuevo):
 *   capability  = unidad atómica `recurso:verbo` (report:create, role:edit…).
 *                 Catálogo FIJO (sembrado por código, no editable por usuarios).
 *   role        = fila en DB que admins crean; agrupa capacidades (bundle).
 *   role_caps   = M:N rol↔capacidades.
 *   user        = tiene un rol base (bundle) + posibles grants individuales.
 *   grant       = capacidad individual encima del rol (flexibilidad por-persona),
 *                 con expiry/revoke (modelo estándar de grants). Sujeto: user O role.
 *   invitation  = alta por invitación (flujo estándar): token → accept → JWT.
 *   audit_log   = TODA mutación de auth (rol/grant/invite/login) queda registrada.
 *
 * Tenancy por fases: `org_id` viaja en roles/users/grants pero queda NULL (global)
 * hoy. Fase 2 = poblarlo + un filtro de scope en userHasCapability. El core no
 * cambia. NULL = global / aplica en todas las orgs.
 */

/* ------------------------------------------------------------- capabilities */
// Catálogo FIJO de capacidades. Se siembra por migración; NO lo crean usuarios.
// key = `recurso:verbo` (allowlist). category agrupa para la UI de admin.
export const capabilities = pgTable("capabilities", {
  key: text("key").primaryKey(), // "report:create", "user:invite", ...
  description: text("description").notNull().default(""),
  category: text("category").notNull().default(""), // "reports", "auth", ...
});

/* -------------------------------------------------------------------- roles */
// Roles creados por admins (filas, no enum). is_system marca el rol "admin"
// semilla (inmutable: no se borra ni se le quitan capacidades). org_id = fase 2.
export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isSystem: boolean("is_system").notNull().default(false),
    orgId: text("org_id"), // NULL = global (fase 2: scope por organización)
    createdBy: text("created_by"), // user.id que lo creó (NULL para el semilla)
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at"),
  },
  (t) => [
    // Nombre único por org (con org NULL = único global). Dos índices parciales
    // para tratar NULL como "global" sin chocar con orgs concretas.
    uniqueIndex("idx_roles_name_global").on(t.name).where(sql`org_id IS NULL`),
    uniqueIndex("idx_roles_name_org").on(t.orgId, t.name).where(sql`org_id IS NOT NULL`),
  ],
);

/* -------------------------------------------------------- role_capabilities */
// M:N rol↔capacidades. Borrar un rol cae en cascada (FK app-side, sin DDL aquí).
export const roleCapabilities = pgTable(
  "role_capabilities",
  {
    roleId: text("role_id").notNull(),
    capabilityKey: text("capability_key").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.capabilityKey] }),
    index("idx_role_caps_role").on(t.roleId),
  ],
);

/* -------------------------------------------------------------------- users */
// Usuarios autenticados (≠ ciudadanos anónimos del sitio público). password_hash
// es bcrypt; NULL mientras la invitación esté pendiente. status: invited→active.
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    passwordHash: text("password_hash"), // NULL hasta aceptar invitación
    roleId: text("role_id"), // rol base (bundle). NULL = sin rol (solo grants)
    orgId: text("org_id"), // fase 2
    status: text("status").notNull().default("invited"), // invited|active|disabled
    // Super admin: tier por ENCIMA del admin semilla. Único que puede gestionar
    // la réplica pública (capability mirror:manage, con corte en resolve.ts). El
    // admin semilla normal NO la tiene. Ver RFC 0006.
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    createdAt: epochMs("created_at").notNull(),
    lastLoginAt: epochMs("last_login_at"),
  },
  (t) => [
    uniqueIndex("idx_users_email").on(sql`lower(${t.email})`),
    index("idx_users_role").on(t.roleId),
  ],
);

/* -------------------------------------------------------- permission_grants */
// Capacidad individual encima del rol (modelo estándar de grants). subject = user O role
// (XOR app-side). Activo = revoked_at NULL && (expires_at NULL || > now).
export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: text("id").primaryKey(),
    capabilityKey: text("capability_key").notNull(),
    subjectType: text("subject_type").notNull(), // "user" | "role"
    subjectUserId: text("subject_user_id"), // set si subject_type=user
    subjectRoleId: text("subject_role_id"), // set si subject_type=role
    orgId: text("org_id"), // fase 2: scope del grant
    grantedBy: text("granted_by").notNull(),
    grantedAt: epochMs("granted_at").notNull(),
    expiresAt: epochMs("expires_at"), // NULL = sin expiración
    revokedAt: epochMs("revoked_at"), // NULL = activo
    revokedBy: text("revoked_by"),
    reason: text("reason").notNull().default(""),
  },
  (t) => [
    index("idx_grants_cap_subject").on(t.capabilityKey, t.subjectType, t.revokedAt),
    index("idx_grants_user").on(t.subjectUserId),
    index("idx_grants_role").on(t.subjectRoleId),
  ],
);

/* -------------------------------------------------------------- invitations */
// Alta por invitación (flujo estándar). token_hash = sha256 del token enviado por
// email (nunca guardamos el token en claro). Un solo uso; caduca.
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    roleId: text("role_id"), // rol que tendrá al aceptar
    orgId: text("org_id"), // fase 2
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").notNull(),
    createdAt: epochMs("created_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
    acceptedAt: epochMs("accepted_at"), // NULL = pendiente
  },
  (t) => [
    uniqueIndex("idx_invitations_token").on(t.tokenHash),
    index("idx_invitations_email").on(sql`lower(${t.email})`),
  ],
);

/* ----------------------------------------------------------- password_resets */
// Recuperación de contraseña por OTP (código de 6 dígitos enviado al email).
// Guardamos solo el HASH del código (sha256), nunca el código en claro. Un solo
// uso, caduca pronto (minutos). attempts limita el fuerza-bruta del código.
export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    createdAt: epochMs("created_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
    consumedAt: epochMs("consumed_at"), // NULL = sin usar
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    index("idx_pwreset_user").on(t.userId),
    index("idx_pwreset_expires").on(t.expiresAt),
  ],
);

/* ---------------------------------------------------------------- audit_log */
// Bitácora de TODA mutación sensible (auth + escrituras de api/public/*).
// metadata jsonb lleva el contexto (antes/después, ids afectados, etc.).
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: text("actor_user_id"), // NULL = sistema/anónimo
    action: text("action").notNull(), // "role.create", "report.delete", ...
    targetType: text("target_type"), // "report", "user", "role", ...
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    ipHash: text("ip_hash"),
    createdAt: epochMs("created_at").notNull(),
    scopeType: text("scope_type"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_audit_created").on(t.createdAt.desc()),
    index("idx_audit_actor").on(t.actorUserId),
    index("idx_audit_target").on(t.targetType, t.targetId),
    incidentOwnershipFk("audit_log", t),
    check(
      "audit_log_scope_ids",
      sql`(
        (${t.scopeType} IS NULL AND ${t.organizationId} IS NULL AND ${t.incidentId} IS NULL)
        OR (${t.scopeType} = 'global' AND ${t.organizationId} IS NULL AND ${t.incidentId} IS NULL)
        OR (${t.scopeType} = 'organization' AND ${t.organizationId} IS NOT NULL AND ${t.incidentId} IS NULL)
        OR (${t.scopeType} = 'incident' AND ${t.organizationId} IS NOT NULL AND ${t.incidentId} IS NOT NULL)
      )`,
    ),
  ],
);

/* ------------------------------------------------------------- earthquakes */
// Catálogo de sismos de la región configurada, ingerido del USGS por el worker (feed
// realtime cada minuto + backfill puntual vía FDSN). La PK es el `id` de evento
// del USGS (ej. "us7000abcd") → el upsert es onConflictDoUpdate sobre la PK,
// idempotente y a prueba de revisiones (USGS corrige magnitud horas después).
// Datos públicos read-only; una región típica genera pocos sismos/día (catálogo pequeño).
export const earthquakes = pgTable(
  "earthquakes",
  {
    id: text("id").primaryKey(), // id de evento USGS (clave natural)
    magnitude: doublePrecision("magnitude"), // nullable: a veces se publica antes de calcularla
    place: text("place").notNull(), // p. ej. "43 km N of Ciudad Ejemplo"
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    depthKm: doublePrecision("depth_km"),
    alert: text("alert"), // PAGER: green|yellow|orange|red (usualmente null en sismos chicos)
    tsunami: boolean("tsunami").notNull().default(false),
    sig: integer("sig"), // significancia USGS 0–1000
    usgsUpdatedAt: epochMs("usgs_updated_at").notNull(), // 'updated' del USGS → decide si sobreescribir
    occurredAt: epochMs("occurred_at").notNull(), // 'time' del USGS (momento del sismo)
    fetchedAt: epochMs("fetched_at").notNull(), // cuándo lo vio nuestro worker
  },
  (t) => [
    index("idx_earthquakes_occurred").on(t.occurredAt.desc()),
    index("idx_earthquakes_geo").on(t.lat, t.lng),
  ],
);

/* ---------------------------------------------------------------- api_keys */
// API keys self-service por usuario (integraciones máquina-a-máquina contra
// api/public/*). Nunca se guarda la llave cruda: solo su hash SHA-256 (igual que
// hospital_poc_assignments e invitations). `prefix` es los primeros caracteres
// (no secreto) para identificar la llave en la UI. `scopes` acota la llave a un
// SUBCONJUNTO de las capacidades del usuario (least-privilege por integración);
// el permiso efectivo en cada request = scopes ∩ capacidades vivas del usuario.
// Soft-delete vía revokedAt (nunca borrado físico) — espeja el patrón de users.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(), // dueño de la llave
    name: text("name").notNull().default(""), // etiqueta del usuario ("CI", "Postman"…)
    keyHash: text("key_hash").notNull(), // SHA-256(llave cruda), nunca la cruda
    prefix: text("prefix").notNull(), // primeros chars para mostrar (no secreto)
    scopes: jsonb("scopes").notNull(), // string[] de capability keys (subconjunto del usuario)
    createdAt: epochMs("created_at").notNull(),
    lastUsedAt: epochMs("last_used_at"), // se actualiza fire-and-forget en cada uso
    expiresAt: epochMs("expires_at"), // NULL = sin expiración
    revokedAt: epochMs("revoked_at"), // NULL = activa (soft delete)
    revokedBy: text("revoked_by"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_api_keys_hash").on(t.keyHash),
    index("idx_api_keys_user").on(t.userId),
    incidentOwnershipFk("api_keys", t),
  ],
);

/* ------------------------------------------------------------ hub_credentials */
// Credenciales de acceso a la RÉPLICA PÚBLICA (hub Postgres, RFC 0006). Cada fila
// representa un consumidor externo al que un super admin le dio acceso SQL crudo.
// El backend, al emitirla: (1) crea un ROL Postgres `consumer_<id>` en el hub con
// password generada, (2) abre la IP del consumidor en el firewall del hub vía
// la API de Hetzner. Esta tabla es el LIBRO MAYOR para poder revocar ambas cosas.
// La password NUNCA se guarda (se muestra una vez, como api_keys). `pgRole` y
// `allowedIp` + `hetznerRuleRef` permiten deshacer rol y regla al revocar.
export const hubCredentials = pgTable(
  "hub_credentials",
  {
    id: text("id").primaryKey(),
    consumerName: text("consumer_name").notNull(), // etiqueta humana ("ONG X")
    pgRole: text("pg_role").notNull(), // rol creado en el hub (consumer_<id>)
    allowedIp: text("allowed_ip").notNull(), // CIDR/IP whitelisteada en el firewall
    hetznerRuleRef: text("hetzner_rule_ref"), // marca para ubicar/quitar la regla
    createdBy: text("created_by").notNull(), // user.id (super admin) que la emitió
    createdAt: epochMs("created_at").notNull(),
    lastRotatedAt: epochMs("last_rotated_at"), // si se rota la password
    revokedAt: epochMs("revoked_at"), // NULL = activa (soft delete)
    revokedBy: text("revoked_by"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_hub_credentials_role").on(t.pgRole),
    index("idx_hub_credentials_active").on(t.revokedAt),
    incidentOwnershipFk("hub_credentials", t),
  ],
);

/* ==================================================== capa de identidad ==== */
// Family Search (plan 2026-08-11-001). Registro overlay: las tablas fuente
// (missing_persons, hospital_patients, unidentified_persons) NUNCA aprenden de
// esta capa — sin FKs hacia ellas a propósito; el cron de reconciliación es el
// que detecta referencias huérfanas. Escrituras multi-fila = máquina de estados
// idempotente (claim condicional + ON CONFLICT), jamás db.transaction().

/* ------------------------------------------------------------ person_records */
// Un PRN (TC-XXXXXXXXC, Crockford base32 + carácter de control) por registro
// fuente. El PRN identifica un REGISTRO; la "persona" es el cluster.
export const personRecords = pgTable(
  "person_records",
  {
    prn: text("prn").primaryKey(),
    // 'missing_report' | 'hospital_patient' | 'unidentified_person' | ...
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    createdAt: epochMs("created_at").notNull(),
    // Tombstone (U10): el registro fuente fue borrado; el PRN se conserva y
    // resuelve a "registro eliminado" en vez de a un 500.
    removedAt: epochMs("removed_at"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_person_records_record").on(t.recordType, t.recordId),
    incidentOwnershipFk("person_records", t),
  ],
);

/* -------------------------------------------------------------- person_links */
// Una fila por PAR no ordenado (prn_a < prn_b, CHECK estructural — sin él, un
// insert invertido resucitaría un par rechazado como fila nueva). El estado es
// la última decisión; la historia vive en person_link_decisions (append-only).
export const personLinks = pgTable(
  "person_links",
  {
    id: text("id").primaryKey(),
    prnA: text("prn_a").notNull(),
    prnB: text("prn_b").notNull(),
    // 'proposed' | 'confirmed' | 'rejected' | 'unsure'
    status: text("status").notNull().default("proposed"),
    score: doublePrecision("score"),
    // SOLO tokens de resultado por campo (p.ej. {"documento":"exact"}).
    // Jamás valores crudos — invariante testeado.
    evidence: jsonb("evidence").notNull().default({}),
    // Ranking de re-propuesta: 'document_hash_exact' > 'name_age_exact'.
    evidenceClass: text("evidence_class").notNull(),
    // 'deterministic' | 'manual' (probabilistic llega en fase 2)
    method: text("method").notNull(),
    matcherVersion: text("matcher_version"),
    proposedAt: epochMs("proposed_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_person_links_pair").on(t.prnA, t.prnB),
    index("idx_person_links_queue").on(t.status, t.proposedAt),
    incidentOwnershipFk("person_links", t),
  ],
);

/* ----------------------------------------------------- person_link_decisions */
// Append-only: NUNCA se actualiza una decisión. evidence_snapshot congela lo
// que el revisor vio (una re-propuesta sobreescribe person_links, no esto).
export const personLinkDecisions = pgTable(
  "person_link_decisions",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => personLinks.id),
    // 'confirmed' | 'rejected' | 'unsure' | 'rescinded' (unmerge/borrado)
    decision: text("decision").notNull(),
    note: text("note").notNull().default(""),
    evidenceSnapshot: jsonb("evidence_snapshot").notNull().default({}),
    // users.id — atribución obligatoria (R12).
    decidedBy: text("decided_by").notNull(),
    decidedAt: epochMs("decided_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_person_link_decisions_link").on(t.linkId, t.decidedAt),
    incidentOwnershipFk("person_link_decisions", t),
  ],
);

/* ------------------------------------------------------------ person_clusters */
// La "persona": componente conexo sobre links CONFIRMADOS (solo). La membresía
// materializada la converge recomputeClusterFor (5 sub-pasos, KTD3 del plan);
// el cron de reconciliación verifica conectividad y repara divergencias.
export const personClusters = pgTable(
  "person_clusters",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("reported_missing"),
    createdAt: epochMs("created_at").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [incidentOwnershipFk("person_clusters", t)],
);

export const personClusterMembers = pgTable(
  "person_cluster_members",
  {
    id: text("id").primaryKey(),
    clusterId: text("cluster_id").notNull(),
    prn: text("prn").notNull(),
    addedAt: epochMs("added_at").notNull(),
    // Historia preservada: quitar = set removed_at, jamás DELETE.
    removedAt: epochMs("removed_at"),
    // users.id | 'system' (recompute).
    addedBy: text("added_by").notNull(),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_person_cluster_members_live")
      .on(t.prn)
      .where(sql`removed_at IS NULL`),
    index("idx_person_cluster_members_cluster").on(t.clusterId, t.removedAt),
    incidentOwnershipFk("person_cluster_members", t),
  ],
);

/* ------------------------------------------------------ record_status_signals */
// "Señal, no verdad": una transición de status llegada por upsert externo
// (socio/sync) NO pisa el status guardado — queda pendiente aquí hasta que un
// revisor la confirme o descarte (R25/R26). claimed_status es columna de
// primera clase porque es la clave de dedup del índice parcial único.
export const recordStatusSignals = pgTable(
  "record_status_signals",
  {
    id: text("id").primaryKey(),
    prn: text("prn").notNull(),
    // 'partner:<email>' | 'feed:<n>' — procedencia del claim.
    source: text("source").notNull(),
    // Solo 'status_report' en esta fase (KTD19: precursor de intake_items).
    kind: text("kind").notNull().default("status_report"),
    claimedStatus: text("claimed_status").notNull(),
    // Allowlist: nota de resolución del socio + reported-at. Sin texto libre
    // adicional del cable, sin media.
    payload: jsonb("payload").notNull().default({}),
    // 'pending' | 'confirmed' | 'dismissed'
    status: text("status").notNull().default("pending"),
    createdAt: epochMs("created_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: epochMs("decided_at"),
    decisionNote: text("decision_note"),
    ...incidentOwnershipColumns(),
  },
  (t) => [
    uniqueIndex("idx_record_status_signals_pending")
      .on(t.prn, t.kind, t.claimedStatus)
      .where(sql`status = 'pending'`),
    index("idx_record_status_signals_queue").on(t.status, t.createdAt),
    incidentOwnershipFk("record_status_signals", t),
  ],
);

/* ----------------------------------------------- failed_submissions */
// RED DE SEGURIDAD de durabilidad para los formularios públicos.
//
// El 2026-08-11 el registro de voluntarios estuvo 6h devolviendo 503 por una
// migración sin aplicar y ~44 inscripciones de personas afectadas por el
// terremoto se perdieron para siempre: nunca llegaron a la base, no había nada
// que reproducir. Los gates nuevos (deriva de esquema en el deploy, monitor
// horario) hacen eso mucho menos probable; esta tabla hace que, cuando vuelva a
// pasar, el dato de la persona NO se tire a la basura.
//
// FORMA DELIBERADAMENTE MÍNIMA Y CONGELADA. Es la tabla que tiene que seguir
// funcionando justo cuando OTRA tabla está derivada, así que no debe crecer
// columnas: el cuerpo entero va en un `jsonb`. Añadirle campos la vuelve tan
// frágil como lo que protege.
//
// ALCANCE HONESTO: cubre el fallo de escritura sobre una tabla concreta (deriva
// de esquema, constraint, tipo). NO cubre que la base entera esté caída — ahí
// este insert falla también. Es la mejora barata sobre "se pierde", no una cola
// durable de verdad.
//
// PRIVACIDAD: `payload` lleva datos personales (nombre, contacto) porque ese es
// exactamente el dato que no queremos perder — la persona lo envió para que lo
// guardáramos. Vive en la MISMA base y bajo las mismas protecciones que la tabla
// destino: no se relocaliza PII a KV ni a una cola externa. `turnstileToken` se
// quita antes de persistir. La supresión (Ley 1581) SÍ mira aquí: resolver una
// solicitud purga los envíos fallidos por email, y el cron de reconciliación
// aplica retención (7d reinyectadas / 30d pendientes) — ver
// backend/src/services/failed-submissions.ts.
export const failedSubmissions = pgTable(
  "failed_submissions",
  {
    id: text("id").primaryKey(),
    // Formulario de origen ("volunteers", "missing", ...). Texto y no enum a
    // propósito: un valor nuevo no debe requerir migrar esta tabla.
    form: text("form").notNull(),
    payload: jsonb("payload").notNull(),
    // SQLSTATE del fallo (42703, 23505...). Nunca el mensaje: puede arrastrar
    // los valores de la fila. Ver lib/db-error.ts.
    errorCode: text("error_code"),
    createdAt: epochMs("created_at").notNull(),
    // NULL = pendiente de reinyectar. Se sella al reprocesar.
    replayedAt: epochMs("replayed_at"),
    // Tenant columns live beside the JSON (KTD10). They are the only additive
    // columns this table accepts: retention and deletion must be incident-scoped.
    ...incidentOwnershipColumns(),
  },
  (t) => [
    index("idx_failed_submissions_pending").on(t.replayedAt, t.createdAt),
    incidentOwnershipFk("failed_submissions", t),
  ],
);
