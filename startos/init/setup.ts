import { sdk } from '../sdk'
import { storeJson } from '../fileModels/store.json'
import { setAdminPassword } from '../actions'
import { i18n } from '../i18n'
export const setup = sdk.setupOnInit(async effects => {
  await storeJson.merge(effects, {})
  if (!(await storeJson.read(s => s.adminPassword).const(effects))) await sdk.action.createOwnTask(effects, setAdminPassword, 'critical', { reason: i18n('Set a service password before signing in') })
})
