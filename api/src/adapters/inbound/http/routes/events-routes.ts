import { Router } from 'express';
import type { RateLimiters } from '../middlewares/rate-limits.js';
import type { LotEventHub, SseSink } from '../sse/lot-event-hub.js';

/** Tempo real da sala. Publica: quem so assiste nao precisa de conta (como na vitrine). */
export function eventsRoutes(deps: { hub: LotEventHub; limiters: RateLimiters }): Router {
  const { hub, limiters } = deps;
  const router = Router();

  router.get('/lots/:id/events', limiters.events, async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const sink: SseSink = {
      open() {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        // `no-transform` impede proxy de bufferizar/comprimir; X-Accel-Buffering faz o mesmo no nginx.
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        req.socket.setNoDelay(true);
        req.socket.setTimeout(0);
        res.flushHeaders();
      },
      write: (chunk) => res.write(chunk),
      get writableLength() {
        return res.writableLength;
      },
      end: () => res.end(),
      destroy: () => res.destroy(),
    };

    const result = await hub.connect({
      lotId: String(req.params.id),
      viewer: req.auth?.actor ?? null,
      ip: req.ip ?? 'desconhecido',
      sink,
      signal: abort.signal,
    });
    // 204: o EventSource entende como "pare de reconectar". O cliente le o resultado em GET /lots/:id.
    if (result.status === 'finished' && !res.headersSent) res.status(204).end();
  });

  return router;
}
