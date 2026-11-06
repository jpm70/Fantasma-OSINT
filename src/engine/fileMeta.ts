/**
 * Lectura local de metadatos de un archivo, sin subirlo a ningún sitio.
 *
 * - Tipo real por los primeros bytes (firma o «magic number»), comparado con la extensión.
 * - JPEG: EXIF de IFD0 (fabricante, modelo, software, fecha, autor, copyright), fecha original
 *   de la subIFD Exif y coordenadas GPS si las hay.
 * - PNG: fragmentos de texto tEXt e iTXt (Software, Author, Comment…).
 * - PDF: diccionario Info (/Author, /Creator, /Producer, /CreationDate…) y si contiene XMP.
 *
 * No encontrar metadatos no significa que el archivo esté «limpio»: puede haberlos en
 * formatos que este lector no interpreta.
 */

export interface FileMetaField {
  key: string;
  value: string;
}

export interface FileMetaReport {
  detectedType: string;
  extension: string;
  extensionMatches: boolean | null;
  fields: FileMetaField[];
  gps?: { lat: number; lng: number };
  notes: string[];
}

const SIGNATURES: Array<{ type: string; exts: string[]; test: (b: Uint8Array) => boolean }> = [
  { type: 'JPEG', exts: ['jpg', 'jpeg', 'jpe', 'jfif'], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'PNG', exts: ['png'], test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'GIF', exts: ['gif'], test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { type: 'PDF', exts: ['pdf'], test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { type: 'ZIP / Office (docx, xlsx, pptx)', exts: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'jar', 'apk'], test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  { type: 'WEBP', exts: ['webp'], test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { type: 'Ejecutable Windows (PE)', exts: ['exe', 'dll', 'sys', 'scr'], test: (b) => b[0] === 0x4d && b[1] === 0x5a },
  { type: 'Ejecutable ELF', exts: ['elf', 'so', 'bin', ''], test: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
];

const ascii = (b: Uint8Array, start: number, len: number) => {
  let s = '';
  for (let i = start; i < Math.min(b.length, start + len); i++) s += String.fromCharCode(b[i]);
  return s;
};

// ------------------------------------------------------------------ JPEG / EXIF
const IFD0_TAGS: Record<number, string> = {
  0x010f: 'Fabricante (Make)',
  0x0110: 'Modelo (Model)',
  0x0131: 'Software',
  0x0132: 'Fecha de modificación (DateTime)',
  0x013b: 'Autor (Artist)',
  0x8298: 'Copyright',
  0x010e: 'Descripción (ImageDescription)',
};
const EXIF_TAGS: Record<number, string> = {
  0x9003: 'Fecha original (DateTimeOriginal)',
  0xa434: 'Objetivo (LensModel)',
  0xa431: 'Número de serie de la cámara (BodySerialNumber)',
};

function readExif(b: Uint8Array, report: FileMetaReport) {
  let off = 2;
  while (off + 4 < b.length) {
    if (b[off] !== 0xff) break;
    const marker = b[off + 1];
    const size = (b[off + 2] << 8) | b[off + 3];
    if (marker === 0xe1 && ascii(b, off + 4, 4) === 'Exif') {
      parseTiff(b, off + 10, report);
      return;
    }
    if (marker === 0xda) break; // comienzo de la imagen comprimida
    off += 2 + size;
  }
  report.notes.push('El JPEG no contiene bloque EXIF (APP1).');
}

function parseTiff(b: Uint8Array, base: number, report: FileMetaReport) {
  const le = ascii(b, base, 2) === 'II';
  const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const str = (o: number, n: number) => ascii(b, o, n).replace(/\0+$/, '').trim();
  const rational = (o: number) => {
    const den = u32(o + 4);
    return den ? u32(o) / den : 0;
  };

  const readIfd = (ifdOff: number, tags: Record<number, string>) => {
    const out: { exif?: number; gps?: number } = {};
    const start = base + ifdOff;
    if (start + 2 > b.length) return out;
    const count = u16(start);
    for (let i = 0; i < count; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const valOff = n > 4 || type !== 2 ? base + u32(e + 8) : e + 8;
      if (tag === 0x8769) out.exif = u32(e + 8);
      else if (tag === 0x8825) out.gps = u32(e + 8);
      else if (tags[tag] && type === 2) {
        const v = str(n <= 4 ? e + 8 : valOff, n);
        if (v) report.fields.push({ key: tags[tag], value: v });
      }
    }
    return out;
  };

  if (u16(base + 2) !== 42) {
    report.notes.push('Cabecera TIFF del EXIF no válida.');
    return;
  }
  const ifd0 = readIfd(u32(base + 4), IFD0_TAGS);
  if (ifd0.exif) readIfd(ifd0.exif, EXIF_TAGS);
  if (ifd0.gps) {
    const start = base + ifd0.gps;
    const count = u16(start);
    let latRef = 'N', lngRef = 'E';
    let lat: number | null = null, lng: number | null = null;
    for (let i = 0; i < count; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = u16(e);
      const ptr = base + u32(e + 8);
      if (tag === 1) latRef = String.fromCharCode(b[e + 8]);
      if (tag === 3) lngRef = String.fromCharCode(b[e + 8]);
      if (tag === 2) lat = rational(ptr) + rational(ptr + 8) / 60 + rational(ptr + 16) / 3600;
      if (tag === 4) lng = rational(ptr) + rational(ptr + 8) / 60 + rational(ptr + 16) / 3600;
    }
    if (lat !== null && lng !== null) {
      report.gps = { lat: latRef === 'S' ? -lat : lat, lng: lngRef === 'W' ? -lng : lng };
      report.fields.push({ key: 'Coordenadas GPS', value: `${report.gps.lat.toFixed(6)}, ${report.gps.lng.toFixed(6)}` });
    }
  }
}

// ------------------------------------------------------------------ PNG
function readPng(b: Uint8Array, report: FileMetaReport) {
  let off = 8;
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let found = 0;
  while (off + 12 <= b.length) {
    const len = be32(off);
    const type = ascii(b, off + 4, 4);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'tEXt' || type === 'iTXt') {
      const sep = data.indexOf(0);
      if (sep > 0) {
        const key = ascii(data, 0, sep);
        let value: string;
        if (type === 'tEXt') value = ascii(data, sep + 1, len - sep - 1);
        else {
          // iTXt: clave\0 compresión(1) método(1) idioma\0 clave traducida\0 texto (UTF-8)
          let p = sep + 3;
          p = data.indexOf(0, p) + 1;
          p = data.indexOf(0, p) + 1;
          value = data[sep + 1] === 0 ? new TextDecoder().decode(data.subarray(p)) : '(comprimido)';
        }
        if (key === 'XML:com.adobe.xmp') report.fields.push({ key: 'XMP', value: `${value.length} caracteres de metadatos XMP` });
        else report.fields.push({ key, value: value.slice(0, 300) });
        found++;
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!found) report.notes.push('El PNG no tiene fragmentos de texto (tEXt/iTXt).');
}

// ------------------------------------------------------------------ PDF
function readPdf(b: Uint8Array, report: FileMetaReport) {
  const text = ascii(b, 0, b.length);
  const keys: Record<string, string> = { Title: 'Título', Author: 'Autor', Subject: 'Asunto', Creator: 'Aplicación de origen (Creator)', Producer: 'Generador del PDF (Producer)', CreationDate: 'Fecha de creación', ModDate: 'Fecha de modificación' };
  let found = 0;
  for (const [k, label] of Object.entries(keys)) {
    const m = text.match(new RegExp(`/${k}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`));
    if (m && m[1].trim()) {
      let v = m[1].replace(/\\([()\\])/g, '$1');
      const d = v.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
      if (d) v = `${d[1]}-${d[2]}-${d[3]}${d[4] ? ` ${d[4]}:${d[5] ?? '00'}` : ''}`;
      report.fields.push({ key: label, value: v.slice(0, 300) });
      found++;
    }
  }
  if (/<x:xmpmeta|<\?xpacket/.test(text)) report.fields.push({ key: 'XMP', value: 'Contiene un bloque de metadatos XMP' });
  if (!found) report.notes.push('No se ha encontrado el diccionario Info sin comprimir (puede estar en un flujo comprimido).');
}

export function analyzeFileBytes(bytes: Uint8Array, fileName: string): FileMetaReport {
  const extension = (fileName.includes('.') ? fileName.split('.').pop()! : '').toLowerCase();
  const sig = SIGNATURES.find((s) => s.test(bytes));
  const report: FileMetaReport = {
    detectedType: sig?.type ?? 'Desconocido',
    extension,
    extensionMatches: sig ? sig.exts.includes(extension) : null,
    fields: [],
    notes: [],
  };
  if (sig && report.extensionMatches === false) {
    report.notes.push(`La extensión .${extension || '(ninguna)'} no corresponde al contenido real (${sig.type}).`);
  }
  if (sig?.type === 'JPEG') readExif(bytes, report);
  else if (sig?.type === 'PNG') readPng(bytes, report);
  else if (sig?.type === 'PDF') readPdf(bytes, report);
  else if (sig) report.notes.push(`Este lector no interpreta los metadatos de ${sig.type}.`);
  else report.notes.push('No se reconoce la firma del archivo.');
  return report;
}
