import { AliasVariant, ConfidenceBreakdown, ContextHints, GraphNode, ProfileEvidence } from '../types/osint';
import { compareLocations, normalizeText } from '../engine/geo';

/**
 * Extrae la raíz morfológica de un alias, un correo o un nombre.
 */
export function extractUsernameRoot(rawInput: string): string {
  const cleaned = rawInput.trim().toLowerCase().replace(/^@/, '').split('@')[0];

  // Quita prefijos y sufijos habituales manteniendo al menos 3 caracteres
  let root = cleaned
    .replace(/^(real_|iam_|iam|the_|mr_|el_|soy_|official_)/i, '')
    .replace(/(_official|_real|_dev|_sec|_osint|_es|_mx|_arg|[0-9]{2,4})$/i, '')
    .replace(/[^a-z0-9]/g, '');

  if (root.length < 3) {
    root = cleaned.replace(/[^a-z0-9]/g, '') || 'objetivo';
  }
  return root;
}

/**
 * Similitud de Levenshtein normalizada (0–100).
 */
export function computeStringSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 100;
  if (!s1.length || !s2.length) return 0;

  const matrix: number[][] = [];
  for (let i = 0; i <= s2.length; i++) matrix[i] = [i];
  for (let j = 0; j <= s1.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }

  const distance = matrix[s2.length][s1.length];
  const maxLen = Math.max(s1.length, s2.length);
  return Math.max(0, Math.round(((maxLen - distance) / maxLen) * 100));
}

/**
 * Genera familias de alias: leet speak, letras repetidas, separadores, prefijos, sufijos y números.
 */
export function generateAliasFamilies(seedInput: string, hints?: ContextHints): AliasVariant[] {
  const cleanSeed = seedInput.trim().toLowerCase().replace(/^@/, '').split('@')[0].replace(/\s+/g, '');
  const root = extractUsernameRoot(seedInput);
  const variantsMap = new Map<string, AliasVariant>();

  const addVariant = (variant: string, familyType: AliasVariant['familyType'], familyLabel: string) => {
    const clean = variant.toLowerCase().trim();
    if (!clean || clean.length < 2 || variantsMap.has(clean)) return;
    variantsMap.set(clean, {
      variant: clean,
      root,
      familyType,
      familyLabel,
      similarity: computeStringSimilarity(root, clean),
      tested: false,
      hitsCount: 0,
    });
  };

  // 1. Semilla y raíz
  addVariant(cleanSeed, 'exact', 'Semilla original');
  if (root !== cleanSeed) addVariant(root, 'exact', 'Raíz morfológica');

  // 2. Leet speak (1337)
  const leetFull = root.replace(/a/g, '4').replace(/e/g, '3').replace(/i/g, '1').replace(/o/g, '0').replace(/s/g, '5');
  const leetVowelsOnly = root.replace(/o/g, '0').replace(/e/g, '3').replace(/a/g, '4');
  const leetSubtle = root.replace(/i/g, '1').replace(/o/g, '0');
  addVariant(leetFull, 'leet_speak', 'Leet speak (completo)');
  addVariant(leetVowelsOnly, 'leet_speak', 'Leet speak (vocales)');
  addVariant(leetSubtle, 'leet_speak', 'Leet speak (sutil)');

  // 3. Letras repetidas
  if (root.length >= 3) {
    addVariant(`${root}${root[root.length - 1]}`, 'duplicated_chars', 'Última letra doble');
    addVariant(`${root[0]}${root}`, 'duplicated_chars', 'Primera letra doble');
    addVariant(root.replace(/([aeiou])/, '$1$1'), 'duplicated_chars', 'Vocal duplicada');
  }

  // 4. Separadores
  if (seedInput.includes(' ') || seedInput.includes('_') || seedInput.includes('.')) {
    const tokens = seedInput.toLowerCase().split(/[\s._-]+/).filter(Boolean);
    if (tokens.length >= 2) {
      addVariant(tokens.join('_'), 'separator', 'Separador guion bajo');
      addVariant(tokens.join('.'), 'separator', 'Separador punto');
      addVariant(tokens.join('-'), 'separator', 'Separador guion');
      addVariant(`${tokens[0][0]}${tokens[1]}`, 'separator', 'Inicial + apellido');
      addVariant(`${tokens[0]}_${tokens[1][0]}`, 'separator', 'Nombre + inicial');
    }
  } else if (root.length >= 6) {
    const mid = Math.floor(root.length / 2);
    addVariant(`${root.slice(0, mid)}_${root.slice(mid)}`, 'separator', 'División con guion bajo');
    addVariant(`${root.slice(0, mid)}.${root.slice(mid)}`, 'separator', 'División con punto');
  }

  // 5. Prefijos y sufijos
  addVariant(`${root}_sec`, 'prefix_suffix', 'Sufijo _sec');
  addVariant(`${root}_dev`, 'prefix_suffix', 'Sufijo _dev');
  addVariant(`real_${root}`, 'prefix_suffix', 'Prefijo real_');
  addVariant(`iam${root}`, 'prefix_suffix', 'Prefijo iam');
  addVariant(`${root}_official`, 'prefix_suffix', 'Sufijo _official');
  addVariant(`${root}_es`, 'prefix_suffix', 'Sufijo regional _es');

  // 6. Años y números
  const yearHint = (hints?.expectedYear || '').trim();
  if (yearHint) addVariant(`${root}${yearHint}`, 'year_numeric', `Sufijo numérico (${yearHint})`);
  addVariant(`${root}99`, 'year_numeric', 'Sufijo numérico (99)');
  addVariant(`${root}01`, 'year_numeric', 'Secuencia numérica (01)');

  return Array.from(variantsMap.values());
}

// ---------------------------------------------------------------------------
// Puntuación de confianza
// ---------------------------------------------------------------------------

/** Umbrales de clasificación de un perfil. */
export const CONFIDENCE_BANDS = { corroborated: 75, homonym: 40 } as const;

export type IdentityBand = 'corroborated' | 'uncorroborated' | 'homonym';

export function identityBand(total: number): IdentityBand {
  if (total >= CONFIDENCE_BANDS.corroborated) return 'corroborated';
  if (total < CONFIDENCE_BANDS.homonym) return 'homonym';
  return 'uncorroborated';
}

export const BAND_LABEL: Record<IdentityBand, string> = {
  corroborated: 'Corroborado',
  uncorroborated: 'Sin corroborar',
  homonym: 'Probable homónimo',
};

/** Confianza de un dato técnico (no mide identidad). */
export function sourceConfidence(total: number, reason: string): ConfidenceBreakdown {
  return { total, handleMatch: 0, aliasSimilarity: 0, bioNameMatch: 0, geoMatch: 0, avatarDomainMatch: 0, basis: 'source', reasons: [reason] };
}

/** Señales que comparten varios perfiles encontrados (mismo nombre visible, misma web). */
export interface CrossSignals {
  sharedNameWith?: string[];
  sharedWebsiteWith?: string[];
}

function nameTokens(s: string): string[] {
  return normalizeText(s).split(' ').filter((t) => t.length >= 3);
}

export function websiteHost(url?: string): string {
  if (!url) return '';
  const u = url.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  return u.split(/[/?#]/)[0].replace(/:\d+$/, '');
}

/**
 * Puntuación de identidad de un perfil frente al objetivo.
 *
 * Solo suma lo que coincide: el alias (hasta 50), el nombre (20), la ubicación (15) y la web (15),
 * comparados con las pistas del analista o con otros perfiles encontrados. Tener biografía o
 * ubicación no suma por sí solo, y lo que contradice las pistas resta. Sin pistas ni otros
 * perfiles que coincidan, un alias exacto se queda en 50: existe, pero no se sabe si es la misma persona.
 */
export function calculateConfidenceScore(params: {
  seedQuery: string;
  candidateHandle?: string;
  candidateName?: string;
  candidateBio?: string;
  candidateLocation?: string;
  candidateDomainOrUrl?: string;
  statusOnly?: boolean;
  hints?: ContextHints;
  cross?: CrossSignals;
}): ConfidenceBreakdown {
  const {
    seedQuery,
    candidateHandle = '',
    candidateName = '',
    candidateBio = '',
    candidateLocation = '',
    candidateDomainOrUrl = '',
    statusOnly = false,
    hints = {},
    cross = {},
  } = params;

  const reasons: string[] = [];
  let penalty = 0;
  const seed = seedQuery.toLowerCase().trim().replace(/^@/, '');
  const root = extractUsernameRoot(seedQuery);
  const handle = candidateHandle.toLowerCase().replace(/^@/, '').trim();

  // 1. Alias (máx. 30)
  let handleMatch = 10;
  if (handle && (handle === seed || handle === root)) {
    handleMatch = 30;
    reasons.push(`Alias idéntico a la semilla («${handle}») [+30]`);
  } else if (handle && handle.includes(root)) {
    handleMatch = 20;
    reasons.push(`El alias contiene la raíz «${root}» [+20]`);
  } else {
    reasons.push('Alias distinto de la semilla [+10]');
  }

  // 2. Familia de alias (máx. 20)
  const sim = computeStringSimilarity(root, extractUsernameRoot(handle || seedQuery));
  let aliasSimilarity = 0;
  if (sim >= 90) aliasSimilarity = 20;
  else if (sim >= 70) aliasSimilarity = 12;
  else if (sim >= 50) aliasSimilarity = 6;
  if (aliasSimilarity) reasons.push(`Similitud con la raíz del ${sim} % [+${aliasSimilarity}]`);

  if (statusOnly) {
    reasons.push('Detectado solo por el código HTTP: no hay nombre, ubicación ni web que comparar');
  }

  // 3. Nombre y biografía (máx. 20)
  let bioNameMatch = 0;
  const expectedTokens = nameTokens(hints.expectedName || '');
  const candidateText = `${candidateName} ${candidateBio}`;
  const candTokens = new Set(nameTokens(candidateText));
  // Muchas plataformas rellenan el nombre visible con el propio alias: eso no es un nombre
  const nameIsHandle = candidateName.trim().toLowerCase().replace(/^@/, '') === handle;
  if (expectedTokens.length) {
    const hits = expectedTokens.filter((t) => candTokens.has(t)).length;
    if (hits === expectedTokens.length) {
      bioNameMatch = 20;
      reasons.push(`El nombre esperado («${hints.expectedName}») aparece en el perfil [+20]`);
    } else if (hits > 0) {
      bioNameMatch = 10;
      reasons.push(`Parte del nombre esperado aparece en el perfil (${hits}/${expectedTokens.length}) [+10]`);
    } else if (candidateName && !nameIsHandle) {
      penalty += 10;
      reasons.push(`El nombre del perfil («${candidateName}») no coincide con el esperado [−10]`);
    }
  }
  if (!bioNameMatch && cross.sharedNameWith?.length) {
    bioNameMatch = 15;
    reasons.push(`Mismo nombre visible que en ${cross.sharedNameWith.join(', ')} [+15]`);
  }

  // 4. Ubicación (máx. 15)
  let geoMatch = 0;
  if (hints.expectedLocation?.trim() && candidateLocation.trim()) {
    const cmp = compareLocations(hints.expectedLocation, candidateLocation);
    if (cmp === 'match') {
      geoMatch = 15;
      reasons.push(`La ubicación coincide con la esperada («${candidateLocation}») [+15]`);
    } else if (cmp === 'conflict') {
      penalty += 15;
      reasons.push(`La ubicación del perfil («${candidateLocation}») contradice la esperada [−15]`);
    } else {
      reasons.push(`Ubicación «${candidateLocation}» no comparable con la esperada [0]`);
    }
  }

  // 5. Web enlazada (máx. 15)
  let avatarDomainMatch = 0;
  const expectedDom = websiteHost(hints.expectedDomain);
  const candDom = websiteHost(candidateDomainOrUrl);
  if (expectedDom && candDom && (candDom === expectedDom || candDom.endsWith(`.${expectedDom}`))) {
    avatarDomainMatch = 15;
    reasons.push(`Enlaza al dominio esperado («${expectedDom}») [+15]`);
  } else if (cross.sharedWebsiteWith?.length) {
    avatarDomainMatch = 12;
    reasons.push(`Enlaza a la misma web (${candDom}) que ${cross.sharedWebsiteWith.join(', ')} [+12]`);
  }

  const sum = handleMatch + aliasSimilarity + bioNameMatch + geoMatch + avatarDomainMatch;
  const total = Math.min(100, Math.max(0, sum - penalty));
  return { total, handleMatch, aliasSimilarity, bioNameMatch, geoMatch, avatarDomainMatch, penalty, basis: 'identity', reasons };
}

export function scoreEvidence(seedQuery: string, ev: ProfileEvidence, hints?: ContextHints, cross?: CrossSignals): ConfidenceBreakdown {
  return calculateConfidenceScore({
    seedQuery,
    candidateHandle: ev.handle,
    candidateName: ev.displayName,
    candidateBio: ev.bio,
    candidateLocation: ev.location,
    candidateDomainOrUrl: ev.website,
    statusOnly: ev.statusOnly,
    hints,
    cross,
  });
}

/**
 * Recalcula la identidad de todos los perfiles, cruzando entre ellos el nombre visible y la web.
 * Los datos técnicos no se tocan, y el veredicto del analista (real u homónimo) se respeta.
 */
export function rescoreProfiles(nodes: GraphNode[], seedQuery: string, hints: ContextHints = {}): GraphNode[] {
  const profiles = nodes.filter((n) => n.evidence);
  const nameKey = (n: GraphNode) => {
    const ev = n.evidence!;
    const name = normalizeText(ev.displayName || '');
    // Un nombre visible que solo repite el alias no es una señal independiente
    if (!name || name.replace(/ /g, '').length < 4 || (ev.displayName || '').trim().toLowerCase().replace(/^@/, '') === ev.handle.toLowerCase()) return '';
    return name;
  };
  const byName = new Map<string, GraphNode[]>();
  const byWeb = new Map<string, GraphNode[]>();
  for (const n of profiles) {
    const k = nameKey(n);
    if (k) byName.set(k, [...(byName.get(k) ?? []), n]);
    const w = websiteHost(n.evidence!.website);
    if (w) byWeb.set(w, [...(byWeb.get(w) ?? []), n]);
  }
  const others = (group: GraphNode[] | undefined, self: GraphNode) =>
    Array.from(new Set((group ?? []).filter((g) => g.id !== self.id && g.platform !== self.platform).map((g) => g.platform)));

  return nodes.map((n) => {
    if (!n.evidence) return n;
    const cross: CrossSignals = {
      sharedNameWith: others(byName.get(nameKey(n)), n),
      sharedWebsiteWith: others(byWeb.get(websiteHost(n.evidence.website)), n),
    };
    const confidence = scoreEvidence(seedQuery, n.evidence, hints, cross);
    return { ...n, confidence };
  });
}
