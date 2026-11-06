import type { GraphNode, InvestigationCase } from '../types/osint';

/**
 * Exportación a un bundle STIX 2.1 válido.
 *
 * - Identificadores `tipo--UUID` (RFC 4122), como exige la especificación.
 * - Observables (SCO) solo con sus propiedades: ipv4-addr, domain-name, email-addr,
 *   user-account (account_login, display_name) y url. Sin created, confidence ni labels,
 *   que son de los objetos de dominio.
 * - Ubicaciones como objetos location con latitud y longitud.
 * - El resto de hallazgos (brechas, puertos, dorks, DNI…) como note, ligada al observable de la semilla.
 * - Relaciones con relationship_type `related-to` y el nombre original en la descripción.
 * - Todo agrupado en un grouping con el nombre del caso.
 */

type StixObject = Record<string, unknown> & { type: string; id: string };

const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function observableFor(n: GraphNode): Record<string, unknown> | null {
  const raw = (n.pivot?.query ?? n.label).trim();
  if (n.type === 'ip' && IPV4.test(raw)) return { type: 'ipv4-addr', value: raw };
  if ((n.type === 'domain' || n.type === 'subdomain') && n.pivot?.type === 'domain' && DOMAIN.test(raw)) return { type: 'domain-name', value: raw.toLowerCase() };
  if (n.type === 'email' && n.pivot?.type === 'email' && EMAIL.test(raw)) return { type: 'email-addr', value: raw.toLowerCase() };
  if (n.type === 'social_profile' && n.evidence) {
    const o: Record<string, unknown> = { type: 'user-account', account_login: n.evidence.handle, account_type: n.platform.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') };
    if (n.evidence.displayName) o.display_name = n.evidence.displayName;
    return o;
  }
  if (n.type === 'seed' && n.pivot) {
    if (n.pivot.type === 'ip' && IPV4.test(raw)) return { type: 'ipv4-addr', value: raw };
    if (n.pivot.type === 'domain' && DOMAIN.test(raw)) return { type: 'domain-name', value: raw.toLowerCase() };
    if (n.pivot.type === 'email' && EMAIL.test(raw)) return { type: 'email-addr', value: raw.toLowerCase() };
    if (n.pivot.type === 'username') return { type: 'user-account', account_login: raw };
  }
  return null;
}

export function buildStixBundle(osintCase: InvestigationCase, now = new Date()): { type: 'bundle'; id: string; objects: StixObject[] } {
  const ts = now.toISOString();
  const identityId = `identity--${uuid()}`;
  const objects: StixObject[] = [
    { type: 'identity', spec_version: '2.1', id: identityId, created: ts, modified: ts, name: 'Fantasma OSINT — Un Fantasma en el Sistema', identity_class: 'system' },
  ];
  const idMap = new Map<string, string>();
  const seed = osintCase.nodes.find((n) => n.type === 'seed');

  // Primero los observables, para poder referenciarlos desde las notas
  for (const n of osintCase.nodes) {
    const obs = observableFor(n);
    if (!obs) continue;
    const id = `${obs.type}--${uuid()}`;
    idMap.set(n.id, id);
    objects.push({ ...obs, spec_version: "2.1", id } as unknown as StixObject);
  }
  const seedRef = seed ? idMap.get(seed.id) : undefined;

  for (const n of osintCase.nodes) {
    if (idMap.has(n.id)) continue;
    if (n.type === 'location' && n.coordinates) {
      const id = `location--${uuid()}`;
      idMap.set(n.id, id);
      objects.push({ type: 'location', spec_version: '2.1', id, created: ts, modified: ts, created_by_ref: identityId, name: n.label, latitude: n.coordinates.lat, longitude: n.coordinates.lng, confidence: n.confidence.total });
      continue;
    }
    const id = `note--${uuid()}`;
    idMap.set(n.id, id);
    const details = Object.entries(n.metadata).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
    objects.push({
      type: 'note',
      spec_version: '2.1',
      id,
      created: ts,
      modified: ts,
      created_by_ref: identityId,
      abstract: `${n.label} (${n.platform})`,
      content: [n.subtitle, n.url, details, ...n.confidence.reasons].filter(Boolean).join('\n'),
      object_refs: [seedRef ?? identityId],
      confidence: n.confidence.total,
    });
  }

  for (const e of osintCase.edges) {
    const s = idMap.get(e.source);
    const t = idMap.get(e.target);
    if (!s || !t || s === t) continue;
    objects.push({ type: 'relationship', spec_version: '2.1', id: `relationship--${uuid()}`, created: ts, modified: ts, created_by_ref: identityId, relationship_type: 'related-to', description: e.relation, source_ref: s, target_ref: t });
  }

  const refs = objects.filter((o) => o.id !== identityId).map((o) => o.id);
  objects.push({
    type: 'grouping',
    spec_version: '2.1',
    id: `grouping--${uuid()}`,
    created: ts,
    modified: ts,
    created_by_ref: identityId,
    name: osintCase.name,
    description: `Semilla: ${osintCase.seedQuery} (${osintCase.seedType})`,
    context: 'unspecified',
    object_refs: refs.length ? refs : [identityId],
  });

  return { type: 'bundle', id: `bundle--${uuid()}`, objects };
}
