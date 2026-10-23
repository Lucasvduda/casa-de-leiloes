import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/** So aceitamos um id vindo de fora se for curto e seguro (evita injecao em log/cabecalho). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}
