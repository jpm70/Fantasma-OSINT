import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareLocations, resolvePlace } from './geo';
import { analyzePhone } from './phone';
import { validateSpanishId } from './nationalId';
import { decryptVault, encryptVault, legacyXorDecode } from './vault';
import { canonicalCaseJson, caseSha256, csvCell, safeHttpUrl, sha256Hex } from './integrity';
import { buildStixBundle } from './stix';
import { analyzeFileBytes } from './fileMeta';
import {
  calculateConfidenceScore,
  computeStringSimilarity,
  generateAliasFamilies,
  identityBand,
  rescoreProfiles,
} from '../services/aliasAndConfidenceEngine';
import {
  buildProxiedUrl,
  detectInputType,
  executeOsintInvestigation,
  isNonPublicIpv4,
  parseDirectProfile,
  SHERLOCK_SITES,
} from '../services/osintEngine';
import { createInitialDemoCase, DEFAULT_CREDENTIALS, normalizeCase } from '../services/storageService';
import { buildCaseHtml, buildMaltegoCsv } from '../services/reportGenerator';
import type { InvestigationCase } from '../types/osint';

afterEach(() => vi.unstubAllGlobals());

describe('ubicaciones escritas', () => {
  it('la ciudad gana al país y no hay coincidencias por trozos de palabra', () => {
    expect(resolvePlace('Barcelona, España')?.label).toBe('Barcelona, España');
    expect(resolvePlace('Buenos Aires')?.countryCode).toBe('AR');
    expect(resolvePlace('Los Ángeles, Chile')?.label).toBe('Chile');
    expect(resolvePlace('Paris, France')?.label).toBe('París, Francia');
    expect(resolvePlace('Colorado')).toBeNull();
    expect(resolvePlace('Madrid, ES')?.label).toBe('Madrid, España');
    expect(resolvePlace('vivo aquí, es bonito')).toBeNull();
  });
  it('compara ubicaciones', () => {
    expect(compareLocations('Valencia', 'Valencia, España')).toBe('match');
    expect(compareLocations('España', 'Sevilla')).toBe('match');
    expect(compareLocations('Valencia', 'Buenos Aires, Argentina')).toBe('conflict');
    expect(compareLocations('Valencia', 'Marte')).toBe('unknown');
  });
});

describe('teléfono', () => {
  it('normaliza E.164 y detecta el país por el prefijo más largo', () => {
    const es = analyzePhone('+34 612 345 678');
    expect(es.e164).toBe('+34612345678');
    expect(es.countryCode).toBe('ES');
    expect(es.lineType).toBe('Móvil');
    expect(analyzePhone('+351 912 345 678').countryCode).toBe('PT');
    expect(analyzePhone('0052 55 1234 5678').countryCode).toBe('MX');
  });
  it('sin prefijo solo supone España si tiene forma de número español', () => {
    const r = analyzePhone('912345678');
    expect(r.e164).toBe('+34912345678');
    expect(r.assumedCountry).toBe(true);
    expect(r.lineType).toBe('Fijo');
    // Antes se convertía en +612345678 (prefijo de Australia)
    expect(analyzePhone('612345678').e164).toBe('+34612345678');
    expect(analyzePhone('5551234567').countryCode).toBeNull();
  });
  it('un prefijo desconocido no se geolocaliza en Madrid', () => {
    expect(analyzePhone('+999 123 456 789').countryCode).toBeNull();
  });
});

describe('DNI y NIE', () => {
  it('valida la letra de control', () => {
    expect(validateSpanishId('00000000T').valid).toBe(true);
    expect(validateSpanishId('12345678Z').valid).toBe(true);
    expect(validateSpanishId('12345678A')).toMatchObject({ valid: false, expectedLetter: 'Z' });
    expect(validateSpanishId('X1234567L')).toMatchObject({ kind: 'NIE', valid: true });
    expect(validateSpanishId('Y0000000Z')).toMatchObject({ kind: 'NIE', valid: true });
    expect(validateSpanishId('hola').kind).toBe('desconocido');
  });
});

describe('detección del tipo de entrada', () => {
  it.each([
    ['test@example.com', 'email'],
    ['1.1.1.1', 'ip'],
    ['999.1.1.1', 'username'],
    ['00000000T', 'national_id'],
    ['+34 600 000 000', 'phone'],
    ['example.org', 'domain'],
    ['Laura Ejemplo', 'real_name'],
    ['laura_ejemplo', 'username'],
  ])('%s → %s', (q, t) => expect(detectInputType(q)).toBe(t));
  it('IP privadas y de documentación', () => {
    expect(isNonPublicIpv4('192.168.1.10')).toBe(true);
    expect(isNonPublicIpv4('203.0.113.10')).toBe(true);
    expect(isNonPublicIpv4('1.1.1.1')).toBe(false);
  });
});

describe('puntuación de identidad', () => {
  const base = { seedQuery: 'laura_ejemplo', candidateHandle: 'laura_ejemplo' };
  it('tener datos públicos no suma: solo coincidir', () => {
    const vacio = calculateConfidenceScore(base);
    const lleno = calculateConfidenceScore({ ...base, candidateName: 'Pepe Pérez', candidateBio: 'Una bio muy larga y detallada', candidateLocation: 'Tokio', candidateDomainOrUrl: 'https://otra.com' });
    expect(vacio.total).toBe(50);
    expect(lleno.total).toBe(50);
    expect(identityBand(50)).toBe('uncorroborated');
  });
  it('las pistas coincidentes corroboran y las contradictorias restan', () => {
    const hints = { expectedName: 'Laura Ejemplo', expectedLocation: 'Valencia', expectedDomain: 'example.org' };
    const real = calculateConfidenceScore({ ...base, candidateName: 'Laura Ejemplo', candidateLocation: 'Valencia, España', candidateDomainOrUrl: 'https://www.example.org/blog', hints });
    expect(real.total).toBe(100);
    const homonimo = calculateConfidenceScore({ ...base, candidateName: 'Lauri', candidateLocation: 'Buenos Aires', hints });
    expect(homonimo.penalty).toBe(25);
    expect(homonimo.total).toBe(25);
    expect(identityBand(homonimo.total)).toBe('homonym');
  });
  it('un nombre visible igual al alias no penaliza ni cuenta como coincidencia', () => {
    const r = calculateConfidenceScore({ ...base, candidateName: 'laura_ejemplo', hints: { expectedName: 'Laura Ejemplo' } });
    expect(r.penalty).toBe(0);
  });
  it('el cruce entre perfiles corrobora sin pistas', () => {
    const mk = (id: string, platform: string, displayName: string, website?: string) => ({
      id, label: `${platform}: laura_ejemplo`, type: 'social_profile' as const, platform, category: '', aliasFamily: '', metadata: {}, verifiedStatus: 'unverified' as const,
      confidence: calculateConfidenceScore(base), evidence: { handle: 'laura_ejemplo', displayName, website },
    });
    const out = rescoreProfiles([mk('a', 'GitHub', 'Laura Ejemplo', 'https://example.org'), mk('b', 'Keybase', 'Laura Ejemplo'), mk('c', 'Mastodon', 'L. E.', 'https://example.org/x')], 'laura_ejemplo');
    const by = Object.fromEntries(out.map((n) => [n.id, n.confidence.total]));
    expect(by.a).toBe(77);
    expect(by.b).toBe(65);
    expect(by.c).toBe(62);
  });
  it('el caso de ejemplo separa a la persona del homónimo', () => {
    const demo = createInitialDemoCase();
    const score = (id: string) => demo.nodes.find((n) => n.id === id)!.confidence.total;
    expect(identityBand(score('demo-github'))).toBe('corroborated');
    expect(identityBand(score('demo-lichess'))).toBe('homonym');
    expect(identityBand(score('demo-devto'))).not.toBe('corroborated');
  });
  it('las variantes de alias no inventan similitud mínima', () => {
    const v = generateAliasFamilies('laura_ejemplo');
    expect(v.every((x) => !x.tested)).toBe(true);
    for (const x of v) expect(x.similarity).toBe(computeStringSimilarity(x.root, x.variant));
  });
});

describe('catálogo de sitios', () => {
  it('cada sitio tiene un modo de comprobación válido', () => {
    expect(SHERLOCK_SITES.length).toBe(58);
    for (const s of SHERLOCK_SITES) {
      expect(['direct_json', 'proxy_status', 'proxy_message', 'manual']).toContain(s.probeMode);
      expect(s.urlTemplate).toContain('{username}');
      if (s.probeMode === 'proxy_message') expect(s.errorMsg).toBeTruthy();
      if (s.probeMode === 'manual') expect(s.manualReason).toBeTruthy();
    }
  });
  it('los sitios que responden 200 aunque el usuario no exista no se dan por encontrados', () => {
    for (const name of ['Instagram', 'TikTok', 'PyPI', 'Twitch', 'Telegram']) {
      expect(SHERLOCK_SITES.find((s) => s.name === name)?.probeMode).toBe('manual');
    }
  });
  it('sin proxy no se construye URL de proxy', () => {
    expect(buildProxiedUrl('https://a.b/c', '')).toBeNull();
    expect(buildProxiedUrl('https://a.b/c', 'https://p.dev/?url=')).toBe('https://p.dev/?url=https%3A%2F%2Fa.b%2Fc');
    expect(buildProxiedUrl('https://a.b/c', 'https://p.dev/{url}/x')).toBe('https://p.dev/https%3A%2F%2Fa.b%2Fc/x');
  });
  it('interpreta las respuestas de las API directas', () => {
    const site = (n: string) => SHERLOCK_SITES.find((s) => s.name === n)!;
    expect(parseDirectProfile(site('GitHub'), { login: 'x', name: 'X Y', location: 'Valencia', blog: 'https://e.org', created_at: '2020-01-02T00:00:00Z' }, 'x')).toMatchObject({ handle: 'x', displayName: 'X Y', created: '2020-01-02' });
    expect(parseDirectProfile(site('GitLab'), [], 'x')).toBeNull();
    expect(parseDirectProfile(site('Keybase'), { them: [null] }, 'x')).toBeNull();
    expect(parseDirectProfile(site('HackerNews'), null, 'x')).toBeNull();
  });
});

function fakeFetch(routes: Record<string, { status: number; body?: unknown; text?: string }>) {
  return vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new TypeError('Failed to fetch');
    const r = routes[key];
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text } as Response;
  });
}

const emptyCase = (): InvestigationCase => ({ id: 'c1', name: 'Prueba', description: '', createdAt: '', updatedAt: '', seedQuery: 'x', seedType: 'username', contextHints: {}, nodes: [], edges: [], timeline: [], locations: [], manualTasks: [], aliasVariants: [], logs: [] });
const cb = { onLog: () => undefined, onRetryStatus: () => undefined, onCaseProgress: () => undefined };

describe('investigación de usuario (fetch simulado)', () => {
  it('distingue encontrado, no existe y sin respuesta, y sin proxy no da nada por encontrado', async () => {
    vi.stubGlobal('fetch', fakeFetch({
      'https://api.github.com/users/laura_ejemplo': { status: 200, body: { login: 'laura_ejemplo', name: 'Laura Ejemplo', location: 'Valencia' } },
      'https://gitlab.com/': { status: 200, body: [] },
      'https://dev.to/': { status: 404, body: { error: 'not found' } },
      'https://lichess.org/': { status: 429, body: {} },
    }));
    const out = await executeOsintInvestigation({ currentCase: emptyCase(), query: 'laura_ejemplo', inputType: 'username', hints: {}, credentials: DEFAULT_CREDENTIALS, callbacks: cb, backoffMs: 1 });
    const res = Object.fromEntries((out.siteChecks ?? []).map((c) => [c.site, c.result]));
    expect(res.GitHub).toBe('found');
    expect(res.GitLab).toBe('not_found');
    expect(res['Dev.to']).toBe('not_found');
    expect(res.Lichess).toBe('unknown');
    expect(res.Keybase).toBe('unknown');
    expect(res.Instagram).toBe('manual');
    expect(res.YouTube).toBe('manual');
    const profiles = out.nodes.filter((n) => n.evidence);
    expect(profiles.map((n) => n.platform)).toEqual(['GitHub']);
    expect(profiles[0].confidence.total).toBe(50);
    expect(out.manualTasks.some((t) => t.platform === 'Lichess' && t.reason === 'HTTP_429')).toBe(true);
    expect(out.aliasVariants.find((v) => v.variant === 'laura_ejemplo')).toMatchObject({ tested: true, hitsCount: 1 });
    // Ni una sola petición salió hacia un proxy
    const calls = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    expect(calls.some((u) => /corsproxy|allorigins/.test(u))).toBe(false);
  });

  it('con proxy propio, un 200 solo por código queda «sin corroborar»', async () => {
    vi.stubGlobal('fetch', fakeFetch({ 'https://proxy.test/?url=https%3A%2F%2Fwww.youtube.com': { status: 200, text: '<html>' }, 'https://proxy.test/': { status: 404, text: '' } }));
    const out = await executeOsintInvestigation({ currentCase: emptyCase(), query: 'laura_ejemplo', inputType: 'username', hints: {}, credentials: { ...DEFAULT_CREDENTIALS, corsProxy: 'https://proxy.test/?url=' }, callbacks: cb, backoffMs: 1 });
    const yt = out.nodes.find((n) => n.platform === 'YouTube')!;
    expect(yt.evidence?.statusOnly).toBe(true);
    expect(identityBand(yt.confidence.total)).toBe('uncorroborated');
    expect(out.siteChecks?.find((c) => c.site === 'Vimeo')?.result).toBe('not_found');
  });

  it('las claves nunca viajan por el proxy sin permiso explícito', async () => {
    const f = fakeFetch({});
    vi.stubGlobal('fetch', f);
    await executeOsintInvestigation({ currentCase: emptyCase(), query: 'a@example.com', inputType: 'email', hints: {}, credentials: { ...DEFAULT_CREDENTIALS, corsProxy: 'https://proxy.test/?url=', hibpKey: 'SECRETO' }, callbacks: cb, backoffMs: 1 });
    const leaked = f.mock.calls.some((c: unknown[]) => JSON.stringify(c).includes('SECRETO'));
    expect(leaked).toBe(false);
  });
});

describe('dominio y correo (fetch simulado)', () => {
  it('filtra subdominios de verdad y lee SPF y DMARC', async () => {
    vi.stubGlobal('fetch', fakeFetch({
      'https://api.certspotter.com/': { status: 200, body: [{ dns_names: ['www.example.org', 'mail.example.org', 'evilexample.org', '*.dev.example.org'], not_before: '2025-01-01T00:00:00Z' }] },
      'https://dns.google/resolve?name=example.org&type=TXT': { status: 200, body: { Answer: [{ type: 16, data: '"v=spf1 -all"' }] } },
      'https://dns.google/resolve?name=_dmarc.example.org&type=TXT': { status: 200, body: { Answer: [{ type: 16, data: '"v=DMARC1; p=reject"' }] } },
      'https://dns.google/resolve?name=example.org&type=MX': { status: 200, body: { Answer: [{ type: 15, data: '0 .' }] } },
    }));
    const out = await executeOsintInvestigation({ currentCase: emptyCase(), query: 'example.org', inputType: 'domain', hints: {}, credentials: DEFAULT_CREDENTIALS, callbacks: cb, backoffMs: 1 });
    const subs = out.nodes.filter((n) => n.type === 'subdomain').map((n) => n.label).sort();
    expect(subs).toEqual(['dev.example.org', 'mail.example.org', 'www.example.org']);
    const mail = out.nodes.find((n) => n.type === 'dns_record')!;
    expect(mail.metadata.dmarc).toBe('v=DMARC1; p=reject');
    expect(String(mail.metadata.valoracion)).toMatch(/Protegido/);
  });
  it('un teléfono sin país conocido no se marca en el mapa', async () => {
    vi.stubGlobal('fetch', fakeFetch({}));
    const out = await executeOsintInvestigation({ currentCase: emptyCase(), query: '+999 1234 5678', inputType: 'phone', hints: {}, credentials: DEFAULT_CREDENTIALS, callbacks: cb, backoffMs: 1 });
    expect(out.locations).toHaveLength(0);
  });
});

describe('bóveda cifrada', () => {
  it('cifra y descifra con la frase correcta y falla con otra', async () => {
    const blob = await encryptVault('{"openAiKey":"sk-x"}', 'frase de prueba larga', 1000);
    expect(blob.ciphertext).not.toContain('sk-x');
    expect(await decryptVault(blob, 'frase de prueba larga')).toBe('{"openAiKey":"sk-x"}');
    await expect(decryptVault(blob, 'otra frase cualquiera')).rejects.toThrow();
    const again = await encryptVault('{"openAiKey":"sk-x"}', 'frase de prueba larga', 1000);
    expect(again.iv).not.toBe(blob.iv);
  });
  it('lee la bóveda ofuscada de la v1 para migrarla', () => {
    const SALT = 'UN_FANTASMA_EN_EL_SISTEMA_OSINT_2026';
    const enc = encodeURIComponent('{"hibpKey":"abc"}');
    let x = '';
    for (let i = 0; i < enc.length; i++) x += String.fromCharCode(enc.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
    expect(legacyXorDecode(btoa(x))).toBe('{"hibpKey":"abc"}');
  });
});

describe('integridad y exportaciones', () => {
  it('el SHA-256 es el del JSON exportado', async () => {
    const demo = createInitialDemoCase();
    expect(await caseSha256(demo)).toBe(await sha256Hex(canonicalCaseJson(demo)));
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const changed = { ...demo, name: demo.name + ' ' };
    expect(await caseSha256(changed)).not.toBe(await caseSha256(demo));
  });
  it('solo enlaces http(s) y CSV sin fórmulas', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeHttpUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(buildMaltegoCsv(createInitialDemoCase()).split('\n')[0]).toContain('Source_Entity');
  });
  it('el informe HTML escapa los datos externos', async () => {
    const c = createInitialDemoCase();
    c.nodes[1] = { ...c.nodes[1], label: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' };
    const html = await buildCaseHtml(c);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('javascript:alert');
    expect(html).toContain("default-src 'none'");
  });
  it('el bundle STIX 2.1 tiene identificadores válidos y referencias resueltas', () => {
    const b = buildStixBundle(createInitialDemoCase());
    const uuid = /^[a-z0-9-]+--[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = new Set(b.objects.map((o) => o.id));
    expect(b.id).toMatch(uuid);
    for (const o of b.objects) {
      expect(o.id).toMatch(uuid);
      expect(o.id.startsWith(`${o.type}--`)).toBe(true);
      expect(o.spec_version).toBe('2.1');
      const sco = ['ipv4-addr', 'domain-name', 'email-addr', 'user-account', 'url'].includes(o.type);
      if (sco) {
        expect(o).not.toHaveProperty('created');
        expect(o).not.toHaveProperty('confidence');
      }
      for (const k of ['source_ref', 'target_ref', 'created_by_ref']) if (o[k]) expect(ids.has(o[k] as string)).toBe(true);
      for (const r of (o.object_refs as string[] | undefined) ?? []) expect(ids.has(r)).toBe(true);
      if (o.type === 'relationship') expect(o.relationship_type).toMatch(/^[a-z0-9-]+$/);
    }
    expect(b.objects.some((o) => o.type === 'user-account' && o.account_login === 'laura_ejemplo')).toBe(true);
    expect(b.objects.some((o) => o.type === 'domain-name' && o.value === 'example.org')).toBe(true);
  });
});

describe('casos guardados', () => {
  it('migra un caso de la v1 (perfil sin evidencias, puntuación inflada)', () => {
    const v1 = { id: 'old', name: 'Viejo', seedQuery: 'pepe', seedType: 'username', nodes: [
      { id: 's', label: 'pepe', type: 'seed', platform: 'Input OSINT', category: '', aliasFamily: '', confidence: { total: 100 }, verifiedStatus: 'verified', metadata: {} },
      { id: 'p', label: 'GitHub: pepe', type: 'social_profile', platform: 'GitHub', category: '', aliasFamily: '', url: 'javascript:alert(1)', confidence: { total: 89, handleMatch: 30, aliasSimilarity: 20, bioNameMatch: 15, geoMatch: 11, avatarDomainMatch: 13, reasons: [] }, verifiedStatus: 'verified', metadata: { usuario: 'pepe', nombreVisible: 'Pepe', biografia: 'Sin biografía pública', ubicacion: 'Tokio' } },
    ] };
    const c = normalizeCase(v1)!;
    const p = c.nodes.find((n) => n.id === 'p')!;
    expect(p.evidence).toMatchObject({ handle: 'pepe', displayName: 'Pepe', location: 'Tokio' });
    expect(p.evidence?.bio).toBeUndefined();
    expect(p.confidence.total).toBe(50);
    expect(p.verifiedStatus).toBe('unverified');
    expect(p.url).toBeUndefined();
    expect(normalizeCase({ nada: 1 })).toBeNull();
  });
});

// ------------------------------------------------------------------ metadatos de archivos
function jpegWithExif(): Uint8Array {
  // TIFF little-endian con IFD0: Make="Canon", Model="EOS", y puntero GPS
  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push(v & 255, v >> 8);
  const u32 = (v: number) => tiff.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  tiff.push(0x49, 0x49); u16(42); u32(8);
  // IFD0 en 8: 3 entradas
  u16(3);
  const makeOff = 8 + 2 + 3 * 12 + 4; // tras la IFD
  u16(0x010f); u16(2); u32(6); u32(makeOff);
  u16(0x0110); u16(2); u32(4); tiff.push(0x45, 0x4f, 0x53, 0); // "EOS\0" en línea
  const gpsOff = makeOff + 6;
  u16(0x8825); u16(4); u32(1); u32(gpsOff);
  u32(0);
  tiff.push(...'Canon\0'.split('').map((c) => c.charCodeAt(0)));
  // GPS IFD: 4 entradas
  u16(4);
  const ratOff = gpsOff + 2 + 4 * 12 + 4;
  u16(1); u16(2); u32(2); tiff.push(0x4e, 0, 0, 0); // N
  u16(2); u16(5); u32(3); u32(ratOff);
  u16(3); u16(2); u32(2); tiff.push(0x57, 0, 0, 0); // W
  u16(4); u16(5); u32(3); u32(ratOff + 24);
  u32(0);
  for (const [n, d] of [[39, 1], [28, 1], [0, 1], [0, 1], [22, 1], [30, 1]]) { u32(n); u32(d); }
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xd9]);
}

describe('metadatos de archivos', () => {
  it('lee el EXIF y el GPS de un JPEG', () => {
    const r = analyzeFileBytes(jpegWithExif(), 'foto.jpg');
    expect(r.detectedType).toBe('JPEG');
    expect(r.fields.find((f) => f.key.startsWith('Fabricante'))?.value).toBe('Canon');
    expect(r.fields.find((f) => f.key.startsWith('Modelo'))?.value).toBe('EOS');
    expect(r.gps?.lat).toBeCloseTo(39.4667, 3);
    expect(r.gps?.lng).toBeCloseTo(-0.375, 3);
  });
  it('detecta la extensión falsa', () => {
    const r = analyzeFileBytes(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'factura.pdf');
    expect(r.detectedType).toBe('Ejecutable Windows (PE)');
    expect(r.extensionMatches).toBe(false);
  });
  it('lee el diccionario Info de un PDF y el texto de un PNG', () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Author (Laura Ejemplo) /Producer (LibreOffice 7.6) /CreationDate (D:20240102103000) >> endobj');
    const r = analyzeFileBytes(pdf, 'doc.pdf');
    expect(r.fields).toEqual(expect.arrayContaining([{ key: 'Autor', value: 'Laura Ejemplo' }, { key: 'Fecha de creación', value: '2024-01-02 10:30' }]));
    const chunk = (type: string, data: number[]) => { const l = data.length; return [l >>> 24, (l >> 16) & 255, (l >> 8) & 255, l & 255, ...type.split('').map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]; };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('tEXt', [...'Software\0GIMP 2.10'].map((c) => c.charCodeAt(0))), ...chunk('IEND', [])]);
    expect(analyzeFileBytes(png, 'a.png').fields).toEqual([{ key: 'Software', value: 'GIMP 2.10' }]);
  });
});
