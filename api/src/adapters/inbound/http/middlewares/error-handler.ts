import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { HttpError } from '../http-error.js';

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorBody = {
    error: { code: 'NOT_FOUND', message: 'Rota nao encontrada.', requestId: req.id },
  };
  res.status(404).json(body);
}

/**
 * Ultima barreira. Erros conhecidos viram resposta com codigo estavel; qualquer outro vira 500
 * generico (a causa real vai so para o log, correlacionada pelo requestId).
 */
export function createErrorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof HttpError) {
      const body: ErrorBody = {
        error: {
          code: err.code,
          message: err.message,
          requestId: req.id,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      };
      res.status(err.status).json(body);
      return;
    }

    // body-parser: JSON malformado ou corpo grande demais.
    const status =
      typeof (err as { status?: unknown })?.status === 'number'
        ? (err as { status: number }).status
        : undefined;
    if (status === 400 || status === 413) {
      const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON';
      const message = status === 413 ? 'Corpo da requisicao grande demais.' : 'JSON invalido.';
      res.status(status).json({ error: { code, message, requestId: req.id } } satisfies ErrorBody);
      return;
    }

    logger.error({ err, requestId: req.id, path: req.path, method: req.method }, 'unhandled_error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno.', requestId: req.id },
    } satisfies ErrorBody);
  };
}
