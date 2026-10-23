import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { settleDueTask } from '../src/infrastructure/scheduler.js';
import { HOUR, MIN, FakeClock, reais } from './support/harness.js';
import { Client, LOOSE_RATE_LIMITS, createHttpHarness } from './support/http-harness.js';
import type { HttpHarness } from './support/http-harness.js';
import { SseStream, listen } from './support/sse-client.js';
import { createTestDb } from './support/test-db.js';
import type { TestDb } from './support/test-db.js';

let db: TestDb;
let http: HttpHarness;
let server: Awaited<ReturnType<typeof listen>>;
const clock = new FakeClock();
const open: SseStream[] = [];
const extraServers: { close(): Promise<void> }[] = [];
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  db = await createTestDb();
  http = createHttpHarness(db, { clock });
  server = await listen(http.app);
});

afterEach(() => {
  for (const stream of open.splice(0)) stream.close();
});

afterAll(async () => {
  await server.close();
  for (const extra of extraServers) await extra.close();
  await db.close();
});

async function register(
  role: 'seller' | 'bidder',
  name: string,
  funds = 0,
  target: HttpHarness = http,
): Promise<Client> {
  const c = new Client(target.app);
  expect((await c.register({ role, displayName: name })).res.status).toBe(201);
  if (funds > 0) expect((await c.post('/api/wallet/deposits', { amount: funds })).status).toBe(201);
  return c;
}

async function liveLot(s: Client, over: Record<string, unknown> = {}): Promise<string> {
  const now = clock.now().getTime();
  const res = await s.post('/api/lots', {
    sourceId: '1001',
    startingBid: reais(100),
    minIncrement: reais(5),
    startsAt: iso(now),
    endsAt: iso(now + HOUR),
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.lot.id as string;
}

const bid = (c: Client, lotId: string, amount: number) =>
  c.post(`/api/lots/${lotId}/bids`, { amount });

async function watch(
  lotId: string,
  as: Client | null = null,
  base = server.baseUrl,
): Promise<SseStream> {
  const stream = await SseStream.connect(base, `/api/lots/${lotId}/events`, {
    cookie: as?.cookieHeader ?? null,
  });
  open.push(stream);
  return stream;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condicao nao ocorreu a tempo');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('abertura', () => {
  it('cabecalhos corretos para SSE atras de proxy e snapshot igual ao da sala', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const lotId = await liveLot(s);
    await bid(bob, lotId, reais(100));

    const stream = await watch(lotId);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');

    const first = await stream.next();
    expect(first.event).toBe('snapshot');
    const room = (await request(http.app).get(`/api/lots/${lotId}`)).body.lot;
    expect(first.data.lot).toMatchObject({
      id: lotId,
      bidCount: 1,
      currentAmount: room.currentAmount,
      minimumNextBid: room.minimumNextBid,
      phase: 'live',
    });
    expect(typeof first.data.lot.serverNow).toBe('string');
    expect(stream.retryMs).toBe(3_000);
  });

  it('lote inexistente ou id malformado: erro JSON padrao (nao abre stream)', async () => {
    for (const id of ['11111111-1111-4111-8111-111111111111', 'abc', "' OR 1=1 --"]) {
      const stream = await watch(id);
      expect(stream.status, id).toBe(404);
      expect(JSON.parse(stream.bodyText).error.code).toBe('LOT_NOT_FOUND');
    }
  });

  it('lote ja encerrado -> 204 (o EventSource para de reconectar)', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const lotId = await liveLot(s);
    await bid(bob, lotId, reais(100));
    clock.advance(HOUR + MIN);
    await request(http.app).get(`/api/lots/${lotId}`); // liquida
    const stream = await watch(lotId);
    expect(stream.status).toBe(204);
    expect(stream.bodyText).toBe('');
  });

  it('lote cancelado -> 204', async () => {
    const s = await register('seller', 'Leiloeiro');
    const lotId = await liveLot(s);
    await s.post(`/api/lots/${lotId}/cancel`);
    expect((await watch(lotId)).status).toBe(204);
  });
});

describe('lances ao vivo', () => {
  it('cada lance chega em ordem, sem buracos nem repeticao, e sem dado pessoal', async () => {
    const s = await register('seller', 'Leiloeiro');
    const alice = await register('bidder', 'Alice Segredo', reais(10_000));
    const bob = await register('bidder', 'Bob Segredo', reais(10_000));
    const lotId = await liveLot(s);
    const stream = await watch(lotId);
    await stream.next(); // snapshot

    const amounts = [100, 105, 110, 200, 205];
    for (const [i, amount] of amounts.entries()) {
      expect((await bid(i % 2 === 0 ? alice : bob, lotId, reais(amount))).status).toBe(201);
    }
    const events = [];
    for (let i = 0; i < amounts.length; i++) events.push(await stream.until('bid'));
    expect(events.map((e) => e.data.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((e) => e.data.amount)).toEqual(amounts.map((a) => reais(a)));
    expect(events.map((e) => e.data.bidCount)).toEqual([1, 2, 3, 4, 5]);
    expect(events[4]!.data.minimumNextBid).toBe(reais(210));
    // Alice e Bob alternam: as referencias anonimas tambem.
    expect(events[0]!.data.bidder).toBe(events[2]!.data.bidder);
    expect(events[0]!.data.bidder).not.toBe(events[1]!.data.bidder);

    const raw = stream.rawChunks.join('');
    for (const secret of [
      alice.userId!,
      bob.userId!,
      'Alice Segredo',
      'Bob Segredo',
      '@teste.local',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('flags personalizadas pelo cookie: superado (alice), meu lance (bob), neutro (anonimo)', async () => {
    const s = await register('seller', 'Leiloeiro');
    const alice = await register('bidder', 'Alice', reais(5_000));
    const bob = await register('bidder', 'Bob', reais(5_000));
    const lotId = await liveLot(s);
    await bid(alice, lotId, reais(100));

    const asAlice = await watch(lotId, alice);
    const asBob = await watch(lotId, bob);
    const asAnon = await watch(lotId);
    for (const stream of [asAlice, asBob, asAnon])
      expect((await stream.next()).event).toBe('snapshot');

    await bid(bob, lotId, reais(150));
    const flags = async (stream: SseStream) => {
      const { mine, outbid } = (await stream.until('bid')).data;
      return { mine, outbid };
    };
    expect(await flags(asAlice)).toEqual({ mine: false, outbid: true });
    expect(await flags(asBob)).toEqual({ mine: true, outbid: false });
    expect(await flags(asAnon)).toEqual({ mine: false, outbid: false });
  });

  it('anti-sniping: o evento traz o novo fim', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const lotId = await liveLot(s);
    const stream = await watch(lotId);
    await stream.next();
    clock.advance(HOUR - MIN);
    await bid(bob, lotId, reais(100));
    const event = await stream.until('bid');
    expect(event.data.extended).toBe(true);
    expect(new Date(event.data.endsAt).getTime()).toBe(clock.now().getTime() + 2 * MIN);
  });

  it('lance recusado nao gera evento', async () => {
    const s = await register('seller', 'Leiloeiro');
    const poor = await register('bidder', 'Pobre', reais(50));
    const lotId = await liveLot(s);
    const stream = await watch(lotId);
    await stream.next();
    expect((await bid(poor, lotId, reais(100))).status).toBe(409);
    expect(await stream.quiet(200)).toBe(true);
  });

  it('cada sala so recebe os lances do proprio lote', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(5_000));
    const lotA = await liveLot(s);
    const lotB = await liveLot(s);
    const a = await watch(lotA);
    const b = await watch(lotB);
    await a.next();
    await b.next();
    await bid(bob, lotB, reais(100));
    expect((await b.until('bid')).data.seq).toBe(1);
    expect(await a.quiet(200)).toBe(true);
  });
});

describe('fim do lote', () => {
  it('o agendador liquida o lote vencido e a sala recebe `closed` (vendido) e o stream fecha', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const lotId = await liveLot(s, { endsAt: iso(clock.now().getTime() + 5 * MIN) });
    await bid(bob, lotId, reais(100));
    const stream = await watch(lotId);
    await stream.next();

    clock.advance(6 * MIN);
    await settleDueTask(http.settle, { error: () => undefined }).run();
    const closed = await stream.until('closed');
    expect(closed.data.sold).toBe(true);
    expect(await stream.ended()).toBe(true);

    // O resultado completo vem de GET /lots/:id (receipt etc.).
    const lot = (await request(http.app).get(`/api/lots/${lotId}`)).body.lot;
    expect(lot).toMatchObject({ phase: 'closed', result: { outcome: 'sold' } });
  });

  it('lote sem lances: `closed` com sold=false', async () => {
    const s = await register('seller', 'Leiloeiro');
    const lotId = await liveLot(s, { endsAt: iso(clock.now().getTime() + 2 * MIN) });
    const stream = await watch(lotId);
    await stream.next();
    clock.advance(3 * MIN);
    await settleDueTask(http.settle, { error: () => undefined }).run();
    expect((await stream.until('closed')).data.sold).toBe(false);
  });

  it('abrir a sala depois do fim liquida na hora e avisa quem ja assistia', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const lotId = await liveLot(s, { endsAt: iso(clock.now().getTime() + 5 * MIN) });
    await bid(bob, lotId, reais(100));
    const watcher = await watch(lotId);
    await watcher.next();
    clock.advance(6 * MIN);
    await request(http.app).get(`/api/lots/${lotId}`); // liquidacao preguicosa
    expect((await watcher.until('closed')).data.sold).toBe(true);
  });

  it('cancelamento: `cancelled` e o stream fecha', async () => {
    const s = await register('seller', 'Leiloeiro');
    const lotId = await liveLot(s);
    const stream = await watch(lotId);
    await stream.next();
    expect((await s.post(`/api/lots/${lotId}/cancel`)).status).toBe(200);
    await stream.until('cancelled');
    expect(await stream.ended()).toBe(true);
  });
});

describe('recursos: nada vaza quando o cliente vai embora', () => {
  it('fechar as conexoes (inclusive abruptamente) devolve todas as vagas', async () => {
    const s = await register('seller', 'Leiloeiro');
    const lotId = await liveLot(s);
    const baseline = http.hub.stats().connections;
    const streams = await Promise.all(Array.from({ length: 8 }, () => watch(lotId)));
    for (const stream of streams) expect((await stream.next()).event).toBe('snapshot');
    expect(http.hub.stats().connections).toBe(baseline + 8);
    for (const stream of streams) stream.close();
    await waitFor(() => http.hub.stats().connections === baseline);
  });

  it('publicar eventos depois que todos sairam nao quebra nada', async () => {
    const s = await register('seller', 'Leiloeiro');
    const bob = await register('bidder', 'Bob', reais(1_000));
    const lotId = await liveLot(s);
    const stream = await watch(lotId);
    await stream.next();
    stream.close();
    await waitFor(() => http.hub.stats().connections === 0);
    expect((await bid(bob, lotId, reais(100))).status).toBe(201);
  });
});

describe('protecoes de capacidade e abuso (servidor com limites apertados)', () => {
  it('por IP: o terceiro stream leva 429; ao fechar um, volta a aceitar', async () => {
    const tight = createHttpHarness(db, { clock, hubLimits: { maxPerIp: 2 } });
    const srv = await listen(tight.app);
    extraServers.push(srv);
    const s = await register('seller', 'Leiloeiro', 0, tight);
    const lotId = await liveLot(s);

    const first = await watch(lotId, null, srv.baseUrl);
    const second = await watch(lotId, null, srv.baseUrl);
    await first.next();
    await second.next();
    const third = await watch(lotId, null, srv.baseUrl);
    expect(third.status).toBe(429);
    expect(JSON.parse(third.bodyText).error.code).toBe('TOO_MANY_STREAMS');

    first.close();
    await waitFor(() => tight.hub.stats().connections === 1);
    const again = await watch(lotId, null, srv.baseUrl);
    expect(again.status).toBe(200);
  });

  it('limite de taxa nas aberturas: depois de N por minuto, 429 RATE_LIMITED', async () => {
    const limited = createHttpHarness(db, {
      clock,
      rateLimits: { ...LOOSE_RATE_LIMITS, events: { windowMs: 60_000, limit: 3 } },
    });
    const srv = await listen(limited.app);
    extraServers.push(srv);
    const s = await register('seller', 'Leiloeiro', 0, limited);
    const lotId = await liveLot(s);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const stream = await watch(lotId, null, srv.baseUrl);
      statuses.push(stream.status);
      stream.close();
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('batimento: o relogio do servidor chega periodicamente (sincroniza a contagem regressiva)', async () => {
    const beating = createHttpHarness(db, { clock, hubLimits: { heartbeatMs: 40 } });
    const srv = await listen(beating.app);
    extraServers.push(srv);
    const s = await register('seller', 'Leiloeiro', 0, beating);
    const lotId = await liveLot(s);
    const stream = await watch(lotId, null, srv.baseUrl);
    await stream.next();
    const tick = await stream.until('tick');
    expect(tick.data.serverNow).toBe(clock.now().toISOString());
    await stream.until('tick'); // continua batendo
  });

  it('vida maxima: a conexao antiga e encerrada pelo servidor (o navegador reconecta)', async () => {
    const aging = createHttpHarness(db, {
      clock,
      hubLimits: { heartbeatMs: 30, maxLifetimeMs: 60_000 },
    });
    const srv = await listen(aging.app);
    extraServers.push(srv);
    const s = await register('seller', 'Leiloeiro', 0, aging);
    const lotId = await liveLot(s);
    const stream = await watch(lotId, null, srv.baseUrl);
    await stream.next();
    clock.advance(61_000);
    expect(await stream.ended()).toBe(true);
    await waitFor(() => aging.hub.stats().connections === 0);
  });

  it('desligamento: close() do hub encerra os streams e novas conexoes levam 503', async () => {
    const closing = createHttpHarness(db, { clock });
    const srv = await listen(closing.app);
    extraServers.push(srv);
    const s = await register('seller', 'Leiloeiro', 0, closing);
    const lotId = await liveLot(s);
    const stream = await watch(lotId, null, srv.baseUrl);
    await stream.next();
    closing.hub.close();
    expect(await stream.ended()).toBe(true);
    const late = await watch(lotId, null, srv.baseUrl);
    expect(late.status).toBe(503);
    expect(JSON.parse(late.bodyText).error.code).toBe('SHUTTING_DOWN');
  });
});

describe('seguranca da rota', () => {
  it('so GET: POST na rota de eventos nao existe', async () => {
    const s = await register('seller', 'Leiloeiro');
    const lotId = await liveLot(s);
    const res = await s.post(`/api/lots/${lotId}/events`, {});
    expect([404, 405]).toContain(res.status);
  });

  it('a sessao nao vaza para outra pessoa: cookie invalido vira espectador anonimo (sem erro)', async () => {
    const s = await register('seller', 'Leiloeiro');
    const lotId = await liveLot(s);
    const stream = await SseStream.connect(server.baseUrl, `/api/lots/${lotId}/events`, {
      cookie: 'leilao_sid=invalido',
    });
    open.push(stream);
    expect(stream.status).toBe(200);
    expect((await stream.next()).data.lot.viewer).toBeNull();
  });
});
