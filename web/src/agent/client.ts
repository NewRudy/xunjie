// 类型安全的引擎 Agent API client（contracts/agent-tools.md §2）。
// 引擎地址通过 VITE_ENGINE_BASE_URL 配置，默认 http://localhost:8787。
import type {
  ApprovalInput,
  CreateMissionInput,
  MissionResponse,
  SceneEvent,
} from './types'

const BASE_URL: string =
  (import.meta.env.VITE_ENGINE_BASE_URL as string | undefined) ?? 'http://localhost:8787'

export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'AgentApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new AgentApiError('引擎不可达', null, 'ENGINE_UNREACHABLE')
  }
  const text = await res.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      throw new AgentApiError(`引擎返回非 JSON（HTTP ${res.status}）`, res.status, 'BAD_JSON')
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new AgentApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code)
  }
  return json as T
}

export const agentApi = {
  baseUrl: BASE_URL,
  createMission: (input: CreateMissionInput) =>
    request<MissionResponse>('POST', '/api/agent/missions', input),
  getMission: (missionId: string) =>
    request<MissionResponse>('GET', `/api/agent/missions/${encodeURIComponent(missionId)}`),
  postApproval: (missionId: string, input: ApprovalInput) =>
    request<MissionResponse>(
      'POST',
      `/api/agent/missions/${encodeURIComponent(missionId)}/approval`,
      input,
    ),
  postEvent: (missionId: string, event: SceneEvent) =>
    request<MissionResponse>(
      'POST',
      `/api/agent/missions/${encodeURIComponent(missionId)}/events`,
      event,
    ),
}
