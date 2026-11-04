import { AliasVariant, ConfidenceBreakdown, ContextHints } from '../types/osint';

/**
 * Extracts the morphological root from a username or real name.
 */
export function extractUsernameRoot(rawInput: string): string {
  const cleaned = rawInput
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .split('@')[0]; // If an email was passed, take local part

  // Strip common prefixes/suffixes while keeping at least 3 chars
  let root = cleaned
    .replace(/^(real_|iam_|iam|the_|mr_|el_|soy_|official_)/i, '')
    .replace(/(_official|_real|_dev|_sec|_osint|_es|_mx|_arg|[0-9]{2,4})$/i, '')
    .replace(/[^a-z0-9]/g, '');

  if (root.length < 3) {
    root = cleaned.replace(/[^a-z0-9]/g, '') || 'target';
  }
  return root;
}

/**
 * Computes normalized Levenshtein similarity (0 - 100) between two strings.
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
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  const distance = matrix[s2.length][s1.length];
  const maxLen = Math.max(s1.length, s2.length);
  return Math.max(0, Math.round(((maxLen - distance) / maxLen) * 100));
}

/**
 * Generates OSINT Alias Families (Leet speak, duplicated letters, prefixes/suffixes, separators, years).
 */
export function generateAliasFamilies(seedInput: string, hints?: ContextHints): AliasVariant[] {
  const cleanSeed = seedInput.trim().toLowerCase().replace(/^@/, '').split('@')[0].replace(/\s+/g, '');
  const root = extractUsernameRoot(seedInput);
  const variantsMap = new Map<string, AliasVariant>();

  const addVariant = (
    variant: string,
    familyType: AliasVariant['familyType'],
    familyLabel: string,
    tested = false,
    hitsCount = 0
  ) => {
    const clean = variant.toLowerCase().trim();
    if (!clean || clean.length < 2 || variantsMap.has(clean)) return;
    const similarity = computeStringSimilarity(root, clean);
    variantsMap.set(clean, {
      variant: clean,
      root,
      familyType,
      familyLabel,
      similarity: Math.max(45, similarity),
      tested,
      hitsCount,
    });
  };

  // 1. Exact & Root
  addVariant(cleanSeed, 'exact', 'Semilla Original', true, 1);
  if (root !== cleanSeed) {
    addVariant(root, 'exact', 'Raíz Morfológica', false, 0);
  }

  // 2. Leet Speak (1337)
  const leetFull = root
    .replace(/a/g, '4')
    .replace(/e/g, '3')
    .replace(/i/g, '1')
    .replace(/o/g, '0')
    .replace(/s/g, '5');
  const leetVowelsOnly = root.replace(/o/g, '0').replace(/e/g, '3').replace(/a/g, '4');
  const leetSubtle = root.replace(/i/g, '1').replace(/o/g, '0');
  addVariant(leetFull, 'leet_speak', 'Leet Speak (Completo)');
  addVariant(leetVowelsOnly, 'leet_speak', 'Leet Speak (Vocales)');
  addVariant(leetSubtle, 'leet_speak', 'Leet Speak (Sutil)');

  // 3. Duplicated Characters (Letras repetidas)
  if (root.length >= 3) {
    addVariant(`${root}${root[root.length - 1]}`, 'duplicated_chars', 'Sufijo Doble Carácter');
    addVariant(`${root[0]}${root}`, 'duplicated_chars', 'Prefijo Doble Carácter');
    const vowelDoubled = root.replace(/([aeiou])/, '$1$1');
    addVariant(vowelDoubled, 'duplicated_chars', 'Vocal Duplicada');
  }

  // 4. Separators (Guiones, puntos, barras bajas)
  if (seedInput.includes(' ') || seedInput.includes('_') || seedInput.includes('.')) {
    const tokens = seedInput
      .toLowerCase()
      .split(/[\s._-]+/)
      .filter(Boolean);
    if (tokens.length >= 2) {
      addVariant(tokens.join('_'), 'separator', 'Separador Guion Bajo');
      addVariant(tokens.join('.'), 'separator', 'Separador Punto');
      addVariant(tokens.join('-'), 'separator', 'Separador Guion Medio');
      addVariant(`${tokens[0][0]}${tokens[1]}`, 'separator', 'Inicial + Apellido');
      addVariant(`${tokens[0]}_${tokens[1][0]}`, 'separator', 'Nombre + Inicial');
    }
  } else if (root.length >= 6) {
    const mid = Math.floor(root.length / 2);
    addVariant(`${root.slice(0, mid)}_${root.slice(mid)}`, 'separator', 'División con Guion Bajo');
    addVariant(`${root.slice(0, mid)}.${root.slice(mid)}`, 'separator', 'División con Punto');
  }

  // 5. Prefixes & Suffixes (OSINT / Cyber / Social)
  addVariant(`${root}_sec`, 'prefix_suffix', 'Sufijo Ciberseguridad (_sec)');
  addVariant(`${root}_dev`, 'prefix_suffix', 'Sufijo Desarrollo (_dev)');
  addVariant(`real_${root}`, 'prefix_suffix', 'Prefijo Verificación (real_)');
  addVariant(`iam${root}`, 'prefix_suffix', 'Prefijo Identidad (iam)');
  addVariant(`${root}_official`, 'prefix_suffix', 'Sufijo Oficial (_official)');
  addVariant(`${root}_es`, 'prefix_suffix', 'Sufijo Regional (_es)');

  // 6. Year & Numeric Suffixes
  const yearHint = hints?.expectedYear || '99';
  addVariant(`${root}${yearHint}`, 'year_numeric', `Sufijo Numérico (${yearHint})`);
  addVariant(`${root}01`, 'year_numeric', 'Secuencia Numérica (01)');
  addVariant(`${root}_77`, 'year_numeric', 'Sufijo Numérico (_77)');

  return Array.from(variantsMap.values());
}

/**
 * Multi-factor Confidence Scoring Engine (0 to 100) to differentiate real profiles from homonyms.
 */
export function calculateConfidenceScore(params: {
  seedQuery: string;
  candidateHandle?: string;
  candidateName?: string;
  candidateBio?: string;
  candidateLocation?: string;
  candidateDomainOrUrl?: string;
  candidateAvatarHash?: string;
  isDirectApiMatch?: boolean;
  hints?: ContextHints;
}): ConfidenceBreakdown {
  const {
    seedQuery,
    candidateHandle = '',
    candidateName = '',
    candidateBio = '',
    candidateLocation = '',
    candidateDomainOrUrl = '',
    candidateAvatarHash = '',
    isDirectApiMatch = false,
    hints = {},
  } = params;

  const reasons: string[] = [];
  const root = extractUsernameRoot(seedQuery);
  const cleanCandidateHandle = candidateHandle.toLowerCase().replace(/^@/, '').trim();

  // 1. Handle / Identifier Match (Max 30)
  let handleMatch = 0;
  if (
    cleanCandidateHandle &&
    (cleanCandidateHandle === seedQuery.toLowerCase().trim() || cleanCandidateHandle === root)
  ) {
    handleMatch = 30;
    reasons.push(`Coincidencia exacta de identificador principal ("${cleanCandidateHandle}") [+30]`);
  } else if (cleanCandidateHandle && cleanCandidateHandle.includes(root)) {
    handleMatch = 22;
    reasons.push(`Contiene la raíz morfológica "${root}" en el handle [+22]`);
  } else if (isDirectApiMatch) {
    handleMatch = 25;
    reasons.push('Registro técnico confirmado por respuesta directa de API [+25]');
  } else {
    handleMatch = 12;
    reasons.push('Coincidencia parcial de patrón de búsqueda [+12]');
  }

  // 2. Alias Family / Morphological Similarity (Max 20)
  let aliasSimilarity = 0;
  const sim = computeStringSimilarity(root, extractUsernameRoot(cleanCandidateHandle || seedQuery));
  if (sim >= 90) {
    aliasSimilarity = 20;
    reasons.push(`Similitud morfológica de familia de alias muy alta (${sim}%) [+20]`);
  } else if (sim >= 70) {
    aliasSimilarity = 14;
    reasons.push(`Variante compatible con familia de alias (${sim}%) [+14]`);
  } else {
    aliasSimilarity = 8;
  }

  // 3. Cross-Platform Name / Bio Correlation (Max 20)
  let bioNameMatch = 0;
  const targetName = (hints.expectedName || '').toLowerCase().trim();
  const combinedText = `${candidateName} ${candidateBio}`.toLowerCase();

  if (targetName && combinedText.includes(targetName)) {
    bioNameMatch = 20;
    reasons.push(`Nombre real/alias esperado ("${hints.expectedName}") confirmado en biografía/perfil [+20]`);
  } else if (candidateName && candidateBio && candidateBio.length > 12) {
    bioNameMatch = 15;
    reasons.push(`Metadatos de perfil y biografía públicos verificados (${candidateName}) [+15]`);
  } else if (candidateName) {
    bioNameMatch = 10;
    reasons.push(`Nombre de perfil público extraído (${candidateName}) [+10]`);
  } else {
    bioNameMatch = 5;
  }

  // 4. Geographic / Timezone Correlation (Max 15)
  let geoMatch = 0;
  const expectedLoc = (hints.expectedLocation || '').toLowerCase().trim();
  const candLoc = candidateLocation.toLowerCase().trim();

  if (expectedLoc && candLoc && (candLoc.includes(expectedLoc) || expectedLoc.includes(candLoc))) {
    geoMatch = 15;
    reasons.push(`Ubicación geográfica coincide con el objetivo ("${candidateLocation}") [+15]`);
  } else if (candLoc) {
    geoMatch = 11;
    reasons.push(`Coordenada / región geográfica identificada (${candidateLocation}) [+11]`);
  } else {
    geoMatch = 4;
  }

  // 5. Avatar Hash / Linked Website / Domain Correlation (Max 15)
  let avatarDomainMatch = 0;
  const expectedDom = (hints.expectedDomain || '').toLowerCase().trim();
  const candDom = candidateDomainOrUrl.toLowerCase().trim();

  if (expectedDom && candDom && candDom.includes(expectedDom)) {
    avatarDomainMatch = 15;
    reasons.push(`Vinculación cruzada con el dominio objetivo ("${expectedDom}") [+15]`);
  } else if (candidateAvatarHash) {
    avatarDomainMatch = 13;
    reasons.push(`Hash de avatar / huella visual correlacionada (${candidateAvatarHash.slice(0, 8)}...) [+13]`);
  } else if (candDom) {
    avatarDomainMatch = 9;
    reasons.push('Enlace externo o recurso web verificado [+9]');
  } else {
    avatarDomainMatch = 5;
  }

  const total = Math.min(
    100,
    Math.max(10, handleMatch + aliasSimilarity + bioNameMatch + geoMatch + avatarDomainMatch)
  );

  return {
    total,
    handleMatch,
    aliasSimilarity,
    bioNameMatch,
    geoMatch,
    avatarDomainMatch,
    reasons,
  };
}
