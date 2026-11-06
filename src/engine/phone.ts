/**
 * Análisis de un número de teléfono: prefijo de país (UIT E.164), formato normalizado y,
 * en España, el tipo de número según su primera cifra.
 *
 * El prefijo indica el plan de numeración del país, no dónde está la persona: un móvil
 * español puede usarse en cualquier parte y los números portados conservan el prefijo.
 */

export interface PhoneAnalysis {
  /** Número completo en formato E.164 (+ y solo cifras), o null si no se pudo determinar el país. */
  e164: string | null;
  countryCode: string | null;
  countryName: string | null;
  dialCode: string | null;
  nationalNumber: string;
  /** true si el país se ha supuesto (9 cifras sin prefijo: se asume España). */
  assumedCountry: boolean;
  lineType: string;
  valid: boolean;
  notes: string[];
}

// Prefijo → [ISO, nombre, capital lat, lng]. Se busca el prefijo más largo.
const DIAL_CODES: Record<string, [string, string, number, number]> = {
  '1': ['US', 'Estados Unidos / Canadá (plan NANP)', 38.9072, -77.0369],
  '7': ['RU', 'Rusia / Kazajistán', 55.7558, 37.6173],
  '30': ['GR', 'Grecia', 37.9838, 23.7275],
  '31': ['NL', 'Países Bajos', 52.3676, 4.9041],
  '32': ['BE', 'Bélgica', 50.8503, 4.3517],
  '33': ['FR', 'Francia', 48.8566, 2.3522],
  '34': ['ES', 'España', 40.4168, -3.7038],
  '39': ['IT', 'Italia', 41.9028, 12.4964],
  '41': ['CH', 'Suiza', 46.948, 7.4474],
  '44': ['GB', 'Reino Unido', 51.5072, -0.1276],
  '49': ['DE', 'Alemania', 52.52, 13.405],
  '51': ['PE', 'Perú', -12.0464, -77.0428],
  '52': ['MX', 'México', 19.4326, -99.1332],
  '53': ['CU', 'Cuba', 23.1136, -82.3666],
  '54': ['AR', 'Argentina', -34.6037, -58.3816],
  '55': ['BR', 'Brasil', -15.7939, -47.8828],
  '56': ['CL', 'Chile', -33.4489, -70.6693],
  '57': ['CO', 'Colombia', 4.711, -74.0721],
  '58': ['VE', 'Venezuela', 10.4806, -66.9036],
  '81': ['JP', 'Japón', 35.6762, 139.6503],
  '351': ['PT', 'Portugal', 38.7223, -9.1393],
  '353': ['IE', 'Irlanda', 53.3498, -6.2603],
  '376': ['AD', 'Andorra', 42.5063, 1.5218],
  '502': ['GT', 'Guatemala', 14.6349, -90.5069],
  '503': ['SV', 'El Salvador', 13.6929, -89.2182],
  '504': ['HN', 'Honduras', 14.0723, -87.1921],
  '505': ['NI', 'Nicaragua', 12.1149, -86.2362],
  '506': ['CR', 'Costa Rica', 9.9281, -84.0907],
  '507': ['PA', 'Panamá', 8.9824, -79.5199],
  '591': ['BO', 'Bolivia', -16.4897, -68.1193],
  '593': ['EC', 'Ecuador', -0.1807, -78.4678],
  '595': ['PY', 'Paraguay', -25.2637, -57.5759],
  '598': ['UY', 'Uruguay', -34.9011, -56.1645],
};

export function dialCodeCapital(dialCode: string): { lat: number; lng: number } | null {
  const e = DIAL_CODES[dialCode];
  return e ? { lat: e[2], lng: e[3] } : null;
}

function spanishLineType(national: string): string {
  if (/^[67]/.test(national)) return 'Móvil';
  if (/^(800|900)/.test(national)) return 'Número gratuito (800/900)';
  if (/^(80[1-9]|90[1-9])/.test(national)) return 'Tarificación especial (80X/90X)';
  if (/^[89]/.test(national)) return 'Fijo';
  return 'No determinado';
}

export function analyzePhone(raw: string): PhoneAnalysis {
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  const notes: string[] = [];
  let international = trimmed.startsWith('+');
  if (!international && digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }

  if (international) {
    let dial: string | null = null;
    for (const len of [3, 2, 1]) {
      const p = digits.slice(0, len);
      if (DIAL_CODES[p]) {
        dial = p;
        break;
      }
    }
    const valid = digits.length >= 8 && digits.length <= 15;
    if (!dial) {
      notes.push('Prefijo internacional no incluido en la tabla del laboratorio.');
      return { e164: valid ? `+${digits}` : null, countryCode: null, countryName: null, dialCode: null, nationalNumber: digits, assumedCountry: false, lineType: 'No determinado', valid, notes };
    }
    const national = digits.slice(dial.length);
    const [cc, name] = DIAL_CODES[dial];
    if (cc === 'ES' && national.length !== 9) notes.push('Un número español tiene 9 cifras después del +34.');
    return {
      e164: `+${digits}`,
      countryCode: cc,
      countryName: name,
      dialCode: dial,
      nationalNumber: national,
      assumedCountry: false,
      lineType: cc === 'ES' ? spanishLineType(national) : 'No determinado',
      valid: valid && (cc !== 'ES' || national.length === 9),
      notes,
    };
  }

  // Sin prefijo: solo se puede suponer España si tiene la forma de un número español
  if (digits.length === 9 && /^[6789]/.test(digits)) {
    notes.push('Sin prefijo internacional: se supone España (+34) por tener 9 cifras y empezar por 6, 7, 8 o 9.');
    return {
      e164: `+34${digits}`,
      countryCode: 'ES',
      countryName: 'España',
      dialCode: '34',
      nationalNumber: digits,
      assumedCountry: true,
      lineType: spanishLineType(digits),
      valid: true,
      notes,
    };
  }
  notes.push('Sin prefijo internacional no se puede saber el país: escríbelo con + y el prefijo.');
  return { e164: null, countryCode: null, countryName: null, dialCode: null, nationalNumber: digits, assumedCountry: false, lineType: 'No determinado', valid: false, notes };
}
