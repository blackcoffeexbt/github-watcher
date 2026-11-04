import { sdk } from './sdk'
import { i18n } from './i18n'
import { uiPort } from './utils'
export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const host = sdk.MultiHost.of(effects, 'ui')
  const origin = await host.bindPort(uiPort, { protocol: 'http', preferredExternalPort: 80 })
  const ui = sdk.createInterface(effects, { id: 'ui', name: i18n('Web Interface'), description: i18n('The main web interface'), type: 'ui', masked: false, schemeOverride: null, username: null, path: '', query: {} })
  return [await origin.export([ui])]
})
