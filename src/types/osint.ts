export type InputType =
  | 'username'
  | 'email'
  | 'phone'
  | 'real_name'
  | 'domain'
  | 'ip'
  | 'national_id';

export type EntityType =
  | 'seed'
  | 'username'
  | 'social_profile'
  | 'email'
  | 'breach'
  | 'domain'
  | 'subdomain'
  | 'dns_record'
  | 'ip'
  | 'port_vuln'
  | 'phone'
  | 'real_name'
  | 'national_id'
  | 'location'
  | 'alias_variant'
  | 'dork_query'
  | 'evidence_file';

export type ClusterGroupMode = 'none' | 'type' | 'platform' | 'alias_family';

/**
 * Puntuación 0–100. Con basis 'identity' mide si un perfil es de la misma persona que el objetivo
 * (se desglosa en los cinco factores y las penalizaciones). Con basis 'source' es la fiabilidad
 * de un dato técnico (RDAP, DNS, Shodan…): no dice nada de identidad y los factores valen 0.
 */
export interface ConfidenceBreakdown {
  total: number; // 0 a 100
  handleMatch: number; // 0 a 30
  aliasSimilarity: number; // 0 a 20
  bioNameMatch: number; // 0 a 20
  geoMatch: number; // 0 a 15
  avatarDomainMatch: number; // 0 a 15
  /** Puntos restados por datos que contradicen las pistas (otra ciudad, otro nombre). */
  penalty?: number;
  basis?: 'identity' | 'source';
  reasons: string[];
}

/** Datos públicos de un perfil con los que se calcula la puntuación de identidad. */
export interface ProfileEvidence {
  handle: string;
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  /** El perfil solo se ha detectado por el código HTTP (sin datos que comparar). */
  statusOnly?: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  subtitle?: string;
  type: EntityType;
  platform: string;
  category: string;
  aliasFamily: string;
  url?: string;
  confidence: ConfidenceBreakdown;
  timestamp?: string;
  coordinates?: {
    lat: number;
    lng: number;
    label: string;
  };
  metadata: Record<string, string | number | boolean | string[]>;
  /** Solo en perfiles: lo que se compara para puntuar la identidad. */
  evidence?: ProfileEvidence;
  /** Búsqueda que tiene sentido lanzar desde este nodo (doble clic / «Pivotar»). */
  pivot?: { query: string; type: InputType };
  verifiedStatus: 'verified' | 'unverified' | 'false_positive';
  /** El analista ha marcado el nodo como real o como homónimo: el recálculo no lo cambia. */
  analystReviewed?: boolean;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  pinned?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface TimelineEvent {
  id: string;
  date: string; // ISO or YYYY-MM-DD
  title: string;
  description: string;
  category: 'account' | 'breach' | 'certificate' | 'domain_whois' | 'network' | 'investigation';
  sourcePlatform: string;
  sourceUrl?: string;
  nodeId?: string;
  confidence: number;
}

export interface GeoMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  subtitle: string;
  category: 'ip_host' | 'profile_location' | 'registrar_hq' | 'phone_region';
  confidence: number;
  nodeId?: string;
  source: string;
  countryCode?: string;
}

export interface ManualTask {
  id: string;
  platform: string;
  url: string;
  target: string;
  reason: 'HTTP_429' | 'CORS_BLOCKED' | 'WAF_CHALLENGE' | 'MANUAL_DORK' | 'NO_DATA' | 'SIMULATION';
  httpStatus?: number;
  retriesAttempted: number;
  timestamp: string;
  status: 'pending' | 'verified_hit' | 'discarded';
  notes: string;
}

export interface AliasVariant {
  variant: string;
  root: string;
  familyType: 'exact' | 'leet_speak' | 'duplicated_chars' | 'prefix_suffix' | 'separator' | 'year_numeric';
  familyLabel: string;
  similarity: number; // 0 to 100
  tested: boolean;
  hitsCount: number;
}

export interface InvestigationLog {
  id: string;
  timestamp: string;
  module: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}

export interface RetryTaskStatus {
  id: string;
  platform: string;
  url: string;
  attempt: number;
  maxAttempts: number;
  nextRetryMs: number;
  status: 'retrying' | 'resolved' | 'moved_to_manual';
}

export interface ContextHints {
  expectedName?: string;
  expectedLocation?: string;
  expectedDomain?: string;
  expectedYear?: string;
}

/** Resultado de comprobar un usuario en un sitio del catálogo. */
export interface SiteCheck {
  site: string;
  url: string;
  result: 'found' | 'not_found' | 'unknown' | 'manual';
  httpStatus?: number;
  detail: string;
}

export interface InvestigationCase {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  seedQuery: string;
  seedType: InputType;
  contextHints: ContextHints;
  nodes: GraphNode[];
  edges: GraphEdge[];
  timeline: TimelineEvent[];
  locations: GeoMarker[];
  manualTasks: ManualTask[];
  aliasVariants: AliasVariant[];
  aiSummary?: string;
  logs: InvestigationLog[];
  /** Comprobaciones de la última búsqueda de usuario, sitio por sitio. */
  siteChecks?: SiteCheck[];
  siteChecksFor?: string;
  /** Caso de ejemplo con datos inventados. */
  isDemo?: boolean;
}

export interface ApiCredentials {
  /** Proxy CORS propio (vacío = sin proxy). Recibe la URL de destino codificada al final. */
  corsProxy: string;
  /** Sondear por el proxy los sitios del catálogo que no admiten CORS. */
  useCorsProxyForSherlock: boolean;
  /** Permitir que las claves de HIBP, VirusTotal y URLScan viajen por el proxy (las verá quien lo gestione). */
  allowKeysThroughProxy: boolean;
  virusTotalKey: string;
  urlScanKey: string;
  hibpKey: string;
  hunterKey: string;
  serperKey: string;
  openAiKey: string;
  openAiModel: string;
}

export interface SherlockSite {
  name: string;
  category:
    | 'Desarrollo'
    | 'Redes Sociales'
    | 'Foros y Comunidad'
    | 'Ciberseguridad'
    | 'Multimedia y Diseño'
    | 'Gaming'
    | 'Blogging y Contenido'
    | 'Profesional y Finanzas';
  urlTemplate: string;
  probeUrlTemplate?: string;
  /**
   * direct_json: API con CORS que se consulta desde el navegador.
   * proxy_status: responde 404 si el usuario no existe; necesita proxy propio.
   * proxy_message: responde 200 siempre, pero con errorMsg si no existe; necesita proxy propio.
   * manual: responde 200 aunque el usuario no exista o exige sesión: solo se puede comprobar a mano.
   */
  probeMode: 'direct_json' | 'proxy_status' | 'proxy_message' | 'manual';
  errorMsg?: string;
  /** Por qué el sitio está en modo manual. */
  manualReason?: string;
}
