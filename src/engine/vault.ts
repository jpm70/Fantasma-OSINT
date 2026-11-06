/**
 * Bóveda de claves de API cifrada con una frase de paso (Web Crypto).
 *
 * PBKDF2-SHA-256 con 310 000 iteraciones y sal aleatoria deriva una clave AES-GCM de 256 bits;
 * cada guardado usa un IV nuevo. Sin la frase no se puede descifrar: no hay ninguna clave
 * escrita en el código. La versión 1 solo hacía XOR con una cadena fija del propio código
 * (ofuscación, no cifrado); legacyXorDecode existe solo para migrar esas bóvedas.
 */

export const PBKDF2_ITERATIONS = 310_000;

export interface VaultBlob {
  v: 2;
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptVault(plainText: string, passphrase: string, iterations = PBKDF2_ITERATIONS): Promise<VaultBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainText)));
  return { v: 2, kdf: 'PBKDF2-SHA-256', iterations, salt: b64(salt), iv: b64(iv), ciphertext: b64(ct) };
}

/** Lanza un error si la frase es incorrecta o el contenido se ha alterado (AES-GCM lo detecta). */
export async function decryptVault(blob: VaultBlob, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, unb64(blob.salt), blob.iterations);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) as BufferSource }, key, unb64(blob.ciphertext) as BufferSource);
  return new TextDecoder().decode(pt);
}

export function isVaultBlob(x: unknown): x is VaultBlob {
  const o = x as VaultBlob;
  return !!o && o.v === 2 && typeof o.salt === 'string' && typeof o.iv === 'string' && typeof o.ciphertext === 'string' && Number.isFinite(o.iterations);
}

/** Lee una bóveda de la versión 1 (XOR con una cadena fija). Solo para migrarla. */
export function legacyXorDecode(cipherText: string): string | null {
  const SALT = 'UN_FANTASMA_EN_EL_SISTEMA_OSINT_2026';
  try {
    const raw = atob(cipherText);
    let out = '';
    for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ SALT.charCodeAt(i % SALT.length));
    return decodeURIComponent(out);
  } catch {
    return null;
  }
}
