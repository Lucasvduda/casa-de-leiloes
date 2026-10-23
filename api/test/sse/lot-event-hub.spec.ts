import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../src/adapters/inbound/http/http-error.js';
import { LotEventHub } from '../../src/adapters/inbound/http/sse/lot-event-hub.js';
import type {
  HubDeps,
  HubLimits,
  SseSink,
} from '../../src/adapters/inbound/http/sse/lot-event-hub.js';
import { InMemoryEventBus, createMac } from '../../src/adapters/outbound/system.js';
import type { Actor, AuctionEvent } from '../../src/application/ports.js';
import type { LotDetailDto } from '../../src/application/usecases/auction-queries.js';
import { cents } from '../../src/domain/money.js';
import { publicBidderRef } from '../../src/domain/public-bidder-ref.js';

const LOT = '11111111-1111-4111-8111-111111111111';
const OTHER_LOT = '22222222-2222-4222-8222-222222222222';
const mac = createMac('segredo-de-teste-com-mais-de-32-caracteres');

class FakeSink implements SseSink {
  readonly chunks: string[] = [];
  opened = 0;
  ended = 0;
  destroyed = 0;
  writableLength = 0;
  throwOnWrite = false;
  /** Tamanho que o buffer passa a ter depois de cada escrita (simula cliente que nao le). */
  growBy = 0;

  open(): void {
    this.opened += 1;
  }
  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error('socket fechado');
    this.chunks.push(chunk);
    this.writableLength += this.growBy;
    return true;
  }
  end(): void {
    this.ended += 1;
  }
  destroy(): void {
    this.destroyed += 1;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload dinamico, so em teste
  get frames(): { event: string; data: any }[] {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((block) => block.includes('event:'))
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)![1]!;
        const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
        return { event, data };
      });
  }
  names(): string[] {
    return this.frames.map((f) => f.event);
  }
}

const snap = (over: Record<string, unknown> = {}): LotDetailDto =>
  ({
    id: LOT,
    title: 'Obra',
    phase: 'live',
    bidCount: 0,
    minIncrement: cents(500),
    ...over,
  }) as unknown as LotDetailDto;

const bid = (over: Record<string, unknown> = {}): AuctionEvent =>
  ({
    type: 'bid_placed',
    lotId: LOT,
    seq: 1,
    amount: cents(10_000),
    bidderId: 'user-bob',
    previousLeaderId: null,
    placedAt: new Date('2026-11-01T12:00:00Z'),
    endsAt: new Date('2026-11-01T13:00:00Z'),
    extended: false,
    bidCount: 1,
    ...over,
  }) as AuctionEvent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(over: Partial<HubDeps> = {}, limits: Partial<HubLimits> = {}) {
  const bus = new InMemoryEventBus();
  const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
  const warn = vi.fn();
  const state = { load: (async () => snap()) as () => Promise<LotDetailDto> };
  const hub = new LotEventHub({
    bus,
    loadSnapshot: () => state.load(),
    mac,
    now: () => clock.t,
    logger: { warn },
    autoTick: false,
    limits,
    ...over,
  });
  const connect = (
    sink: FakeSink,
    extra: Partial<{ lotId: string; viewer: Actor | null; ip: string; signal: AbortSignal }> = {},
  ) => hub.connect({ lotId: LOT, viewer: null, ip: '10.0.0.1', sink, ...extra });
  return { hub, bus, clock, warn, state, connect };
}

const microtasks = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('abertura da transmissao', () => {
  it('abre os cabecalhos uma vez, sugere o intervalo de reconexao e manda o snapshot primeiro', async () => {
    const { connect, state } = setup();
    state.load = async () => snap({ bidCount: 4 });
    const sink = new FakeSink();
    const result = await connect(sink);
    expect(result.status).toBe('streaming');
    expect(sink.opened).toBe(1);
    expect(sink.chunks[0]).toBe('retry: 3000\n\n');
    expect(sink.names()).toEqual(['snapshot']);
    expect(sink.frames[0]!.data.lot).toMatchObject({ id: LOT, bidCount: 4 });
  });

  it.each(['closed', 'cancelled'])(
    'lote %s: nada a transmitir (a rota responde 204) e nenhuma vaga fica presa',
    async (phase) => {
      const { connect, state, hub } = setup();
      state.load = async () => snap({ phase });
      const sink = new FakeSink();
      expect((await connect(sink)).status).toBe('finished');
      expect(sink.opened).toBe(0);
      expect(sink.chunks).toEqual([]);
      expect(hub.stats()).toEqual({ connections: 0, lots: 0, ips: 0 });
    },
  );

  it('falha ao carregar o snapshot (ex.: lote inexistente) propaga e NAO vaza vaga', async () => {
    const { connect, state, hub } = setup();
    state.load = async () => {
      throw new HttpError(404, 'LOT_NOT_FOUND', 'x');
    };
    const sink = new FakeSink();
    await expect(connect(sink)).rejects.toMatchObject({ code: 'LOT_NOT_FOUND' });
    expect(sink.opened).toBe(0);
    expect(hub.stats().connections).toBe(0);
  });

  it('cliente que desiste DURANTE o carregamento nao abre stream nem deixa vaga', async () => {
    const { connect, state, hub } = setup();
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const abort = new AbortController();
    const sink = new FakeSink();
    const pending = connect(sink, { signal: abort.signal });
    await microtasks();
    expect(hub.stats().connections).toBe(1);
    abort.abort();
    gate.resolve(snap());
    expect((await pending).status).toBe('finished');
    expect(sink.opened).toBe(0);
    expect(hub.stats().connections).toBe(0);
  });

  it('cliente que sai depois de conectado libera a vaga e nao recebe mais nada', async () => {
    const { connect, bus, hub } = setup();
    const abort = new AbortController();
    const sink = new FakeSink();
    await connect(sink, { signal: abort.signal });
    abort.abort();
    expect(hub.stats().connections).toBe(0);
    bus.publish(bid());
    expect(sink.names()).toEqual(['snapshot']);
  });

  it('close() do handle e idempotente', async () => {
    const { connect, hub } = setup();
    const result = await connect(new FakeSink());
    if (result.status !== 'streaming') throw new Error('esperava streaming');
    result.close();
    result.close();
    expect(hub.stats().connections).toBe(0);
  });
});

describe('evento de lance', () => {
  it('chega com tudo que a sala precisa e o proximo lance minimo calculado', async () => {
    const { connect, bus } = setup();
    const sink = new FakeSink();
    await connect(sink);
    bus.publish(bid({ seq: 1, amount: cents(10_000), bidCount: 1, extended: true }));
    const event = sink.frames.find((f) => f.event === 'bid')!;
    expect(event.data).toMatchObject({
      seq: 1,
      amount: 10_000,
      bidder: publicBidderRef(mac, 'user-bob', LOT),
      placedAt: '2026-11-01T12:00:00.000Z',
      endsAt: '2026-11-01T13:00:00.000Z',
      extended: true,
      bidCount: 1,
      minimumNextBid: 10_500,
      serverNow: '2026-11-01T12:00:00.000Z',
    });
  });

  it('PRIVACIDADE: nenhum id interno sai no stream (nem o do lider anterior)', async () => {
    const { connect, bus } = setup();
    const sink = new FakeSink();
    await connect(sink, { viewer: { id: 'user-alice', role: 'bidder' } });
    bus.publish(bid({ bidderId: 'user-bob', previousLeaderId: 'user-alice' }));
    const raw = sink.chunks.join('');
    expect(raw).not.toContain('user-bob');
    expect(raw).not.toContain('user-alice');
    expect(raw).not.toContain('previousLeaderId');
    expect(raw).not.toContain('bidderId');
  });

  it('flags por espectador: quem deu o lance ve mine; quem foi superado ve outbid; os demais, nenhum', async () => {
    const { connect, bus } = setup();
    const bob = new FakeSink();
    const alice = new FakeSink();
    const carol = new FakeSink();
    const anon = new FakeSink();
    await connect(bob, { viewer: { id: 'user-bob', role: 'bidder' } });
    await connect(alice, { viewer: { id: 'user-alice', role: 'bidder' } });
    await connect(carol, { viewer: { id: 'user-carol', role: 'bidder' } });
    await connect(anon);
    bus.publish(bid({ bidderId: 'user-bob', previousLeaderId: 'user-alice' }));
    const flags = (s: FakeSink) => {
      const { mine, outbid } = s.frames.find((f) => f.event === 'bid')!.data;
      return { mine, outbid };
    };
    expect(flags(bob)).toEqual({ mine: true, outbid: false });
    expect(flags(alice)).toEqual({ mine: false, outbid: true });
    expect(flags(carol)).toEqual({ mine: false, outbid: false });
    expect(flags(anon)).toEqual({ mine: false, outbid: false });
  });

  it('quem deu o lance nunca e marcado como superado, mesmo se o evento vier com ele como lider anterior', async () => {
    const { connect, bus } = setup();
    const bob = new FakeSink();
    await connect(bob, { viewer: { id: 'user-bob', role: 'bidder' } });
    bus.publish(bid({ bidderId: 'user-bob', previousLeaderId: 'user-bob' }));
    const { mine, outbid } = bob.frames.find((f) => f.event === 'bid')!.data;
    expect({ mine, outbid }).toEqual({ mine: true, outbid: false });
  });

  it('so recebe quem esta na sala daquele lote', async () => {
    const { connect, bus } = setup();
    const here = new FakeSink();
    const there = new FakeSink();
    await connect(here);
    await connect(there, { lotId: OTHER_LOT });
    bus.publish(bid());
    expect(here.names()).toEqual(['snapshot', 'bid']);
    expect(there.names()).toEqual(['snapshot']);
  });

  it('lance repetido ou fora de ordem (seq <= ultimo visto) e ignorado', async () => {
    const { connect, bus, state } = setup();
    state.load = async () => snap({ bidCount: 2 });
    const sink = new FakeSink();
    await connect(sink);
    bus.publish(bid({ seq: 2 })); // ja refletido no snapshot
    bus.publish(bid({ seq: 1 }));
    bus.publish(bid({ seq: 3, bidCount: 3 }));
    bus.publish(bid({ seq: 3, bidCount: 3 })); // duplicado
    bus.publish(bid({ seq: 4, bidCount: 4 }));
    expect(sink.frames.filter((f) => f.event === 'bid').map((f) => f.data.seq)).toEqual([3, 4]);
  });
});

describe('corrida entre snapshot e eventos (nenhum lance se perde)', () => {
  it('eventos que chegam durante o carregamento saem DEPOIS do snapshot, sem duplicar o que ele ja continha', async () => {
    const { connect, bus, state } = setup();
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const sink = new FakeSink();
    const pending = connect(sink);
    await microtasks();

    bus.publish(bid({ seq: 3, bidCount: 3 })); // o snapshot ja vai conter
    bus.publish(bid({ seq: 4, bidCount: 4 })); // este nao
    bus.publish(bid({ seq: 5, bidCount: 5 }));
    expect(sink.chunks).toEqual([]); // nada sai antes do snapshot

    gate.resolve(snap({ bidCount: 3 }));
    await pending;
    expect(sink.names()).toEqual(['snapshot', 'bid', 'bid']);
    expect(sink.frames.filter((f) => f.event === 'bid').map((f) => f.data.seq)).toEqual([4, 5]);
  });

  it('lote que encerra durante o carregamento: entrega o fim depois do snapshot e fecha o stream', async () => {
    const { connect, bus, state, hub } = setup();
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const sink = new FakeSink();
    const pending = connect(sink);
    await microtasks();
    bus.publish({ type: 'lot_closed', lotId: LOT, sold: true });
    gate.resolve(snap());
    await pending;
    expect(sink.names()).toEqual(['snapshot', 'closed']);
    expect(sink.ended).toBe(1);
    expect(hub.stats().connections).toBe(0);
  });

  it('fila de espera limitada: estouro derruba a conexao (nao cresce sem limite)', async () => {
    const { connect, bus, state, hub, warn } = setup({}, { maxPendingEvents: 2 });
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const sink = new FakeSink();
    const pending = connect(sink);
    await microtasks();
    for (let seq = 1; seq <= 3; seq++) bus.publish(bid({ seq, bidCount: seq }));
    expect(sink.destroyed).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'pending_overflow' }),
      'sse_connection_dropped',
    );
    gate.resolve(snap());
    expect((await pending).status).toBe('finished');
    expect(sink.opened).toBe(0);
    expect(hub.stats().connections).toBe(0);
  });
});

describe('fim do lote', () => {
  it('lot_closed: entrega `closed` com o resultado (vendido ou nao), fecha o stream e libera a vaga', async () => {
    const { connect, bus, hub } = setup();
    const sink = new FakeSink();
    await connect(sink);
    bus.publish({ type: 'lot_closed', lotId: LOT, sold: false });
    expect(sink.frames.at(-1)).toMatchObject({ event: 'closed', data: { sold: false } });
    expect(sink.ended).toBe(1);
    expect(hub.stats().connections).toBe(0);
    bus.publish(bid());
    expect(sink.names()).toEqual(['snapshot', 'closed']);
  });

  it('lot_cancelled: entrega `cancelled` e fecha', async () => {
    const { connect, bus } = setup();
    const sink = new FakeSink();
    await connect(sink);
    bus.publish({ type: 'lot_cancelled', lotId: LOT });
    expect(sink.names()).toEqual(['snapshot', 'cancelled']);
    expect(sink.ended).toBe(1);
  });

  it('o fim de um lote nao afeta outras salas', async () => {
    const { connect, bus } = setup();
    const a = new FakeSink();
    const b = new FakeSink();
    await connect(a);
    await connect(b, { lotId: OTHER_LOT });
    bus.publish({ type: 'lot_closed', lotId: LOT, sold: true });
    expect(a.ended).toBe(1);
    expect(b.ended).toBe(0);
  });
});

describe('limites de capacidade', () => {
  it('por IP: o excedente leva 429 TOO_MANY_STREAMS; outro IP passa; fechar uma devolve a vaga', async () => {
    const { connect } = setup({}, { maxPerIp: 2 });
    const first = await connect(new FakeSink());
    await connect(new FakeSink());
    const error = await connect(new FakeSink()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_STREAMS' });
    expect((await connect(new FakeSink(), { ip: '10.0.0.2' })).status).toBe('streaming');
    if (first.status === 'streaming') first.close();
    expect((await connect(new FakeSink())).status).toBe('streaming');
  });

  it('por lote: 503 STREAM_CAPACITY; outro lote segue livre', async () => {
    const { connect } = setup({}, { maxPerLot: 2, maxPerIp: 99 });
    await connect(new FakeSink());
    await connect(new FakeSink());
    await expect(connect(new FakeSink())).rejects.toMatchObject({
      status: 503,
      code: 'STREAM_CAPACITY',
    });
    expect((await connect(new FakeSink(), { lotId: OTHER_LOT })).status).toBe('streaming');
  });

  it('total: 503 STREAM_CAPACITY', async () => {
    const { connect } = setup({}, { maxConnections: 2, maxPerLot: 99, maxPerIp: 99 });
    await connect(new FakeSink());
    await connect(new FakeSink(), { lotId: OTHER_LOT });
    await expect(
      connect(new FakeSink(), { lotId: '33333333-3333-4333-8333-333333333333' }),
    ).rejects.toMatchObject({
      code: 'STREAM_CAPACITY',
    });
  });

  it('conexoes ainda CARREGANDO o snapshot ja ocupam vaga (senao uma rajada furaria o limite)', async () => {
    const { connect, state } = setup({}, { maxPerIp: 2 });
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const a = connect(new FakeSink());
    const b = connect(new FakeSink());
    await microtasks();
    await expect(connect(new FakeSink())).rejects.toMatchObject({ code: 'TOO_MANY_STREAMS' });
    gate.resolve(snap());
    await Promise.all([a, b]);
  });

  it('abrir e fechar muitas vezes nao vaza contador', async () => {
    const { connect, hub } = setup({}, { maxPerIp: 3 });
    for (let i = 0; i < 50; i++) {
      const result = await connect(new FakeSink());
      if (result.status === 'streaming') result.close();
    }
    expect(hub.stats()).toEqual({ connections: 0, lots: 0, ips: 0 });
  });
});

describe('cliente lento ou com defeito', () => {
  it('buffer acima do teto: derruba o lento e os demais continuam recebendo', async () => {
    const { connect, bus, hub, warn } = setup({}, { maxBufferedBytes: 1_000 });
    const slow = new FakeSink();
    const healthy = new FakeSink();
    await connect(slow);
    await connect(healthy);
    slow.writableLength = 5_000;
    bus.publish(bid());
    expect(slow.destroyed).toBe(1);
    expect(slow.names()).toEqual(['snapshot']);
    expect(healthy.names()).toEqual(['snapshot', 'bid']);
    expect(hub.stats().connections).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      { reason: 'slow_consumer', lotId: LOT },
      'sse_connection_dropped',
    );
  });

  it('o buffer que estoura DEPOIS da escrita tambem derruba', async () => {
    const { connect, bus, hub } = setup({}, { maxBufferedBytes: 1_000 });
    const sink = new FakeSink();
    await connect(sink);
    sink.growBy = 5_000;
    bus.publish(bid({ seq: 1 }));
    expect(sink.destroyed).toBe(1);
    expect(hub.stats().connections).toBe(0);
  });

  it('escrita que lanca nao atrapalha os outros nem o fluxo do lance', async () => {
    const { connect, bus, hub } = setup();
    const broken = new FakeSink();
    const healthy = new FakeSink();
    await connect(broken);
    await connect(healthy);
    broken.throwOnWrite = true;
    expect(() => bus.publish(bid())).not.toThrow();
    expect(healthy.names()).toEqual(['snapshot', 'bid']);
    expect(broken.destroyed).toBe(1);
    expect(hub.stats().connections).toBe(1);
  });
});

describe('batimento e vida maxima', () => {
  it('tick envia o relogio do servidor so para quem ja esta pronto', async () => {
    const { connect, hub, clock, state } = setup();
    const ready = new FakeSink();
    await connect(ready);
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const loading = new FakeSink();
    const pending = connect(loading);
    await microtasks();
    clock.t += 15_000;
    hub.tick();
    expect(ready.frames.at(-1)).toEqual({
      event: 'tick',
      data: { serverNow: '2026-11-01T12:00:15.000Z' },
    });
    expect(loading.chunks).toEqual([]);
    gate.resolve(snap());
    await pending;
  });

  it('conexao mais velha que o limite e encerrada (o EventSource reconecta e reautentica)', async () => {
    const { connect, hub, clock } = setup({}, { maxLifetimeMs: 60_000 });
    const old = new FakeSink();
    await connect(old);
    clock.t += 59_999;
    hub.tick();
    expect(old.ended).toBe(0);
    clock.t += 1;
    hub.tick();
    expect(old.ended).toBe(1);
    expect(hub.stats().connections).toBe(0);
    hub.tick();
    expect(old.names().filter((n) => n === 'tick')).toHaveLength(1); // o de 59.999ms
  });

  it('o timer so existe enquanto ha conexoes (nada fica rodando a toa)', async () => {
    vi.useFakeTimers();
    const { connect } = setup({ autoTick: true }, { heartbeatMs: 1_000 });
    expect(vi.getTimerCount()).toBe(0);
    const sink = new FakeSink();
    const result = await connect(sink);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(sink.names().filter((n) => n === 'tick')).toHaveLength(2);
    if (result.status === 'streaming') result.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('desligamento', () => {
  it('close() encerra todas as transmissoes, para de ouvir o barramento e recusa novas', async () => {
    const { connect, bus, hub } = setup();
    const a = new FakeSink();
    const b = new FakeSink();
    await connect(a);
    await connect(b, { lotId: OTHER_LOT });
    hub.close();
    expect([a.ended, b.ended]).toEqual([1, 1]);
    expect(hub.stats().connections).toBe(0);
    bus.publish(bid());
    expect(a.names()).toEqual(['snapshot']);
    await expect(connect(new FakeSink())).rejects.toMatchObject({
      status: 503,
      code: 'SHUTTING_DOWN',
    });
    expect(() => hub.close()).not.toThrow();
  });

  it('close() durante o carregamento: o cliente em espera nao abre stream', async () => {
    const { connect, hub, state } = setup();
    const gate = deferred<LotDetailDto>();
    state.load = () => gate.promise;
    const sink = new FakeSink();
    const pending = connect(sink);
    await microtasks();
    hub.close();
    gate.resolve(snap());
    expect((await pending).status).toBe('finished');
    expect(sink.opened).toBe(0);
  });
});

describe('integridade do formato SSE', () => {
  it('quebra de linha e campos SSE dentro do conteudo nao conseguem forjar eventos', async () => {
    const { connect, state } = setup();
    state.load = async () => snap({ title: 'Obra\n\nevent: closed\ndata: {"sold":true}\n\n' });
    const sink = new FakeSink();
    await connect(sink);
    const raw = sink.chunks[1]!;
    // Exatamente um frame: um unico terminador "\n\n", no fim.
    expect(raw.indexOf('\n\n')).toBe(raw.length - 2);
    expect(raw.match(/^event: /gm)).toHaveLength(1);
    expect(sink.names()).toEqual(['snapshot']);
    expect(sink.frames[0]!.data.lot.title).toContain('event: closed');
  });
});
