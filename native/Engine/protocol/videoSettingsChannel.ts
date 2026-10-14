// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted from DiPlay's VideoSettingsChannel. Separate from the iAP tunnel.
import net from 'node:net'
import { ControlCipher } from './controlCipher'

export class VideoSettingsChannel {
  private server?: net.Server
  private socket?: net.Socket
  private closed = false
  constructor(private readonly readKey: Buffer, private readonly writeKey: Buffer, private readonly peer: string) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        const norm = (s: string) => s.replace(/^::ffff:/i, '').replace(/%.*$/, '')
        if (this.closed || this.socket || norm(socket.remoteAddress || '') !== norm(this.peer)) { socket.destroy(); return }
        this.socket = socket
        const cipher = new ControlCipher(this.readKey, this.writeKey)
        let encrypted: Buffer = Buffer.alloc(0), plain: Buffer = Buffer.alloc(0)
        socket.on('data', (chunk: Buffer) => {
          try {
            encrypted = Buffer.concat([encrypted, chunk])
            const decoded = cipher.decrypt(encrypted)
            encrypted = decoded.rest
            plain = Buffer.concat([plain, decoded.data])
            if (plain.length > 8 * 1024 * 1024) throw Error('Video settings package exceeds limit')
            while (plain.length >= 32) {
              const size = plain.readUInt32BE(0)
              if (size < 32 || size > 8 * 1024 * 1024) throw Error('Invalid video settings package')
              if (plain.length < size) break
              if (plain.subarray(4, 16).toString('ascii').replace(/\0+$/, '') === 'sync') {
                const reply = Buffer.alloc(32)
                reply.writeUInt32BE(32, 0); reply.write('rply', 4, 'ascii')
                plain.copy(reply, 20, 20, 28)
                socket.write(cipher.encrypt(reply))
              }
              plain = plain.subarray(size)
            }
          } catch { this.stop() }
        })
        socket.on('error', () => this.stop())
        socket.on('close', () => this.stop())
      })
      this.server = server
      server.on('error', reject)
      server.listen({ host: '::', port: 0, ipv6Only: false }, () => {
        const addr = server.address()
        if (typeof addr !== 'object' || !addr) { reject(Error('Video settings listener closed')); return }
        resolve(addr.port)
      })
    })
  }
  stop(): void { if (this.closed) return; this.closed = true; this.socket?.destroy(); this.server?.close() }
}
