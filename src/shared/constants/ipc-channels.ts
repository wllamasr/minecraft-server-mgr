/** IPC Channel name constants */
export const IPC_CHANNELS = {
  // Server lifecycle
  SERVER_LIST: 'server:list',
  SERVER_CREATE: 'server:create',
  SERVER_START: 'server:start',
  SERVER_STOP: 'server:stop',
  SERVER_DELETE: 'server:delete',
  SERVER_GET: 'server:get',

  // Console
  CONSOLE_SEND_COMMAND: 'console:send-command',

  // Config
  CONFIG_READ_SERVER_PROPERTIES: 'config:read-server-properties',
  CONFIG_WRITE_SERVER_PROPERTIES: 'config:write-server-properties',

  // System
  SYSTEM_SELECT_DIRECTORY: 'system:select-directory',
  SYSTEM_GET_JAVA: 'system:get-java',
  SYSTEM_OPEN_EXTERNAL: 'system:open-external',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // App
  APP_GET_VERSION: 'app:get-version',
  APP_WINDOW_MINIMIZE: 'app:window-minimize',
  APP_WINDOW_MAXIMIZE: 'app:window-maximize',
  APP_WINDOW_CLOSE: 'app:window-close'
} as const

/** IPC Event names (Main → Renderer) */
export const IPC_EVENTS = {
  SERVER_LOG: 'event:server-log',
  SERVER_STATUS_CHANGED: 'event:server-status-changed',
  SERVER_METRICS: 'event:server-metrics',
  DOWNLOAD_PROGRESS: 'event:download-progress'
} as const
