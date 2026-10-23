import { emptySeal } from '../../domain/hash-chain.js';
import type { Mac } from '../../domain/hash-chain.js';
import { cents } from '../../domain/money.js';
import { ForbiddenError, ValidationError } from '../errors.js';
import type { Actor, Clock, IdGenerator, LotRecord, UnitOfWork } from '../ports.js';
import { createLotSchema, parseWith } from '../validation.js';

/** Tolerancia de relogio entre navegador e servidor ao escolher "comecar agora". */
const START_SKEW_MS = 60_000;
const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export interface CreateLotCommand {
  readonly actor: Actor;
  /** Corpo cru da requisicao: a validacao mora aqui, numa unica fonte de verdade. */
  readonly input: unknown;
}

export class CreateLot {
  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; mac: Mac; ids: IdGenerator },
  ) {}

  async execute({ actor, input }: CreateLotCommand): Promise<LotRecord> {
    if (actor.role !== 'seller') {
      throw new ForbiddenError('ONLY_SELLERS_CAN_CREATE_LOTS', 'Apenas leiloeiros criam lotes.');
    }
    const data = parseWith(createLotSchema, input);
    const now = this.deps.clock.now();

    const details: Record<string, string> = {};
    if (data.startsAt.getTime() < now.getTime() - START_SKEW_MS) {
      details.startsAt = 'o inicio nao pode estar no passado';
    }
    if (data.startsAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
      details.startsAt = 'o inicio nao pode estar a mais de 1 ano';
    }
    const duration = data.endsAt.getTime() - data.startsAt.getTime();
    if (duration < MIN_DURATION_MS) details.endsAt = 'o lote precisa durar pelo menos 1 minuto';
    if (duration > MAX_DURATION_MS) details.endsAt = 'o lote pode durar no maximo 30 dias';
    if (Object.keys(details).length > 0) {
      throw new ValidationError('Janela do lote invalida.', details);
    }

    const { mac, ids } = this.deps;
    const id = ids.uuid();
    const terms = {
      lotId: id,
      sellerId: actor.id,
      startingBid: cents(data.startingBid),
      minIncrement: cents(data.minIncrement),
    };
    const lot: LotRecord = {
      id,
      sellerId: actor.id,
      title: data.item.title,
      item: data.item,
      startingBid: terms.startingBid,
      minIncrement: terms.minIncrement,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      status: 'open',
      currentAmount: null,
      leaderId: null,
      bidCount: 0,
      seal: emptySeal(mac, terms),
      extensionCount: 0,
      createdAt: now,
      closedAt: null,
      cancelledAt: null,
    };
    await this.deps.uow.run((repos) => repos.lots.insert(lot));
    return lot;
  }
}
