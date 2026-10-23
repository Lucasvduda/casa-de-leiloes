import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import express from 'express';
import type { RequestHandler, Response } from 'express';

/** Prefixos que pertencem ao servidor: nunca devolvem o HTML do front. */
const SERVER_PREFIXES = ['/api', '/health', '/ready'];
const ONE_YEAR_S = 31_536_000;

const isServerPath = (path: string): boolean =>
  SERVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

function noStore(res: Response): void {
  // O HTML aponta para arquivos com hash no nome: precisa ser revalidado a cada deploy.
  res.setHeader('Cache-Control', 'no-cache');
}

/**
 * Serve o build do front (Vite) na mesma origem da API: sem CORS, cookie httpOnly simples, um link so.
 *
 * - `/assets/*` (nome com hash) e imutavel: cache de 1 ano.
 * - `index.html` nunca fica em cache.
 * - Rota do React (ex.: `/lotes/123`) recebe o `index.html` (fallback de SPA), mas SO se o navegador
 *   pediu HTML e o caminho nao parece arquivo. Arquivo inexistente continua 404 (nao devolve HTML
 *   no lugar de um .js quebrado) e `/api/*` continua devolvendo o erro JSON padrao.
 * - So GET/HEAD; traversal (`..`) e dotfiles sao tratados pelo `express.static`.
 */
export function serveWebApp(distDir: string): RequestHandler[] {
  const root = resolve(distDir);
  const indexFile = join(root, 'index.html');
  if (!existsSync(indexFile)) {
    throw new Error(`WEB_DIST_DIR invalido: ${indexFile} nao existe (rode o build do front-end).`);
  }

  const files = express.static(root, {
    index: false,
    dotfiles: 'ignore',
    redirect: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      // Sempre relativo a raiz: o lugar onde o build mora no disco (ex.: /srv/assets/dist) nao conta.
      const relativePath = relative(root, filePath).split(sep).join('/');
      if (relativePath === 'index.html') noStore(res);
      else if (relativePath.startsWith('assets/')) {
        res.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_S}, immutable`);
      } else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  });

  const spaFallback: RequestHandler = (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isServerPath(req.path)) {
      next();
      return;
    }
    const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(req.path);
    if (looksLikeFile || !req.accepts('html')) {
      next();
      return;
    }
    noStore(res);
    // `root`: dotfiles so vale para o caminho DENTRO do build, nao para as pastas acima dele.
    res.sendFile('index.html', { root, dotfiles: 'deny' }, (error) => {
      if (error !== undefined && error !== null) next(error);
    });
  };

  const skipServerPaths: RequestHandler = (req, res, next) => {
    if (isServerPath(req.path)) next();
    else files(req, res, next);
  };

  return [skipServerPaths, spaFallback];
}
