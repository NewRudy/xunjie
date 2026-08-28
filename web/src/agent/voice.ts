// 最小浏览器语音适配（contracts/avatar-command.md §6）：
// 只封装 Web Speech API（zh-CN），把最终转写交给既有 sendAvatarText，
// 仍先进入 POST /api/agent/avatar/interpret；不做后端 ASR，不请求云端密钥。
import { reactive } from 'vue'
import { sendAvatarText } from './controller'
import { log } from './missionStore'

export type VoiceStatus = 'idle' | 'listening' | 'recognizing' | 'unsupported' | 'error'

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function resolveCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const voiceStore = reactive({
  status: 'idle' as VoiceStatus,
  /** 最近一次最终转写（已自动发送给 interpret） */
  transcript: '',
  error: '',
})

let rec: SpeechRecognitionLike | null = null

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: '待命',
  listening: '聆听中',
  recognizing: '识别中',
  unsupported: '不支持',
  error: '错误',
}

export function voiceStatusLabel(): string {
  return STATUS_LABEL[voiceStore.status]
}

/** 同一按钮：待命/错误时启动，聆听/识别中停止 */
export function toggleVoice(): void {
  if (voiceStore.status === 'listening' || voiceStore.status === 'recognizing') {
    stopVoice()
    return
  }
  startVoice()
}

export function startVoice(): void {
  const Ctor = resolveCtor()
  if (!Ctor) {
    voiceStore.status = 'unsupported'
    voiceStore.error = '当前浏览器不支持语音识别（Web Speech API），请使用文字输入'
    log(voiceStore.error)
    return
  }
  rec?.abort()
  const r = new Ctor()
  rec = r
  r.lang = 'zh-CN'
  r.continuous = false
  r.interimResults = true
  voiceStore.error = ''
  voiceStore.transcript = ''
  voiceStore.status = 'listening'
  r.onresult = (e) => {
    let final = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript
    }
    if (final) {
      voiceStore.transcript = final.trim()
      voiceStore.status = 'recognizing'
    }
  }
  r.onerror = (e) => {
    voiceStore.status = 'error'
    voiceStore.error =
      e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? '麦克风权限被拒绝，请授权后重试，或使用文字输入'
        : `语音识别失败（${e.error ?? '未知原因'}），请使用文字输入`
    log(voiceStore.error)
  }
  r.onend = () => {
    rec = null
    if (voiceStore.status === 'listening' || voiceStore.status === 'recognizing') {
      const text = voiceStore.transcript
      voiceStore.status = 'idle'
      if (text) {
        log(`语音转写：「${text}」→ 发送给数字运维员指令入口`)
        void sendAvatarText(text)
      }
    }
  }
  try {
    r.start()
  } catch (e) {
    voiceStore.status = 'error'
    voiceStore.error = `语音识别启动失败：${e instanceof Error ? e.message : String(e)}`
    log(voiceStore.error)
  }
}

export function stopVoice(): void {
  try {
    rec?.stop()
  } catch {
    rec?.abort()
  }
}
