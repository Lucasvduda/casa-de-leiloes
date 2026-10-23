-- Schema inicial da Casa de Leiloes.
-- Dinheiro: sempre BIGINT em centavos.
-- Timestamps: timestamptz(3) (milissegundos) para o instante do lance ir e voltar identico ao que
-- entrou no hash da cadeia (o JS so tem precisao de ms).

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('seller', 'bidder')),
  created_at    timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Saldo. As CHECKs sao a ultima barreira: mesmo um bug de aplicacao nao consegue
-- comprometer mais do que existe nem deixar saldo negativo.
CREATE TABLE wallets (
  user_id         uuid PRIMARY KEY REFERENCES users (id),
  total_cents     bigint NOT NULL DEFAULT 0,
  committed_cents bigint NOT NULL DEFAULT 0,
  CONSTRAINT wallets_non_negative CHECK (total_cents >= 0 AND committed_cents >= 0),
  CONSTRAINT wallets_committed_within_total CHECK (committed_cents <= total_cents)
);

CREATE TABLE lots (
  id                   uuid PRIMARY KEY,
  seller_id            uuid NOT NULL REFERENCES users (id),
  title                text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  item                 jsonb NOT NULL,
  starting_bid_cents   bigint NOT NULL CHECK (starting_bid_cents > 0),
  min_increment_cents  bigint NOT NULL CHECK (min_increment_cents > 0),
  starts_at            timestamptz(3) NOT NULL,
  ends_at              timestamptz(3) NOT NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  current_amount_cents bigint CHECK (current_amount_cents IS NULL OR current_amount_cents > 0),
  leader_id            uuid REFERENCES users (id),
  bid_count            integer NOT NULL DEFAULT 0 CHECK (bid_count >= 0),
  -- Selo da cadeia de hash (ver domain/hash-chain.ts).
  head_seq             integer NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  head_hash            text NOT NULL,
  seal                 text NOT NULL,
  extension_count      integer NOT NULL DEFAULT 0 CHECK (extension_count >= 0),
  created_at           timestamptz(3) NOT NULL DEFAULT now(),
  closed_at            timestamptz(3),
  cancelled_at         timestamptz(3),
  CONSTRAINT lots_window CHECK (ends_at > starts_at),
  CONSTRAINT lots_leader_consistent CHECK ((leader_id IS NULL) = (current_amount_cents IS NULL)),
  CONSTRAINT lots_bid_count_consistent CHECK ((bid_count = 0) = (leader_id IS NULL))
);
CREATE INDEX lots_status_starts_idx ON lots (status, starts_at);
CREATE INDEX lots_status_ends_idx ON lots (status, ends_at);
CREATE INDEX lots_seller_idx ON lots (seller_id, created_at DESC);

CREATE TABLE bids (
  id              uuid PRIMARY KEY,
  lot_id          uuid NOT NULL REFERENCES lots (id),
  seq             integer NOT NULL CHECK (seq >= 1),
  bidder_id       uuid NOT NULL REFERENCES users (id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  placed_at       timestamptz(3) NOT NULL,
  prev_hash       text NOT NULL,
  hash            text NOT NULL,
  idempotency_key text,
  CONSTRAINT bids_lot_seq_key UNIQUE (lot_id, seq)
);
CREATE UNIQUE INDEX bids_idempotency_key ON bids (bidder_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX bids_bidder_idx ON bids (bidder_id, lot_id);

-- Extrato da carteira: so insercao. Cada linha guarda o saldo resultante.
CREATE TABLE wallet_ledger (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users (id),
  kind                  text NOT NULL
    CHECK (kind IN ('deposit', 'hold', 'release', 'settle_debit', 'settle_credit')),
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  total_after_cents     bigint NOT NULL CHECK (total_after_cents >= 0),
  committed_after_cents bigint NOT NULL CHECK (committed_after_cents >= 0),
  lot_id                uuid REFERENCES lots (id),
  bid_id                uuid REFERENCES bids (id),
  idempotency_key       text,
  created_at            timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallet_ledger_idempotency_key ON wallet_ledger (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger (user_id, id DESC);
CREATE INDEX wallet_ledger_lot_idx ON wallet_ledger (lot_id) WHERE lot_id IS NOT NULL;

-- Comprovante de arremate (um por lote), assinado com HMAC (ver domain/receipt.ts).
CREATE TABLE receipts (
  code            text PRIMARY KEY,
  lot_id          uuid NOT NULL UNIQUE REFERENCES lots (id),
  winner_id       uuid NOT NULL REFERENCES users (id),
  seller_id       uuid NOT NULL REFERENCES users (id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  bid_count       integer NOT NULL CHECK (bid_count > 0),
  final_head_hash text NOT NULL,
  issued_at       timestamptz(3) NOT NULL,
  signature       text NOT NULL
);
CREATE INDEX receipts_winner_idx ON receipts (winner_id, issued_at DESC);
CREATE INDEX receipts_seller_idx ON receipts (seller_id, issued_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Defesa em profundidade (NAO e a garantia de integridade; a garantia e a cadeia de HMAC).
-- Estes triggers impedem adulteracao acidental ou casual. Quem tem superusuario pode desliga-los,
-- e e exatamente nesse caso que a auditoria por HMAC detecta a alteracao.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a tabela % e somente de insercao (operacao % bloqueada)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER bids_append_only BEFORE UPDATE OR DELETE ON bids
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bids_no_truncate BEFORE TRUNCATE ON bids
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER wallet_ledger_append_only BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER wallet_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER receipts_append_only BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Termos do lote sao imutaveis (entram no genesis da cadeia); o fim so pode crescer; um lote
-- encerrado ou cancelado nao muda mais de estado.
CREATE FUNCTION lots_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.item IS DISTINCT FROM OLD.item
     OR NEW.starting_bid_cents IS DISTINCT FROM OLD.starting_bid_cents
     OR NEW.min_increment_cents IS DISTINCT FROM OLD.min_increment_cents
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'termos imutaveis do lote nao podem ser alterados'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.ends_at < OLD.ends_at THEN
    RAISE EXCEPTION 'o fim do lote nao pode diminuir'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'lote % nao pode mudar de estado', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'open' AND (NEW.bid_count IS DISTINCT FROM OLD.bid_count
     OR NEW.head_hash IS DISTINCT FROM OLD.head_hash) THEN
    RAISE EXCEPTION 'lote % nao aceita novos lances', OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lots_guard BEFORE UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION lots_guard_update();
CREATE TRIGGER lots_no_delete BEFORE DELETE ON lots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
