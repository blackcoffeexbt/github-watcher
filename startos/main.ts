import { writeFile, chown } from 'node:fs/promises'
import { T } from '@start9labs/start-sdk'
import { sdk } from './sdk'
import { i18n } from './i18n'
import { storeJson } from './fileModels/store.json'
import { uiPort } from './utils'
export const main = sdk.setupMain(async ({ effects }) => {
  const password = await storeJson.read(s => s.adminPassword).const(effects)
  const selection = await storeJson.read(s => s.smtp).const(effects)
  let smtp: T.SmtpValue | null = null
  if (selection?.selection === 'system') {
    smtp = await sdk.getSystemSmtp(effects).const()
    if (smtp && selection.value.customFrom) smtp = { ...smtp, from: selection.value.customFrom }
  } else if (selection?.selection === 'custom') {
    const { host, from, username, password, security } = selection.value.provider.value
    smtp = { host, from, username, password, port: Number(security.value.port), security: security.selection }
  }
  const sub = sdk.SubContainer.of(effects, { imageId: 'mailbox' }, sdk.Mounts.of().mountVolume({ volumeId: 'main', subpath: null, mountpoint: '/data', readonly: false }), 'mailbox')
  const runtime = `${await sub.rootfs}/app/runtime.json`
  await writeFile(runtime, JSON.stringify({ password: password || null, smtp }), { mode: 0o600 })
  await chown(runtime, 1000, 1000)
  return sdk.Daemons.of(effects).addOneshot('prepare-data', {
    subcontainer: sub,
    exec: { command: ['chown', '-R', '1000:1000', '/data'], user: 'root' },
    requires: [],
  }).addDaemon('mailbox', {
    subcontainer: sub,
    exec: { command: ['node', 'dist-server/index.js'], cwd: '/app', env: { HOST: '0.0.0.0', PORT: String(uiPort), DATABASE_PATH: '/data/mailbox.sqlite', RUNTIME_CONFIG: '/app/runtime.json' } },
    ready: { display: i18n('Web Interface'), fn: () => sdk.healthCheck.checkWebUrl(effects, `http://127.0.0.1:${uiPort}/health`, { successMessage: i18n('The web interface is ready'), errorMessage: i18n('The web interface is not ready') }) },
    requires: ['prepare-data'],
  })
})
