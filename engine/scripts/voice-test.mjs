#!/usr/bin/env node
// 豆包 Seed ASR 协议测试（engine/scripts/voice-test.mjs，离线，不外呼）
// 覆盖：帧打包（header/长度/gzip 负载）、结束包 flags、服务端帧解析（JSON/gzip/error 帧）、
//       识别文本提取（definite 语句拼接 / result.text 回退）、凭据未配置守卫、路由 503。
// 用法：pnpm test:voice（退出码 0=全绿）
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

const tmpDb = path.join(os.tmpdir(), `voice-test-${process.pid}.db`);
process.env.PECC_DB = tmpDb;
for (const k of ['DOUBAO_ASR_RESOURCE_ID', 'DOUBAO_ASR_API_KEY', 'DOUBAO_ASR_APP_KEY', 'DOUBAO_ASR_ACCESS_KEY']) delete process.env[k];

const { buildFullClientRequest, buildAudioOnlyRequest, parseServerResponse, extractTranscript, voiceConfigured } = await import('../src/agent/voice.ts');
const { agentRoutes } = await import('../src/agent/routes.ts');

// ---------- 1. 帧打包 ----------
section('Seed 帧打包（header / 长度前缀 / gzip 负载）');
{
  const cfg = { user: { uid: 'r1' }, audio: { format: 'pcm' } };
  const full = buildFullClientRequest(cfg);
  ok(full[0] === 0x11 && full[1] === 0x10 && full[2] === 0x11 && full[3] === 0x00, '首帧 header 字节', [full[0], full[1], full[2], full[3]].join(','));
  const len = full.readUInt32BE(4);
  ok(len === full.length - 8, '长度前缀 = 负载字节数', `${len} vs ${full.length - 8}`);
  ok(full.subarray(8).length > 0 && full[8] === 0x1f && full[9] === 0x8b, '负载为 gzip 魔数', `${full[8].toString(16)}${full[9].toString(16)}`);

  const audio = buildAudioOnlyRequest(Buffer.from([1, 2, 3]));
  ok(audio[1] === 0x20 && audio[2] === 0x01, '音频帧 header（NO_SEQUENCE + gzip）', [audio[1], audio[2]].join(','));
  const fin = buildAudioOnlyRequest(Buffer.alloc(0), true);
  ok(fin[1] === 0x22, '结束包 flag=LAST_PACKET(0x22)', fin[1].toString(16));
}

// ---------- 2. 服务端帧解析 ----------
section('服务端帧解析（gzip JSON / error 帧 / isLast）');
{
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text: '' } }), 'utf8'));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length);
  const frame = Buffer.concat([Buffer.from([0x11, 0x92, 0x11, 0x00]), lenBuf, payload]);
  const r = parseServerResponse(frame);
  ok(r.messageType === 0x9 && r.isLast === true && r.payload?.result?.text === '', 'FULL_RESPONSE + isLast 解析', JSON.stringify(r.payload));

  const errPayload = gzipSync(Buffer.from(JSON.stringify({ message: 'quota exceeded' }), 'utf8'));
  const errSize = Buffer.alloc(4);
  errSize.writeUInt32BE(errPayload.length);
  const errFrame = Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x11, 0x00]), // header：message=SERVER_ERROR
    Buffer.alloc(4),                        // error code = 0
    errSize,                                // payload size
    errPayload,
  ]);
  const e = parseServerResponse(errFrame);
  ok(e.messageType === 0xf && e.errorCode === 0 && String(e.errorMessage).includes('quota'), '错误帧解析（code + message）', String(e.errorMessage));
}

// ---------- 3. 文本提取 ----------
section('识别文本提取（definite 拼接 / result.text 回退）');
{
  const t1 = extractTranscript({ result: { utterances: [{ text: '飞到', definite: true }, { text: '七号', definite: false }, { text: '风机', definite: true }] } });
  ok(t1 === '飞到风机', 'definite 语句拼接（partial 剔除）', t1);
  const t2 = extractTranscript({ result: { text: '跑到 2 号风机' } });
  ok(t2 === '跑到 2 号风机', 'result.text 回退', t2);
  ok(extractTranscript({}) === '', '空 payload → 空文本');
}

// ---------- 4. 未配置守卫 + 路由 503 ----------
section('凭据未配置：voiceConfigured=false + 路由 503');
{
  ok(voiceConfigured() === false, '无凭据 → voiceConfigured=false');
  const res = await agentRoutes.request('/voice/asr', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) });
  const body = await res.json();
  ok(res.status === 503 && body.error?.code === 'VOICE_NOT_CONFIGURED', '未配置 → 503 VOICE_NOT_CONFIGURED（不外呼）', JSON.stringify(body.error));
  const empty = await agentRoutes.request('/voice/asr', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(0) });
  ok(empty.status === 503, '未配置优先于空音频（仍 503）');

  process.env.DOUBAO_ASR_RESOURCE_ID = 'volc.demo';
  process.env.DOUBAO_ASR_API_KEY = 'demo-key';
  ok(voiceConfigured() === true, '配置后 → voiceConfigured=true');
  delete process.env.DOUBAO_ASR_RESOURCE_ID;
  delete process.env.DOUBAO_ASR_API_KEY;
}

// ---------- 汇总 ----------
fs.rmSync(tmpDb, { force: true });
console.log(`\n========================================`);
console.log(`voice-test 结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('语音协议测试全部通过 ✔');
