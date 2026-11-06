import React, { useEffect, useRef, useState } from 'react';
import {
  ApiCredentials,
  ContextHints,
  EntityType,
  GeoMarker,
  GraphNode,
  InputType,
  InvestigationCase,
  InvestigationLog,
  ManualTask,
  RetryTaskStatus,
} from './types/osint';
import {
  createInitialDemoCase,
  deleteCaseFromStorage,
  loadAllCasesFromStorage,
  loadSettings,
  migrateLegacyVault,
  normalizeCase,
  saveCaseToStorage,
} from './services/storageService';
import { detectInputType, executeOsintInvestigation, generateCaseAiSummary, seedNodeIdFor } from './services/osintEngine';
import { generateAliasFamilies, identityBand, rescoreProfiles, sourceConfidence } from './services/aliasAndConfidenceEngine';
import { exportCaseToHtml, exportCaseToJson, exportCaseToPdf } from './services/reportGenerator';
import { safeHttpUrl } from './engine/integrity';
import { InteractiveGraph } from './components/InteractiveGraph';
import { GeoTimelineView } from './components/GeoTimelineView';
import { AliasAndConfidenceView } from './components/AliasAndConfidenceView';
import { ManualTasksAndRetryView } from './components/ManualTasksAndRetryView';
import { CredentialsAndArchView } from './components/CredentialsAndArchView';
import {
  BrainCircuit,
  Database,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Fingerprint,
  FolderPlus,
  Globe,
  KeyRound,
  ListChecks,
  Loader2,
  Network,
  Scale,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';

type ActiveWorkspaceTab = 'graph' | 'alias_confidence' | 'geo_timeline' | 'manual_retries' | 'credentials';

const LOGO_URL = `${import.meta.env.BASE_URL}assets/aistudio/icono_81a3db5b.png`;

const INPUT_TYPES: Array<{ id: InputType; label: string; placeholder: string }> = [
  { id: 'username', label: 'Usuario', placeholder: 'Ej. unfantasmaenelsistema' },
  { id: 'email', label: 'Correo', placeholder: 'Ej. test@example.com' },
  { id: 'domain', label: 'Dominio', placeholder: 'Ej. unfantasmaenelsistema.com' },
  { id: 'ip', label: 'IP', placeholder: 'Ej. 1.1.1.1' },
  { id: 'phone', label: 'Teléfono', placeholder: 'Ej. +34 600 000 000' },
  { id: 'real_name', label: 'Nombre', placeholder: 'Nombre y apellidos' },
  { id: 'national_id', label: 'DNI / NIE', placeholder: 'Ej. 00000000T' },
];

const TABS: Array<{ id: ActiveWorkspaceTab; label: string; icon: typeof Network }> = [
  { id: 'graph', label: 'Grafo', icon: Network },
  { id: 'alias_confidence', label: 'Familias y confianza', icon: Fingerprint },
  { id: 'geo_timeline', label: 'Mapa y cronología', icon: Globe },
  { id: 'manual_retries', label: 'Verificación manual', icon: ListChecks },
  { id: 'credentials', label: 'Claves y herramientas', icon: KeyRound },
];

function blankCase(query: string, type: InputType, n: number): InvestigationCase {
  const now = new Date().toISOString();
  const q = query.trim() || 'objetivo';
  return {
    id: `case-${Date.now()}`,
    name: `Caso ${n} (${q})`,
    description: 'Investigación guardada en este navegador (IndexedDB).',
    createdAt: now,
    updatedAt: now,
    seedQuery: q,
    seedType: type,
    contextHints: { expectedName: '', expectedLocation: '', expectedDomain: '', expectedYear: '' },
    nodes: [
      {
        id: seedNodeIdFor(q),
        label: q,
        subtitle: `Semilla (${type})`,
        type: 'seed',
        platform: 'Entrada del analista',
        category: 'Semilla',
        aliasFamily: 'Raíz exacta',
        confidence: sourceConfidence(100, 'Punto de partida definido por el analista'),
        verifiedStatus: 'verified',
        pivot: { query: q, type },
        metadata: { busqueda: q, tipo: type },
      },
    ],
    edges: [],
    timeline: [],
    locations: [],
    manualTasks: [],
    aliasVariants: type === 'username' || type === 'email' || type === 'real_name' ? generateAliasFamilies(q) : [],
    logs: [{ id: `log-${Date.now()}`, timestamp: new Date().toTimeString().slice(0, 8), module: 'Casos', message: 'Caso nuevo creado.', level: 'info' }],
  };
}

export function App() {
  const [cases, setCases] = useState<InvestigationCase[]>([]);
  const [activeCase, setActiveCase] = useState<InvestigationCase | null>(null);
  const [credentials, setCredentials] = useState<ApiCredentials>(() => loadSettings());
  const [legacyNotice, setLegacyNotice] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('graph');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedInputType, setSelectedInputType] = useState<InputType>('username');
  const [autoDetectType, setAutoDetectType] = useState<boolean>(true);

  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState<boolean>(false);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [activeRetries, setActiveRetries] = useState<RetryTaskStatus[]>([]);
  const [jsonHash, setJsonHash] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Bóveda de la v1 (solo ofuscada): se cargan las claves en memoria y se borra
    const legacy = migrateLegacyVault();
    if (legacy) {
      setCredentials((c) => ({ ...c, ...legacy }));
      setLegacyNotice('La versión anterior guardaba tus claves solo ofuscadas (XOR con una cadena escrita en el código): cualquiera con acceso al navegador podía leerlas. Se han cargado en esta sesión y se han borrado del navegador. Si quieres conservarlas, guárdalas en la bóveda cifrada con una frase.');
    }
    loadAllCasesFromStorage().then((loaded) => {
      setCases(loaded);
      if (loaded.length > 0) {
        setActiveCase(loaded[0]);
        setSearchQuery(loaded[0].seedQuery);
        setSelectedInputType(loaded[0].seedType);
      }
    });
  }, []);

  const handleQueryChange = (val: string) => {
    setSearchQuery(val);
    if (autoDetectType && val.trim().length > 2) setSelectedInputType(detectInputType(val));
  };

  const persistCaseUpdate = async (updated: InvestigationCase) => {
    setActiveCase(updated);
    setJsonHash(null);
    await saveCaseToStorage(updated);
    setCases((prev) => (prev.some((c) => c.id === updated.id) ? prev.map((c) => (c.id === updated.id ? updated : c)) : [updated, ...prev]));
  };

  const handleRunInvestigation = async (overrideQuery?: string, overrideType?: InputType) => {
    if (!activeCase || isScanning) return;
    const q = (overrideQuery ?? searchQuery).trim();
    const t = overrideType ?? selectedInputType;
    if (!q) return;
    setSearchQuery(q);
    setSelectedInputType(t);
    setIsScanning(true);
    try {
      // El caso de ejemplo tiene datos inventados: una búsqueda real abre un caso nuevo
      let base = activeCase;
      if (activeCase.isDemo) {
        base = blankCase(q, t, cases.length + 1);
        await persistCaseUpdate(base);
        setSelectedNode(null);
      }
      const updated = await executeOsintInvestigation({
        currentCase: base,
        query: q,
        inputType: t,
        hints: base.contextHints,
        credentials,
        callbacks: {
          onLog: () => undefined,
          onRetryStatus: (status) => setActiveRetries((prev) => [status, ...prev.filter((r) => r.id !== status.id)].slice(0, 8)),
          onCaseProgress: (progCase) => setActiveCase({ ...progCase }),
        },
      });
      await persistCaseUpdate(updated);
    } finally {
      setIsScanning(false);
    }
  };

  const handleCreateNewCase = async () => {
    const q = searchQuery.trim() || 'objetivo';
    await persistCaseUpdate(blankCase(q, autoDetectType ? detectInputType(q) : selectedInputType, cases.length + 1));
    setSelectedNode(null);
    setActiveTab('graph');
  };

  const handleDeleteCurrentCase = async () => {
    if (!activeCase) return;
    if (!window.confirm(`¿Eliminar el caso «${activeCase.name}» de este navegador? No se puede deshacer (exporta el JSON antes si lo necesitas).`)) return;
    await deleteCaseFromStorage(activeCase.id);
    const remaining = cases.filter((c) => c.id !== activeCase.id);
    if (remaining.length > 0) {
      setCases(remaining);
      setActiveCase(remaining[0]);
    } else {
      const demo = createInitialDemoCase();
      await saveCaseToStorage(demo);
      setCases([demo]);
      setActiveCase(demo);
    }
    setSelectedNode(null);
  };

  const handleImportJsonFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = normalizeCase(JSON.parse(String(ev.target?.result)));
        if (!parsed) throw new Error('formato');
        await persistCaseUpdate(parsed);
        setSearchQuery(parsed.seedQuery);
        setSelectedInputType(parsed.seedType);
      } catch {
        window.alert('El archivo no es un caso de Fantasma OSINT válido.');
      }
    };
    reader.readAsText(file);
  };

  /** Veredicto del analista: no cambia la puntuación, que sigue reflejando las pruebas. */
  const handleUpdateNodeStatus = async (nodeId: string, status: GraphNode['verifiedStatus']) => {
    if (!activeCase) return;
    const updatedNodes = activeCase.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const undo = n.analystReviewed && n.verifiedStatus === status;
      return { ...n, verifiedStatus: undo ? ('unverified' as const) : status, analystReviewed: !undo };
    });
    await persistCaseUpdate({ ...activeCase, nodes: updatedNodes });
    if (selectedNode?.id === nodeId) setSelectedNode(updatedNodes.find((n) => n.id === nodeId) || null);
  };

  const handleAddManualNode = async (label: string, type: EntityType, platform: string, relationToSeed: string, metadata: Record<string, string> = {}, handle?: string, url?: string) => {
    if (!activeCase) return;
    const seedNode = activeCase.nodes.find((n) => n.type === 'seed') || activeCase.nodes[0];
    const newNodeId = `node-manual-${Date.now()}`;
    const newNode: GraphNode = {
      id: newNodeId,
      label,
      subtitle: `Añadido por el analista (${platform})`,
      type,
      platform,
      category: 'Evidencia manual',
      aliasFamily: 'Manual',
      url: safeHttpUrl(url),
      confidence: sourceConfidence(100, 'Comprobado y añadido por el analista'),
      evidence: type === 'social_profile' && handle ? { handle, statusOnly: true } : undefined,
      pivot: handle ? { query: handle, type: 'username' } : undefined,
      verifiedStatus: 'verified',
      analystReviewed: true,
      metadata: { origen: 'Añadido por el analista', fecha: new Date().toISOString().slice(0, 10), ...metadata },
    };
    const nodes = rescoreProfiles([...activeCase.nodes, newNode], activeCase.seedQuery, activeCase.contextHints);
    await persistCaseUpdate({
      ...activeCase,
      nodes,
      edges: seedNode ? [...activeCase.edges, { id: `edge-${seedNode.id}-${newNodeId}`, source: seedNode.id, target: newNodeId, relation: relationToSeed || 'evidencia manual', weight: 2 }] : activeCase.edges,
    });
  };

  const handleUpdateHintsAndRecalculate = async (newHints: ContextHints) => {
    if (!activeCase) return;
    const tested = new Map(activeCase.aliasVariants.map((v) => [v.variant, v]));
    const aliasVariants = generateAliasFamilies(activeCase.seedQuery, newHints).map((v) => ({ ...v, tested: tested.get(v.variant)?.tested ?? false, hitsCount: tested.get(v.variant)?.hitsCount ?? 0 }));
    await persistCaseUpdate({ ...activeCase, contextHints: newHints, nodes: rescoreProfiles(activeCase.nodes, activeCase.seedQuery, newHints), aliasVariants });
  };

  /** Simulación didáctica de un 429: no hace ninguna petición y la tarea queda marcada como simulación. */
  const handleSimulateRateLimitRetry = async () => {
    if (!activeCase) return;
    const simId = `retry-sim-${Date.now()}`;
    const targetUrl = 'https://example.com/simulacion-429';
    for (let attempt = 1; attempt <= 2; attempt++) {
      setActiveRetries((prev) => [{ id: simId, platform: 'Simulación', url: targetUrl, attempt, maxAttempts: 2, nextRetryMs: 1400 * 2 ** (attempt - 1), status: 'retrying' as const }, ...prev.filter((p) => p.id !== simId)]);
      await new Promise((r) => setTimeout(r, 900));
    }
    setActiveRetries((prev) => [{ id: simId, platform: 'Simulación', url: targetUrl, attempt: 2, maxAttempts: 2, nextRetryMs: 0, status: 'moved_to_manual' as const }, ...prev.filter((p) => p.id !== simId)]);
    const task: ManualTask = { id: `mt-${Date.now()}`, platform: 'Simulación de HTTP 429', url: targetUrl, target: activeCase.seedQuery, reason: 'SIMULATION', httpStatus: 429, retriesAttempted: 2, timestamp: new Date().toISOString(), status: 'pending', notes: 'Simulación didáctica: no se ha hecho ninguna petición real. Descártala cuando quieras.' };
    await persistCaseUpdate({ ...activeCase, manualTasks: [task, ...activeCase.manualTasks] });
  };

  const handleGenerateAiSummary = async () => {
    if (!activeCase) return;
    if (credentials.openAiKey && !window.confirm('Con tu clave de OpenAI, los datos de este caso (alias, perfiles, ubicaciones…) se enviarán a OpenAI para redactar el resumen. ¿Continuar?')) return;
    setIsGeneratingAi(true);
    setAiNotice(null);
    try {
      const res = await generateCaseAiSummary(activeCase, credentials);
      setAiNotice(res.error ?? (res.mode === 'openai' ? 'Resumen redactado por OpenAI: revísalo antes de usarlo.' : 'Resumen local: no se ha enviado nada fuera del navegador.'));
      await persistCaseUpdate({ ...activeCase, aiSummary: res.summary });
    } finally {
      setIsGeneratingAi(false);
    }
  };

  if (!activeCase) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center" role="status">
        <Loader2 className="w-6 h-6 animate-spin text-red-500 mr-2" />
        <span className="text-sm">Cargando los casos guardados…</span>
      </div>
    );
  }

  const profiles = activeCase.nodes.filter((n) => n.evidence);
  const confirmedCount = profiles.filter((n) => identityBand(n.confidence.total) === 'corroborated').length;
  const homonymCount = profiles.filter((n) => identityBand(n.confidence.total) === 'homonym').length;
  const pendingManual = activeCase.manualTasks.filter((t) => t.status === 'pending').length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="flex items-center justify-between gap-4 px-4 sm:px-6 py-3 bg-slate-900 border-b border-slate-800">
        <a href="https://www.unfantasmaenelsistema.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
          <img src={LOGO_URL} alt="" className="w-8 h-8 object-contain" />
          Fantasma OSINT
        </a>
        <nav aria-label="Secciones" className="hidden xl:flex items-center gap-6 text-sm font-medium text-slate-400">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              aria-current={activeTab === t.id ? 'page' : undefined}
              className={`hover:text-white transition-colors whitespace-nowrap ${activeTab === t.id ? 'text-white underline underline-offset-8 decoration-red-500 decoration-2' : ''}`}
            >
              {t.label}
              {t.id === 'manual_retries' ? ` (${pendingManual})` : ''}
            </button>
          ))}
        </nav>
        <button onClick={() => exportCaseToPdf(activeCase)} className="hidden sm:inline-flex px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-500 transition-colors whitespace-nowrap shrink-0">
          Exportar PDF
        </button>
      </header>

      <div className="flex-1 flex flex-col xl:flex-row min-w-0">
        <aside className="w-full xl:w-72 bg-slate-900/70 border-b xl:border-b-0 xl:border-r border-slate-800 p-4 flex flex-col gap-6 shrink-0">
          <div className="space-y-5">
            <a href="https://www.unfantasmaenelsistema.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 p-3 bg-slate-950 border border-slate-800 hover:border-red-500/50 rounded-xl transition-colors group">
              <div className="w-12 h-12 rounded-lg bg-slate-900 border border-slate-800 p-1 flex items-center justify-center shrink-0 overflow-hidden">
                <img src={LOGO_URL} alt="Logo de Un Fantasma en el Sistema" className="w-full h-full object-contain" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white group-hover:text-red-400 transition-colors truncate">Un Fantasma en el Sistema</div>
                <div className="text-[11px] text-slate-400 truncate flex items-center gap-1">
                  unfantasmaenelsistema.com
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </div>
              </div>
            </a>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-medium text-slate-300 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-red-400" />
                  Casos guardados ({cases.length})
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={handleCreateNewCase} title="Caso nuevo con el texto del buscador" aria-label="Caso nuevo" className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded">
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => fileInputRef.current?.click()} title="Importar un caso (JSON)" aria-label="Importar caso" className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded">
                    <Upload className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={handleDeleteCurrentCase} title="Eliminar el caso actual" aria-label="Eliminar caso" className="p-1 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleImportJsonFile} className="hidden" />
                </div>
              </div>
              <label htmlFor="case-select" className="sr-only">Caso activo</label>
              <select
                id="case-select"
                value={activeCase.id}
                onChange={(e) => {
                  const found = cases.find((c) => c.id === e.target.value);
                  if (found) {
                    setActiveCase(found);
                    setSearchQuery(found.seedQuery);
                    setSelectedInputType(found.seedType);
                    setSelectedNode(null);
                    setAiNotice(null);
                  }
                }}
                className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-red-500"
              >
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.nodes.length} nodos)
                  </option>
                ))}
              </select>
              <label htmlFor="case-name" className="sr-only">Nombre del caso</label>
              <input id="case-name" type="text" value={activeCase.name} onChange={(e) => persistCaseUpdate({ ...activeCase, name: e.target.value })} className="w-full px-2.5 py-1.5 text-xs bg-slate-950/60 border border-slate-800/80 rounded-lg text-slate-300 focus:outline-none focus:border-slate-700" placeholder="Nombre del caso…" />
              {activeCase.isDemo && <p className="text-[11px] text-amber-300">Caso de ejemplo con datos ficticios.</p>}
            </div>

            <dl className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
              {[
                ['Semilla', activeCase.seedQuery, 'text-white font-semibold truncate max-w-[140px]'],
                ['Nodos en el grafo', activeCase.nodes.length, 'text-slate-200'],
                ['Perfiles encontrados', profiles.length, 'text-slate-200'],
                ['Corroborados (≥75)', confirmedCount, 'text-emerald-400'],
                ['Probables homónimos (<40)', homonymCount, 'text-red-400'],
                ['Comprobaciones a mano', pendingManual, 'text-sky-300'],
              ].map(([k, v, cls]) => (
                <div key={String(k)} className="flex justify-between gap-2">
                  <dt className="text-slate-400">{k}</dt>
                  <dd className={`font-mono tabular-nums ${cls}`}>{v}</dd>
                </div>
              ))}
            </dl>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                  <BrainCircuit className="w-3.5 h-3.5 text-red-400" />
                  Resumen del caso
                </span>
                <button onClick={handleGenerateAiSummary} disabled={isGeneratingAi} className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-50">
                  {isGeneratingAi ? 'Generando…' : 'Generar'}
                </button>
              </div>
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 max-h-48 overflow-y-auto text-[11px] text-slate-300 leading-relaxed whitespace-pre-line" aria-live="polite">
                {activeCase.aiSummary || `Pulsa «Generar» para resumir los hallazgos. ${credentials.openAiKey ? 'Con tu clave de OpenAI se usará su modelo (los datos se envían a OpenAI).' : 'Sin clave de OpenAI se usa el resumen local, que no envía nada.'}`}
              </div>
              {aiNotice && <p className="text-[11px] text-slate-400">{aiNotice}</p>}
              <div className="grid grid-cols-3 gap-1.5 pt-1">
                <button onClick={() => exportCaseToPdf(activeCase)} className="flex items-center justify-center gap-1 py-1.5 px-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">
                  <FileText className="w-3.5 h-3.5 text-red-400" />
                  PDF
                </button>
                <button onClick={() => exportCaseToHtml(activeCase)} className="flex items-center justify-center gap-1 py-1.5 px-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">
                  <FileCode2 className="w-3.5 h-3.5 text-sky-400" />
                  HTML
                </button>
                <button onClick={async () => setJsonHash(await exportCaseToJson(activeCase))} className="flex items-center justify-center gap-1 py-1.5 px-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg">
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  JSON
                </button>
              </div>
              {jsonHash && <p className="text-[11px] text-slate-400 break-all">SHA-256 del JSON descargado: <span className="font-mono text-emerald-300">{jsonHash}</span></p>}
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-4">
            <div className="text-xs font-medium text-slate-400">Registro de consultas</div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1 text-[11px] font-mono" aria-live="polite">
              {activeCase.logs.slice(0, 12).map((l: InvestigationLog) => (
                <div key={l.id} className="text-slate-400 leading-tight break-words">
                  <span className="text-slate-500">{l.timestamp}</span>{' '}
                  <span className={l.level === 'success' ? 'text-emerald-400' : l.level === 'warning' ? 'text-amber-400' : l.level === 'error' ? 'text-red-400' : 'text-slate-300'}>[{l.module}]</span> {l.message}
                </div>
              ))}
            </div>
          </div>
        </aside>

        <main className="flex-1 p-4 sm:p-6 space-y-5 min-w-0">
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3" aria-label="Buscador">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="radiogroup" aria-label="Tipo de entrada" className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                {INPUT_TYPES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selectedInputType === item.id}
                    onClick={() => {
                      setAutoDetectType(false);
                      setSelectedInputType(item.id);
                    }}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${selectedInputType === item.id ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input type="checkbox" checked={autoDetectType} onChange={(e) => setAutoDetectType(e.target.checked)} className="accent-red-500 rounded" />
                Detectar el tipo
              </label>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRunInvestigation();
              }}
              className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
            >
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <label htmlFor="query" className="sr-only">Objetivo de la búsqueda</label>
                <input
                  id="query"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder={INPUT_TYPES.find((i) => i.id === selectedInputType)?.placeholder || 'Objetivo…'}
                  className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-950 border border-slate-800 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-red-500 font-mono"
                />
              </div>
              <button type="submit" disabled={isScanning || !searchQuery.trim()} className="flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors whitespace-nowrap">
                {isScanning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Consultando fuentes…
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Investigar
                  </>
                )}
              </button>
            </form>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 pt-1">
              <span>Prueba con:</span>
              {[
                ['unfantasmaenelsistema', 'username', '@unfantasmaenelsistema'],
                ['unfantasmaenelsistema.com', 'domain', 'unfantasmaenelsistema.com'],
                ['1.1.1.1', 'ip', '1.1.1.1'],
                ['test@example.com', 'email', 'test@example.com'],
                ['00000000T', 'national_id', '00000000T'],
              ].map(([q, t, label], i) => (
                <React.Fragment key={q}>
                  {i > 0 && <span aria-hidden="true">·</span>}
                  <button type="button" disabled={isScanning} onClick={() => handleRunInvestigation(q, t as InputType)} className="text-slate-300 hover:text-red-400 font-mono underline underline-offset-4 disabled:opacity-50">
                    {label}
                  </button>
                </React.Fragment>
              ))}
            </div>

            <p className="flex items-start gap-2 text-[11px] text-slate-400 border-t border-slate-800 pt-3">
              <Scale className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Investigar a una persona es tratar datos personales: hazlo solo sobre ti, con su consentimiento o con una base legal (RGPD, art. 6), y con una finalidad concreta. Las consultas salen de tu navegador hacia cada servicio, que verá tu IP. Los casos se guardan solo en este navegador.
              </span>
            </p>
          </section>

          <div role="tablist" aria-label="Secciones" className="flex xl:hidden items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={activeTab === t.id} onClick={() => setActiveTab(t.id)} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${activeTab === t.id ? 'bg-red-600 text-white' : 'text-slate-400'}`}>
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                {t.id === 'manual_retries' ? ` (${pendingManual})` : ''}
              </button>
            ))}
          </div>

          {activeTab === 'graph' && (
            <InteractiveGraph
              nodes={activeCase.nodes}
              edges={activeCase.edges}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              onUpdateNodeStatus={handleUpdateNodeStatus}
              onPivotFromNode={(q, t) => handleRunInvestigation(q, t)}
              onAddManualNode={(label, type, platform, relation) => handleAddManualNode(label, type, platform, relation, {}, type === 'social_profile' ? label.split(':').pop()!.trim() : undefined)}
            />
          )}

          {activeTab === 'alias_confidence' && (
            <AliasAndConfidenceView
              seedQuery={activeCase.seedQuery}
              aliasVariants={activeCase.aliasVariants}
              nodes={activeCase.nodes}
              contextHints={activeCase.contextHints}
              isScanning={isScanning}
              onProbeVariant={(variant) => {
                setActiveTab('graph');
                handleRunInvestigation(variant, 'username');
              }}
              onUpdateHintsAndRecalculate={handleUpdateHintsAndRecalculate}
              onUpdateNodeStatus={handleUpdateNodeStatus}
            />
          )}

          {activeTab === 'geo_timeline' && (
            <GeoTimelineView
              locations={activeCase.locations}
              timeline={activeCase.timeline}
              onAddManualLocation={(loc: Omit<GeoMarker, 'id'>) => persistCaseUpdate({ ...activeCase, locations: [...activeCase.locations, { ...loc, id: `geo-manual-${Date.now()}` }] })}
            />
          )}

          {activeTab === 'manual_retries' && (
            <ManualTasksAndRetryView
              seedQuery={activeCase.seedQuery}
              manualTasks={activeCase.manualTasks}
              activeRetries={activeRetries}
              siteChecks={activeCase.siteChecks}
              siteChecksFor={activeCase.siteChecksFor}
              proxyConfigured={!!credentials.corsProxy.trim()}
              onUpdateManualTaskStatus={(taskId, status) => persistCaseUpdate({ ...activeCase, manualTasks: activeCase.manualTasks.map((t) => (t.id === taskId ? { ...t, status } : t)) })}
              onPromoteTaskToGraph={(task) => handleAddManualNode(`${task.platform}: ${task.target}`, 'social_profile', task.platform, 'comprobado a mano', { url: task.url }, task.target, task.url)}
              onSimulateRateLimitRetry={handleSimulateRateLimitRetry}
            />
          )}

          {activeTab === 'credentials' && (
            <CredentialsAndArchView
              credentials={credentials}
              activeCase={activeCase}
              legacyNotice={legacyNotice}
              onCredentialsChange={(c) => {
                setCredentials(c);
                setLegacyNotice(null);
              }}
              onAddForensicNode={(label, type, platform, relation, metadata) => {
                handleAddManualNode(label, type, platform, relation, metadata);
                setActiveTab('graph');
              }}
            />
          )}
        </main>
      </div>

      <footer className="px-4 sm:px-6 py-3 bg-slate-900 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <img src={LOGO_URL} alt="" className="w-4 h-4 object-contain" />
          <span>
            Fantasma OSINT, de{' '}
            <a href="https://www.unfantasmaenelsistema.com/" target="_blank" rel="noopener noreferrer" className="text-red-400 hover:underline font-medium">
              Un Fantasma en el Sistema
            </a>{' '}
            · Licencia MIT
          </span>
        </div>
        <div>Todo en tu navegador: sin servidor propio ni cuentas</div>
      </footer>
    </div>
  );
}

export default App;
