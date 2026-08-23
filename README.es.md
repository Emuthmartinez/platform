# Mallanet platform — clon de desarrollo

*[Read it in English](README.md)*

Este repositorio es el clon de la **plataforma multi-incidente** (unidad U6).
Es canónico para el desarrollo de la plataforma. **No** es la fuente de
producción de Colombia hasta la unidad U21.

La producción de Colombia sigue en **https://terremotocolombia.co**, desde
[mallanet/Terremotocolombia](https://github.com/mallanet/Terremotocolombia).

**No copies tokens de Doppler o Cloudflare de Colombia aquí.** Los
workflows de deploy no corren salvo que `ENABLE_PLATFORM_DEPLOYS` sea
`true` después de existir un staging aislado.

Sitio de respuesta al **terremoto de Colombia de 2026**, operado por
[Mallanet.org](https://mallanet.org): mapa de emergencia ciudadano en tiempo
real con reportes georreferenciados, directorio de personas desaparecidas +
hospitales/refugios, directorio de centros de acopio, y panel de administración
con control de acceso por roles.

**Producción de Colombia → https://terremotocolombia.co**

Agentes y colaboradores: lee [`CLAUDE.md`](CLAUDE.md) primero.

## Este despliegue

| | |
| --- | --- |
| En vivo | **https://terremotocolombia.co** |
| Frontend | Cloudflare Workers (`@opennextjs/cloudflare`) |
| API | Cloudflare Workers, `api.terremotocolombia.co` |
| Base de datos | Neon Postgres (externa) |
| Secretos | Doppler — no ficheros `.env` |
| Panel de administración | Cloudflare Workers, `admin.terremotocolombia.co` (detrás de Cloudflare Access) |
| Despliegue del frontend | **Automático, en cada push a `main`** que toque `frontend/**` |
| Despliegue del admin | **Automático, en cada push a `main`** que toque `admin/**` |
| Despliegue del backend | **Solo manual** — `workflow_dispatch`, nunca con el merge |

**`main` es producción**, y además existe la rama y el entorno de `staging`
(`staging.terremotocolombia.co`, con su propia rama de Neon) donde todo el
stack —API incluida— se despliega solo. La asimétrica es producción: el
frontend y el panel salen con el merge, pero la API solo sale cuando un humano
lanza `deploy-backend.yml`, que antes corre un gate de deriva de esquema que
falla cerrado. Las migraciones no las corre CI en ningún entorno.

Hoy sin desplegar: el worker de colas BullMQ (sus jobs se portaron a Cloudflare
Queues y Cron Triggers).

## Para quién es

- Equipos técnicos voluntarios y ONGs respondiendo a un desastre específico
  que necesitan un mapa + directorio funcionando ya, operado por personas
  que no son ingenieros de software a tiempo completo.
- Organizaciones que ya operan infraestructura de respuesta a desastres y
  quieren una base documentada y limpia de datos sensibles, en vez de
  copiar el repo de un evento anterior (con los datos, secretos y supuestos
  de ese evento todavía adentro).
- Cualquiera que vaya a levantar esto con un agente de código de IA haciendo
  la configuración y el despliegue, no solo el código.

## Lo central: un agente puede llevar esto de clon a despliegue en vivo

Esta plantilla trae cinco skills de [Claude Code](https://claude.com/claude-code)
bajo `.claude/skills/`. Abre el repo en un agente que lea `CLAUDE.md` (Claude
Code lo hace automáticamente) y pídele que levante tu despliegue: correrá
estas cinco skills, en este orden:

1. **`disaster-configure`** — escribe tu organización, tu desastre, tu
   región, el centro del mapa y tus dominios en
   `config/deployment.config.json` y en los pocos archivos estáticos que no
   pueden leerlo en runtime (manifest PWA, contactos de emergencia, datos de
   evento de ejemplo). Todo lo demás en la app lee de ese único archivo.
2. **`disaster-brand`** — aplica tus colores y tu logo en los tokens de
   diseño de `docs/DESIGN.md`, las variables CSS de la app, el manifest PWA,
   el favicon y las imágenes sociales generadas (OpenGraph/Twitter).
3. **`disaster-secrets-bootstrap`** — genera cada secreto requerido
   (`JWT_SECRET`, `IP_SALT`, contraseñas de base de datos/caché, etc.) con
   `openssl rand` y escribe tu `.env` real, sin darse por terminado mientras
   sobreviva algún placeholder `CHANGE_ME`.
4. **`disaster-deploy-vps`** — endurece un VPS Ubuntu nuevo (usuario de
   deploy, UFW, fail2ban), instala Docker, levanta
   `docker-compose.prod.yml` detrás de Caddy con TLS de Let's Encrypt sobre
   tus dominios, y corre smoke checks (servicios sanos, TLS emitido, un
   reporte de prueba llega de punta a punta, el login de admin funciona).
5. **`disaster-content-audit`** — el último portón antes de compartir tu
   fork públicamente o sumar colaboradores: escanea todo el árbol en busca
   del tipo de literal del que esta misma plantilla fue depurada (IPs
   reales, correos personales, secretos olvidados, la identidad de un
   evento anterior) y se niega a decir "limpio" hasta que de verdad lo esté.

Cada skill es un `SKILL.md` con rutas de archivo exactas, pasos de
verificación y "hard stops" — un agente no necesita conocimiento tribal más
allá de lo que ya está en el repo. La versión legible para humanos de este
mismo camino es [`docs/standup-guide.md`](docs/standup-guide.md); el paso de
VPS solo está detallado en [`docs/deploy-vps.md`](docs/deploy-vps.md).

## Arquitectura, en un párrafo

Tres apps Next.js/Express detrás de un único reverse proxy. `frontend/`
(Next.js + React + Leaflet) es el mapa público y los directorios; nunca toca
la base de datos directo, solo la API. `backend/` (Express + TypeScript +
Drizzle ORM sobre Postgres) sirve todo bajo `/api`, más
`backend/worker/` (BullMQ sobre Valkey) para sync en segundo plano,
geocodificación, deduplicación y federación de hub opcional. `admin/` es un
microservicio Next.js separado —un backend-for-frontend con su propio RBAC
(JWT en cookie httpOnly) que habla con el backend por la red interna, nunca
directo a la base de datos. El camino de **un solo VPS** de la plantilla
(`docker-compose.prod.yml` + Caddy como único reverse proxy que termina TLS,
con Postgres y Valkey co-ubicados) sigue soportado y es el único donde funcionan
las colas y las transacciones interactivas — pero **no** es lo que sirve
terremotocolombia.co hoy. Este despliegue corre en Cloudflare Workers con Neon
Postgres, como dice la tabla de arriba. Ver
[`docs/architecture.md`](docs/architecture.md) para el panorama completo.

## Guía rápida

Con tu información lista de antemano (nombre de tu organización,
desastre/región, dominios, números reales de emergencia de tu zona — ver
`docs/standup-guide.md` para la lista completa), el camino de abajo toma
alrededor de **30 minutos** de trabajo activo, más lo que tarde la
propagación de DNS.

1. Usa **Use this template** en GitHub y crea tu propio repositorio a partir
   de este.
2. Clona tu nuevo repositorio.
3. Ábrelo en Claude Code (u otro agente de código que lea
   `CLAUDE.md`/`AGENTS.md`).
4. Sigue `CLAUDE.md` — apunta al agente hacia las skills de standup en el
   orden de arriba. Responde las preguntas que te haga (el nombre de tu
   organización, los números reales de emergencia de tu región, tus
   dominios) a medida que aparezcan; las skills se niegan a inventarte esa
   información.

¿Prefieres hacerlo a mano, o quieres ver cada paso antes de que un agente lo
corra? Lee [`docs/standup-guide.md`](docs/standup-guide.md).

## Lo que esta plantilla deliberadamente NO incluye

- **Datos reales.** Cada semilla (hospitales, personas desaparecidas,
  contactos de emergencia, el sismo de referencia) es sintética y está
  marcada como ejemplo de forma obvia. No hay atajo que envíe datos reales
  de una crisis: tú aportas la información real de tu región tú mismo,
  deliberadamente, a través de `disaster-configure`.
- **Kubernetes / multi-nodo / stack de observabilidad.** El camino soportado
  es un solo VPS con docker compose y Caddy. Un camino con k3s+OpenTofu y un
  stack de observabilidad Prometheus/Loki/Grafana son pasos razonables a
  mayor escala, pero son trabajo futuro, no parte de esta plantilla.
- **Un framework de i18n.** La UI se envía en español (el idioma por
  defecto para este tipo de despliegue) como strings JSX planos —no hay una
  abstracción tipo next-intl/i18next debajo. Localizar a otro idioma hoy
  significa que tu agente edite el copy directamente; es un costo real que
  elegimos no esconder detrás de una promesa falsa de "soporte
  multi-idioma".

## Modelo de seguridad

Este tipo de sitio recopila información de personas en crisis. La plantilla
impone algunas cosas de forma estructural, y le pide al deployer que se haga
cargo del resto:

- **Portón de auditoría de contenido.** `disaster-content-audit` (y
  `scripts/content-audit/` de forma independiente) bloquea cualquiera de los
  patrones literales de los que la historia de este mismo repo fue
  depurada: el mismo chequeo que corre antes de cada release de esta
  plantilla corre en cada fork que la use.
- **Política de no-datos-reales.** Semillas y fixtures son sintéticas por
  convención (`AGENTS.md` lo vuelve una regla dura para quien contribuya
  código). Los datos reales de una crisis van en tu base de datos, nunca en
  un commit, una issue o una captura de pantalla.
- **Obligaciones del deployer sobre PII.** Levantar esto significa que vas a
  recopilar datos personales reales de personas en una emergencia. Esa es
  una responsabilidad legal y ética que esta plantilla no puede asumir por
  ti — ver [`SECURITY.md`](SECURITY.md) para lo que sí impone (rate
  limiting, verificación anti-bot en escrituras públicas, RBAC en la
  superficie admin) y lo que sigue siendo tuyo por decidir (retención,
  acceso, y eventualmente el decommission del despliegue).

## Crédito

Mantenido por [mallanet.org](https://mallanet.org). Esta plantilla se extrae
de la plataforma de producción que mallanet construyó y operó durante la
respuesta al sismo de Venezuela de 2026 — las partes específicas de ese
evento y todo lo sensible fueron removidas; las partes que hacen funcionar
el software se conservaron y se volvieron genéricas. Si usas esta plantilla
para un despliegue real, estás parado sobre esa experiencia de campo.

Licencia MIT. Ver [`LICENSE`](LICENSE).
