import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/endpoints';
import { ApiError, NetworkError } from '../../api/errors';
import type { BidAccepted, LotDetail, User } from '../../api/types';
import { ToastProvider } from '../../components/toast';
import { BIDDER, SELLER, makeBid, makeLot } from '../../test/fixtures';
import { BidPanel, checkBid } from './BidPanel';

const session: { user: User | null } = { user: BIDDER };
vi.mock('../auth/session', () => ({
  useSession: () => ({ user: session.user, status: 'authenticated', viewerKey: 'u' }),
}));

const balance: { available: number | undefined } = { available: 1_000_000 };
vi.mock('../wallet/use-balance', () => ({
  useBalance: () => ({
    data: balance.available === undefined ? undefined : { available: balance.available },
  }),
}));

const accepted: BidAccepted = {
  replayed: false,
  bid: { seq: 1, amount: 10_000, placedAt: '2026-10-23T12:00:00.000Z' },
  endsAt: '2026-10-23T13:00:00.000Z',
  extended: false,
  bidCount: 1,
};

function renderPanel(lot: LotDetail, phase: 'live' | 'scheduled' | 'ended' = 'live') {
  const onAccepted = vi.fn();
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <BidPanel lot={lot} phase={phase} onAccepted={onAccepted} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onAccepted };
}

const bidderLot = (overrides: Partial<LotDetail> = {}) =>
  makeLot({ viewer: { isSeller: false, isLeading: false }, ...overrides });

describe('checkBid', () => {
  const lot = { minimumNextBid: 10_000 };

  it('valor valido no minimo e acima', () => {
    expect(checkBid('100,00', lot, 1_000_000)).toEqual({
      amount: 10_000,
      error: undefined,
      insufficient: false,
    });
    expect(checkBid('1.234,56', lot, undefined).amount).toBe(123_456);
  });

  it('formato invalido', () => {
    for (const text of ['', 'abc', '1,2,3', '0', '-10']) {
      const result = checkBid(text, lot, 1_000_000);
      expect(result.amount).toBeNull();
      expect(result.error).toMatch(/valor válido/);
    }
  });

  it('abaixo do minimo por 1 centavo', () => {
    const result = checkBid('99,99', lot, 1_000_000);
    expect(result.error).toMatch(/lance mínimo agora/);
    expect(result.insufficient).toBe(false);
  });

  it('saldo insuficiente (e so marca insuficiente quando o valor em si e valido)', () => {
    const result = checkBid('100,00', lot, 5_000);
    expect(result.insufficient).toBe(true);
    expect(result.error).toMatch(/Saldo insuficiente/);
    expect(checkBid('50,00', lot, 5_000).insufficient).toBe(false);
  });

  it('saldo EXATAMENTE igual ao lance e suficiente; 1 centavo a menos nao', () => {
    expect(checkBid('100,00', lot, 10_000)).toEqual({
      amount: 10_000,
      error: undefined,
      insufficient: false,
    });
    expect(checkBid('100,00', lot, 9_999).insufficient).toBe(true);
  });

  it('acima do maximo da carteira', () => {
    expect(checkBid('10.000.000,01', lot, undefined).error).toMatch(/acima do máximo/);
  });

  it('saldo desconhecido (ainda carregando) nao bloqueia', () => {
    expect(checkBid('100,00', lot, undefined).error).toBeUndefined();
  });
});

describe('BidPanel', () => {
  beforeEach(() => {
    session.user = BIDDER;
    balance.available = 1_000_000;
    vi.restoreAllMocks();
  });

  it('visitante: convida a entrar ou criar conta, sem formulario', () => {
    session.user = null;
    renderPanel(makeLot());
    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
      'href',
      expect.stringContaining('/entrar?next='),
    );
    expect(screen.getByRole('link', { name: 'Criar conta' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu lance')).not.toBeInTheDocument();
  });

  it('leiloeiro nao ve formulario de lance', () => {
    session.user = SELLER;
    renderPanel(makeLot({ viewer: { isSeller: true, isLeading: false } }));
    expect(screen.getByText('Este é o seu lote')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu lance')).not.toBeInTheDocument();
  });

  it('leiloeiro em lote de OUTRO leiloeiro tambem nao da lance', () => {
    session.user = SELLER;
    renderPanel(makeLot({ viewer: { isSeller: false, isLeading: false } }));
    expect(screen.getByText(/Contas de leiloeiro não dão lances/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu lance')).not.toBeInTheDocument();
  });

  it('licitante: campo ja vem com o lance minimo e envia com Idempotency-Key', async () => {
    const placeBid = vi.spyOn(api, 'placeBid').mockResolvedValue(accepted);
    const { onAccepted } = renderPanel(bidderLot());
    const input = screen.getByLabelText('Seu lance');
    expect(input).toHaveValue('100,00');

    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(accepted));
    expect(placeBid).toHaveBeenCalledTimes(1);
    const [lotId, amount, key] = placeBid.mock.calls[0] ?? [];
    expect(lotId).toBe('11111111-1111-4111-8111-111111111111');
    expect(amount).toBe(10_000);
    expect(typeof key).toBe('string');
    expect((key as string).length).toBeGreaterThan(10);
    expect(await screen.findByText(/Lance de .* registrado/)).toBeInTheDocument();
  });

  it('abaixo do minimo: mostra a mensagem e NAO chama a API', async () => {
    const placeBid = vi.spyOn(api, 'placeBid').mockResolvedValue(accepted);
    renderPanel(bidderLot());
    const input = screen.getByLabelText('Seu lance');
    await userEvent.clear(input);
    await userEvent.type(input, '50,00');
    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/lance mínimo agora/);
    expect(placeBid).not.toHaveBeenCalled();
  });

  it('saldo insuficiente: botao desabilitado e link para a carteira', async () => {
    balance.available = 5_000;
    const placeBid = vi.spyOn(api, 'placeBid').mockResolvedValue(accepted);
    renderPanel(bidderLot());
    expect(screen.getByRole('button', { name: 'Dar lance' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Adicionar saldo' })).toHaveAttribute(
      'href',
      '/carteira',
    );
    expect(placeBid).not.toHaveBeenCalled();
  });

  it('valor fora do normal pede SEGUNDA confirmacao antes de enviar', async () => {
    const placeBid = vi.spyOn(api, 'placeBid').mockResolvedValue(accepted);
    renderPanel(bidderLot());
    const input = screen.getByLabelText('Seu lance');
    await userEvent.clear(input);
    await userEvent.type(input, '5.000,00'); // 50x o minimo: provavel zero a mais
    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    expect(placeBid).not.toHaveBeenCalled();
    expect(screen.getByText(/bem acima do mínimo/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Confirmar lance de/ }));
    await waitFor(() => expect(placeBid).toHaveBeenCalledTimes(1));
    expect(placeBid.mock.calls[0]?.[1]).toBe(500_000);
  });

  it('editar o valor desfaz a confirmacao pendente', async () => {
    renderPanel(bidderLot());
    const input = screen.getByLabelText('Seu lance');
    await userEvent.clear(input);
    await userEvent.type(input, '5.000,00');
    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    expect(screen.getByRole('button', { name: /Confirmar lance de/ })).toBeInTheDocument();
    await userEvent.type(input, '0');
    expect(screen.queryByRole('button', { name: /Confirmar lance de/ })).not.toBeInTheDocument();
  });

  it('duplo clique envia UM lance so', async () => {
    let resolve: (value: BidAccepted) => void = () => undefined;
    const placeBid = vi.spyOn(api, 'placeBid').mockImplementation(
      () =>
        new Promise<BidAccepted>((res) => {
          resolve = res;
        }),
    );
    renderPanel(bidderLot());
    const button = screen.getByRole('button', { name: 'Dar lance' });
    await userEvent.dblClick(button);
    expect(placeBid).toHaveBeenCalledTimes(1);
    resolve(accepted);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });

  it('falha de rede: reenvio reaproveita a MESMA Idempotency-Key (nao duplica)', async () => {
    const placeBid = vi
      .spyOn(api, 'placeBid')
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValueOnce(accepted);
    renderPanel(bidderLot());
    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    expect(await screen.findByText(/enviar de novo não o duplica/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    await waitFor(() => expect(placeBid).toHaveBeenCalledTimes(2));
    expect(placeBid.mock.calls[1]?.[2]).toBe(placeBid.mock.calls[0]?.[2]);
  });

  it('rejeicao definitiva do servidor: mostra o motivo e usa chave NOVA no proximo envio', async () => {
    const placeBid = vi
      .spyOn(api, 'placeBid')
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          code: 'BELOW_MINIMUM',
          message: 'Lance abaixo do mínimo.',
          details: { minimumRequired: 11_000 },
        }),
      )
      .mockResolvedValueOnce(accepted);
    renderPanel(bidderLot());
    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    await waitFor(() => expect(placeBid).toHaveBeenCalledTimes(2));
    expect(placeBid.mock.calls[1]?.[2]).not.toBe(placeBid.mock.calls[0]?.[2]);
  });

  it('lance estendido pelo anti-sniping avisa em um segundo aviso', async () => {
    vi.spyOn(api, 'placeBid').mockResolvedValue({ ...accepted, extended: true });
    renderPanel(bidderLot());
    await userEvent.click(screen.getByRole('button', { name: 'Dar lance' }));
    expect(await screen.findByText(/prazo foi estendido em 2 minutos/)).toBeInTheDocument();
  });

  it('liderando: mostra aviso de lideranca no lugar do formulario', () => {
    renderPanel(
      bidderLot({
        viewer: { isSeller: false, isLeading: true },
        currentAmount: 10_000,
        bidCount: 1,
        bids: [makeBid({ mine: true })],
      }),
    );
    expect(screen.getByText('Você está liderando')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu lance')).not.toBeInTheDocument();
  });

  it('superado: avisa e mantem o formulario', () => {
    renderPanel(
      bidderLot({
        currentAmount: 12_000,
        minimumNextBid: 13_000,
        bidCount: 2,
        bids: [makeBid({ seq: 2, mine: false }), makeBid({ seq: 1, mine: true })],
      }),
    );
    expect(screen.getByText('Você foi superado')).toBeInTheDocument();
    expect(screen.getByLabelText('Seu lance')).toHaveValue('130,00');
  });

  it('superado ha mais de 50 lances (lance fora da janela): o servidor garante o aviso e a posicao', () => {
    renderPanel(
      bidderLot({
        currentAmount: 90_000,
        minimumNextBid: 91_000,
        bidCount: 80,
        bids: [makeBid({ seq: 80, mine: false, bidder: 'Licitante A1' })], // nenhum lance meu na janela
        viewerDetail: { ref: 'Licitante Z9', hasBid: true, position: 3 },
      }),
    );
    expect(screen.getByText('Você foi superado')).toBeInTheDocument();
    expect(screen.getByText(/Sua posição agora: 3º/)).toBeInTheDocument();
  });

  it('quem nunca deu lance nao ve "superado" nem posicao', () => {
    renderPanel(
      bidderLot({
        currentAmount: 12_000,
        bidCount: 2,
        bids: [makeBid({ seq: 2, mine: false })],
        viewerDetail: { ref: 'Licitante Z9', hasBid: false, position: null },
      }),
    );
    expect(screen.queryByText('Você foi superado')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sua posição/)).not.toBeInTheDocument();
  });

  it('leiloeiro dono: lote SEM lances mostra Cancelar; COM lances explica que nao da', () => {
    session.user = SELLER;
    const own = { isSeller: true, isLeading: false };
    renderPanel(makeLot({ viewer: own, bidCount: 0 }));
    expect(screen.getByRole('button', { name: 'Cancelar lote' })).toBeInTheDocument();
    cleanup();

    renderPanel(makeLot({ viewer: own, bidCount: 2, currentAmount: 12_000 }));
    expect(screen.queryByRole('button', { name: 'Cancelar lote' })).not.toBeInTheDocument();
    expect(screen.getByText(/já recebeu lances e não pode ser cancelado/)).toBeInTheDocument();
  });

  it('lote agendado e lote em fechamento nao mostram formulario', () => {
    renderPanel(bidderLot(), 'scheduled');
    expect(screen.getByText('Este leilão ainda não começou')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu lance')).not.toBeInTheDocument();
  });

  it('fase "ended": aguarda o resultado, sem formulario', () => {
    renderPanel(bidderLot(), 'ended');
    expect(screen.getByText('Encerrando')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seu lance')).not.toBeInTheDocument();
  });
});
