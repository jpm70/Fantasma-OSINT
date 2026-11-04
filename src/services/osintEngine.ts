import sherlockSitesData from '../data/sherlockSites.json';
import {
  ApiCredentials,
  ContextHints,
  GeoMarker,
  GraphEdge,
  GraphNode,
  InputType,
  InvestigationCase,
  InvestigationLog,
  ManualTask,
  RetryTaskStatus,
  SherlockSite,
  TimelineEvent,
} from '../types/osint';
import {
  calculateConfidenceScore,
  extractUsernameRoot,
  generateAliasFamilies,
} from './aliasAndConfidenceEngine';

export const SHERLOCK_SITES: SherlockSite[] = sherlockSitesData as SherlockSite[];

/**
 * Known city/country gazetteer for converting profile text locations into Leaflet coordinates.
 */
const LOCATION_GAZETTEER: Array<{ keywords: string[]; lat: number; lng: number; label: string; cc: string }> = [
  { keywords: ['madrid', 'españa', 'spain', 'es'], lat: 40.4168, lng: -3.7038, label: 'Madrid, España', cc: 'ES' },
  { keywords: ['barcelona', 'catalunya', 'catalonia'], lat: 41.3874, lng: 2.1686, label: 'Barcelona, España', cc: 'ES' },
  { keywords: ['valencia'], lat: 39.4699, lng: -0.3763, label: 'Valencia, España', cc: 'ES' },
  { keywords: ['sevilla', 'seville'], lat: 37.3891, lng: -5.9845, label: 'Sevilla, España', cc: 'ES' },
  { keywords: ['bilbao', 'euskadi'], lat: 43.263, lng: -2.935, label: 'Bilbao, España', cc: 'ES' },
  { keywords: ['mexico', 'méxico', 'cdmx', 'mx'], lat: 19.4326, lng: -99.1332, label: 'Ciudad de México, MX', cc: 'MX' },
  { keywords: ['buenos aires', 'argentina', 'ar'], lat: -34.6037, lng: -58.3816, label: 'Buenos Aires, Argentina', cc: 'AR' },
  { keywords: ['bogota', 'bogotá', 'colombia', 'co'], lat: 4.711, lng: -74.0721, label: 'Bogotá, Colombia', cc: 'CO' },
  { keywords: ['santiago', 'chile', 'cl'], lat: -33.4489, lng: -70.6693, label: 'Santiago, Chile', cc: 'CL' },
  { keywords: ['lima', 'peru', 'perú'], lat: -12.0464, lng: -77.0428, label: 'Lima, Perú', cc: 'PE' },
  { keywords: ['san francisco', 'california', 'bay area', 'sf'], lat: 37.7749, lng: -122.4194, label: 'San Francisco, EE.UU.', cc: 'US' },
  { keywords: ['new york', 'nyc', 'manhattan'], lat: 40.7128, lng: -74.006, label: 'Nueva York, EE.UU.', cc: 'US' },
  { keywords: ['london', 'londres', 'uk', 'united kingdom'], lat: 51.5072, lng: -0.1276, label: 'Londres, Reino Unido', cc: 'GB' },
  { keywords: ['berlin', 'berlín', 'germany', 'alemania'], lat: 52.52, lng: 13.405, label: 'Berlín, Alemania', cc: 'DE' },
  { keywords: ['frankfurt'], lat: 50.1109, lng: 8.6821, label: 'Frankfurt, Alemania', cc: 'DE' },
  { keywords: ['paris', 'parís', 'france', 'francia'], lat: 48.8566, lng: 2.3522, label: 'París, Francia', cc: 'FR' },
  { keywords: ['amsterdam', 'netherlands', 'holanda'], lat: 52.3676, lng: 4.9041, label: 'Ámsterdam, Países Bajos', cc: 'NL' },
  { keywords: ['tokyo', 'tokio', 'japan', 'japón'], lat: 35.6762, lng: 139.6503, label: 'Tokio, Japón', cc: 'JP' },
];

export function resolveCoordinatesFromText(locationText?: string): {
  lat: number;
  lng: number;
  label: string;
  countryCode: string;
} | null {
  if (!locationText || !locationText.trim()) return null;
  const lower = locationText.toLowerCase();
  for (const entry of LOCATION_GAZETTEER) {
    if (entry.keywords.some((k) => lower.includes(k))) {
      return { lat: entry.lat, lng: entry.lng, label: entry.label, countryCode: entry.cc };
    }
  }
  return null;
}

/**
 * Automatically detects the input type from a raw query string.
 */
export function detectInputType(raw: string): InputType {
  const q = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return 'email';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(q)) return 'ip';
  if (/^[0-9]{8}[A-Za-z]$/.test(q) || /^[XYZxyz][0-9]{7}[A-Za-z]$/.test(q)) return 'national_id';
  if (/^\+?[0-9\s()-]{8,16}$/.test(q) && /\d{7,}/.test(q.replace(/\D/g, ''))) return 'phone';
  if (/^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/.test(q) && !q.includes(' ')) return 'domain';
  if (q.includes(' ') && /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s.-]+$/.test(q)) return 'real_name';
  return 'username';
}

function nowTimeStr(): string {
  return new Date().toTimeString().split(' ')[0];
}

function buildProxiedUrl(targetUrl: string, corsProxy: string): string {
  const proxy = (corsProxy || 'https://corsproxy.io/?').trim();
  if (!proxy) return targetUrl;
  if (proxy.endsWith('=') || proxy.endsWith('?')) {
    return `${proxy}${encodeURIComponent(targetUrl)}`;
  }
  return `${proxy}${targetUrl}`;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Smart Fetch with HTTP 429 Exponential Backoff Retries and CORS Proxy fallback.
 */
export async function fetchWithSmartRetries(options: {
  url: string;
  platform: string;
  useProxy?: boolean;
  corsProxy: string;
  headers?: Record<string, string>;
  maxRetries?: number;
  timeoutMs?: number;
  onRetryStatus?: (status: RetryTaskStatus) => void;
}): Promise<{
  ok: boolean;
  status: number;
  data: any;
  text: string;
  retriesUsed: number;
  blockedReason?: ManualTask['reason'];
}> {
  const {
    url,
    platform,
    useProxy = false,
    corsProxy,
    headers = {},
    maxRetries = 2,
    timeoutMs = 7500,
    onRetryStatus,
  } = options;

  const taskId = `retry-${platform}-${Date.now()}`;
  let attempt = 0;

  while (attempt <= maxRetries) {
    const fetchUrl = useProxy ? buildProxiedUrl(url, corsProxy) : url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(fetchUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          ...headers,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 429 || response.status === 503) {
        attempt++;
        if (attempt <= maxRetries) {
          const waitMs = attempt * 1400;
          onRetryStatus?.({
            id: taskId,
            platform,
            url,
            attempt,
            maxAttempts: maxRetries,
            nextRetryMs: waitMs,
            status: 'retrying',
          });
          await sleep(waitMs);
          continue;
        } else {
          onRetryStatus?.({
            id: taskId,
            platform,
            url,
            attempt,
            maxAttempts: maxRetries,
            nextRetryMs: 0,
            status: 'moved_to_manual',
          });
          return {
            ok: false,
            status: response.status,
            data: null,
            text: '',
            retriesUsed: attempt,
            blockedReason: 'HTTP_429',
          };
        }
      }

      const text = await response.text();
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (attempt > 0) {
        onRetryStatus?.({
          id: taskId,
          platform,
          url,
          attempt,
          maxAttempts: maxRetries,
          nextRetryMs: 0,
          status: 'resolved',
        });
      }

      return {
        ok: response.ok,
        status: response.status,
        data,
        text,
        retriesUsed: attempt,
      };
    } catch {
      clearTimeout(timer);
      attempt++;
      if (attempt <= maxRetries) {
        const waitMs = attempt * 1100;
        onRetryStatus?.({
          id: taskId,
          platform,
          url,
          attempt,
          maxAttempts: maxRetries,
          nextRetryMs: waitMs,
          status: 'retrying',
        });
        await sleep(waitMs);
      } else {
        onRetryStatus?.({
          id: taskId,
          platform,
          url,
          attempt,
          maxAttempts: maxRetries,
          nextRetryMs: 0,
          status: 'moved_to_manual',
        });
        return {
          ok: false,
          status: 0,
          data: null,
          text: '',
          retriesUsed: attempt,
          blockedReason: 'CORS_BLOCKED',
        };
      }
    }
  }

  return {
    ok: false,
    status: 0,
    data: null,
    text: '',
    retriesUsed: attempt,
    blockedReason: 'CORS_BLOCKED',
  };
}

export interface ScanCallbacks {
  onLog: (log: InvestigationLog) => void;
  onRetryStatus: (status: RetryTaskStatus) => void;
  onCaseProgress: (updatedCase: InvestigationCase) => void;
}

/**
 * Master OSINT Orchestrator: Runs client-side investigations for any input type
 * and populates the Live Graph, Confidence Scores, Alias Families, Map, Timeline, and Manual Queue.
 */
export async function executeOsintInvestigation(params: {
  currentCase: InvestigationCase;
  query: string;
  inputType: InputType;
  hints: ContextHints;
  credentials: ApiCredentials;
  maxSherlockSites?: number;
  callbacks: ScanCallbacks;
}): Promise<InvestigationCase> {
  const {
    currentCase,
    query,
    inputType,
    hints,
    credentials,
    maxSherlockSites = 22,
    callbacks,
  } = params;

  const cleanQuery = query.trim();
  const workingCase: InvestigationCase = {
    ...currentCase,
    seedQuery: cleanQuery,
    seedType: inputType,
    contextHints: { ...currentCase.contextHints, ...hints },
    nodes: [...currentCase.nodes],
    edges: [...currentCase.edges],
    timeline: [...currentCase.timeline],
    locations: [...currentCase.locations],
    manualTasks: [...currentCase.manualTasks],
    aliasVariants: [...currentCase.aliasVariants],
    logs: [...currentCase.logs],
  };

  const addLog = (module: string, message: string, level: InvestigationLog['level'] = 'info') => {
    const entry: InvestigationLog = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: nowTimeStr(),
      module,
      message,
      level,
    };
    workingCase.logs = [entry, ...workingCase.logs.slice(0, 79)];
    callbacks.onLog(entry);
  };

  const upsertNode = (node: GraphNode) => {
    const idx = workingCase.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) {
      workingCase.nodes[idx] = { ...workingCase.nodes[idx], ...node };
    } else {
      workingCase.nodes.push(node);
    }
  };

  const upsertEdge = (source: string, target: string, relation: string, weight = 2) => {
    if (source === target) return;
    const id = `edge-${source}-${target}`;
    if (!workingCase.edges.some((e) => e.id === id)) {
      workingCase.edges.push({ id, source, target, relation, weight });
    }
  };

  const addTimeline = (ev: TimelineEvent) => {
    if (!workingCase.timeline.some((t) => t.title === ev.title && t.date === ev.date)) {
      workingCase.timeline.push(ev);
      workingCase.timeline.sort((a, b) => a.date.localeCompare(b.date));
    }
  };

  const addLocation = (loc: GeoMarker) => {
    if (!workingCase.locations.some((l) => Math.abs(l.lat - loc.lat) < 0.01 && l.title === loc.title)) {
      workingCase.locations.push(loc);
    }
  };

  const addManualTask = (task: Omit<ManualTask, 'id' | 'timestamp' | 'status'>) => {
    if (!workingCase.manualTasks.some((m) => m.url === task.url)) {
      workingCase.manualTasks.unshift({
        ...task,
        id: `mt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        status: 'pending',
      });
    }
  };

  // Ensure Seed Node exists
  const seedNodeId = `seed-${cleanQuery.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  upsertNode({
    id: seedNodeId,
    label: cleanQuery,
    subtitle: `Objetivo (${inputType.toUpperCase()})`,
    type: 'seed',
    platform: 'Input OSINT',
    category: 'Semilla Principal',
    aliasFamily: 'Raíz Exacta',
    confidence: {
      total: 100,
      handleMatch: 30,
      aliasSimilarity: 20,
      bioNameMatch: 20,
      geoMatch: 15,
      avatarDomainMatch: 15,
      reasons: ['Punto de entrada confirmado por el investigador [100]'],
    },
    verifiedStatus: 'verified',
    metadata: {
      inputType,
      query: cleanQuery,
      timestamp: new Date().toISOString(),
    },
  });

  // Generate Alias Families if username, email, or real_name
  if (inputType === 'username' || inputType === 'email' || inputType === 'real_name') {
    const generatedAliases = generateAliasFamilies(cleanQuery, workingCase.contextHints);
    for (const av of generatedAliases) {
      if (!workingCase.aliasVariants.some((x) => x.variant === av.variant)) {
        workingCase.aliasVariants.push(av);
      }
    }
    addLog(
      'Familias de Alias',
      `Generadas ${generatedAliases.length} variantes morfológicas para la raíz "${extractUsernameRoot(cleanQuery)}".`,
      'success'
    );
  }

  callbacks.onCaseProgress({ ...workingCase });

  // ============================================================================
  // MODULE 1: USERNAME SEARCH (Sherlock 58 Sites + Rich JSON APIs)
  // ============================================================================
  if (inputType === 'username') {
    const username = cleanQuery.replace(/^@/, '');
    addLog('Sherlock Engine', `Iniciando barrido de usuario "${username}" en catálogo de ${SHERLOCK_SITES.length} plataformas...`, 'info');

    // 1A. Direct JSON APIs (GitHub, GitLab, Reddit, Dev.to, HackerNews, Keybase, Lichess, Chess.com, Crates.io, Mastodon, Bluesky)
    const directSites = SHERLOCK_SITES.filter((s) => s.probeMode === 'direct_json');
    for (const site of directSites) {
      const probeUrl = (site.probeUrlTemplate || site.urlTemplate).replace(/\{username\}/g, encodeURIComponent(username));
      const profileUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(username));

      const res = await fetchWithSmartRetries({
        url: probeUrl,
        platform: site.name,
        useProxy: false,
        corsProxy: credentials.corsProxy,
        maxRetries: 1,
        onRetryStatus: callbacks.onRetryStatus,
      });

      if (res.ok && res.data) {
        let exists = false;
        let displayName = '';
        let bio = '';
        let locationStr = '';
        let createdDate = '';
        let linkedBlog = '';
        let avatarUrl = '';
        const extraMeta: Record<string, string | number> = {};

        if (site.name === 'GitHub' && res.data.login) {
          exists = true;
          displayName = res.data.name || res.data.login;
          bio = res.data.bio || '';
          locationStr = res.data.location || '';
          createdDate = (res.data.created_at || '').slice(0, 10);
          linkedBlog = res.data.blog || '';
          avatarUrl = res.data.avatar_url || '';
          extraMeta.reposPublicos = res.data.public_repos ?? 0;
          extraMeta.seguidores = res.data.followers ?? 0;
        } else if (site.name === 'GitLab' && Array.isArray(res.data) && res.data.length > 0) {
          exists = true;
          displayName = res.data[0].name || res.data[0].username;
          avatarUrl = res.data[0].avatar_url || '';
          extraMeta.estado = res.data[0].state || 'active';
        } else if (site.name === 'Reddit' && res.data?.data?.name) {
          exists = true;
          displayName = res.data.data.subreddit?.title || res.data.data.name;
          bio = res.data.data.subreddit?.public_description || '';
          if (res.data.data.created_utc) {
            createdDate = new Date(res.data.data.created_utc * 1000).toISOString().slice(0, 10);
          }
          extraMeta.karmaTotal = res.data.data.total_karma ?? 0;
        } else if (site.name === 'Dev.to' && res.data?.username) {
          exists = true;
          displayName = res.data.name || res.data.username;
          bio = res.data.summary || '';
          locationStr = res.data.location || '';
          linkedBlog = res.data.website_url || '';
        } else if (site.name === 'HackerNews' && res.data?.id) {
          exists = true;
          displayName = res.data.id;
          bio = (res.data.about || '').replace(/<[^>]+>/g, '').slice(0, 160);
          if (res.data.created) {
            createdDate = new Date(res.data.created * 1000).toISOString().slice(0, 10);
          }
          extraMeta.karma = res.data.karma ?? 0;
        } else if (site.name === 'Keybase' && res.data?.them?.[0]?.basics?.username) {
          exists = true;
          const kb = res.data.them[0];
          displayName = kb.profile?.full_name || kb.basics.username;
          bio = kb.profile?.bio || '';
          locationStr = kb.profile?.location || '';
        } else if (site.name === 'Lichess' && res.data?.username) {
          exists = true;
          displayName = res.data.username;
          bio = res.data.profile?.bio || '';
          locationStr = res.data.profile?.country || '';
          if (res.data.createdAt) {
            createdDate = new Date(res.data.createdAt).toISOString().slice(0, 10);
          }
        } else if (site.name === 'Chess.com' && res.data?.username) {
          exists = true;
          displayName = res.data.name || res.data.username;
          locationStr = res.data.location || '';
          if (res.data.joined) {
            createdDate = new Date(res.data.joined * 1000).toISOString().slice(0, 10);
          }
        } else if (site.name.startsWith('Crates.io') && res.data?.user?.login) {
          exists = true;
          displayName = res.data.user.name || res.data.user.login;
        } else if (site.name === 'Bluesky' && res.data?.handle) {
          exists = true;
          displayName = res.data.displayName || res.data.handle;
          bio = res.data.description || '';
          createdDate = (res.data.createdAt || '').slice(0, 10);
        } else if (site.name.startsWith('Mastodon') && res.data?.acct) {
          exists = true;
          displayName = res.data.display_name || res.data.username;
          bio = (res.data.note || '').replace(/<[^>]+>/g, '').slice(0, 160);
          createdDate = (res.data.created_at || '').slice(0, 10);
        }

        if (exists) {
          const conf = calculateConfidenceScore({
            seedQuery: username,
            candidateHandle: username,
            candidateName: displayName,
            candidateBio: bio,
            candidateLocation: locationStr,
            candidateDomainOrUrl: linkedBlog,
            candidateAvatarHash: avatarUrl,
            isDirectApiMatch: true,
            hints: workingCase.contextHints,
          });

          const geoCoord = resolveCoordinatesFromText(locationStr);
          const nodeId = `node-${site.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${username}`;

          upsertNode({
            id: nodeId,
            label: `${site.name}: ${username}`,
            subtitle: displayName ? `${displayName} (${site.category})` : site.category,
            type: 'social_profile',
            platform: site.name,
            category: site.category,
            aliasFamily: 'Raíz Exacta',
            url: profileUrl,
            timestamp: createdDate || undefined,
            coordinates: geoCoord
              ? { lat: geoCoord.lat, lng: geoCoord.lng, label: `${geoCoord.label} (${site.name})` }
              : undefined,
            confidence: conf,
            verifiedStatus: conf.total >= 75 ? 'verified' : 'unverified',
            metadata: {
              plataforma: site.name,
              usuario: username,
              nombreVisible: displayName || 'N/D',
              biografia: bio || 'Sin biografía pública',
              ubicacion: locationStr || 'No especificada',
              web: linkedBlog || 'N/D',
              creacion: createdDate || 'N/D',
              ...extraMeta,
            },
          });
          upsertEdge(seedNodeId, nodeId, `perfil_${site.name.toLowerCase()} (${conf.total}%)`, 3);

          if (createdDate) {
            addTimeline({
              id: `tl-${nodeId}`,
              date: createdDate,
              title: `Alta de cuenta en ${site.name} (@${username})`,
              description: bio ? `Bio: "${bio.slice(0, 110)}"` : `Perfil público verificado en ${site.name}.`,
              category: 'account',
              sourcePlatform: site.name,
              sourceUrl: profileUrl,
              nodeId,
              confidence: conf.total,
            });
          }

          if (geoCoord) {
            addLocation({
              id: `geo-${nodeId}`,
              lat: geoCoord.lat,
              lng: geoCoord.lng,
              title: `${geoCoord.label} — ${site.name}`,
              subtitle: `Ubicación declarada en el perfil @${username} (${displayName})`,
              category: 'profile_location',
              confidence: conf.total,
              nodeId,
              source: site.name,
              countryCode: geoCoord.countryCode,
            });
          }

          addLog('Sherlock Engine', `[+] Hallazgo en ${site.name}: ${profileUrl} (Confianza: ${conf.total}/100)`, 'success');
          callbacks.onCaseProgress({ ...workingCase });
        }
      } else if (res.blockedReason === 'HTTP_429') {
        addManualTask({
          platform: site.name,
          url: profileUrl,
          target: username,
          reason: 'HTTP_429',
          httpStatus: res.status,
          retriesAttempted: res.retriesUsed,
          notes: `Límite de peticiones HTTP 429 en ${site.name} tras ${res.retriesUsed} reintentos.`,
        });
      }
    }

    // 1B. Probe additional Sherlock sites via CORS Proxy (status 200 checks) & queue WAF sites
    const remainingSites = SHERLOCK_SITES.filter((s) => s.probeMode !== 'direct_json').slice(
      0,
      Math.max(6, maxSherlockSites - directSites.length)
    );

    for (const site of remainingSites) {
      const profileUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(username));

      if (site.probeMode === 'manual_waf') {
        addManualTask({
          platform: site.name,
          url: profileUrl,
          target: username,
          reason: 'WAF_CHALLENGE',
          httpStatus: 403,
          retriesAttempted: 1,
          notes: `${site.name} requiere sesión interactiva o resolución de desafío anti-bot.`,
        });
        continue;
      }

      if (credentials.useCorsProxyForSherlock && credentials.corsProxy) {
        const probeRes = await fetchWithSmartRetries({
          url: site.probeUrlTemplate
            ? site.probeUrlTemplate.replace(/\{username\}/g, encodeURIComponent(username))
            : profileUrl,
          platform: site.name,
          useProxy: true,
          corsProxy: credentials.corsProxy,
          maxRetries: 1,
          timeoutMs: 5000,
          onRetryStatus: callbacks.onRetryStatus,
        });

        const hasErrorString =
          site.errorMsg && probeRes.text && probeRes.text.toLowerCase().includes(site.errorMsg.toLowerCase());

        if (probeRes.ok && probeRes.status === 200 && !hasErrorString) {
          const conf = calculateConfidenceScore({
            seedQuery: username,
            candidateHandle: username,
            isDirectApiMatch: false,
            hints: workingCase.contextHints,
          });
          const nodeId = `node-${site.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${username}`;
          upsertNode({
            id: nodeId,
            label: `${site.name}: ${username}`,
            subtitle: `HTTP 200 OK (${site.category})`,
            type: 'social_profile',
            platform: site.name,
            category: site.category,
            aliasFamily: 'Raíz Exacta',
            url: profileUrl,
            confidence: conf,
            verifiedStatus: 'unverified',
            metadata: {
              plataforma: site.name,
              url: profileUrl,
              codigoHttp: 200,
              metodo: 'Sondeo Sherlock vía Proxy CORS',
            },
          });
          upsertEdge(seedNodeId, nodeId, `http_200_${site.name.toLowerCase()}`, 2);
          addLog('Sherlock Proxy', `[+] HTTP 200 OK en ${site.name}: ${profileUrl}`, 'success');
          callbacks.onCaseProgress({ ...workingCase });
        } else if (probeRes.blockedReason === 'HTTP_429' || probeRes.status === 429 || probeRes.status === 999) {
          addManualTask({
            platform: site.name,
            url: profileUrl,
            target: username,
            reason: 'HTTP_429',
            httpStatus: probeRes.status || 429,
            retriesAttempted: probeRes.retriesUsed,
            notes: `Bloqueo HTTP ${probeRes.status || 429} detectado tras reintentos automáticos.`,
          });
        }
      }
    }
  }

  // ============================================================================
  // MODULE 2: EMAIL INTELLIGENCE (XposedOrNot + DoH MX/SPF/DMARC + HIBP / Hunter)
  // ============================================================================
  if (inputType === 'email') {
    const email = cleanQuery.toLowerCase();
    const [localPart, emailDomain] = email.split('@');
    addLog('Email OSINT', `Analizando correo "${email}" en XposedOrNot, DNS-over-HTTPS y gestores de brechas...`, 'info');

    // Add extracted username node from email local part
    if (localPart) {
      const handleNodeId = `node-email-handle-${localPart}`;
      const conf = calculateConfidenceScore({
        seedQuery: email,
        candidateHandle: localPart,
        candidateDomainOrUrl: emailDomain,
        hints: workingCase.contextHints,
      });
      upsertNode({
        id: handleNodeId,
        label: `Alias Local: ${localPart}`,
        subtitle: 'Extraído de dirección de correo',
        type: 'username',
        platform: 'Extractor de Correo',
        category: 'Identidad Base',
        aliasFamily: 'Raíz Exacta',
        confidence: conf,
        verifiedStatus: 'verified',
        metadata: {
          aliasExtraido: localPart,
          dominioCorreo: emailDomain || 'N/D',
        },
      });
      upsertEdge(seedNodeId, handleNodeId, 'contiene_alias', 3);
    }

    // 2A. XposedOrNot Public API (Keyless)
    const xonUrl = `https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`;
    const xonRes = await fetchWithSmartRetries({
      url: xonUrl,
      platform: 'XposedOrNot',
      useProxy: false,
      corsProxy: credentials.corsProxy,
      maxRetries: 1,
      onRetryStatus: callbacks.onRetryStatus,
    });

    // If direct CORS fails on some browsers, fallback through proxy
    const finalXon =
      !xonRes.ok && xonRes.status === 0 && credentials.corsProxy
        ? await fetchWithSmartRetries({
            url: xonUrl,
            platform: 'XposedOrNot (Proxy)',
            useProxy: true,
            corsProxy: credentials.corsProxy,
            maxRetries: 1,
            onRetryStatus: callbacks.onRetryStatus,
          })
        : xonRes;

    if (finalXon.ok && finalXon.data) {
      const breaches: string[] = Array.isArray(finalXon.data?.breaches?.[0])
        ? finalXon.data.breaches[0]
        : Array.isArray(finalXon.data?.breaches)
        ? finalXon.data.breaches
        : [];

      if (breaches.length > 0) {
        addLog('XposedOrNot', `[!] Correo detectado en ${breaches.length} brecha(s) de seguridad públicas.`, 'warning');
        breaches.slice(0, 10).forEach((breachName: string) => {
          const bId = `node-breach-${breachName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          upsertNode({
            id: bId,
            label: `Brecha: ${breachName}`,
            subtitle: 'Exposición en XposedOrNot',
            type: 'breach',
            platform: 'XposedOrNot API',
            category: 'Seguridad y Brechas',
            aliasFamily: 'Incidentes',
            confidence: {
              total: 95,
              handleMatch: 30,
              aliasSimilarity: 20,
              bioNameMatch: 15,
              geoMatch: 15,
              avatarDomainMatch: 15,
              reasons: [`Confirmado en base de datos pública XposedOrNot (${breachName}) [+95]`],
            },
            verifiedStatus: 'verified',
            metadata: {
              incidente: breachName,
              correoAfectado: email,
              fuente: 'XposedOrNot Public API',
            },
          });
          upsertEdge(seedNodeId, bId, 'expuesto_en_brecha', 3);
        });
      } else {
        addLog('XposedOrNot', `Sin exposiciones públicas registradas para ${email} en XposedOrNot.`, 'success');
      }
    } else if (finalXon.status === 404) {
      addLog('XposedOrNot', `El correo ${email} no figura en brechas públicas de XposedOrNot (404 Clean).`, 'success');
    }

    // 2B. Optional Have I Been Pwned (HIBP) if API Key is provided
    if (credentials.hibpKey) {
      const hibpUrl = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`;
      const hibpRes = await fetchWithSmartRetries({
        url: hibpUrl,
        platform: 'Have I Been Pwned',
        useProxy: true,
        corsProxy: credentials.corsProxy,
        headers: {
          'hibp-api-key': credentials.hibpKey,
          'user-agent': 'FantasmaOSINT-Client',
        },
        maxRetries: 1,
        onRetryStatus: callbacks.onRetryStatus,
      });
      if (hibpRes.ok && Array.isArray(hibpRes.data)) {
        hibpRes.data.slice(0, 8).forEach((b: any) => {
          const bId = `node-hibp-${(b.Name || 'breach').toLowerCase()}`;
          upsertNode({
            id: bId,
            label: `HIBP: ${b.Title || b.Name}`,
            subtitle: `Fecha de brecha: ${b.BreachDate || 'N/D'}`,
            type: 'breach',
            platform: 'Have I Been Pwned',
            category: 'Seguridad y Brechas',
            aliasFamily: 'Incidentes',
            timestamp: b.BreachDate,
            confidence: {
              total: 98,
              handleMatch: 30,
              aliasSimilarity: 20,
              bioNameMatch: 18,
              geoMatch: 15,
              avatarDomainMatch: 15,
              reasons: [`Registro verificado con API Key de Have I Been Pwned (${b.Name})`],
            },
            verifiedStatus: 'verified',
            metadata: {
              dominioBrecha: b.Domain || 'N/D',
              fechaBrecha: b.BreachDate || 'N/D',
              cuentasAfectadas: b.PwnCount || 0,
            },
          });
          upsertEdge(seedNodeId, bId, 'hibp_breach', 3);
          if (b.BreachDate) {
            addTimeline({
              id: `tl-${bId}`,
              date: b.BreachDate,
              title: `Exposición en brecha ${b.Title || b.Name}`,
              description: `Incidente registrado en HIBP para ${email}.`,
              category: 'breach',
              sourcePlatform: 'Have I Been Pwned',
              nodeId: bId,
              confidence: 98,
            });
          }
        });
      }
    }

    // 2C. Optional Hunter.io Email Verifier if API Key is provided
    if (credentials.hunterKey) {
      const hunterUrl = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(credentials.hunterKey)}`;
      const hunterRes = await fetchWithSmartRetries({
        url: hunterUrl,
        platform: 'Hunter.io',
        useProxy: false,
        corsProxy: credentials.corsProxy,
        maxRetries: 1,
        onRetryStatus: callbacks.onRetryStatus,
      });
      if (hunterRes.ok && hunterRes.data?.data) {
        const hd = hunterRes.data.data;
        const hNodeId = `node-hunter-${email.replace(/[^a-z0-9]/g, '')}`;
        upsertNode({
          id: hNodeId,
          label: `Hunter.io: ${hd.status || 'Verificado'}`,
          subtitle: `Score entregabilidad: ${hd.score || 0}%`,
          type: 'email',
          platform: 'Hunter.io API',
          category: 'Inteligencia de Correo',
          aliasFamily: 'Raíz Exacta',
          confidence: {
            total: hd.score || 85,
            handleMatch: 28,
            aliasSimilarity: 18,
            bioNameMatch: 15,
            geoMatch: 12,
            avatarDomainMatch: 12,
            reasons: [`Verificación directa con Hunter.io API (Estado: ${hd.status})`],
          },
          verifiedStatus: 'verified',
          metadata: {
            estadoEntrega: hd.status || 'unknown',
            puntuacionHunter: hd.score || 0,
            servidorSmtp: hd.smtp_server ? 'Activo' : 'Desconocido',
            webmail: hd.webmail ? 'Sí' : 'Corporativo',
          },
        });
        upsertEdge(seedNodeId, hNodeId, 'verificado_hunter', 2);
      }
    }

    // 2D. Inspect Email Domain MX & SPF via Google DNS-over-HTTPS
    if (emailDomain) {
      const domNodeId = `node-email-domain-${emailDomain.replace(/[^a-z0-9]/g, '_')}`;
      upsertNode({
        id: domNodeId,
        label: emailDomain,
        subtitle: 'Dominio del Servidor de Correo',
        type: 'domain',
        platform: 'DNS-over-HTTPS',
        category: 'Infraestructura Web',
        aliasFamily: 'Infraestructura',
        url: `https://${emailDomain}`,
        confidence: {
          total: 90,
          handleMatch: 28,
          aliasSimilarity: 18,
          bioNameMatch: 14,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: ['Dominio extraído directamente de la dirección de correo objetivo [+90]'],
        },
        verifiedStatus: 'verified',
        metadata: { dominio: emailDomain },
      });
      upsertEdge(seedNodeId, domNodeId, 'alojado_en_dominio', 3);

      const mxRes = await fetchWithSmartRetries({
        url: `https://dns.google/resolve?name=${encodeURIComponent(emailDomain)}&type=MX`,
        platform: 'Google DoH (MX)',
        useProxy: false,
        corsProxy: credentials.corsProxy,
      });
      if (mxRes.ok && Array.isArray(mxRes.data?.Answer)) {
        const mxServers = mxRes.data.Answer.map((a: any) => a.data).slice(0, 4);
        if (mxServers.length > 0) {
          const mxId = `node-mx-${emailDomain.replace(/[^a-z0-9]/g, '_')}`;
          upsertNode({
            id: mxId,
            label: `MX: ${mxServers[0]}`,
            subtitle: `${mxServers.length} registros de correo entrante`,
            type: 'dns_record',
            platform: 'DNS-over-HTTPS',
            category: 'Infraestructura Web',
            aliasFamily: 'Infraestructura',
            confidence: {
              total: 92,
              handleMatch: 28,
              aliasSimilarity: 18,
              bioNameMatch: 16,
              geoMatch: 15,
              avatarDomainMatch: 15,
              reasons: ['Registros MX verificados en tiempo real mediante Google DoH [+92]'],
            },
            verifiedStatus: 'verified',
            metadata: {
              servidoresMX: mxServers.join(' | '),
            },
          });
          upsertEdge(domNodeId, mxId, 'registro_mx', 2);
        }
      }
    }

    // 2E. SHA-256 Gravatar Hash & OpenPGP Keyserver Correlation
    try {
      const msgBuffer = new TextEncoder().encode(email.trim().toLowerCase());
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const sha256Email = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const hashNodeId = `node-hash-${sha256Email.slice(0, 10)}`;
      upsertNode({
        id: hashNodeId,
        label: `Gravatar SHA256: ${sha256Email.slice(0, 10)}…`,
        subtitle: 'Huella Criptográfica de Identidad',
        type: 'email',
        platform: 'Gravatar / OpenPGP',
        category: 'Identidad Criptográfica',
        aliasFamily: 'Raíz Exacta',
        url: `https://keys.openpgp.org/search?q=${encodeURIComponent(email)}`,
        confidence: {
          total: 90,
          handleMatch: 28,
          aliasSimilarity: 18,
          bioNameMatch: 14,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: [`Hash SHA-256 estándar calculado para correlación Gravatar/PGP (${sha256Email.slice(0, 14)}...) [+90]`],
        },
        verifiedStatus: 'verified',
        metadata: {
          sha256: sha256Email,
          openPgpSearch: `https://keys.openpgp.org/search?q=${encodeURIComponent(email)}`,
        },
      });
      upsertEdge(seedNodeId, hashNodeId, 'hash_identidad_sha256', 2);
    } catch {
      // Ignore WebCrypto error
    }

    callbacks.onCaseProgress({ ...workingCase });
  }

  // ============================================================================
  // MODULE 3: DOMAIN & URL INTELLIGENCE (crt.sh + RDAP/WHOIS + DoH + VirusTotal/URLScan)
  // ============================================================================
  if (inputType === 'domain') {
    const cleanDomain = cleanQuery
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .toLowerCase();

    addLog('Domain OSINT', `Iniciando reconocimiento pasivo del dominio "${cleanDomain}" (crt.sh, RDAP, DoH)...`, 'info');

    // 3A. RDAP / WHOIS Query (https://rdap.org/domain/{domain})
    const rdapRes = await fetchWithSmartRetries({
      url: `https://rdap.org/domain/${encodeURIComponent(cleanDomain)}`,
      platform: 'RDAP / WHOIS',
      useProxy: false,
      corsProxy: credentials.corsProxy,
      maxRetries: 1,
      onRetryStatus: callbacks.onRetryStatus,
    });

    if (rdapRes.ok && rdapRes.data) {
      const events: any[] = rdapRes.data.events || [];
      const regEvent = events.find((e) => e.eventAction === 'registration');
      const expEvent = events.find((e) => e.eventAction === 'expiration');
      const nameservers = (rdapRes.data.nameservers || [])
        .map((ns: any) => ns.ldhName)
        .filter(Boolean)
        .join(', ');

      const regDate = regEvent?.eventDate ? regEvent.eventDate.slice(0, 10) : '';
      const rdapNodeId = `node-rdap-${cleanDomain.replace(/[^a-z0-9]/g, '_')}`;

      upsertNode({
        id: rdapNodeId,
        label: `RDAP: ${cleanDomain}`,
        subtitle: regDate ? `Registrado: ${regDate}` : 'Registro WHOIS/RDAP Activo',
        type: 'domain',
        platform: 'RDAP / ICANN',
        category: 'Infraestructura Web',
        aliasFamily: 'Infraestructura',
        timestamp: regDate || undefined,
        confidence: {
          total: 96,
          handleMatch: 30,
          aliasSimilarity: 20,
          bioNameMatch: 16,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: ['Datos registrales oficiales extraídos del servidor RDAP [+96]'],
        },
        verifiedStatus: 'verified',
        metadata: {
          handleRdap: rdapRes.data.handle || 'N/D',
          fechaRegistro: regDate || 'N/D',
          fechaExpiracion: expEvent?.eventDate ? expEvent.eventDate.slice(0, 10) : 'N/D',
          nameservers: nameservers || 'N/D',
          estado: (rdapRes.data.status || []).join(', ') || 'Activo',
        },
      });
      upsertEdge(seedNodeId, rdapNodeId, 'registro_rdap_whois', 3);

      if (regDate) {
        addTimeline({
          id: `tl-rdap-${cleanDomain}`,
          date: regDate,
          title: `Registro WHOIS/RDAP del dominio ${cleanDomain}`,
          description: `Nameservers: ${nameservers || 'Estándar'}. Estado: ${(rdapRes.data.status || [])[0] || 'Activo'}.`,
          category: 'domain_whois',
          sourcePlatform: 'RDAP Public Server',
          nodeId: rdapNodeId,
          confidence: 96,
        });
      }
      addLog('RDAP / WHOIS', `[+] Metadatos WHOIS/RDAP obtenidos para ${cleanDomain} (Alta: ${regDate || 'N/D'}).`, 'success');
    }

    // 3B. crt.sh Certificate Transparency Subdomain Discovery
    const crtUrl = `https://crt.sh/?q=%25.${encodeURIComponent(cleanDomain)}&output=json`;
    const crtRes = await fetchWithSmartRetries({
      url: crtUrl,
      platform: 'crt.sh CT Logs',
      useProxy: false,
      corsProxy: credentials.corsProxy,
      timeoutMs: 9000,
      maxRetries: 1,
      onRetryStatus: callbacks.onRetryStatus,
    });

    const finalCrt =
      !crtRes.ok && credentials.corsProxy
        ? await fetchWithSmartRetries({
            url: crtUrl,
            platform: 'crt.sh (Proxy)',
            useProxy: true,
            corsProxy: credentials.corsProxy,
            timeoutMs: 9000,
            maxRetries: 1,
            onRetryStatus: callbacks.onRetryStatus,
          })
        : crtRes;

    if (finalCrt.ok && Array.isArray(finalCrt.data)) {
      const seenSubs = new Set<string>();
      for (const cert of finalCrt.data) {
        const names: string[] = String(cert.name_value || '')
          .split('\n')
          .map((s) => s.trim().toLowerCase().replace(/^\*\./, ''))
          .filter((s) => s && s.endsWith(cleanDomain));

        for (const sub of names) {
          if (!seenSubs.has(sub) && seenSubs.size < 12) {
            seenSubs.add(sub);
            const subNodeId = `node-sub-${sub.replace(/[^a-z0-9]/g, '_')}`;
            const certDate = String(cert.not_before || cert.entry_timestamp || '').slice(0, 10);

            upsertNode({
              id: subNodeId,
              label: sub,
              subtitle: `Subdominio CT (${(cert.issuer_name || 'TLS').slice(0, 28)})`,
              type: 'subdomain',
              platform: 'crt.sh',
              category: 'Infraestructura Web',
              aliasFamily: 'Subdominios',
              url: `https://${sub}`,
              timestamp: certDate || undefined,
              confidence: {
                total: 93,
                handleMatch: 28,
                aliasSimilarity: 19,
                bioNameMatch: 16,
                geoMatch: 15,
                avatarDomainMatch: 15,
                reasons: [`Certificado TLS histórico verificado en crt.sh para ${sub} [+93]`],
              },
              verifiedStatus: 'verified',
              metadata: {
                subdominio: sub,
                emisor: cert.issuer_name || 'Autoridad Certificadora',
                validoDesde: certDate || 'N/D',
                validoHasta: String(cert.not_after || '').slice(0, 10),
                idCertificado: cert.id || 'N/D',
              },
            });
            upsertEdge(seedNodeId, subNodeId, 'subdominio_crtsh', 2);

            if (certDate && seenSubs.size <= 5) {
              addTimeline({
                id: `tl-crt-${subNodeId}`,
                date: certDate,
                title: `Certificado TLS emitido para ${sub}`,
                description: `Registrado en logs de Certificate Transparency (crt.sh).`,
                category: 'certificate',
                sourcePlatform: 'crt.sh',
                nodeId: subNodeId,
                confidence: 93,
              });
            }
          }
        }
      }
      addLog('crt.sh', `[+] Descubiertos ${seenSubs.size} subdominios únicos en Certificate Transparency.`, 'success');
    }

    // 3C. DNS Resolution (Google DoH) -> Auto-chain to Shodan InternetDB & GeoIP!
    const dnsRes = await fetchWithSmartRetries({
      url: `https://dns.google/resolve?name=${encodeURIComponent(cleanDomain)}&type=A`,
      platform: 'Google DoH (A)',
      useProxy: false,
      corsProxy: credentials.corsProxy,
    });

    if (dnsRes.ok && Array.isArray(dnsRes.data?.Answer)) {
      const aRecords = dnsRes.data.Answer.filter((r: any) => r.type === 1).map((r: any) => r.data);
      for (const ipAddr of aRecords.slice(0, 2)) {
        const ipNodeId = `node-ip-${ipAddr.replace(/\./g, '_')}`;
        upsertNode({
          id: ipNodeId,
          label: ipAddr,
          subtitle: `IP resuelta de ${cleanDomain}`,
          type: 'ip',
          platform: 'DNS / Shodan InternetDB',
          category: 'Infraestructura de Red',
          aliasFamily: 'Infraestructura',
          confidence: {
            total: 94,
            handleMatch: 29,
            aliasSimilarity: 19,
            bioNameMatch: 16,
            geoMatch: 15,
            avatarDomainMatch: 15,
            reasons: [`Registro DNS A activo para ${cleanDomain} -> ${ipAddr} [+94]`],
          },
          verifiedStatus: 'verified',
          metadata: { ip: ipAddr, dominioOrigen: cleanDomain },
        });
        upsertEdge(seedNodeId, ipNodeId, 'resuelve_a_ip', 3);

        // Enrich IP with Shodan InternetDB & GeoIP
        await enrichIpNode({
          ipAddr,
          ipNodeId,
          credentials,
          upsertNode,
          upsertEdge,
          addLocation,
          addTimeline,
          addLog,
          onRetryStatus: callbacks.onRetryStatus,
        });
      }
    }

    // 3D. Optional VirusTotal Domain Report & URLScan.io
    if (credentials.virusTotalKey) {
      const vtRes = await fetchWithSmartRetries({
        url: `https://www.virustotal.com/api/v3/domains/${encodeURIComponent(cleanDomain)}`,
        platform: 'VirusTotal API',
        useProxy: false,
        corsProxy: credentials.corsProxy,
        headers: { 'x-apikey': credentials.virusTotalKey },
        onRetryStatus: callbacks.onRetryStatus,
      });
      if (vtRes.ok && vtRes.data?.data?.attributes) {
        const stats = vtRes.data.data.attributes.last_analysis_stats || {};
        const vtNodeId = `node-vt-${cleanDomain.replace(/[^a-z0-9]/g, '_')}`;
        upsertNode({
          id: vtNodeId,
          label: `VirusTotal: ${stats.malicious || 0} detecciones`,
          subtitle: `Reputación de ${cleanDomain}`,
          type: 'domain',
          platform: 'VirusTotal v3',
          category: 'Seguridad y Brechas',
          aliasFamily: 'Infraestructura',
          confidence: {
            total: 97,
            handleMatch: 30,
            aliasSimilarity: 20,
            bioNameMatch: 17,
            geoMatch: 15,
            avatarDomainMatch: 15,
            reasons: ['Análisis de motores de seguridad vía VirusTotal API v3 [+97]'],
          },
          verifiedStatus: 'verified',
          metadata: {
            maliciosos: stats.malicious || 0,
            sospechosos: stats.suspicious || 0,
            limpios: stats.harmless || 0,
            reputacion: vtRes.data.data.attributes.reputation ?? 0,
          },
        });
        upsertEdge(seedNodeId, vtNodeId, 'analisis_virustotal', 2);
      }
    }

    if (credentials.urlScanKey) {
      const usRes = await fetchWithSmartRetries({
        url: `https://urlscan.io/api/v1/search/?q=domain:${encodeURIComponent(cleanDomain)}&size=3`,
        platform: 'URLScan.io',
        useProxy: true,
        corsProxy: credentials.corsProxy,
        headers: { 'API-Key': credentials.urlScanKey },
        onRetryStatus: callbacks.onRetryStatus,
      });
      if (usRes.ok && Array.isArray(usRes.data?.results) && usRes.data.results.length > 0) {
        const first = usRes.data.results[0];
        const usNodeId = `node-urlscan-${cleanDomain.replace(/[^a-z0-9]/g, '_')}`;
        upsertNode({
          id: usNodeId,
          label: `URLScan: ${first.page?.server || 'Escaneado'}`,
          subtitle: `ASN: ${first.page?.asnname || 'N/D'}`,
          type: 'domain',
          platform: 'URLScan.io API',
          category: 'Infraestructura Web',
          aliasFamily: 'Infraestructura',
          url: first.result,
          confidence: {
            total: 94,
            handleMatch: 29,
            aliasSimilarity: 19,
            bioNameMatch: 16,
            geoMatch: 15,
            avatarDomainMatch: 15,
            reasons: [' Captura e inspección histórica en URLScan.io [+94]'],
          },
          verifiedStatus: 'verified',
          metadata: {
            servidorWeb: first.page?.server || 'N/D',
            asn: first.page?.asn || 'N/D',
            pais: first.page?.country || 'N/D',
          },
        });
        upsertEdge(seedNodeId, usNodeId, 'captura_urlscan', 2);
      }
    }

    // 3E. Wayback Machine (Archive.org) Historical Snapshot Discovery
    const wbRes = await fetchWithSmartRetries({
      url: `https://archive.org/wayback/available?url=${encodeURIComponent(cleanDomain)}`,
      platform: 'Wayback Machine',
      useProxy: false,
      corsProxy: credentials.corsProxy,
      maxRetries: 1,
      onRetryStatus: callbacks.onRetryStatus,
    });

    if (wbRes.ok && wbRes.data?.archived_snapshots?.closest?.available) {
      const snap = wbRes.data.archived_snapshots.closest;
      const ts = String(snap.timestamp || '');
      const formattedDate =
        ts.length >= 8 ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
      const wbNodeId = `node-wayback-${cleanDomain.replace(/[^a-z0-9]/g, '_')}`;

      upsertNode({
        id: wbNodeId,
        label: `Wayback (${formattedDate})`,
        subtitle: `Snapshot Archive.org HTTP ${snap.status || '200'}`,
        type: 'domain',
        platform: 'Archive.org',
        category: 'Archivo Histórico',
        aliasFamily: 'Infraestructura',
        url: snap.url,
        timestamp: formattedDate,
        confidence: {
          total: 94,
          handleMatch: 29,
          aliasSimilarity: 19,
          bioNameMatch: 16,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: [`Captura histórica verificada en Wayback Machine (${formattedDate}) [+94]`],
        },
        verifiedStatus: 'verified',
        metadata: {
          fechaSnapshot: formattedDate,
          urlArchivada: snap.url || 'N/D',
          estadoHttp: snap.status || 200,
        },
      });
      upsertEdge(seedNodeId, wbNodeId, 'snapshot_wayback', 2);

      addTimeline({
        id: `tl-wb-${cleanDomain}`,
        date: formattedDate,
        title: `Captura archivada en Wayback Machine (${cleanDomain})`,
        description: `Snapshot disponible en Internet Archive (${snap.url}).`,
        category: 'domain_whois',
        sourcePlatform: 'Archive.org',
        sourceUrl: snap.url,
        nodeId: wbNodeId,
        confidence: 94,
      });
      addLog('Wayback Machine', `[+] Snapshot histórico localizado para ${cleanDomain} (${formattedDate}).`, 'success');
    }

    callbacks.onCaseProgress({ ...workingCase });
  }

  // ============================================================================
  // MODULE 4: IP INTELLIGENCE (Shodan InternetDB + GeoIP Leaflet + AbuseIPDB)
  // ============================================================================
  if (inputType === 'ip') {
    const ipAddr = cleanQuery;
    addLog('IP OSINT', `Consultando Shodan InternetDB (${ipAddr}), geolocalización y RDAP de red...`, 'info');
    await enrichIpNode({
      ipAddr,
      ipNodeId: seedNodeId,
      credentials,
      upsertNode,
      upsertEdge,
      addLocation,
      addTimeline,
      addLog,
      onRetryStatus: callbacks.onRetryStatus,
    });
    callbacks.onCaseProgress({ ...workingCase });
  }

  // ============================================================================
  // MODULE 5: PHONE, REAL NAME & NATIONAL ID (DNI/NIF) + GOOGLE DORKS & SERPER
  // ============================================================================
  if (inputType === 'phone' || inputType === 'real_name' || inputType === 'national_id') {
    if (inputType === 'phone') {
      const digits = cleanQuery.replace(/\D/g, '');
      let countryLabel = 'Internacional';
      let lat = 40.4168;
      let lng = -3.7038;
      let cc = 'ES';

      if (cleanQuery.startsWith('+34') || (digits.length === 9 && /^[6789]/.test(digits))) {
        countryLabel = 'España (+34)';
        lat = 40.4168;
        lng = -3.7038;
        cc = 'ES';
      } else if (cleanQuery.startsWith('+52')) {
        countryLabel = 'México (+52)';
        lat = 19.4326;
        lng = -99.1332;
        cc = 'MX';
      } else if (cleanQuery.startsWith('+54')) {
        countryLabel = 'Argentina (+54)';
        lat = -34.6037;
        lng = -58.3816;
        cc = 'AR';
      } else if (cleanQuery.startsWith('+57')) {
        countryLabel = 'Colombia (+57)';
        lat = 4.711;
        lng = -74.0721;
        cc = 'CO';
      } else if (cleanQuery.startsWith('+1')) {
        countryLabel = 'EE.UU. / Canadá (+1)';
        lat = 38.9072;
        lng = -77.0369;
        cc = 'US';
      }

      const phoneMetaNodeId = `node-phone-meta-${digits}`;
      upsertNode({
        id: phoneMetaNodeId,
        label: `Región ITU: ${countryLabel}`,
        subtitle: `Formato E.164: +${digits}`,
        type: 'phone',
        platform: 'Analizador E.164',
        category: 'Telecomunicaciones',
        aliasFamily: 'Identidad Base',
        coordinates: { lat, lng, label: `Jurisdicción Telefónica: ${countryLabel}` },
        confidence: {
          total: 90,
          handleMatch: 28,
          aliasSimilarity: 18,
          bioNameMatch: 14,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: [`Prefijo telefónico internacional validado (${countryLabel}) [+90]`],
        },
        verifiedStatus: 'verified',
        metadata: {
          formatoE164: `+${digits}`,
          jurisdiccion: countryLabel,
          tipoLinea: /^[67]/.test(digits.slice(-9)) ? 'Móvil / Celular' : 'Fijo / VoIP',
        },
      });
      upsertEdge(seedNodeId, phoneMetaNodeId, 'prefijo_itu', 3);

      addLocation({
        id: `geo-phone-${digits}`,
        lat,
        lng,
        title: `Jurisdicción Telefónica: ${countryLabel}`,
        subtitle: `Asociada al número +${digits}`,
        category: 'phone_region',
        confidence: 90,
        nodeId: phoneMetaNodeId,
        source: 'Prefijo UIT E.164',
        countryCode: cc,
      });

      addManualTask({
        platform: 'WhatsApp Direct Check',
        url: `https://wa.me/${digits}`,
        target: `+${digits}`,
        reason: 'MANUAL_DORK',
        retriesAttempted: 0,
        notes: 'Verificación pasiva de existencia de cuenta y foto de perfil en WhatsApp.',
      });
      addLog('Phone OSINT', `[+] Analizado número +${digits} (${countryLabel}) y geolocalizado en el mapa.`, 'success');
    }

    if (inputType === 'national_id') {
      const upperId = cleanQuery.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const letters = 'TRWAGMYFPDXBNJZSQVHLCKE';
      let isValidMod23 = false;
      let expectedLetter = '';

      if (/^[0-9]{8}[A-Z]$/.test(upperId)) {
        const num = parseInt(upperId.slice(0, 8), 10);
        expectedLetter = letters[num % 23];
        isValidMod23 = expectedLetter === upperId[8];
      } else if (/^[XYZ][0-9]{7}[A-Z]$/.test(upperId)) {
        const prefixMap: Record<string, string> = { X: '0', Y: '1', Z: '2' };
        const num = parseInt(prefixMap[upperId[0]] + upperId.slice(1, 8), 10);
        expectedLetter = letters[num % 23];
        isValidMod23 = expectedLetter === upperId[8];
      }

      const idNode = `node-id-check-${upperId}`;
      upsertNode({
        id: idNode,
        label: isValidMod23 ? `DNI/NIE Válido (${upperId})` : `ID: ${upperId}`,
        subtitle: expectedLetter
          ? `Control Mod-23: Letra ${expectedLetter} (${isValidMod23 ? 'Correcta' : 'Discrepante'})`
          : 'Identificador Nacional / Documento',
        type: 'national_id',
        platform: 'Validador Algorítmico',
        category: 'Identidad Legal',
        aliasFamily: 'Identidad Base',
        confidence: {
          total: isValidMod23 ? 97 : 75,
          handleMatch: 30,
          aliasSimilarity: 20,
          bioNameMatch: 17,
          geoMatch: 15,
          avatarDomainMatch: isValidMod23 ? 15 : 0,
          reasons: [
            isValidMod23
              ? `Dígito de control Módulo-23 verificado matemáticamente (${expectedLetter}) [+97]`
              : 'Formato de identificador analizado para búsqueda en boletines públicos [+75]',
          ],
        },
        verifiedStatus: isValidMod23 ? 'verified' : 'unverified',
        metadata: {
          documento: upperId,
          checksumMod23: isValidMod23 ? 'VÁLIDO' : 'No aplicable / Internacional',
          letraControlEsperada: expectedLetter || 'N/A',
        },
      });
      upsertEdge(seedNodeId, idNode, 'validacion_algoritmica', 3);
      addLog('ID Analyzer', `[+] Verificación de documento ${upperId} completada.`, 'success');
    }

    // Generate Automated Google Dorks & Serper.dev search
    const dorks = [
      {
        label: `Dork Perfiles: "${cleanQuery}"`,
        q: `"${cleanQuery}" (site:linkedin.com OR site:github.com OR site:x.com OR site:instagram.com)`,
      },
      {
        label: `Dork Documentos: "${cleanQuery}"`,
        q: `"${cleanQuery}" (filetype:pdf OR filetype:xlsx OR filetype:docx)`,
      },
      {
        label: `Dork Boletines Oficiales: "${cleanQuery}"`,
        q: `"${cleanQuery}" (site:boe.es OR site:borme.es OR "boletín oficial")`,
      },
    ];

    for (const d of dorks) {
      const dorkUrl = `https://www.google.com/search?q=${encodeURIComponent(d.q)}`;
      const dorkId = `node-dork-${d.label.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      upsertNode({
        id: dorkId,
        label: d.label,
        subtitle: d.q.slice(0, 48) + '...',
        type: 'dork_query',
        platform: 'Google Dorking Engine',
        category: 'Búsqueda Avanzada',
        aliasFamily: 'Dorks OSINT',
        url: dorkUrl,
        confidence: {
          total: 82,
          handleMatch: 25,
          aliasSimilarity: 17,
          bioNameMatch: 15,
          geoMatch: 13,
          avatarDomainMatch: 12,
          reasons: ['Consulta Google Dork automatizada generada para el objetivo [+82]'],
        },
        verifiedStatus: 'verified',
        metadata: {
          consultaDork: d.q,
          motor: 'Google / DuckDuckGo',
        },
      });
      upsertEdge(seedNodeId, dorkId, 'google_dork', 2);

      addManualTask({
        platform: 'Google Dork Automatizado',
        url: dorkUrl,
        target: cleanQuery,
        reason: 'MANUAL_DORK',
        retriesAttempted: 0,
        notes: `Dork: ${d.q}`,
      });
    }

    // Optional Serper.dev Live Search API if key configured
    if (credentials.serperKey) {
      try {
        const serperRes = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': credentials.serperKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: `"${cleanQuery}"`, num: 5 }),
        });
        if (serperRes.ok) {
          const sData = await serperRes.json();
          const organic: any[] = sData.organic || [];
          organic.slice(0, 5).forEach((item, idx) => {
            const sId = `node-serper-${idx}-${Date.now()}`;
            upsertNode({
              id: sId,
              label: (item.title || 'Resultado Web').slice(0, 38),
              subtitle: item.link || '',
              type: 'dork_query',
              platform: 'Serper.dev API',
              category: 'Búsqueda Web',
              aliasFamily: 'Resultados Serper',
              url: item.link,
              confidence: {
                total: 88,
                handleMatch: 28,
                aliasSimilarity: 18,
                bioNameMatch: 16,
                geoMatch: 13,
                avatarDomainMatch: 13,
                reasons: ['Resultado indexado obtenido en vivo vía Serper.dev API [+88]'],
              },
              verifiedStatus: 'verified',
              metadata: {
                titulo: item.title || '',
                fragmento: item.snippet || '',
                url: item.link || '',
              },
            });
            upsertEdge(seedNodeId, sId, 'resultado_serper', 2);
          });
          addLog('Serper.dev', `[+] Extraídos ${organic.length} resultados web en vivo vía Serper.dev.`, 'success');
        }
      } catch {
        addLog('Serper.dev', 'Error al conectar con Serper.dev API.', 'warning');
      }
    }

    callbacks.onCaseProgress({ ...workingCase });
  }

  addLog('OSINT Engine', `Investigación completada sobre "${cleanQuery}". Grafo y evidencias actualizadas en IndexedDB.`, 'success');
  return workingCase;
}

/**
 * Helper to enrich any IP node with passive Shodan InternetDB (`https://internetdb.shodan.io/{ip}`),
 * GeoIP (`https://ipwho.is/{ip}`), and AbuseIPDB / Shodan API.
 */
async function enrichIpNode(params: {
  ipAddr: string;
  ipNodeId: string;
  credentials: ApiCredentials;
  upsertNode: (node: GraphNode) => void;
  upsertEdge: (source: string, target: string, relation: string, weight?: number) => void;
  addLocation: (loc: GeoMarker) => void;
  addTimeline: (ev: TimelineEvent) => void;
  addLog: (module: string, message: string, level?: InvestigationLog['level']) => void;
  onRetryStatus: (status: RetryTaskStatus) => void;
}) {
  const {
    ipAddr,
    ipNodeId,
    credentials,
    upsertNode,
    upsertEdge,
    addLocation,
    addTimeline,
    addLog,
    onRetryStatus,
  } = params;

  // 1. Shodan InternetDB (Free, keyless, CORS-enabled)
  const idbUrl = `https://internetdb.shodan.io/${encodeURIComponent(ipAddr)}`;
  const idbRes = await fetchWithSmartRetries({
    url: idbUrl,
    platform: 'Shodan InternetDB',
    useProxy: false,
    corsProxy: credentials.corsProxy,
    maxRetries: 1,
    onRetryStatus,
  });

  if (idbRes.ok && idbRes.data) {
    const ports: number[] = idbRes.data.ports || [];
    const vulns: string[] = idbRes.data.vulns || [];
    const hostnames: string[] = idbRes.data.hostnames || [];
    const cpes: string[] = idbRes.data.cpes || [];
    const tags: string[] = idbRes.data.tags || [];

    if (ports.length > 0 || vulns.length > 0) {
      const portNodeId = `node-idb-ports-${ipAddr.replace(/\./g, '_')}`;
      upsertNode({
        id: portNodeId,
        label: `Puertos: ${ports.slice(0, 6).join(', ') || 'Ninguno'}`,
        subtitle: vulns.length > 0 ? `${vulns.length} CVEs detectadas` : 'Superficie Shodan InternetDB',
        type: 'port_vuln',
        platform: 'Shodan InternetDB',
        category: 'Infraestructura de Red',
        aliasFamily: 'Infraestructura',
        confidence: {
          total: 95,
          handleMatch: 30,
          aliasSimilarity: 20,
          bioNameMatch: 15,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: [`Enumeración pasiva oficial desde internetdb.shodan.io/${ipAddr} [+95]`],
        },
        verifiedStatus: 'verified',
        metadata: {
          ip: ipAddr,
          puertosAbiertos: ports.join(', ') || 'Ninguno',
          hostnames: hostnames.join(', ') || 'N/D',
          cpes: cpes.join(', ') || 'N/D',
          vulnerabilidadesCVE: vulns.slice(0, 10).join(', ') || '0 CVEs conocidas',
          tags: tags.join(', ') || 'N/D',
        },
      });
      upsertEdge(ipNodeId, portNodeId, 'shodan_internetdb', 3);

      addTimeline({
        id: `tl-idb-${ipAddr}`,
        date: new Date().toISOString().slice(0, 10),
        title: `Enumeración pasiva Shodan InternetDB en ${ipAddr}`,
        description: `Puertos abiertos: ${ports.join(', ') || 'N/A'}. Vulnerabilidades: ${vulns.length}.`,
        category: 'network',
        sourcePlatform: 'Shodan InternetDB',
        nodeId: portNodeId,
        confidence: 95,
      });

      addLog(
        'Shodan InternetDB',
        `[+] ${ipAddr}: Puertos [${ports.join(', ')}] | CVEs: ${vulns.length} | Hostnames: ${hostnames.length}`,
        vulns.length > 0 ? 'warning' : 'success'
      );
    }
  }

  // 2. GeoIP Lookup via ipwho.is (CORS-friendly) for Leaflet Map
  const geoRes = await fetchWithSmartRetries({
    url: `https://ipwho.is/${encodeURIComponent(ipAddr)}`,
    platform: 'GeoIP (ipwho.is)',
    useProxy: false,
    corsProxy: credentials.corsProxy,
    maxRetries: 1,
    onRetryStatus,
  });

  if (geoRes.ok && geoRes.data && geoRes.data.success !== false && typeof geoRes.data.latitude === 'number') {
    const g = geoRes.data;
    const locTitle = `${g.city || 'Nodo'}, ${g.country || 'Red'}`;
    addLocation({
      id: `geo-ip-${ipAddr.replace(/\./g, '_')}`,
      lat: g.latitude,
      lng: g.longitude,
      title: `${locTitle} (${ipAddr})`,
      subtitle: `ISP/ASN: ${g.connection?.isp || g.connection?.org || 'Proveedor de Red'} (AS${g.connection?.asn || ''})`,
      category: 'ip_host',
      confidence: 93,
      nodeId: ipNodeId,
      source: 'GeoIP / ASN Intelligence',
      countryCode: g.country_code || 'UN',
    });

    const locNodeId = `node-loc-${ipAddr.replace(/\./g, '_')}`;
    upsertNode({
      id: locNodeId,
      label: locTitle,
      subtitle: `${g.connection?.org || g.connection?.isp || 'ASN'} (${g.country_code || ''})`,
      type: 'location',
      platform: 'GeoIP / Leaflet',
      category: 'Geolocalización',
      aliasFamily: 'Infraestructura',
      coordinates: { lat: g.latitude, lng: g.longitude, label: locTitle },
      confidence: {
        total: 93,
        handleMatch: 28,
        aliasSimilarity: 18,
        bioNameMatch: 17,
        geoMatch: 15,
        avatarDomainMatch: 15,
        reasons: [`Coordenadas de enrutamiento BGP/GeoIP verificadas (${g.latitude}, ${g.longitude}) [+93]`],
      },
      verifiedStatus: 'verified',
      metadata: {
        ciudad: g.city || 'N/D',
        region: g.region || 'N/D',
        pais: g.country || 'N/D',
        isp: g.connection?.isp || 'N/D',
        asn: g.connection?.asn ? `AS${g.connection.asn}` : 'N/D',
        zonaHoraria: g.timezone?.id || 'UTC',
      },
    });
    upsertEdge(ipNodeId, locNodeId, 'geolocalizado_en', 2);
    addLog('GeoIP Leaflet', `[+] IP ${ipAddr} geolocalizada en ${locTitle} (${g.latitude.toFixed(2)}, ${g.longitude.toFixed(2)}).`, 'success');
  }

  // 3. RIPE Stat BGP Prefix & ASN Intelligence (Keyless Public API)
  const ripeRes = await fetchWithSmartRetries({
    url: `https://stat.ripe.net/data/prefix-overview/data.json?resource=${encodeURIComponent(ipAddr)}`,
    platform: 'RIPE Stat BGP',
    useProxy: false,
    corsProxy: credentials.corsProxy,
    maxRetries: 1,
    onRetryStatus,
  });

  if (ripeRes.ok && ripeRes.data?.data?.resource) {
    const rd = ripeRes.data.data;
    const asns: any[] = rd.asns || [];
    const holder = asns[0]?.holder || 'Autonomous System';
    const asnNum = asns[0]?.asn ? `AS${asns[0].asn}` : 'ASN';
    const bgpNodeId = `node-bgp-${ipAddr.replace(/\./g, '_')}`;

    upsertNode({
      id: bgpNodeId,
      label: `BGP: ${rd.resource} (${asnNum})`,
      subtitle: holder,
      type: 'dns_record',
      platform: 'RIPE Stat BGP',
      category: 'Enrutamiento BGP',
      aliasFamily: 'Infraestructura',
      confidence: {
        total: 95,
        handleMatch: 29,
        aliasSimilarity: 19,
        bioNameMatch: 17,
        geoMatch: 15,
        avatarDomainMatch: 15,
        reasons: [`Prefijo de enrutamiento BGP anunciado por ${asnNum} (${holder}) verificado en RIPE Stat [+95]`],
      },
      verifiedStatus: 'verified',
      metadata: {
        prefijoCidr: rd.resource,
        asn: asnNum,
        operadorTitular: holder,
        enrutado: rd.is_less_specific ? 'Subprefijo' : 'Anuncio Directo BGP',
      },
    });
    upsertEdge(ipNodeId, bgpNodeId, 'anuncio_bgp_asn', 2);
    addLog('RIPE Stat BGP', `[+] Prefijo BGP ${rd.resource} anunciado por ${asnNum} (${holder}).`, 'success');
  }
}

/**
 * Generates an Executive OSINT Intelligence Summary using either the user's OpenAI API Key
 * (100% client-side call to api.openai.com) or the built-in deterministic OSINT synthesizer.
 */
export async function generateCaseAiSummary(
  osintCase: InvestigationCase,
  credentials: ApiCredentials
): Promise<{ summary: string; mode: 'openai' | 'local_heuristic' }> {
  const highConfNodes = osintCase.nodes.filter((n) => n.confidence.total >= 75 && n.type !== 'seed');
  const lowConfNodes = osintCase.nodes.filter((n) => n.confidence.total < 55);
  const locationsList = osintCase.locations.map((l) => `${l.title} (${l.source})`).join('; ');
  const timelineList = osintCase.timeline.map((t) => `${t.date}: ${t.title}`).join(' | ');

  if (credentials.openAiKey && credentials.openAiKey.trim().startsWith('sk-')) {
    try {
      const prompt = `Actúa como un Analista Senior de Ciberinteligencia y OSINT. Redacta un Resumen Ejecutivo estructurado en español sobre el siguiente caso de investigación:
- Objetivo Principal (Seed): ${osintCase.seedQuery} (Tipo: ${osintCase.seedType})
- Hallazgos de Alta Confianza (${highConfNodes.length}): ${highConfNodes.map((n) => `${n.label} [${n.platform}, Score ${n.confidence.total}/100]`).join(', ')}
- Posibles Homónimos / Baja Confianza (${lowConfNodes.length}): ${lowConfNodes.map((n) => `${n.label} [Score ${n.confidence.total}/100]`).join(', ')}
- Ubicaciones Geográficas Extraídas: ${locationsList || 'Ninguna'}
- Cronología (Timeline): ${timelineList || 'Sin eventos fechados'}
- Tareas Manuales Pendientes (HTTP 429 / WAF): ${osintCase.manualTasks.length}

Incluye: 1) Síntesis de Identidad y Correlación, 2) Evaluación de Infraestructura y Exposición, 3) Discriminación de Homónimos, y 4) Recomendaciones de Pivoteo.`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.openAiKey.trim()}`,
        },
        body: JSON.stringify({
          model: credentials.openAiModel || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'Eres un analista principal de inteligencia OSINT de la plataforma Un Fantasma en el Sistema. Sé preciso, técnico y estructurado.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          return { summary: text, mode: 'openai' };
        }
      }
    } catch (e) {
      console.warn('Fallo al invocar OpenAI API desde el cliente, usando sintetizador heurístico local:', e);
    }
  }

  // Deterministic Local Heuristic OSINT Synthesis
  const avgConfidence =
    osintCase.nodes.length > 0
      ? Math.round(osintCase.nodes.reduce((acc, n) => acc + n.confidence.total, 0) / osintCase.nodes.length)
      : 0;

  const summary = [
    `INFORME DE SÍNTESIS HEURÍSTICA LOCAL — CASO: ${osintCase.name.toUpperCase()}`,
    `1. Correlación de Identidad y Superficie: A partir de la semilla "${osintCase.seedQuery}" (${osintCase.seedType}), se han correlacionado ${osintCase.nodes.length} entidades en el grafo con una puntuación media de confianza de ${avgConfidence}/100. Se identificaron ${highConfNodes.length} hallazgos de alta fiabilidad (>=75/100): ${highConfNodes.slice(0, 6).map((n) => n.label).join(', ') || 'N/A'}.`,
    `2. Familias de Alias y Cribado de Homónimos: El motor morfológico generó ${osintCase.aliasVariants.length} variantes (Leet Speak, duplicación de caracteres y sufijos). ${lowConfNodes.length > 0 ? `Se aislaron ${lowConfNodes.length} perfiles de baja confianza (${lowConfNodes.map((n) => `${n.label} [${n.confidence.total}%]`).join(', ')}) como probables homónimos por divergencia geográfica o biográfica.` : 'No se detectaron colisiones de homónimos significativas.'}`,
    `3. Inteligencia Geográfica y Cronológica: Se registraron ${osintCase.locations.length} marcadores geográficos (${locationsList || 'sin coordenadas'}) y ${osintCase.timeline.length} hitos cronológicos verificables en la línea de tiempo.`,
    `4. Gestión de Límites de Tasa (HTTP 429): Existen ${osintCase.manualTasks.filter((t) => t.status === 'pending').length} verificaciones pendientes en la cola de Tareas Manuales para revisión directa del analista.`,
  ].join('\n\n');

  return { summary, mode: 'local_heuristic' };
}
