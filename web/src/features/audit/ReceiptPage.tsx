import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { keys } from '../../app/query-keys';
import { CopyButton } from '../../components/CopyButton';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  LoadError,
  Skeleton,
} from '../../components/ui';
import { formatDateTimeSeconds } from '../../lib/format';
import { messageForError } from '../../lib/messages';
import { formatBRL } from '../../lib/money';
import { useDocumentTitle } from '../../lib/use-document-title';
import { ItemImage } from '../lots/LotParts';

/** Comprovante PUBLICO: o codigo (128 bits) no link e o segredo. Nao revela quem e o vencedor. */
export function ReceiptPage() {
  const { code = '' } = useParams();
  const query = useQuery({
    queryKey: keys.receipt(code),
    queryFn: ({ signal }) => api.receipt(code, signal),
  });
  const receipt = query.data;
  useDocumentTitle('Comprovante');

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-xl space-y-4" role="status" aria-label="Carregando comprovante">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (receipt === undefined) {
    if (isApiError(query.error) && query.error.status === 404) {
      return (
        <EmptyState
          title="Comprovante não encontrado"
          action={<ButtonLink to="/">Voltar à vitrine</ButtonLink>}
        >
          Confira se o link foi copiado por inteiro.
        </EmptyState>
      );
    }
    return (
      <LoadError
        message={messageForError(query.error)}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  return (
    <article className="mx-auto max-w-xl">
      <Card className="space-y-5 p-6">
        <header className="text-center">
          <p className="text-sm uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Comprovante de arremate
          </p>
          <h1 className="mt-1 font-serif text-2xl font-bold">{receipt.lot.title}</h1>
        </header>

        <ItemImage
          src={receipt.lot.imageUrl}
          alt={receipt.lot.title}
          className="mx-auto aspect-[4/3] w-full max-w-sm rounded-lg object-contain"
        />

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-stone-500 dark:text-stone-400">Valor</dt>
          <dd className="tabular text-lg font-bold">{formatBRL(receipt.amount)}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Comprador</dt>
          <dd>{receipt.winner}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Leiloeiro</dt>
          <dd>{receipt.sellerName}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Lances</dt>
          <dd className="tabular">{receipt.bidCount}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Emitido em</dt>
          <dd>{formatDateTimeSeconds(receipt.issuedAt)}</dd>
          <dt className="text-stone-500 dark:text-stone-400">Código</dt>
          <dd className="break-all font-mono text-xs">{receipt.code}</dd>
        </dl>

        {receipt.signatureValid ? (
          <Alert tone="success" title="Assinatura válida">
            O servidor confirmou que este comprovante não foi alterado.
          </Alert>
        ) : (
          <Alert tone="danger" title="Assinatura inválida">
            Este comprovante não confere com a assinatura do servidor. Não confie nele.
          </Alert>
        )}

        <div className="no-print flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={() => window.print()}>
            Imprimir
          </Button>
          <CopyButton text={window.location.href} label="Copiar link" />
          <Link
            to={`/auditoria/${receipt.lot.id}`}
            className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium underline"
          >
            Auditar histórico do lote
          </Link>
        </div>
      </Card>
    </article>
  );
}
