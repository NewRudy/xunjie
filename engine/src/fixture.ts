// 园区 fixture 加载 + 语义树节点注册表（合同 semantic-tree.md §1）
// 所有 nodeId 校验都走这里；未知 ID → 404（合同 engine-io.md 通用约定）。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Fixture {
  id: string;
  name: string;
  fictional: boolean;
  prototypeNote: string;
  anchor: { lat: number; lon: number; altM: number };
  gridConnection: Record<string, unknown>;
  buildings: any[];
  roofs: any[];
  pvArrays: any[];
  inverters: any[];
  strings: any[];
  junctionBoxes: any[];
  ess: any;
  chargers: any[];
  transformer: any;
  mainMeter: any;
  subMeters: any[];
  weatherStation: any;
  opsPoint: any;
  loadProfile: any;
  roads: any[];
  checkpoints: any[];
  demoAnomaly: any;
}

const fixturePath = fileURLToPath(new URL('../../data/fixtures/park-pecc-01.json', import.meta.url));
export const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

export type NodeType =
  | 'park' | 'building' | 'roof' | 'pvArray' | 'inverter' | 'string' | 'junctionBox'
  | 'ess' | 'essCabinet' | 'charger' | 'transformer' | 'meter' | 'weatherStation'
  | 'opsPoint' | 'checkpoint';

export interface NodeInfo {
  id: string;
  type: NodeType;
  parentId: string | null;
  children: string[];
  raw: any;
}

const nodes = new Map<string, NodeInfo>();

function register(id: string, type: NodeType, parentId: string | null, raw: any): void {
  if (nodes.has(id)) throw new Error(`fixture 节点 ID 重复: ${id}`);
  nodes.set(id, { id, type, parentId, children: [], raw });
  if (parentId) nodes.get(parentId)!.children.push(id);
}

// —— 按语义树层级注册 ——
register(fixture.id, 'park', null, { name: fixture.name, fictional: fixture.fictional });

for (const b of fixture.buildings) register(b.id, 'building', fixture.id, b);
for (const r of fixture.roofs) register(r.id, 'roof', r.buildingId, r);
for (const p of fixture.pvArrays) register(p.id, 'pvArray', p.roofId ?? fixture.id, p); // 车棚子阵与楼栋同级（语义树 §1）
for (const inv of fixture.inverters) register(inv.id, 'inverter', inv.pvArrayId, inv);
for (const s of fixture.strings) register(s.id, 'string', s.inverterId, s);
for (const j of fixture.junctionBoxes) register(j.id, 'junctionBox', j.pvArrayId, j);
register(fixture.ess.id, 'ess', fixture.id, fixture.ess);
for (const c of fixture.ess.cabinets) register(c.id, 'essCabinet', fixture.ess.id, c);
for (const c of fixture.chargers) register(c.id, 'charger', fixture.id, c);
register(fixture.transformer.id, 'transformer', fixture.id, fixture.transformer);
register(fixture.mainMeter.id, 'meter', fixture.id, fixture.mainMeter);
for (const m of fixture.subMeters) register(m.id, 'meter', m.buildingId, m);
register(fixture.weatherStation.id, 'weatherStation', fixture.id, fixture.weatherStation);
register(fixture.opsPoint.id, 'opsPoint', fixture.id, fixture.opsPoint);
for (const cp of fixture.checkpoints) register(cp.id, 'checkpoint', cp.nodeId, cp);

export const nodeRegistry = nodes;
export const hasNode = (id: string): boolean => nodes.has(id);
export const getNode = (id: string): NodeInfo | undefined => nodes.get(id);
export const allNodeIds = (): string[] => [...nodes.keys()];

/** 子树是否包含某节点（异常连带汇总用） */
export function subtreeContains(rootId: string, targetId: string): boolean {
  if (rootId === targetId) return true;
  const root = nodes.get(rootId);
  if (!root) return false;
  return root.children.some((c) => subtreeContains(c, targetId));
}

/** 楼栋/屋顶 → 光伏子阵（无则 null） */
export function pvArrayOfNode(nodeId: string): any | null {
  const n = nodes.get(nodeId);
  if (!n) return null;
  if (n.type === 'pvArray') return n.raw;
  if (n.type === 'roof') return fixture.pvArrays.find((p) => p.roofId === nodeId) ?? null;
  if (n.type === 'building') {
    const roof = fixture.roofs.find((r) => r.buildingId === nodeId);
    return roof ? fixture.pvArrays.find((p) => p.roofId === roof.id) ?? null : null;
  }
  return null;
}
