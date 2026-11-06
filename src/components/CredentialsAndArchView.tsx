import React, { useEffect, useState } from 'react';
import { ApiCredentials, EntityType, InvestigationCase } from '../types/osint';
import { DEFAULT_CREDENTIALS, forgetVault, hasStoredVault, saveSecretsToVault, saveSettings, unlockVault } from '../services/storageService';
import { computeCaseSha256, exportCaseToJson, exportCaseToMaltegoCsv, exportCaseToStix21 } from '../services/reportGenerator';
import { sha256Hex } from '../engine/integrity';
import { analyzeFileBytes, FileMetaReport } from '../engine/fileMeta';
import { AlertTriangle, CheckCircle2, Download, Eye, EyeOff, FileCheck2, Hash, KeyRound, Lock, PlusCircle, Save, Share2, ShieldCheck, Trash2, Unlock, UploadCloud } from 'lucide-react';

interface CredentialsAndArchViewProps {
  credentials: ApiCredentials;
  activeCase: InvestigationCase;
  legacyNotice: string | null;
  onCredentialsChange: (creds: ApiCredentials) => void;
  onAddForensicNode: (label: string, type: EntityType, platform: string, relationToSeed: string, metadata?: Record<string, string>) => void;
}

interface InspectedFile {
  name: string;
  size: number;
  mime: string;
  lastModified: string;
  sha256: string;
  meta: FileMetaReport;
}

const KEY_FIELDS: Array<{ key: keyof ApiCredentials; label: string; placeholder: string; note: string }> = [
  { key: 'openAiKey', label: 'OpenAI (resumen con IA)', placeholder: 'sk-…', note: 'Directo a api.openai.com. Los datos del caso se envían a OpenAI al pedir el resumen.' },
  { key: 'hunterKey', label: 'Hunter.io', placeholder: 'clave de Hunter', note: 'Va en la URL, solo hacia api.hunter.io.' },
  { key: 'serperKey', label: 'Serper.dev (búsqueda web)', placeholder: 'X-API-KEY', note: 'Directo a google.serper.dev.' },
  { key: 'hibpKey', label: 'Have I Been Pwned', placeholder: 'hibp-api-key', note: 'Sin CORS: solo con proxy propio y permiso para enviar claves.' },
  { key: 'virusTotalKey', label: 'VirusTotal v3', placeholder: 'x-apikey', note: 'Sin CORS: solo con proxy propio y permiso para enviar claves.' },
  { key: 'urlScanKey', label: 'URLScan.io', placeholder: 'API-Key', note: 'Sin CORS: solo con proxy propio y permiso para enviar claves.' },
];

export const CredentialsAndArchView: React.FC<CredentialsAndArchViewProps> = ({ credentials, activeCase, legacyNotice, onCredentialsChange, onAddForensicNode }) => {
  const [form, setForm] = useState<ApiCredentials>({ ...credentials });
  const [showSecrets, setShowSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [vaultExists, setVaultExists] = useState(hasStoredVault());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [caseSha, setCaseSha] = useState('Calculando…');
  const [file, setFile] = useState<InspectedFile | null>(null);

  useEffect(() => setForm({ ...credentials }), [credentials]);
  useEffect(() => {
    computeCaseSha256(activeCase).then(setCaseSha);
  }, [activeCase]);

  const flash = (ok: boolean, text: string) => setMessage({ ok, text });

  const applySession = () => {
    saveSettings(form);
    onCredentialsChange(form);
    flash(true, 'Guardado para esta sesión. Las claves están solo en memoria y se pierden al cerrar la pestaña.');
  };

  const saveEncrypted = async () => {
    if (passphrase.length < 10) return flash(false, 'La frase de paso debe tener al menos 10 caracteres.');
    setBusy(true);
    try {
      saveSettings(form);
      await saveSecretsToVault(form, passphrase);
      onCredentialsChange(form);
      setVaultExists(true);
      setPassphrase('');
      flash(true, 'Claves cifradas con AES-GCM y guardadas en este navegador. Para recuperarlas hará falta la frase.');
    } catch {
      flash(false, 'No se pudo cifrar (¿navegador sin Web Crypto?).');
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    try {
      const secrets = await unlockVault(passphrase);
      const merged = { ...form, ...secrets };
      setForm(merged);
      onCredentialsChange(merged);
      setPassphrase('');
      flash(true, 'Bóveda abierta: claves cargadas en esta sesión.');
    } catch {
      flash(false, 'Frase incorrecta o bóveda dañada.');
    } finally {
      setBusy(false);
    }
  };

  const forget = () => {
    if (!window.confirm('¿Borrar la bóveda cifrada de este navegador? Las claves en memoria se mantienen hasta cerrar la pestaña.')) return;
    forgetVault();
    setVaultExists(false);
    flash(true, 'Bóveda borrada de este navegador.');
  };

  const clearAll = () => {
    const reset = { ...DEFAULT_CREDENTIALS };
    setForm(reset);
    saveSettings(reset);
    onCredentialsChange(reset);
    flash(true, 'Claves y ajustes restablecidos en esta sesión.');
  };

  const inspect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const buf = await f.arrayBuffer();
    setFile({
      name: f.name,
      size: f.size,
      mime: f.type || 'desconocido',
      lastModified: new Date(f.lastModified).toISOString().slice(0, 19).replace('T', ' '),
      sha256: await sha256Hex(buf),
      meta: analyzeFileBytes(new Uint8Array(buf), f.name),
    });
  };

  const proxySet = !!form.corsProxy.trim();
  const inputCls = 'w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-red-500';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Integridad e inspector de archivos */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 min-w-0">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <FileCheck2 className="w-4 h-4 text-red-400 shrink-0" />
            <h3 className="text-base font-semibold text-white">Integridad del caso e inspector de archivos</h3>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 space-y-2">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5 text-emerald-400" />
              SHA-256 del JSON del caso en su estado actual:
            </div>
            <div className="font-mono text-xs text-emerald-300 break-all select-all">{caseSha}</div>
            <p className="text-[11px] text-slate-400">
              Es el hash del archivo que descarga «JSON». Cualquiera puede comprobarlo con <code className="text-slate-300">sha256sum</code> o <code className="text-slate-300">Get-FileHash</code>: si alguien cambia el JSON, deja de coincidir.
            </p>
            <button type="button" onClick={() => exportCaseToJson(activeCase)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">
              <Download className="w-3.5 h-3.5" />
              Descargar el JSON
            </button>
          </div>

          <label className="flex flex-col items-center justify-center p-4 border border-dashed border-slate-700 hover:border-red-500/60 bg-slate-950/60 rounded-lg cursor-pointer text-center">
            <UploadCloud className="w-6 h-6 text-red-400 mb-1.5" />
            <span className="text-xs font-medium text-slate-200">Inspeccionar un archivo (imagen, PDF, documento)</span>
            <span className="text-[11px] text-slate-400 mt-0.5">SHA-256, tipo real por su firma y metadatos EXIF, PNG o PDF. El archivo no sale de tu equipo.</span>
            <input type="file" onChange={inspect} className="sr-only" aria-label="Archivo a inspeccionar" />
          </label>

          {file && (
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 space-y-2 text-xs" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-white break-all">{file.name}</span>
                <span className="font-mono text-slate-400">{(file.size / 1024).toFixed(1)} KB · {file.mime}</span>
              </div>
              <div className="font-mono text-[11px] text-emerald-400 break-all">SHA-256: {file.sha256}</div>
              <div className="text-slate-300">
                Tipo real: <strong>{file.meta.detectedType}</strong>
                {file.meta.extensionMatches === false && <span className="text-amber-400"> · no coincide con la extensión .{file.meta.extension}</span>}
              </div>
              <div className="text-slate-400">Modificado (según el sistema de archivos): <span className="font-mono text-slate-200">{file.lastModified}</span></div>
              {file.meta.fields.length > 0 ? (
                <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-3 gap-y-1 pt-1">
                  {file.meta.fields.map((f, i) => (
                    <React.Fragment key={i}>
                      <dt className="text-slate-400">{f.key}</dt>
                      <dd className="font-mono text-slate-200 break-all">{f.value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              ) : (
                <p className="text-slate-400">No se han encontrado metadatos que este lector sepa interpretar.</p>
              )}
              {file.meta.gps && <p className="text-amber-300">La foto lleva coordenadas GPS: revela dónde se tomó.</p>}
              {file.meta.notes.map((n, i) => (
                <p key={i} className="text-[11px] text-slate-400">{n}</p>
              ))}
              <button
                type="button"
                onClick={() =>
                  onAddForensicNode(`Archivo: ${file.name}`, 'evidence_file', 'Inspector de archivos', 'evidencia', {
                    sha256: file.sha256,
                    tipoReal: file.meta.detectedType,
                    ...Object.fromEntries(file.meta.fields.slice(0, 8).map((f) => [f.key, f.value])),
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                Añadir al grafo como evidencia
              </button>
            </div>
          )}
        </div>

        {/* Exportación CTI */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 min-w-0">
          <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
            <Share2 className="w-4 h-4 text-red-400 shrink-0" />
            <h3 className="text-base font-semibold text-white">Exportar a herramientas CTI</h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            STIX 2.1 válido (identificadores UUID, observables, ubicaciones, notas y relaciones) para importar en OpenCTI o MISP, y una tabla de aristas para Maltego o Gephi.
          </p>
          <button type="button" onClick={() => exportCaseToStix21(activeCase)} className="w-full flex items-center justify-between px-4 py-3 bg-slate-950 hover:bg-slate-800/80 border border-slate-800 rounded-lg text-left">
            <div>
              <div className="text-xs font-semibold text-white">Bundle STIX 2.1 (.stix.json)</div>
              <div className="text-[11px] text-slate-400">OpenCTI, MISP</div>
            </div>
            <Download className="w-4 h-4 text-red-400 shrink-0" />
          </button>
          <button type="button" onClick={() => exportCaseToMaltegoCsv(activeCase)} className="w-full flex items-center justify-between px-4 py-3 bg-slate-950 hover:bg-slate-800/80 border border-slate-800 rounded-lg text-left">
            <div>
              <div className="text-xs font-semibold text-white">Aristas para Maltego y Gephi (.csv)</div>
              <div className="text-[11px] text-slate-400">Origen → relación → destino, con puntuación</div>
            </div>
            <Download className="w-4 h-4 text-sky-400 shrink-0" />
          </button>
        </div>
      </div>

      {/* Claves y proxy */}
      <form onSubmit={(e) => { e.preventDefault(); applySession(); }} className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-red-400 shrink-0" />
              <h3 className="text-base font-semibold text-white">Claves de API y proxy propio</h3>
            </div>
            <p className="text-xs text-slate-400">Todo es opcional: sin claves funcionan GitHub, GitLab, Keybase, Bluesky, Mastodon, RDAP, DNS, Cert Spotter, Shodan InternetDB, RIPE Stat, XposedOrNot y OpenPGP.</p>
          </div>
          <button type="button" onClick={() => setShowSecrets(!showSecrets)} aria-pressed={showSecrets} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">
            {showSecrets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showSecrets ? 'Ocultar claves' : 'Mostrar claves'}
          </button>
        </div>

        {legacyNotice && (
          <div role="status" className="bg-amber-950/40 border border-amber-700/50 rounded-lg p-3 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{legacyNotice}</span>
          </div>
        )}

        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
          <label htmlFor="proxy" className="block text-xs font-semibold text-slate-200">Proxy CORS propio (opcional)</label>
          <input id="proxy" type="url" value={form.corsProxy} onChange={(e) => setForm({ ...form, corsProxy: e.target.value })} placeholder="https://mi-proxy.example.workers.dev/?url=" className={inputCls} />
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Muchos sitios no dejan que una web los consulte (CORS). Un proxy que controles tú (por ejemplo un Cloudflare Worker) permite sondearlos. La URL de destino se añade codificada al final, o donde pongas <code>{'{url}'}</code>. Los proxies públicos gratuitos que usaba la versión anterior ya no funcionan sin registro, y quien gestiona un proxy ve todas las peticiones.
          </p>
          <label className="flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.useCorsProxyForSherlock} onChange={(e) => setForm({ ...form, useCorsProxyForSherlock: e.target.checked })} disabled={!proxySet} className="accent-red-500 mt-0.5" />
            Sondear por el proxy los sitios del catálogo sin CORS
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.allowKeysThroughProxy} onChange={(e) => setForm({ ...form, allowKeysThroughProxy: e.target.checked })} disabled={!proxySet} className="accent-red-500 mt-0.5" />
            <span>Enviar por el proxy las claves de HIBP, VirusTotal y URLScan <span className="text-amber-300">(solo si el proxy es tuyo: quien lo gestione podrá leerlas)</span></span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {KEY_FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={`k-${f.key}`} className="block text-xs text-slate-300 mb-1">{f.label}</label>
              <input id={`k-${f.key}`} type={showSecrets ? 'text' : 'password'} autoComplete="off" value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} placeholder={f.placeholder} className={inputCls} />
              <p className="text-[11px] text-slate-500 mt-1">{f.note}</p>
            </div>
          ))}
          <div>
            <label htmlFor="k-model" className="block text-xs text-slate-300 mb-1">Modelo de OpenAI</label>
            <select id="k-model" value={form.openAiModel} onChange={(e) => setForm({ ...form, openAiModel: e.target.value })} className={inputCls}>
              <option value="gpt-4o-mini">gpt-4o-mini</option>
              <option value="gpt-4o">gpt-4o</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800">
          <button type="button" onClick={clearAll} className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-white">
            <Trash2 className="w-3.5 h-3.5" />
            Restablecer
          </button>
          <button type="submit" className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg">
            <Save className="w-3.5 h-3.5" />
            Usar en esta sesión
          </button>
        </div>

        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <Lock className="w-3.5 h-3.5 text-emerald-400" />
            Bóveda cifrada en este navegador {vaultExists ? '(hay una guardada)' : '(vacía)'}
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Las claves se cifran con AES-GCM de 256 bits y una clave derivada de tu frase con PBKDF2-SHA-256 (310 000 iteraciones). Sin la frase no se pueden recuperar, ni siquiera desde el código de la página.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <label htmlFor="passphrase" className="sr-only">Frase de paso</label>
            <input id="passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Frase de paso (mínimo 10 caracteres)" className={inputCls} />
            <button type="button" disabled={busy} onClick={saveEncrypted} className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg disabled:opacity-50 whitespace-nowrap">
              <ShieldCheck className="w-3.5 h-3.5" />
              Cifrar y guardar
            </button>
            {vaultExists && (
              <button type="button" disabled={busy || !passphrase} onClick={unlock} className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg disabled:opacity-50 whitespace-nowrap">
                <Unlock className="w-3.5 h-3.5" />
                Abrir bóveda
              </button>
            )}
            {vaultExists && (
              <button type="button" onClick={forget} className="px-3 py-2 text-xs text-slate-400 hover:text-red-400 whitespace-nowrap">Borrar bóveda</button>
            )}
          </div>
        </div>

        {message && (
          <p role="status" className={`text-xs flex items-center gap-1.5 ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {message.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            {message.text}
          </p>
        )}
      </form>
    </div>
  );
};
