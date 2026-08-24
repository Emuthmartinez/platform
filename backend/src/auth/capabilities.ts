/**
 * Catálogo FIJO de capacidades (la unidad atómica de autorización).
 *
 * Una capability es `recurso:verbo`. Cada endpoint de `api/public/*` declara la
 * que exige (deny-by-default). Este catálogo es la fuente de verdad: se siembra
 * en la tabla `capabilities` por migración y NO lo crean usuarios. Los ROLES
 * (filas en DB que admins crean) agrupan estas capacidades; además se pueden
 * conceder individualmente vía `permission_grants`.
 *
 * Convención: CRUD por modelo = read | create | edit | delete. Más un puñado de
 * capacidades transversales (auth, audit) que gobiernan el propio motor.
 *
 * Para añadir un modelo nuevo: agrégalo a MODELS y corre `db:generate` + el seed.
 */

/** Verbos CRUD estándar que todo modelo de datos expone en `api/public/*`. */
export const CRUD_VERBS = ["read", "create", "edit", "delete"] as const;
export type CrudVerb = (typeof CRUD_VERBS)[number];

/**
 * Modelos de datos con superficie CRUD en `api/public/*`. La key es el prefijo
 * de la capability y del path del router (`api/public/<model>`); category agrupa
 * en la UI de admin.
 */
export const MODELS: { key: string; category: string; label: string }[] = [
  { key: "report", category: "reports", label: "Reportes de emergencia" },
  { key: "missing", category: "missing", label: "Personas desaparecidas" },
  // Modelo aparte de `missing`: son tablas distintas a propósito (ver
  // services/pets.ts), así que también son permisos distintos — se puede dar
  // acceso a mascotas sin darlo a los datos de personas, que son más sensibles.
  { key: "pet", category: "missing", label: "Mascotas desaparecidas" },
  { key: "hospital", category: "hospitals", label: "Hospitales" },
  { key: "patient", category: "hospitals", label: "Pacientes de hospital" },
  { key: "donation", category: "donations", label: "Donaciones / acopio" },
  { key: "chat", category: "chat", label: "Mensajes de chat" },
  { key: "contact", category: "contact", label: "Mensajes de contacto" },
  { key: "volunteer", category: "volunteers", label: "Voluntarios" },
  // Campaña de reconstrucción: puntos de recolección, responsables de punto,
  // compromisos de donación y lotes de salida. Una sola capability para los
  // cuatro recursos, igual que volunteer-tasks reutiliza `volunteer`: quien
  // coordina la campaña necesita las cuatro cosas o ninguna.
  { key: "campaign", category: "campaign", label: "Campaña de reconstrucción" },
];

/**
 * Capacidades transversales (no son CRUD de un modelo de datos): gobiernan el
 * motor de auth y la bitácora. Son las que `requireCapability` exige en los
 * endpoints de administración de usuarios/roles/grants.
 */
export const CROSS_CUTTING: { key: string; category: string; description: string }[] = [
  // Importación de pacientes hospitalarios (staging + procesado + apply). No es
  // un verbo CRUD estándar: gobierna toda la superficie de `patient-imports`.
  {
    key: "patient:import",
    category: "hospitals",
    description: "Importar pacientes hospitalarios (staging, validación y apply)",
  },
  // Supresión de datos (Ley 1581): gestionar las solicitudes ciudadanas de
  // eliminación. Dos claves (no CRUD completo): leerlas es sensible por sí
  // mismo (PII de solicitantes) y resolverlas es una decisión operativa.
  {
    key: "deletion:read",
    category: "privacy",
    description: "Ver solicitudes de supresión de datos (Ley 1581)",
  },
  {
    key: "deletion:edit",
    category: "privacy",
    description: "Resolver/rechazar solicitudes de supresión de datos",
  },
  // Portal exclusivo de psicólogos (/psicologia): gatea el endpoint
  // api/public/psychology. El rol "Psicólogos" lo crea el admin desde el
  // panel con esta capability; las invitaciones van por el flujo normal.
  {
    key: "psychology:access",
    category: "psychology",
    description: "Acceder al portal exclusivo de psicólogos",
  },
  { key: "user:invite", category: "auth", description: "Invitar usuarios nuevos" },
  { key: "user:read", category: "auth", description: "Ver usuarios" },
  { key: "user:edit", category: "auth", description: "Editar usuarios (estado, rol)" },
  { key: "user:delete", category: "auth", description: "Desactivar/eliminar usuarios" },
  { key: "role:read", category: "auth", description: "Ver roles" },
  { key: "role:create", category: "auth", description: "Crear roles" },
  { key: "role:edit", category: "auth", description: "Editar roles (capacidades incluidas)" },
  { key: "role:delete", category: "auth", description: "Eliminar roles" },
  { key: "grant:read", category: "auth", description: "Ver grants de capacidades" },
  { key: "grant:manage", category: "auth", description: "Conceder/revocar capacidades individuales" },
  { key: "audit:read", category: "audit", description: "Ver la bitácora de auditoría" },
  // Analítica agregada de voluntarios reutiliza `volunteer:read` del MODEL
  // CRUD (`MODELS.volunteer`) — no duplicar la key en CROSS_CUTTING.
  // Self-service: gestionar TUS PROPIAS API keys. Se siembra en todos los roles
  // (cualquier usuario invitado puede crear sus llaves). Revocar llaves AJENAS es
  // potestad del admin semilla (no necesita esta cap). Es capability — no "solo
  // autenticado" — para encajar en el deny-by-default del repo y poder quitársela
  // a un rol restringido si hiciera falta (least-privilege).
  { key: "apikey:manage", category: "auth", description: "Crear y revocar tus propias API keys" },
  // Acceso a la RÉPLICA PÚBLICA (hub SQL, RFC 0006): emitir/revocar credenciales
  // de consumidor (rol Postgres + password + IP en el firewall). Es la capacidad
  // MÁS sensible (abre un puerto público + crea credenciales de DB), así que NO
  // se siembra en ningún rol por defecto y tiene un CORTE especial en resolve.ts:
  // se exige incluso al admin semilla, que debe tener además el flag de super
  // admin (users.is_super_admin). Ver MIRROR_MANAGE + userHasCapability.
  { key: "mirror:manage", category: "auth", description: "Emitir/revocar acceso a la réplica pública (SQL hub)" },
  // Hostname → organization/incident catalog (KTD7). Same superadmin cut as
  // mirror:manage: never granted through a role. See DEPLOYMENT_MANAGE.
  {
    key: "deployment:manage",
    category: "auth",
    description: "Crear y editar deployments (hostname → organización e incidente)",
  },
  // Family Search (U9) — capa de identidad sobre missing_persons/hospital_patients/
  // unidentified_persons. Tres claves, no CRUD estándar (la unidad no es un
  // modelo con create/edit/delete, es un flujo de revisión con tres verbos
  // propios). Mismo criterio que deletion:read/edit: leer ya es sensible (cruza
  // PII entre registros de poblaciones distintas), decidir es una potestad
  // operativa aparte, y fusionar clusters ya establecidos es la más delicada de
  // las tres (una fusión ancorada equivocada notifica a la familia equivocada).
  {
    key: "person:search",
    category: "identity",
    description: "Buscar registros/clusters de personas (cola de revisión, búsqueda por nombre/PRN, ficha de cluster)",
  },
  {
    key: "person:review",
    category: "identity",
    description: "Decidir vínculos propuestos (confirmar/rechazar/inseguro) y proponerlos manualmente",
  },
  {
    key: "person:merge",
    category: "identity",
    description: "Confirmar una fusión ANCORADA (dos clusters ya establecidos) y deshacer una fusión (unmerge)",
  },
];

/** Capacidad que gobierna el acceso a la réplica pública. Gateada a super admin. */
export const MIRROR_MANAGE = "mirror:manage";

/** Hostname catalog (KTD7). Gateada a super admin, igual que mirror:manage. */
export const DEPLOYMENT_MANAGE = "deployment:manage";

/** Capabilities that require users.is_super_admin even for the seed admin role. */
export const SUPERADMIN_ONLY_CAPABILITIES = [
  MIRROR_MANAGE,
  DEPLOYMENT_MANAGE,
] as const;

export function isSuperAdminOnlyCapability(key: string): boolean {
  return (SUPERADMIN_ONLY_CAPABILITIES as readonly string[]).includes(key);
}

export interface CapabilityDef {
  key: string;
  description: string;
  category: string;
}

/** Construye el catálogo completo: CRUD por modelo + transversales. */
function buildCatalog(): CapabilityDef[] {
  const verbLabel: Record<CrudVerb, string> = {
    read: "Ver",
    create: "Crear",
    edit: "Editar",
    delete: "Eliminar",
  };
  const crud = MODELS.flatMap((m) =>
    CRUD_VERBS.map((verb) => ({
      key: `${m.key}:${verb}`,
      category: m.category,
      description: `${verbLabel[verb]} ${m.label.toLowerCase()}`,
    })),
  );
  return [...crud, ...CROSS_CUTTING];
}

/** El catálogo completo, inmutable. */
export const CAPABILITIES: readonly CapabilityDef[] = Object.freeze(buildCatalog());

/** Set de keys válidas — para validar que un endpoint exige una capability real. */
export const CAPABILITY_KEYS: ReadonlySet<string> = new Set(CAPABILITIES.map((c) => c.key));

/** True si la key existe en el catálogo (usado por requireCapability en dev). */
export function isKnownCapability(key: string): boolean {
  return CAPABILITY_KEYS.has(key);
}

/** Nombre del rol semilla (admin total). Inmutable: no se borra ni se le quitan caps. */
export const SYSTEM_ADMIN_ROLE = "admin";
