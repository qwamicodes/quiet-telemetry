import type { DockerStatus } from '@/gen'

/** The socket quiet reads, as a path (`unix:///var/run/docker.sock` → `/var/run/docker.sock`). */
export function dockerEndpoint(d: DockerStatus | undefined): string {
  const e = d?.state === 'connected' ? d.endpoint : ''
  return e ? e.replace(/^unix:\/\//, '') : '/var/run/docker.sock'
}

/** `engine 27.3` (major.minor), or '' when the engine didn't say. */
export function dockerEngine(d: DockerStatus | undefined): string {
  if (d?.state !== 'connected' || !d.engine) return ''
  return `engine ${d.engine.split('.').slice(0, 2).join('.')}`
}
