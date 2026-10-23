import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { keys } from '../../app/query-keys';
import { CopyButton } from '../../components/CopyButton';
import { Alert, ButtonLink, Card, EmptyState, LoadError, Skeleton } from '../../components/ui';
import { formatDateTimeSeconds, shortHash } from '../../lib/format';
import { AUDIT_ISSUE_TEXT, messageForError } from '../../lib/messages';
import { formatBRL } from '../../lib/money';
import { useDocumentTitle } from '../../lib/use-document-title';
import { ItemImage } from '../lots/LotParts';

/** Auditoria PUBLICA: qualquer pessoa confere a cadeia de lances de um lote, sem login. */
export function AuditPage() {
  const { id = '' } = useParams();
  const query = useQuery({
    queryKey: keys.audit(id),
    queryFn: ({ signal }) => api.audit(id, signal),
  });
  const report = query.data;
  useDocumentTitle(report === undefined ? 'Auditoria' : `Auditoria: ${report.lot.title}`);

  if (query.isPending) {
    return (
      <div className="space-y-4" role="status" aria-label="Carregando auditoria">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (report === undefined) {
    if (isApiError(query.error) && query.error.status === 404) {
      return (
        <EmptyState
          title="Lote não encontrado"
          action={<ButtonLink to="/">Voltar à vitrine</ButtonLink>}
        >
          Confira o link da auditoria.
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

  const { lot, integrity } = report;

  return (
    <article className="space-y-6">
      <p className="text-sm">
        <Link to={`/lotes/${lot.id}`} className="underline">
          ← Voltar ao lote
        </Link>
      </p>

      <header className="flex flex-wrap items-center gap-4">
        <ItemImage src={lot.imageUrl} alt="" className="size-20 rounded-lg" />
        <div>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Auditoria do histórico de lances
          </p>
          <h1 className="font-serif text-2xl font-bold sm:text-3xl">{lot.title}</h1>
        </div>
      </header>

      {integrity.intact ? (
        <Alert tone="success" title="Histórico íntegro">
          Todos os {report.bidCount} lances estão encadeados e conferem com o resumo do lote, com o
          extrato das carteiras e com o comprovante.
        </Alert>
      ) : (
        <Alert tone="danger" title="Inconsistência encontrada">
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {integrity.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.seq ?? index}`}>
                {AUDIT_ISSUE_TEXT[issue.code] ?? 'Inconsistência não identificada.'}
                {issue.seq !== undefined && ` (lance #${issue.seq})`}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card as="section">
        <h2 className="font-semibold">Selo do histórico</h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Cada lance é selado junto com o anterior por uma chave que só o servidor conhece. Se
          alguém editar, apagar ou inserir um lance, a cadeia deixa de conferir. Anote o selo final:
          se ele mudar depois do encerramento, algo foi alterado.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code
            className="break-all rounded bg-stone-100 px-2 py-1 text-xs dark:bg-stone-800"
            data-testid="head-hash"
          >
            {report.headHash}
          </code>
          <CopyButton text={report.headHash} label="Copiar selo" />
        </div>
      </Card>

      {report.receipt !== null && (
        <Card as="section">
          <h2 className="font-semibold">Comprovante</h2>
          <p className="mt-1 text-sm">
            Arrematado por <strong className="tabular">{formatBRL(report.receipt.amount)}</strong> (
            {report.receipt.winner}) em {formatDateTimeSeconds(report.receipt.issuedAt)}. Assinatura{' '}
            <strong>{report.receipt.signatureValid ? 'válida' : 'INVÁLIDA'}</strong>.
          </p>
          <p className="mt-2 text-sm">
            <Link to={`/comprovantes/${report.receipt.code}`} className="font-semibold underline">
              Abrir comprovante
            </Link>
          </p>
        </Card>
      )}

      <Card as="section">
        <h2 className="mb-3 font-semibold">Lances ({report.bidCount})</h2>
        {report.bids.length === 0 ? (
          <p className="text-sm text-stone-600 dark:text-stone-400">Nenhum lance neste lote.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">
                Histórico completo de lances com os selos de cada um
              </caption>
              <thead className="text-xs uppercase text-stone-500 dark:text-stone-400">
                <tr>
                  <th scope="col" className="py-2 pr-3">
                    #
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Licitante
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right">
                    Valor
                  </th>
                  <th scope="col" className="py-2 pr-3">
                    Data e hora
                  </th>
                  <th scope="col" className="py-2">
                    Selo
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
                {report.bids.map((bid) => (
                  <tr key={bid.seq}>
                    <td className="tabular py-2 pr-3">{bid.seq}</td>
                    <td className="py-2 pr-3">{bid.bidder}</td>
                    <td className="tabular py-2 pr-3 text-right font-semibold">
                      {formatBRL(bid.amount)}
                    </td>
                    <td className="tabular py-2 pr-3">{formatDateTimeSeconds(bid.placedAt)}</td>
                    <td className="py-2">
                      <code title={bid.hash} className="text-xs">
                        {shortHash(bid.hash)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </article>
  );
}
