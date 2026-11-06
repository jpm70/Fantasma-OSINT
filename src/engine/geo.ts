/**
 * Convierte la ubicación escrita en un perfil («Valencia, España», «Buenos Aires», «Madrid, ES»)
 * en coordenadas aproximadas para el mapa.
 *
 * Se busca por palabras completas y primero por ciudades: «Barcelona, España» es Barcelona,
 * no Madrid, y «Buenos Aires» no contiene «es» como palabra. Los códigos de país de dos letras
 * solo cuentan escritos en mayúsculas («Madrid, ES»), porque en minúsculas son palabras corrientes.
 */

export interface PlaceMatch {
  lat: number;
  lng: number;
  label: string;
  countryCode: string;
  /** 'city' si se reconoció la ciudad; 'country' si solo el país (se marca la capital). */
  precision: 'city' | 'country';
}

interface Entry {
  keywords: string[];
  codes?: string[];
  lat: number;
  lng: number;
  label: string;
  cc: string;
}

const CITIES: Entry[] = [
  { keywords: ['madrid'], lat: 40.4168, lng: -3.7038, label: 'Madrid, España', cc: 'ES' },
  { keywords: ['barcelona'], lat: 41.3874, lng: 2.1686, label: 'Barcelona, España', cc: 'ES' },
  { keywords: ['valencia', 'valència'], lat: 39.4699, lng: -0.3763, label: 'Valencia, España', cc: 'ES' },
  { keywords: ['alicante', 'alacant'], lat: 38.3452, lng: -0.481, label: 'Alicante, España', cc: 'ES' },
  { keywords: ['sevilla', 'seville'], lat: 37.3891, lng: -5.9845, label: 'Sevilla, España', cc: 'ES' },
  { keywords: ['bilbao'], lat: 43.263, lng: -2.935, label: 'Bilbao, España', cc: 'ES' },
  { keywords: ['zaragoza'], lat: 41.6488, lng: -0.8891, label: 'Zaragoza, España', cc: 'ES' },
  { keywords: ['malaga', 'málaga'], lat: 36.7213, lng: -4.4214, label: 'Málaga, España', cc: 'ES' },
  { keywords: ['ciudad de mexico', 'ciudad de méxico', 'cdmx'], lat: 19.4326, lng: -99.1332, label: 'Ciudad de México, México', cc: 'MX' },
  { keywords: ['buenos aires'], lat: -34.6037, lng: -58.3816, label: 'Buenos Aires, Argentina', cc: 'AR' },
  { keywords: ['bogota', 'bogotá'], lat: 4.711, lng: -74.0721, label: 'Bogotá, Colombia', cc: 'CO' },
  { keywords: ['santiago de chile'], lat: -33.4489, lng: -70.6693, label: 'Santiago, Chile', cc: 'CL' },
  { keywords: ['lima'], lat: -12.0464, lng: -77.0428, label: 'Lima, Perú', cc: 'PE' },
  { keywords: ['san francisco', 'bay area'], lat: 37.7749, lng: -122.4194, label: 'San Francisco, EE. UU.', cc: 'US' },
  { keywords: ['new york', 'nueva york', 'nyc', 'manhattan'], lat: 40.7128, lng: -74.006, label: 'Nueva York, EE. UU.', cc: 'US' },
  { keywords: ['london', 'londres'], lat: 51.5072, lng: -0.1276, label: 'Londres, Reino Unido', cc: 'GB' },
  { keywords: ['berlin', 'berlín'], lat: 52.52, lng: 13.405, label: 'Berlín, Alemania', cc: 'DE' },
  { keywords: ['frankfurt'], lat: 50.1109, lng: 8.6821, label: 'Fráncfort, Alemania', cc: 'DE' },
  { keywords: ['paris', 'parís'], lat: 48.8566, lng: 2.3522, label: 'París, Francia', cc: 'FR' },
  { keywords: ['amsterdam', 'ámsterdam'], lat: 52.3676, lng: 4.9041, label: 'Ámsterdam, Países Bajos', cc: 'NL' },
  { keywords: ['lisboa', 'lisbon'], lat: 38.7223, lng: -9.1393, label: 'Lisboa, Portugal', cc: 'PT' },
  { keywords: ['roma', 'rome'], lat: 41.9028, lng: 12.4964, label: 'Roma, Italia', cc: 'IT' },
  { keywords: ['tokyo', 'tokio'], lat: 35.6762, lng: 139.6503, label: 'Tokio, Japón', cc: 'JP' },
];

const COUNTRIES: Entry[] = [
  { keywords: ['españa', 'espana', 'spain'], codes: ['ES', 'ESP'], lat: 40.4168, lng: -3.7038, label: 'España', cc: 'ES' },
  { keywords: ['mexico', 'méxico'], codes: ['MX', 'MEX'], lat: 19.4326, lng: -99.1332, label: 'México', cc: 'MX' },
  { keywords: ['argentina'], codes: ['AR', 'ARG'], lat: -34.6037, lng: -58.3816, label: 'Argentina', cc: 'AR' },
  { keywords: ['colombia'], codes: ['CO', 'COL'], lat: 4.711, lng: -74.0721, label: 'Colombia', cc: 'CO' },
  { keywords: ['chile'], codes: ['CL', 'CHL'], lat: -33.4489, lng: -70.6693, label: 'Chile', cc: 'CL' },
  { keywords: ['peru', 'perú'], codes: ['PE', 'PER'], lat: -12.0464, lng: -77.0428, label: 'Perú', cc: 'PE' },
  { keywords: ['united states', 'estados unidos', 'usa'], codes: ['US', 'USA'], lat: 38.9072, lng: -77.0369, label: 'Estados Unidos', cc: 'US' },
  { keywords: ['united kingdom', 'reino unido', 'england', 'inglaterra'], codes: ['UK', 'GB'], lat: 51.5072, lng: -0.1276, label: 'Reino Unido', cc: 'GB' },
  { keywords: ['germany', 'alemania', 'deutschland'], codes: ['DE', 'DEU'], lat: 52.52, lng: 13.405, label: 'Alemania', cc: 'DE' },
  { keywords: ['france', 'francia'], codes: ['FR', 'FRA'], lat: 48.8566, lng: 2.3522, label: 'Francia', cc: 'FR' },
  { keywords: ['netherlands', 'países bajos', 'paises bajos', 'holanda'], codes: ['NL', 'NLD'], lat: 52.3676, lng: 4.9041, label: 'Países Bajos', cc: 'NL' },
  { keywords: ['portugal'], codes: ['PT', 'PRT'], lat: 38.7223, lng: -9.1393, label: 'Portugal', cc: 'PT' },
  { keywords: ['italia', 'italy'], codes: ['IT', 'ITA'], lat: 41.9028, lng: 12.4964, label: 'Italia', cc: 'IT' },
  { keywords: ['japan', 'japón', 'japon'], codes: ['JP', 'JPN'], lat: 35.6762, lng: 139.6503, label: 'Japón', cc: 'JP' },
];

/** Minúsculas y sin tildes, para comparar textos escritos de formas distintas. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

function containsPhrase(normText: string, phrase: string): boolean {
  const p = normalizeText(phrase);
  return p.length > 0 && ` ${normText} `.includes(` ${p} `);
}

export function resolvePlace(text?: string): PlaceMatch | null {
  if (!text || !text.trim()) return null;
  const norm = normalizeText(text);
  for (const e of CITIES) {
    if (e.keywords.some((k) => containsPhrase(norm, k))) {
      return { lat: e.lat, lng: e.lng, label: e.label, countryCode: e.cc, precision: 'city' };
    }
  }
  const upperTokens = new Set(text.split(/[^A-Za-z]+/).filter((t) => t.length >= 2 && t === t.toUpperCase()));
  for (const e of COUNTRIES) {
    if (e.keywords.some((k) => containsPhrase(norm, k)) || (e.codes ?? []).some((c) => upperTokens.has(c))) {
      return { lat: e.lat, lng: e.lng, label: e.label, countryCode: e.cc, precision: 'country' };
    }
  }
  return null;
}

/**
 * ¿Dos ubicaciones escritas apuntan al mismo sitio? 'match', 'conflict' o 'unknown' si no se puede saber.
 * Si una es solo un país y la otra una ciudad de ese país, cuenta como coincidencia.
 */
export function compareLocations(expected: string, candidate: string): 'match' | 'conflict' | 'unknown' {
  const ne = normalizeText(expected);
  const nc = normalizeText(candidate);
  if (!ne || !nc) return 'unknown';
  if (containsPhrase(nc, ne) || containsPhrase(ne, nc)) return 'match';
  const a = resolvePlace(expected);
  const b = resolvePlace(candidate);
  if (!a || !b) return 'unknown';
  if (a.countryCode !== b.countryCode) return 'conflict';
  if (a.precision === 'country' || b.precision === 'country') return 'match';
  return a.label === b.label ? 'match' : 'conflict';
}
