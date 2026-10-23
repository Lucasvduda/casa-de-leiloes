import type { QueryClient } from '@tanstack/react-query';
import type { LotListParams } from '../api/types';

/**
 * Toda chave de cache que depende de QUEM esta vendo leva o `viewerKey` (id ou "anon"):
 * dado de uma conta nunca aparece para outra, mesmo que o cache sobreviva a uma troca de login.
 */
export const keys = {
  lots: (viewer: string, params: LotListParams) => ['lots', viewer, params] as const,
  lot: (viewer: string, id: string) => ['lot', viewer, id] as const,
  balance: (viewer: string) => ['balance', viewer] as const,
  wallet: (viewer: string) => ['wallet', viewer] as const,
  myBids: (viewer: string, params: LotListParams) => ['my-bids', viewer, params] as const,
  myWins: (viewer: string, params: LotListParams) => ['my-wins', viewer, params] as const,
  myLots: (viewer: string, params: LotListParams) => ['my-lots', viewer, params] as const,
  catalog: (q: string, page: number) => ['catalog', q, page] as const,
  audit: (id: string) => ['audit', id] as const,
  receipt: (code: string) => ['receipt', code] as const,
};

/** Depois de qualquer movimento de dinheiro (lance, deposito, cancelamento, encerramento). */
export function invalidateMoney(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['balance'] });
  void queryClient.invalidateQueries({ queryKey: ['wallet'] });
}

/** Listas que mostram preco/lideranca (vitrine e paineis) ficam desatualizadas apos um lance. */
export function invalidateLotLists(queryClient: QueryClient): void {
  for (const key of ['lots', 'my-bids', 'my-wins', 'my-lots']) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}
