import type { TickSample } from '../utils/tick-query'

export interface ServerTelemetry {
  serverId: string
  cpu: number // percentage
  memory: number // bytes
  onlinePlayers: number
  maxPlayers: number
  /**
   * The server's last answer about its tick time, and when it came (`at`,
   * epoch ms). The server is only asked while its page is open, so this can
   * be old: check `at` before showing it as the current state.
   */
  tick?: TickSample & { at: number }
  /**
   * Why there is no tick time and none will come: the Minecraft version has
   * no `tick query` (before 1.20.3), or the server did not answer it.
   */
  tickStatus?: 'unsupported' | 'unavailable'
  timestamp: number
}
