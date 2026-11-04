import React, { useState } from 'react';
import {
  AliasVariant,
  ContextHints,
  GraphNode,
} from '../types/osint';
import { extractUsernameRoot } from '../services/aliasAndConfidenceEngine';
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  Fingerprint,
  Play,
  RefreshCw,
  Search,
  Sliders,
  XCircle,
} from 'lucide-react';

interface AliasAndConfidenceViewProps {
  seedQuery: string;
  aliasVariants: AliasVariant[];
  nodes: GraphNode[];
  contextHints: ContextHints;
  isScanning: boolean;
  onProbeVariant: (variant: string) => void;
  onUpdateHintsAndRecalculate: (hints: ContextHints) => void;
  onUpdateNodeStatus: (nodeId: string, status: GraphNode['verifiedStatus']) => void;
}

export const AliasAndConfidenceView: React.FC<AliasAndConfidenceViewProps> = ({
  seedQuery,
  aliasVariants,
  nodes,
  contextHints,
  isScanning,
  onProbeVariant,
  onUpdateHintsAndRecalculate,
  onUpdateNodeStatus,
}) => {
  const [expectedName, setExpectedName] = useState(contextHints.expectedName || '');
  const [expectedLocation, setExpectedLocation] = useState(contextHints.expectedLocation || '');
  const [expectedDomain, setExpectedDomain] = useState(contextHints.expectedDomain || '');
  const [expectedYear, setExpectedYear] = useState(contextHints.expectedYear || '');
  const [customVariant, setCustomVariant] = useState('');
  const [familyFilter, setFamilyFilter] = useState<string>('all');

  const root = extractUsernameRoot(seedQuery);

  const filteredAliases = aliasVariants.filter(
    (a) => familyFilter === 'all' || a.familyType === familyFilter
  );

  const sortedNodes = [...nodes].sort((a, b) => b.confidence.total - a.confidence.total);

  return (
    <div className="space-y-6">
      {/* Top Section: Cross-Correlation Context Hints & Confidence Recalculation */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-red-400" />
            <div>
              <h3 className="text-base font-semibold text-white">
                Parámetros de Correlación Cruzada (Algoritmo Anti-Homónimos 0–100)
              </h3>
              <p className="text-xs text-slate-400">
                Introduce pistas conocidas del objetivo para recalcular el Score de Confianza de todos los hallazgos y filtrar homónimos.
              </p>
            </div>
          </div>

          <button
            onClick={() =>
              onUpdateHintsAndRecalculate({
                expectedName,
                expectedLocation,
                expectedDomain,
                expectedYear,
              })
            }
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Recalcular Scores de Confianza
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Nombre Real / Alias Conocido (+20 pts)</label>
            <input
              type="text"
              value={expectedName}
              onChange={(e) => setExpectedName(e.target.value)}
              placeholder="Ej. Un Fantasma en el Sistema"
              className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-red-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Ubicación / Ciudad Esperada (+15 pts)</label>
            <input
              type="text"
              value={expectedLocation}
              onChange={(e) => setExpectedLocation(e.target.value)}
              placeholder="Ej. Madrid, España"
              className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-red-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Dominio / Web Vinculada (+15 pts)</label>
            <input
              type="text"
              value={expectedDomain}
              onChange={(e) => setExpectedDomain(e.target.value)}
              placeholder="Ej. unfantasmaenelsistema.com"
              className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-red-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Año / Sufijo Numérico Frecuente</label>
            <input
              type="text"
              value={expectedYear}
              onChange={(e) => setExpectedYear(e.target.value)}
              placeholder="Ej. 2026 o 99"
              className="w-full px-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 font-mono focus:outline-none focus:border-red-500"
            />
          </div>
        </div>
      </div>

      {/* Middle Section: Alias Families Generator & Tester */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Fingerprint className="w-4 h-4 text-red-400" />
              <h3 className="text-base font-semibold text-white">
                Motor de Familias de Alias — Raíz Detectada: <span className="font-mono text-red-400">{root}</span>
              </h3>
            </div>
            <p className="text-xs text-slate-400">
              Generación heurística de variantes (Leet Speak 1337, duplicación de caracteres, separadores y sufijos) listas para sondeo directo.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customVariant}
              onChange={(e) => setCustomVariant(e.target.value)}
              placeholder="Sondear variante manual..."
              className="px-3 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 font-mono"
            />
            <button
              disabled={isScanning || !customVariant.trim()}
              onClick={() => {
                if (customVariant.trim()) {
                  onProbeVariant(customVariant.trim());
                  setCustomVariant('');
                }
              }}
              className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              Sondear Alias
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg w-fit">
          {[
            { id: 'all', label: `Todas (${aliasVariants.length})` },
            { id: 'exact', label: 'Raíz Exacta' },
            { id: 'leet_speak', label: 'Leet Speak (1337)' },
            { id: 'duplicated_chars', label: 'Letras Repetidas' },
            { id: 'prefix_suffix', label: 'Prefijos / Sufijos' },
            { id: 'separator', label: 'Separadores' },
            { id: 'year_numeric', label: 'Numéricos' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFamilyFilter(tab.id)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                familyFilter === tab.id
                  ? 'bg-red-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Alias Variants Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filteredAliases.map((item) => (
            <div
              key={item.variant}
              className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex flex-col justify-between gap-2 hover:border-slate-700 transition-colors"
            >
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-sm font-semibold text-white truncate">
                    {item.variant}
                  </span>
                  <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
                    Sim: {item.similarity}%
                  </span>
                </div>
                <div className="text-xs text-slate-400">
                  {item.familyLabel} · {item.tested ? `Probado (${item.hitsCount} hits)` : 'Sin sondear'}
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-slate-900">
                <span className="text-[11px] font-mono text-slate-500">Raíz: {item.root}</span>
                <button
                  disabled={isScanning}
                  onClick={() => onProbeVariant(item.variant)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-red-400 hover:text-red-300 disabled:opacity-50 whitespace-nowrap"
                >
                  <Play className="w-3 h-3" />
                  Comprobar en Sherlock
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom Section: Confidence Scoring Matrix Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-red-400" />
            <h3 className="text-base font-semibold text-white">
              Matriz de Puntuación de Confianza y Discriminación de Homónimos ({sortedNodes.length})
            </h3>
          </div>
          <span className="text-xs text-slate-400">
            ≥75% Perfil Confirmado · 50–74% Correlación Parcial · &lt;50% Probable Homónimo
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 px-3 font-medium">Score Total</th>
                <th className="py-2.5 px-3 font-medium">Entidad / Hallazgo</th>
                <th className="py-2.5 px-3 font-medium">Plataforma</th>
                <th className="py-2.5 px-3 font-medium text-right">Handle (30)</th>
                <th className="py-2.5 px-3 font-medium text-right">Alias (20)</th>
                <th className="py-2.5 px-3 font-medium text-right">Bio/Nombre (20)</th>
                <th className="py-2.5 px-3 font-medium text-right">Geo/Dom (30)</th>
                <th className="py-2.5 px-3 font-medium">Justificación Principal</th>
                <th className="py-2.5 px-3 font-medium text-right">Clasificación</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {sortedNodes.map((n) => (
                <tr key={n.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-2.5 px-3 font-mono font-bold tabular-nums">
                    <span
                      className={
                        n.confidence.total >= 75
                          ? 'text-emerald-400'
                          : n.confidence.total >= 50
                          ? 'text-amber-400'
                          : 'text-red-400'
                      }
                    >
                      {n.confidence.total}/100
                    </span>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="font-medium text-slate-100">{n.label}</div>
                    {n.url && (
                      <a
                        href={n.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-slate-400 hover:text-red-400 inline-flex items-center gap-1"
                      >
                        Abrir enlace <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-slate-300">
                    {n.platform} · <span className="text-slate-500">{n.aliasFamily}</span>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                    {n.confidence.handleMatch}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                    {n.confidence.aliasSimilarity}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                    {n.confidence.bioNameMatch}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                    {n.confidence.geoMatch + n.confidence.avatarDomainMatch}
                  </td>
                  <td className="py-2.5 px-3 text-slate-400 max-w-xs truncate">
                    {n.confidence.reasons[0] || 'Correlación directa'}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => onUpdateNodeStatus(n.id, 'verified')}
                        title="Marcar como Perfil Real"
                        className={`px-2 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                          n.verifiedStatus === 'verified'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-600/50'
                            : 'bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Real
                      </button>
                      <button
                        onClick={() => onUpdateNodeStatus(n.id, 'false_positive')}
                        title="Descartar como Homónimo"
                        className={`px-2 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                          n.verifiedStatus === 'false_positive'
                            ? 'bg-red-950 text-red-300 border border-red-600/50'
                            : 'bg-slate-950 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Homónimo
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
