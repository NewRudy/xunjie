// 豆包 Seed ASR 客户端（协议移植自 pipe-report-agent asr/protocol.py + client.py）
// 语音输入：前端采 PCM 16k → POST /api/agent/voice/asr → 本模块经 WebSocket 打包帧发豆包，
// 汇总 definite 语句返回识别文本。凭据全走环境变量，不配置即显式未启用（不外呼、不落库）。
// 回复播报沿用页面浏览器本地 TTS（管网项目无 TTS 链路）。
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';

// —— Seed 二进制帧协议（contracts 参照：豆包 SAUC bigmodel） ——

const PROTOCOL_VERSION_AND_HEADER_SIZE = 0x11;
const FULL_CLIENT_REQUEST = 0x1;
const AUDIO_ONLY_REQUEST = 0x2;
const FULL_SERVER_RESPONSE = 0x9;
const SERVER_ERROR_RESPONSE = 0xf;
const NO_SEQUENCE = 0x0;
const LAST_PACKET_WITHOUT_SEQUENCE = 0x2;
const JSON_SERIALIZATION = 0x1;
const NO_SERIALIZATION = 0x0;
const GZIP_COMPRESSION = 0x1;

function packFrame(header: Buffer, payload: Buffer): Buffer {
  return Buffer.concat([header, (() => { const b = Buffer.alloc(4); b.writeUInt32BE(payload.length); return b; })(), payload]);
}

/** 首帧：JSON 配置（gzip 压缩） */
export function buildFullClientRequest(request: Record<string, unknown>): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify(request), 'utf8'));
  const header = Buffer.from([PROTOCOL_VERSION_AND_HEADER_SIZE, (FULL_CLIENT_REQUEST << 4) | NO_SEQUENCE, (JSON_SERIALIZATION << 4) | GZIP_COMPRESSION, 0]);
  return packFrame(header, payload);
}

/** 音频帧（gzip）；final=true 发送空负载结束包 */
export function buildAudioOnlyRequest(audio: Buffer, final = false): Buffer {
  const payload = gzipSync(audio);
  const flags = final ? LAST_PACKET_WITHOUT_SEQUENCE : NO_SEQUENCE;
  const header = Buffer.from([PROTOCOL_VERSION_AND_HEADER_SIZE, (AUDIO_ONLY_REQUEST << 4) | flags, (NO_SERIALIZATION << 4) | GZIP_COMPRESSION, 0]);
  return packFrame(header, payload);
}

export interface SeedResponse {
  messageType: number;
  payload: Record<string, unknown> | null;
  errorCode: number | null;
  errorMessage: string | null;
  isLast: boolean;
}

/** 解析服务端帧（FULL_SERVER_RESPONSE / SERVER_ERROR_RESPONSE） */
export function parseServerResponse(frame: Buffer): SeedResponse {
  if (frame.length < 8) throw new Error('Seed frame shorter than header');
  const version = frame[0] >> 4;
  const headerSize = (frame[0] & 0x0f) * 4;
  if (version !== 1 || headerSize < 4 || frame.length < headerSize + 4) throw new Error('unsupported Seed header');
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let offset = headerSize;
  // flags & 0x1：带 4 字节序号（bigmodel_async 结果帧会带，须跳过再读负载长度）
  if ((flags & 0x1) !== 0) {
    if (frame.length < offset + 4) throw new Error('Seed frame missing sequence');
    offset += 4;
  }

  const readPayload = (): Buffer => {
    const size = frame.readUInt32BE(offset);
    const payload = frame.subarray(offset + 4, offset + 4 + size);
    if (compression === GZIP_COMPRESSION) return gunzipSync(payload);
    if (compression !== 0) throw new Error('unsupported Seed compression');
    return Buffer.from(payload);
  };

  if (messageType === SERVER_ERROR_RESPONSE) {
    const errorCode = frame.readUInt32BE(offset);
    offset += 4; // 错误码之后才是负载长度（对齐 pipe-report-agent _read_payload 语义）
    let errorMessage = 'upstream ASR error';
    try {
      const payload = readPayload();
      const decoded = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      const msg = decoded.message ?? decoded.error;
      if (typeof msg === 'string' && msg) errorMessage = msg;
    } catch {
      /* 保留默认错误文案 */
    }
    return { messageType, payload: null, errorCode, errorMessage, isLast: true };
  }
  if (messageType !== FULL_SERVER_RESPONSE) throw new Error('unsupported Seed message type');
  const payload = readPayload();
  if (serialization !== JSON_SERIALIZATION) throw new Error('Seed result not JSON');
  const decoded = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  return { messageType, payload: decoded, errorCode: null, errorMessage: null, isLast: (flags & 0x2) !== 0 };
}

// —— 配置（全环境变量；未配置 = 功能显式未启用） ——

export interface VoiceConfig {
  endpoint: string;
  resourceKey: { apiKey?: string; appKey?: string; accessKey?: string };
  resourceId: string;
  hotwordTableId?: string;
  correctTableId?: string;
}

export function readVoiceConfig(): VoiceConfig | null {
  const endpoint = process.env.DOUBAO_ASR_ENDPOINT || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
  const resourceId = process.env.DOUBAO_ASR_RESOURCE_ID ?? '';
  const apiKey = process.env.DOUBAO_ASR_API_KEY ?? '';
  const appKey = process.env.DOUBAO_ASR_APP_KEY ?? '';
  const accessKey = process.env.DOUBAO_ASR_ACCESS_KEY ?? '';
  if (!resourceId) return null;
  if (!apiKey && !(appKey && accessKey)) return null;
  return {
    endpoint,
    resourceId,
    resourceKey: apiKey ? { apiKey } : { appKey, accessKey },
    ...(process.env.DOUBAO_ASR_HOTWORD_TABLE_ID ? { hotwordTableId: process.env.DOUBAO_ASR_HOTWORD_TABLE_ID } : {}),
    ...(process.env.DOUBAO_ASR_CORRECT_TABLE_ID ? { correctTableId: process.env.DOUBAO_ASR_CORRECT_TABLE_ID } : {}),
  };
}

export const voiceConfigured = (): boolean => readVoiceConfig() !== null;

/** 从 Seed payload 提取识别文本：definite 语句拼接；无 utterances 时回退 result.text */
export function extractTranscript(payload: Record<string, unknown>): string {
  const result = payload.result as Record<string, unknown> | undefined;
  if (!result) return '';
  const utterances = result.utterances as Array<{ text?: unknown; definite?: unknown }> | undefined;
  if (Array.isArray(utterances)) {
    return utterances
      .filter((u) => u.definite === true && typeof u.text === 'string')
      .map((u) => String(u.text))
      .join('')
      .trim();
  }
  return typeof result.text === 'string' ? result.text.trim() : '';
}

const AUDIO_FRAME_BYTES = 9600; // ≈300ms @16k/16bit/mono

/** 一次完整识别：PCM 16k/16bit/mono → 中文文本（含标点与 ITN） */
export function doubaoAsrTranscribe(pcm: Buffer, requestId: string): Promise<string> {
  const cfg = readVoiceConfig();
  if (!cfg) return Promise.reject(new Error('VOICE_NOT_CONFIGURED'));
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(cfg.endpoint, {
      headers: {
        ...(cfg.resourceKey.apiKey ? { 'X-Api-Key': cfg.resourceKey.apiKey } : { 'X-Api-App-Key': cfg.resourceKey.appKey!, 'X-Api-Access-Key': cfg.resourceKey.accessKey! }),
        'X-Api-Resource-Id': cfg.resourceId,
        'X-Api-Request-Id': requestId,
        'X-Api-Connect-Id': requestId,
        'X-Api-Sequence': '-1',
      },
      handshakeTimeout: 10_000,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('ASR_TIMEOUT'));
    }, 20_000);

    const fail = (err: Error) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关闭 */ }
      reject(err);
    };
    const done = (text: string) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关闭 */ }
      resolve(text);
    };

    ws.on('unexpected-response', (_req, res) => fail(new Error(`ASR_HTTP_${res.statusCode}`)));
    ws.on('error', (err) => fail(err.message === 'unexpected response' ? new Error('ASR_HTTP_ERROR') : err));
    ws.on('open', () => {
      const request: Record<string, unknown> = {
        user: { uid: requestId },
        audio: { format: 'pcm', codec: 'raw', rate: 16_000, bits: 16, channel: 1 },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
          result_type: 'full',
          enable_nonstream: true,
          ...(cfg.hotwordTableId || cfg.correctTableId ? { corpus: { ...(cfg.hotwordTableId ? { boosting_table_id: cfg.hotwordTableId } : {}), ...(cfg.correctTableId ? { correct_table_id: cfg.correctTableId } : {}) } } : {}),
        },
      };
      ws.send(buildFullClientRequest(request));
      for (let offset = 0; offset < pcm.length; offset += AUDIO_FRAME_BYTES) {
        ws.send(buildAudioOnlyRequest(pcm.subarray(offset, Math.min(offset + AUDIO_FRAME_BYTES, pcm.length))));
      }
      ws.send(buildAudioOnlyRequest(Buffer.alloc(0), true));
    });
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const frame = parseServerResponse(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        if (frame.messageType === SERVER_ERROR_RESPONSE) return fail(new Error(`ASR_UPSTREAM_${frame.errorCode}`));
        const text = frame.payload ? extractTranscript(frame.payload) : '';
        if (frame.isLast) return done(text);
      } catch (e) {
        return fail(e instanceof Error ? e : new Error('ASR_PARSE_FAILED'));
      }
    });
  });
}
