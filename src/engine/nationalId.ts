/**
 * Validación de la letra de control del DNI, el NIE y los NIF especiales K, L y M.
 *
 * La letra es el resto de dividir el número entre 23, buscado en TRWAGMYFPDXBNJZSQVHLCKE.
 * En el NIE la X, la Y y la Z valen 0, 1 y 2 delante de las siete cifras. En los NIF K, L y M
 * la letra inicial no cuenta y se usan solo las siete cifras.
 *
 * Una letra correcta solo dice que el número está bien formado, no que exista ni a quién pertenece.
 */

const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

export interface NationalIdResult {
  normalized: string;
  kind: 'DNI' | 'NIE' | 'NIF especial (K/L/M)' | 'desconocido';
  valid: boolean;
  expectedLetter: string | null;
}

export function controlLetter(num: number): string {
  return LETTERS[num % 23];
}

export function validateSpanishId(raw: string): NationalIdResult {
  const id = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let num: number | null = null;
  let kind: NationalIdResult['kind'] = 'desconocido';
  if (/^\d{8}[A-Z]$/.test(id)) {
    num = parseInt(id.slice(0, 8), 10);
    kind = 'DNI';
  } else if (/^[XYZ]\d{7}[A-Z]$/.test(id)) {
    num = parseInt('XYZ'.indexOf(id[0]) + id.slice(1, 8), 10);
    kind = 'NIE';
  } else if (/^[KLM]\d{7}[A-Z]$/.test(id)) {
    num = parseInt(id.slice(1, 8), 10);
    kind = 'NIF especial (K/L/M)';
  }
  if (num === null) return { normalized: id, kind, valid: false, expectedLetter: null };
  const expected = controlLetter(num);
  return { normalized: id, kind, valid: expected === id[8], expectedLetter: expected };
}
