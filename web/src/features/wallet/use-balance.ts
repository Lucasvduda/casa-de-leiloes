import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { keys } from '../../app/query-keys';
import { useSession } from '../auth/session';

/** Saldo (total, comprometido e disponivel) de quem esta logado. Sem login, a consulta nem sai. */
export function useBalance() {
  const { viewerKey, status } = useSession();
  return useQuery({
    queryKey: keys.balance(viewerKey),
    queryFn: ({ signal }) => api.wallet({}, signal),
    enabled: status === 'authenticated',
    staleTime: 10_000,
  });
}
