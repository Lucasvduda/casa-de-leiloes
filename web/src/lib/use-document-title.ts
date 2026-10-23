import { useEffect } from 'react';

const SITE = 'Casa de Leilões';

/** Titulo da aba por pagina (leitor de tela anuncia a troca de pagina por ele). */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title =
      title === null || title === undefined || title === '' ? SITE : `${title} · ${SITE}`;
    return () => {
      document.title = SITE;
    };
  }, [title]);
}
