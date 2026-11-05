import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.1.0:7',
  releaseNotes: {
    en_US: 'Configure a shared update interval, daily start time, and timezone in Settings. Show the next check and recover missed checks after downtime.',
    es_ES: 'Configura intervalo, hora de inicio y zona horaria para las actualizaciones en Ajustes.',
    de_DE: 'Gemeinsames Prüfintervall, Startzeit und Zeitzone in den Einstellungen konfigurieren.',
    pl_PL: 'Ustaw wspólny interwał sprawdzania, godzinę rozpoczęcia i strefę czasową.',
    fr_FR: 'Configurez l’intervalle, l’heure de début et le fuseau horaire dans les paramètres.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
