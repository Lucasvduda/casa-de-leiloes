import { describe, expect, it } from 'vitest';
import { defaultSort, parseListState, toApiParams, toSearchParams } from './list-params';

const parse = (query: string) => parseListState(new URLSearchParams(query));

describe('parseListState', () => {
  it('URL vazia: ao vivo, sem busca, ordenado por quem termina primeiro, pagina 1', () => {
    expect(parse('')).toEqual({ tab: 'ao-vivo', q: '', sort: 'ending', page: 1 });
  });

  it('le aba, busca, ordem e pagina validas', () => {
    expect(parse('fase=encerrados&busca=vaso&ordem=price_desc&pagina=3')).toEqual({
      tab: 'encerrados',
      q: 'vaso',
      sort: 'price_desc',
      page: 3,
    });
  });

  it('encerrados ordena por mais recentes por padrao', () => {
    expect(parse('fase=encerrados').sort).toBe('newest');
    expect(defaultSort('agendados')).toBe('ending');
  });

  it.each([
    ['fase=qualquer-coisa', 'tab', 'ao-vivo'],
    ['fase=', 'tab', 'ao-vivo'],
    ['ordem=drop table', 'sort', 'ending'],
    ['pagina=0', 'page', 1],
    ['pagina=-4', 'page', 1],
    ['pagina=2.5', 'page', 1],
    ['pagina=abc', 'page', 1],
    ['pagina=99999999999', 'page', 1],
    ['pagina=', 'page', 1],
  ])('URL adulterada (%s) cai no padrao', (query, field, expected) => {
    expect(parse(query)[field as 'tab' | 'sort' | 'page']).toBe(expected);
  });

  it('busca e aparada e limitada a 100 caracteres', () => {
    expect(parse('busca=%20%20vaso%20%20').q).toBe('vaso');
    expect(parse(`busca=${'a'.repeat(500)}`).q).toHaveLength(100);
  });
});

describe('toSearchParams', () => {
  it('estado padrao gera URL vazia', () => {
    expect(toSearchParams({ tab: 'ao-vivo', q: '', sort: 'ending', page: 1 }).toString()).toBe('');
  });

  it('escreve so o que difere do padrao', () => {
    expect(
      toSearchParams({ tab: 'encerrados', q: 'vaso azul', sort: 'newest', page: 2 }).toString(),
    ).toBe('fase=encerrados&busca=vaso+azul&pagina=2');
  });

  it('ida e volta preserva o estado', () => {
    const states = [
      { tab: 'agendados', q: '', sort: 'price_asc', page: 4 },
      { tab: 'encerrados', q: 'ç & ?=', sort: 'newest', page: 1 },
      { tab: 'ao-vivo', q: 'x', sort: 'ending', page: 1 },
    ] as const;
    for (const state of states) {
      expect(parseListState(toSearchParams(state))).toEqual(state);
    }
  });
});

describe('toApiParams', () => {
  it('traduz a aba para a fase da API e omite busca vazia', () => {
    expect(toApiParams({ tab: 'encerrados', q: '', sort: 'newest', page: 2 })).toEqual({
      phase: 'finished',
      q: undefined,
      sort: 'newest',
      page: 2,
      pageSize: 12,
    });
    expect(toApiParams({ tab: 'ao-vivo', q: 'x', sort: 'ending', page: 1 }).phase).toBe('live');
    expect(toApiParams({ tab: 'agendados', q: '', sort: 'ending', page: 1 }).phase).toBe(
      'scheduled',
    );
  });
});
