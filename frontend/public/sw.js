/**
 * Service worker mínimo y prudente para esta plataforma de emergencia.
 *
 * Estrategia:
 *  - HTML/navegaciones: network-first con fallback al último HTML cacheado o
 *    a una página simple offline. Nunca devolvemos contenido viejo si la red
 *    está disponible, porque los reportes cambian rápido.
 *  - Imágenes de reportes/desaparecidos (/api/.../photo): cache-first.
 *  - Tiles de OpenStreetMap: NO interceptados — Leaflet los carga como <img>
 *    (img-src https:). Interceptarlos con fetch() en el SW choca con connect-src
 *    y deja el mapa gris en navegadores con SW registrado.
 *  - Otros assets estáticos del propio dominio (_next/static, /icon-192.png,
 *    manifest, etc.): cache-first.
 *  - APIs JSON (/api/...): siempre network; si falla, devolvemos lo último
 *    cacheado por GET. No interceptamos POST/DELETE.
 *
 * Hosts cross-origin de la API:
 *  El backend vive en api.<dominio> (api-staging.<dominio> en staging; ver
 *  middleware.ts y NEXT_PUBLIC_API_URL). El SW intercepta las peticiones GET
 *  al host API igual que a las same-origin `/api/...` (necesario para mantener
 *  network-first con fallback offline). Las respuestas vienen con CORS
 *  habilitado, así que la Cache API las puede guardar sin restricciones de
 *  "opaque response".
 */

// v8: purga los caches de API v7 envenenados — un teléfono cuyo PRIMER fetch
// del día vencía el timeout (Neon frío de madrugada) recibía su snapshot de
// hace días como si fuera actual, y como el cache solo se actualizaba con un
// fetch EXITOSO, nunca sanaba (visto en producción: "15 reportadas" con 100
// personas en base). Ver networkFirst: ahora revalida en segundo plano.
// v9: añade el shell y los datos estáticos de /mapa-de-rescate, con un cache
// separado y timestamp. No intercepta ni almacena tiles de OSM/Esri.
importScripts("/sw-config.js");

const CFG = self.__MALLANET_SW_CONFIG || {
  cacheEpoch: 0,
  organizationId: "org_mallanet",
  incidentId: "inc_terremoto_colombia_2026",
  buildSha: "dev",
  cachePrefix: "mallanet-",
  cacheNames: {
    static: "mallanet-e0-org_mallanet-inc_terremoto_colombia_2026-static",
    photos: "mallanet-e0-org_mallanet-inc_terremoto_colombia_2026-photos",
    api: "mallanet-e0-org_mallanet-inc_terremoto_colombia_2026-api",
    html: "mallanet-e0-org_mallanet-inc_terremoto_colombia_2026-html",
    rescue: "mallanet-e0-org_mallanet-inc_terremoto_colombia_2026-rescue",
  },
  previousCacheNames: [
    "static-v9",
    "photos-v9",
    "api-v9",
    "html-v9",
    "rescue-data-v9",
  ],
  rescueDataPaths: [
    "/data/incidents/colombia-2026-08-10-san-jose-del-palmar.json",
    "/data/incidents/colombia-2026-08-10-emsr916-map.json",
  ],
  publicJsonPathPrefixes: [
    "/api/missing",
    "/api/deceased",
    "/api/pets",
    "/api/reports",
    "/api/hospitals",
    "/api/earthquakes",
    "/api/donations",
    "/api/acopio",
    "/api/hub",
    "/api/stats/psychology-help",
  ],
  publicJsonDenySubstrings: ["/patients", "/chat", "/photo"],
  privilegedHeaderNames: [
    "authorization",
    "cookie",
    "x-admin-token",
    "x-api-key",
    "x-incident-override",
  ],
};

const STATIC_CACHE = CFG.cacheNames.static;
const PHOTO_CACHE = CFG.cacheNames.photos;
const API_CACHE = CFG.cacheNames.api;
const HTML_CACHE = CFG.cacheNames.html;
const RESCUE_DATA_CACHE = CFG.cacheNames.rescue;

const KEEP_CACHES = new Set([
  STATIC_CACHE,
  PHOTO_CACHE,
  API_CACHE,
  HTML_CACHE,
  RESCUE_DATA_CACHE,
  ...CFG.previousCacheNames,
]);

const CORE_ASSETS = [
  "/favicon.svg",
  "/favicon.ico",
  "/favicon-32.png",
  "/favicon-64.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/brand/isotipo-oscuro.svg",
  "/brand/isotipo-claro.svg",
  "/manifest.webmanifest",
  "/mapa-de-rescate.webmanifest",
];
const CORE_PAGES = ["/", "/privacidad", "/mapa-de-rescate"];
const RESCUE_DATA_PATHS = CFG.rescueDataPaths;
// El precache de snapshots `/api/...` se eliminó al mover el backend a
// `api.<dominio>` (cross-origin): `cache.addAll` con una URL cross-origin sin
// CORS configurado falla y aborta el install. El `networkFirst` posterior se
// encarga de poblar el API cache con la primera respuesta real desde la app.
// Página de último recurso: se muestra solo si ni siquiera hay un "/" cacheado
// (caché fría o desalojada). Lleva embebidos los teléfonos de emergencia
// universales para que SIEMPRE haya números a la mano sin conexión.
// Mantener sincronizado con el grupo "Emergencias (línea directa)" de
// app/components/EmergencyContacts.tsx.
const OFFLINE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"/><title>Sin conexión</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:2rem 1rem;min-height:100vh;box-sizing:border-box}main{max-width:30rem;margin:0 auto;text-align:center}h1{margin:.5rem 0;font-size:1.25rem}p{color:#475569}.lead{max-width:28rem;margin:.5rem auto 1.5rem}.note{margin-top:1.5rem;font-size:.75rem;color:#64748b}</style></head><body><main><h1>🛰️ Sin conexión</h1><p class="lead">No hay internet en este momento. Si tienes una emergencia, contacta a los servicios de emergencia locales de tu país o región.</p><p class="note">Cuando vuelva la conexión podrás ver el mapa, reportar y consultar la lista completa de teléfonos de emergencia.</p></main></body></html>`;
// 8s: 2.5s era demasiado agresivo — abandonaba requests legítimos (un /api/missing
// frío ronda ~450ms pero bajo carga/cold-start podía pasar de 2.5s) y servía cache
// viejo mientras el fetch real seguía. Con el AbortController de fetchWithTimeout,
// un request lento ahora se CANCELA limpio al vencer, sin fugas.
const API_TIMEOUT_MS = 8000;
const NAVIGATION_TIMEOUT_MS = 4000;

async function precacheRescueData() {
  const cache = await caches.open(RESCUE_DATA_CACHE);
  await Promise.all(
    RESCUE_DATA_PATHS.map(async (path) => {
      try {
        const request = new Request(new URL(path, self.location.origin));
        const response = await fetch(request);
        if (response.ok) await putWithTimestamp(cache, request, response);
      } catch {
        // El install no se aborta si un asset puntual no está disponible.
      }
    }),
  );
}

async function precacheRouteShell(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) return;
    const htmlCache = await caches.open(HTML_CACHE);
    await htmlCache.put(path, response.clone());

    // Next inyecta los chunks content-hashed del route en el HTML. Guardarlos
    // permite reabrir el mapa tras la primera instalación aun con caché HTTP
    // vacía. Solo se aceptan assets same-origin; no se descargan tiles ni CDN.
    const html = await response.text();
    const staticCache = await caches.open(STATIC_CACHE);
    const assetUrls = new Set();
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const raw = match[1]?.replaceAll("&amp;", "&");
      if (!raw) continue;
      const url = new URL(raw, self.location.origin);
      if (
        url.origin === self.location.origin &&
        url.pathname.startsWith("/_next/static/")
      ) {
        assetUrls.add(url.href);
      }
    }
    await Promise.all(
      [...assetUrls].map(async (href) => {
        try {
          const asset = await fetch(href);
          if (asset.ok) await staticCache.put(href, asset);
        } catch {
          // Un chunk faltante se volverá a solicitar en la próxima visita.
        }
      }),
    );
  } catch {
    // La navegación conserva el fallback HTML genérico si el shell falla.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(STATIC_CACHE)
        .then((cache) => cache.addAll(CORE_ASSETS).catch(() => {})),
      caches
        .open(HTML_CACHE)
        .then((cache) => cache.addAll(CORE_PAGES).catch(() => {})),
      precacheRescueData(),
      precacheRouteShell("/mapa-de-rescate"),
    ])
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (KEEP_CACHES.has(key)) return null;
            if (!key.startsWith(CFG.cachePrefix)) return null;
            return caches.delete(key);
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isPrivilegedRequest(request) {
  return CFG.privilegedHeaderNames.some((name) => {
    const value = request.headers.get(name);
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isPublicJsonPath(pathname) {
  if (CFG.publicJsonDenySubstrings.some((part) => pathname.includes(part))) {
    return false;
  }
  return CFG.publicJsonPathPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isPhotoApi(url) {
  return (
    url.pathname.startsWith("/api/missing/") && url.pathname.endsWith("/photo")
  ) || (
    url.pathname.startsWith("/api/reports/") && url.pathname.endsWith("/photo")
  );
}

// Reconoce las peticiones que apuntan a la superficie `/api/...`, sea en el
// mismo origen (dev/legado) o en el subdominio API cross-origin
// (`api.<dominio>` en producción, `api-staging.<dominio>` en staging). Espejo
// de la heurística de `frontend/middleware.ts` para mantener un solo criterio
// de "esto es API".
function isApiRequest(url) {
  if (!url.pathname.startsWith("/api/")) return false;
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin) return true;
  // Cross-origin: solo si el host empieza con `api.` o `api-staging.` (puerto
  // incluido). `api-staging.` es hermano de `api.`, no hijo: sin el segundo
  // prefijo, staging nunca ejercitaba estas rutas de intercepción del SW y no
  // probaba lo que producción sí ejecuta.
  return url.host.startsWith("api.") || url.host.startsWith("api-staging.");
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  // ignoreVary: las respuestas de foto llevan `Vary: Origin` (CORS del backend);
  // sin esto, un match estricto puede fallar según qué cabeceras llevó el request.
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    // Re-emitimos el request en modo CORS en vez de reenviarlo tal cual: las
    // fotos se piden desde <img> cross-origin SIN `crossorigin`, y ese request
    // no-cors produce una respuesta OPACA (status 0, ok false) aunque el backend
    // devuelva 200. Gatear cache.put por `ok` con opacas dejaba photos-v7 vacío
    // para siempre (medido: 0 entradas tras cargar 32 fotos) y mataba el modo
    // offline de fotos. El backend ya responde con Access-Control-Allow-Origin
    // (verificado en prod y staging), así que en modo CORS el status es visible:
    // cacheamos SOLO 200s reales y jamás un error transitorio (una opaca cacheada
    // de un 500 frío sería una foto rota permanente). Same-origin (_next/static,
    // iconos) no cambia: mode cors ahí produce respuestas "basic" normales.
    // Y con timeout, como TODAS las demás estrategias del fichero: un backend
    // frío puede tardar >28s en la primera foto y sin límite el respondWith()
    // queda colgado en vez de degradar.
    const fresh = await fetchWithTimeout(
      new Request(request.url, { mode: "cors" }),
      API_TIMEOUT_MS,
    );
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    // El fetch CORS falló: red caída, timeout, o un origen que no manda ACAO
    // (p.ej. un redirect de foto a un CDN externo). Último intento con el
    // request original no-cors — es lo que hacía siempre este SW: la opaca se
    // devuelve SIN cachear (no podemos ver su status) pero el <img> la pinta.
    try {
      return await fetchWithTimeout(request, API_TIMEOUT_MS);
    } catch {
      // NUNCA propagamos el throw: `respondWith` con una promesa rechazada
      // genera "Uncaught (in promise): Failed to fetch" en consola y deja el
      // recurso en error igual. Devolvemos un 503 normal: el `<img>` queda roto
      // (como sin SW) pero sin ruido ni rechazo suelto.
      return new Response("", { status: 503, statusText: "sw-fetch-failed" });
    }
  }
}

// Guarda la respuesta con sello de CUÁNDO se cacheó: es lo que permite decirle
// a la app "esto es de hace X" cuando toca servir respaldo.
async function putWithTimestamp(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set("x-sw-cached-at", String(Date.now()));
  const body = await response.arrayBuffer();
  await cache.put(
    request,
    new Response(body, { status: response.status, statusText: response.statusText, headers }),
  );
}

// Al servir respaldo, inyecta `__swStaleAt` (epoch-ms de cuándo se cacheó) en
// cuerpos JSON de tipo objeto, para que la UI pueda AVISAR que los datos no
// son actuales en vez de presentarlos como frescos. En un directorio de
// personas desaparecidas, un "encontrada/desaparecida" congelado de hace días
// mostrado como actual es un dato falso — el aviso es parte del contrato.
async function markStale(cached) {
  const cachedAt = Number(cached.headers.get("x-sw-cached-at")) || null;
  const contentType = cached.headers.get("content-type") || "";
  if (!cachedAt || !contentType.includes("application/json")) return cached;
  try {
    const body = await cached.clone().json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return cached;
    body.__swStaleAt = cachedAt;
    const headers = new Headers(cached.headers);
    headers.set("x-sw-stale", "1");
    headers.delete("content-length");
    return new Response(JSON.stringify(body), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  } catch {
    return cached;
  }
}

async function responseVersion(response) {
  const headerVersion =
    response.headers.get("etag") || response.headers.get("last-modified");
  if (headerVersion) return headerVersion;
  try {
    const body = await response.clone().json();
    return body.lastCheckedAt || body.lastVerifiedAt || body.schemaVersion || null;
  } catch {
    return null;
  }
}

async function notifyRescueDataUpdate(request, previous, fresh) {
  if (!previous) return;
  const [previousVersion, freshVersion] = await Promise.all([
    responseVersion(previous),
    responseVersion(fresh),
  ]);
  if (!freshVersion || previousVersion === freshVersion) return;
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({
      type: "rescue-map-data-updated",
      url: request.url,
    });
  }
}

async function networkFirst(
  event,
  request,
  cacheName,
  notifyOnUpdate = false,
) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetchWithTimeout(request, API_TIMEOUT_MS);
    if (fresh.ok) {
      const previous = notifyOnUpdate ? await cache.match(request) : null;
      await putWithTimestamp(cache, request, fresh.clone());
      if (notifyOnUpdate) {
        await notifyRescueDataUpdate(request, previous, fresh.clone());
      }
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      // ROMPE EL CICLO VICIOSO: sin esto, un backend frío que vence el timeout
      // en la primera visita del día servía el snapshot viejo Y el cache jamás
      // se actualizaba (solo se escribía en fetch exitoso), así que TODAS las
      // visitas siguientes repetían el dato congelado. La revalidación en
      // segundo plano usa un timeout amplio (el arranque en frío de Neon puede
      // superar los 8 s), repuebla el cache al terminar y de paso CALIENTA el
      // backend para el siguiente poll de la app (60 s).
      event.waitUntil(
        fetchWithTimeout(new Request(request.url), 30_000)
          .then(async (late) => {
            if (!late.ok) return null;
            const previous = notifyOnUpdate ? await cache.match(request) : null;
            await putWithTimestamp(cache, request, late.clone());
            if (notifyOnUpdate) {
              await notifyRescueDataUpdate(request, previous, late);
            }
            return null;
          })
          .catch(() => {}),
      );
      return markStale(cached);
    }
    // Sin red y sin caché: degradamos con una respuesta JSON sintética en vez de
    // propagar el error. Si hiciéramos `throw`, `event.respondWith()` recibiría una
    // promesa rechazada y el navegador filtraría "FetchEvent.respondWith received an
    // error: …" a la UI. Con un 503 normal, la app ve `!res.ok` y muestra su propio
    // mensaje amable.
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

// AbortController real: al vencer el timeout, CANCELA el fetch — no solo pierde
// la carrera. Sin esto, un Promise.race dejaba el fetch huérfano corriendo en
// segundo plano (se veían respuestas de 15s en DevTools iniciadas por sw.js aun
// cuando el SW ya había devuelto cache a los 2.5s): bandwidth desperdiciado y
// el pool de conexiones agotado por requests que nadie consume.
function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // 1. Navegaciones HTML: NETWORK-FIRST. Quien entra con conexión SIEMPRE recibe
  // la versión fresca del servidor — nunca servimos HTML cacheado estando online,
  // así el contenido (reportes, rediseño, deploys) jamás queda "pegado" en cache.
  // El cache de HTML solo se usa como respaldo SIN conexión (app de emergencia:
  // debe abrir aunque no haya red), y como último recurso el HTML offline con los
  // teléfonos de emergencia.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(HTML_CACHE);
        try {
          const fresh = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
          if (fresh.ok) {
            // Refresca el respaldo offline, pero la respuesta servida es la fresca.
            cache.put(request, fresh.clone());
            return fresh;
          }
        } catch {
          // Sin red: caemos al respaldo cacheado abajo.
        }
        const cached = await cache.match(request);
        if (cached) return cached;
        const cachedHome = await cache.match("/");
        if (cachedHome) return cachedHome;
        return new Response(OFFLINE_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      })(),
    );
    return;
  }

  // Resto: manejamos same-origin (assets/tiles) y el subdominio API cross-origin.
  const sameOrigin = url.origin === self.location.origin;
  const apiRequest = isApiRequest(url);

  // 2. Fotos de reportes/desaparecidos: cache-first (no cambian).
  if (apiRequest && isPhotoApi(url)) {
    event.respondWith(cacheFirst(request, PHOTO_CACHE));
    return;
  }

  // 3. APIs JSON anónimas de la allowlist: network-first con cache de respaldo.
  //    No interceptamos chat, patients, fotos JSON, ni peticiones con cookie,
  //    Authorization u otros headers privilegiados.
  if (
    apiRequest &&
    !isPrivilegedRequest(request) &&
    isPublicJsonPath(url.pathname)
  ) {
    event.respondWith(networkFirst(event, request, API_CACHE));
    return;
  }
  if (apiRequest) {
    return;
  }

  // 4. Datos estáticos del mapa de rescate: network-first, timestamp y aviso
  //    cuando llega una versión nueva. Nunca se presentan como actuales si se
  //    sirven desde cache.
  if (sameOrigin && RESCUE_DATA_PATHS.includes(url.pathname)) {
    event.respondWith(
      networkFirst(event, request, RESCUE_DATA_CACHE, true),
    );
    return;
  }

  // 5. Assets estáticos de Next y públicos: cache-first.
  if (
    sameOrigin &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname === "/favicon.svg" ||
      url.pathname === "/favicon.ico" ||
      url.pathname === "/favicon-32.png" ||
      url.pathname === "/favicon-64.png" ||
      url.pathname === "/apple-touch-icon.png" ||
      url.pathname === "/icon-192.png" ||
      url.pathname === "/icon-512.png" ||
      url.pathname === "/manifest.webmanifest" ||
      url.pathname === "/mapa-de-rescate.webmanifest" ||
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".css") ||
      url.pathname.endsWith(".js"))
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
});
