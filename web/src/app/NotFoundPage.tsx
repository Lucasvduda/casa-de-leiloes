import { ButtonLink, EmptyState } from '../components/ui';
import { useDocumentTitle } from '../lib/use-document-title';

export function NotFoundPage() {
  useDocumentTitle('Página não encontrada');
  return (
    <EmptyState
      title="Página não encontrada"
      action={<ButtonLink to="/">Ir para a vitrine</ButtonLink>}
    >
      O endereço digitado não existe.
    </EmptyState>
  );
}
