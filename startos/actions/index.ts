import { utils, smtpPrefill } from '@start9labs/start-sdk'
import { sdk } from '../sdk'
import { i18n } from '../i18n'
import { storeJson } from '../fileModels/store.json'
export const manageSmtp = sdk.Action.withInput('manage-smtp', async () => ({ name: i18n('Configure SMTP'), description: i18n('Configure email delivery'), warning: null, allowedStatuses: 'any', group: null, visibility: 'enabled' }), sdk.InputSpec.of({ smtp: sdk.inputSpecConstants.smtpInputSpec }), async ({ effects }) => ({ smtp: smtpPrefill(await storeJson.read(s => s.smtp).const(effects)) }), async ({ effects, input }) => { await storeJson.merge(effects, { smtp: input.smtp }) })
export const setAdminPassword = sdk.Action.withoutInput('set-admin-password', async ({ effects }) => ({ name: i18n('Set service password'), description: i18n('Generate a password for the shared mailbox'), warning: await storeJson.read(s => s.adminPassword).const(effects) ? i18n('Replaces the current password and signs out existing sessions.') : null, allowedStatuses: 'any', group: null, visibility: 'enabled' }), async ({ effects }) => {
  const adminPassword = utils.getDefaultString({ charset: 'a-z,A-Z,0-9', len: 32 })
  await storeJson.merge(effects, { adminPassword })
  return { version: '1', title: i18n('Mailbox password'), message: i18n('Use this password to open your mailbox.'), result: { type: 'single', name: i18n('Password'), description: null, value: adminPassword, masked: true, copyable: true, qr: false, launchable: false } }
})
export const actions = sdk.Actions.of().addAction(manageSmtp).addAction(setAdminPassword)
