// ScenePackage 契约 v1（contracts/scene-package.md）
// 任意能源场景以数据登记 + 轻量适配器进入统一对象注册表：
//   对象问答/指代解析/导航目标按对象属性（风险·状态·规格·位置）驱动——换场景 = 换数据，不改问答代码。
// 原则：ID/编码只进结构化字段；人话回答由 dispatch 按属性组织。
// 装载期校验（ID 唯一、必要字段）不过直接抛错——坏场景包宁可起不来，不带病运行。
import { fixture } from '../fixture';
import { windFarm } from '../agent/windFarm';

export type SceneKind = 'pv' | 'wind' | 'hydro';
export type RiskLevel = 'normal' | 'warning' | 'critical';

export interface SceneObject {
  id: string;
  /** 人话名（如「3 号风机」「7 号组串」），回答用 */
  label: string;
  /** 问句/指代匹配的别名（含无空格变体与关联 ID） */
  aliases: string[];
  kind: 'device' | 'ops';
  /** 关联检查点（导航落点） */
  checkpointId?: string;
  riskLevel?: RiskLevel;
  /** 人可读状态说明 */
  stateNote?: string;
  /** 对象级规格（覆盖场景级） */
  specs?: Record<string, string>;
  position?: { east: number; north: number; up: number };
  headingDeg?: number;
}

export interface ScenePackage {
  sceneId: string;
  sceneRevision: string;
  name: string;
  kind: SceneKind;
  sourceRef: string;
  /** 场景级默认规格（对象级覆盖） */
  specs: Record<string, string>;
  objects: SceneObject[];
}

export const RISK_LABEL_CN: Record<RiskLevel, string> = { normal: '正常', warning: '预警', critical: '严重' };

// —— 风电适配：player-demo/example/public/wind/farm.json（前端同源，单一事实源） ——

function adaptWind(): ScenePackage {
  const objects: SceneObject[] = windFarm.turbines.map((t) => ({
    id: t.id,
    label: t.label,
    aliases: [`${t.no}号风机`, `${t.no} 号风机`, `${t.no}号机组`, `${t.no} 号机组`, t.id],
    kind: 'device',
    checkpointId: t.checkpointId,
    riskLevel: t.riskLevel ?? 'normal',
    stateNote: t.stateNote,
    position: t.offset,
    headingDeg: t.headingDeg,
  }));
  if (windFarm.opsPoint) {
    objects.push({ id: windFarm.opsPoint.id, label: windFarm.opsPoint.label, aliases: [windFarm.opsPoint.label, '场站运维点'], kind: 'ops' });
  }
  return {
    sceneId: windFarm.sceneId,
    sceneRevision: windFarm.sceneRevision,
    name: `${windFarm.name}（风电场站·演示仿真）`,
    kind: 'wind',
    sourceRef: 'player-demo/example/public/wind/farm.json',
    specs: windFarm.specs ?? {},
    objects,
  };
}

// —— 光伏适配：data/fixtures/park-pecc-01.json（引擎仿真 fixture 同源） ——

function adaptPecc(): ScenePackage {
  const objects: SceneObject[] = [];
  const cpPos = (cpId: string) => {
    const cp = fixture.checkpoints.find((c: any) => c.id === cpId);
    return Array.isArray(cp?.position) ? { east: Number(cp.position[0]), north: Number(cp.position[1]), up: Number(cp.position[2]) } : undefined;
  };
  const anomaly = fixture.demoAnomaly;
  const targetString = fixture.strings.find((s: any) => s.id === anomaly.targetStringId);
  if (targetString) {
    const no = String(Number.parseInt(targetString.id.match(/(\d+)$/)?.[1] ?? '0', 10));
    objects.push({
      id: targetString.id,
      label: `${no} 号组串`,
      aliases: [`${no}号组串`, `${no} 号组串`, `${no} 号异常组串`, `${no}号异常组串`, '异常组串', targetString.id, anomaly.id],
      kind: 'device',
      checkpointId: 'CP-INV-B02',
      riskLevel: 'warning',
      stateNote: `发电电流偏离同类约 ${Math.round(Math.abs(Number(anomaly.magnitude ?? 0)) * 100)}%，疑似${anomaly.suspected}`,
      specs: {
        ...(targetString.panelCount ? { 组件数量: `${targetString.panelCount} 块` } : {}),
        ...(targetString.ratedCurrentA ? { 额定电流: `${targetString.ratedCurrentA} A` } : {}),
        ...(targetString.ratedVoltageV ? { 额定电压: `${targetString.ratedVoltageV} V` } : {}),
      },
      position: cpPos('CP-INV-B02'),
    });
  }
  for (const inv of fixture.inverters as Array<Record<string, any>>) {
    if (inv.id !== 'INV-B-02') continue; // 其余逆变器未入巡检路线，先不进问答注册表
    objects.push({
      id: inv.id,
      label: 'B2 逆变器',
      aliases: ['B2逆变器', 'B2 逆变器', inv.id, String(inv.model ?? '')],
      kind: 'device',
      checkpointId: 'CP-INV-B02',
      riskLevel: 'normal',
      stateNote: '运行正常',
      specs: {
        ...(inv.model ? { 型号: String(inv.model) } : {}),
        ...(inv.ratedKw ? { 额定功率: `${inv.ratedKw} 千瓦` } : {}),
        ...(inv.efficiency ? { 转换效率: `${Math.round(Number(inv.efficiency) * 1000) / 10}%` } : {}),
        ...(inv.stringCount ? { 接入组串: `${inv.stringCount} 路` } : {}),
      },
      position: cpPos('CP-INV-B02'),
    });
  }
  if (fixture.opsPoint) {
    objects.push({ id: fixture.opsPoint.id, label: String(fixture.opsPoint.name ?? '运维点'), aliases: ['运维点'], kind: 'ops' });
  }
  return {
    sceneId: 'PECC-PARK-01',
    sceneRevision: 'fixture-v1',
    name: `${fixture.name}（光伏园区·演示仿真）`,
    kind: 'pv',
    sourceRef: 'data/fixtures/park-pecc-01.json',
    specs: (fixture as any).specs ?? {},
    objects,
  };
}

// —— 装载与校验 ——

const packages: Record<string, ScenePackage> = {};

for (const pkg of [adaptPecc(), adaptWind()]) {
  const seen = new Set<string>();
  for (const o of pkg.objects) {
    if (!o.id || !o.label) throw new Error(`场景包 ${pkg.sceneId} 对象缺少 id/label`);
    if (seen.has(o.id)) throw new Error(`场景包 ${pkg.sceneId} 对象 ID 重复: ${o.id}`);
    seen.add(o.id);
  }
  if (pkg.objects.length === 0) throw new Error(`场景包 ${pkg.sceneId} 没有登记对象`);
  packages[pkg.sceneId] = pkg;
}

export function getPackage(sceneId: string): ScenePackage | null {
  return packages[sceneId] ?? null;
}

export function requirePackage(sceneId: string): ScenePackage {
  const p = packages[sceneId];
  if (!p) throw new Error(`未登记场景包: ${sceneId}（已登记 ${Object.keys(packages).join('、')}）`);
  return p;
}

/** 问句里提到的对象：别名最长优先（「7 号异常组串」优先于「7 号组串」） */
export function findObjectByMention(pkg: ScenePackage, text: string): SceneObject | null {
  let best: SceneObject | null = null;
  let bestLen = 0;
  for (const o of pkg.objects) {
    for (const alias of o.aliases) {
      if (alias && text.includes(alias) && alias.length > bestLen) {
        best = o;
        bestLen = alias.length;
      }
    }
    if (text.includes(o.id) && o.id.length > bestLen) {
      best = o;
      bestLen = o.id.length;
    }
  }
  return best;
}

/** 指代/命令回看：targetId 命中对象 id、关联检查点或别名（如 ANOM-DEMO-01 → 7 号组串） */
export function findObjectByRef(pkg: ScenePackage, ref: string): SceneObject | null {
  if (!ref) return null;
  return (
    pkg.objects.find((o) => o.id === ref) ??
    pkg.objects.find((o) => o.checkpointId === ref) ??
    pkg.objects.find((o) => o.aliases.includes(ref)) ??
    null
  );
}

/** 按问句挑规格键：问「高」答高度类；问「长宽高」答尺寸类；无命中给默认前若干条（数据驱动，新场景自动适配） */
export function pickSpecs(specs: Record<string, string>, text: string, limit = 6): Array<[string, string]> {
  let keyRe: RegExp | null = null;
  if (/长宽高|机舱尺寸/.test(text)) keyRe = /长|宽|高|尺寸/;
  else if (/多高|高度|塔筒|轮毂/.test(text)) keyRe = /高/;
  else if (/直径|叶轮|叶片/.test(text)) keyRe = /直径|叶轮|叶片/;
  else if (/功率|千瓦|多大/.test(text)) keyRe = /功率|千瓦/;
  else if (/电流|电压|组件/.test(text)) keyRe = /电流|电压|组件/;
  else if (/齿轮箱|发电机|基础|型号|转换效率/.test(text)) keyRe = /齿轮箱|发电机|基础|型号|转换效率/;
  const entries = Object.entries(specs);
  const hit = keyRe ? entries.filter(([k]) => keyRe!.test(k)) : [];
  return (hit.length ? hit : entries).slice(0, limit);
}
