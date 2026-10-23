import { describe, expect, it } from 'vitest';
import { iso, makeBid, makeLot, NOW } from '../../test/fixtures';
import {
  MAX_BIDS_IN_ROOM,
  applyBid,
  bidAcceptedToEvent,
  bidSuggestions,
  hasGap,
  isUnusualBid,
  mergeLot,
  parseBidEvent,
  parseServerNow,
  parseSnapshot,
  phaseAt,
  viewerStatus,
} from './room-state';

const MIN = 60_000;

describe('phaseAt (relogio do servidor decide a fase)', () => {
  const lot = { status: 'open' as const, startsAt: iso(-MIN), endsAt: iso(MIN) };

  it('antes do inicio: agendado; dentro: ao vivo; depois do fim: aguardando encerramento', () => {
    expect(phaseAt(lot, NOW - 2 * MIN)).toBe('scheduled');
    expect(phaseAt(lot, NOW)).toBe('live');
    expect(phaseAt(lot, NOW + 2 * MIN)).toBe('ended');
  });

  it('intervalo semiaberto: no instante exato do inicio ja e ao vivo; no do fim ja nao e', () => {
    expect(phaseAt(lot, Date.parse(lot.startsAt))).toBe('live');
    expect(phaseAt(lot, Date.parse(lot.startsAt) - 1)).toBe('scheduled');
    expect(phaseAt(lot, Date.parse(lot.endsAt) - 1)).toBe('live');
    expect(phaseAt(lot, Date.parse(lot.endsAt))).toBe('ended');
  });

  it('status salvo manda: encerrado e cancelado ignoram a hora', () => {
    expect(phaseAt({ ...lot, status: 'closed' }, NOW)).toBe('closed');
    expect(phaseAt({ ...lot, status: 'cancelled' }, NOW)).toBe('cancelled');
    expect(phaseAt({ ...lot, status: 'cancelled' }, NOW - 99 * MIN)).toBe('cancelled');
  });
});

describe('viewerStatus', () => {
  it('visitante, leiloeiro, lider, superado e quem ainda nao deu lance', () => {
    expect(viewerStatus(makeLot({ viewer: null }))).toBe('anonymous');
    expect(viewerStatus(makeLot({ viewer: { isSeller: true, isLeading: false } }))).toBe('seller');
    expect(viewerStatus(makeLot({ viewer: { isSeller: false, isLeading: true } }))).toBe('leading');
    expect(viewerStatus(makeLot({ viewer: { isSeller: false, isLeading: false } }))).toBe('none');
    expect(
      viewerStatus(
        makeLot({
          viewer: { isSeller: false, isLeading: false },
          bids: [
            { seq: 2, bidder: 'B', mine: false, amount: 12_000, placedAt: iso(0) },
            { seq: 1, bidder: 'A', mine: true, amount: 11_000, placedAt: iso(-1) },
          ],
        }),
      ),
    ).toBe('outbid');
  });
});

describe('applyBid', () => {
  const viewer = { isSeller: false, isLeading: false };

  it('atualiza valor, contagem, fim, minimo e historico (mais novo primeiro)', () => {
    const lot = makeLot({ viewer });
    const next = applyBid(
      lot,
      makeBid({ seq: 1, amount: 10_000, bidCount: 1, endsAt: iso(5 * MIN) }),
    );
    expect(next.currentAmount).toBe(10_000);
    expect(next.bidCount).toBe(1);
    expect(next.endsAt).toBe(iso(5 * MIN));
    expect(next.minimumNextBid).toBe(11_000);
    expect(next.bids.map((b) => b.seq)).toEqual([1]);

    const second = applyBid(
      next,
      makeBid({
        seq: 2,
        amount: 12_000,
        bidCount: 2,
        bidder: 'Licitante B2',
        minimumNextBid: 13_000,
      }),
    );
    expect(second.bids.map((b) => b.seq)).toEqual([2, 1]);
    expect(second.minimumNextBid).toBe(13_000);
  });

  it('e idempotente: evento repetido ou atrasado nao muda nada', () => {
    const lot = applyBid(makeLot({ viewer }), makeBid({ seq: 1, bidCount: 1 }));
    expect(applyBid(lot, makeBid({ seq: 1, bidCount: 1 }))).toBe(lot);
    const second = applyBid(lot, makeBid({ seq: 2, amount: 12_000, bidCount: 2 }));
    expect(applyBid(second, makeBid({ seq: 1, bidCount: 1 }))).toBe(second);
  });

  it('sem minimumNextBid no evento, calcula atual + incremento', () => {
    const next = applyBid(makeLot(), makeBid({ amount: 25_000, minimumNextBid: null }));
    expect(next.minimumNextBid).toBe(26_000);
  });

  it('lance meu: passo a liderar; lance de outro: deixo de liderar', () => {
    const mine = applyBid(makeLot({ viewer }), makeBid({ mine: true }));
    expect(mine.viewer?.isLeading).toBe(true);
    const other = applyBid(
      applyBid(makeLot({ viewer }), makeBid({ seq: 1, bidCount: 1, mine: true })),
      makeBid({ seq: 2, bidCount: 2, mine: false, amount: 12_000 }),
    );
    expect(other.viewer?.isLeading).toBe(false);
    expect(viewerStatus(other)).toBe('outbid');
  });

  it('visitante sem login continua sem "viewer"', () => {
    expect(applyBid(makeLot({ viewer: null }), makeBid()).viewer).toBeNull();
  });

  it('nao muta o estado anterior', () => {
    const lot = makeLot({ viewer });
    const snapshot = JSON.stringify(lot);
    applyBid(lot, makeBid());
    expect(JSON.stringify(lot)).toBe(snapshot);
  });

  it(`guarda no maximo ${MAX_BIDS_IN_ROOM} lances na sala`, () => {
    let lot = makeLot();
    for (let seq = 1; seq <= MAX_BIDS_IN_ROOM + 10; seq += 1) {
      lot = applyBid(lot, makeBid({ seq, bidCount: seq, amount: 10_000 + seq * 1000 }));
    }
    expect(lot.bids).toHaveLength(MAX_BIDS_IN_ROOM);
    expect(lot.bids[0]?.seq).toBe(MAX_BIDS_IN_ROOM + 10);
    expect(lot.bidCount).toBe(MAX_BIDS_IN_ROOM + 10);
  });

  it('prazo estendido (anti-sniping) chega pelo novo endsAt', () => {
    const next = applyBid(makeLot(), makeBid({ endsAt: iso(2 * MIN), extended: true }));
    expect(next.endsAt).toBe(iso(2 * MIN));
  });
});

describe('hasGap', () => {
  it('detecta evento perdido (seq pulou) e nao acusa o proximo esperado nem repeticao', () => {
    const lot = makeLot({ bidCount: 3 });
    expect(hasGap(lot, makeBid({ seq: 4 }))).toBe(false);
    expect(hasGap(lot, makeBid({ seq: 5 }))).toBe(true);
    expect(hasGap(lot, makeBid({ seq: 2 }))).toBe(false);
  });
});

describe('bidAcceptedToEvent', () => {
  it('traduz a resposta do POST para o formato do evento, marcando como meu', () => {
    const lot = makeLot({
      viewerDetail: { ref: 'Licitante Z9' },
      viewer: { isSeller: false, isLeading: false },
    });
    const event = bidAcceptedToEvent(lot, {
      replayed: false,
      bid: { seq: 3, amount: 15_000, placedAt: iso(-500) },
      endsAt: iso(2 * MIN),
      extended: true,
      bidCount: 3,
    });
    expect(event).toMatchObject({
      seq: 3,
      amount: 15_000,
      mine: true,
      bidder: 'Licitante Z9',
      bidCount: 3,
    });
    const next = applyBid({ ...lot, bidCount: 2 }, event);
    expect(next.viewer?.isLeading).toBe(true);
    expect(next.minimumNextBid).toBe(16_000);
  });

  it('o mesmo lance chegando pelo SSE depois do POST nao duplica', () => {
    const lot = makeLot({
      viewerDetail: { ref: 'Licitante Z9' },
      viewer: { isSeller: false, isLeading: false },
    });
    const afterPost = applyBid(
      lot,
      bidAcceptedToEvent(lot, {
        replayed: false,
        bid: { seq: 1, amount: 10_000, placedAt: iso(0) },
        endsAt: lot.endsAt,
        extended: false,
        bidCount: 1,
      }),
    );
    const afterSse = applyBid(afterPost, makeBid({ seq: 1, bidCount: 1, mine: true }));
    expect(afterSse).toBe(afterPost);
    expect(afterSse.bids).toHaveLength(1);
  });
});

describe('mergeLot (resposta atrasada nao desfaz o tempo real)', () => {
  it('sem estado anterior, usa o que chegou', () => {
    const incoming = makeLot({ bidCount: 2 });
    expect(mergeLot(undefined, incoming)).toBe(incoming);
  });

  it('estado mais novo vence resposta velha (menos lances)', () => {
    const current = makeLot({ bidCount: 5 });
    expect(mergeLot(current, makeLot({ bidCount: 4 }))).toBe(current);
  });

  it('resposta igual ou mais nova substitui', () => {
    const current = makeLot({ bidCount: 5 });
    const same = makeLot({ bidCount: 5, title: 'novo' });
    expect(mergeLot(current, same)).toBe(same);
    const newer = makeLot({ bidCount: 6 });
    expect(mergeLot(current, newer)).toBe(newer);
  });

  it('lote ja encerrado/cancelado nao "reabre" com resposta atrasada', () => {
    const closed = makeLot({ bidCount: 3, status: 'closed' });
    expect(mergeLot(closed, makeLot({ bidCount: 3, status: 'open' }))).toBe(closed);
    const cancelled = makeLot({ bidCount: 0, status: 'cancelled' });
    expect(mergeLot(cancelled, makeLot({ bidCount: 0, status: 'open' }))).toBe(cancelled);
  });

  it('encerramento chegando por cima de um lote aberto vale', () => {
    const open = makeLot({ bidCount: 3 });
    const closed = makeLot({ bidCount: 3, status: 'closed' });
    expect(mergeLot(open, closed)).toBe(closed);
  });

  it('outro lote (troca de sala) nunca e misturado', () => {
    const current = makeLot({ bidCount: 9 });
    const other = makeLot({ id: '22222222-2222-4222-8222-222222222222', bidCount: 0 });
    expect(mergeLot(current, other)).toBe(other);
  });
});

describe('bidSuggestions e isUnusualBid', () => {
  it('sugere o minimo e degraus acima, sem repeticao', () => {
    expect(bidSuggestions(10_000, 1_000)).toEqual([10_000, 11_000, 15_000, 20_000]);
    expect(bidSuggestions(10_000, 0)).toEqual([10_000]);
  });

  it('lance normal passa; valor muito acima do minimo pede confirmacao', () => {
    expect(isUnusualBid(10_000, 10_000, 1_000)).toBe(false);
    expect(isUnusualBid(15_000, 10_000, 1_000)).toBe(false);
    expect(isUnusualBid(29_999, 10_000, 5_000)).toBe(false);
    expect(isUnusualBid(30_000, 10_000, 5_000)).toBe(true); // 3x o minimo
    expect(isUnusualBid(100_000, 10_000, 1_000)).toBe(true); // um zero a mais
    expect(isUnusualBid(30_000, 20_000, 500)).toBe(true); // 20 incrementos acima
  });
});

describe('leitura defensiva dos eventos', () => {
  const valid = {
    seq: 1,
    amount: 10_000,
    bidder: 'Licitante A1',
    placedAt: iso(0),
    endsAt: iso(MIN),
    extended: false,
    bidCount: 1,
    minimumNextBid: 11_000,
    mine: true,
    outbid: false,
    serverNow: iso(0),
  };

  it('evento valido e lido por inteiro', () => {
    expect(parseBidEvent(valid)).toMatchObject({
      seq: 1,
      amount: 10_000,
      mine: true,
      minimumNextBid: 11_000,
    });
  });

  it.each([
    ['null', null],
    ['texto', 'oi'],
    ['array', []],
    ['sem seq', { ...valid, seq: undefined }],
    ['seq decimal', { ...valid, seq: 1.5 }],
    ['valor como texto', { ...valid, amount: '10000' }],
    ['valor NaN', { ...valid, amount: Number.NaN }],
    ['bidCount ausente', { ...valid, bidCount: undefined }],
    ['bidder numero', { ...valid, bidder: 7 }],
    ['data invalida', { ...valid, endsAt: 'nunca' }],
    ['placedAt ausente', { ...valid, placedAt: undefined }],
  ])('descarta evento malformado: %s', (_name, payload) => {
    expect(parseBidEvent(payload)).toBeNull();
  });

  it('campos opcionais ausentes viram padroes seguros', () => {
    const lean = {
      ...valid,
      minimumNextBid: undefined,
      mine: undefined,
      outbid: undefined,
      serverNow: undefined,
      extended: undefined,
    };
    expect(parseBidEvent(lean)).toMatchObject({
      minimumNextBid: null,
      mine: false,
      outbid: false,
      extended: false,
      serverNow: valid.placedAt,
    });
  });

  it('snapshot valido passa; lixo e descartado', () => {
    const lot = makeLot();
    expect(parseSnapshot({ lot })).toEqual(lot);
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({})).toBeNull();
    expect(parseSnapshot({ lot: { id: 1 } })).toBeNull();
    expect(parseSnapshot({ lot: { ...lot, bids: 'x' } })).toBeNull();
    expect(parseSnapshot({ lot: { ...lot, bidCount: '3' } })).toBeNull();
    expect(parseSnapshot({ lot: { ...lot, endsAt: undefined } })).toBeNull();
  });

  it('parseServerNow so aceita texto', () => {
    expect(parseServerNow({ serverNow: iso(0) })).toBe(iso(0));
    expect(parseServerNow({ serverNow: 5 })).toBeUndefined();
    expect(parseServerNow(null)).toBeUndefined();
  });
});
