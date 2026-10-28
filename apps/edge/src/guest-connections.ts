/**
 * Live guest WebSockets, keyed by guest session.
 *
 * Revoking a guest (or disabling sharing) must close its browser sockets
 * immediately; the session row alone is not enough because DSH keeps a mux
 * WebSocket open. Sessions may have several sockets (the DSH UI opens more than
 * one), so each session maps to a set. Audit connect/disconnect on the first
 * and last socket of a session.
 */
import type { WebSocket } from 'ws';
import type { Logger } from '@dsh-rc/shared';
import type { EdgeDatabase } from './db.js';

interface GuestConnectionMeta {
  deviceId: string;
  label: string;
  ip: string | null;
}

export class GuestConnections {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly meta = new Map<string, GuestConnectionMeta>();

  constructor(
    private readonly db: EdgeDatabase,
    private readonly logger: Logger,
  ) {}

  add(sessionId: string, deviceId: string, ws: WebSocket): void {
    let set = this.sockets.get(sessionId);
    if (set === undefined) {
      set = new Set<WebSocket>();
      this.sockets.set(sessionId, set);
      const session = this.db.getSession(sessionId);
      const meta: GuestConnectionMeta = {
        deviceId,
        label: this.db.getGuestSessionLabel(sessionId) ?? 'Guest',
        ip: session?.ip ?? null,
      };
      this.meta.set(sessionId, meta);
      this.db.addAudit({
        event: 'guest-connected',
        deviceId,
        actor: 'guest',
        ip: meta.ip,
        detail: `${sessionId} · ${meta.label}`,
      });
      this.logger.info('guest websocket connected', { deviceId, sessionId });
    }
    set.add(ws);
  }

  remove(sessionId: string, ws: WebSocket): void {
    const set = this.sockets.get(sessionId);
    if (set === undefined) return;
    set.delete(ws);
    if (set.size > 0) return;
    this.sockets.delete(sessionId);
    const meta = this.meta.get(sessionId);
    this.meta.delete(sessionId);
    this.db.addAudit({
      event: 'guest-disconnected',
      deviceId: meta?.deviceId ?? null,
      actor: 'guest',
      ip: meta?.ip ?? null,
      detail: `${sessionId}${meta === undefined ? '' : ` · ${meta.label}`}`,
    });
    this.logger.info('guest websocket disconnected', { deviceId: meta?.deviceId, sessionId });
  }

  /** Close every socket for one session; code 1008 is policy violation/revoked. */
  closeSession(sessionId: string, reason = 'guest session revoked'): number {
    const set = this.sockets.get(sessionId);
    if (set === undefined) return 0;
    this.sockets.delete(sessionId);
    const meta = this.meta.get(sessionId);
    this.meta.delete(sessionId);
    this.db.addAudit({
      event: 'guest-disconnected',
      deviceId: meta?.deviceId ?? null,
      actor: 'guest',
      ip: meta?.ip ?? null,
      detail: `${sessionId} · ${reason}`,
    });
    const count = set.size;
    for (const ws of set) {
      try {
        ws.close(1008, reason.slice(0, 120));
      } catch {
        /* already closing */
      }
      const forced = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }, 250);
      forced.unref?.();
    }
    return count;
  }

  closeMany(sessionIds: readonly string[], reason = 'guest session revoked'): number {
    let closed = 0;
    for (const sessionId of sessionIds) closed += this.closeSession(sessionId, reason);
    return closed;
  }

  closeAll(reason = 'edge shutting down'): void {
    for (const sessionId of [...this.sockets.keys()]) this.closeSession(sessionId, reason);
  }

  get size(): number {
    return this.sockets.size;
  }
}
