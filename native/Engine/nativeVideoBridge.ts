// SPDX-License-Identifier: GPL-3.0-or-later
// Keep media bytes in the engine. Swift receives only per-item loopback URLs.
import type { CpStack } from './protocol/cpStack'
import type { VideoResource } from './protocol/videoPlayback'

interface ResourceServer {
  start(itemId: string, url: string, streaming: boolean): Promise<string | undefined>
  stop(): void
  close(): void
}
const { VideoResourceServer } = require('./video-resource-server.cjs') as {
  VideoResourceServer: new (resolve: (itemId: string, url: string) => Promise<VideoResource>) => ResourceServer
}
type HostMessage = Record<string, unknown>
type Owner = Pick<CpStack, 'resolveVideoUrl' | 'updateVideoState'>

export class NativeVideoBridge {
  private proxy?: ResourceServer
  private current?: { id: string; owner: Owner; ready: boolean; queued: HostMessage[] }
  private closed = false
  constructor(private send: (message: HostMessage) => void) {}

  handle(owner: Owner, message: HostMessage): void {
    if (this.closed || typeof message.itemId !== 'string') return
    if (message.action === 'load') {
      this.stop()
      const item = { id: message.itemId, owner, ready: false, queued: [] as HostMessage[] }
      this.current = item
      const proxy = this.proxy ??= new VideoResourceServer((id, url) => this.current?.id === id
        ? this.current.owner.resolveVideoUrl(id, url) : Promise.resolve({ status: 410 }))
      void proxy.start(item.id, String(message.url), message.streaming === true).then(url => {
        if (this.current !== item || !url) return
        // A setRate or seek can arrive before the proxy has bound its local port.
        this.send({ type: 'native-video', ...message, url })
        item.ready = true
        for (const pending of item.queued) this.send({ type: 'native-video', ...pending })
        item.queued = []
      }).catch(() => {
        if (this.current !== item) return
        owner.updateVideoState(item.id, { error: 'network' })
        this.stop()
      })
      return
    }
    const item = this.current
    if (!item || item.owner !== owner || item.id !== message.itemId) return
    if (message.action === 'stop') { this.stop(); return }
    if (item.ready) this.send({ type: 'native-video', ...message })
    else {
      // Retain the most recent control of each kind while the server starts.
      item.queued = item.queued.filter(value => value.action !== message.action)
      item.queued.push(message)
    }
  }

  update(itemId: string, state: Record<string, unknown>): void {
    if (this.current?.id === itemId) this.current.owner.updateVideoState(itemId, state)
  }

  stop(owner?: Owner): void {
    if (owner && this.current?.owner !== owner) return
    const item = this.current
    this.current = undefined
    this.proxy?.stop()
    if (item) this.send({ type: 'native-video', action: 'stop', itemId: item.id })
  }

  close(): void { this.closed = true; this.stop(); this.proxy?.close() }
}
