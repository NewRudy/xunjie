// 登记道路寻路：只在 fixture.roads 折线网络上行走（不穿建筑），
// 起终点经最近投影接入路网，末端保留一段“接近检查点”的短直线路。
// 全部几何数据来自 fixture，不硬编码第二份坐标。
import { fixture } from '../fixture'

type Pt = [number, number]

interface Node {
  p: Pt
  adj: Array<{ to: number; w: number }>
}

const nodes: Node[] = []

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function nodeIndexAt(p: Pt): number {
  // 折线顶点共享点合并（容差 1cm）
  const i = nodes.findIndex((n) => dist(n.p, p) < 0.01)
  if (i >= 0) return i
  nodes.push({ p, adj: [] })
  return nodes.length - 1
}

function link(a: number, b: number): void {
  const w = dist(nodes[a].p, nodes[b].p)
  nodes[a].adj.push({ to: b, w })
  nodes[b].adj.push({ to: a, w })
}

// 建图：每条道路折线的相邻顶点连边
for (const road of fixture.roads) {
  for (let i = 0; i < road.polyline.length - 1; i++) {
    link(nodeIndexAt(road.polyline[i]), nodeIndexAt(road.polyline[i + 1]))
  }
}

/** 点 p 在线段 ab 上的投影 */
function project(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return [a[0] + t * dx, a[1] + t * dy]
}

/** 把点接入路网：找到最近投影点，拆分所在线段，返回新节点索引 */
function attach(p: Pt): number {
  let best: { roadSeg: [Pt, Pt]; proj: Pt; d: number } | null = null
  for (const road of fixture.roads) {
    for (let i = 0; i < road.polyline.length - 1; i++) {
      const a = road.polyline[i]
      const b = road.polyline[i + 1]
      const proj = project(p, a, b)
      const d = dist(p, proj)
      if (!best || d < best.d) best = { roadSeg: [a, b], proj, d }
    }
  }
  if (!best) throw new Error('fixture 中无道路')
  const idx = nodeIndexAt(best.proj)
  // 已存在的顶点（共享路口）无需再拆边
  if (nodes[idx].adj.length === 0 || dist(best.proj, best.roadSeg[0]) > 0.01 && dist(best.proj, best.roadSeg[1]) > 0.01) {
    const a = nodeIndexAt(best.roadSeg[0])
    const b = nodeIndexAt(best.roadSeg[1])
    if (a !== idx) link(idx, a)
    if (b !== idx) link(idx, b)
  }
  return idx
}

/** Dijkstra：返回途经节点坐标序列 */
function dijkstra(from: number, to: number): Pt[] {
  const distTo = new Array<number>(nodes.length).fill(Infinity)
  const prev = new Array<number>(nodes.length).fill(-1)
  distTo[from] = 0
  const visited = new Set<number>()
  for (;;) {
    let u = -1
    for (let i = 0; i < nodes.length; i++) {
      if (!visited.has(i) && (u < 0 || distTo[i] < distTo[u])) u = i
    }
    if (u < 0 || u === to || distTo[u] === Infinity) break
    visited.add(u)
    for (const e of nodes[u].adj) {
      const nd = distTo[u] + e.w
      if (nd < distTo[e.to]) {
        distTo[e.to] = nd
        prev[e.to] = u
      }
    }
  }
  if (distTo[to] === Infinity) return []
  const path: Pt[] = []
  for (let cur = to; cur >= 0; cur = prev[cur]) path.unshift(nodes[cur].p)
  return path
}

/**
 * 规划 from → to 的行走路线（ENU 平面坐标）。
 * 主体沿登记道路折线，两端各允许一段接入/接近的短直线。
 */
export function planRoute(from: Pt, to: Pt): Pt[] {
  const a = attach(from)
  const b = attach(to)
  const mid = dijkstra(a, b)
  if (mid.length === 0) return []
  const path: Pt[] = [from]
  for (const p of mid) if (dist(p, path[path.length - 1]) > 0.01) path.push(p)
  if (dist(to, path[path.length - 1]) > 0.01) path.push(to)
  return path
}
