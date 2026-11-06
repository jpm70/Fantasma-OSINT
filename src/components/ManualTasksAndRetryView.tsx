import React, { useState } from 'react';
import { ManualTask, RetryTaskStatus, SiteCheck } from '../types/osint';
import { SHERLOCK_SITES } from '../services/osintEngine';
import { safeHttpUrl } from '../engine/integrity';
import { AlertTriangle, CheckCircle2, ExternalLink, ListChecks, PlusCircle, RefreshCw, RotateCcw, Search, XCircle } from 'lucide-react';

interface ManualTasksAndRetryViewProps {
  seedQuery: string;
  manualTasks: ManualTask[];
  activeRetries: RetryTaskStatus[];
  siteChecks?: SiteCheck[];
  siteChecksFor?: string;
  proxyConfigured: boolean;
  onUpdateManualTaskStatus: (taskId: string, status: ManualTask['status']) => void;
  onPromoteTaskToGraph: (task: ManualTask) => void;
  onSimulateRateLimitRetry: () => void;
}

const REASON_LABEL: Record<ManualTask['reason'], string> = {
  HTTP_429: 'Límite o bloqueo',
  CORS_BLOCKED: 'Sin CORS',
  WAF_CHALLENGE: 'Solo a mano',
  MANUAL_DORK: 'Búsqueda',
  NO_DATA: 'Sin datos',
  SIMULATION: 'Simulación',
};

const RESULT_STYLE: Record<SiteCheck['result'], { label: string; cls: string }> = {
  found: { label: 'Encontrado', cls: 'text-emerald-400' },
  not_found: { label: 'No existe', cls: 'text-slate-400' },
  unknown: { label: 'Sin respuesta', cls: 'text-amber-400' },
  manual: { label: 'A mano', cls: 'text-sky-400' },
};

const MODE_LABEL: Record<string, string> = {
  direct_json: 'API con CORS',
  proxy_status: 'Proxy propio (código HTTP)',
  proxy_message: 'Proxy propio (texto de la página)',
  manual: 'Solo a mano',
};

export const ManualTasksAndRetryView: React.FC<ManualTasksAndRetryViewProps> = ({
  seedQuery,
  manualTasks,
  activeRetries,
  siteChecks,
  siteChecksFor,
  proxyConfigured,
  onUpdateManualTaskStatus,
  onPromoteTaskToGraph,
  onSimulateRateLimitRetry,
}) => {
  const [taskFilter, setTaskFilter] = useState<'pending' | 'all' | 'verified_hit' | 'discarded'>('pending');
  const [catalogSearch, setCatalogSearch] = useState('');

  const filteredTasks = manualTasks.filter((t) => taskFilter === 'all' || t.status === taskFilter);
  const count = (s: ManualTask['status']) => manualTasks.filter((t) => t.status === s).length;
  const handle = (siteChecksFor || seedQuery).replace(/^@/, '').split('@')[0].trim() || 'usuario';
  const catalog = SHERLOCK_SITES.filter((s) => !catalogSearch.trim() || s.name.toLowerCase().includes(catalogSearch.toLowerCase()));
  const checkFor = (name: string) => siteChecks?.find((c) => c.site === name);

  return (
    <div className="space-y-6">
      {/* Reintentos */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <h3 className="text-base font-semibold text-white">Reintentos ante límites de peticiones (HTTP 429)</h3>
            </div>
            <p className="text-xs text-slate-400">
              Si un servicio responde 429 o 503, se espera 1,4 s y se reintenta una vez; si sigue limitado, el enlace pasa a la cola manual. Un error de red o de CORS no se reintenta: no se arregla esperando.
            </p>
          </div>
          <button onClick={onSimulateRateLimitRetry} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors shrink-0">
            <RefreshCw className="w-3.5 h-3.5" />
            Ver una simulación
          </button>
        </div>
        {activeRetries.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {activeRetries.map((rt) => (
              <div key={rt.id} className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex items-center justify-between gap-3 min-w-0">
                <div className="space-y-1 min-w-0">
                  <div className="text-xs font-semibold text-amber-300">
                    {rt.platform} — reintento {rt.attempt}/{rt.maxAttempts}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 truncate">{rt.url}</div>
                </div>
                <div className="text-right font-mono text-xs text-slate-300 tabular-nums shrink-0">
                  {rt.status === 'retrying' ? `espera ${rt.nextRetryMs} ms` : rt.status === 'moved_to_manual' ? '→ cola manual' : 'resuelto'}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-400 bg-slate-950 border border-slate-800/80 rounded-lg px-4 py-3">Ningún reintento en curso.</div>
        )}
      </div>

      {/* Cola manual */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-red-400 shrink-0" />
              <h3 className="text-base font-semibold text-white">Verificación manual ({count('pending')} pendientes)</h3>
            </div>
            <p className="text-xs text-slate-400">
              Lo que el navegador no puede comprobar solo: sitios sin CORS, sitios que responden 200 aunque el usuario no exista y búsquedas. Abre el enlace y marca lo que veas.
            </p>
          </div>
          <div role="tablist" aria-label="Filtrar la cola" className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            {[
              { id: 'pending', label: `Pendientes (${count('pending')})` },
              { id: 'verified_hit', label: `Encontrados (${count('verified_hit')})` },
              { id: 'discarded', label: `Descartados (${count('discarded')})` },
              { id: 'all', label: `Todas (${manualTasks.length})` },
            ].map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={taskFilter === tab.id}
                onClick={() => setTaskFilter(tab.id as typeof taskFilter)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${taskFilter === tab.id ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredTasks.length === 0 ? (
          <p className="text-xs text-slate-400">No hay tareas en este filtro.</p>
        ) : (
          <ul className="divide-y divide-slate-800/80 max-h-[560px] overflow-y-auto pr-1">
            {filteredTasks.map((task) => {
              const url = safeHttpUrl(task.url);
              const isDork = task.reason === 'MANUAL_DORK';
              return (
                <li key={task.id} className="py-3 px-2 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="font-semibold text-white text-sm">{task.platform}</span>
                      <span className="text-amber-400">{REASON_LABEL[task.reason] ?? task.reason}</span>
                      {task.httpStatus ? <span className="font-mono text-slate-400">HTTP {task.httpStatus}</span> : null}
                      {task.status !== 'pending' && (
                        <span className={task.status === 'verified_hit' ? 'text-emerald-400' : 'text-slate-400'}>{task.status === 'verified_hit' ? (isDork ? '· Revisado' : '· Encontrado') : '· Descartado'}</span>
                      )}
                    </div>
                    {url && (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-sky-400 hover:underline inline-flex items-center gap-1 break-all">
                        {url}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    )}
                    <p className="text-xs text-slate-400">{task.notes}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {task.status === 'pending' ? (
                      <>
                        <button
                          onClick={() => {
                            onUpdateManualTaskStatus(task.id, 'verified_hit');
                            if (!isDork && task.reason !== 'SIMULATION') onPromoteTaskToGraph(task);
                          }}
                          className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors"
                        >
                          {isDork ? <CheckCircle2 className="w-3.5 h-3.5" /> : <PlusCircle className="w-3.5 h-3.5" />}
                          {isDork ? 'Marcar revisado' : 'Existe: añadir al grafo'}
                        </button>
                        <button onClick={() => onUpdateManualTaskStatus(task.id, 'discarded')} className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-red-400 transition-colors">
                          <XCircle className="w-3.5 h-3.5" />
                          {isDork ? 'Sin resultados' : 'No existe'}
                        </button>
                      </>
                    ) : (
                      <button onClick={() => onUpdateManualTaskStatus(task.id, 'pending')} className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white transition-colors">
                        <RotateCcw className="w-3.5 h-3.5" />
                        Volver a pendiente
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Catálogo y resultado por sitio */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white">Catálogo de {SHERLOCK_SITES.length} sitios y resultado para «{handle}»</h3>
            <p className="text-xs text-slate-400">
              {siteChecks?.length
                ? `Encontrados: ${siteChecks.filter((c) => c.result === 'found').length} · no existen: ${siteChecks.filter((c) => c.result === 'not_found').length} · por comprobar: ${siteChecks.filter((c) => c.result === 'unknown' || c.result === 'manual').length}.`
                : 'Lanza una búsqueda de usuario para ver el resultado de cada sitio.'}{' '}
              {proxyConfigured ? 'Con tu proxy se sondean también los sitios sin CORS.' : 'Sin proxy propio, los sitios sin CORS quedan para comprobar a mano.'}
            </p>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              placeholder="Buscar sitio…"
              aria-label="Buscar sitio del catálogo"
              className="pl-8 pr-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 w-44"
            />
          </div>
        </div>
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 sticky top-0 bg-slate-900">
              <tr className="border-b border-slate-800">
                <th className="py-2 px-2 font-medium">Sitio</th>
                <th className="py-2 px-2 font-medium">Cómo se comprueba</th>
                <th className="py-2 px-2 font-medium">Resultado</th>
                <th className="py-2 px-2 font-medium">Detalle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {catalog.map((site) => {
                const c = checkFor(site.name);
                const url = site.urlTemplate.replace(/\{username\}/g, encodeURIComponent(handle));
                return (
                  <tr key={site.name}>
                    <td className="py-2 px-2">
                      <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-slate-200 hover:text-red-400 inline-flex items-center gap-1">
                        {site.name}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <div className="text-[11px] text-slate-500">{site.category}</div>
                    </td>
                    <td className="py-2 px-2 text-slate-400">{MODE_LABEL[site.probeMode]}</td>
                    <td className={`py-2 px-2 font-medium ${c ? RESULT_STYLE[c.result].cls : 'text-slate-500'}`}>{c ? RESULT_STYLE[c.result].label : '—'}</td>
                    <td className="py-2 px-2 text-slate-400">{c?.detail ?? site.manualReason ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
