import React, { useState } from 'react';
import {
  ManualTask,
  RetryTaskStatus,
  SherlockSite,
} from '../types/osint';
import { SHERLOCK_SITES } from '../services/osintEngine';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  PlusCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react';

interface ManualTasksAndRetryViewProps {
  seedQuery: string;
  manualTasks: ManualTask[];
  activeRetries: RetryTaskStatus[];
  onUpdateManualTaskStatus: (taskId: string, status: ManualTask['status']) => void;
  onPromoteTaskToGraph: (task: ManualTask) => void;
  onSimulateRateLimitRetry: () => void;
}

export const ManualTasksAndRetryView: React.FC<ManualTasksAndRetryViewProps> = ({
  seedQuery,
  manualTasks,
  activeRetries,
  onUpdateManualTaskStatus,
  onPromoteTaskToGraph,
  onSimulateRateLimitRetry,
}) => {
  const [taskFilter, setTaskFilter] = useState<'all' | 'pending' | 'verified_hit' | 'discarded'>('all');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('Todas');

  const filteredTasks = manualTasks.filter(
    (t) => taskFilter === 'all' || t.status === taskFilter
  );

  const categories = ['Todas', ...Array.from(new Set(SHERLOCK_SITES.map((s) => s.category)))];
  const filteredCatalog = SHERLOCK_SITES.filter((s) => {
    if (catalogCategory !== 'Todas' && s.category !== catalogCategory) return false;
    if (catalogSearch.trim()) {
      return s.name.toLowerCase().includes(catalogSearch.toLowerCase());
    }
    return true;
  });

  const cleanHandle = seedQuery.replace(/^@/, '').split('@')[0].trim() || 'unfantasma';

  return (
    <div className="space-y-6">
      {/* Section 1: Smart Retries (HTTP 429) Live Monitor */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <h3 className="text-base font-semibold text-white">
                Gestor Inteligente de Límites de Tasa (HTTP 429 Smart Retries)
              </h3>
            </div>
            <p className="text-xs text-slate-400">
              Cuando una red social responde con HTTP 429 o bloqueo WAF, el motor aplica pausas exponenciales (Backoff 1.4s → 2.8s → 4.2s) antes de derivar el enlace a Tareas Manuales.
            </p>
          </div>

          <button
            onClick={onSimulateRateLimitRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Probar Simulación HTTP 429
          </button>
        </div>

        {activeRetries.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {activeRetries.map((rt) => (
              <div
                key={rt.id}
                className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="text-xs font-semibold text-amber-300">
                    {rt.platform} — Reintento {rt.attempt}/{rt.maxAttempts}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 truncate max-w-xs">
                    {rt.url}
                  </div>
                </div>
                <div className="text-right font-mono text-xs text-slate-300 tabular-nums shrink-0">
                  {rt.status === 'retrying'
                    ? `Pausa ${rt.nextRetryMs}ms...`
                    : rt.status === 'moved_to_manual'
                    ? '→ Cola Manual'
                    : 'Resuelto'}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-400 bg-slate-950 border border-slate-800/80 rounded-lg px-4 py-3 flex items-center justify-between">
            <span>Cola de reintentos exponenciales en reposo. Todas las peticiones recientes han finalizado o pasado a verificación manual.</span>
            <span className="font-mono text-slate-300 tabular-nums">Backoff: 3 niveles</span>
          </div>
        )}
      </div>

      {/* Section 2: Manual Verification Queue (Tareas Manuales) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-red-400" />
            <h3 className="text-base font-semibold text-white">
              Cola de Tareas Manuales y Dorks Pendientes ({filteredTasks.length})
            </h3>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            {[
              { id: 'all', label: `Todas (${manualTasks.length})` },
              { id: 'pending', label: 'Pendientes' },
              { id: 'verified_hit', label: 'Verificadas (Hit)' },
              { id: 'discarded', label: 'Descartadas' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTaskFilter(tab.id as any)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  taskFilter === tab.id
                    ? 'bg-red-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-slate-800/80">
          {filteredTasks.map((task) => (
            <div
              key={task.id}
              className="py-3.5 px-3 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-slate-800/30 rounded-lg transition-colors"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-white text-sm">{task.platform}</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-mono text-amber-400">{task.reason}</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-mono text-slate-400 tabular-nums">
                    Reintentos: {task.retriesAttempted}
                  </span>
                </div>
                <a
                  href={task.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-sky-400 hover:underline inline-flex items-center gap-1 break-all"
                >
                  {task.url}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
                <p className="text-xs text-slate-400">{task.notes}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={task.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
                >
                  Abrir Enlace
                </a>
                <button
                  onClick={() => {
                    onUpdateManualTaskStatus(task.id, 'verified_hit');
                    onPromoteTaskToGraph(task);
                  }}
                  className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    task.status === 'verified_hit'
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-600/50'
                      : 'bg-red-600 hover:bg-red-500 text-white'
                  }`}
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  {task.status === 'verified_hit' ? 'En el Grafo' : 'Confirmar y Añadir al Grafo'}
                </button>
                <button
                  onClick={() => onUpdateManualTaskStatus(task.id, 'discarded')}
                  className="px-2.5 py-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors whitespace-nowrap"
                >
                  Descartar
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 3: Complete Sherlock 58-Site OSINT URL Directory */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div>
            <h3 className="text-base font-semibold text-white">
              Directorio Local Sherlock JSON ({SHERLOCK_SITES.length} Sitios Populares)
            </h3>
            <p className="text-xs text-slate-400">
              Plantillas de URL generadas dinámicamente para el identificador activo: <span className="font-mono text-slate-200">{cleanHandle}</span>
            </p>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={catalogCategory}
              onChange={(e) => setCatalogCategory(e.target.value)}
              className="px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="Buscar plataforma..."
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 w-44"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 max-h-80 overflow-y-auto pr-1">
          {filteredCatalog.map((site: SherlockSite) => {
            const targetUrl = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(cleanHandle));
            return (
              <a
                key={site.name}
                href={targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2.5 bg-slate-950 border border-slate-800 hover:border-red-500/60 rounded-lg flex items-center justify-between gap-2 transition-colors group"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-200 group-hover:text-white truncate">
                    {site.name}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {site.category} · {site.probeMode === 'direct_json' ? 'API Directa' : 'Proxy CORS'}
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-red-400 shrink-0" />
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
};
