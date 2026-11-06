import { ApiCredentials, GraphNode, InvestigationCase, ProfileEvidence } from '../types/osint';
import { generateAliasFamilies, rescoreProfiles, scoreEvidence, sourceConfidence } from './aliasAndConfidenceEngine';
import { decryptVault, encryptVault, isVaultBlob, legacyXorDecode } from '../engine/vault';
import { safeHttpUrl } from '../engine/integrity';

const DB_NAME = 'FantasmaOSINT_DB';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const LS_CASES_FALLBACK = 'fantasma_osint_cases_backup_v1';
const LS_SETTINGS = 'fantasma_osint_settings_v2';
const LS_VAULT = 'fantasma_osint_vault_v2';
const LS_LEGACY_VAULT = 'fantasma_osint_vault_v1';
const LEGACY_DEMO_ID = 'case-fantasma-demo-01';
export const DEMO_CASE_ID = 'case-demo-ficticio-v2';

export const SECRET_FIELDS = ['openAiKey', 'hibpKey', 'hunterKey', 'virusTotalKey', 'urlScanKey', 'serperKey'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export const DEFAULT_CREDENTIALS: ApiCredentials = {
  corsProxy: '',
  useCorsProxyForSherlock: true,
  allowKeysThroughProxy: false,
  virusTotalKey: '',
  urlScanKey: '',
  hibpKey: '',
  hunterKey: '',
  serperKey: '',
  openAiKey: '',
  openAiModel: 'gpt-4o-mini',
};

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // almacenamiento no disponible
  }
};
const lsDel = (k: string) => {
  try {
    localStorage.removeItem(k);
  } catch {
    // almacenamiento no disponible
  }
};

// ---------------------------------------------------------------------------
// Ajustes (no secretos) y bóveda de claves
// ---------------------------------------------------------------------------

/** Ajustes sin secretos: proxy, opciones y modelo. Las claves nunca se guardan aquí. */
export function loadSettings(): ApiCredentials {
  try {
    const raw = lsGet(LS_SETTINGS);
    const s = raw ? JSON.parse(raw) : {};
    return {
      ...DEFAULT_CREDENTIALS,
      corsProxy: typeof s.corsProxy === 'string' ? s.corsProxy : '',
      useCorsProxyForSherlock: s.useCorsProxyForSherlock !== false,
      allowKeysThroughProxy: s.allowKeysThroughProxy === true,
      openAiModel: typeof s.openAiModel === 'string' ? s.openAiModel : DEFAULT_CREDENTIALS.openAiModel,
    };
  } catch {
    return { ...DEFAULT_CREDENTIALS };
  }
}

export function saveSettings(c: ApiCredentials): void {
  lsSet(LS_SETTINGS, JSON.stringify({ corsProxy: c.corsProxy, useCorsProxyForSherlock: c.useCorsProxyForSherlock, allowKeysThroughProxy: c.allowKeysThroughProxy, openAiModel: c.openAiModel }));
}

export function pickSecrets(c: ApiCredentials): Record<SecretField, string> {
  return Object.fromEntries(SECRET_FIELDS.map((k) => [k, c[k] || ''])) as Record<SecretField, string>;
}

export function hasStoredVault(): boolean {
  return !!lsGet(LS_VAULT);
}

export async function saveSecretsToVault(c: ApiCredentials, passphrase: string): Promise<void> {
  const blob = await encryptVault(JSON.stringify(pickSecrets(c)), passphrase);
  lsSet(LS_VAULT, JSON.stringify(blob));
}

/** Descifra la bóveda. Lanza un error si la frase es incorrecta. */
export async function unlockVault(passphrase: string): Promise<Record<SecretField, string>> {
  const raw = lsGet(LS_VAULT);
  if (!raw) throw new Error('No hay bóveda guardada');
  const blob = JSON.parse(raw);
  if (!isVaultBlob(blob)) throw new Error('Bóveda con formato desconocido');
  const secrets = JSON.parse(await decryptVault(blob, passphrase));
  return Object.fromEntries(SECRET_FIELDS.map((k) => [k, typeof secrets[k] === 'string' ? secrets[k] : ''])) as Record<SecretField, string>;
}

export function forgetVault(): void {
  lsDel(LS_VAULT);
}

/**
 * La v1 guardaba las claves «cifradas» con XOR y una cadena escrita en el propio código.
 * Se leen, se borran del navegador y se devuelven para usarlas en la sesión.
 */
export function migrateLegacyVault(): Partial<ApiCredentials> | null {
  const raw = lsGet(LS_LEGACY_VAULT);
  if (!raw) return null;
  lsDel(LS_LEGACY_VAULT);
  const decoded = legacyXorDecode(raw);
  if (!decoded) return null;
  try {
    const old = JSON.parse(decoded);
    const out: Partial<ApiCredentials> = {};
    for (const k of SECRET_FIELDS) if (typeof old[k] === 'string' && old[k]) out[k] = old[k];
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

const nd = (v: unknown) => (typeof v === 'string' && v && v !== 'N/D' && !/^sin biograf|^no especificada/i.test(v) ? v : undefined);

/** Completa y actualiza un caso guardado por una versión anterior o importado desde JSON. */
export function normalizeCase(raw: any): InvestigationCase | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !Array.isArray(raw.nodes)) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const nodes: GraphNode[] = arr(raw.nodes)
    .filter((n: any) => n && typeof n.id === 'string' && typeof n.label === 'string')
    .map((n: any) => {
      const node: GraphNode = {
        ...n,
        platform: String(n.platform ?? 'Desconocida'),
        category: String(n.category ?? ''),
        aliasFamily: String(n.aliasFamily ?? ''),
        metadata: n.metadata && typeof n.metadata === 'object' ? n.metadata : {},
        url: safeHttpUrl(n.url),
        verifiedStatus: ['verified', 'unverified', 'false_positive'].includes(n.verifiedStatus) ? n.verifiedStatus : 'unverified',
        confidence: n.confidence && typeof n.confidence.total === 'number' ? n.confidence : sourceConfidence(50, 'Sin puntuación'),
      };
      if (node.type === 'social_profile' && !node.evidence) {
        const m = node.metadata as Record<string, unknown>;
        const handle = nd(m.usuario) ?? node.label.split(':').pop()!.trim();
        const ev: ProfileEvidence = { handle, displayName: nd(m.nombreVisible), bio: nd(m.biografia), location: nd(m.ubicacion), website: nd(m.web), statusOnly: m.codigoHttp === 200 || undefined };
        node.evidence = ev;
        node.pivot = { query: handle, type: 'username' };
        if (node.verifiedStatus === 'verified' && !node.analystReviewed) node.verifiedStatus = 'unverified';
      } else if (!node.evidence && node.confidence.basis !== 'identity') {
        node.confidence = { ...node.confidence, basis: 'source' };
      }
      return node;
    });
  const c: InvestigationCase = {
    id: raw.id,
    name: String(raw.name ?? 'Caso importado'),
    description: String(raw.description ?? ''),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
    seedQuery: String(raw.seedQuery ?? nodes[0]?.label ?? 'objetivo'),
    seedType: raw.seedType ?? 'username',
    contextHints: raw.contextHints && typeof raw.contextHints === 'object' ? raw.contextHints : {},
    nodes,
    edges: arr(raw.edges).filter((e: any) => e && typeof e.source === 'string' && typeof e.target === 'string'),
    timeline: arr(raw.timeline),
    locations: arr(raw.locations).filter((l: any) => l && Number.isFinite(l.lat) && Number.isFinite(l.lng)),
    manualTasks: arr(raw.manualTasks).map((t: any) => ({ ...t, url: safeHttpUrl(t.url) ?? '' })).filter((t: any) => t.url),
    aliasVariants: arr(raw.aliasVariants),
    aiSummary: typeof raw.aiSummary === 'string' ? raw.aiSummary : undefined,
    logs: arr(raw.logs),
    siteChecks: Array.isArray(raw.siteChecks) ? raw.siteChecks : undefined,
    siteChecksFor: typeof raw.siteChecksFor === 'string' ? raw.siteChecksFor : undefined,
    isDemo: raw.isDemo === true,
  };
  c.nodes = rescoreProfiles(c.nodes, c.seedQuery, c.contextHints);
  return c;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CASES)) db.createObjectStore(STORE_CASES, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function fallbackList(): InvestigationCase[] {
  try {
    const raw = lsGet(LS_CASES_FALLBACK);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Se guarda en IndexedDB; solo si no está disponible (p. ej. modo privado) se usa localStorage. */
export async function saveCaseToStorage(osintCase: InvestigationCase, touch = true): Promise<void> {
  const updated = touch ? { ...osintCase, updatedAt: new Date().toISOString() } : osintCase;
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readwrite');
      tx.objectStore(STORE_CASES).put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return;
  } catch {
    const list = fallbackList().filter((c) => c.id !== updated.id);
    lsSet(LS_CASES_FALLBACK, JSON.stringify([updated, ...list]));
  }
}

export async function deleteCaseFromStorage(caseId: string): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readwrite');
      tx.objectStore(STORE_CASES).delete(caseId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // sin IndexedDB
  }
  lsSet(LS_CASES_FALLBACK, JSON.stringify(fallbackList().filter((c) => c.id !== caseId)));
}

export async function loadAllCasesFromStorage(): Promise<InvestigationCase[]> {
  let raw: any[] = [];
  try {
    const db = await openDatabase();
    raw = await new Promise<any[]>((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readonly');
      const req = tx.objectStore(STORE_CASES).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // sin IndexedDB
  }
  // Casos de la v1, que se duplicaban en localStorage: se pasan a IndexedDB y se borra la copia
  const legacy = fallbackList();
  for (const c of legacy) if (!raw.some((r) => r.id === c.id)) raw.push(c);

  // El caso de demostración de la v1 se sustituye por el nuevo
  const legacyDemo = raw.some((r) => r.id === LEGACY_DEMO_ID);
  raw = raw.filter((r) => r.id !== LEGACY_DEMO_ID);
  const cases = raw.map(normalizeCase).filter((c): c is InvestigationCase => !!c);

  if (!cases.some((c) => c.id === DEMO_CASE_ID) && (cases.length === 0 || legacyDemo)) cases.push(createInitialDemoCase());
  for (const c of cases) await saveCaseToStorage(c, false);
  if (legacyDemo) await deleteCaseFromStorage(LEGACY_DEMO_ID);
  if (legacy.length) {
    try {
      await openDatabase();
      lsDel(LS_CASES_FALLBACK);
    } catch {
      // sin IndexedDB: la copia en localStorage sigue siendo el almacenamiento
    }
  }
  return cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ---------------------------------------------------------------------------
// Caso de ejemplo (datos inventados)
// ---------------------------------------------------------------------------

/**
 * Caso de ejemplo con datos inventados: el dominio example.org (reservado por la IANA),
 * IP de documentación 203.0.113.0/24 y perfiles ficticios. Las puntuaciones las calcula el
 * mismo motor que en una búsqueda real, para ver cómo las pistas separan a la persona
 * buscada de un homónimo.
 */
export function createInitialDemoCase(): InvestigationCase {
  const seed = 'laura_ejemplo';
  const hints = { expectedName: 'Laura Ejemplo', expectedLocation: 'Valencia', expectedDomain: 'example.org', expectedYear: '' };
  const now = new Date().toISOString();
  const seedId = 'seed-laura_ejemplo';
  const profile = (id: string, platform: string, category: string, ev: ProfileEvidence, created?: string, coords?: { lat: number; lng: number; label: string }): GraphNode => ({
    id,
    label: `${platform}: ${ev.handle}`,
    subtitle: ev.displayName ? `${ev.displayName} · ${category}` : category,
    type: 'social_profile',
    platform,
    category,
    aliasFamily: ev.handle === seed ? 'Raíz exacta' : 'Variante',
    confidence: scoreEvidence(seed, ev, hints),
    evidence: ev,
    pivot: { query: ev.handle, type: 'username' },
    verifiedStatus: 'unverified',
    timestamp: created,
    coordinates: coords,
    metadata: { ficticio: 'Sí', usuario: ev.handle, nombreVisible: ev.displayName || 'N/D', ubicacion: ev.location || 'N/D', web: ev.website || 'N/D', creacion: created || 'N/D' },
  });

  const nodes: GraphNode[] = [
    { id: seedId, label: seed, subtitle: 'Semilla (username)', type: 'seed', platform: 'Entrada del analista', category: 'Semilla', aliasFamily: 'Raíz exacta', confidence: sourceConfidence(100, 'Punto de partida definido por el analista'), verifiedStatus: 'verified', pivot: { query: seed, type: 'username' }, metadata: { tipo: 'username', ficticio: 'Sí' } },
    profile('demo-github', 'GitHub', 'Desarrollo', { handle: seed, displayName: 'Laura Ejemplo', bio: 'Administración de sistemas y redes.', location: 'Valencia, España', website: 'https://example.org' }, '2019-03-14', { lat: 39.4699, lng: -0.3763, label: 'Valencia, España (GitHub)' }),
    profile('demo-keybase', 'Keybase', 'Ciberseguridad', { handle: seed, displayName: 'Laura Ejemplo' }, undefined),
    profile('demo-mastodon', 'Mastodon (mastodon.social)', 'Redes Sociales', { handle: seed, displayName: 'L. E.', website: 'https://example.org/blog' }, '2022-11-02'),
    profile('demo-lichess', 'Lichess', 'Gaming', { handle: seed, displayName: 'Lauri', bio: 'Ajedrez cada noche', location: 'Buenos Aires, Argentina' }, '2016-07-21', { lat: -34.6037, lng: -58.3816, label: 'Buenos Aires, Argentina (Lichess)' }),
    profile('demo-devto', 'Dev.to', 'Desarrollo', { handle: 'laura_ejemplo_dev', displayName: 'Laura E.' }, '2021-05-09'),
    { id: 'demo-domain', label: 'example.org', subtitle: 'Web enlazada desde GitHub', type: 'domain', platform: 'Ejemplo', category: 'Infraestructura web', aliasFamily: 'Infraestructura', url: 'https://example.org', confidence: sourceConfidence(90, 'Dominio enlazado desde el perfil (ficticio)'), pivot: { query: 'example.org', type: 'domain' }, verifiedStatus: 'verified', metadata: { ficticio: 'Sí', nota: 'example.org está reservado por la IANA para ejemplos' } },
    { id: 'demo-ip', label: '203.0.113.10', subtitle: 'IP de documentación (RFC 5737)', type: 'ip', platform: 'Ejemplo', category: 'Red', aliasFamily: 'Infraestructura', confidence: sourceConfidence(90, 'IP ficticia'), verifiedStatus: 'verified', metadata: { ficticio: 'Sí', nota: '203.0.113.0/24 está reservada para documentación' } },
  ];

  const c: InvestigationCase = {
    id: DEMO_CASE_ID,
    name: 'Caso de ejemplo (datos ficticios)',
    description: 'Datos inventados para practicar: dos perfiles coinciden con las pistas, uno las contradice (otra ciudad y otro nombre) y otros no tienen datos suficientes. Cambia las pistas en «Familias y confianza» para ver cómo cambian las puntuaciones.',
    createdAt: now,
    updatedAt: now,
    seedQuery: seed,
    seedType: 'username',
    contextHints: hints,
    nodes,
    edges: [
      ...nodes.filter((n) => n.id.startsWith('demo-') && n.type === 'social_profile').map((n) => ({ id: `edge-${seedId}-${n.id}`, source: seedId, target: n.id, relation: `perfil en ${n.platform}`, weight: 3 })),
      { id: 'edge-demo-github-domain', source: 'demo-github', target: 'demo-domain', relation: 'enlaza a', weight: 2 },
      { id: 'edge-demo-domain-ip', source: 'demo-domain', target: 'demo-ip', relation: 'resuelve a', weight: 2 },
    ],
    timeline: [
      { id: 'tl-demo-lichess', date: '2016-07-21', title: 'Alta en Lichess (@laura_ejemplo)', description: 'Perfil de Buenos Aires: contradice la ciudad esperada.', category: 'account', sourcePlatform: 'Lichess', nodeId: 'demo-lichess', confidence: 0 },
      { id: 'tl-demo-github', date: '2019-03-14', title: 'Alta en GitHub (@laura_ejemplo)', description: 'Nombre, ciudad y web coinciden con las pistas.', category: 'account', sourcePlatform: 'GitHub', nodeId: 'demo-github', confidence: 0 },
      { id: 'tl-demo-devto', date: '2021-05-09', title: 'Alta en Dev.to (@laura_ejemplo_dev)', description: 'Variante del alias con sufijo _dev.', category: 'account', sourcePlatform: 'Dev.to', nodeId: 'demo-devto', confidence: 0 },
      { id: 'tl-demo-mastodon', date: '2022-11-02', title: 'Alta en Mastodon (@laura_ejemplo)', description: 'Enlaza al mismo dominio que GitHub.', category: 'account', sourcePlatform: 'Mastodon', nodeId: 'demo-mastodon', confidence: 0 },
    ],
    locations: [
      { id: 'geo-demo-github', lat: 39.4699, lng: -0.3763, title: 'Valencia, España — GitHub', subtitle: 'Ubicación escrita en el perfil (ficticio)', category: 'profile_location', confidence: 0, nodeId: 'demo-github', source: 'GitHub', countryCode: 'ES' },
      { id: 'geo-demo-lichess', lat: -34.6037, lng: -58.3816, title: 'Buenos Aires, Argentina — Lichess', subtitle: 'Ubicación escrita en el perfil (ficticio)', category: 'profile_location', confidence: 0, nodeId: 'demo-lichess', source: 'Lichess', countryCode: 'AR' },
    ],
    manualTasks: [],
    aliasVariants: generateAliasFamilies(seed, hints),
    logs: [{ id: 'log-demo', timestamp: new Date().toTimeString().slice(0, 8), module: 'Ejemplo', message: 'Caso de ejemplo con datos ficticios cargado.', level: 'info' }],
    isDemo: true,
  };
  c.nodes = rescoreProfiles(c.nodes, seed, hints);
  const score = (id: string) => c.nodes.find((n) => n.id === id)?.confidence.total ?? 0;
  c.timeline = c.timeline.map((t) => ({ ...t, confidence: score(t.nodeId!) }));
  c.locations = c.locations.map((l) => ({ ...l, confidence: score(l.nodeId!) }));
  return c;
}
