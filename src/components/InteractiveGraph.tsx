import React, { useEffect, useRef, useState } from 'react';
import {
  ClusterGroupMode,
  EntityType,
  GraphEdge,
  GraphNode,
  InputType,
} from '../types/osint';
import {
  CheckCircle2,
  Compass,
  Download,
  ExternalLink,
  Filter,
  Layers,
  Maximize2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Target,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

interface InteractiveGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelectNode: (node: GraphNode | null) => void;
  selectedNode: GraphNode | null;
  onUpdateNodeStatus: (nodeId: string, status: GraphNode['verifiedStatus']) => void;
  onPivotFromNode: (query: string, type: InputType) => void;
  onAddManualNode: (label: string, type: EntityType, platform: string, relationToSeed: string) => void;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  groupKey: string;
}

const TYPE_COLOR_MAP: Record<EntityType, { fill: string; stroke: string; label: string }> = {
  seed: { fill: '#ef4444', stroke: '#fca5a5', label: 'Semilla Principal' },
  username: { fill: '#3b82f6', stroke: '#93c5fd', label: 'Nombre de Usuario' },
  social_profile: { fill: '#0ea5e9', stroke: '#7dd3fc', label: 'Perfil Social' },
  alias_variant: { fill: '#8b5cf6', stroke: '#c4b5fd', label: 'Familia de Alias' },
  email: { fill: '#f59e0b', stroke: '#fde68a', label: 'Correo Electrónico' },
  breach: { fill: '#dc2626', stroke: '#fca5a5', label: 'Brecha de Datos' },
  domain: { fill: '#10b981', stroke: '#6ee7b7', label: 'Dominio Web' },
  subdomain: { fill: '#14b8a6', stroke: '#5eead4', label: 'Subdominio (crt.sh)' },
  dns_record: { fill: '#06b6d4', stroke: '#67e8f9', label: 'Registro DNS' },
  ip: { fill: '#6366f1', stroke: '#a5b4fc', label: 'Dirección IP' },
  port_vuln: { fill: '#ec4899', stroke: '#f9a8d4', label: 'Puertos / Shodan' },
  phone: { fill: '#84cc16', stroke: '#bef264', label: 'Teléfono E.164' },
  real_name: { fill: '#eab308', stroke: '#fef08a', label: 'Nombre Real' },
  national_id: { fill: '#f97316', stroke: '#fdba74', label: 'ID Nacional / DNI' },
  location: { fill: '#22c55e', stroke: '#86efac', label: 'Ubicación Geo' },
  dork_query: { fill: '#64748b', stroke: '#cbd5e1', label: 'Dork / Búsqueda' },
};

const BUBBLE_PALETTE = [
  { bg: 'rgba(59, 130, 246, 0.09)', border: 'rgba(96, 165, 250, 0.45)', text: '#93c5fd' },
  { bg: 'rgba(16, 185, 129, 0.09)', border: 'rgba(52, 211, 153, 0.45)', text: '#6ee7b7' },
  { bg: 'rgba(139, 92, 246, 0.09)', border: 'rgba(167, 139, 250, 0.45)', text: '#c4b5fd' },
  { bg: 'rgba(245, 158, 11, 0.09)', border: 'rgba(251, 191, 36, 0.45)', text: '#fde68a' },
  { bg: 'rgba(236, 72, 153, 0.09)', border: 'rgba(244, 114, 182, 0.45)', text: '#f9a8d4' },
  { bg: 'rgba(20, 184, 166, 0.09)', border: 'rgba(45, 212, 191, 0.45)', text: '#5eead4' },
  { bg: 'rgba(239, 68, 68, 0.09)', border: 'rgba(248, 113, 113, 0.45)', text: '#fca5a5' },
];

export const InteractiveGraph: React.FC<InteractiveGraphProps> = ({
  nodes,
  edges,
  onSelectNode,
  selectedNode,
  onUpdateNodeStatus,
  onPivotFromNode,
  onAddManualNode,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [clusterMode, setClusterMode] = useState<ClusterGroupMode>('type');
  const [minConfidence, setMinConfidence] = useState<number>(0);
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newNodeLabel, setNewNodeLabel] = useState('');
  const [newNodeType, setNewNodeType] = useState<EntityType>('social_profile');
  const [newNodePlatform, setNewNodePlatform] = useState('Manual OSINT');
  const [newNodeRelation, setNewNodeRelation] = useState('vinculo_manual');

  // Viewport transform state
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const simNodesRef = useRef<SimNode[]>([]);
  const draggingNodeRef = useRef<SimNode | null>(null);
  const isPanningRef = useRef<boolean>(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [, setTick] = useState(0);

  // Filter nodes & edges
  const filteredNodes = nodes.filter((n) => {
    if (n.type === 'seed') return true;
    if (n.confidence.total < minConfidence) return false;
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      return (
        n.label.toLowerCase().includes(q) ||
        n.platform.toLowerCase().includes(q) ||
        n.category.toLowerCase().includes(q) ||
        n.aliasFamily.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const visibleIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

  const getGroupKey = (n: GraphNode, mode: ClusterGroupMode): string => {
    if (mode === 'none') return 'Grafo General';
    if (mode === 'type') return TYPE_COLOR_MAP[n.type]?.label || n.category;
    if (mode === 'platform') return n.platform || 'General';
    if (mode === 'alias_family') return n.aliasFamily || 'Raíz Exacta';
    return 'General';
  };

  // Initialize / sync simulation nodes when props or clusterMode change
  useEffect(() => {
    const width = containerRef.current?.clientWidth || 960;
    const height = containerRef.current?.clientHeight || 600;
    const cx = width / 2;
    const cy = height / 2;

    const existingMap = new Map<string, SimNode>();
    simNodesRef.current.forEach((sn) => existingMap.set(sn.id, sn));

    const groups = Array.from(new Set(filteredNodes.map((n) => getGroupKey(n, clusterMode))));

    simNodesRef.current = filteredNodes.map((n, idx) => {
      const prev = existingMap.get(n.id);
      const groupKey = getGroupKey(n, clusterMode);
      const gIdx = Math.max(0, groups.indexOf(groupKey));
      const angle = (2 * Math.PI * gIdx) / Math.max(1, groups.length) + idx * 0.35;
      const dist = n.type === 'seed' ? 0 : 180 + (idx % 4) * 35;

      return {
        ...n,
        groupKey,
        radius: n.type === 'seed' ? 26 : 19,
        x: prev ? prev.x : cx + Math.cos(angle) * dist,
        y: prev ? prev.y : cy + Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
      };
    });
  }, [nodes, edges, clusterMode, minConfidence, searchFilter]);

  // Physics + Canvas Render Loop
  useEffect(() => {
    let animationFrameId: number;

    const renderLoop = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const width = container.clientWidth;
      const height = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const sNodes = simNodesRef.current;
      const cx = width / 2;
      const cy = height / 2;

      // Compute group centers for Bubble Clustering
      const groupKeys = Array.from(
        new Set(sNodes.filter((n) => n.type !== 'seed').map((n) => n.groupKey))
      );
      const groupTargets = new Map<string, { x: number; y: number }>();
      groupKeys.forEach((gk, i) => {
        const angle = (2 * Math.PI * i) / Math.max(1, groupKeys.length) - Math.PI / 4;
        const r = clusterMode === 'none' ? 0 : Math.min(width, height) * 0.31;
        groupTargets.set(gk, {
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
        });
      });

      // Physics forces
      for (let i = 0; i < sNodes.length; i++) {
        const a = sNodes[i];
        if (a === draggingNodeRef.current || a.pinned) continue;

        if (a.type === 'seed') {
          a.vx += (cx - a.x) * 0.08;
          a.vy += (cy - a.y) * 0.08;
        } else if (clusterMode !== 'none') {
          const gt = groupTargets.get(a.groupKey);
          if (gt) {
            a.vx += (gt.x - a.x) * 0.025;
            a.vy += (gt.y - a.y) * 0.025;
          }
        } else {
          a.vx += (cx - a.x) * 0.008;
          a.vy += (cy - a.y) * 0.008;
        }

        // Node-to-node repulsion
        for (let j = i + 1; j < sNodes.length; j++) {
          const b = sNodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distSq = dx * dx + dy * dy || 1;
          const minDist = clusterMode !== 'none' && a.groupKey === b.groupKey ? 95 : 135;
          if (distSq < minDist * minDist) {
            const dist = Math.sqrt(distSq);
            const force = ((minDist - dist) / dist) * 0.14;
            const fx = dx * force;
            const fy = dy * force;
            if (a !== draggingNodeRef.current && !a.pinned) {
              a.vx -= fx;
              a.vy -= fy;
            }
            if (b !== draggingNodeRef.current && !b.pinned) {
              b.vx += fx;
              b.vy += fy;
            }
          }
        }
      }

      // Edge spring attraction
      const nodeById = new Map<string, SimNode>();
      sNodes.forEach((n) => nodeById.set(n.id, n));

      for (const edge of filteredEdges) {
        const s = nodeById.get(edge.source);
        const t = nodeById.get(edge.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetLen = clusterMode === 'none' ? 165 : 195;
        const force = (dist - targetLen) * 0.012;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (s !== draggingNodeRef.current && !s.pinned && s.type !== 'seed') {
          s.vx += fx;
          s.vy += fy;
        }
        if (t !== draggingNodeRef.current && !t.pinned && t.type !== 'seed') {
          t.vx -= fx;
          t.vy -= fy;
        }
      }

      // Apply velocities with damping
      for (const n of sNodes) {
        if (n === draggingNodeRef.current || n.pinned) continue;
        n.vx *= 0.78;
        n.vy *= 0.78;
        n.x += n.vx;
        n.y += n.vy;
      }

      // Clear & Draw
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      // Subtle technical grid background
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
      ctx.lineWidth = 1;
      const gridStep = 36;
      for (let gx = 0; gx < width; gx += gridStep) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, height);
        ctx.stroke();
      }
      for (let gy = 0; gy < height; gy += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
      }

      // Apply Pan & Zoom transform
      ctx.translate(transformRef.current.x, transformRef.current.y);
      ctx.scale(transformRef.current.scale, transformRef.current.scale);

      // 1. Draw Cluster Bubbles ("Burbujas") when clusterMode !== 'none'
      if (clusterMode !== 'none') {
        groupKeys.forEach((gk, gIdx) => {
          const members = sNodes.filter((n) => n.groupKey === gk && n.type !== 'seed');
          if (members.length === 0) return;

          const meanX = members.reduce((s, m) => s + m.x, 0) / members.length;
          const meanY = members.reduce((s, m) => s + m.y, 0) / members.length;
          let maxDist = 52;
          members.forEach((m) => {
            const d = Math.hypot(m.x - meanX, m.y - meanY) + m.radius + 32;
            if (d > maxDist) maxDist = d;
          });

          const palette = BUBBLE_PALETTE[gIdx % BUBBLE_PALETTE.length];
          ctx.beginPath();
          ctx.arc(meanX, meanY, maxDist, 0, Math.PI * 2);
          ctx.fillStyle = palette.bg;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = palette.border;
          ctx.stroke();
          ctx.setLineDash([]);

          // Bubble Header Label
          ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = palette.text;
          ctx.textAlign = 'center';
          ctx.fillText(`${gk.toUpperCase()} (${members.length})`, meanX, meanY - maxDist + 16);
        });
      }

      // 2. Draw Edges & Relationship Labels
      for (const edge of filteredEdges) {
        const s = nodeById.get(edge.source);
        const t = nodeById.get(edge.target);
        if (!s || !t) continue;

        const isSelectedEdge =
          selectedNode && (selectedNode.id === s.id || selectedNode.id === t.id);

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.strokeStyle = isSelectedEdge
          ? 'rgba(248, 113, 113, 0.85)'
          : t.confidence.total < 50
          ? 'rgba(248, 113, 113, 0.35)'
          : 'rgba(148, 163, 184, 0.32)';
        ctx.lineWidth = isSelectedEdge ? 2.2 : 1.3;
        if (t.confidence.total < 50) {
          ctx.setLineDash([4, 4]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Midpoint relationship label
        const mx = (s.x + t.x) / 2;
        const my = (s.y + t.y) / 2;
        ctx.font = '500 9.5px "JetBrains Mono", monospace';
        ctx.fillStyle = isSelectedEdge ? '#fca5a5' : 'rgba(148, 163, 184, 0.78)';
        ctx.textAlign = 'center';
        ctx.fillText(edge.relation, mx, my - 4);
      }

      // 3. Draw Nodes & Confidence Score Halos
      for (const n of sNodes) {
        const theme = TYPE_COLOR_MAP[n.type] || TYPE_COLOR_MAP.username;
        const isSelected = selectedNode?.id === n.id;

        // Outer Selection or Confidence Halo
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius + (isSelected ? 7 : 4), 0, Math.PI * 2);
        if (isSelected) {
          ctx.strokeStyle = '#f87171';
          ctx.lineWidth = 2.5;
        } else if (n.confidence.total >= 75) {
          ctx.strokeStyle = 'rgba(34, 197, 94, 0.55)';
          ctx.lineWidth = 2;
        } else if (n.confidence.total >= 50) {
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
          ctx.lineWidth = 1.8;
        } else {
          ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
          ctx.lineWidth = 1.8;
          ctx.setLineDash([3, 3]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Node Circle Body
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx.fillStyle = theme.fill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = theme.stroke;
        ctx.stroke();

        // Confidence Score Inside Node (Tabular Mono)
        ctx.font = n.type === 'seed' ? '700 11px "JetBrains Mono", monospace' : '600 10px "JetBrains Mono", monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.type === 'seed' ? 'SEED' : `${n.confidence.total}%`, n.x, n.y);

        // Node Title Label below
        ctx.font = '600 11.5px "Plus Jakarta Sans", sans-serif';
        ctx.fillStyle = '#f8fafc';
        ctx.textBaseline = 'top';
        ctx.fillText(n.label.length > 26 ? n.label.slice(0, 24) + '…' : n.label, n.x, n.y + n.radius + 7);

        // Platform Subtitle
        ctx.font = '400 9.5px "Plus Jakarta Sans", sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(n.platform, n.x, n.y + n.radius + 21);
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [filteredEdges, selectedNode, clusterMode]);

  // Canvas Mouse Handlers (Select, Drag, Pan, Double-Click Pivot)
  const screenToWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { wx: 0, wy: 0 };
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const wx = (sx - transformRef.current.x) / transformRef.current.scale;
    const wy = (sy - transformRef.current.y) / transformRef.current.scale;
    return { wx, wy };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    const clicked = [...simNodesRef.current]
      .reverse()
      .find((n) => Math.hypot(n.x - wx, n.y - wy) <= n.radius + 6);

    if (clicked) {
      draggingNodeRef.current = clicked;
      onSelectNode(clicked);
    } else {
      isPanningRef.current = true;
      panStartRef.current = {
        x: e.clientX - transformRef.current.x,
        y: e.clientY - transformRef.current.y,
      };
      onSelectNode(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingNodeRef.current) {
      const { wx, wy } = screenToWorld(e.clientX, e.clientY);
      draggingNodeRef.current.x = wx;
      draggingNodeRef.current.y = wy;
      draggingNodeRef.current.pinned = true;
    } else if (isPanningRef.current) {
      transformRef.current.x = e.clientX - panStartRef.current.x;
      transformRef.current.y = e.clientY - panStartRef.current.y;
    }
  };

  const handleMouseUp = () => {
    draggingNodeRef.current = null;
    isPanningRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const nextScale = Math.min(2.4, Math.max(0.45, transformRef.current.scale * factor));
    transformRef.current.scale = nextScale;
    setTick((t) => t + 1);
  };

  const handleResetView = () => {
    transformRef.current = { x: 0, y: 0, scale: 1 };
    simNodesRef.current.forEach((n) => {
      n.pinned = false;
    });
    setTick((t) => t + 1);
  };

  const handleExportGraphPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `Grafo_OSINT_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  };

  const inferPivotType = (node: GraphNode): { query: string; type: InputType } => {
    if (node.type === 'domain' || node.type === 'subdomain') {
      return { query: node.label.replace(/^RDAP:\s*/i, ''), type: 'domain' };
    }
    if (node.type === 'ip') return { query: node.label, type: 'ip' };
    if (node.type === 'email') return { query: node.label, type: 'email' };
    if (node.type === 'phone') return { query: String(node.metadata.formatoE164 || node.label), type: 'phone' };
    const clean = node.label.includes(':') ? node.label.split(':').pop()!.trim() : node.label;
    return { query: clean, type: 'username' };
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[640px]">
      {/* Main Interactive Graph Viewport */}
      <div
        ref={containerRef}
        className="lg:col-span-8 xl:col-span-9 relative bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col"
      >
        {/* Top Graph Toolbar: Bubble Clustering & Filters */}
        <div className="z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-900/95 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-xs font-medium text-slate-300 whitespace-nowrap">Agrupar en Burbujas:</span>
            <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
              {(
                [
                  { id: 'type', label: 'Por Tipo' },
                  { id: 'platform', label: 'Por Plataforma' },
                  { id: 'alias_family', label: 'Por Familia de Alias' },
                  { id: 'none', label: 'Sin Agrupar' },
                ] as Array<{ id: ClusterGroupMode; label: string }>
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setClusterMode(tab.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    clusterMode === tab.id
                      ? 'bg-red-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Confidence Score Filter */}
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <Filter className="w-3.5 h-3.5 text-slate-400" />
              <span className="whitespace-nowrap">Score Mín:</span>
              <input
                type="range"
                min={0}
                max={80}
                step={10}
                value={minConfidence}
                onChange={(e) => setMinConfidence(Number(e.target.value))}
                className="w-20 accent-red-500 cursor-pointer"
              />
              <span className="font-mono tabular-nums text-slate-200 w-8">{minConfidence}%</span>
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filtrar nodo..."
                className="pl-8 pr-3 py-1 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-red-500 w-36"
              />
            </div>

            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Añadir Nodo
            </button>
          </div>
        </div>

        {/* Interactive HTML5 Canvas */}
        <div className="relative flex-1 w-full h-full">
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onWheel={handleWheel}
            className="w-full h-full cursor-grab active:cursor-grabbing block"
          />

          {/* Floating Zoom & Export Controls */}
          <div className="absolute bottom-4 left-4 flex items-center gap-1.5 bg-slate-900/90 border border-slate-800 rounded-lg p-1.5">
            <button
              onClick={() => {
                transformRef.current.scale = Math.min(2.4, transformRef.current.scale * 1.15);
                setTick((t) => t + 1);
              }}
              title="Acercar"
              className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                transformRef.current.scale = Math.max(0.45, transformRef.current.scale * 0.85);
                setTick((t) => t + 1);
              }}
              title="Alejar"
              className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={handleResetView}
              title="Centrar y Liberar Nodos"
              className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleExportGraphPng}
              title="Exportar Captura del Grafo (PNG)"
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              PNG
            </button>
          </div>

          {/* Legend */}
          <div className="absolute bottom-4 right-4 hidden sm:flex items-center gap-4 px-3 py-2 bg-slate-900/90 border border-slate-800 rounded-lg text-xs text-slate-300">
            <span className="text-slate-400">Halo Confianza:</span>
            <span className="text-emerald-400 font-mono">≥75% Real</span>
            <span className="text-amber-400 font-mono">50–74% Medio</span>
            <span className="text-red-400 font-mono">&lt;50% Homónimo</span>
          </div>
        </div>

        {/* Manual Node Modal */}
        {showAddModal && (
          <div className="absolute inset-0 z-30 bg-slate-950/80 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 w-full max-w-md space-y-4">
              <h3 className="text-base font-semibold text-white">Añadir Evidencia Manual al Grafo</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Identificador / Valor del Nodo</label>
                  <input
                    type="text"
                    value={newNodeLabel}
                    onChange={(e) => setNewNodeLabel(e.target.value)}
                    placeholder="Ej. t.me/unfantasma_canal o 185.199.108.153"
                    className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Tipo de Entidad</label>
                    <select
                      value={newNodeType}
                      onChange={(e) => setNewNodeType(e.target.value as EntityType)}
                      className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-white"
                    >
                      <option value="social_profile">Perfil Social</option>
                      <option value="domain">Dominio Web</option>
                      <option value="ip">Dirección IP</option>
                      <option value="email">Correo Electrónico</option>
                      <option value="phone">Teléfono</option>
                      <option value="alias_variant">Alias Relacionado</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Plataforma / Fuente</label>
                    <input
                      type="text"
                      value={newNodePlatform}
                      onChange={(e) => setNewNodePlatform(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-white"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Relación con la Semilla</label>
                  <input
                    type="text"
                    value={newNodeRelation}
                    onChange={(e) => setNewNodeRelation(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-white font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    if (newNodeLabel.trim()) {
                      onAddManualNode(newNodeLabel.trim(), newNodeType, newNodePlatform, newNodeRelation);
                      setNewNodeLabel('');
                      setShowAddModal(false);
                    }
                  }}
                  className="px-4 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg"
                >
                  Insertar en el Grafo
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right Node Inspector & Confidence Breakdown Panel */}
      <div className="lg:col-span-4 xl:col-span-3 bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between overflow-y-auto">
        {selectedNode ? (
          <div className="space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <div className="text-xs text-slate-400">
                {selectedNode.platform} · {selectedNode.category}
              </div>
              <h3 className="text-base font-semibold text-white mt-0.5 break-words">{selectedNode.label}</h3>
              {selectedNode.subtitle && (
                <p className="text-xs text-slate-400 mt-0.5">{selectedNode.subtitle}</p>
              )}
            </div>

            {/* Confidence Score Breakdown (0-100) */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">Puntuación de Confianza</span>
                <span
                  className={`text-sm font-mono font-bold tabular-nums ${
                    selectedNode.confidence.total >= 75
                      ? 'text-emerald-400'
                      : selectedNode.confidence.total >= 50
                      ? 'text-amber-400'
                      : 'text-red-400'
                  }`}
                >
                  {selectedNode.confidence.total} / 100
                </span>
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${
                    selectedNode.confidence.total >= 75
                      ? 'bg-emerald-500'
                      : selectedNode.confidence.total >= 50
                      ? 'bg-amber-500'
                      : 'bg-red-500'
                  }`}
                  style={{ width: `${selectedNode.confidence.total}%` }}
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[11px] text-slate-400 font-mono pt-1">
                <div>Handle: {selectedNode.confidence.handleMatch}/30</div>
                <div>Alias: {selectedNode.confidence.aliasSimilarity}/20</div>
                <div>Bio/Nombre: {selectedNode.confidence.bioNameMatch}/20</div>
                <div>Geo/Dominio: {selectedNode.confidence.geoMatch + selectedNode.confidence.avatarDomainMatch}/30</div>
              </div>

              <div className="space-y-1 pt-1 border-t border-slate-800/80">
                {selectedNode.confidence.reasons.map((r, i) => (
                  <p key={i} className="text-[11px] text-slate-300 leading-relaxed">
                    • {r}
                  </p>
                ))}
              </div>
            </div>

            {/* Verification Status Controls */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-slate-400 block">Clasificación del Analista</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => onUpdateNodeStatus(selectedNode.id, 'verified')}
                  className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                    selectedNode.verifiedStatus === 'verified'
                      ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Perfil Real
                </button>
                <button
                  onClick={() => onUpdateNodeStatus(selectedNode.id, 'false_positive')}
                  className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                    selectedNode.verifiedStatus === 'false_positive'
                      ? 'bg-red-950/60 border-red-500/60 text-red-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Homónimo
                </button>
              </div>
            </div>

            {/* Metadata Key-Value Table */}
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-slate-400 block">Atributos y Metadatos Técnicos</span>
              <div className="bg-slate-950 border border-slate-800 rounded-lg divide-y divide-slate-800/70">
                {Object.entries(selectedNode.metadata).map(([k, v]) => (
                  <div key={k} className="px-3 py-1.5 flex justify-between gap-3 text-xs">
                    <span className="text-slate-400 capitalize">{k}</span>
                    <span className="text-slate-200 font-mono text-right break-all">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions: Open External Link & Pivot OSINT Scan */}
            <div className="space-y-2 pt-2">
              {selectedNode.url && (
                <a
                  href={selectedNode.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Abrir Evidencia Externa
                </a>
              )}

              {selectedNode.type !== 'seed' && (
                <button
                  onClick={() => {
                    const pivot = inferPivotType(selectedNode);
                    onPivotFromNode(pivot.query, pivot.type);
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Pivotar Investigación desde Nodo
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-4 space-y-3">
            <Target className="w-8 h-8 text-slate-500" />
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-slate-200">Inspector de Evidencias</h4>
              <p className="text-xs text-slate-400 leading-relaxed">
                Haz clic sobre cualquier nodo del grafo para auditar su Puntuación de Confianza (0–100), verificar si es un perfil real o un homónimo, y pivotar la investigación.
              </p>
            </div>
            <div className="w-full pt-4 border-t border-slate-800 text-left space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>Nodos Visibles:</span>
                <span className="font-mono text-slate-200">{filteredNodes.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Relaciones Activas:</span>
                <span className="font-mono text-slate-200">{filteredEdges.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Modo de Agrupación:</span>
                <span className="font-mono text-red-400">{clusterMode}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
