// 服务端受控编排（P1 编排收权 + P2 会话与 trace，contracts/avatar-command.md §0 / agent-state.md）
// 一句中文 → 解释（LLM-first，复用 interpretAvatar，人物路径行为不变）→ 命令分流：
//   闭环命令（start_inspection / decide_pending / capture_evidence）由服务端直接执行：
//     - start_inspection：演示复位 + 建任务原子化（重复演示不带脏状态）；
//     - decide_pending：服务端绑定当前 pendingApproval 的 approvalId/contextVersion/planHash
//       （"我同意"不再由前端读取状态后选择接口，语义与 /missions/:id/approval 完全一致）；
//     - capture_evidence：走既有状态机（过早取证自动暂存、缺 ROOF 证据保持阻塞），前端不再自行判断阶段；
//   场景命令（navigate/focus_asset/repair_simulation/运动类）原样返回前端执行（渲染层职责）。
// 会话（P2）：conversationId 聚合轮次摘要（有界窗口注入 prompt）与逐节点 trace（入库并随响应返回）。
// 本接口只加不减：/avatar/interpret 合同不变（风电页继续可用）。
import { resetAnomaly } from '../anomalyState';
import { resetTasks } from '../inspection';
import { canonicalJson } from './context';
import { findObjectByMention, findObjectByRef, getPackage, pickSpecs, RISK_LABEL_CN } from '../scene/registry';
import type { SceneObject, ScenePackage } from '../scene/registry';
import { nowIsoShanghai } from '../util';
import { AvatarClarificationError, withIds } from './avatar';
import type { AvatarCommand, AvatarCommandInput } from './avatar';
import { interpretAvatar } from './avatar-llm';
import { activeAdapter, structured } from './model';
import { createMission, handleSceneEvent, submitApproval, type Clarification } from './runtime';
import { latestMissionId, loadMission, nextSeq, recentTurns, recordTrace, recordTurn, resetAgentData } from './store';
import type { MissionState, PlannerInfo } from './types';

const CLOSED_LOOP_KINDS = ['start_inspection', 'decide_pending', 'capture_evidence'] as const;
type ClosedLoopKind = (typeof CLOSED_LOOP_KINDS)[number];

const isClosedLoop = (kind: string): kind is ClosedLoopKind => (CLOSED_LOOP_KINDS as readonly string[]).includes(kind);

export const DEFAULT_CONVERSATION_ID = 'CONV-DEMO';

export interface DispatchInput {
  text: string;
  sceneId: string;
  sceneRevision: string;
  scene: 'pecc' | 'wind' | 'hydro';
  /** 缺省时自动定位最近创建的任务 */
  missionId?: string;
  /** start_inspection 前是否演示复位（默认 true，与页面"演示：检查 B2 屋顶异常"语义一致） */
  reset?: boolean;
  /** 会话 id（缺省 CONV-DEMO）：轮次摘要与 trace 按会话聚合 */
  conversationId?: string;
}

/** 逐节点 trace（agent-tools.md §3 精神：只含 label/status/耗时/错误类型，不含模型原文与密钥） */
export interface TraceStep {
  label: string;
  status: 'ok' | 'warn' | 'error';
  durationMs: number;
  detail?: string;
}

export type DispatchOutcome =
  | { kind: ClosedLoopKind; status: 'available'; detail: Record<string, unknown> }
  | { kind: ClosedLoopKind; status: 'rejected'; code: string; message: string };

export type DispatchResult =
  | {
      kind: 'ok';
      status: 'available' | 'partial' | 'rejected';
      conversationId: string;
      trace: TraceStep[];
      /** 上下文问答时携带结构化场景信息（identity/scene/mission） */
      sceneBrief?: Record<string, unknown>;
      normalizedText: string;
      reply: string;
      commands: AvatarCommand[];
      outcomes: DispatchOutcome[];
      mission: MissionState | null;
      planner: PlannerInfo;
    }
  | { kind: 'clarification'; conversationId: string; trace: TraceStep[]; clarification: Clarification; planner: PlannerInfo };

/** 与 /api/debug/reset 完全一致的三段复位（演示原子性：复位+建任务之间不留脏状态） */
function resetDemo(): void {
  resetTasks();
  resetAnomaly();
  resetAgentData();
}

type MissionResolve = { ok: true; m: MissionState } | { ok: false; code: string; message: string };

// —— 上下文问答门控（确定性，先于 LLM）：身份 / 场景 / 任务 / 对象（状态·参数·位置） ——
// 对象问答由场景包注册表属性驱动（contracts/scene-package.md）：换场景 = 换数据，不改本文件。
// 原则：回答只讲人话——关键事实组织成自然语句；ID/来源/编码留在 sceneBrief 结构化字段给前端使用。
const IDENTITY_QA_RE = /你是谁|你叫什么|自我介绍|介绍(?:一下|下)?你自己/;
const SCENE_QA_RE = /什么场景|啥场景|当前场景|这是(?:哪里|什么地方)|场景信息|现在是哪里|哪个场站|什么站/;
const MISSION_QA_RE = /当前任务|任务状态|什么任务|啥任务|任务进展|(?:有|查)(?:啥|什么|哪些).{0,4}任务|有任务吗|任务吗/;

// —— 通用问题门控（闲聊/能力/时间/异常汇总/巡览）——
const THANKS_RE = /谢谢|辛苦了|麻烦你了|辛苦辛苦/;
const GREETING_RE = /^(?:你好|您好|嗨|哈喽|在吗|hello|hi)[呀啊啦嘛!!。.~～\s]*$/i;
const CAPABILITY_RE = /你会(?:干什么|做什么|做啥|什么)|你能(?:做什么|干什么|做啥|帮什么)|你有什么功能|有什么功能|怎么用你|能干啥|功能介绍/;
const TIME_QA_RE = /现在几点|几点了|今天几号|今天日期|什么日期|今天星期/;
const ANOMALY_QA_RE = /有没有异常|有异常吗|有什么异常|啥异常|异常情况|有什么告警|有告警吗|告警情况|哪些.{0,4}(?:异常|告警|问题)|有什么问题|设备还好吗/;
const TOUR_RE = /带我转一圈|转一圈|逛一圈|带我逛逛|巡览|巡检一遍|全面巡检|都看一遍|挨个看|参观/;

const OBJ_CMD_VERB_RE = /飞到|跑到|走到|前往|赶去|回去|回到|运维点|维修|修复|消缺|检修|查看|看看|聚焦|对准|停下|停止|站住|暂停|别动|左转|右转|转身|掉头|跳|采集|提交|取证|拍照|检查|巡检|排查|同意|批准|赞同|执行|拒绝|取消|证据|起飞|降落|落地|着陆|悬停|上升|下降|升高|降低|爬升/;
const OBJ_REFERENT_RE = /它|这个设备|该设备|当前对象|当前设备|这台|该机组/;
const OBJ_STATUS_RE = /状态|风险|情况|严重|怎么样|怎样|正常|告警|健康|预警|毛病|问题/;
const OBJ_SPEC_RE = /参数|尺寸|长宽高|多高|多大|规格|功率|高度|直径|型号|机型|多少米|叶片|齿轮箱|发电机|基础|多少千瓦/;
const OBJ_POS_RE = /位置|坐标|在哪|朝向|多远|海拔|标高|方位/;

interface ContextAnswer {
  reply: string;
  brief: Record<string, unknown>;
  /** 巡览类门控携带的受控场景命令（服务端生成，不经模型） */
  commands?: AvatarCommand[];
}

function humanPhase(phase: string): string {
  return (
    (
      {
        created: '刚建立',
        'context-ready': '正在汇总现场信息',
        proposed: '已给出处理建议',
        'awaiting-approval': '正在等你批准',
        executing: '正在现场执行',
        'awaiting-evidence': '正在等现场证据',
        'awaiting-confirmation': '证据齐了，等你确认闭环',
        resolved: '已完成闭环',
        escalated: '已升级处理',
        cancelled: '已取消',
      } as Record<string, string>
    )[phase] ?? phase
  );
}

function missionHumanLine(): string {
  const id = latestMissionId();
  const m = id ? loadMission(id) : null;
  return m ? `当前有一个巡检任务，${humanPhase(m.phase)}。` : '当前没有进行中的任务。';
}

// —— 事实托底 LLM 兜底：门控没接住的表述，把场景包事实喂给模型组织回答 ——
// 模型只当发言人、不当数据源：回答不得出现任何编号（ID），数字必须逐字来自事实 JSON。

const REPLY_ID_RE = /HS-WTG|CP-WT|HS-HU|HS-GATE|CP-HU|CP-GATE|HYDRO-|CP-B02|CP-INV|STR-|ANOM-|PECC-|WIND-|MSN-|OPS-|INV-[AB]|TASK-/;

function factsContext(pkg: ScenePackage): Record<string, unknown> {
  const devices = pkg.objects
    .filter((o) => o.kind === 'device')
    .map((o) => ({
      名称: o.label,
      状态: RISK_LABEL_CN[o.riskLevel ?? 'normal'],
      ...(o.stateNote ? { 说明: o.stateNote } : {}),
      ...(pickSpecs({ ...pkg.specs, ...(o.specs ?? {}) }, '', 3).reduce<Record<string, string>>((acc, [k, v]) => ({ ...acc, [k]: v }), {})),
    }));
  return {
    场景: { 名称: pkg.name, 类型: pkg.kind },
    设备: devices,
    任务: missionLineFor(pkg),
    提醒: '所有数据为演示仿真',
  };
}

/** 事实托底回答：模型组织语言；校验失败（含 ID/编造数字/超长）重试一次，仍失败返回 null 走软化澄清 */
async function answerWithFacts(text: string, pkg: ScenePackage): Promise<string | null> {
  if (!activeAdapter()) return null;
  const facts = factsContext(pkg);
  const factsJson = canonicalJson(facts as never);
  const res = await structured<Record<string, unknown>>({
    messages: [
      {
        role: 'system',
        content:
          '你是「巡界」数字运维员，在新能源场站的三维现场回答运维人员的问题。' +
          '只使用用户消息里「事实」JSON 中的信息回答；禁止编造任何数字、设备或结论；' +
          '禁止输出任何编号或代码（如 HS-WTG、CP-WT、STR、MSN 等），说到某台设备用它的名称；' +
          '用口语化中文回答，不超过 3 句。' +
          '如果事实不足以回答，就如实说明，并建议一个可以问的问题（例如某台设备的状态、参数，或当前任务）。',
      },
      { role: 'user', content: `${JSON.stringify({ 事实: facts })}\n\n用户问题：${text}` },
    ],
    parse: (v) => (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Record<string, unknown>).reply === 'string' ? (v as Record<string, unknown>) : null),
    validator: (v) => {
      const reply = String(v.reply).trim();
      if (reply.length < 2 || reply.length > 200) return 'REPLY_LENGTH';
      if (REPLY_ID_RE.test(reply)) return 'REPLY_CONTAINS_ID';
      const tokens = reply.match(/\d+(?:\.\d+)?/g) ?? [];
      if (!tokens.every((t) => factsJson.includes(t))) return 'REPLY_NUMBER_NOT_IN_FACTS';
      return null;
    },
    schemaHint: '{"reply":"<中文回答>"}',
    maxAttempts: 2,
  });
  if (!res.ok) return null;
  return String(res.value.reply).trim();
}

function sceneMeta(pkg: ScenePackage) {
  return { sceneId: pkg.sceneId, sceneRevision: pkg.sceneRevision, name: pkg.name, sourceRef: pkg.sourceRef };
}

/** 本场景的任务提示行：任务闭环目前只在光伏场景；其他场景不跨场景串任务 */
function missionLineFor(pkg: ScenePackage): string {
  return pkg.kind === 'pv' ? missionHumanLine() : '';
}

/** 巡览计划：按风险优先挑至多 3 处设备，生成导航命令队列（问题设备先看） */
function tourPlan(pkg: ScenePackage): { reply: string; commands: AvatarCommand[] } {
  const order: Record<string, number> = { critical: 0, warning: 1, normal: 2 };
  const devices = pkg.objects
    .filter((o) => o.kind === 'device' && o.checkpointId)
    .sort((a, b) => (order[a.riskLevel ?? 'normal'] ?? 2) - (order[b.riskLevel ?? 'normal'] ?? 2));
  const stops = devices.slice(0, 3);
  const movement: 'walk' | 'fly' = pkg.kind === 'pv' ? 'walk' : 'fly';
  const commands = withIds(stops.map((s) => ({ kind: 'navigate', targetId: s.checkpointId!, movement }) as unknown as AvatarCommandInput));
  const names = stops.map((o) => o.label).join('、');
  return { reply: `好的，带你巡览一圈：依次前往${names}，问题设备优先。出发。`, commands };
}

function objectAnswer(pkg: ScenePackage, obj: SceneObject, text: string): ContextAnswer {
  const specs = { ...pkg.specs, ...(obj.specs ?? {}) };
  if (OBJ_SPEC_RE.test(text)) {
    const parts = pickSpecs(specs, text).map(([k, v]) => `${k} ${v}`);
    const head = specs['机型'] ? `${obj.label}是${specs['机型']}：` : `${obj.label}的关键参数：`;
    return { reply: `${head}${parts.join('；')}。`, brief: { kind: 'object', object: obj.id, aspect: 'specs' } };
  }
  if (OBJ_POS_RE.test(text)) {
    const o = obj.position;
    const where = o
      ? `在场地${(o.north ?? 0) >= 0 ? '北' : '南'}侧偏${(o.east ?? 0) >= 0 ? '东' : '西'}方向，场地高程约 ${Math.round(o.up)} 米`
      : '沿场地布置';
    return {
      reply: `${obj.label}${where}${obj.headingDeg != null ? `，机舱朝向约 ${obj.headingDeg} 度` : ''}。`,
      brief: { kind: 'object', object: obj.id, aspect: 'position' },
    };
  }
  const level = RISK_LABEL_CN[obj.riskLevel ?? 'normal'];
  const note = obj.stateNote?.trim();
  const statusLine = level === '正常' ? `${obj.label}状态正常` : `${obj.label}状态${level}——${note ?? '需要现场关注'}`;
  const topSpecs = pickSpecs(specs, text, 2)
    .map(([k, v]) => `${k} ${v}`)
    .join('，');
  // 尾句按对象轮换，避免每条回答同一句尾巴的模板感
  const tails = ['想看详细参数可以问我「它的参数」。', '详细参数直接问我「它的参数」就行。', '想了解参数，问我「它的参数」。'];
  const tail = tails[obj.id.length % tails.length];
  return {
    reply: `${statusLine}。${topSpecs ? topSpecs + '。' : ''}${tail}`,
    brief: { kind: 'object', object: obj.id, aspect: OBJ_STATUS_RE.test(text) ? 'status' : 'overview', riskLevel: obj.riskLevel ?? 'normal', stateNote: note ?? null },
  };
}

function answerContextQuestion(text: string, pkg: ScenePackage, scene: 'pecc' | 'wind' | 'hydro', conversationId: string): ContextAnswer | null {
  const meta = sceneMeta(pkg);
  const missionLine = missionLineFor(pkg);

  if (IDENTITY_QA_RE.test(text)) {
    return {
      reply: `我是「巡界」数字运维员，在${meta.name}值班：移动巡检、设备查看、维修推演都可以交给我，重要的动作会先请你授权。${missionLine}`,
      brief: { kind: 'identity', ...meta },
    };
  }
  if (THANKS_RE.test(text)) {
    return { reply: '不客气，有需要随时叫我。', brief: { kind: 'smalltalk' } };
  }
  if (GREETING_RE.test(text)) {
    return {
      reply: `你好！我是巡界数字运维员，正在${pkg.name}值班。可以直接给我下指令（比如「飞到 ${pkg.objects.find((o) => o.kind === 'device')?.label ?? '设备'}」），也可以问我设备状态、当前任务。`,
      brief: { kind: 'smalltalk', sceneId: meta.sceneId },
    };
  }
  if (TIME_QA_RE.test(text)) {
    const m = nowIsoShanghai().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    return {
      reply: m ? `现在是北京时间 ${Number(m[2])} 月 ${Number(m[3])} 日 ${m[4]} 点 ${m[5]} 分。` : '时钟组件暂时不可用。',
      brief: { kind: 'time' },
    };
  }
  if (CAPABILITY_RE.test(text)) {
    const devices = pkg.objects.filter((o) => o.kind === 'device');
    const abnormal = devices.filter((o) => (o.riskLevel ?? 'normal') !== 'normal');
    const kindLabel = pkg.kind === 'wind' ? '风机' : pkg.kind === 'hydro' ? '机组、闸门' : '组串、逆变器';
    return {
      reply:
        `在${pkg.name}，我可以：①带你到 ${devices.length} 处登记设备（${kindLabel}）现场查看；②回答设备状态、参数、位置问题；③按规程做维修推演${pkg.kind === 'pv' ? '（含任务审批与闭环回执）' : ''}。` +
        (abnormal.length ? `当前有 ${abnormal.length} 处设备需要注意，可以先问我「有没有异常」。` : '目前登记的设备都正常。'),
      brief: { kind: 'capability', sceneId: meta.sceneId },
    };
  }
  if (SCENE_QA_RE.test(text)) {
    if (pkg.kind === 'wind') {
      const devices = pkg.objects.filter((o) => o.kind === 'device');
      const crit = devices.filter((o) => o.riskLevel === 'critical');
      const warn = devices.filter((o) => o.riskLevel === 'warning');
      const lines = [`当前是${pkg.name}，山脊上共有 ${devices.length} 台${pkg.specs['机型'] ?? '风电机组'}`];
      if (crit.length) lines.push(`其中${crit.map((o) => o.label).join('、')}问题比较严重——${crit.map((o) => o.stateNote ?? '需要处理').join('；')}`);
      if (warn.length) lines.push(`${warn.map((o) => o.label).join('、')}有预警`);
      lines.push(`其余机组运行正常，场内还有一个运维点。${missionLine}`);
      return { reply: lines.join('；'), brief: { kind: 'scene', ...meta } };
    }
    if (pkg.kind === 'hydro') {
      const devices = pkg.objects.filter((o) => o.kind === 'device');
      const crit = devices.filter((o) => o.riskLevel === 'critical');
      const warn = devices.filter((o) => o.riskLevel === 'warning');
      const lines = [`当前是${pkg.name}，${pkg.specs['坝型'] ?? '水电站'}，共登记 ${devices.length} 台/座设备（含泄洪闸门）`];
      if (crit.length) lines.push(`其中${crit.map((o) => o.label).join('、')}问题比较严重——${crit.map((o) => o.stateNote ?? '需要处理').join('；')}`);
      if (warn.length) lines.push(`${warn.map((o) => o.label).join('、')}有预警`);
      lines.push(`其余设备运行正常，场内还有一个运维点。${missionLine}`);
      return { reply: lines.join('；'), brief: { kind: 'scene', ...meta } };
    }
    const warn = pkg.objects.filter((o) => o.kind === 'device' && o.riskLevel === 'warning');
    const warnLine = warn.length ? `${warn.map((o) => o.label).join('、')}登记了发电异常——${warn.map((o) => o.stateNote ?? '待现场核查').join('；')}。` : '';
    return {
      reply: `当前是${pkg.name}。${warnLine}逆变器和楼前、屋面检查点都已入图。${missionLine}`,
      brief: { kind: 'scene', ...meta },
    };
  }
  if (MISSION_QA_RE.test(text)) {
    if (pkg.kind !== 'pv') {
      return {
        reply: `${pkg.name}暂未接入任务闭环演示——任务审批与闭环回执目前以光伏场景为主。在这里你可以让我巡检设备、查看状态和参数。`,
        brief: { kind: 'mission', sceneId: meta.sceneId, sceneKind: pkg.kind },
      };
    }
    const id = latestMissionId();
    const m = id ? loadMission(id) : null;
    const phaseText = m ? humanPhase(m.phase) : '';
    const approvalLine = m?.pendingApproval && !phaseText.includes('等你')
      ? (m.pendingApproval.purpose === 'close' ? '证据已经齐了，就等你一句「我同意」确认闭环。' : '有一份处理建议正等你批准。')
      : '';
    return {
      reply: m ? `${missionHumanLine()}${approvalLine}` : '当前没有进行中的任务。说「检查 B2 屋顶异常」就能建一个巡检任务。',
      brief: { kind: 'mission', sceneId: meta.sceneId, missionId: m?.missionId ?? null, phase: m?.phase ?? null, inspectionTaskId: m?.inspectionTaskId ?? null },
    };
  }
  if (ANOMALY_QA_RE.test(text)) {
    const abnormal = pkg.objects.filter((o) => o.kind === 'device' && (o.riskLevel ?? 'normal') !== 'normal');
    if (abnormal.length === 0) {
      return { reply: '目前登记的设备都正常，没有异常。', brief: { kind: 'anomaly', sceneId: meta.sceneId, count: 0 } };
    }
    const lines = abnormal.map((o) => {
      const level = RISK_LABEL_CN[o.riskLevel ?? 'normal'];
      return `${o.label}状态${level}——${o.stateNote ?? '需要现场关注'}`;
    });
    return {
      reply: `有 ${abnormal.length} 处需要注意：${lines.join('；')}。其余设备正常。`,
      brief: { kind: 'anomaly', sceneId: meta.sceneId, count: abnormal.length, objects: abnormal.map((o) => o.id) },
    };
  }
  if (TOUR_RE.test(text)) {
    const plan = tourPlan(pkg);
    return { reply: plan.reply, brief: { kind: 'tour', sceneId: meta.sceneId, stops: plan.commands.map((c) => ('targetId' in c ? c.targetId : undefined)) }, commands: plan.commands };
  }
  // 对象问答（注册表属性驱动，两场景通用；「它」指代最近一轮命令指向的对象）
  if (!OBJ_CMD_VERB_RE.test(text)) {
    let obj = findObjectByMention(pkg, text);
    if (!obj && OBJ_REFERENT_RE.test(text)) {
      for (const turn of recentTurns(conversationId, 3)) {
        for (const c of [...turn.commands].reverse()) {
          const hit = findObjectByRef(pkg, String(c.targetId ?? ''));
          if (hit) {
            obj = hit;
            break;
          }
        }
        if (obj) break;
      }
    }
    if (obj) return objectAnswer(pkg, obj, text);
  }
  return null;
}

export async function dispatchAvatarText(input: DispatchInput): Promise<DispatchResult> {
  const conversationId = input.conversationId?.trim() || DEFAULT_CONVERSATION_ID;
  const trace: TraceStep[] = [];
  const t0 = Date.now();

  // 上下文问答门控：元问题确定性作答，不消耗 LLM、不产生命令
  const pkg = getPackage(input.sceneId);
  // 光伏「找板子」指令直通：组串指称 + 定位动词是移动指令（要产生命令），不进对象问答/事实托底门控
  const solarLocateCmd =
    input.scene === 'pecc' &&
    /组串|STR-[A-G][12]-\d{1,2}/i.test(input.text) &&
    /在哪|哪里|定位|找到|带我去|带我到|带我过去|去看看|看一下|看看/.test(input.text);
  const qa = pkg && !solarLocateCmd ? answerContextQuestion(input.text, pkg, input.scene, conversationId) : null;
  if (qa) {
    const adapter = activeAdapter();
    trace.push({ label: '解释', status: 'ok', durationMs: Date.now() - t0, detail: 'context-qa' });
    trace.push({ label: '总计', status: 'ok', durationMs: Date.now() - t0 });
    recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);
    recordTurn(conversationId, {
      text: input.text,
      scene: input.scene,
      commands: (qa.commands ?? []).map((c) => ({ kind: c.kind, targetId: 'targetId' in c ? c.targetId : undefined })),
      outcomeSummary: qa.commands?.length ? `tour:${qa.commands.length}` : 'context-qa',
      ts: nowIsoShanghai(),
    });
    return {
      kind: 'ok',
      status: 'available',
      conversationId,
      trace,
      sceneBrief: qa.brief,
      normalizedText: input.text,
      reply: qa.reply,
      commands: qa.commands ?? [],
      outcomes: [],
      mission: null,
      planner: adapter ? { mode: 'llm', modelAvailable: true } : { mode: 'deterministic-fallback', modelAvailable: false, reason: 'NO_CREDENTIALS' },
    };
  }

  const tInterpret = Date.now();
  const history = recentTurns(conversationId, 2).map((t) => ({ text: t.text, commands: t.commands }));
  let interp: Awaited<ReturnType<typeof interpretAvatar>>;
  try {
    interp = await interpretAvatar(input.text, input.scene, history);
  } catch (e) {
    // 命令解析拒收（含「找板子」等已有具体引导的澄清原样上浮）：
    // ① 先试事实托底 LLM（不再要求问句特征——模糊表述也让模型按事实组织回答）；
    // ② 模型不可用/仍失败 → 按当前场景动态软引导，不再甩「无法理解指令」。
    if (e instanceof AvatarClarificationError && pkg && !solarLocateCmd && !OBJ_CMD_VERB_RE.test(input.text)) {
      const tFacts = Date.now();
      const answer = await answerWithFacts(input.text, pkg);
      if (answer) {
        const adapter = activeAdapter();
        trace.push({ label: '解释', status: 'ok', durationMs: Date.now() - tFacts, detail: 'context-qa-llm' });
        trace.push({ label: '总计', status: 'ok', durationMs: Date.now() - t0 });
        recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);
        recordTurn(conversationId, { text: input.text, scene: input.scene, commands: [], outcomeSummary: 'context-qa-llm', ts: nowIsoShanghai() });
        return {
          kind: 'ok',
          status: 'available',
          conversationId,
          trace,
          sceneBrief: { kind: 'facts-qa' },
          normalizedText: input.text,
          reply: answer,
          commands: [],
          outcomes: [],
          mission: null,
          planner: adapter ? { mode: 'llm', modelAvailable: true } : { mode: 'deterministic-fallback', modelAvailable: false, reason: 'NO_CREDENTIALS' },
        };
      }
      const sampleDevice = pkg.objects.find((o) => o.kind === 'device')?.label ?? '设备';
      throw new AvatarClarificationError(
        `这个问题我暂时答不准。可以问我：「${sampleDevice}什么状态」「当前啥场景」「有没有异常」，或者直接下达指令。`,
        e.examples,
        e.planner,
      );
    }
    throw e;
  }
  const { normalizedText, reply, commands, planner } = interp;
  trace.push({ label: '解释', status: 'ok', durationMs: Date.now() - tInterpret, detail: planner.mode });

  const outcomes: DispatchOutcome[] = [];
  let mission: MissionState | null = null;

  const resolveMission = (): MissionResolve => {
    const id = input.missionId ?? latestMissionId();
    const m = id ? loadMission(id) : null;
    if (!m) return { ok: false, code: 'NO_ACTIVE_MISSION', message: '当前没有活动任务：请先说「检查 B2 屋顶异常」创建任务' };
    return { ok: true, m };
  };

  for (const cmd of commands) {
    if (!isClosedLoop(cmd.kind)) continue; // 场景命令原样透传，服务端不执行
    const tCmd = Date.now();
    let outcome: DispatchOutcome;
    if (input.scene !== 'pecc') {
      const sceneLabel = input.scene === 'wind' ? '风电' : '水电';
      outcome = { kind: cmd.kind, status: 'rejected', code: 'UNSUPPORTED_IN_SCENE', message: `${sceneLabel}场景暂未接任务闭环（仅 PECC-PARK-01 支持 start_inspection/decide_pending/capture_evidence）` };
    } else {
      switch (cmd.kind) {
        case 'start_inspection': {
          if (input.reset !== false) resetDemo();
          const res = await createMission({
            objective: normalizedText,
            sceneId: input.sceneId,
            sceneRevision: input.sceneRevision,
            anomalyId: cmd.anomalyId,
            trigger: 'user',
          });
          if ('clarification' in res) {
            trace.push({ label: `执行:${cmd.kind}`, status: 'warn', durationMs: Date.now() - tCmd, detail: 'CLARIFICATION_NEEDED' });
            trace.push({ label: '总计', status: 'warn', durationMs: Date.now() - t0 });
            recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);
            return { kind: 'clarification', conversationId, trace, clarification: res.clarification, planner };
          }
          mission = res.mission;
          outcome = {
            kind: 'start_inspection',
            status: 'available',
            detail: { missionId: mission.missionId, phase: mission.phase, pendingApprovalId: mission.pendingApproval?.approvalId ?? null },
          };
          break;
        }
        case 'decide_pending': {
          const r = resolveMission();
          if (!r.ok) {
            outcome = { kind: 'decide_pending', status: 'rejected', code: r.code, message: r.message };
            break;
          }
          const pa = r.m.pendingApproval;
          if (!pa) {
            outcome = { kind: 'decide_pending', status: 'rejected', code: 'NO_PENDING_APPROVAL', message: `任务 ${r.m.missionId} 阶段 ${r.m.phase} 无挂起审批` };
            break;
          }
          // 语义统一：服务端用当前待审批项补全四重绑定，前端不再读取/回传审批三元组
          const res = await submitApproval(r.m.missionId, { approvalId: pa.approvalId, decision: cmd.decision, contextVersion: pa.contextVersion, planHash: pa.planHash });
          if (!res.ok) {
            outcome = { kind: 'decide_pending', status: 'rejected', code: res.code, message: res.message };
            break;
          }
          mission = res.mission;
          outcome = { kind: 'decide_pending', status: 'available', detail: { missionId: mission.missionId, phase: mission.phase, decision: cmd.decision } };
          break;
        }
        case 'capture_evidence': {
          const r = resolveMission();
          if (!r.ok) {
            outcome = { kind: 'capture_evidence', status: 'rejected', code: r.code, message: r.message };
            break;
          }
          const m = r.m;
          const roof = m.route.roofCheckpointId;
          if (!roof) {
            outcome = { kind: 'capture_evidence', status: 'rejected', code: 'NO_ROOF_CHECKPOINT', message: `任务 ${m.missionId} 路线上没有已登记屋面检查点` };
            break;
          }
          const seq = nextSeq('dispatch');
          const res = await handleSceneEvent(m.missionId, {
            eventId: `EVT-DISP-${seq}`,
            idempotencyKey: `dispatch-capture-${m.missionId}-${seq}`,
            type: 'evidence_captured',
            sceneId: m.sceneId,
            sceneRevision: m.sceneRevision,
            checkpointId: roof,
            reason: `语言指令：采集证据（${normalizedText}）`,
            clientTs: nowIsoShanghai(),
            evidence: (['photo', 'thermal', 'reading'] as const).map((kind) => ({ checkpointId: roof, kind, value: `语言指令取证（${kind}）`, ts: nowIsoShanghai() })),
          });
          if (!res.ok) {
            outcome = { kind: 'capture_evidence', status: 'rejected', code: res.code, message: res.message };
            break;
          }
          mission = res.mission;
          outcome = { kind: 'capture_evidence', status: 'available', detail: res.extra ?? {} };
          break;
        }
      }
    }
    outcomes.push(outcome);
    trace.push({
      label: `执行:${cmd.kind}`,
      status: outcome.status === 'available' ? 'ok' : 'error',
      durationMs: Date.now() - tCmd,
      ...(outcome.status === 'rejected' ? { detail: outcome.code } : {}),
    });
  }

  const anyOk = outcomes.some((o) => o.status === 'available');
  const anyRejected = outcomes.some((o) => o.status === 'rejected');
  const status = outcomes.length === 0 ? 'available' : anyRejected ? (anyOk ? 'partial' : 'rejected') : 'available';

  // 轮次摘要入库（进 prompt 的只有结构化字段）；trace 入库并随响应返回
  recordTurn(conversationId, {
    text: normalizedText,
    scene: input.scene,
    commands: commands.map((c) => ({ kind: c.kind, targetId: 'targetId' in c ? c.targetId : undefined })),
    missionId: mission?.missionId,
    outcomeSummary: outcomes.length ? outcomes.map((o) => `${o.kind}:${o.status}`).join(',') : 'scene-only',
    ts: nowIsoShanghai(),
  });
  trace.push({ label: '总计', status: anyRejected ? (anyOk ? 'warn' : 'error') : 'ok', durationMs: Date.now() - t0 });
  recordTrace(`TRC-${nextSeq('trace')}`, conversationId, trace);

  return { kind: 'ok', status, conversationId, trace, normalizedText, reply, commands, outcomes, mission, planner };
}
