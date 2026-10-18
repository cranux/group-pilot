import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import type { HubClient, RealtimeHub, WsFrame } from './hub.js';

const AUTH_TIMEOUT_MS = 10_000;

/**
 * WS /ws：连接后先发 { type: 'auth', accessToken, sinceSeq? }，
 * 回 { type: 'auth', success: true, latestSeq } 后开始推 { seq, type, payload }；带 sinceSeq 时先补发。
 */
export function registerWebSocket(app: FastifyInstance, hub: RealtimeHub, auth: AuthService): void {
  app.get('/ws', { websocket: true }, (socket) => {
    let client: HubClient | null = null;
    let authenticating = false;
    const send = (data: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
    };
    const timer = setTimeout(() => socket.close(4000, 'auth timeout'), AUTH_TIMEOUT_MS);

    socket.on('message', async (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (client) {
        if (msg?.type === 'ping') send({ type: 'pong' });
        return;
      }
      if (authenticating) return;
      if (msg?.type !== 'auth') {
        send({ type: 'auth', success: false, error: { code: 'UNAUTHORIZED', message: 'first message must be auth' } });
        socket.close(4001, 'unauthorized');
        return;
      }
      authenticating = true;
      try {
        const user = await auth.verifyAccess(typeof msg.accessToken === 'string' ? msg.accessToken : undefined);
        clearTimeout(timer);
        const sinceSeq = typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq) ? msg.sinceSeq : undefined;
        const c: HubClient = {
          sessionId: user.sessionId,
          send: (frame: WsFrame) => send(frame),
          close: (code, reason) => socket.close(code, reason),
          lastSentSeq: 0,
          ready: false,
        };
        client = c;
        send({ type: 'auth', success: true, latestSeq: hub.latestSeq });
        await hub.attach(c, sinceSeq);
      } catch {
        send({ type: 'auth', success: false, error: { code: 'UNAUTHORIZED', message: 'invalid or expired access token' } });
        socket.close(4001, 'unauthorized');
      } finally {
        authenticating = false;
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (client) hub.detach(client);
    });
    socket.on('error', () => undefined);
  });
}
