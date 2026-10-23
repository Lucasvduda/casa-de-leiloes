import { describe, expect, it } from 'vitest';
import { ANTI_SNIPING_EXTENSION_MS, ANTI_SNIPING_WINDOW_MS, evaluateBid } from './bid-policy.js';
import type { BidInput } from './bid-policy.js';
import { lotPhase } from './lot.js';
import type { LotState } from './lot.js';
import { cents } from './money.js';

const START = new Date('2026-11-01T12:00:00.000Z');
const END = new Date('2026-11-01T13:00:00.000Z');
const LIVE_NOW = new Date('2026-11-01T12:30:00.000Z');

function lot(overrides: Partial<LotState> = {}): LotState {
  return {
    id: 'lot-1',
    sellerId: 'seller-1',
    startingBid: cents(10_000),
    minIncrement: cents(500),
    startsAt: START,
    endsAt: END,
    status: 'open',
    ...overrides,
  };
}

function input(overrides: Partial<BidInput> = {}): BidInput {
  return {
    lot: lot(),
    now: LIVE_NOW,
    bidderId: 'bidder-1',
    amount: cents(10_000),
    leading: null,
    availableBalance: cents(1_000_000),
    ...overrides,
  };
}

describe('lotPhase', () => {
  it('agendado antes do inicio', () => {
    expect(lotPhase(lot(), new Date(START.getTime() - 1))).toBe('scheduled');
  });
  it('ao vivo exatamente no inicio (intervalo fechado a esquerda)', () => {
    expect(lotPhase(lot(), START)).toBe('live');
  });
  it('ao vivo 1ms antes do fim', () => {
    expect(lotPhase(lot(), new Date(END.getTime() - 1))).toBe('live');
  });
  it('encerrado exatamente no fim (intervalo aberto a direita)', () => {
    expect(lotPhase(lot(), END)).toBe('ended');
  });
  it('status persistido vence o relogio', () => {
    expect(lotPhase(lot({ status: 'closed' }), LIVE_NOW)).toBe('closed');
    expect(lotPhase(lot({ status: 'cancelled' }), LIVE_NOW)).toBe('cancelled');
  });
});

describe('evaluateBid: janela do lote', () => {
  it('recusa antes do inicio', () => {
    const d = evaluateBid(input({ now: new Date(START.getTime() - 1) }));
    expect(d).toMatchObject({ accepted: false, reason: 'LOT_NOT_STARTED' });
  });

  it('aceita exatamente no inicio', () => {
    expect(evaluateBid(input({ now: START })).accepted).toBe(true);
  });

  it('recusa exatamente no fim', () => {
    expect(evaluateBid(input({ now: END }))).toMatchObject({
      accepted: false,
      reason: 'LOT_ENDED',
    });
  });

  it('recusa depois do fim', () => {
    const d = evaluateBid(input({ now: new Date(END.getTime() + 60_000) }));
    expect(d).toMatchObject({ accepted: false, reason: 'LOT_ENDED' });
  });

  it('recusa em lote ja liquidado (closed)', () => {
    const d = evaluateBid(input({ lot: lot({ status: 'closed' }) }));
    expect(d).toMatchObject({ accepted: false, reason: 'LOT_ENDED' });
  });

  it('recusa em lote cancelado', () => {
    const d = evaluateBid(input({ lot: lot({ status: 'cancelled' }) }));
    expect(d).toMatchObject({ accepted: false, reason: 'LOT_CANCELLED' });
  });
});

describe('evaluateBid: valor do lance', () => {
  it('primeiro lance igual ao inicial e aceito (>=)', () => {
    expect(evaluateBid(input({ amount: cents(10_000) })).accepted).toBe(true);
  });

  it('primeiro lance abaixo do inicial e recusado e informa o minimo', () => {
    const d = evaluateBid(input({ amount: cents(9_999) }));
    expect(d).toEqual({ accepted: false, reason: 'BELOW_MINIMUM', minimumRequired: 10_000 });
  });

  it('primeiro lance NAO precisa respeitar o incremento sobre o inicial', () => {
    expect(evaluateBid(input({ amount: cents(10_000) })).accepted).toBe(true);
  });

  const withLeader = { bidderId: 'other', amount: cents(12_000) };

  it('lance seguinte igual a atual + incremento e aceito (>=)', () => {
    const d = evaluateBid(input({ leading: withLeader, amount: cents(12_500) }));
    expect(d.accepted).toBe(true);
  });

  it('lance seguinte 1 centavo abaixo de atual + incremento e recusado', () => {
    const d = evaluateBid(input({ leading: withLeader, amount: cents(12_499) }));
    expect(d).toEqual({ accepted: false, reason: 'BELOW_MINIMUM', minimumRequired: 12_500 });
  });

  it('lance igual ao atual e recusado (incremento minimo e obrigatorio)', () => {
    const d = evaluateBid(input({ leading: withLeader, amount: cents(12_000) }));
    expect(d).toMatchObject({ accepted: false, reason: 'BELOW_MINIMUM' });
  });

  it('lance bem acima do minimo e aceito', () => {
    expect(evaluateBid(input({ leading: withLeader, amount: cents(999_999) })).accepted).toBe(true);
  });
});

describe('evaluateBid: quem pode dar lance', () => {
  it('o lider nao pode cobrir o proprio lance', () => {
    const d = evaluateBid(
      input({ leading: { bidderId: 'bidder-1', amount: cents(12_000) }, amount: cents(20_000) }),
    );
    expect(d).toMatchObject({ accepted: false, reason: 'ALREADY_LEADING' });
  });

  it('leiloeiro nao pode dar lance no proprio lote', () => {
    const d = evaluateBid(input({ bidderId: 'seller-1' }));
    expect(d).toMatchObject({ accepted: false, reason: 'SELLER_CANNOT_BID' });
  });

  it('quem foi superado pode dar lance de novo', () => {
    const d = evaluateBid(
      input({ leading: { bidderId: 'other', amount: cents(12_000) }, amount: cents(13_000) }),
    );
    expect(d.accepted).toBe(true);
  });
});

describe('evaluateBid: saldo', () => {
  it('recusa se o lance nao cabe no disponivel', () => {
    const d = evaluateBid(input({ amount: cents(10_000), availableBalance: cents(9_999) }));
    expect(d).toEqual({ accepted: false, reason: 'INSUFFICIENT_FUNDS', available: 9_999 });
  });

  it('aceita se o lance e exatamente o disponivel', () => {
    expect(
      evaluateBid(input({ amount: cents(10_000), availableBalance: cents(10_000) })).accepted,
    ).toBe(true);
  });
});

describe('evaluateBid: ordem dos motivos (qual mensagem o usuario ve)', () => {
  it('lote encerrado vence valor baixo e saldo baixo', () => {
    const d = evaluateBid(input({ now: END, amount: cents(1), availableBalance: cents(0) }));
    expect(d).toMatchObject({ reason: 'LOT_ENDED' });
  });

  it('ja esta ganhando vence valor baixo', () => {
    const d = evaluateBid(
      input({ leading: { bidderId: 'bidder-1', amount: cents(12_000) }, amount: cents(1) }),
    );
    expect(d).toMatchObject({ reason: 'ALREADY_LEADING' });
  });

  it('valor baixo vence saldo insuficiente', () => {
    const d = evaluateBid(input({ amount: cents(1), availableBalance: cents(0) }));
    expect(d).toMatchObject({ reason: 'BELOW_MINIMUM' });
  });
});

describe('anti-sniping (+2 min nos ultimos 2 min, novo fim = instante do lance + 2 min)', () => {
  it('constantes batem com o enunciado', () => {
    expect(ANTI_SNIPING_WINDOW_MS).toBe(120_000);
    expect(ANTI_SNIPING_EXTENSION_MS).toBe(120_000);
  });

  it('lance fora dos ultimos 2 min nao prorroga', () => {
    const now = new Date(END.getTime() - 120_001);
    expect(evaluateBid(input({ now }))).toEqual({
      accepted: true,
      newEndsAt: END,
      extended: false,
    });
  });

  it('lance faltando exatamente 2 min nao altera o fim (instante + 2 min == fim)', () => {
    const now = new Date(END.getTime() - 120_000);
    expect(evaluateBid(input({ now }))).toEqual({
      accepted: true,
      newEndsAt: END,
      extended: false,
    });
  });

  it('lance faltando 119,999 s prorroga para instante + 2 min', () => {
    const now = new Date(END.getTime() - 119_999);
    const d = evaluateBid(input({ now }));
    expect(d).toEqual({
      accepted: true,
      newEndsAt: new Date(now.getTime() + 120_000),
      extended: true,
    });
  });

  it('lance faltando 1 ms prorroga para instante + 2 min', () => {
    const now = new Date(END.getTime() - 1);
    const d = evaluateBid(input({ now }));
    expect(d).toMatchObject({ accepted: true, extended: true });
    if (d.accepted) expect(d.newEndsAt.getTime()).toBe(now.getTime() + 120_000);
  });

  it('o fim nunca diminui', () => {
    const now = new Date(END.getTime() - 30_000);
    const d = evaluateBid(input({ now }));
    if (d.accepted) expect(d.newEndsAt.getTime()).toBeGreaterThanOrEqual(END.getTime());
  });

  it('lance recusado nunca prorroga', () => {
    const now = new Date(END.getTime() - 30_000);
    const d = evaluateBid(input({ now, amount: cents(1) }));
    expect(d.accepted).toBe(false);
  });
});
