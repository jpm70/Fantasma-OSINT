import { ApiCredentials, InvestigationCase } from '../types/osint';
import { generateAliasFamilies } from './aliasAndConfidenceEngine';

const DB_NAME = 'FantasmaOSINT_DB';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const LOCAL_STORAGE_CASES_BACKUP = 'fantasma_osint_cases_backup_v1';
const LOCAL_STORAGE_CREDS_KEY = 'fantasma_osint_vault_v1';
const CIPHER_SALT = 'UN_FANTASMA_EN_EL_SISTEMA_OSINT_2026';

export const DEFAULT_CREDENTIALS: ApiCredentials = {
  corsProxy: 'https://corsproxy.io/?',
  useCorsProxyForSherlock: true,
  shodanKey: '',
  virusTotalKey: '',
  urlScanKey: '',
  hibpKey: '',
  hunterKey: '',
  abuseIpDbKey: '',
  serperKey: '',
  openAiKey: '',
  openAiModel: 'gpt-4o-mini',
};

/**
 * Symmetric XOR + UTF-8 Base64 encoding for localStorage credential protection.
 */
function encryptPayload(plainText: string): string {
  try {
    const encoded = encodeURIComponent(plainText);
    let result = '';
    for (let i = 0; i < encoded.length; i++) {
      const charCode = encoded.charCodeAt(i) ^ CIPHER_SALT.charCodeAt(i % CIPHER_SALT.length);
      result += String.fromCharCode(charCode);
    }
    return btoa(result);
  } catch {
    return btoa(encodeURIComponent(plainText));
  }
}

function decryptPayload(cipherText: string): string {
  try {
    const raw = atob(cipherText);
    let decoded = '';
    for (let i = 0; i < raw.length; i++) {
      const charCode = raw.charCodeAt(i) ^ CIPHER_SALT.charCodeAt(i % CIPHER_SALT.length);
      decoded += String.fromCharCode(charCode);
    }
    return decodeURIComponent(decoded);
  } catch {
    return '';
  }
}

export function saveCredentialsToVault(creds: ApiCredentials): void {
  try {
    const json = JSON.stringify(creds);
    const encrypted = encryptPayload(json);
    localStorage.setItem(LOCAL_STORAGE_CREDS_KEY, encrypted);
  } catch (err) {
    console.error('Error guardando credenciales en bóveda local:', err);
  }
}

export function loadCredentialsFromVault(): ApiCredentials {
  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_CREDS_KEY);
    if (!stored) return { ...DEFAULT_CREDENTIALS };
    const decrypted = decryptPayload(stored);
    if (!decrypted) return { ...DEFAULT_CREDENTIALS };
    return { ...DEFAULT_CREDENTIALS, ...JSON.parse(decrypted) };
  } catch {
    return { ...DEFAULT_CREDENTIALS };
  }
}

/**
 * Opens IndexedDB connection for persistent OSINT cases.
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CASES)) {
        db.createObjectStore(STORE_CASES, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveCaseToStorage(osintCase: InvestigationCase): Promise<void> {
  const updatedCase = { ...osintCase, updatedAt: new Date().toISOString() };
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readwrite');
      const store = tx.objectStore(STORE_CASES);
      store.put(updatedCase);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Fallback to localStorage if IndexedDB is restricted in private browsing
  }

  try {
    const existingRaw = localStorage.getItem(LOCAL_STORAGE_CASES_BACKUP);
    const list: InvestigationCase[] = existingRaw ? JSON.parse(existingRaw) : [];
    const idx = list.findIndex((c) => c.id === updatedCase.id);
    if (idx >= 0) {
      list[idx] = updatedCase;
    } else {
      list.unshift(updatedCase);
    }
    localStorage.setItem(LOCAL_STORAGE_CASES_BACKUP, JSON.stringify(list));
  } catch (e) {
    console.warn('Backup en localStorage omitido por cuota:', e);
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
    // Ignore
  }

  try {
    const existingRaw = localStorage.getItem(LOCAL_STORAGE_CASES_BACKUP);
    if (existingRaw) {
      const list: InvestigationCase[] = JSON.parse(existingRaw);
      const filtered = list.filter((c) => c.id !== caseId);
      localStorage.setItem(LOCAL_STORAGE_CASES_BACKUP, JSON.stringify(filtered));
    }
  } catch {
    // Ignore
  }
}

export async function loadAllCasesFromStorage(): Promise<InvestigationCase[]> {
  try {
    const db = await openDatabase();
    const cases = await new Promise<InvestigationCase[]>((resolve, reject) => {
      const tx = db.transaction(STORE_CASES, 'readonly');
      const store = tx.objectStore(STORE_CASES);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (cases.length > 0) {
      return cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
  } catch {
    // Fallback to localStorage
  }

  try {
    const existingRaw = localStorage.getItem(LOCAL_STORAGE_CASES_BACKUP);
    if (existingRaw) {
      const parsed: InvestigationCase[] = JSON.parse(existingRaw);
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Ignore
  }

  const demoCase = createInitialDemoCase();
  await saveCaseToStorage(demoCase);
  return [demoCase];
}

/**
 * Creates a rich, realistic initial OSINT case demonstrating all modules:
 * Live Graph nodes, Alias Families, Confidence Scoring (0-100), Leaflet Geo markers,
 * Chronological Timeline, and HTTP 429 Manual Verification Queue.
 */
export function createInitialDemoCase(): InvestigationCase {
  const seed = 'unfantasma';
  const aliasVariants = generateAliasFamilies(seed, {
    expectedName: 'Fantasma Sistema',
    expectedLocation: 'Madrid, España',
    expectedDomain: 'unfantasmaenelsistema.com',
    expectedYear: '26',
  }).map((v, i) => ({
    ...v,
    tested: i < 5,
    hitsCount: i === 0 ? 4 : i === 1 ? 2 : i === 2 ? 1 : 0,
  }));

  return {
    id: 'case-fantasma-demo-01',
    name: 'Operación Fantasma: Huella Digital y Superficie Externa',
    description:
      'Caso base demostrativo con correlación de alias, certificados crt.sh, puertos pasivos InternetDB, brechas de correo y geolocalización.',
    createdAt: '2026-10-15T09:30:00.000Z',
    updatedAt: new Date().toISOString(),
    seedQuery: 'unfantasma',
    seedType: 'username',
    contextHints: {
      expectedName: 'Un Fantasma en el Sistema',
      expectedLocation: 'Madrid, España',
      expectedDomain: 'unfantasmaenelsistema.com',
      expectedYear: '2026',
    },
    nodes: [
      {
        id: 'node-seed',
        label: 'unfantasma',
        subtitle: 'Objetivo Principal (Seed)',
        type: 'seed',
        platform: 'Input OSINT',
        category: 'Identidad Base',
        aliasFamily: 'Raíz Exacta',
        confidence: {
          total: 100,
          handleMatch: 30,
          aliasSimilarity: 20,
          bioNameMatch: 20,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: ['Semilla inicial de la investigación definida por el analista [100]'],
        },
        verifiedStatus: 'verified',
        metadata: {
          tipo: 'Username / Handle',
          raizMorfologica: 'fantasma',
          fechaInicio: '2026-11-04',
        },
      },
      {
        id: 'node-domain-main',
        label: 'unfantasmaenelsistema.com',
        subtitle: 'Dominio Principal Vinculado',
        type: 'domain',
        platform: 'RDAP / DNS',
        category: 'Infraestructura Web',
        aliasFamily: 'Raíz Exacta',
        url: 'https://www.unfantasmaenelsistema.com/',
        timestamp: '2021-03-14',
        confidence: {
          total: 96,
          handleMatch: 30,
          aliasSimilarity: 20,
          bioNameMatch: 18,
          geoMatch: 13,
          avatarDomainMatch: 15,
          reasons: [
            'Dominio oficial enlazado en biografías de perfiles técnicos [+30]',
            'Certificado TLS activo verificado en crt.sh [+20]',
            'Coincidencia exacta con pista de dominio esperado [+15]',
          ],
        },
        verifiedStatus: 'verified',
        metadata: {
          registrar: 'Cloudflare / ICANN RDAP',
          estado: 'clientTransferProhibited',
          dnssec: 'Firmado ( Seguro )',
          webUrl: 'https://www.unfantasmaenelsistema.com/',
        },
      },
      {
        id: 'node-gh-profile',
        label: 'github.com/unfantasma',
        subtitle: 'Perfil de Desarrollo & Seguridad',
        type: 'social_profile',
        platform: 'GitHub',
        category: 'Desarrollo',
        aliasFamily: 'Raíz Exacta',
        url: 'https://github.com/unfantasma',
        timestamp: '2020-08-22',
        coordinates: {
          lat: 40.4168,
          lng: -3.7038,
          label: 'Madrid, España (Perfil GitHub)',
        },
        confidence: {
          total: 94,
          handleMatch: 30,
          aliasSimilarity: 20,
          bioNameMatch: 19,
          geoMatch: 15,
          avatarDomainMatch: 10,
          reasons: [
            'Coincidencia exacta de identificador principal ("unfantasma") [+30]',
            'Ubicación declarada coincide con Madrid, España [+15]',
            'Enlace al blog unfantasmaenelsistema.com en perfil [+15]',
          ],
        },
        verifiedStatus: 'verified',
        metadata: {
          repositoriosPublicos: 28,
          seguidores: 412,
          ubicacion: 'Madrid, España',
          biografia: 'Investigación en Ciberseguridad, OSINT & Hacking Ético.',
        },
      },
      {
        id: 'node-alias-leet',
        label: 'unf4nt4sm4_sec',
        subtitle: 'Variante Familia Leet + Sufijo',
        type: 'alias_variant',
        platform: 'Keybase / Mastodon',
        category: 'Ciberseguridad',
        aliasFamily: 'Leet Speak (1337)',
        url: 'https://keybase.io/unf4nt4sm4',
        timestamp: '2022-05-19',
        confidence: {
          total: 84,
          handleMatch: 22,
          aliasSimilarity: 18,
          bioNameMatch: 18,
          geoMatch: 13,
          avatarDomainMatch: 13,
          reasons: [
            'Variante Leet Speak derivada de la raíz "unfantasma" [+22]',
            'Huella PGP / Avatar hash coincidente entre plataformas [+13]',
            'Mención a investigaciones OSINT en biografía [+18]',
          ],
        },
        verifiedStatus: 'verified',
        metadata: {
          patronAlias: 'Sustitución vocálica a->4 + sufijo _sec',
          similitudRaiz: '82%',
          llavePGP: '0x9F4B...E82A',
        },
      },
      {
        id: 'node-homonym-low',
        label: 'reddit.com/u/fantasma99_gamer',
        subtitle: 'Posible Homónimo (Baja Confianza)',
        type: 'social_profile',
        platform: 'Reddit',
        category: 'Foros y Comunidad',
        aliasFamily: 'Sufijo Numérico',
        url: 'https://www.reddit.com/user/fantasma99_gamer',
        timestamp: '2023-11-02',
        coordinates: {
          lat: -34.6037,
          lng: -58.3816,
          label: 'Buenos Aires, Argentina (Zona Horaria UTC-3)',
        },
        confidence: {
          total: 32,
          handleMatch: 12,
          aliasSimilarity: 10,
          bioNameMatch: 4,
          geoMatch: 2,
          avatarDomainMatch: 4,
          reasons: [
            'Coincidencia parcial solo en palabra común "fantasma" [+12]',
            'Discrepancia geográfica (Buenos Aires vs Madrid) [+2]',
            'Sin correlación de avatar ni enlaces a unfantasmaenelsistema.com [+4]',
          ],
        },
        verifiedStatus: 'false_positive',
        metadata: {
          evaluacion: 'Homónimo descartado por el algoritmo de Scoring',
          actividadPrincipal: 'Gaming / Deportes',
          ubicacionDetectada: 'Buenos Aires, AR',
        },
      },
      {
        id: 'node-sub-crt',
        label: 'osint.unfantasmaenelsistema.com',
        subtitle: 'Subdominio Histórico (crt.sh)',
        type: 'subdomain',
        platform: 'crt.sh CT Logs',
        category: 'Infraestructura Web',
        aliasFamily: 'Raíz Exacta',
        timestamp: '2025-02-10',
        confidence: {
          total: 91,
          handleMatch: 28,
          aliasSimilarity: 18,
          bioNameMatch: 15,
          geoMatch: 15,
          avatarDomainMatch: 15,
          reasons: [
            'Extraído de registros públicos de Certificate Transparency (crt.sh) [+28]',
            'Subdominio perteneciente al dominio raíz confirmado [+15]',
          ],
        },
        verifiedStatus: 'verified',
        metadata: {
          emisorCertificado: "Let's Encrypt Authority X3",
          validezDesde: '2025-02-10',
          registroCT: 'crt.sh ID #1194820412',
        },
      },
      {
        id: 'node-ip-edge',
        label: '104.21.48.192',
        subtitle: 'Nodo Edge / Reverse Proxy IP',
        type: 'ip',
        platform: 'Shodan InternetDB',
        category: 'Infraestructura de Red',
        aliasFamily: 'Infraestructura',
        timestamp: '2026-01-18',
        coordinates: {
          lat: 50.1109,
          lng: 8.6821,
          label: 'Frankfurt, Alemania (Nodo Anycast EU)',
        },
        confidence: {
          total: 88,
          handleMatch: 25,
          aliasSimilarity: 16,
          bioNameMatch: 15,
          geoMatch: 15,
          avatarDomainMatch: 17,
          reasons: [
            'Resolución DNS A/AAAA vinculada al dominio objetivo [+25]',
            'Puertos pasivos inspeccionados vía Shodan InternetDB [+17]',
          ],
        },
        verifiedStatus: 'verified',
        metadata: {
          asn: 'AS13335 Cloudflare, Inc.',
          puertosAbiertos: '80, 443, 8080, 8443',
          cpes: 'cpe:/a:cloudflare:cloudflare',
          ubicacionRed: 'Frankfurt am Main, DE',
        },
      },
      {
        id: 'node-ports-shodan',
        label: 'Puertos: 80, 443, 8443 (TLS 1.3)',
        subtitle: 'Superficie Shodan InternetDB',
        type: 'port_vuln',
        platform: 'Shodan InternetDB',
        category: 'Infraestructura de Red',
        aliasFamily: 'Infraestructura',
        confidence: {
          total: 86,
          handleMatch: 24,
          aliasSimilarity: 15,
          bioNameMatch: 15,
          geoMatch: 15,
          avatarDomainMatch: 17,
          reasons: ['Enumeración pasiva sin llaves desde internetdb.shodan.io [+24]'],
        },
        verifiedStatus: 'verified',
        metadata: {
          puertos: '80/tcp, 443/tcp, 8443/tcp',
          vulnerabilidadesCVE: 'Ninguna CVE crítica expuesta (WAF Activo)',
          tags: 'cdn, cloud, waf-protected',
        },
      },
      {
        id: 'node-email-contact',
        label: 'contacto@unfantasmaenelsistema.com',
        subtitle: 'Correo de Contacto / Seguridad',
        type: 'email',
        platform: 'XposedOrNot / DoH MX',
        category: 'Identidad Base',
        aliasFamily: 'Raíz Exacta',
        timestamp: '2021-04-01',
        confidence: {
          total: 92,
          handleMatch: 28,
          aliasSimilarity: 19,
          bioNameMatch: 16,
          geoMatch: 14,
          avatarDomainMatch: 15,
          reasons: [
            'Registros MX y política DMARC estricta verificados en el dominio [+28]',
            'Verificado en XposedOrNot API sin credenciales expuestas en texto plano [+15]',
          ],
        },
        verifiedStatus: 'verified',
        metadata: {
          estadoXposedOrNot: '0 brechas críticas de contraseñas',
          dmarc: 'v=DMARC1; p=reject;',
          spf: 'v=spf1 include:_spf.google.com ~all',
        },
      },
    ],
    edges: [
      { id: 'e-1', source: 'node-seed', target: 'node-domain-main', relation: 'opera_dominio', weight: 3 },
      { id: 'e-2', source: 'node-seed', target: 'node-gh-profile', relation: 'perfil_confirmado (94%)', weight: 3 },
      { id: 'e-3', source: 'node-seed', target: 'node-alias-leet', relation: 'familia_alias_1337', weight: 2 },
      { id: 'e-4', source: 'node-seed', target: 'node-homonym-low', relation: 'posible_homonimo (32%)', weight: 1 },
      { id: 'e-5', source: 'node-domain-main', target: 'node-sub-crt', relation: 'certificado_ct_crtsh', weight: 2 },
      { id: 'e-6', source: 'node-domain-main', target: 'node-ip-edge', relation: 'resuelve_dns_a', weight: 2 },
      { id: 'e-7', source: 'node-ip-edge', target: 'node-ports-shodan', relation: 'expone_puertos', weight: 2 },
      { id: 'e-8', source: 'node-domain-main', target: 'node-email-contact', relation: 'registro_soa_mx', weight: 2 },
    ],
    timeline: [
      {
        id: 'tl-1',
        date: '2020-08-22',
        title: 'Creación de cuenta en GitHub (unfantasma)',
        description: 'Registro inicial del perfil de investigación y publicación de primeros repositorios OSINT.',
        category: 'account',
        sourcePlatform: 'GitHub API',
        sourceUrl: 'https://github.com/unfantasma',
        nodeId: 'node-gh-profile',
        confidence: 94,
      },
      {
        id: 'tl-2',
        date: '2021-03-14',
        title: 'Registro del dominio unfantasmaenelsistema.com',
        description: 'Alta en servidor RDAP oficial con protección de privacidad WHOIS y DNSSEC habilitado.',
        category: 'domain_whois',
        sourcePlatform: 'RDAP / ICANN',
        sourceUrl: 'https://www.unfantasmaenelsistema.com/',
        nodeId: 'node-domain-main',
        confidence: 96,
      },
      {
        id: 'tl-3',
        date: '2022-05-19',
        title: 'Aparición de variante Leet Speak (unf4nt4sm4_sec)',
        description: 'Detección de alias secundario con misma huella de clave pública y temática de seguridad.',
        category: 'account',
        sourcePlatform: 'Keybase',
        nodeId: 'node-alias-leet',
        confidence: 84,
      },
      {
        id: 'tl-4',
        date: '2023-11-02',
        title: 'Creación de cuenta homónima descartada (fantasma99_gamer)',
        description: 'El motor de puntuación de confianza asignó 32/100 por discrepancia de ubicación y biografía.',
        category: 'investigation',
        sourcePlatform: 'Reddit',
        nodeId: 'node-homonym-low',
        confidence: 32,
      },
      {
        id: 'tl-5',
        date: '2025-02-10',
        title: 'Emisión de certificado TLS en crt.sh (osint.unfantasmaenelsistema.com)',
        description: 'Certificado registrado en logs de Transparencia de Certificados públicos.',
        category: 'certificate',
        sourcePlatform: 'crt.sh',
        nodeId: 'node-sub-crt',
        confidence: 91,
      },
      {
        id: 'tl-6',
        date: '2026-01-18',
        title: 'Inspección pasiva de nodo IP 104.21.48.192 en Shodan InternetDB',
        description: 'Confirmados puertos web 80/443/8443 bajo protección reverse-proxy en Frankfurt.',
        category: 'network',
        sourcePlatform: 'Shodan InternetDB',
        nodeId: 'node-ip-edge',
        confidence: 88,
      },
    ],
    locations: [
      {
        id: 'geo-1',
        lat: 40.4168,
        lng: -3.7038,
        title: 'Madrid, España',
        subtitle: 'Ubicación principal correlacionada en perfil técnico y huso horario CET (UTC+1)',
        category: 'profile_location',
        confidence: 94,
        nodeId: 'node-gh-profile',
        source: 'Metadatos de Perfil / Zona Horaria',
        countryCode: 'ES',
      },
      {
        id: 'geo-2',
        lat: 50.1109,
        lng: 8.6821,
        title: 'Frankfurt am Main, Alemania',
        subtitle: 'Nodo IP Edge 104.21.48.192 (AS13335 Cloudflare Gateway Europeo)',
        category: 'ip_host',
        confidence: 88,
        nodeId: 'node-ip-edge',
        source: 'Shodan InternetDB / GeoIP',
        countryCode: 'DE',
      },
      {
        id: 'geo-3',
        lat: 37.7749,
        lng: -122.4194,
        title: 'San Francisco, CA, EE.UU.',
        subtitle: 'Sede del Registrador / Autoridad RDAP del Dominio Principal',
        category: 'registrar_hq',
        confidence: 85,
        nodeId: 'node-domain-main',
        source: 'Registro RDAP / WHOIS',
        countryCode: 'US',
      },
      {
        id: 'geo-4',
        lat: -34.6037,
        lng: -58.3816,
        title: 'Buenos Aires, Argentina (Homónimo Descartado)',
        subtitle: 'Ubicación asociada al perfil u/fantasma99_gamer (Confianza 32/100)',
        category: 'profile_location',
        confidence: 32,
        nodeId: 'node-homonym-low',
        source: 'Análisis de Homónimos',
        countryCode: 'AR',
      },
    ],
    manualTasks: [
      {
        id: 'mt-1',
        platform: 'X (Twitter)',
        url: 'https://x.com/unfantasma',
        target: 'unfantasma',
        reason: 'HTTP_429',
        httpStatus: 429,
        retriesAttempted: 3,
        timestamp: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
        status: 'pending',
        notes: 'Bloqueo de límite de tasa tras 3 reintentos con backoff exponencial. Requiere apertura manual.',
      },
      {
        id: 'mt-2',
        platform: 'Instagram',
        url: 'https://www.instagram.com/unfantasma/',
        target: 'unfantasma',
        reason: 'WAF_CHALLENGE',
        httpStatus: 403,
        retriesAttempted: 3,
        timestamp: new Date(Date.now() - 1000 * 60 * 11).toISOString(),
        status: 'pending',
        notes: 'Login wall / desafío anti-bot de Meta detectado en proxy CORS.',
      },
      {
        id: 'mt-3',
        platform: 'Google Dork (Documentos Públicos)',
        url: 'https://www.google.com/search?q=site%3Aunfantasmaenelsistema.com+filetype%3Apdf+OR+filetype%3Adocx',
        target: 'unfantasmaenelsistema.com',
        reason: 'MANUAL_DORK',
        retriesAttempted: 0,
        timestamp: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
        status: 'verified_hit',
        notes: 'Búsqueda avanzada de documentos indexados en el dominio objetivo.',
      },
    ],
    aliasVariants,
    aiSummary:
      'RESUMEN EJECUTIVO DE INTELIGENCIA (CASO DEMO): El objetivo "unfantasma" presenta una huella digital altamente cohesionada en el ámbito de la ciberseguridad y divulgación técnica, articulada en torno al dominio oficial unfantasmaenelsistema.com (Confianza 96/100) y su perfil de desarrollo en GitHub (94/100), ambos correlacionados geográficamente con Madrid, España. El motor de Familias de Alias identificó la variante leet-speak "unf4nt4sm4_sec" (84/100) con coincidencia de llave pública, mientras que el sistema de Puntuación de Confianza aisló con éxito el perfil homónimo "fantasma99_gamer" (32/100) ubicado en Argentina. A nivel de infraestructura, la superficie expuesta en Shodan InternetDB (104.21.48.192) está protegida tras proxy inverso con políticas DMARC/SPF estrictas y sin vulnerabilidades CVE críticas.',
    logs: [
      {
        id: 'log-1',
        timestamp: '09:30:05',
        module: 'Core Engine',
        message: 'Caso inicializado en IndexedDB local (Modo 100% Client-Side Serverless).',
        level: 'info',
      },
      {
        id: 'log-2',
        timestamp: '09:30:08',
        module: 'Alias Engine',
        message: 'Generadas 15 variantes morfológicas (Leet speak, caracteres duplicados, sufijos).',
        level: 'success',
      },
      {
        id: 'log-3',
        timestamp: '09:30:14',
        module: 'crt.sh & RDAP',
        message: 'Extraídos certificados históricos y estado DNSSEC para unfantasmaenelsistema.com.',
        level: 'success',
      },
      {
        id: 'log-4',
        timestamp: '09:30:19',
        module: 'Smart Retries',
        message: 'HTTP 429 detectado en X.com tras 3 reintentos con pausa exponencial -> derivado a Tareas Manuales.',
        level: 'warning',
      },
    ],
  };
}
