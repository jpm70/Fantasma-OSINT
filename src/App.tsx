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
  loadCredentialsFromVault,
  saveCaseToStorage,
  saveCredentialsToVault,
} from './services/storageService';
import {
  detectInputType,
  executeOsintInvestigation,
  generateCaseAiSummary,
} from './services/osintEngine';
import {
  calculateConfidenceScore,
  generateAliasFamilies,
} from './services/aliasAndConfidenceEngine';
import {
  exportCaseToHtml,
  exportCaseToJson,
  exportCaseToPdf,
} from './services/reportGenerator';
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
  Search,
  Trash2,
  Upload,
} from 'lucide-react';

type ActiveWorkspaceTab =
  | 'graph'
  | 'alias_confidence'
  | 'geo_timeline'
  | 'manual_retries'
  | 'credentials';

const INPUT_TYPES: Array<{ id: InputType; label: string; placeholder: string }> = [
  { id: 'username', label: 'Usuario (Sherlock)', placeholder: 'Ej. unfantasma o torvalds' },
  { id: 'email', label: 'Correo Electrónico', placeholder: 'Ej. contacto@unfantasmaenelsistema.com' },
  { id: 'domain', label: 'Dominio / URL', placeholder: 'Ej. unfantasmaenelsistema.com' },
  { id: 'ip', label: 'Dirección IP (Shodan)', placeholder: 'Ej. 1.1.1.1 o 104.21.48.192' },
  { id: 'phone', label: 'Teléfono (E.164)', placeholder: 'Ej. +34 600 123 456' },
  { id: 'real_name', label: 'Nombre Real', placeholder: 'Ej. Nombre y Apellidos del objetivo' },
  { id: 'national_id', label: 'ID Nacional / DNI', placeholder: 'Ej. 12345678Z o X1234567L' },
];

export function App() {
  const [cases, setCases] = useState<InvestigationCase[]>([]);
  const [activeCase, setActiveCase] = useState<InvestigationCase | null>(null);
  const [credentials, setCredentials] = useState<ApiCredentials>(() => loadCredentialsFromVault());

  const [activeTab, setActiveTab] = useState<ActiveWorkspaceTab>('graph');
  const [searchQuery, setSearchQuery] = useState<string>('unfantasma');
  const [selectedInputType, setSelectedInputType] = useState<InputType>('username');
  const [autoDetectType, setAutoDetectType] = useState<boolean>(true);

  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState<boolean>(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [activeRetries, setActiveRetries] = useState<RetryTaskStatus[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load persisted cases from IndexedDB on mount
  useEffect(() => {
    loadAllCasesFromStorage().then((loaded) => {
      setCases(loaded);
      if (loaded.length > 0) {
        setActiveCase(loaded[0]);
        setSearchQuery(loaded[0].seedQuery);
        setSelectedInputType(loaded[0].seedType);
      }
    });
  }, []);

  // Auto-detect input type when typing if enabled
  const handleQueryChange = (val: string) => {
    setSearchQuery(val);
    if (autoDetectType && val.trim().length > 2) {
      setSelectedInputType(detectInputType(val));
    }
  };

  // Persist updates to active case in IndexedDB
  const persistCaseUpdate = async (updated: InvestigationCase) => {
    setActiveCase(updated);
    await saveCaseToStorage(updated);
    setCases((prev) => {
      const exists = prev.some((c) => c.id === updated.id);
      if (exists) {
        return prev.map((c) => (c.id === updated.id ? updated : c));
      }
      return [updated, ...prev];
    });
  };

  // Launch OSINT Scan on current case
  const handleRunInvestigation = async (overrideQuery?: string, overrideType?: InputType) => {
    if (!activeCase) return;
    const q = (overrideQuery ?? searchQuery).trim();
    const t = overrideType ?? selectedInputType;
    if (!q) return;

    setSearchQuery(q);
    setSelectedInputType(t);
    setIsScanning(true);

    try {
      const updated = await executeOsintInvestigation({
        currentCase: activeCase,
        query: q,
        inputType: t,
        hints: activeCase.contextHints,
        credentials,
        maxSherlockSites: 20,
        callbacks: {
          onLog: () => {
            // Updated via onCaseProgress
          },
          onRetryStatus: (status) => {
            setActiveRetries((prev) => {
              const others = prev.filter((r) => r.id !== status.id);
              return [status, ...others].slice(0, 8);
            });
          },
          onCaseProgress: (progCase) => {
            setActiveCase({ ...progCase });
          },
        },
      });
      await persistCaseUpdate(updated);
    } finally {
      setIsScanning(false);
    }
  };

  // Create a brand new blank OSINT case
  const handleCreateNewCase = async () => {
    const newCase: InvestigationCase = {
      id: `case-${Date.now()}`,
      name: `Caso OSINT #${cases.length + 1} (${searchQuery || 'Nuevo Objetivo'})`,
      description: 'Investigación creada localmente en IndexedDB.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      seedQuery: searchQuery || 'objetivo',
      seedType: selectedInputType,
      contextHints: {
        expectedName: '',
        expectedLocation: '',
        expectedDomain: '',
        expectedYear: '',
      },
      nodes: [
        {
          id: 'node-seed',
          label: searchQuery || 'objetivo',
          subtitle: `Semilla Principal (${selectedInputType.toUpperCase()})`,
          type: 'seed',
          platform: 'Input OSINT',
          category: 'Semilla Principal',
          aliasFamily: 'Raíz Exacta',
          confidence: {
            total: 100,
            handleMatch: 30,
            aliasSimilarity: 20,
            bioNameMatch: 20,
            geoMatch: 15,
            avatarDomainMatch: 15,
            reasons: ['Semilla inicial definida por el investigador [100]'],
          },
          verifiedStatus: 'verified',
          metadata: { semilla: searchQuery || 'objetivo', tipo: selectedInputType },
        },
      ],
      edges: [],
      timeline: [],
      locations: [],
      manualTasks: [],
      aliasVariants: generateAliasFamilies(searchQuery || 'objetivo'),
      logs: [
        {
          id: `log-${Date.now()}`,
          timestamp: new Date().toTimeString().split(' ')[0],
          module: 'IndexedDB',
          message: 'Nuevo expediente de investigación creado en almacenamiento local.',
          level: 'info',
        },
      ],
    };

    await persistCaseUpdate(newCase);
    setSelectedNode(null);
  };

  const handleDeleteCurrentCase = async () => {
    if (!activeCase) return;
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

  // Import JSON Case file
  const handleImportJsonFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(String(ev.target?.result)) as InvestigationCase;
        if (parsed && parsed.id && Array.isArray(parsed.nodes)) {
          await persistCaseUpdate(parsed);
          setSearchQuery(parsed.seedQuery);
          setSelectedInputType(parsed.seedType);
        }
      } catch {
        // Ignore invalid JSON
      }
    };
    reader.readAsText(file);
  };

  // Update node verification status (Real vs Homonym)
  const handleUpdateNodeStatus = async (
    nodeId: string,
    status: GraphNode['verifiedStatus']
  ) => {
    if (!activeCase) return;
    const updatedNodes = activeCase.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const adjustedTotal =
        status === 'verified'
          ? Math.max(85, n.confidence.total)
          : status === 'false_positive'
          ? Math.min(35, n.confidence.total)
          : n.confidence.total;
      return {
        ...n,
        verifiedStatus: status,
        confidence: { ...n.confidence, total: adjustedTotal },
      };
    });
    const updatedCase = { ...activeCase, nodes: updatedNodes };
    await persistCaseUpdate(updatedCase);
    if (selectedNode?.id === nodeId) {
      const found = updatedNodes.find((n) => n.id === nodeId) || null;
      setSelectedNode(found);
    }
  };

  // Add manual node to graph
  const handleAddManualNode = async (
    label: string,
    type: EntityType,
    platform: string,
    relationToSeed: string
  ) => {
    if (!activeCase) return;
    const seedNode = activeCase.nodes.find((n) => n.type === 'seed') || activeCase.nodes[0];
    const newNodeId = `node-manual-${Date.now()}`;
    const conf = calculateConfidenceScore({
      seedQuery: activeCase.seedQuery,
      candidateHandle: label,
      isDirectApiMatch: true,
      hints: activeCase.contextHints,
    });

    const newNode: GraphNode = {
      id: newNodeId,
      label,
      subtitle: `Evidencia Manual (${platform})`,
      type,
      platform,
      category: 'Evidencia Manual',
      aliasFamily: 'Raíz Exacta',
      confidence: conf,
      verifiedStatus: 'verified',
      metadata: {
        origen: 'Añadido manualmente por el analista',
        fecha: new Date().toISOString().slice(0, 10),
      },
    };

    const updatedCase: InvestigationCase = {
      ...activeCase,
      nodes: [...activeCase.nodes, newNode],
      edges: seedNode
        ? [
            ...activeCase.edges,
            {
              id: `edge-${seedNode.id}-${newNodeId}`,
              source: seedNode.id,
              target: newNodeId,
              relation: relationToSeed || 'evidencia_manual',
              weight: 2,
            },
          ]
        : activeCase.edges,
    };
    await persistCaseUpdate(updatedCase);
  };

  // Recalculate Confidence Scores when Context Hints change
  const handleUpdateHintsAndRecalculate = async (newHints: ContextHints) => {
    if (!activeCase) return;
    const updatedNodes = activeCase.nodes.map((n) => {
      if (n.type === 'seed') return n;
      const newConf = calculateConfidenceScore({
        seedQuery: activeCase.seedQuery,
        candidateHandle: n.label.split(':').pop()?.trim() || n.label,
        candidateName: String(n.metadata.nombreVisible || n.subtitle || ''),
        candidateBio: String(n.metadata.biografia || ''),
        candidateLocation: String(n.metadata.ubicacion || n.coordinates?.label || ''),
        candidateDomainOrUrl: String(n.metadata.web || n.url || ''),
        isDirectApiMatch: n.verifiedStatus === 'verified',
        hints: newHints,
      });
      return {
        ...n,
        confidence: newConf,
        verifiedStatus:
          newConf.total >= 75
            ? ('verified' as const)
            : newConf.total < 45
            ? ('false_positive' as const)
            : n.verifiedStatus,
      };
    });

    const updatedAliases = generateAliasFamilies(activeCase.seedQuery, newHints);
    await persistCaseUpdate({
      ...activeCase,
      contextHints: newHints,
      nodes: updatedNodes,
      aliasVariants: updatedAliases,
    });
  };

  // Simulate HTTP 429 Exponential Backoff for demonstration & testing
  const handleSimulateRateLimitRetry = async () => {
    if (!activeCase) return;
    const simId = `retry-sim-${Date.now()}`;
    const targetUrl = `https://www.instagram.com/${activeCase.seedQuery}/`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      setActiveRetries((prev) => [
        {
          id: simId,
          platform: 'Instagram (Simulación 429)',
          url: targetUrl,
          attempt,
          maxAttempts: 3,
          nextRetryMs: attempt * 1200,
          status: 'retrying',
        },
        ...prev.filter((p) => p.id !== simId),
      ]);
      await new Promise((r) => setTimeout(r, 950));
    }

    setActiveRetries((prev) => [
      {
        id: simId,
        platform: 'Instagram (Simulación 429)',
        url: targetUrl,
        attempt: 3,
        maxAttempts: 3,
        nextRetryMs: 0,
        status: 'moved_to_manual',
      },
      ...prev.filter((p) => p.id !== simId),
    ]);

    const newTask: ManualTask = {
      id: `mt-${Date.now()}`,
      platform: 'Instagram',
      url: targetUrl,
      target: activeCase.seedQuery,
      reason: 'HTTP_429',
      httpStatus: 429,
      retriesAttempted: 3,
      timestamp: new Date().toISOString(),
      status: 'pending',
      notes: 'Derivado automáticamente tras 3 reintentos con pausa exponencial por HTTP 429.',
    };

    await persistCaseUpdate({
      ...activeCase,
      manualTasks: [newTask, ...activeCase.manualTasks],
    });
  };

  // Generate AI / Heuristic Case Summary
  const handleGenerateAiSummary = async () => {
    if (!activeCase) return;
    setIsGeneratingAi(true);
    try {
      const res = await generateCaseAiSummary(activeCase, credentials);
      await persistCaseUpdate({
        ...activeCase,
        aiSummary: res.summary,
      });
    } finally {
      setIsGeneratingAi(false);
    }
  };

  if (!activeCase) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-red-500 mr-2" />
        <span className="text-sm">Inicializando base de datos local IndexedDB...</span>
      </div>
    );
  }

  const confirmedCount = activeCase.nodes.filter((n) => n.confidence.total >= 75).length;
  const homonymCount = activeCase.nodes.filter((n) => n.confidence.total < 50).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Mandatory 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 bg-slate-900 border-b border-slate-800">
        {/* Zone 1: Single Brand Wordmark */}
        <a
          href="https://www.unfantasmaenelsistema.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          Fantasma OSINT
        </a>

        {/* Zone 2: 5 Concise Single-Line Navigation Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            onClick={() => setActiveTab('graph')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'graph' ? 'text-white underline underline-offset-8 decoration-red-500 decoration-2' : ''
            }`}
          >
            Grafo en Vivo
          </button>
          <button
            onClick={() => setActiveTab('alias_confidence')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'alias_confidence'
                ? 'text-white underline underline-offset-8 decoration-red-500 decoration-2'
                : ''
            }`}
          >
            Familias y Confianza
          </button>
          <button
            onClick={() => setActiveTab('geo_timeline')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'geo_timeline'
                ? 'text-white underline underline-offset-8 decoration-red-500 decoration-2'
                : ''
            }`}
          >
            Mapa y Timeline
          </button>
          <button
            onClick={() => setActiveTab('manual_retries')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'manual_retries'
                ? 'text-white underline underline-offset-8 decoration-red-500 decoration-2'
                : ''
            }`}
          >
            Cola HTTP 429 ({activeCase.manualTasks.filter((t) => t.status === 'pending').length})
          </button>
          <button
            onClick={() => setActiveTab('credentials')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'credentials'
                ? 'text-white underline underline-offset-8 decoration-red-500 decoration-2'
                : ''
            }`}
          >
            Credenciales
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => exportCaseToPdf(activeCase)}
            className="px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-500 transition-colors whitespace-nowrap shrink-0"
          >
            Exportar Reporte PDF
          </button>
        </div>
      </header>

      {/* Main Workspace Layout: Left Sidebar (280px) + Central Viewport */}
      <div className="flex-1 flex flex-col xl:flex-row">
        {/* Left Sidebar: Brand Identity, IndexedDB Case Manager, AI Synthesis & Reports */}
        <aside className="w-full xl:w-72 bg-slate-900/70 border-b xl:border-b-0 xl:border-r border-slate-800 p-4 flex flex-col justify-between gap-6 shrink-0">
          <div className="space-y-5">
            {/* Un Fantasma en el Sistema Author Card with Uploaded Logo */}
            <a
              href="https://www.unfantasmaenelsistema.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-3 bg-slate-950 border border-slate-800 hover:border-red-500/50 rounded-xl transition-colors group"
            >
              <div className="w-12 h-12 rounded-lg bg-slate-900 border border-slate-800 p-1 flex items-center justify-center shrink-0 overflow-hidden">
                <img
                  src="/assets/aistudio/icono_81a3db5b.png"
                  alt="Logo Un Fantasma en el Sistema"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain group-hover:scale-105 transition-transform"
                />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white group-hover:text-red-400 transition-colors truncate">
                  Un Fantasma en el Sistema
                </div>
                <div className="text-[11px] text-slate-400 truncate flex items-center gap-1">
                  unfantasmaenelsistema.com
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  OSINT Serverless · GitHub Pages
                </div>
              </div>
            </a>

            {/* IndexedDB Case Selector & Persistence Controls */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-medium text-slate-300 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-red-400" />
                  Casos en IndexedDB ({cases.length})
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleCreateNewCase}
                    title="Crear Nuevo Caso"
                    className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    title="Importar Caso JSON"
                    className="p-1 text-slate-400 hover:text-white hover:bg-slate-800 rounded"
                  >
                    <Upload className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={handleDeleteCurrentCase}
                    title="Eliminar Caso Actual"
                    className="p-1 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImportJsonFile}
                    className="hidden"
                  />
                </div>
              </div>

              <select
                value={activeCase.id}
                onChange={(e) => {
                  const found = cases.find((c) => c.id === e.target.value);
                  if (found) {
                    setActiveCase(found);
                    setSearchQuery(found.seedQuery);
                    setSelectedInputType(found.seedType);
                    setSelectedNode(null);
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

              <input
                type="text"
                value={activeCase.name}
                onChange={(e) => persistCaseUpdate({ ...activeCase, name: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-950/60 border border-slate-800/80 rounded-lg text-slate-300 focus:outline-none focus:border-slate-700"
                placeholder="Renombrar caso..."
              />
            </div>

            {/* Case Metrics Summary (Clean Tabular Text, Zero Pill Sandwiches) */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Semilla Activa:</span>
                <span className="font-mono text-white font-semibold truncate max-w-[130px]">
                  {activeCase.seedQuery}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Entidades en Grafo:</span>
                <span className="font-mono tabular-nums text-slate-200">{activeCase.nodes.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Perfiles Confirmados (≥75%):</span>
                <span className="font-mono tabular-nums text-emerald-400">{confirmedCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Homónimos Aislados (&lt;50%):</span>
                <span className="font-mono tabular-nums text-red-400">{homonymCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Familias de Alias:</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {activeCase.aliasVariants.length}
                </span>
              </div>
            </div>

            {/* AI / Heuristic Summary & Export Suite */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                  <BrainCircuit className="w-3.5 h-3.5 text-red-400" />
                  Síntesis de Inteligencia
                </span>
                <button
                  onClick={handleGenerateAiSummary}
                  disabled={isGeneratingAi}
                  className="text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-50"
                >
                  {isGeneratingAi ? 'Procesando...' : 'Generar Resumen'}
                </button>
              </div>

              <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 max-h-40 overflow-y-auto text-[11px] text-slate-300 leading-relaxed whitespace-pre-line">
                {activeCase.aiSummary ||
                  'Pulsa "Generar Resumen" para procesar todos los hallazgos del caso (compatible con tu API Key de OpenAI o el sintetizador heurístico local).'}
              </div>

              <div className="grid grid-cols-3 gap-1.5 pt-1">
                <button
                  onClick={() => exportCaseToPdf(activeCase)}
                  className="flex items-center justify-center gap-1 py-1.5 px-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  <FileText className="w-3.5 h-3.5 text-red-400" />
                  PDF
                </button>
                <button
                  onClick={() => exportCaseToHtml(activeCase)}
                  className="flex items-center justify-center gap-1 py-1.5 px-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-sky-400" />
                  HTML
                </button>
                <button
                  onClick={() => exportCaseToJson(activeCase)}
                  className="flex items-center justify-center gap-1 py-1.5 px-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  JSON
                </button>
              </div>
            </div>
          </div>

          {/* Activity Logs (Clean Unboxed List) */}
          <div className="space-y-2 border-t border-slate-800 pt-4">
            <div className="text-xs font-medium text-slate-400">Registro de Consultas OSINT</div>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1 text-[11px] font-mono">
              {activeCase.logs.slice(0, 8).map((l: InvestigationLog) => (
                <div key={l.id} className="text-slate-400 leading-tight">
                  <span className="text-slate-500">{l.timestamp}</span>{' '}
                  <span
                    className={
                      l.level === 'success'
                        ? 'text-emerald-400'
                        : l.level === 'warning'
                        ? 'text-amber-400'
                        : 'text-slate-300'
                    }
                  >
                    [{l.module}]
                  </span>{' '}
                  {l.message}
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Central Content Area */}
        <main className="flex-1 p-4 sm:p-6 space-y-5 overflow-x-hidden">
          {/* Universal OSINT Search & Input Entry Bar */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
            {/* Input Type Selector Tabs */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                {INPUT_TYPES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setAutoDetectType(false);
                      setSelectedInputType(item.id);
                    }}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      selectedInputType === item.id
                        ? 'bg-red-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDetectType}
                  onChange={(e) => setAutoDetectType(e.target.checked)}
                  className="accent-red-500 rounded"
                />
                Autodetectar formato
              </label>
            </div>

            {/* Search Input + Primary Execute CTA */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleRunInvestigation();
              }}
              className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
            >
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleQueryChange(e.target.value)}
                  placeholder={
                    INPUT_TYPES.find((i) => i.id === selectedInputType)?.placeholder ||
                    'Introduce objetivo de investigación...'
                  }
                  className="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-950 border border-slate-800 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-red-500 font-mono"
                />
              </div>

              <button
                type="submit"
                disabled={isScanning || !searchQuery.trim()}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                {isScanning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Consultando Fuentes...
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4" />
                    Ejecutar Investigación OSINT
                  </>
                )}
              </button>
            </form>

            {/* Quick Live Target Presets for Immediate Testing */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 pt-1">
              <span>Objetivos rápidos de prueba en vivo:</span>
              <button
                type="button"
                onClick={() => handleRunInvestigation('torvalds', 'username')}
                className="text-slate-300 hover:text-red-400 font-mono underline underline-offset-4"
              >
                @torvalds (Usuario)
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => handleRunInvestigation('unfantasmaenelsistema.com', 'domain')}
                className="text-slate-300 hover:text-red-400 font-mono underline underline-offset-4"
              >
                unfantasmaenelsistema.com (Dominio crt.sh/RDAP)
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => handleRunInvestigation('1.1.1.1', 'ip')}
                className="text-slate-300 hover:text-red-400 font-mono underline underline-offset-4"
              >
                1.1.1.1 (Shodan InternetDB + GeoIP)
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => handleRunInvestigation('test@example.com', 'email')}
                className="text-slate-300 hover:text-red-400 font-mono underline underline-offset-4"
              >
                test@example.com (XposedOrNot + MX)
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => handleRunInvestigation('00000000T', 'national_id')}
                className="text-slate-300 hover:text-red-400 font-mono underline underline-offset-4"
              >
                00000000T (DNI Mod-23)
              </button>
            </div>
          </section>

          {/* Mobile / Tablet Workspace Tab Switcher */}
          <div className="flex md:hidden items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
            {[
              { id: 'graph', label: 'Grafo', icon: Network },
              { id: 'alias_confidence', label: 'Alias y Score', icon: Fingerprint },
              { id: 'geo_timeline', label: 'Mapa/Timeline', icon: Globe },
              { id: 'manual_retries', label: 'Cola 429', icon: ListChecks },
              { id: 'credentials', label: 'API Keys', icon: KeyRound },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id as ActiveWorkspaceTab)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
                  activeTab === t.id ? 'bg-red-600 text-white' : 'text-slate-400'
                }`}
              >
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {/* Active Workspace Module */}
          {activeTab === 'graph' && (
            <InteractiveGraph
              nodes={activeCase.nodes}
              edges={activeCase.edges}
              selectedNode={selectedNode}
              onSelectNode={setSelectedNode}
              onUpdateNodeStatus={handleUpdateNodeStatus}
              onPivotFromNode={(q, t) => handleRunInvestigation(q, t)}
              onAddManualNode={handleAddManualNode}
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
              onAddManualLocation={(loc: Omit<GeoMarker, 'id'>) => {
                const newGeo: GeoMarker = { ...loc, id: `geo-manual-${Date.now()}` };
                persistCaseUpdate({
                  ...activeCase,
                  locations: [...activeCase.locations, newGeo],
                });
              }}
            />
          )}

          {activeTab === 'manual_retries' && (
            <ManualTasksAndRetryView
              seedQuery={activeCase.seedQuery}
              manualTasks={activeCase.manualTasks}
              activeRetries={activeRetries}
              onUpdateManualTaskStatus={(taskId, status) => {
                const updatedTasks = activeCase.manualTasks.map((t) =>
                  t.id === taskId ? { ...t, status } : t
                );
                persistCaseUpdate({ ...activeCase, manualTasks: updatedTasks });
              }}
              onPromoteTaskToGraph={(task) => {
                handleAddManualNode(
                  `${task.platform}: ${task.target}`,
                  'social_profile',
                  task.platform,
                  'verificado_manualmente'
                );
              }}
              onSimulateRateLimitRetry={handleSimulateRateLimitRetry}
            />
          )}

          {activeTab === 'credentials' && (
            <CredentialsAndArchView
              credentials={credentials}
              activeCase={activeCase}
              onSaveCredentials={(newCreds) => {
                setCredentials(newCreds);
                saveCredentialsToVault(newCreds);
              }}
              onAddForensicNode={(label, type, platform, relation) => {
                handleAddManualNode(label, type, platform, relation);
                setActiveTab('graph');
              }}
            />
          )}
        </main>
      </div>

      {/* Quiet Footer with Author Branding & GitHub Pages Link */}
      <footer className="px-6 py-3 bg-slate-900 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <img
            src="/assets/aistudio/icono_81a3db5b.png"
            alt="Icono Un Fantasma en el Sistema"
            referrerPolicy="no-referrer"
            className="w-4 h-4 object-contain"
          />
          <span>
            Plataforma OSINT de Código Abierto —{' '}
            <a
              href="https://www.unfantasmaenelsistema.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-red-400 hover:underline font-medium"
            >
              Un Fantasma en el Sistema
            </a>
          </span>
        </div>
        <div>
          Arquitectura 100% Client-Side (IndexedDB · Proxy CORS · Leaflet.js · jsPDF) lista para GitHub Pages
        </div>
      </footer>
    </div>
  );
}

export default App;
