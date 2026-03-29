import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en_common from './locales/en/common.json'
import en_servers from './locales/en/servers.json'
import en_console from './locales/en/console.json'
import en_settings from './locales/en/settings.json'

i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: en_common,
      servers: en_servers,
      console: en_console,
      settings: en_settings
    }
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common', 'servers', 'console', 'settings'],
  interpolation: {
    escapeValue: false
  }
})

export default i18n
