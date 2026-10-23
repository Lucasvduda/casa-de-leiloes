-- Sessoes de login. O token que vai no cookie NUNCA e gravado: guardamos so o SHA-256 dele.
-- Quem ler esta tabela (backup vazado, SQL injection) nao consegue forjar um cookie valido.
CREATE TABLE sessions (
  id_hash    text PRIMARY KEY CHECK (char_length(id_hash) = 64),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Token anti-CSRF, devolvido ao cliente no login e exigido no cabecalho de toda escrita.
  csrf_token text NOT NULL CHECK (char_length(csrf_token) >= 16),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
