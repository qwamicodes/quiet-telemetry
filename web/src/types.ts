export type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface CorrId {
  key: 'request_id' | 'job_id' | 'trace_id' | 'correlation_id'
  value: string
}

export interface LogLine {
  id: number
  ts: number
  received: number
  source: string
  level: Level | null
  display_id: CorrId | null
  ids: CorrId[]
  msg: string
  fields?: Record<string, unknown>
  raw: string
  flags?: string[]
}

export interface SourceInfo {
  name: string
  kind: 'docker' | 'http'
  containers: string[]
  group: string | null
  lines: number
  last_ts: number | null
}

export type Frame =
  | { type: 'backlog'; lines: LogLine[] }
  | { type: 'lines'; lines: LogLine[] }
  | { type: 'gap'; dropped: number }
  | { type: 'error'; message: string }

export interface Health {
  ok: boolean
  version: string
  started: number
  docker:
    | { state: 'disabled' | 'connecting' }
    | { state: 'connected'; containers: number }
    | { state: 'unavailable'; error: string }
}
