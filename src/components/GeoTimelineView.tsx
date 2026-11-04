import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { GeoMarker, TimelineEvent } from '../types/osint';
import {
  Calendar,
  Clock,
  Compass,
  ExternalLink,
  Globe,
  MapPin,
  Plus,
} from 'lucide-react';

interface GeoTimelineViewProps {
  locations: GeoMarker[];
  timeline: TimelineEvent[];
  onAddManualLocation: (loc: Omit<GeoMarker, 'id'>) => void;
}

export const GeoTimelineView: React.FC<GeoTimelineViewProps> = ({
  locations,
  timeline,
  onAddManualLocation,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const [timelineFilter, setTimelineFilter] = useState<string>('all');
  const [showAddLoc, setShowAddLoc] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');
  const [newLat, setNewLat] = useState('40.4168');
  const [newLng, setNewLng] = useState('-3.7038');

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [34.0, -4.0],
      zoom: 3,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    const layerGroup = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;
    markersLayerRef.current = layerGroup;

    // Ensure proper Leaflet sizing
    setTimeout(() => {
      map.invalidateSize();
    }, 150);

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markersLayerRef.current = null;
    };
  }, []);

  // Sync Markers whenever `locations` changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    const bounds: L.LatLngTuple[] = [];

    locations.forEach((loc) => {
      const color =
        loc.confidence >= 75
          ? '#10b981'
          : loc.confidence >= 50
          ? '#f59e0b'
          : '#ef4444';

      const marker = L.circleMarker([loc.lat, loc.lng], {
        radius: 9,
        fillColor: color,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.88,
      });

      marker.bindPopup(`
        <div style="min-width:200px;font-family:'Plus Jakarta Sans',sans-serif;">
          <div style="font-size:11px;color:#94a3b8;margin-bottom:2px;">${loc.source} · Confianza ${loc.confidence}/100</div>
          <div style="font-weight:700;font-size:13px;color:#f8fafc;margin-bottom:4px;">${loc.title}</div>
          <div style="font-size:12px;color:#cbd5e1;margin-bottom:6px;">${loc.subtitle}</div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#38bdf8;">
            LAT: ${loc.lat.toFixed(4)} | LNG: ${loc.lng.toFixed(4)}
          </div>
        </div>
      `);

      marker.addTo(layer);
      bounds.push([loc.lat, loc.lng]);
    });

    if (bounds.length > 0) {
      try {
        map.fitBounds(bounds, { padding: [45, 45], maxZoom: 6 });
      } catch {
        // Ignore bounds error on rapid resize
      }
    }
  }, [locations]);

  const handleFlyTo = (lat: number, lng: number) => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo([lat, lng], 7, { duration: 1.1 });
    }
  };

  const filteredTimeline = [...timeline]
    .filter((ev) => timelineFilter === 'all' || ev.category === timelineFilter)
    .sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="space-y-6">
      {/* Top Section: Interactive Leaflet Map & Geo Intelligence List */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col h-[460px]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-red-400" />
              <h3 className="text-sm font-semibold text-white">
                Mapa de Inteligencia Geográfica (Leaflet.js)
              </h3>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span className="font-mono">{locations.length} coordenadas extraídas</span>
              <button
                onClick={() => setShowAddLoc(!showAddLoc)}
                className="flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                Añadir Coordenada
              </button>
            </div>
          </div>

          <div className="relative flex-1 w-full h-full">
            <div ref={mapContainerRef} className="w-full h-full z-0" />

            {showAddLoc && (
              <div className="absolute top-3 right-3 z-[1000] bg-slate-900/95 border border-slate-700 rounded-xl p-4 w-72 space-y-3 shadow-xl">
                <h4 className="text-xs font-semibold text-white">Nueva Coordenada Manual</h4>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Ciudad / Lugar (ej. Valencia, ES)"
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded text-white"
                />
                <input
                  type="text"
                  value={newSubtitle}
                  onChange={(e) => setNewSubtitle(e.target.value)}
                  placeholder="Contexto / Evidencia"
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded text-white"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.0001"
                    value={newLat}
                    onChange={(e) => setNewLat(e.target.value)}
                    placeholder="Latitud"
                    className="w-full px-2.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded text-white font-mono"
                  />
                  <input
                    type="number"
                    step="0.0001"
                    value={newLng}
                    onChange={(e) => setNewLng(e.target.value)}
                    placeholder="Longitud"
                    className="w-full px-2.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded text-white font-mono"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowAddLoc(false)}
                    className="px-2.5 py-1 text-xs text-slate-400 hover:text-white"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={() => {
                      const lat = parseFloat(newLat);
                      const lng = parseFloat(newLng);
                      if (!isNaN(lat) && !isNaN(lng) && newTitle.trim()) {
                        onAddManualLocation({
                          lat,
                          lng,
                          title: newTitle.trim(),
                          subtitle: newSubtitle.trim() || 'Marcador añadido por el analista',
                          category: 'profile_location',
                          confidence: 90,
                          source: 'Analista OSINT',
                        });
                        setNewTitle('');
                        setNewSubtitle('');
                        setShowAddLoc(false);
                      }
                    }}
                    className="px-3 py-1 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded"
                  >
                    Guardar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Geo Locations Sidebar */}
        <div className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col h-[460px]">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-white">Ubicaciones Detectadas</h3>
            <span className="text-xs text-slate-400 font-mono">{locations.length} puntos</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/80 mt-2 pr-1">
            {locations.map((loc) => (
              <button
                key={loc.id}
                onClick={() => handleFlyTo(loc.lat, loc.lng)}
                className="w-full text-left py-3 px-2 hover:bg-slate-800/50 rounded-lg transition-colors space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    {loc.title}
                  </span>
                  <span
                    className={`text-xs font-mono font-semibold tabular-nums ${
                      loc.confidence >= 75
                        ? 'text-emerald-400'
                        : loc.confidence >= 50
                        ? 'text-amber-400'
                        : 'text-red-400'
                    }`}
                  >
                    {loc.confidence}%
                  </span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{loc.subtitle}</p>
                <div className="text-[11px] font-mono text-slate-500">
                  {loc.source} · {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom Section: Chronological Timeline */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-red-400" />
            <h3 className="text-base font-semibold text-white">
              Línea de Tiempo Cronológica de Evidencias ({filteredTimeline.length})
            </h3>
          </div>

          {/* Interactive Filter Controls */}
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            {[
              { id: 'all', label: 'Todos los Hitos' },
              { id: 'account', label: 'Creación Cuentas' },
              { id: 'domain_whois', label: 'RDAP / WHOIS' },
              { id: 'certificate', label: 'Certificados crt.sh' },
              { id: 'breach', label: 'Brechas' },
              { id: 'network', label: 'Red / Shodan' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setTimelineFilter(tab.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  timelineFilter === tab.id
                    ? 'bg-red-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chronological Event Stream */}
        <div className="divide-y divide-slate-800/80">
          {filteredTimeline.map((ev, index) => (
            <div
              key={ev.id}
              className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-800/30 px-3 rounded-lg transition-colors"
            >
              <div className="flex items-start gap-4">
                <div className="font-mono text-xs text-slate-400 tabular-nums w-28 shrink-0 pt-0.5">
                  <span className="text-slate-500 mr-1.5">#{String(index + 1).padStart(2, '0')}</span>
                  {ev.date}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-sm font-semibold text-slate-100">{ev.title}</h4>
                    <span className="text-xs text-slate-400">
                      · {ev.sourcePlatform} · Confianza {ev.confidence}/100
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">{ev.description}</p>
                </div>
              </div>

              {ev.sourceUrl && (
                <a
                  href={ev.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-red-400 hover:text-red-300 whitespace-nowrap shrink-0"
                >
                  Ver Fuente
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
