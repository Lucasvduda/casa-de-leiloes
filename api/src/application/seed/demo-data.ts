import type { Actor, Clock, ItemSnapshot, UnitOfWork } from '../ports.js';
import type { AuctionQueries } from '../usecases/auction-queries.js';
import type { AuthService } from '../usecases/auth.js';
import type { CreateLot } from '../usecases/create-lot.js';
import type { Deposit } from '../usecases/deposit.js';
import type { PlaceBid } from '../usecases/place-bid.js';
import type { SettleLot } from '../usecases/settle-lot.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const reais = (value: number): number => value * 100;

/** Contas de demonstracao. Publicas de proposito (README): quem avalia precisa conseguir entrar. */
export const DEMO_ACCOUNTS = {
  seller: { email: 'leiloeiro@demo.leilao', displayName: 'Casa Demo Leiloeiro', role: 'seller' },
  ana: { email: 'ana@demo.leilao', displayName: 'Ana Licitante', role: 'bidder' },
  bruno: { email: 'bruno@demo.leilao', displayName: 'Bruno Licitante', role: 'bidder' },
} as const;

type Bidder = 'ana' | 'bruno';

interface LotTemplate {
  readonly key: string;
  readonly itemIndex: number;
  /** Instantes relativos ao momento do seed (negativo = passado). */
  readonly startsAtOffsetMs: number;
  readonly endsAtOffsetMs: number;
  readonly startingBid: number;
  readonly minIncrement: number;
  readonly bids: readonly {
    readonly by: Bidder;
    readonly amount: number;
    readonly atOffsetMs: number;
  }[];
}

/**
 * Cobre todos os estados que a avaliacao precisa ver: ao vivo com lances (Ana lidera), ao vivo
 * com Ana superada, ao vivo sem lances, agendado, encerrado com vencedor e encerrado sem vencedor.
 * Os lotes ao vivo duram semanas (o seed roda uma vez), salvo um que fecha em poucas horas para
 * mostrar a contagem regressiva e o anti-sniping.
 */
const TEMPLATES: readonly LotTemplate[] = [
  {
    key: 'ao-vivo-ana-lidera',
    itemIndex: 0,
    startsAtOffsetMs: -3 * HOUR,
    endsAtOffsetMs: 26 * DAY,
    startingBid: reais(1_500),
    minIncrement: reais(100),
    bids: [
      { by: 'ana', amount: reais(1_500), atOffsetMs: -170 * MIN },
      { by: 'bruno', amount: reais(1_600), atOffsetMs: -150 * MIN },
      { by: 'ana', amount: reais(1_800), atOffsetMs: -90 * MIN },
      { by: 'bruno', amount: reais(2_000), atOffsetMs: -40 * MIN },
      { by: 'ana', amount: reais(2_200), atOffsetMs: -12 * MIN },
    ],
  },
  {
    key: 'ao-vivo-fecha-logo',
    itemIndex: 1,
    startsAtOffsetMs: -1 * DAY,
    endsAtOffsetMs: 3 * HOUR,
    startingBid: reais(800),
    minIncrement: reais(50),
    bids: [
      { by: 'bruno', amount: reais(800), atOffsetMs: -20 * HOUR },
      { by: 'ana', amount: reais(850), atOffsetMs: -6 * HOUR },
      { by: 'bruno', amount: reais(950), atOffsetMs: -1 * HOUR },
    ],
  },
  {
    key: 'ao-vivo-sem-lances',
    itemIndex: 2,
    startsAtOffsetMs: -1 * HOUR,
    endsAtOffsetMs: 20 * DAY,
    startingBid: reais(2_500),
    minIncrement: reais(250),
    bids: [],
  },
  {
    key: 'agendado',
    itemIndex: 3,
    startsAtOffsetMs: 2 * DAY,
    endsAtOffsetMs: 9 * DAY,
    startingBid: reais(1_200),
    minIncrement: reais(100),
    bids: [],
  },
  {
    key: 'encerrado-vendido',
    itemIndex: 4,
    startsAtOffsetMs: -5 * DAY,
    endsAtOffsetMs: -4 * DAY,
    startingBid: reais(3_000),
    minIncrement: reais(200),
    bids: [
      { by: 'ana', amount: reais(3_000), atOffsetMs: -4.8 * DAY },
      { by: 'bruno', amount: reais(3_200), atOffsetMs: -4.5 * DAY },
      { by: 'ana', amount: reais(3_500), atOffsetMs: -4.2 * DAY },
    ],
  },
  {
    key: 'encerrado-sem-vencedor',
    itemIndex: 5,
    startsAtOffsetMs: -3 * DAY,
    endsAtOffsetMs: -2 * DAY,
    startingBid: reais(1_000),
    minIncrement: reais(100),
    bids: [],
  },
];

/** Cada operacao do seed usa uma chave fixa: repetir o seed nunca duplica deposito nem lance. */
const KEY_VERSION = 'seed-v1';
const DEPOSIT_CENTS = reais(60_000);

/** Relogio controlavel: permite gravar o historico de lotes que "ja aconteceram" pelos casos de uso reais. */
class SeedClock implements Clock {
  private current = Date.now();
  set(ms: number): void {
    this.current = ms;
  }
  now(): Date {
    return new Date(this.current);
  }
}

export interface DemoDataDeps {
  readonly auth: Pick<AuthService, 'register'>;
  readonly deposit: Pick<Deposit, 'execute'>;
  readonly queries: Pick<AuctionQueries, 'myLots'>;
  readonly settle: Pick<SettleLot, 'execute'>;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  /** Casos de uso de escrita ligados a um relogio informado (o seed grava no passado). */
  readonly writers: (clock: Clock) => { createLot: CreateLot; placeBid: PlaceBid };
  /** Obras usadas nos lotes (catalogo offline embutido: o seed nunca depende de rede). */
  readonly items: readonly ItemSnapshot[];
  readonly password: string;
  readonly logger: { info(data: Record<string, unknown>, message: string): void };
}

export interface DemoDataSummary {
  readonly usersCreated: number;
  readonly lotsCreated: number;
  readonly bidsPlaced: number;
}

/**
 * Garante os dados de demonstracao. Idempotente e retomavel: cada passo verifica o que ja existe
 * (conta por e-mail, lote por titulo do leiloeiro, deposito e lances por Idempotency-Key), entao
 * rodar duas vezes, ou depois de uma queda no meio, converge para o mesmo estado.
 * O chamador deve serializar execucoes concorrentes (advisory lock).
 */
export async function ensureDemoData(deps: DemoDataDeps): Promise<DemoDataSummary> {
  if (deps.items.length < TEMPLATES.length) {
    throw new Error('Catalogo offline com poucas obras para o seed de demonstracao.');
  }
  const titles = TEMPLATES.map((t) => deps.items[t.itemIndex]?.title);
  if (new Set(titles).size !== titles.length || titles.includes(undefined)) {
    throw new Error('As obras do seed precisam existir e ter titulos distintos.');
  }

  const startedAt = deps.clock.now().getTime();
  let usersCreated = 0;
  let lotsCreated = 0;
  let bidsPlaced = 0;

  const actors = new Map<keyof typeof DEMO_ACCOUNTS, Actor>();
  for (const [name, account] of Object.entries(DEMO_ACCOUNTS) as [
    keyof typeof DEMO_ACCOUNTS,
    (typeof DEMO_ACCOUNTS)[keyof typeof DEMO_ACCOUNTS],
  ][]) {
    const found = await deps.uow.readSnapshot((repos) => repos.users.findByEmail(account.email));
    if (found !== null) {
      if (found.role !== account.role) {
        throw new Error(
          `A conta ${account.email} existe com outro papel; recuse o seed em vez de adivinhar.`,
        );
      }
      actors.set(name, { id: found.id, role: found.role });
      continue;
    }
    const registered = await deps.auth.register({ ...account, password: deps.password });
    actors.set(name, { id: registered.user.id, role: registered.user.role });
    usersCreated += 1;
  }
  const seller = actors.get('seller')!;

  for (const name of ['ana', 'bruno'] as const) {
    await deps.deposit.execute(actors.get(name)!, {
      amount: DEPOSIT_CENTS,
      idempotencyKey: `${KEY_VERSION}:deposit:${name}`,
    });
  }

  const clock = new SeedClock();
  const writers = deps.writers(clock);
  const existing = await existingLotsByTitle(deps, seller);

  for (const template of TEMPLATES) {
    const item = deps.items[template.itemIndex]!;
    const startsAt = startedAt + template.startsAtOffsetMs;
    let lotId = existing.get(item.title);
    const isNew = lotId === undefined;

    if (lotId === undefined) {
      // Grava "no passado" quando o lote ja comecou; agendados (inicio futuro) gravam agora.
      clock.set(Math.min(startsAt, startedAt));
      const lot = await writers.createLot.execute({
        actor: seller,
        input: {
          item,
          startingBid: template.startingBid,
          minIncrement: template.minIncrement,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(startedAt + template.endsAtOffsetMs).toISOString(),
        },
      });
      lotId = lot.id;
      lotsCreated += 1;
    }

    for (const [index, bid] of template.bids.entries()) {
      clock.set(startedAt + bid.atOffsetMs);
      const result = await writers.placeBid.execute({
        actor: actors.get(bid.by)!,
        lotId,
        amount: bid.amount,
        idempotencyKey: `${KEY_VERSION}:${template.key}:${index + 1}`,
      });
      if (!result.accepted) {
        // Em lote novo isso e bug do seed. Em lote antigo e o fim natural (ja encerrou): nao e erro.
        if (isNew) {
          throw new Error(`Seed: lance ${template.key}#${index + 1} recusado (${result.reason}).`);
        }
        break;
      }
      if (!result.replayed) bidsPlaced += 1;
    }

    // Lotes que ja passaram do fim: liquida agora (idempotente; o agendador faria o mesmo).
    if (template.endsAtOffsetMs < 0) await deps.settle.execute(lotId);
  }

  deps.logger.info({ usersCreated, lotsCreated, bidsPlaced }, 'demo_data_ensured');
  return { usersCreated, lotsCreated, bidsPlaced };
}

/** Percorre todas as paginas do painel do leiloeiro (nao confia em busca por texto, limitada a 100 caracteres). */
async function existingLotsByTitle(
  deps: DemoDataDeps,
  seller: Actor,
): Promise<Map<string, string>> {
  const byTitle = new Map<string, string>();
  const MAX_PAGES = 40;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await deps.queries.myLots(seller, { phase: 'all', page, pageSize: 50 });
    for (const lot of result.items) byTitle.set(lot.title, lot.id);
    if (page >= result.totalPages) break;
  }
  return byTitle;
}
