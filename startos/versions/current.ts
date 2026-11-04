import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.1.0:4',
  releaseNotes: {
    en_US: 'Use Anagram-compatible private DM delivery with sender history and app relays. Add a labeled Mark all as read button.',
    es_ES: 'Mensajes privados compatibles con Anagram y botón Marcar todo como leído.',
    de_DE: 'Private Anagram-Nachrichten und eine Schaltfläche zum Markieren aller Releases als gelesen.',
    pl_PL: 'Prywatne wiadomości zgodne z Anagram i przycisk oznaczania wszystkich wydań jako przeczytane.',
    fr_FR: 'Messages privés compatibles avec Anagram et bouton Tout marquer comme lu.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
