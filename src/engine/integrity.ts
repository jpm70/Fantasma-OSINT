import type { InvestigationCase } from '../types/osint';

/**
 * Sello de integridad del expediente.
 *
 * El SHA-256 se calcula sobre exactamente el mismo texto que se descarga como JSON, así que
 * cualquiera puede comprobarlo con `sha256sum Caso_….json` (o `Get-FileHash` en Windows).
 * Si el JSON se modifica, aunque sea un espacio, el hash deja de coincidir.
 */
export function canonicalCaseJson(osintCase: InvestigationCase): string {
  return JSON.stringify(osintCase, null, 2) + '\n';
}

export async function sha256Hex(text: string | ArrayBuffer): Promise<string> {
  const data = typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function caseSha256(osintCase: InvestigationCase): Promise<string> {
  return sha256Hex(canonicalCaseJson(osintCase));
}

/** Solo enlaces http(s): evita javascript:, data: y similares llegados de fuentes externas. */
export function safeHttpUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Celda CSV segura: comillas escapadas y sin fórmulas (=, +, -, @) que Excel ejecutaría. */
export function csvCell(v: string | number | undefined | null): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function downloadText(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileSafe(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'caso';
}
