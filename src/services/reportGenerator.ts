import { jsPDF } from 'jspdf';
import { InvestigationCase } from '../types/osint';
import { BAND_LABEL, identityBand } from './aliasAndConfidenceEngine';
import { canonicalCaseJson, caseSha256, csvCell, downloadText, fileSafe, safeHttpUrl, sha256Hex } from '../engine/integrity';
import { buildStixBundle } from '../engine/stix';

/** SHA-256 del expediente: el del archivo JSON que descarga «Exportar JSON». */
export const computeCaseSha256 = caseSha256;

const jsonName = (c: InvestigationCase) => `Caso_${fileSafe(c.seedQuery)}_${c.id.slice(-6)}.json`;

const classify = (n: InvestigationCase['nodes'][number]) => {
  if (n.analystReviewed) return n.verifiedStatus === 'verified' ? 'Confirmado por el analista' : n.verifiedStatus === 'false_positive' ? 'Descartado por el analista' : '';
  if (n.evidence) return BAND_LABEL[identityBand(n.confidence.total)];
  return n.type === 'seed' ? 'Semilla' : 'Dato técnico';
};

/**
 * Informe en PDF. Incluye el SHA-256 del JSON del caso: quien reciba el PDF y el JSON
 * puede comprobar que el JSON no se ha tocado.
 */
export async function exportCaseToPdf(osintCase: InvestigationCase): Promise<void> {
  const sha256 = await caseSha256(osintCase);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const width = pageWidth - margin * 2;
  let y = 18;
  const pageBreak = (h = 18) => {
    if (y + h > 280) {
      doc.addPage();
      y = 18;
    }
  };
  const para = (text: string, size = 9, color: [number, number, number] = [51, 65, 85], indent = 0, lh = 4.3) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(text, width - indent) as string[]) {
      pageBreak(6);
      doc.text(line, margin + indent, y);
      y += lh;
    }
  };
  const heading = (text: string) => {
    pageBreak(16);
    y += 3;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(15, 23, 42);
    doc.text(text, margin, y);
    y += 6.5;
  };

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 40, 'F');
  doc.setTextColor(248, 250, 252);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('FANTASMA OSINT — INFORME DE INVESTIGACIÓN', margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(248, 113, 113);
  doc.text('Un Fantasma en el Sistema · https://www.unfantasmaenelsistema.com/', margin, 19.5);
  doc.setTextColor(148, 163, 184);
  doc.text(doc.splitTextToSize(`Caso: ${osintCase.name} · Semilla: ${osintCase.seedQuery} (${osintCase.seedType}) · ${new Date().toISOString().slice(0, 10)}`, width), margin, 26);
  doc.setFont('courier', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(16, 185, 129);
  doc.text(`SHA-256 de ${jsonName(osintCase)}: ${sha256}`, margin, 35);
  y = 48;

  if (osintCase.isDemo) para('CASO DE EJEMPLO CON DATOS FICTICIOS.', 9.5, [185, 28, 28]);
  heading('1. Descripción');
  para(osintCase.description || 'Sin descripción.');
  const hintsText = Object.entries(osintCase.contextHints).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ');
  para(`Pistas del analista: ${hintsText || 'ninguna'}`, 8.5, [71, 85, 105]);

  if (osintCase.aiSummary) {
    heading('2. Resumen');
    para(osintCase.aiSummary);
  }

  heading(`3. Hallazgos (${osintCase.nodes.length})`);
  const sorted = [...osintCase.nodes].sort((a, b) => Number(!!b.evidence) - Number(!!a.evidence) || b.confidence.total - a.confidence.total);
  for (const n of sorted) {
    pageBreak(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.2);
    doc.setTextColor(15, 23, 42);
    for (const line of doc.splitTextToSize(`[${n.confidence.total}/100 · ${classify(n)}] ${n.label} — ${n.platform}`, width) as string[]) {
      pageBreak(6);
      doc.text(line, margin, y);
      y += 4.3;
    }
    const meta = Object.entries(n.metadata).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(' | ');
    para(`${n.confidence.reasons.slice(0, 3).join(' · ')}${meta ? ` — ${meta}` : ''}${n.url ? ` — ${n.url}` : ''}`, 8, [71, 85, 105], 3, 3.9);
    y += 1.5;
  }

  heading(`4. Línea de tiempo (${osintCase.timeline.length})`);
  for (const ev of osintCase.timeline) para(`${ev.date} — ${ev.title} (${ev.sourcePlatform}). ${ev.description}`, 8.5);

  heading(`5. Ubicaciones (${osintCase.locations.length}) y comprobaciones manuales`);
  for (const loc of osintCase.locations) para(`• ${loc.title} [${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}]: ${loc.subtitle}`, 8.5);
  const pending = osintCase.manualTasks.filter((t) => t.status === 'pending');
  const done = osintCase.manualTasks.filter((t) => t.status !== 'pending');
  for (const t of done) para(`• ${t.status === 'verified_hit' ? 'ENCONTRADO' : 'DESCARTADO'} — ${t.platform}: ${t.url}`, 8.5, [180, 83, 9]);
  para(`${pending.length} comprobaciones manuales sin revisar.`, 8.5, [180, 83, 9]);

  heading('Integridad');
  para(`El SHA-256 de la cabecera corresponde al archivo ${jsonName(osintCase)} que genera «Exportar JSON» en este mismo estado del caso. Compruébalo con: sha256sum ${jsonName(osintCase)} (Linux/macOS) o Get-FileHash ${jsonName(osintCase)} (Windows).`, 8.5);

  doc.save(`Informe_OSINT_${fileSafe(osintCase.seedQuery)}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

const esc = (str: unknown) =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Informe HTML autónomo (sin scripts) con el SHA-256 del JSON del caso. */
export async function buildCaseHtml(osintCase: InvestigationCase): Promise<string> {
  const sha256 = await caseSha256(osintCase);
  const sorted = [...osintCase.nodes].sort((a, b) => Number(!!b.evidence) - Number(!!a.evidence) || b.confidence.total - a.confidence.total);
  const cls = (t: number) => (t >= 75 ? 'hi' : t >= 40 ? 'mid' : 'lo');
  const link = (u?: string) => {
    const s = safeHttpUrl(u);
    return s ? `<br><a href="${esc(s)}" rel="noopener noreferrer">${esc(s)}</a>` : '';
  };
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Informe OSINT — ${esc(osintCase.name)}</title>
<style>
body{margin:0;padding:28px 18px;background:#0b1220;color:#e2e8f0;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:21px;margin:0 0 4px}h2{font-size:16px;border-bottom:1px solid #1e293b;padding-bottom:8px}
section,header{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:20px;margin-bottom:18px;overflow-x:auto}
.hash{font:12px ui-monospace,Consolas,monospace;color:#34d399;word-break:break-all}.muted{color:#94a3b8;font-size:12.5px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1e293b;vertical-align:top;overflow-wrap:anywhere}td:last-child{min-width:18rem}
th{color:#94a3b8}.hi{color:#4ade80}.mid{color:#fbbf24}.lo{color:#f87171}td.s{font:700 13px ui-monospace,monospace;white-space:nowrap}a{color:#60a5fa;word-break:break-all}
pre{white-space:pre-wrap;background:#020617;padding:14px;border-radius:8px}.demo{color:#fca5a5;font-weight:700}
@media print{body{background:#fff;color:#0f172a}section,header,pre{background:#fff;border-color:#cbd5e1}}
</style>
</head>
<body><main>
<header>
<h1>${esc(osintCase.name)}</h1>
${osintCase.isDemo ? '<p class="demo">Caso de ejemplo con datos ficticios.</p>' : ''}
<div class="muted">Semilla: <strong>${esc(osintCase.seedQuery)}</strong> (${esc(osintCase.seedType)}) · Generado el ${esc(new Date().toLocaleString('es-ES'))} · <a href="https://www.unfantasmaenelsistema.com/">Un Fantasma en el Sistema</a></div>
<p class="muted">Pistas: ${esc(Object.entries(osintCase.contextHints).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'ninguna')}</p>
<div class="hash">SHA-256 de ${esc(jsonName(osintCase))}: ${sha256}</div>
<p class="muted">Compruébalo con <code>sha256sum ${esc(jsonName(osintCase))}</code> o <code>Get-FileHash ${esc(jsonName(osintCase))}</code> sobre el JSON exportado en este mismo estado.</p>
</header>
${osintCase.aiSummary ? `<section><h2>Resumen</h2><pre>${esc(osintCase.aiSummary)}</pre></section>` : ''}
<section><h2>Hallazgos (${sorted.length})</h2>
<table><thead><tr><th>Puntuación</th><th>Hallazgo</th><th>Fuente</th><th>Clasificación</th><th>Motivos y datos</th></tr></thead><tbody>
${sorted
  .map(
    (n) => `<tr><td class="s ${n.evidence ? cls(n.confidence.total) : ''}">${n.confidence.total}/100</td><td><strong>${esc(n.label)}</strong><br><span class="muted">${esc(n.subtitle)}</span>${link(n.url)}</td><td>${esc(n.platform)}<br><span class="muted">${esc(n.category)}</span></td><td>${esc(classify(n))}</td><td>${esc(n.confidence.reasons.join(' · '))}<br><span class="muted">${esc(Object.entries(n.metadata).map(([k, v]) => `${k}: ${v}`).join(' | '))}</span></td></tr>`
  )
  .join('\n')}
</tbody></table></section>
<section><h2>Línea de tiempo (${osintCase.timeline.length})</h2>
<table><thead><tr><th>Fecha</th><th>Hito</th><th>Fuente</th><th>Detalle</th></tr></thead><tbody>
${osintCase.timeline.map((t) => `<tr><td class="s">${esc(t.date)}</td><td><strong>${esc(t.title)}</strong></td><td>${esc(t.sourcePlatform)}</td><td>${esc(t.description)}</td></tr>`).join('\n')}
</tbody></table></section>
<section><h2>Comprobaciones manuales (${osintCase.manualTasks.length})</h2>
<table><thead><tr><th>Estado</th><th>Sitio</th><th>Enlace</th><th>Nota</th></tr></thead><tbody>
${osintCase.manualTasks.map((t) => `<tr><td>${t.status === 'verified_hit' ? 'Encontrado' : t.status === 'discarded' ? 'Descartado' : 'Pendiente'}</td><td>${esc(t.platform)}</td><td>${link(t.url)}</td><td>${esc(t.notes)}</td></tr>`).join('\n')}
</tbody></table></section>
</main></body></html>
`;
}

export async function exportCaseToHtml(osintCase: InvestigationCase): Promise<void> {
  downloadText(await buildCaseHtml(osintCase), `Informe_OSINT_${fileSafe(osintCase.seedQuery)}.html`, 'text/html;charset=utf-8');
}

/** JSON del caso: exactamente el texto sobre el que se calcula el SHA-256. */
export async function exportCaseToJson(osintCase: InvestigationCase): Promise<string> {
  const text = canonicalCaseJson(osintCase);
  downloadText(text, jsonName(osintCase), 'application/json');
  return sha256Hex(text);
}

export function exportCaseToStix21(osintCase: InvestigationCase): void {
  downloadText(JSON.stringify(buildStixBundle(osintCase), null, 2), `STIX21_${fileSafe(osintCase.seedQuery)}.stix.json`, 'application/json');
}

/** Aristas Origen → Relación → Destino para Maltego y Gephi (celdas protegidas contra fórmulas). */
export function buildMaltegoCsv(osintCase: InvestigationCase): string {
  const rows = ['Source_Entity,Target_Entity,Relationship,Target_Type,Platform,Confidence_Score,Classification,URL'];
  const byId = new Map(osintCase.nodes.map((n) => [n.id, n]));
  for (const e of osintCase.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    rows.push([csvCell(s.label), csvCell(t.label), csvCell(e.relation), csvCell(t.type), csvCell(t.platform), t.confidence.total, csvCell(classify(t)), csvCell(t.url || '')].join(','));
  }
  return rows.join('\n') + '\n';
}

export function exportCaseToMaltegoCsv(osintCase: InvestigationCase): void {
  downloadText('﻿' + buildMaltegoCsv(osintCase), `Maltego_Gephi_${fileSafe(osintCase.seedQuery)}.csv`, 'text/csv;charset=utf-8');
}
