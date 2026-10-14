// SPDX-License-Identifier: GPL-3.0-or-later
// Remote playback control adapted from DiPlay's CarPlayVideo.kt/VideoInCar.kt.
import { randomBytes } from 'node:crypto'
import type { PlistValue } from './bplist'
import { asVideoMessage, playableUrl, timeSeconds, playbackResponse, propertyResponse, videoError,
  type VideoMessage, type VideoPlayerState } from './videoInCar'

export interface VideoResource { status: number; data?: Buffer; location?: string; contentType?: string }
export class VideoPlayback {
  private stream?: number
  private uuid?: PlistValue
  private itemId?: string
  private state?: VideoPlayerState
  private requestId = 0
  private pending = new Map<number, { resolve: (value: VideoResource) => void; timer: NodeJS.Timeout }>()
  constructor(private send: (stream: number, message: VideoMessage) => boolean,
    private emit: (message: Record<string, unknown>) => void,
    private allowed: () => boolean) {}

  handle(stream: number, message: VideoMessage): void {
    const type = message.type
    // A response from the overlay stream must not steal playback's reply stream.
    if (type === 'unhandledURL') {
      const result = asVideoMessage(message.response), id = Number(result?.FCUP_Response_RequestID)
      const pending = this.pending.get(id)
      if (pending && result) {
        this.pending.delete(id); clearTimeout(pending.timer)
        const headers = asVideoMessage(result.FCUP_Response_Headers)
        pending.resolve({ status: Number(result.FCUP_Response_StatusCode) || 200,
          data: Buffer.isBuffer(result.FCUP_Response_Data) ? result.FCUP_Response_Data : undefined,
          location: typeof headers?.Location === 'string' ? headers.Location : typeof headers?.location === 'string' ? headers.location : undefined,
          contentType: typeof headers?.['Content-Type'] === 'string' ? headers['Content-Type'] : undefined })
      }
      return
    }
    const request = message.kind === 'request'
    if (type === 'insertPlayQueueItem') {
      const item = asVideoMessage(message.item)
      if (!this.allowed() || !item || !playableUrl(item['Content-Location'])) {
        this.send(stream, videoError(item?.uuid, -12927)); return
      }
      this.stop()
      this.stream = stream; this.uuid = item.uuid; this.itemId = randomBytes(12).toString('hex')
      const seconds = typeof item['Start-Position-Seconds'] === 'number' ? item['Start-Position-Seconds'] : timeSeconds(item['Start-Position'])
      const start = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, seconds) : 0
      this.state = { prepared: false, playing: false, positionSeconds: start, durationSeconds: 0, bufferedSeconds: 0 }
      this.emit({ action: 'load', itemId: this.itemId, url: item['Content-Location'], streaming: item.mediaType === 'streaming', start })
    } else if (type === 'playbackInfo' && request) {
      this.send(stream, playbackResponse(message.messageID, this.uuid, this.state))
    } else if (type === 'property' && request) {
      this.send(stream, propertyResponse(message.messageID, message.property, this.state))
    } else if (type === 'setRate' && this.itemId && this.allowed()) {
      this.emit({ action: 'rate', itemId: this.itemId, playing: Number(message.rate) > 0 })
    } else if (type === 'seek') {
      const seconds = timeSeconds(message.time)
      if (seconds !== undefined && this.itemId && this.allowed()) this.emit({ action: 'seek', itemId: this.itemId, seconds })
      if (request) this.send(stream, { type: 'seek', kind: 'response', ...(message.messageID === undefined ? {} : { messageID: message.messageID }) })
    } else if (type === 'stop' || type === 'removePlayQueueItem') this.stop()
  }

  show(): void { if (this.allowed() && this.itemId) this.emit({ action: 'show', itemId: this.itemId }) }
  closeStream(stream: number): void { if (stream === this.stream) this.stop() }
  update(itemId: string, value: Record<string, unknown>): void {
    if (!this.itemId || itemId !== this.itemId || this.stream === undefined) return
    if (value.error) {
      this.send(this.stream, videoError(this.uuid, value.error === 'network' ? -17221 : -12927))
      this.stop(); return
    }
    const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0
    const state = { prepared: value.prepared === true, playing: value.playing === true && this.allowed(),
      positionSeconds: finite(value.positionSeconds), durationSeconds: finite(value.durationSeconds), bufferedSeconds: finite(value.bufferedSeconds) }
    const changed = this.state?.playing !== state.playing
    this.state = state
    if (changed) this.send(this.stream, { type: 'playbackState', name: state.playing ? 'playing' : 'paused',
      ...(state.playing && this.uuid !== undefined ? { item: { uuid: this.uuid } } : {}) })
  }

  resolveUrl(itemId: string, url: string): Promise<VideoResource> {
    if (itemId !== this.itemId || !this.allowed() || !playableUrl(url) || this.stream === undefined || this.pending.size >= 32)
      return Promise.resolve({ status: 403 })
    const id = ++this.requestId
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ status: 504 }) }, 10000)
      this.pending.set(id, { resolve, timer })
      if (!this.send(this.stream!, { type: 'unhandledURL', kind: 'request',
        request: { FCUP_Response_URL: url, FCUP_Response_IsContentKeyRequest: false, FCUP_Response_RequestID: id },
        ...(this.uuid === undefined ? {} : { item: { uuid: this.uuid } }) })) {
        clearTimeout(timer); this.pending.delete(id); resolve({ status: 503 })
      }
    })
  }
  stop(): void {
    if (this.itemId) this.emit({ action: 'stop', itemId: this.itemId })
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ status: 410 }) }
    this.pending.clear(); this.itemId = undefined; this.uuid = undefined; this.stream = undefined; this.state = undefined
  }
}
