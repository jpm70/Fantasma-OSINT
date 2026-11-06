import sherlockSitesData from '../data/sherlockSites.json';
import {
  ApiCredentials,
  ContextHints,
  GeoMarker,
  GraphNode,
  InputType,
  InvestigationCase,
  InvestigationLog,
  ManualTask,
  ProfileEvidence,
  RetryTaskStatus,
  SherlockSite,
  SiteCheck,
  TimelineEvent,
} from '../types/osint';
import {
  extractUsernameRoot,
  generateAliasFamilies,
  identityBand,
  rescoreProfiles,
  scoreEvidence,
  sourceConfidence,
} from './aliasAndConfidenceEngine';
import { resolvePlace } from '../engine/geo';
import { analyzePhone, dialCodeCapital } from '../engine/phone';
import { validateSpanishId } from '../engine/nationalId';
import { safeHttpUrl, sha256Hex } from '../engine/integrity';

export const SHERLOCK_SITES: SherlockSite[] = sherlockSitesData as SherlockSite[];

/** Compatibilidad: ubicación escrita → coordenadas. */
export function resolveCoordinatesFromText(text?: string) {
  const p = resolvePlace(text);
  return p ? { lat: p.lat, lng: p.lng, label: p.label, countryCode: p.countryCode } : null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isValidIpv4(q: string): boolean {
  return IPV4.test(q.trim());
}

/** IPv4 privada, reservada o de documentación: no tiene datos públicos que consultar. */
export function isNonPublicIpv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 || a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
  );
}

/**
 * Detecta el tipo de entrada a partir del texto.
 */
export function detectInputType(raw: string): InputType {
  const q = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return 'email';
  if (isValidIpv4(q)) return 'ip';
  if (/^[0-9]{8}[A-Za-z]$/.test(q) || /^[XYZKLMxyzklm][0-9]{7}[A-Za-z]$/.test(q)) return 'national_id';
  if (/^\+?[0-9\s()-]{8,18}$/.test(q) && q.replace(/\D/g, '').length >= 8) return 'phone';
  if (/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/.test(q) && !q.includes(' ')) return 'domain';
  if (q.includes(' ') && /^[a-zA-ZáéíóúüÁÉÍÓÚÜñÑ\s.'-]+$/.test(q)) return 'real_name';
  return 'username';
}

export function seedNodeIdFor(query: string): string {
  return `seed-${query.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

function nowTimeStr(): string {
  return new Date().toTimeString().split(' ')[0];
}

/** URL a través del proxy propio. Sin proxy configurado devuelve null. */
export function buildProxiedUrl(targetUrl: string, corsProxy: string): string | null {
  const proxy = (corsProxy || '').trim();
  if (!proxy) return null;
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(targetUrl));
  if (proxy.endsWith('=') || proxy.endsWith('?')) return `${proxy}${encodeURIComponent(targetUrl)}`;
  return `${proxy}${targetUrl}`;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface FetchResult {
  ok: boolean;
  status: number;
  data: any;
  text: string;
  retriesUsed: number;
  /** 0 = error de red o bloqueo CORS (el navegador no deja leer la respuesta). */
  blockedReason?: ManualTask['reason'];
}

/**
 * fetch con reintentos ante 429/503 (espera creciente) y tiempo máximo por petición.
 * Con useProxy la petición pasa por el proxy propio; si no hay proxy no se hace.
 */
export async function fetchWithSmartRetries(options: {
  url: string;
  platform: string;
  useProxy?: boolean;
  corsProxy: string;
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  onRetryStatus?: (status: RetryTaskStatus) => void;
}): Promise<FetchResult> {
  const { url, platform, useProxy = false, corsProxy, method = 'GET', body, headers = {}, maxRetries = 2, timeoutMs = 8000, backoffMs = 1400, onRetryStatus } = options;
  const fetchUrl = useProxy ? buildProxiedUrl(url, corsProxy) : url;
  if (!fetchUrl) return { ok: false, status: 0, data: null, text: '', retriesUsed: 0, blockedReason: 'CORS_BLOCKED' };

  const taskId = `retry-${platform}-${Math.random().toString(36).slice(2, 8)}`;
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(fetchUrl, { method, body, headers: { Accept: 'application/json, text/plain, */*', ...headers }, signal: controller.signal });
      clearTimeout(timer);
      if ((response.status === 429 || response.status === 503) && attempt < maxRetries) {
        attempt++;
        const waitMs = backoffMs * 2 ** (attempt - 1);
        onRetryStatus?.({ id: taskId, platform, url, attempt, maxAttempts: maxRetries, nextRetryMs: waitMs, status: 'retrying' });
        await sleep(waitMs);
        continue;
      }
      const text = await response.text();
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (response.status === 429 || response.status === 503) {
        onRetryStatus?.({ id: taskId, platform, url, attempt, maxAttempts: maxRetries, nextRetryMs: 0, status: 'moved_to_manual' });
        return { ok: false, status: response.status, data, text, retriesUsed: attempt, blockedReason: 'HTTP_429' };
      }
      if (attempt > 0) onRetryStatus?.({ id: taskId, platform, url, attempt, maxAttempts: maxRetries, nextRetryMs: 0, status: 'resolved' });
      return { ok: response.ok, status: response.status, data, text, retriesUsed: attempt };
    } catch {
      clearTimeout(timer);
      // Un fallo de red o de CORS no mejora reintentando: se devuelve como bloqueado
      return { ok: false, status: 0, data: null, text: '', retriesUsed: attempt, blockedReason: 'CORS_BLOCKED' };
    }
  }
}

/** Ejecuta tareas con un máximo de peticiones simultáneas. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export interface ScanCallbacks {
  onLog: (log: InvestigationLog) => void;
  onRetryStatus: (status: RetryTaskStatus) => void;
  onCaseProgress: (updatedCase: InvestigationCase) => void;
}

/** Datos de perfil de cada API directa. null = la API responde pero el usuario no existe. */
export function parseDirectProfile(site: SherlockSite, data: any, username: string): (ProfileEvidence & { created?: string; extra: Record<string, string | number> }) | null {
  const extra: Record<string, string | number> = {};
  const strip = (s?: string) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const day = (v?: string | number, mult = 1) => (v ? new Date(typeof v === 'number' ? v * mult : v).toISOString().slice(0, 10) : undefined);
  if (!data) return null;
  switch (site.name) {
    case 'GitHub':
      if (!data.login) return null;
      extra.reposPublicos = data.public_repos ?? 0;
      extra.seguidores = data.followers ?? 0;
      extra.tipoCuenta = data.type === 'Organization' ? 'Organización' : 'Usuario';
      return { handle: data.login, displayName: data.name || undefined, bio: data.bio || undefined, location: data.location || undefined, website: data.blog || undefined, created: day(data.created_at), extra };
    case 'GitLab': {
      const u = Array.isArray(data) ? data[0] : null;
      if (!u) return null;
      extra.estado = u.state || 'active';
      return { handle: u.username, displayName: u.name || undefined, extra };
    }
    case 'Dev.to':
      if (!data.username) return null;
      return { handle: data.username, displayName: data.name || undefined, bio: data.summary || undefined, location: data.location || undefined, website: data.website_url || undefined, created: day(data.joined_at), extra };
    case 'HackerNews':
      if (!data.id) return null;
      extra.karma = data.karma ?? 0;
      return { handle: data.id, bio: strip(data.about) || undefined, created: day(data.created, 1000), extra };
    case 'Keybase': {
      const kb = data.them?.[0];
      if (!kb?.basics?.username) return null;
      return { handle: kb.basics.username, displayName: kb.profile?.full_name || undefined, bio: kb.profile?.bio || undefined, location: kb.profile?.location || undefined, extra };
    }
    case 'Lichess':
      if (!data.username || data.disabled) return null;
      return { handle: data.username, displayName: [data.profile?.firstName, data.profile?.lastName].filter(Boolean).join(' ') || undefined, bio: data.profile?.bio || undefined, location: data.profile?.location || data.profile?.country || undefined, created: day(data.createdAt, 1), extra };
    case 'Chess.com':
      if (!data.username) return null;
      return { handle: data.username, displayName: data.name || undefined, location: data.location || undefined, created: day(data.joined, 1000), extra };
    case 'Bluesky':
      if (!data.handle) return null;
      extra.seguidores = data.followersCount ?? 0;
      return { handle: data.handle.replace(/\.bsky\.social$/, ''), displayName: data.displayName || undefined, bio: data.description || undefined, created: day(data.createdAt), extra };
    default:
      if (site.name.startsWith('Crates.io')) {
        if (!data.user?.login) return null;
        return { handle: data.user.login, displayName: data.user.name || undefined, website: data.user.url || undefined, extra };
      }
      if (site.name.startsWith('Mastodon')) {
        if (!data.acct) return null;
        return { handle: data.username, displayName: data.display_name || undefined, bio: strip(data.note) || undefined, website: data.fields?.find((f: any) => /https?:/.test(strip(f.value)))?.value?.replace(/<[^>]+>/g, '') || undefined, created: day(data.created_at), extra };
      }
      return { handle: username, extra };
  }
}

/**
 * Orquestador: lanza la investigación según el tipo de entrada y va rellenando el grafo,
 * la línea de tiempo, el mapa y la cola de verificación manual.
 */
export async function executeOsintInvestigation(params: {
  currentCase: InvestigationCase;
  query: string;
  inputType: InputType;
  hints: ContextHints;
  credentials: ApiCredentials;
  callbacks: ScanCallbacks;
  /** Espera base entre reintentos (en los tests se reduce). */
  backoffMs?: number;
}): Promise<InvestigationCase> {
  const { currentCase, query, inputType, hints, credentials, callbacks, backoffMs = 1400 } = params;
  const cleanQuery = query.trim();
  const isFirstQuery = !currentCase.nodes.some((n) => n.type !== 'seed');
  const workingCase: InvestigationCase = {
    ...currentCase,
    // La semilla del caso es la primera búsqueda; las siguientes son pivotes
    seedQuery: isFirstQuery ? cleanQuery : currentCase.seedQuery,
    seedType: isFirstQuery ? inputType : currentCase.seedType,
    contextHints: { ...currentCase.contextHints, ...hints },
    nodes: isFirstQuery ? currentCase.nodes.filter((n) => n.type !== 'seed') : [...currentCase.nodes],
    edges: [...currentCase.edges],
    timeline: [...currentCase.timeline],
    locations: [...currentCase.locations],
    manualTasks: [...currentCase.manualTasks],
    aliasVariants: [...currentCase.aliasVariants],
    logs: [...currentCase.logs],
    updatedAt: new Date().toISOString(),
  };
  const proxyReady = !!credentials.corsProxy?.trim();
  const keysViaProxy = proxyReady && credentials.allowKeysThroughProxy;
  const get = (url: string, platform: string, extra: Partial<Parameters<typeof fetchWithSmartRetries>[0]> = {}) =>
    fetchWithSmartRetries({ url, platform, corsProxy: credentials.corsProxy, onRetryStatus: callbacks.onRetryStatus, backoffMs, maxRetries: 1, ...extra });

  const addLog = (module: string, message: string, level: InvestigationLog['level'] = 'info') => {
    const entry: InvestigationLog = { id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: nowTimeStr(), module, message, level };
    workingCase.logs = [entry, ...workingCase.logs.slice(0, 149)];
    callbacks.onLog(entry);
  };
  const upsertNode = (node: GraphNode) => {
    const idx = workingCase.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) {
      const prev = workingCase.nodes[idx];
      workingCase.nodes[idx] = { ...prev, ...node, verifiedStatus: prev.analystReviewed ? prev.verifiedStatus : node.verifiedStatus, analystReviewed: prev.analystReviewed };
    } else workingCase.nodes.push(node);
  };
  const upsertEdge = (source: string, target: string, relation: string, weight = 2) => {
    if (source === target) return;
    const id = `edge-${source}-${target}`;
    if (!workingCase.edges.some((e) => e.id === id)) workingCase.edges.push({ id, source, target, relation, weight });
  };
  const addTimeline = (ev: TimelineEvent) => {
    if (!workingCase.timeline.some((t) => t.id === ev.id || (t.title === ev.title && t.date === ev.date))) {
      workingCase.timeline.push(ev);
      workingCase.timeline.sort((a, b) => a.date.localeCompare(b.date));
    }
  };
  const addLocation = (loc: GeoMarker) => {
    if (!workingCase.locations.some((l) => l.id === loc.id)) workingCase.locations.push(loc);
  };
  const addManualTask = (task: Omit<ManualTask, 'id' | 'timestamp' | 'status'>) => {
    if (!workingCase.manualTasks.some((m) => m.url === task.url)) {
      workingCase.manualTasks.unshift({ ...task, id: `mt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, timestamp: new Date().toISOString(), status: 'pending' });
    }
  };
  const progress = () => callbacks.onCaseProgress({ ...workingCase, nodes: [...workingCase.nodes] });
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  // Nodo de la búsqueda (semilla o pivote)
  const seedNodeId = seedNodeIdFor(cleanQuery);
  const mainSeedId = seedNodeIdFor(workingCase.seedQuery);
  upsertNode({
    id: seedNodeId,
    label: cleanQuery,
    subtitle: isFirstQuery || seedNodeId === mainSeedId ? `Semilla (${inputType})` : `Pivote (${inputType})`,
    type: 'seed',
    platform: 'Entrada del analista',
    category: 'Semilla',
    aliasFamily: 'Raíz exacta',
    confidence: sourceConfidence(100, 'Punto de partida definido por el analista'),
    verifiedStatus: 'verified',
    pivot: { query: cleanQuery, type: inputType },
    metadata: { tipo: inputType, busqueda: cleanQuery, fecha: new Date().toISOString() },
  });
  if (seedNodeId !== mainSeedId && workingCase.nodes.some((n) => n.id === mainSeedId)) upsertEdge(mainSeedId, seedNodeId, 'pivote', 2);

  if (inputType === 'username' || inputType === 'email' || inputType === 'real_name') {
    const generated = generateAliasFamilies(cleanQuery, workingCase.contextHints);
    for (const av of generated) if (!workingCase.aliasVariants.some((x) => x.variant === av.variant)) workingCase.aliasVariants.push(av);
    addLog('Familias de alias', `${generated.length} variantes generadas para la raíz «${extractUsernameRoot(cleanQuery)}».`, 'success');
  }
  progress();

  // ==========================================================================
  // 1. USUARIO: APIs con CORS, sitios por proxy propio y verificación manual
  // ==========================================================================
  if (inputType === 'username') {
    const username = cleanQuery.replace(/^@/, '');
    const checks: SiteCheck[] = [];
    addLog('Usuarios', `Comprobando «${username}» en ${SHERLOCK_SITES.length} sitios del catálogo.`, 'info');

    const addProfile = (site: SherlockSite, ev: ProfileEvidence, profileUrl: string, created?: string, extra: Record<string, string | number> = {}) => {
      const nodeId = `node-${slug(site.name)}-${slug(ev.handle)}`;
      const conf = scoreEvidence(workingCase.seedQuery, ev, workingCase.contextHints);
      const place = resolvePlace(ev.location);
      upsertNode({
        id: nodeId,
        label: `${site.name}: ${ev.handle}`,
        subtitle: ev.displayName ? `${ev.displayName} · ${site.category}` : site.category,
        type: 'social_profile',
        platform: site.name,
        category: site.category,
        aliasFamily: ev.handle.toLowerCase() === workingCase.seedQuery.toLowerCase().replace(/^@/, '') ? 'Raíz exacta' : 'Variante',
        url: profileUrl,
        timestamp: created,
        coordinates: place ? { lat: place.lat, lng: place.lng, label: `${place.label} (${site.name})` } : undefined,
        confidence: conf,
        evidence: ev,
        pivot: { query: ev.handle, type: 'username' },
        verifiedStatus: 'unverified',
        metadata: {
          plataforma: site.name,
          usuario: ev.handle,
          nombreVisible: ev.displayName || 'N/D',
          biografia: ev.bio || 'N/D',
          ubicacion: ev.location || 'N/D',
          web: ev.website || 'N/D',
          creacion: created || 'N/D',
          ...extra,
        },
      });
      upsertEdge(seedNodeId, nodeId, `perfil en ${site.name}`, 3);
      if (created) {
        addTimeline({ id: `tl-${nodeId}`, date: created, title: `Alta en ${site.name} (@${ev.handle})`, description: ev.bio ? `Bio: «${ev.bio.slice(0, 110)}»` : `Cuenta pública en ${site.name}.`, category: 'account', sourcePlatform: site.name, sourceUrl: profileUrl, nodeId, confidence: conf.total });
      }
      if (place) {
        addLocation({ id: `geo-${nodeId}`, lat: place.lat, lng: place.lng, title: `${place.label} — ${site.name}`, subtitle: `Ubicación escrita en el perfil @${ev.handle}: «${ev.location}»${place.precision === 'country' ? ' (solo el país: se marca la capital)' : ''}`, category: 'profile_location', confidence: conf.total, nodeId, source: site.name, countryCode: place.countryCode });
      }
    };

    // 1A. APIs que admiten CORS
    const direct = SHERLOCK_SITES.filter((s) => s.probeMode === 'direct_json');
    await mapLimit(direct, 4, async (site) => {
      const probeUrl = (site.probeUrlTemplate || site.urlTemplate).replace(/\{username\}/g, encodeURIComponent(username));
      const profileUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(username));
      const res = await get(probeUrl, site.name);
      const parsed = res.ok ? parseDirectProfile(site, res.data, username) : null;
      if (parsed) {
        const { created, extra, ...ev } = parsed;
        addProfile(site, ev, profileUrl, created, extra);
        checks.push({ site: site.name, url: profileUrl, result: 'found', httpStatus: res.status, detail: 'Perfil devuelto por la API' });
      } else if (res.ok || res.status === 404 || res.status === 400) {
        checks.push({ site: site.name, url: profileUrl, result: 'not_found', httpStatus: res.status, detail: 'La API responde que no existe' });
      } else {
        const detail = res.status === 0 ? 'Sin respuesta legible (red o CORS)' : res.status === 403 || res.status === 429 ? `Límite de peticiones o bloqueo (HTTP ${res.status})` : `Error HTTP ${res.status}`;
        checks.push({ site: site.name, url: profileUrl, result: 'unknown', httpStatus: res.status || undefined, detail });
        addManualTask({ platform: site.name, url: profileUrl, target: username, reason: res.status === 429 || res.status === 403 ? 'HTTP_429' : 'CORS_BLOCKED', httpStatus: res.status || undefined, retriesAttempted: res.retriesUsed, notes: `${detail}: compruébalo abriendo el enlace.` });
      }
      progress();
    });

    // 1B. Sitios sin CORS: por el proxy propio si lo hay; si no, a la cola manual
    const viaProxy = SHERLOCK_SITES.filter((s) => s.probeMode === 'proxy_status' || s.probeMode === 'proxy_message');
    if (proxyReady && credentials.useCorsProxyForSherlock) {
      await mapLimit(viaProxy, 4, async (site) => {
        const profileUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(username));
        const probeUrl = (site.probeUrlTemplate || site.urlTemplate).replace(/\{username\}/g, encodeURIComponent(username));
        const res = await get(probeUrl, site.name, { useProxy: true, timeoutMs: 9000 });
        const hasError = site.probeMode === 'proxy_message' && !!site.errorMsg && res.text.toLowerCase().includes(site.errorMsg.toLowerCase());
        if (res.status === 200 && !hasError) {
          addProfile(site, { handle: username, statusOnly: true }, profileUrl, undefined, { metodo: 'Código HTTP 200 a través del proxy' });
          checks.push({ site: site.name, url: profileUrl, result: 'found', httpStatus: 200, detail: 'HTTP 200 (solo código: sin datos del perfil)' });
        } else if (res.status === 404 || hasError) {
          checks.push({ site: site.name, url: profileUrl, result: 'not_found', httpStatus: res.status, detail: hasError ? 'La página indica que no existe' : 'HTTP 404' });
        } else {
          const detail = res.status ? `HTTP ${res.status} a través del proxy` : 'El proxy no respondió';
          checks.push({ site: site.name, url: profileUrl, result: 'unknown', httpStatus: res.status || undefined, detail });
          addManualTask({ platform: site.name, url: profileUrl, target: username, reason: res.status === 429 ? 'HTTP_429' : 'CORS_BLOCKED', httpStatus: res.status || undefined, retriesAttempted: res.retriesUsed, notes: `${detail}: compruébalo abriendo el enlace.` });
        }
        progress();
      });
    } else {
      for (const site of viaProxy) {
        const profileUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(username));
        checks.push({ site: site.name, url: profileUrl, result: 'manual', detail: 'No admite CORS: sin proxy propio, hay que abrirlo a mano' });
        addManualTask({ platform: site.name, url: profileUrl, target: username, reason: 'CORS_BLOCKED', retriesAttempted: 0, notes: 'El navegador no puede consultar este sitio sin un proxy propio. Abre el enlace: si el perfil carga, márcalo como encontrado.' });
      }
    }

    // 1C. Sitios que solo se pueden comprobar a mano
    for (const site of SHERLOCK_SITES.filter((s) => s.probeMode === 'manual')) {
      const profileUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(username));
      checks.push({ site: site.name, url: profileUrl, result: 'manual', detail: site.manualReason || 'Solo verificable a mano' });
      addManualTask({ platform: site.name, url: profileUrl, target: username, reason: 'WAF_CHALLENGE', retriesAttempted: 0, notes: `${site.manualReason || 'Solo verificable a mano.'} Abre el enlace y comprueba si el perfil existe.` });
    }

    const found = checks.filter((c) => c.result === 'found').length;
    const missing = checks.filter((c) => c.result === 'not_found').length;
    const pending = checks.length - found - missing;
    addLog('Usuarios', `«${username}»: ${found} encontrado${found === 1 ? '' : 's'}, ${missing} no existe${missing === 1 ? '' : 'n'} y ${pending} por comprobar a mano.`, found ? 'success' : 'info');
    workingCase.siteChecks = checks.sort((a, b) => a.site.localeCompare(b.site));
    workingCase.siteChecksFor = username;
    workingCase.aliasVariants = workingCase.aliasVariants.map((v) => (v.variant === username.toLowerCase() ? { ...v, tested: true, hitsCount: found } : v));
  }

  // ==========================================================================
  // 2. CORREO: brechas, MX/SPF/DMARC, OpenPGP y Gravatar
  // ==========================================================================
  if (inputType === 'email') {
    const email = cleanQuery.toLowerCase();
    const [localPart, emailDomain] = email.split('@');
    addLog('Correo', `Analizando «${email}».`, 'info');

    if (localPart) {
      const handleNodeId = `node-email-handle-${slug(localPart)}`;
      upsertNode({ id: handleNodeId, label: `Alias: ${localPart}`, subtitle: 'Parte local del correo', type: 'username', platform: 'Extractor de correo', category: 'Identidad', aliasFamily: 'Raíz exacta', confidence: sourceConfidence(100, 'Extraído literalmente del correo'), pivot: { query: localPart, type: 'username' }, verifiedStatus: 'verified', metadata: { alias: localPart, dominio: emailDomain || 'N/D' } });
      upsertEdge(seedNodeId, handleNodeId, 'contiene el alias', 3);
    }

    // 2A. XposedOrNot (sin clave, con CORS)
    const xon = await get(`https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`, 'XposedOrNot');
    if (xon.ok && xon.data) {
      const raw = xon.data?.breaches;
      const breaches: string[] = Array.isArray(raw?.[0]) ? raw[0] : Array.isArray(raw) ? raw : [];
      if (breaches.length) {
        addLog('XposedOrNot', `El correo aparece en ${breaches.length} brecha(s) públicas.`, 'warning');
        for (const name of breaches.slice(0, 15)) {
          const bId = `node-breach-${slug(name)}`;
          upsertNode({ id: bId, label: `Brecha: ${name}`, subtitle: 'Registrada en XposedOrNot', type: 'breach', platform: 'XposedOrNot', category: 'Brechas', aliasFamily: 'Incidentes', confidence: sourceConfidence(90, `El correo figura en la brecha ${name} según XposedOrNot`), verifiedStatus: 'verified', metadata: { brecha: name, correo: email, fuente: 'api.xposedornot.com' } });
          upsertEdge(seedNodeId, bId, 'expuesto en brecha', 3);
        }
      } else addLog('XposedOrNot', 'Sin brechas registradas.', 'success');
    } else if (xon.status === 404) addLog('XposedOrNot', 'Sin brechas registradas (404).', 'success');
    else addLog('XposedOrNot', `No se pudo consultar (${xon.status ? `HTTP ${xon.status}` : 'sin respuesta'}).`, 'warning');

    // 2B. Have I Been Pwned: no admite CORS; solo por proxy propio y con permiso para enviar la clave
    if (credentials.hibpKey) {
      if (!keysViaProxy) addLog('HIBP', 'Omitido: la API de HIBP no admite llamadas desde el navegador. Necesita tu proxy propio y permitir enviar claves por él.', 'warning');
      else {
        const hibp = await get(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`, 'Have I Been Pwned', { useProxy: true, headers: { 'hibp-api-key': credentials.hibpKey } });
        if (hibp.ok && Array.isArray(hibp.data)) {
          for (const b of hibp.data.slice(0, 15)) {
            const bId = `node-hibp-${slug(b.Name || 'brecha')}`;
            upsertNode({ id: bId, label: `HIBP: ${b.Title || b.Name}`, subtitle: `Brecha del ${b.BreachDate || 'N/D'}`, type: 'breach', platform: 'Have I Been Pwned', category: 'Brechas', aliasFamily: 'Incidentes', timestamp: b.BreachDate, confidence: sourceConfidence(95, `Brecha ${b.Name} confirmada por la API de HIBP`), verifiedStatus: 'verified', metadata: { dominio: b.Domain || 'N/D', fecha: b.BreachDate || 'N/D', cuentasAfectadas: b.PwnCount || 0, datos: (b.DataClasses || []).join(', ') } });
            upsertEdge(seedNodeId, bId, 'brecha (HIBP)', 3);
            if (b.BreachDate) addTimeline({ id: `tl-${bId}`, date: b.BreachDate, title: `Brecha ${b.Title || b.Name}`, description: `Datos expuestos: ${(b.DataClasses || []).slice(0, 5).join(', ') || 'N/D'}.`, category: 'breach', sourcePlatform: 'Have I Been Pwned', nodeId: bId, confidence: 95 });
          }
        } else if (hibp.status === 404) addLog('HIBP', 'Sin brechas en HIBP.', 'success');
        else addLog('HIBP', `Error al consultar HIBP (${hibp.status || 'sin respuesta'}).`, 'warning');
      }
    }

    // 2C. Hunter.io (clave en la URL, solo hacia hunter.io)
    if (credentials.hunterKey) {
      const h = await get(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(credentials.hunterKey)}`, 'Hunter.io');
      if (h.ok && h.data?.data) {
        const hd = h.data.data;
        const hId = `node-hunter-${slug(email)}`;
        upsertNode({ id: hId, label: `Hunter.io: ${hd.status || 'verificado'}`, subtitle: `Entregabilidad ${hd.score ?? 0} %`, type: 'email', platform: 'Hunter.io', category: 'Correo', aliasFamily: 'Infraestructura', confidence: sourceConfidence(85, `Verificación de Hunter.io (estado: ${hd.status})`), verifiedStatus: 'verified', metadata: { estado: hd.status || 'unknown', puntuacion: hd.score ?? 0, smtp: hd.smtp_check ? 'Responde' : 'Sin comprobar', webmail: hd.webmail ? 'Sí' : 'No' } });
        upsertEdge(seedNodeId, hId, 'verificado por Hunter', 2);
      } else addLog('Hunter.io', `No se pudo consultar (${h.status ? `HTTP ${h.status}` : 'sin respuesta o CORS'}).`, 'warning');
    }

    // 2D. Dominio: MX, SPF y DMARC
    if (emailDomain) {
      const domNodeId = `node-domain-${slug(emailDomain)}`;
      upsertNode({ id: domNodeId, label: emailDomain, subtitle: 'Dominio del correo', type: 'domain', platform: 'Correo', category: 'Infraestructura web', aliasFamily: 'Infraestructura', url: `https://${emailDomain}`, confidence: sourceConfidence(100, 'Extraído del correo'), pivot: { query: emailDomain, type: 'domain' }, verifiedStatus: 'verified', metadata: { dominio: emailDomain } });
      upsertEdge(seedNodeId, domNodeId, 'dominio del correo', 3);
      await mailDnsRecords(emailDomain, domNodeId, { get, upsertNode, upsertEdge, addLog });
    }

    // 2E. Huella SHA-256 del correo: Gravatar y claves OpenPGP
    try {
      const hash = await sha256Hex(email.trim().toLowerCase());
      const hashNodeId = `node-hash-${hash.slice(0, 12)}`;
      const gravatar = await gravatarExists(hash);
      const pgp = await get(`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`, 'keys.openpgp.org');
      const hasPgp = pgp.status === 200 && /BEGIN PGP PUBLIC KEY/.test(pgp.text);
      upsertNode({
        id: hashNodeId,
        label: `SHA-256 del correo: ${hash.slice(0, 10)}…`,
        subtitle: [gravatar === true ? 'tiene Gravatar' : gravatar === false ? 'sin Gravatar' : 'Gravatar sin comprobar', hasPgp ? 'clave PGP publicada' : pgp.status === 404 ? 'sin clave PGP' : 'PGP sin comprobar'].join(' · '),
        type: 'email',
        platform: 'Gravatar / OpenPGP',
        category: 'Identidad criptográfica',
        aliasFamily: 'Raíz exacta',
        url: gravatar ? `https://gravatar.com/${hash}` : undefined,
        confidence: sourceConfidence(gravatar || hasPgp ? 90 : 60, 'Hash SHA-256 del correo en minúsculas (el identificador que usa Gravatar)'),
        verifiedStatus: 'verified',
        metadata: { sha256: hash, gravatar: gravatar === null ? 'Sin comprobar' : gravatar ? 'Sí' : 'No', clavePgp: hasPgp ? 'Publicada en keys.openpgp.org' : pgp.status === 404 ? 'No' : 'Sin comprobar' },
      });
      upsertEdge(seedNodeId, hashNodeId, 'hash del correo', 2);
    } catch {
      addLog('Correo', 'Web Crypto no disponible: no se calcula el hash.', 'warning');
    }
    progress();
  }

  // ==========================================================================
  // 3. DOMINIO: RDAP, certificados, DNS, Wayback y (con proxy) VirusTotal / URLScan
  // ==========================================================================
  if (inputType === 'domain') {
    const d = cleanQuery.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
    addLog('Dominio', `Reconocimiento pasivo de «${d}».`, 'info');

    const rdap = await get(`https://rdap.org/domain/${encodeURIComponent(d)}`, 'RDAP');
    if (rdap.ok && rdap.data) {
      const events: any[] = rdap.data.events || [];
      const regDate = events.find((e) => e.eventAction === 'registration')?.eventDate?.slice(0, 10) || '';
      const expDate = events.find((e) => e.eventAction === 'expiration')?.eventDate?.slice(0, 10) || '';
      const nameservers = (rdap.data.nameservers || []).map((ns: any) => String(ns.ldhName || '').toLowerCase()).filter(Boolean);
      const registrar = (rdap.data.entities || []).find((e: any) => (e.roles || []).includes('registrar'));
      const registrarName = registrar?.vcardArray?.[1]?.find((f: any) => f[0] === 'fn')?.[3] || registrar?.handle || 'N/D';
      const rdapNodeId = `node-rdap-${slug(d)}`;
      upsertNode({ id: rdapNodeId, label: `RDAP: ${d}`, subtitle: regDate ? `Registrado el ${regDate}` : 'Registro RDAP', type: 'domain', platform: 'RDAP', category: 'Infraestructura web', aliasFamily: 'Infraestructura', timestamp: regDate || undefined, confidence: sourceConfidence(95, 'Datos del registro oficial (RDAP)'), pivot: { query: d, type: 'domain' }, verifiedStatus: 'verified', metadata: { registrador: registrarName, alta: regDate || 'N/D', caducidad: expDate || 'N/D', nameservers: nameservers.join(', ') || 'N/D', estado: (rdap.data.status || []).join(', ') || 'N/D', dnssec: rdap.data.secureDNS?.delegationSigned ? 'Sí' : 'No' } });
      upsertEdge(seedNodeId, rdapNodeId, 'registro RDAP', 3);
      if (regDate) addTimeline({ id: `tl-rdap-${d}`, date: regDate, title: `Registro del dominio ${d}`, description: `Registrador: ${registrarName}. Nameservers: ${nameservers.join(', ') || 'N/D'}.`, category: 'domain_whois', sourcePlatform: 'RDAP', nodeId: rdapNodeId, confidence: 95 });
      addLog('RDAP', `Registro de ${d}: alta ${regDate || 'N/D'}, registrador ${registrarName}.`, 'success');
    } else addLog('RDAP', `Sin datos RDAP (${rdap.status ? `HTTP ${rdap.status}` : 'sin respuesta'}).`, 'warning');

    // Certificate Transparency: Cert Spotter (con CORS) y, si falla, crt.sh
    const subs = new Map<string, string>();
    const belongs = (name: string) => name === d || name.endsWith(`.${d}`);
    const cs = await get(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(d)}&include_subdomains=true&expand=dns_names`, 'Cert Spotter', { timeoutMs: 12000 });
    let ctSource = 'Cert Spotter';
    if (cs.ok && Array.isArray(cs.data)) {
      for (const cert of cs.data) for (const n of cert.dns_names || []) {
        const name = String(n).toLowerCase().replace(/^\*\./, '');
        if (belongs(name) && !subs.has(name)) subs.set(name, String(cert.not_before || '').slice(0, 10));
      }
    } else {
      ctSource = 'crt.sh';
      const crt = await get(`https://crt.sh/?q=%25.${encodeURIComponent(d)}&output=json`, 'crt.sh', { timeoutMs: 15000, useProxy: proxyReady });
      if (crt.ok && Array.isArray(crt.data)) {
        for (const cert of crt.data) for (const n of String(cert.name_value || '').split('\n')) {
          const name = n.trim().toLowerCase().replace(/^\*\./, '');
          if (belongs(name) && !subs.has(name)) subs.set(name, String(cert.not_before || '').slice(0, 10));
        }
      } else {
        addManualTask({ platform: 'crt.sh', url: `https://crt.sh/?q=%25.${encodeURIComponent(d)}`, target: d, reason: 'CORS_BLOCKED', retriesAttempted: crt.retriesUsed, notes: 'No se pudieron leer los certificados: ábrelo en el navegador.' });
      }
    }
    const subList = Array.from(subs.entries()).filter(([n]) => n !== d).slice(0, 20);
    for (const [sub, date] of subList) {
      const subNodeId = `node-sub-${slug(sub)}`;
      upsertNode({ id: subNodeId, label: sub, subtitle: `Subdominio visto en ${ctSource}`, type: 'subdomain', platform: ctSource, category: 'Infraestructura web', aliasFamily: 'Subdominios', url: `https://${sub}`, timestamp: date || undefined, confidence: sourceConfidence(90, `Aparece en un certificado TLS registrado en ${ctSource}`), pivot: { query: sub, type: 'domain' }, verifiedStatus: 'verified', metadata: { subdominio: sub, certificadoDesde: date || 'N/D' } });
      upsertEdge(seedNodeId, subNodeId, 'subdominio (CT)', 2);
    }
    if (subs.size) addLog(ctSource, `${subList.length} subdominios en los registros de Certificate Transparency.`, 'success');

    // DNS A → enriquecimiento de IP
    const dns = await get(`https://dns.google/resolve?name=${encodeURIComponent(d)}&type=A`, 'Google DoH');
    if (dns.ok && Array.isArray(dns.data?.Answer)) {
      const ips: string[] = dns.data.Answer.filter((r: any) => r.type === 1).map((r: any) => r.data);
      for (const ip of ips.slice(0, 2)) {
        const ipNodeId = `node-ip-${slug(ip)}`;
        upsertNode({ id: ipNodeId, label: ip, subtitle: `IP de ${d}`, type: 'ip', platform: 'DNS (registro A)', category: 'Red', aliasFamily: 'Infraestructura', confidence: sourceConfidence(95, `Registro A de ${d}`), pivot: { query: ip, type: 'ip' }, verifiedStatus: 'verified', metadata: { ip, dominio: d } });
        upsertEdge(seedNodeId, ipNodeId, 'resuelve a', 3);
        await enrichIpNode({ ipAddr: ip, ipNodeId, get, upsertNode, upsertEdge, addLocation, addTimeline, addLog });
      }
    }
    await mailDnsRecords(d, seedNodeId, { get, upsertNode, upsertEdge, addLog });

    if (credentials.virusTotalKey || credentials.urlScanKey) {
      if (!keysViaProxy) addLog('VirusTotal / URLScan', 'Omitidos: sus APIs no admiten llamadas desde el navegador. Necesitan tu proxy propio y permitir enviar claves por él.', 'warning');
      else {
        if (credentials.virusTotalKey) {
          const vt = await get(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(d)}`, 'VirusTotal', { useProxy: true, headers: { 'x-apikey': credentials.virusTotalKey } });
          if (vt.ok && vt.data?.data?.attributes) {
            const st = vt.data.data.attributes.last_analysis_stats || {};
            const vtId = `node-vt-${slug(d)}`;
            upsertNode({ id: vtId, label: `VirusTotal: ${st.malicious || 0} motores lo marcan`, subtitle: `Reputación de ${d}`, type: 'domain', platform: 'VirusTotal', category: 'Reputación', aliasFamily: 'Infraestructura', confidence: sourceConfidence(90, 'Último análisis de VirusTotal'), verifiedStatus: 'verified', metadata: { maliciosos: st.malicious || 0, sospechosos: st.suspicious || 0, inofensivos: st.harmless || 0, reputacion: vt.data.data.attributes.reputation ?? 0 } });
            upsertEdge(seedNodeId, vtId, 'reputación', 2);
          }
        }
        if (credentials.urlScanKey) {
          const us = await get(`https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(d)}&size=3`, 'URLScan.io', { useProxy: true, headers: { 'API-Key': credentials.urlScanKey } });
          const first = us.data?.results?.[0];
          if (us.ok && first) {
            const usId = `node-urlscan-${slug(d)}`;
            upsertNode({ id: usId, label: `URLScan: ${first.page?.server || 'escaneado'}`, subtitle: `ASN ${first.page?.asnname || 'N/D'}`, type: 'domain', platform: 'URLScan.io', category: 'Infraestructura web', aliasFamily: 'Infraestructura', url: safeHttpUrl(first.result), confidence: sourceConfidence(88, 'Escaneo histórico de URLScan.io'), verifiedStatus: 'verified', metadata: { servidor: first.page?.server || 'N/D', asn: first.page?.asn || 'N/D', pais: first.page?.country || 'N/D' } });
            upsertEdge(seedNodeId, usId, 'captura URLScan', 2);
          }
        }
      }
    }

    const wb = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(d)}&timestamp=19900101`, 'Wayback Machine');
    const snap = wb.data?.archived_snapshots?.closest;
    if (wb.ok && snap?.available) {
      const ts = String(snap.timestamp || '');
      const date = ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : '';
      const wbId = `node-wayback-${slug(d)}`;
      upsertNode({ id: wbId, label: `Wayback: primera captura ${date || 'N/D'}`, subtitle: 'Internet Archive', type: 'domain', platform: 'Archive.org', category: 'Archivo histórico', aliasFamily: 'Infraestructura', url: safeHttpUrl(snap.url), timestamp: date || undefined, confidence: sourceConfidence(90, 'Captura archivada en la Wayback Machine'), verifiedStatus: 'verified', metadata: { fecha: date || 'N/D', captura: snap.url || 'N/D' } });
      upsertEdge(seedNodeId, wbId, 'archivado en', 2);
      if (date) addTimeline({ id: `tl-wb-${d}`, date, title: `Primera captura de ${d} en la Wayback Machine`, description: 'Captura más antigua disponible en Internet Archive.', category: 'domain_whois', sourcePlatform: 'Archive.org', sourceUrl: safeHttpUrl(snap.url), nodeId: wbId, confidence: 90 });
    }
    progress();
  }

  // ==========================================================================
  // 4. IP
  // ==========================================================================
  if (inputType === 'ip') {
    if (!isValidIpv4(cleanQuery)) addLog('IP', `«${cleanQuery}» no es una IPv4 válida (cuatro números de 0 a 255).`, 'error');
    else if (isNonPublicIpv4(cleanQuery)) addLog('IP', `${cleanQuery} es una IP privada, reservada o de documentación: no tiene datos públicos.`, 'warning');
    else await enrichIpNode({ ipAddr: cleanQuery, ipNodeId: seedNodeId, get, upsertNode, upsertEdge, addLocation, addTimeline, addLog });
    progress();
  }

  // ==========================================================================
  // 5. TELÉFONO, NOMBRE Y DNI/NIE: análisis local y búsquedas manuales
  // ==========================================================================
  if (inputType === 'phone' || inputType === 'real_name' || inputType === 'national_id') {
    if (inputType === 'phone') {
      const ph = analyzePhone(cleanQuery);
      const phoneNodeId = `node-phone-${slug(ph.e164 || cleanQuery)}`;
      upsertNode({
        id: phoneNodeId,
        label: ph.countryName ? `Prefijo +${ph.dialCode}: ${ph.countryName}` : 'Prefijo no determinado',
        subtitle: ph.e164 ? `E.164: ${ph.e164} · ${ph.lineType}` : 'Sin formato E.164',
        type: 'phone',
        platform: 'Analizador E.164',
        category: 'Telecomunicaciones',
        aliasFamily: 'Identidad',
        confidence: sourceConfidence(ph.valid ? (ph.assumedCountry ? 60 : 85) : 30, ph.valid ? `Número con formato válido para ${ph.countryName ?? 'su prefijo'}` : 'Formato no válido o país desconocido'),
        verifiedStatus: ph.valid ? 'verified' : 'unverified',
        metadata: { e164: ph.e164 || 'N/D', pais: ph.countryName || 'N/D', tipo: ph.lineType, notas: ph.notes.join(' ') || 'N/D' },
      });
      upsertEdge(seedNodeId, phoneNodeId, 'prefijo', 3);
      const cap = ph.dialCode ? dialCodeCapital(ph.dialCode) : null;
      if (cap && ph.countryCode) {
        addLocation({ id: `geo-phone-${slug(ph.e164 || cleanQuery)}`, lat: cap.lat, lng: cap.lng, title: `Plan de numeración: ${ph.countryName}`, subtitle: 'País del prefijo, no la ubicación del titular (se marca la capital)', category: 'phone_region', confidence: ph.assumedCountry ? 40 : 70, nodeId: phoneNodeId, source: 'Prefijo UIT E.164', countryCode: ph.countryCode });
      }
      if (ph.e164) {
        addManualTask({ platform: 'WhatsApp', url: `https://wa.me/${ph.e164.slice(1)}`, target: ph.e164, reason: 'MANUAL_DORK', retriesAttempted: 0, notes: 'Abre el enlace para ver si el número tiene WhatsApp.' });
      }
      addLog('Teléfono', ph.e164 ? `${ph.e164}: ${ph.countryName ?? 'país desconocido'}, ${ph.lineType.toLowerCase()}.` : ph.notes.join(' '), ph.valid ? 'success' : 'warning');
    }

    if (inputType === 'national_id') {
      const r = validateSpanishId(cleanQuery);
      const idNode = `node-id-${slug(r.normalized)}`;
      upsertNode({
        id: idNode,
        label: r.valid ? `${r.kind} con letra correcta (${r.normalized})` : r.expectedLetter ? `${r.kind}: letra incorrecta (${r.normalized})` : `Identificador: ${r.normalized}`,
        subtitle: r.expectedLetter ? `Letra de control esperada: ${r.expectedLetter}` : 'Formato no reconocido como DNI ni NIE',
        type: 'national_id',
        platform: 'Validador módulo 23',
        category: 'Identidad legal',
        aliasFamily: 'Identidad',
        confidence: sourceConfidence(r.valid ? 95 : 20, r.valid ? 'La letra coincide con el resto del número entre 23 (el número está bien formado, no que exista)' : 'La letra no corresponde al número'),
        verifiedStatus: r.valid ? 'verified' : 'false_positive',
        metadata: { documento: r.normalized, tipo: r.kind, letraEsperada: r.expectedLetter || 'N/A', valido: r.valid ? 'Sí' : 'No' },
      });
      upsertEdge(seedNodeId, idNode, 'validación', 3);
      addLog('DNI/NIE', r.valid ? `${r.normalized}: letra correcta.` : `${r.normalized}: ${r.expectedLetter ? `la letra debería ser ${r.expectedLetter}` : 'formato no válido'}.`, r.valid ? 'success' : 'warning');
      addLog('DNI/NIE', 'Un DNI es un dato personal: búscalo solo con una base legal (RGPD, art. 6) y para una finalidad concreta.', 'warning');
    }

    const dorks = [
      { label: 'Perfiles', q: `"${cleanQuery}" (site:linkedin.com OR site:github.com OR site:x.com OR site:instagram.com)` },
      { label: 'Documentos', q: `"${cleanQuery}" (filetype:pdf OR filetype:xlsx OR filetype:docx)` },
      { label: 'Boletines oficiales', q: `"${cleanQuery}" (site:boe.es OR site:borme.es OR "boletín oficial")` },
    ];
    for (const dk of dorks) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(dk.q)}`;
      const id = `node-dork-${slug(dk.label)}-${slug(cleanQuery)}`;
      upsertNode({ id, label: `Dork: ${dk.label}`, subtitle: dk.q.length > 52 ? `${dk.q.slice(0, 50)}…` : dk.q, type: 'dork_query', platform: 'Google (búsqueda manual)', category: 'Búsqueda avanzada', aliasFamily: 'Dorks', url, confidence: sourceConfidence(50, 'Búsqueda preparada: los resultados hay que revisarlos a mano'), verifiedStatus: 'unverified', metadata: { consulta: dk.q } });
      upsertEdge(seedNodeId, id, 'dork', 2);
      addManualTask({ platform: `Dork: ${dk.label}`, url, target: cleanQuery, reason: 'MANUAL_DORK', retriesAttempted: 0, notes: dk.q });
    }

    if (credentials.serperKey) {
      const s = await get('https://google.serper.dev/search', 'Serper.dev', { method: 'POST', body: JSON.stringify({ q: `"${cleanQuery}"`, num: 5 }), headers: { 'X-API-KEY': credentials.serperKey, 'Content-Type': 'application/json' } });
      if (s.ok && Array.isArray(s.data?.organic)) {
        s.data.organic.slice(0, 5).forEach((item: any, idx: number) => {
          const sId = `node-serper-${slug(cleanQuery)}-${idx}`;
          upsertNode({ id: sId, label: String(item.title || 'Resultado').slice(0, 40), subtitle: item.link || '', type: 'dork_query', platform: 'Serper.dev', category: 'Búsqueda web', aliasFamily: 'Resultados web', url: safeHttpUrl(item.link), confidence: sourceConfidence(55, 'Resultado de búsqueda: contiene el texto, no prueba identidad'), verifiedStatus: 'unverified', metadata: { titulo: item.title || '', fragmento: item.snippet || '', url: item.link || '' } });
          upsertEdge(seedNodeId, sId, 'resultado web', 2);
        });
        addLog('Serper.dev', `${s.data.organic.length} resultados web.`, 'success');
      } else addLog('Serper.dev', `Error al consultar (${s.status || 'sin respuesta'}).`, 'warning');
    }
    progress();
  }

  // Cruce final de perfiles (mismo nombre visible, misma web) y clasificación
  workingCase.nodes = rescoreProfiles(workingCase.nodes, workingCase.seedQuery, workingCase.contextHints);
  const profiles = workingCase.nodes.filter((n) => n.evidence);
  if (profiles.length) {
    const c = profiles.filter((n) => identityBand(n.confidence.total) === 'corroborated').length;
    const h = profiles.filter((n) => identityBand(n.confidence.total) === 'homonym').length;
    addLog('Confianza', `${profiles.length} perfiles: ${c} corroborados, ${profiles.length - c - h} sin corroborar y ${h} probables homónimos.`, 'info');
  }
  addLog('Investigación', `Búsqueda de «${cleanQuery}» terminada.`, 'success');
  return workingCase;
}

type Getter = (url: string, platform: string, extra?: Partial<Parameters<typeof fetchWithSmartRetries>[0]>) => Promise<FetchResult>;

/** MX, SPF y DMARC de un dominio por DNS sobre HTTPS. */
async function mailDnsRecords(
  domain: string,
  parentId: string,
  ctx: { get: Getter; upsertNode: (n: GraphNode) => void; upsertEdge: (s: string, t: string, r: string, w?: number) => void; addLog: (m: string, msg: string, l?: InvestigationLog['level']) => void }
) {
  const slug = domain.replace(/[^a-z0-9]+/gi, '_');
  const txt = (r: FetchResult) => (Array.isArray(r.data?.Answer) ? r.data.Answer.filter((a: any) => a.type === 16).map((a: any) => String(a.data).replace(/^"|"$/g, '').replace(/" "/g, '')) : []);
  const [mx, spf, dmarc] = await Promise.all([
    ctx.get(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, 'DoH MX'),
    ctx.get(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`, 'DoH TXT'),
    ctx.get(`https://dns.google/resolve?name=_dmarc.${encodeURIComponent(domain)}&type=TXT`, 'DoH DMARC'),
  ]);
  const mxList: string[] = Array.isArray(mx.data?.Answer) ? mx.data.Answer.filter((a: any) => a.type === 15).map((a: any) => String(a.data)) : [];
  const spfRec = txt(spf).find((t: string) => t.toLowerCase().startsWith('v=spf1'));
  const dmarcRec = txt(dmarc).find((t: string) => t.toLowerCase().startsWith('v=dmarc1'));
  if (!mx.ok && !spf.ok) return;
  const policy = dmarcRec?.match(/;\s*p=(\w+)/i)?.[1]?.toLowerCase();
  const spfAll = spfRec?.match(/[~\-?+]all/)?.[0];
  const id = `node-mail-${slug}`;
  ctx.upsertNode({
    id,
    label: `Correo de ${domain}: ${mxList.length ? `${mxList.length} MX` : 'sin MX'}`,
    subtitle: `SPF ${spfRec ? spfAll ?? 'sin «all»' : 'ausente'} · DMARC ${policy ? `p=${policy}` : 'ausente'}`,
    type: 'dns_record',
    platform: 'DNS sobre HTTPS',
    category: 'Infraestructura web',
    aliasFamily: 'Infraestructura',
    confidence: sourceConfidence(95, 'Registros DNS públicos consultados en dns.google'),
    verifiedStatus: 'verified',
    metadata: {
      mx: mxList.join(' | ') || 'Ninguno',
      spf: spfRec || 'No publicado',
      dmarc: dmarcRec || 'No publicado',
      valoracion: !spfRec || !dmarcRec ? 'Suplantable: falta SPF o DMARC' : policy === 'none' ? 'DMARC solo monitoriza (p=none): no bloquea suplantaciones' : spfAll === '+all' ? 'SPF +all permite enviar a cualquiera' : 'Protegido frente a suplantación básica',
    },
  });
  ctx.upsertEdge(parentId, id, 'registros de correo', 2);
  ctx.addLog('DNS', `${domain}: ${mxList.length} MX, SPF ${spfRec ? 'sí' : 'no'}, DMARC ${policy ? `p=${policy}` : 'no'}.`, 'success');
}

/** ¿Hay avatar de Gravatar para este hash? null si no se puede comprobar (sin navegador). */
function gravatarExists(hash: string): Promise<boolean | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(null), 6000);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = `https://gravatar.com/avatar/${hash}?d=404&s=8`;
  });
}

/**
 * Enriquecimiento pasivo de una IP: Shodan InternetDB, geolocalización (GeoJS o ipwho.is) y BGP (RIPE Stat).
 */
async function enrichIpNode(params: {
  ipAddr: string;
  ipNodeId: string;
  get: Getter;
  upsertNode: (node: GraphNode) => void;
  upsertEdge: (source: string, target: string, relation: string, weight?: number) => void;
  addLocation: (loc: GeoMarker) => void;
  addTimeline: (ev: TimelineEvent) => void;
  addLog: (module: string, message: string, level?: InvestigationLog['level']) => void;
}) {
  const { ipAddr, ipNodeId, get, upsertNode, upsertEdge, addLocation, addTimeline, addLog } = params;
  const s = ipAddr.replace(/\./g, '_');

  const idb = await get(`https://internetdb.shodan.io/${encodeURIComponent(ipAddr)}`, 'Shodan InternetDB');
  if (idb.ok && idb.data) {
    const ports: number[] = idb.data.ports || [];
    const vulns: string[] = idb.data.vulns || [];
    const portNodeId = `node-idb-${s}`;
    upsertNode({
      id: portNodeId,
      label: ports.length ? `Puertos: ${ports.slice(0, 8).join(', ')}` : 'Sin puertos en InternetDB',
      subtitle: vulns.length ? `${vulns.length} CVE asociadas a las versiones vistas` : 'Superficie según Shodan InternetDB',
      type: 'port_vuln',
      platform: 'Shodan InternetDB',
      category: 'Red',
      aliasFamily: 'Infraestructura',
      confidence: sourceConfidence(85, 'Datos del último escaneo de Shodan (pueden tener semanas)'),
      verifiedStatus: 'verified',
      metadata: { ip: ipAddr, puertos: ports.join(', ') || 'Ninguno', hostnames: (idb.data.hostnames || []).join(', ') || 'N/D', cpes: (idb.data.cpes || []).join(', ') || 'N/D', cve: vulns.slice(0, 15).join(', ') || 'Ninguna', etiquetas: (idb.data.tags || []).join(', ') || 'N/D' },
    });
    upsertEdge(ipNodeId, portNodeId, 'Shodan InternetDB', 3);
    addTimeline({ id: `tl-idb-${s}`, date: new Date().toISOString().slice(0, 10), title: `Consulta a Shodan InternetDB de ${ipAddr}`, description: `Puertos: ${ports.join(', ') || 'ninguno'}. CVE: ${vulns.length}.`, category: 'investigation', sourcePlatform: 'Shodan InternetDB', nodeId: portNodeId, confidence: 85 });
    addLog('Shodan InternetDB', `${ipAddr}: puertos [${ports.join(', ')}], ${vulns.length} CVE.`, vulns.length ? 'warning' : 'success');
  } else if (idb.status === 404) addLog('Shodan InternetDB', `${ipAddr}: sin datos en InternetDB.`, 'info');

  // Geolocalización: GeoJS (gratuito, sin clave, con CORS) y, si no responde, ipwho.is
  let g: { lat: number; lng: number; city?: string; country?: string; cc?: string; org?: string; asn?: number | string; source: string } | null = null;
  const gj = await get(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ipAddr)}.json`, 'GeoJS');
  if (gj.ok && gj.data) {
    const lat = parseFloat(gj.data.latitude);
    const lng = parseFloat(gj.data.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) g = { lat, lng, city: gj.data.city, country: gj.data.country, cc: gj.data.country_code, org: gj.data.organization_name, asn: gj.data.asn, source: 'GeoJS' };
    else addLog('GeoIP', `${ipAddr} no tiene ubicación en GeoJS (habitual en IP anycast como las de Cloudflare o Google).`, 'info');
  } else {
    const wi = await get(`https://ipwho.is/${encodeURIComponent(ipAddr)}`, 'ipwho.is');
    const d = wi.data;
    if (wi.ok && d && d.success !== false && typeof d.latitude === 'number') g = { lat: d.latitude, lng: d.longitude, city: d.city, country: d.country, cc: d.country_code, org: d.connection?.org || d.connection?.isp, asn: d.connection?.asn, source: 'ipwho.is' };
    else addLog('GeoIP', `No se pudo geolocalizar ${ipAddr} (${wi.status === 429 ? 'límite de peticiones' : wi.status ? `HTTP ${wi.status}` : 'sin respuesta'}).`, 'warning');
  }
  if (g) {
    const title = [g.city, g.country].filter(Boolean).join(', ') || 'Ubicación de la IP';
    const locNodeId = `node-loc-${s}`;
    addLocation({ id: `geo-ip-${s}`, lat: g.lat, lng: g.lng, title: `${title} (${ipAddr})`, subtitle: `${g.org || 'Proveedor'}${g.asn ? ` (AS${g.asn})` : ''}. La geolocalización de una IP es aproximada: suele marcar el proveedor, no a la persona.`, category: 'ip_host', confidence: 60, nodeId: ipNodeId, source: g.source, countryCode: g.cc || undefined });
    upsertNode({ id: locNodeId, label: title, subtitle: `${g.org || 'Proveedor'} (${g.cc || '?'})`, type: 'location', platform: g.source, category: 'Geolocalización', aliasFamily: 'Infraestructura', coordinates: { lat: g.lat, lng: g.lng, label: title }, confidence: sourceConfidence(60, 'Geolocalización por bases de datos GeoIP: aproximada, suele marcar la sede del proveedor'), verifiedStatus: 'verified', metadata: { ciudad: g.city || 'N/D', pais: g.country || 'N/D', proveedor: g.org || 'N/D', asn: g.asn ? `AS${g.asn}` : 'N/D', fuente: g.source } });
    upsertEdge(ipNodeId, locNodeId, 'geolocalizada en', 2);
  }

  const ripe = await get(`https://stat.ripe.net/data/prefix-overview/data.json?resource=${encodeURIComponent(ipAddr)}`, 'RIPE Stat');
  const rd = ripe.data?.data;
  if (ripe.ok && rd?.resource) {
    const asn = rd.asns?.[0];
    const bgpNodeId = `node-bgp-${s}`;
    upsertNode({ id: bgpNodeId, label: `BGP: ${rd.resource}${asn?.asn ? ` (AS${asn.asn})` : ''}`, subtitle: asn?.holder || 'Sistema autónomo', type: 'dns_record', platform: 'RIPE Stat', category: 'Enrutamiento BGP', aliasFamily: 'Infraestructura', confidence: sourceConfidence(95, 'Prefijo anunciado en BGP según RIPE Stat'), verifiedStatus: 'verified', metadata: { prefijo: rd.resource, asn: asn?.asn ? `AS${asn.asn}` : 'N/D', titular: asn?.holder || 'N/D', anunciado: rd.announced ? 'Sí' : 'No' } });
    upsertEdge(ipNodeId, bgpNodeId, 'anunciada por', 2);
    addLog('RIPE Stat', `${rd.resource}${asn?.asn ? `, AS${asn.asn} (${asn.holder})` : ''}.`, 'success');
  }
}

/**
 * Resumen del caso con la clave de OpenAI del usuario (los datos del caso se envían a OpenAI)
 * o con el sintetizador local, que no envía nada.
 */
export async function generateCaseAiSummary(osintCase: InvestigationCase, credentials: ApiCredentials): Promise<{ summary: string; mode: 'openai' | 'local_heuristic'; error?: string }> {
  const profiles = osintCase.nodes.filter((n) => n.evidence);
  const byBand = (b: string) => profiles.filter((n) => identityBand(n.confidence.total) === b);
  const corroborated = byBand('corroborated');
  const homonyms = byBand('homonym');
  const reviewedReal = profiles.filter((n) => n.analystReviewed && n.verifiedStatus === 'verified');
  const technical = osintCase.nodes.filter((n) => !n.evidence && n.type !== 'seed');
  let error: string | undefined;

  if (credentials.openAiKey?.trim().startsWith('sk-')) {
    try {
      const prompt = `Redacta en español un resumen ejecutivo de esta investigación OSINT. Distingue hechos de suposiciones y no afirmes identidades que no estén corroboradas.
- Semilla: ${osintCase.seedQuery} (${osintCase.seedType})
- Pistas del analista: ${JSON.stringify(osintCase.contextHints)}
- Perfiles corroborados (≥75): ${corroborated.map((n) => `${n.label} [${n.confidence.total}]`).join(', ') || 'ninguno'}
- Perfiles sin corroborar: ${byBand('uncorroborated').map((n) => `${n.label} [${n.confidence.total}]`).join(', ') || 'ninguno'}
- Probables homónimos (<40): ${homonyms.map((n) => `${n.label} [${n.confidence.total}]`).join(', ') || 'ninguno'}
- Datos técnicos: ${technical.slice(0, 25).map((n) => `${n.label} (${n.platform})`).join('; ') || 'ninguno'}
- Línea de tiempo: ${osintCase.timeline.map((t) => `${t.date}: ${t.title}`).join(' | ') || 'vacía'}
- Comprobaciones manuales pendientes: ${osintCase.manualTasks.filter((t) => t.status === 'pending').length}
Estructura: 1) Identidad y correlación, 2) Infraestructura y exposición, 3) Homónimos y dudas, 4) Siguientes pasos.`;
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.openAiKey.trim()}` },
        body: JSON.stringify({ model: credentials.openAiModel || 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres un analista OSINT prudente y preciso.' }, { role: 'user', content: prompt }], temperature: 0.2 }),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) return { summary: text, mode: 'openai' };
      }
      error = `OpenAI respondió HTTP ${response.status}; se usa el resumen local.`;
    } catch {
      error = 'No se pudo contactar con OpenAI; se usa el resumen local.';
    }
  }

  const list = (ns: GraphNode[]) => ns.slice(0, 8).map((n) => `${n.label} (${n.confidence.total})`).join(', ');
  const summary = [
    `RESUMEN LOCAL — ${osintCase.name}`,
    `1. Identidad: desde la semilla «${osintCase.seedQuery}» se han encontrado ${profiles.length} perfiles. ${corroborated.length ? `Corroborados por las pistas o por otros perfiles: ${list(corroborated)}.` : 'Ninguno está corroborado: que exista el mismo alias no prueba que sea la misma persona; añade pistas (nombre, ciudad, web) o busca coincidencias entre perfiles.'}${reviewedReal.length ? ` El analista ha confirmado ${reviewedReal.length}.` : ''}`,
    `2. Homónimos y dudas: ${homonyms.length ? `${homonyms.length} perfiles contradicen las pistas (${list(homonyms)}).` : 'ningún perfil contradice las pistas.'} ${byBand('uncorroborated').length} siguen sin corroborar.`,
    `3. Infraestructura: ${technical.length} datos técnicos (${Array.from(new Set(technical.map((n) => n.platform))).slice(0, 8).join(', ') || 'ninguno'}).`,
    `4. Cronología y mapa: ${osintCase.timeline.length} hitos fechados y ${osintCase.locations.length} ubicaciones (las de IP y prefijo telefónico son aproximadas).`,
    `5. Pendiente: ${osintCase.manualTasks.filter((t) => t.status === 'pending').length} comprobaciones manuales en la cola.`,
  ].join('\n\n');
  return { summary, mode: 'local_heuristic', error };
}
