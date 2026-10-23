import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from '../http-error.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Defesa em camadas contra CSRF em toda escrita (POST/PUT/PATCH/DELETE):
 *  1. `Sec-Fetch-Site: cross-site` e recusado (navegadores modernos declaram a origem da requisicao);
 *  2. se houver `Origin`, o host precisa ser o nosso (cobre navegadores sem Sec-Fetch);
 *  3. o corpo precisa ser `application/json`: formulario HTML de outro site nao consegue enviar isso
 *     sem passar por CORS, e nao habilitamos CORS;
 *  4. com sessao ativa, o cabecalho `X-CSRF-Token` precisa bater com o token da sessao
 *     (um site atacante nao le esse valor: a resposta do login so e legivel pela mesma origem).
 */
export function mutationGuard(): RequestHandler {
  return (req, _res, next) => {
    if (!MUTATING.has(req.method)) {
      next();
      return;
    }

    if (req.get('sec-fetch-site') === 'cross-site') {
      next(new HttpError(403, 'CROSS_SITE_REQUEST', 'Requisicao de outro site recusada.'));
      return;
    }

    const origin = req.get('origin');
    if (origin !== undefined) {
      let originHost: string | null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== req.get('host')) {
        next(new HttpError(403, 'CROSS_ORIGIN_REQUEST', 'Origem da requisicao nao permitida.'));
        return;
      }
    }

    const contentType = (req.get('content-type') ?? '').toLowerCase();
    if (!/^application\/json(\s*;|$)/.test(contentType)) {
      next(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o corpo como application/json.'));
      return;
    }

    if (req.auth !== undefined) {
      const sent = req.get('x-csrf-token');
      if (sent === undefined || !constantTimeEqual(sent, req.auth.csrfToken)) {
        next(new HttpError(403, 'CSRF_INVALID', 'Token CSRF ausente ou invalido.'));
        return;
      }
    }
    next();
  };
}
