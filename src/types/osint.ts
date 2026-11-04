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
  | 'dork_query';

export type ClusterGroupMode = 'none' | 'type' | 'platform' | 'alias_family';

export interface ConfidenceBreakdown {
  total: number; // 0 to 100
  handleMatch: number; // 0 to 30
  aliasSimilarity: number; // 0 to 20
  bioNameMatch: number; // 0 to 20
  geoMatch: number; // 0 to 15
  avatarDomainMatch: number; // 0 to 15
  reasons: string[];
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
  verifiedStatus: 'verified' | 'unverified' | 'false_positive';
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
  reason: 'HTTP_429' | 'CORS_BLOCKED' | 'WAF_CHALLENGE' | 'MANUAL_DORK';
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
}

export interface ApiCredentials {
  corsProxy: string;
  useCorsProxyForSherlock: boolean;
  shodanKey: string;
  virusTotalKey: string;
  urlScanKey: string;
  hibpKey: string;
  hunterKey: string;
  abuseIpDbKey: string;
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
  probeMode: 'direct_json' | 'cors_status' | 'manual_waf';
  errorMsg?: string;
}
