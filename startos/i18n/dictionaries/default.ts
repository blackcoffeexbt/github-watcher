export const DEFAULT_LANG = 'en_US'
const dict = {
  'Starting Release Mailbox!': 0,
  'Web Interface': 1,
  'The web interface is ready': 2,
  'The web interface is not ready': 3,
  'The main web interface': 4,
  'Configure SMTP': 5,
  'Configure email delivery': 6,
  'Set service password': 7,
  'Generate a password for the shared mailbox': 8,
  'Replaces the current password and signs out existing sessions.': 9,
  'Mailbox password': 10,
  'Use this password to open your mailbox.': 11,
  'Password': 12,
  'Set a service password before signing in': 13,
} as const
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
