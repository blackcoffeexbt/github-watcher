import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'
const sourceUrl = 'https://github.com/blackcoffeexbt/github-watcher'
export const manifest = setupManifest({
  id: 'release-mailbox', title: 'Release Mailbox', license: 'MIT',
  packageRepo: sourceUrl, upstreamRepo: sourceUrl, marketingUrl: sourceUrl, donationUrl: null, description: { short, long },
  volumes: ['main', 'startos'],
  images: { mailbox: { source: { dockerBuild: {} }, arch: ['x86_64', 'aarch64'] } },
})
