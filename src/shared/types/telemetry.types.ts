export interface ServerTelemetry {
  serverId: string
  cpu: number // percentage
  memory: number // bytes
  onlinePlayers: number
  maxPlayers: number
  timestamp: number
}
