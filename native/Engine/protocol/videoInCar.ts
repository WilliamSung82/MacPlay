// SPDX-License-Identifier: GPL-3.0-or-later
// Protocol shapes adapted from shihabal3amri/DiPlay, VideoInCar.kt.
// See docs/carplay-video.md for provenance and the supported playback scope.
import type { PlistValue } from './bplist'

export type VideoMessage = Record<string, PlistValue>
export const VIDEO_FEATURE = 'videoPlayback'
export const VIDEO_UI_URL = 'videoplayback:'
export const VIDEO_SETTINGS_UUID = 'BB493F61-A6B8-4769-8D74-80C23A9F71C4'
export const VIDEO_REMOTE_UUIDS = new Set([
  'A6B27562-B43A-4F2D-B75F-82391E250194',
  'E3DC3EA6-E6C3-4B30-847C-B7ACFEBEA654'
])

export function videoPlaybackInfo(legacy: number | bigint, allowed: boolean): VideoMessage {
  let bits = BigInt(legacy) | 1n | (1n << 64n)
  const bytes: number[] = []
  do { bytes.push(Number(bits & 255n)); bits >>= 8n } while (bits)
  return {
    videoPlaybackAllowed: allowed,
    featuresEx: Buffer.from(bytes).toString('base64'),
    playbackCapabilities: {
      supportsOfflineHLS: false, supportsAirPlayVideoWithSharePlay: false,
      supportsInterstitials: false, supportsIntegratedTimeline: false,
      supportsAVMetrics: false, supportsUIForAudioOnlyContent: true,
      supportsFPSSecureStop: false
    }
  }
}

export function asVideoMessage(value: unknown): VideoMessage | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
    ? value as VideoMessage : undefined
}

export function playableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384) return false
  try {
    const url = new URL(value)
    return !url.username && !url.password && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
      !['file:', 'content:', 'asset:', 'rawresource:', 'android.resource:', 'skd:',
        'javascript:', 'data:', 'blob:', 'about:', 'chrome:', 'devtools:'].includes(url.protocol)
  } catch { return false }
}

export function timeSeconds(time: unknown): number | undefined {
  const t = asVideoMessage(time)
  if (!t || !['number', 'bigint'].includes(typeof t.value) || !['number', 'bigint'].includes(typeof t.timescale)) return
  const result = Number(t.value) / Number(t.timescale)
  return Number(t.timescale) > 0 && Number.isFinite(result) ? Math.max(0, result) : undefined
}

export function cmTime(seconds: number): VideoMessage {
  return { value: Math.round(seconds * 1000), timescale: 1000, flags: 1, epoch: 0 }
}

export interface VideoPlayerState {
  prepared: boolean; playing: boolean; positionSeconds: number
  durationSeconds: number; bufferedSeconds: number
}
const range = (seconds: number): VideoMessage => ({ start: cmTime(0), duration: cmTime(seconds) })
const response = (type: string, id: PlistValue | undefined): VideoMessage =>
  ({ type, kind: 'response', ...(id === undefined ? {} : { messageID: id }) })

export function playbackResponse(id: PlistValue | undefined, uuid: PlistValue | undefined, state?: VideoPlayerState): VideoMessage {
  const ready = state?.prepared === true
  const info: VideoMessage = {
    item: uuid === undefined ? {} : { uuid }, rate: state?.playing ? 1 : 0,
    readyToPlay: ready, playbackLikelyToKeepUp: ready,
    droppedVideoFrames: 0, totalVideoFrames: 0, decodedFrameCount: 0,
    playbackState: !ready ? 'loading' : state?.playing ? 'playing' : 'paused', interstitialInfo: {}
  }
  if (state && ready) Object.assign(info, {
    position: cmTime(state.positionSeconds), duration: cmTime(state.durationSeconds),
    seekableTimeRanges: [range(state.durationSeconds)], loadedTimeRanges: [range(state.bufferedSeconds)]
  })
  return { ...response('playbackInfo', id), info }
}

export function propertyResponse(id: PlistValue | undefined, key: PlistValue | undefined, state?: VideoPlayerState): VideoMessage {
  const result = response('property', id)
  if (key !== undefined) result.key = key
  if (key === 'hasEnabledAudio') result.value = true
  if (key === 'muted') result.value = false
  if (state?.prepared && key === 'seekableTimeRanges') result.value = [range(state.durationSeconds)]
  if (state?.prepared && key === 'loadedTimeRanges') result.value = [range(state.bufferedSeconds)]
  return result
}

export function videoError(uuid: PlistValue | undefined, code: number): VideoMessage {
  return { type: 'error', error: { domain: '', code }, ...(uuid === undefined ? {} : { uuid }) }
}
