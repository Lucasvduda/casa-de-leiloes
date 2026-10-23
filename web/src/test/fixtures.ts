import type { BidEventPayload, LotDetail, LotSummary, User } from '../api/types';

export const NOW = Date.parse('2026-10-23T12:00:00.000Z');
export const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

export function makeLot(overrides: Partial<LotDetail> = {}): LotDetail {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Vaso Ming',
    imageUrl: 'https://openaccess-cdn.clevelandart.org/1.jpg',
    startingBid: 10_000,
    minIncrement: 1_000,
    currentAmount: null,
    minimumNextBid: 10_000,
    bidCount: 0,
    startsAt: iso(-60 * 60_000),
    endsAt: iso(60 * 60_000),
    status: 'open',
    phase: 'live',
    sellerName: 'Casa Demo Leiloeiro',
    receiptCode: null,
    viewer: null,
    item: {
      source: 'cleveland',
      sourceId: '123',
      sourceUrl: 'https://clevelandart.org/art/123',
      title: 'Vaso Ming',
      imageUrl: 'https://openaccess-cdn.clevelandart.org/1.jpg',
      attributes: { Cultura: 'China', Técnica: 'Porcelana' },
    },
    bids: [],
    serverNow: iso(0),
    result: null,
    viewerDetail: null,
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<LotSummary> = {}): LotSummary {
  const lot = makeLot();
  return {
    id: lot.id,
    title: lot.title,
    imageUrl: lot.imageUrl,
    startingBid: lot.startingBid,
    minIncrement: lot.minIncrement,
    currentAmount: lot.currentAmount,
    minimumNextBid: lot.minimumNextBid,
    bidCount: lot.bidCount,
    startsAt: lot.startsAt,
    endsAt: lot.endsAt,
    status: lot.status,
    phase: lot.phase,
    sellerName: lot.sellerName,
    receiptCode: lot.receiptCode,
    viewer: lot.viewer,
    ...overrides,
  };
}

export function makeBid(overrides: Partial<BidEventPayload> = {}): BidEventPayload {
  return {
    seq: 1,
    amount: 10_000,
    bidder: 'Licitante A1',
    placedAt: iso(-1000),
    endsAt: iso(60 * 60_000),
    extended: false,
    bidCount: 1,
    minimumNextBid: 11_000,
    mine: false,
    outbid: false,
    serverNow: iso(0),
    ...overrides,
  };
}

export const BIDDER: User = {
  id: 'u-bidder',
  email: 'ana@demo.leilao',
  displayName: 'Ana Licitante',
  role: 'bidder',
};

export const SELLER: User = {
  id: 'u-seller',
  email: 'leiloeiro@demo.leilao',
  displayName: 'Casa Demo Leiloeiro',
  role: 'seller',
};
