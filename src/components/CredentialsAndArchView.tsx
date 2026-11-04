import React, { useEffect, useState } from 'react';
import { ApiCredentials, EntityType, InvestigationCase } from '../types/osint';
import { DEFAULT_CREDENTIALS } from '../services/storageService';
import {
  computeCaseSha256,
  exportCaseToMaltegoCsv,
  exportCaseToStix21,
} from '../services/reportGenerator';
import graphScreenshot from '../assets/images/screenshot_osint_graph_1793787569041.jpg';
import geoScreenshot from '../assets/images/screenshot_geo_timeline_1793787571747.jpg';
import matrixScreenshot from '../assets/images/screenshot_confidence_matrix_1793787570045.jpg';
import {
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCheck2,
  FolderGit2,
  Hash,
  Image as ImageIcon,
  KeyRound,
  PlusCircle,
  RotateCcw,
  Save,
  Share2,
  ShieldCheck,
  Terminal,
  UploadCloud,
} from 'lucide-react';

interface CredentialsAndArchViewProps {
  credentials: ApiCredentials;
  activeCase: InvestigationCase;
  onSaveCredentials: (creds: ApiCredentials) => void;
  onAddForensicNode: (label: string, type: EntityType, platform: string, relationToSeed: string) => void;
}

interface ForensicFileAnalysis {
  fileName: string;
  fileSize: number;
  mimeType: string;
  lastModified: string;
  sha256: string;
  extractedStrings: string[];
}

export const CredentialsAndArchView: React.FC<CredentialsAndArchViewProps> = ({
  credentials,
  activeCase,
  onSaveCredentials,
  onAddForensicNode,
}) => {
  const [form, setForm] = useState<ApiCredentials>({ ...credentials });
  const [showSecrets, setShowSecrets] = useState<boolean>(false);
  const [savedBanner, setSavedBanner] = useState<boolean>(false);
  const [caseSha256, setCaseSha256] = useState<string>('Calculando...');
  const [forensicFile, setForensicFile] = useState<ForensicFileAnalysis | null>(null);
  const [copiedGit, setCopiedGit] = useState<boolean>(false);

  useEffect(() => {
    computeCaseSha256(activeCase).then(setCaseSha256);
  }, [activeCase]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveCredentials(form);
    setSavedBanner(true);
    setTimeout(() => setSavedBanner(false), 3000);
  };

  const handleReset = () => {
    setForm({ ...DEFAULT_CREDENTIALS });
    onSaveCredentials({ ...DEFAULT_CREDENTIALS });
  };

  // Client-Side Forensic File Hash & Metadata Extractor
  const handleInspectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Extract printable ASCII strings (e.g. EXIF software, camera, author, URLs) from first 64KB
    const slice = new Uint8Array(buffer.slice(0, 65536));
    let rawAscii = '';
    for (let i = 0; i < slice.length; i++) {
      const code = slice[i];
      rawAscii += code >= 32 && code <= 126 ? String.fromCharCode(code) : ' ';
    }

    const interestingMatches = Array.from(
      new Set(
        (
          rawAscii.match(
            /(Adobe|Photoshop|GIMP|Canon|Nikon|Sony|Apple|iPhone|Android|Exif|http[s]?:\/\/[^\s"']+|202[0-9]:[0-1][0-9]:[0-3][0-9]|Creator|Author|Producer)[a-zA-Z0-9_.\-:/ ]{0,28}/gi
          ) || []
        ).map((s) => s.trim())
      )
    ).slice(0, 6);

    setForensicFile({
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      lastModified: new Date(file.lastModified).toISOString().slice(0, 19).replace('T', ' '),
      sha256,
      extractedStrings:
        interestingMatches.length > 0
          ? interestingMatches
          : ['Sin cabeceras EXIF/XMP explícitas detectadas (Archivo limpio)'],
    });
  };

  const gitCommands = `git init
git add .
git commit -m "feat: release Fantasma OSINT platform v1.0 (100% Client-Side)"
git branch -M main
git remote add origin https://github.com/tu-usuario/fantasma-osint.git
git push -u origin main`;

  return (
    <div className="space-y-6">
      {/* Top Row: Forensic Chain of Custody & Local File Inspector + CTI Interoperability */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Forensic Chain of Custody & File Hasher */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <FileCheck2 className="w-4 h-4 text-red-400" />
              <h3 className="text-base font-semibold text-white">
                Laboratorio Forense Local y Cadena de Custodia (SHA-256)
              </h3>
            </div>
            <span className="text-xs font-mono text-emerald-400">WebCrypto API</span>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 space-y-1.5">
            <div className="text-xs text-slate-400 flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5 text-emerald-400" />
              Sello Criptográfico SHA-256 del Expediente Activo:
            </div>
            <div className="font-mono text-xs text-emerald-300 break-all select-all">
              {caseSha256}
            </div>
          </div>

          {/* Local Evidence File Dropzone */}
          <div className="space-y-3">
            <label className="flex flex-col items-center justify-center p-4 border border-dashed border-slate-700 hover:border-red-500/60 bg-slate-950/60 rounded-lg cursor-pointer transition-colors text-center">
              <UploadCloud className="w-6 h-6 text-red-400 mb-1.5" />
              <span className="text-xs font-medium text-slate-200">
                Analizar Evidencia Digital en el Navegador (Imagen, PDF, Documento)
              </span>
              <span className="text-[11px] text-slate-400 mt-0.5">
                Extrae hash SHA-256 pericial y cabeceras EXIF/XMP localmente sin subir el archivo a internet
              </span>
              <input type="file" onChange={handleInspectFile} className="hidden" />
            </label>

            {forensicFile && (
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">{forensicFile.fileName}</span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    {(forensicFile.fileSize / 1024).toFixed(1)} KB · {forensicFile.mimeType}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-emerald-400 break-all">
                  SHA-256: {forensicFile.sha256}
                </div>
                <div className="text-slate-400">
                  Última modificación: <span className="font-mono text-slate-200">{forensicFile.lastModified}</span>
                </div>
                <div className="text-slate-400">
                  Metadatos / Cabeceras:{' '}
                  <span className="font-mono text-slate-300">
                    {forensicFile.extractedStrings.join(' | ')}
                  </span>
                </div>
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      onAddForensicNode(
                        `Evidencia: ${forensicFile.fileName} (${forensicFile.sha256.slice(0, 8)})`,
                        'dork_query',
                        'Forense SHA-256',
                        'evidencia_forense_sha256'
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    Vincular Evidencia Forense al Grafo
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* CTI Interoperability Export (STIX 2.1, Maltego, Gephi) */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
              <Share2 className="w-4 h-4 text-red-400" />
              <h3 className="text-base font-semibold text-white">
                Interoperabilidad CTI (STIX 2.1 / Maltego / Gephi)
              </h3>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Exporta las entidades y relaciones descubiertas en estándares internacionales de Ciberinteligencia para importarlas directamente en <strong>OpenCTI</strong>, <strong>MISP</strong>, <strong>Maltego</strong> o <strong>Gephi</strong>.
            </p>

            <div className="space-y-2.5 pt-1">
              <button
                type="button"
                onClick={() => exportCaseToStix21(activeCase)}
                className="w-full flex items-center justify-between px-4 py-3 bg-slate-950 hover:bg-slate-800/80 border border-slate-800 rounded-lg transition-colors text-left"
              >
                <div>
                  <div className="text-xs font-semibold text-white">Exportar Bundle OASIS STIX 2.1 (.stix.json)</div>
                  <div className="text-[11px] text-slate-400">Compatible con OpenCTI, MISP y TheHive</div>
                </div>
                <Download className="w-4 h-4 text-red-400 shrink-0" />
              </button>

              <button
                type="button"
                onClick={() => exportCaseToMaltegoCsv(activeCase)}
                className="w-full flex items-center justify-between px-4 py-3 bg-slate-950 hover:bg-slate-800/80 border border-slate-800 rounded-lg transition-colors text-left"
              >
                <div>
                  <div className="text-xs font-semibold text-white">Exportar Grafo para Maltego y Gephi (.csv)</div>
                  <div className="text-[11px] text-slate-400">Tabla de aristas Origen → Relación → Destino con Score</div>
                </div>
                <Download className="w-4 h-4 text-sky-400 shrink-0" />
              </button>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
            <span>Estándar CTI OASIS v2.1</span>
            <span className="font-mono text-slate-300 tabular-nums">{activeCase.nodes.length} entidades listas</span>
          </div>
        </div>
      </div>

      {/* Middle Row: Encrypted Credential Manager + GitHub Pages Kit */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSave}
          className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-red-400" />
                <h3 className="text-base font-semibold text-white">
                  Gestor de Credenciales Local (Bóveda Cifrada en Navegador)
                </h3>
              </div>
              <p className="text-xs text-slate-400">
                Las llaves API se cifran simétricamente en <code className="text-slate-300">localStorage</code> y se inyectan dinámicamente en las peticiones <code className="text-slate-300">fetch</code> del navegador.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowSecrets(!showSecrets)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              {showSecrets ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {showSecrets ? 'Ocultar Llaves' : 'Mostrar Llaves'}
            </button>
          </div>

          {/* CORS Proxy Configuration */}
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200">
                Proxy CORS Configurable
              </label>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, corsProxy: 'https://corsproxy.io/?' })}
                  className="text-red-400 hover:underline font-mono"
                >
                  corsproxy.io
                </button>
                <span className="text-slate-600">·</span>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, corsProxy: 'https://api.allorigins.win/raw?url=' })}
                  className="text-sky-400 hover:underline font-mono"
                >
                  allorigins.win
                </button>
              </div>
            </div>
            <input
              type="text"
              value={form.corsProxy}
              onChange={(e) => setForm({ ...form, corsProxy: e.target.value })}
              placeholder="https://corsproxy.io/?"
              className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-100 font-mono"
            />
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.useCorsProxyForSherlock}
                onChange={(e) => setForm({ ...form, useCorsProxyForSherlock: e.target.checked })}
                className="accent-red-500 rounded"
              />
              Enrutar comprobaciones HTTP 200 del catálogo Sherlock a través del Proxy CORS
            </label>
          </div>

          {/* Keyless APIs Notice */}
          <div className="bg-emerald-950/30 border border-emerald-800/50 rounded-lg p-3 text-xs text-emerald-200 flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <strong>Fuentes Activas Sin Llave (100% Gratuitas):</strong> Shodan InternetDB (<code>internetdb.shodan.io</code>), <code>crt.sh</code>, <code>RDAP / WHOIS</code>, <code>Wayback Machine</code>, <code>RIPE Stat BGP</code>, <code>XposedOrNot</code>, <code>Google DoH</code>, <code>OpenPGP</code> y las APIs públicas de GitHub, Reddit, GitLab, HackerNews, Keybase, Lichess y Mastodon funcionan de serie.
            </div>
          </div>

          {/* Optional API Keys Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">OpenAI API Key (Resumen IA)</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.openAiKey}
                onChange={(e) => setForm({ ...form, openAiKey: e.target.value })}
                placeholder="sk-proj-..."
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Modelo OpenAI</label>
              <select
                value={form.openAiModel}
                onChange={(e) => setForm({ ...form, openAiModel: e.target.value })}
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              >
                <option value="gpt-4o-mini">gpt-4o-mini (Rápido)</option>
                <option value="gpt-4o">gpt-4o (Análisis Profundo)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Have I Been Pwned (HIBP Key)</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.hibpKey}
                onChange={(e) => setForm({ ...form, hibpKey: e.target.value })}
                placeholder="Opcional — hibp-api-key"
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Hunter.io API Key</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.hunterKey}
                onChange={(e) => setForm({ ...form, hunterKey: e.target.value })}
                placeholder="Opcional — hunter.io key"
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">VirusTotal API Key v3</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.virusTotalKey}
                onChange={(e) => setForm({ ...form, virusTotalKey: e.target.value })}
                placeholder="Opcional — x-apikey"
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">URLScan.io API Key</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.urlScanKey}
                onChange={(e) => setForm({ ...form, urlScanKey: e.target.value })}
                placeholder="Opcional — API-Key"
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Shodan API Clásica</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.shodanKey}
                onChange={(e) => setForm({ ...form, shodanKey: e.target.value })}
                placeholder="Opcional — Shodan Key"
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Serper.dev API Key (Google Dorks)</label>
              <input
                type={showSecrets ? 'text' : 'password'}
                value={form.serperKey}
                onChange={(e) => setForm({ ...form, serperKey: e.target.value })}
                placeholder="Opcional — X-API-KEY"
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-white transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Restaurar Valores
            </button>

            <div className="flex items-center gap-3">
              {savedBanner && (
                <span className="flex items-center gap-1 text-xs text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" />
                  Cifrado en localStorage
                </span>
              )}
              <button
                type="submit"
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                Guardar Bóveda Local
              </button>
            </div>
          </div>
        </form>

        {/* Right Column: GitHub Repository & GitHub Actions Ready Panel */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <FolderGit2 className="w-4 h-4 text-red-400" />
                <h3 className="text-base font-semibold text-white">
                  Preparado para Subir a GitHub y GitHub Pages
                </h3>
              </div>
              <span className="text-xs font-mono text-emerald-400">CI/CD Incluido</span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              El repositorio ya cuenta con <code className="text-slate-100">README.md</code> documentado con capturas, licencia <code className="text-slate-100">MIT</code>, archivo <code className="text-slate-100">public/.nojekyll</code> y el flujo de trabajo oficial <code className="text-slate-100">.github/workflows/deploy.yml</code> para publicación automática en <strong>GitHub Pages</strong>.
            </p>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-red-400" />
                  Comandos para subir a tu cuenta de GitHub:
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(gitCommands);
                    setCopiedGit(true);
                    setTimeout(() => setCopiedGit(false), 2500);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Copy className="w-3 h-3" />
                  {copiedGit ? 'Copiado' : 'Copiar'}
                </button>
              </div>
              <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3 font-mono text-[11px] text-slate-300 overflow-x-auto">
                {gitCommands}
              </pre>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-1.5 text-xs">
              <div className="font-semibold text-white">Archivos de Repositorio Generados en Raíz:</div>
              <div className="font-mono text-[11px] text-slate-300 space-y-1">
                <div>• /README.md (Documentación completa + Capturas + Mermaid)</div>
                <div>• /.github/workflows/deploy.yml (GitHub Actions → Pages)</div>
                <div>• /public/.nojekyll (Servido estático limpio)</div>
                <div>• /LICENSE (MIT License — Un Fantasma en el Sistema)</div>
              </div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
            <span className="text-slate-400">Autoría y Web Oficial:</span>
            <a
              href="https://www.unfantasmaenelsistema.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-red-400 hover:text-red-300 font-semibold"
            >
              unfantasmaenelsistema.com ↗
            </a>
          </div>
        </div>
      </div>

      {/* Bottom Row: README Screenshot Gallery Preview */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-red-400" />
            <h3 className="text-base font-semibold text-white">
              Capturas Oficiales Incluidas en el README.md para GitHub
            </h3>
          </div>
          <span className="text-xs text-slate-400">3 vistas de alta resolución vinculadas en /README.md</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col">
            <div className="aspect-video bg-slate-900 overflow-hidden">
              <img
                src={graphScreenshot}
                alt="Captura del Grafo Interactivo OSINT con Burbujas"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="p-3 space-y-1">
              <div className="text-xs font-semibold text-white">1. Grafo de Investigación en Vivo</div>
              <p className="text-[11px] text-slate-400">
                Agrupación dinámica en burbujas, correlación de nodos e inspector técnico.
              </p>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col">
            <div className="aspect-video bg-slate-900 overflow-hidden">
              <img
                src={geoScreenshot}
                alt="Captura de Inteligencia Geoespacial Leaflet y Línea de Tiempo"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="p-3 space-y-1">
              <div className="text-xs font-semibold text-white">2. Mapa Geoespacial y Línea de Tiempo</div>
              <p className="text-[11px] text-slate-400">
                Geolocalización de IPs/perfiles con Leaflet.js e historial cronológico de evidencias.
              </p>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex flex-col">
            <div className="aspect-video bg-slate-900 overflow-hidden">
              <img
                src={matrixScreenshot}
                alt="Captura de Familias de Alias y Matriz de Confianza"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="p-3 space-y-1">
              <div className="text-xs font-semibold text-white">3. Familias de Alias y Score 0–100</div>
              <p className="text-[11px] text-slate-400">
                Generador morfológico Leet Speak 1337 y matriz para descartar homónimos.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
