import { describe, expect, it } from 'vitest';
import { NOW, iso, makeSummary } from '../../test/fixtures';
import { bidOutcome } from './MyBidsPage';

const viewer = (isLeading: boolean) => ({ isSeller: false, isLeading });

describe('bidOutcome', () => {
  it('ao vivo e liderando', () => {
    const lot = makeSummary({ viewer: viewer(true) });
    expect(bidOutcome(lot, NOW)).toEqual({ label: 'Você lidera', tone: 'success' });
  });

  it('ao vivo e superado', () => {
    const lot = makeSummary({ viewer: viewer(false) });
    expect(bidOutcome(lot, NOW)).toEqual({ label: 'Você foi superado', tone: 'warning' });
  });

  it('encerrado e arrematado por mim', () => {
    const lot = makeSummary({ status: 'closed', endsAt: iso(-1000), viewer: viewer(true) });
    expect(bidOutcome(lot, NOW)).toEqual({ label: 'Você arrematou', tone: 'success' });
  });

  it('encerrado e perdi', () => {
    const lot = makeSummary({ status: 'closed', endsAt: iso(-1000), viewer: viewer(false) });
    expect(bidOutcome(lot, NOW)).toEqual({ label: 'Não arrematado', tone: 'neutral' });
  });

  it('cancelado: valor devolvido, mesmo que eu liderasse', () => {
    const lot = makeSummary({ status: 'cancelled', viewer: viewer(true) });
    expect(bidOutcome(lot, NOW)).toEqual({ label: 'Cancelado, valor devolvido', tone: 'danger' });
  });

  it('prazo vencido mas ainda sem fechamento no servidor segue como "ao vivo" para o resultado', () => {
    const lot = makeSummary({ status: 'open', endsAt: iso(-500), viewer: viewer(true) });
    expect(bidOutcome(lot, NOW).tone).toBe('success');
  });
});
