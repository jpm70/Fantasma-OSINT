import { jsPDF } from 'jspdf';
import { InvestigationCase } from '../types/osint';

/**
 * Computes a cryptographic SHA-256 hash of the investigation case for forensic Chain of Custody.
 */
export async function computeCaseSha256(osintCase: InvestigationCase): Promise<string> {
  try {
    const canonical = JSON.stringify({
      id: osintCase.id,
      seedQuery: osintCase.seedQuery,
      seedType: osintCase.seedType,
      nodes: osintCase.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        type: n.type,
        platform: n.platform,
        score: n.confidence.total,
      })),
      edges: osintCase.edges,
      timeline: osintCase.timeline,
    });
    const encoder = new TextEncoder();
    const data = encoder.encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'sha256-unavailable-in-non-secure-context';
  }
}

/**
 * Exports the entire OSINT case as a multi-section PDF using jsPDF (100% Client-Side),
 * including the cryptographic Chain of Custody SHA-256 digest.
 */
export async function exportCaseToPdf(osintCase: InvestigationCase): Promise<void> {
  const sha256 = await computeCaseSha256(osintCase);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 18;

  const checkPageBreak = (neededHeight = 18) => {
    if (y + neededHeight > 278) {
      doc.addPage();
      y = 18;
    }
  };

  // Header Banner
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 38, 'F');
  doc.setTextColor(248, 250, 252);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15.5);
  doc.text('FANTASMA OSINT — INFORME PERICIAL DE INTELIGENCIA', margin, 13);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(248, 113, 113);
  doc.text('Un Fantasma en el Sistema | https://www.unfantasmaenelsistema.com/', margin, 19.5);

  doc.setTextColor(148, 163, 184);
  doc.text(
    `Caso ID: ${osintCase.id}  |  Semilla: ${osintCase.seedQuery} (${osintCase.seedType.toUpperCase()})  |  Fecha: ${new Date().toISOString().slice(0, 10)}`,
    margin,
    26
  );

  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(16, 185, 129);
  doc.text(`SHA-256 Custodia: ${sha256}`, margin, 32.5);

  y = 46;

  // Section 1: Case Metadata
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`1. Ficha del Expediente: ${osintCase.name}`, margin, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(51, 65, 85);
  const descLines = doc.splitTextToSize(osintCase.description || 'Sin descripción adicional.', pageWidth - margin * 2);
  doc.text(descLines, margin, y);
  y += descLines.length * 4.8 + 4;

  // Section 2: Executive AI / Heuristic Summary
  if (osintCase.aiSummary) {
    checkPageBreak(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(15, 23, 42);
    doc.text('2. Sintesis Ejecutiva de Inteligencia', margin, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85);
    const sumLines = doc.splitTextToSize(osintCase.aiSummary, pageWidth - margin * 2);
    for (const line of sumLines) {
      checkPageBreak(6);
      doc.text(line, margin, y);
      y += 4.5;
    }
    y += 4;
  }

  // Section 3: Discovered Entities & Confidence Scoring (0-100)
  checkPageBreak(24);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`3. Nodos de Evidencia y Puntuacion de Confianza (${osintCase.nodes.length})`, margin, y);
  y += 7;

  const sortedNodes = [...osintCase.nodes].sort((a, b) => b.confidence.total - a.confidence.total);
  for (const node of sortedNodes) {
    checkPageBreak(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(
      `[${node.confidence.total}/100] ${node.label} — ${node.platform} (${node.category})`,
      margin,
      y
    );
    y += 4.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    const reasonStr = node.confidence.reasons[0] || 'Hallazgo correlacionado en el grafo.';
    const metaPairs = Object.entries(node.metadata)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    const detailLines = doc.splitTextToSize(
      `Motivo Score: ${reasonStr}${metaPairs ? ` — Datos: ${metaPairs}` : ''}`,
      pageWidth - margin * 2
    );
    doc.text(detailLines, margin + 3, y);
    y += detailLines.length * 4.2 + 2.5;
  }

  // Section 4: Chronological Timeline
  checkPageBreak(22);
  y += 3;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`4. Linea de Tiempo Cronologica (${osintCase.timeline.length} eventos)`, margin, y);
  y += 6.5;

  for (const ev of osintCase.timeline) {
    checkPageBreak(12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(`${ev.date} — ${ev.title} (${ev.sourcePlatform})`, margin, y);
    y += 4.2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    const evLines = doc.splitTextToSize(ev.description, pageWidth - margin * 2);
    doc.text(evLines, margin + 3, y);
    y += evLines.length * 4.2 + 2;
  }

  // Section 5: Geographic Locations & Manual Tasks
  checkPageBreak(22);
  y += 3;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  doc.setTextColor(15, 23, 42);
  doc.text(`5. Geolocalizacion (${osintCase.locations.length}) y Tareas Manuales (${osintCase.manualTasks.length})`, margin, y);
  y += 6.5;

  for (const loc of osintCase.locations) {
    checkPageBreak(10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(51, 65, 85);
    doc.text(
      `• [GEO ${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}] ${loc.title}: ${loc.subtitle} (Confianza: ${loc.confidence}%)`,
      margin,
      y
    );
    y += 4.8;
  }

  for (const task of osintCase.manualTasks.slice(0, 10)) {
    checkPageBreak(10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(180, 83, 9);
    doc.text(`• [${task.reason}] ${task.platform}: ${task.url} (${task.status})`, margin, y);
    y += 4.8;
  }

  const filename = `Reporte_OSINT_${osintCase.seedQuery.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
  doc.save(filename);
}

/**
 * Exports a complete, standalone Static HTML5 Report with embedded styles, Chain of Custody SHA-256, and branding.
 */
export async function exportCaseToHtml(osintCase: InvestigationCase): Promise<void> {
  const sha256 = await computeCaseSha256(osintCase);
  const sortedNodes = [...osintCase.nodes].sort((a, b) => b.confidence.total - a.confidence.total);
  const escapeHtml = (str: string) =>
    String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reporte Pericial OSINT — ${escapeHtml(osintCase.name)}</title>
  <style>
    :root {
      --bg: #090d16;
      --surface: #0f172a;
      --border: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 20px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
    }
    .container { max-width: 1120px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 24px;
    }
    header h1 { margin: 0 0 6px 0; font-size: 22px; }
    header a { color: #f87171; text-decoration: none; font-weight: 600; }
    .hash-bar {
      font-family: monospace;
      font-size: 12px;
      background: #020617;
      border: 1px solid #1e293b;
      color: #34d399;
      padding: 10px 14px;
      border-radius: 8px;
      margin-bottom: 24px;
      word-break: break-all;
    }
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    h2 { margin-top: 0; font-size: 17px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    .score { font-family: monospace; font-weight: 700; }
    .score-high { color: #4ade80; }
    .score-med { color: #fbbf24; }
    .score-low { color: #f87171; }
    pre { white-space: pre-wrap; background: #020617; padding: 16px; border-radius: 8px; border: 1px solid var(--border); font-size: 13px; }
    @media print {
      body { background: #fff; color: #0f172a; padding: 0; }
      header, .section, pre, .hash-bar { background: #fff; border-color: #cbd5e1; color: #0f172a; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${escapeHtml(osintCase.name)}</h1>
        <div style="color: var(--muted); font-size: 13px;">
          Semilla: <strong>${escapeHtml(osintCase.seedQuery)}</strong> (${escapeHtml(osintCase.seedType.toUpperCase())}) · 
          Generado: ${new Date().toLocaleString('es-ES')} · 
          Plataforma <a href="https://www.unfantasmaenelsistema.com/" target="_blank" rel="noopener">Un Fantasma en el Sistema</a>
        </div>
      </div>
      <button onclick="window.print()" style="background:#ef4444;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:600;">
        Imprimir / Guardar PDF
      </button>
    </header>

    <div class="hash-bar">
      SELLO DE CADENA DE CUSTODIA DIGITAL (SHA-256): ${sha256}
    </div>

    ${
      osintCase.aiSummary
        ? `<div class="section">
            <h2>Síntesis Ejecutiva de Inteligencia</h2>
            <pre>${escapeHtml(osintCase.aiSummary)}</pre>
          </div>`
        : ''
    }

    <div class="section">
      <h2>Entidades Descubiertas y Puntuación de Confianza (${sortedNodes.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Confianza</th>
            <th>Entidad / Hallazgo</th>
            <th>Plataforma / Categoría</th>
            <th>Familia de Alias</th>
            <th>Justificación y Metadatos</th>
          </tr>
        </thead>
        <tbody>
          ${sortedNodes
            .map(
              (n) => `<tr>
                <td class="score ${n.confidence.total >= 75 ? 'score-high' : n.confidence.total >= 50 ? 'score-med' : 'score-low'}">${n.confidence.total}/100</td>
                <td>
                  <strong>${escapeHtml(n.label)}</strong><br/>
                  <span style="color:var(--muted);font-size:12px;">${escapeHtml(n.subtitle || '')}</span>
                  ${n.url ? `<br/><a href="${escapeHtml(n.url)}" target="_blank" style="color:#60a5fa;font-size:12px;">${escapeHtml(n.url)}</a>` : ''}
                </td>
                <td>${escapeHtml(n.platform)}<br/><span style="color:var(--muted);font-size:12px;">${escapeHtml(n.category)}</span></td>
                <td>${escapeHtml(n.aliasFamily)}</td>
                <td>
                  <div style="margin-bottom:4px;">${escapeHtml(n.confidence.reasons.join(' · '))}</div>
                  <div style="color:var(--muted);font-family:monospace;font-size:11px;">
                    ${escapeHtml(
                      Object.entries(n.metadata)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' | ')
                    )}
                  </div>
                </td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Línea de Tiempo Cronológica (${osintCase.timeline.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Hito / Evento</th>
            <th>Fuente</th>
            <th>Confianza</th>
            <th>Detalle</th>
          </tr>
        </thead>
        <tbody>
          ${osintCase.timeline
            .map(
              (t) => `<tr>
                <td style="font-family:monospace;white-space:nowrap;">${escapeHtml(t.date)}</td>
                <td><strong>${escapeHtml(t.title)}</strong></td>
                <td>${escapeHtml(t.sourcePlatform)}</td>
                <td class="score">${t.confidence}/100</td>
                <td>${escapeHtml(t.description)}</td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Reporte_OSINT_${osintCase.seedQuery.replace(/[^a-z0-9]/gi, '_')}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exports the raw case JSON for backup or sharing between analysts.
 */
export function exportCaseToJson(osintCase: InvestigationCase): void {
  const blob = new Blob([JSON.stringify(osintCase, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Caso_OSINT_${osintCase.seedQuery.replace(/[^a-z0-9]/gi, '_')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exports the OSINT Case as an OASIS STIX 2.1 Cyber Threat Intelligence Bundle (.stix.json)
 * compatible with OpenCTI, MISP, and TheHive.
 */
export function exportCaseToStix21(osintCase: InvestigationCase): void {
  const nowIso = new Date().toISOString();
  const identityAuthorId = 'identity--fantasma-osint-system-0001';

  const objects: any[] = [
    {
      type: 'identity',
      spec_version: '2.1',
      id: identityAuthorId,
      created: nowIso,
      modified: nowIso,
      name: 'Fantasma OSINT — Un Fantasma en el Sistema',
      identity_class: 'organization',
      contact_information: 'https://www.unfantasmaenelsistema.com/',
    },
  ];

  const nodeStixIdMap = new Map<string, string>();

  osintCase.nodes.forEach((n, idx) => {
    const stixType =
      n.type === 'ip'
        ? 'ipv4-addr'
        : n.type === 'domain' || n.type === 'subdomain'
        ? 'domain-name'
        : n.type === 'email'
        ? 'email-addr'
        : 'user-account';

    const stixId = `${stixType}--${osintCase.id.replace(/[^a-z0-9]/gi, '')}-${idx + 1000}`;
    nodeStixIdMap.set(n.id, stixId);

    objects.push({
      type: stixType,
      spec_version: '2.1',
      id: stixId,
      value: n.label,
      confidence: n.confidence.total,
      labels: [n.platform, n.category, n.aliasFamily, n.verifiedStatus],
      extensions: {
        'x-fantasma-osint': {
          url: n.url || null,
          reasons: n.confidence.reasons,
          metadata: n.metadata,
        },
      },
    });
  });

  osintCase.edges.forEach((e, idx) => {
    const sourceRef = nodeStixIdMap.get(e.source);
    const targetRef = nodeStixIdMap.get(e.target);
    if (sourceRef && targetRef) {
      objects.push({
        type: 'relationship',
        spec_version: '2.1',
        id: `relationship--${osintCase.id.replace(/[^a-z0-9]/gi, '')}-${idx + 5000}`,
        created: nowIso,
        modified: nowIso,
        relationship_type: e.relation,
        source_ref: sourceRef,
        target_ref: targetRef,
        created_by_ref: identityAuthorId,
      });
    }
  });

  const bundle = {
    type: 'bundle',
    id: `bundle--fantasma-osint-${Date.now()}`,
    objects,
  };

  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `STIX21_${osintCase.seedQuery.replace(/[^a-z0-9]/gi, '_')}.stix.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exports the OSINT Graph to CSV format compatible with Maltego & Gephi.
 */
export function exportCaseToMaltegoCsv(osintCase: InvestigationCase): void {
  const rows: string[] = [
    'Source_Entity,Target_Entity,Relationship,Target_Type,Platform,Confidence_Score,Verified_Status,URL',
  ];

  const nodeMap = new Map(osintCase.nodes.map((n) => [n.id, n]));
  const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  for (const edge of osintCase.edges) {
    const s = nodeMap.get(edge.source);
    const t = nodeMap.get(edge.target);
    if (!s || !t) continue;
    rows.push(
      [
        esc(s.label),
        esc(t.label),
        esc(edge.relation),
        esc(t.type),
        esc(t.platform),
        t.confidence.total,
        esc(t.verifiedStatus),
        esc(t.url || ''),
      ].join(',')
    );
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Maltego_Gephi_${osintCase.seedQuery.replace(/[^a-z0-9]/gi, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
