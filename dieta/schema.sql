-- Esquema D1 do mcp-dieta (rascunho da especificação).
-- Datas de vigência: texto ISO 8601 em UTC, ex. '2026-11-13T16:00:00Z'.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Metas (com vigência). Uma linha vigente por vez.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS metas (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vigente_de      TEXT    NOT NULL,
  vigente_ate     TEXT,                       -- NULL = vigente
  calorias_kcal   REAL    NOT NULL,
  proteina_g      REAL    NOT NULL,
  -- Distribuição de macros em % das calorias (opcional; se informada, soma 100)
  pct_proteina    REAL,
  pct_carboidrato REAL,
  pct_gordura     REAL,
  observacoes     TEXT,
  CHECK (vigente_ate IS NULL OR vigente_ate > vigente_de),
  CHECK ((pct_proteina IS NULL AND pct_carboidrato IS NULL AND pct_gordura IS NULL)
         OR (pct_proteina IS NOT NULL AND pct_carboidrato IS NOT NULL AND pct_gordura IS NOT NULL
             AND ABS(pct_proteina + pct_carboidrato + pct_gordura - 100) < 0.5))
);

-- Garante no máximo uma linha vigente (todas as linhas do índice parcial valem 1)
CREATE UNIQUE INDEX IF NOT EXISTS ux_metas_atual
  ON metas ((vigente_ate IS NULL)) WHERE vigente_ate IS NULL;

CREATE VIEW IF NOT EXISTS metas_atual AS
  SELECT * FROM metas WHERE vigente_ate IS NULL;

-- ---------------------------------------------------------------------------
-- Plano: refeições principais e alternativas (com vigência).
-- refeicao_uid identifica a refeição ao longo das versões.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plano_refeicao (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  refeicao_uid    TEXT    NOT NULL,
  vigente_de      TEXT    NOT NULL,
  vigente_ate     TEXT,                       -- NULL = vigente
  slot            TEXT    NOT NULL,           -- cafe, lanche_manha, almoco, lanche_tarde, jantar, ceia
  tipo            TEXT    NOT NULL DEFAULT 'principal' CHECK (tipo IN ('principal', 'alternativa')),
  ordem           INTEGER NOT NULL DEFAULT 0,
  nome            TEXT    NOT NULL,
  horario         TEXT,                       -- 'HH:MM', opcional
  -- Total da refeição. Com itens, a API grava a soma dos itens.
  kcal            REAL    NOT NULL,
  proteina_g      REAL    NOT NULL,
  carboidrato_g   REAL    NOT NULL,
  gordura_g       REAL    NOT NULL,
  fibra_g         REAL,
  observacoes     TEXT,
  CHECK (vigente_ate IS NULL OR vigente_ate > vigente_de)
);

-- Uma versão vigente por refeição
CREATE UNIQUE INDEX IF NOT EXISTS ux_plano_refeicao_atual
  ON plano_refeicao (refeicao_uid) WHERE vigente_ate IS NULL;

CREATE INDEX IF NOT EXISTS ix_plano_refeicao_uid ON plano_refeicao (refeicao_uid, vigente_de);

CREATE VIEW IF NOT EXISTS plano_refeicao_atual AS
  SELECT * FROM plano_refeicao WHERE vigente_ate IS NULL;

-- ---------------------------------------------------------------------------
-- Itens da refeição (opcionais). Presos à versão da refeição: alterar um item
-- cria uma nova versão da refeição e copia os itens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plano_item (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  refeicao_id     INTEGER NOT NULL REFERENCES plano_refeicao (id),
  ordem           INTEGER NOT NULL DEFAULT 0,
  descricao       TEXT    NOT NULL,           -- ex.: 'hambúrguer de patinho'
  quantidade      REAL,                       -- ex.: 150
  unidade         TEXT,                       -- ex.: 'g', 'un', 'fatia'
  kcal            REAL    NOT NULL,
  proteina_g      REAL    NOT NULL,
  carboidrato_g   REAL    NOT NULL,
  gordura_g       REAL    NOT NULL,
  fibra_g         REAL,
  -- Origem do cálculo (opcional, só para rastreio)
  origem_fonte    TEXT,
  origem_codigo   TEXT,
  origem_gramas   REAL
);

CREATE INDEX IF NOT EXISTS ix_plano_item_refeicao ON plano_item (refeicao_id, ordem);

-- ---------------------------------------------------------------------------
-- Tabelas nutricionais (sem histórico). Valores por 100 g.
-- A carga de uma fonte apaga e regrava só as linhas dessa fonte.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alimento (
  fonte            TEXT NOT NULL,             -- 'TACO', 'USDA-FND', 'USDA-SR', 'IBGE', 'TBCA', 'OFF'
  codigo           TEXT NOT NULL,             -- código dentro da fonte (OFF: código de barras)
  nome             TEXT NOT NULL,
  grupo            TEXT,
  kcal_100g        REAL,
  proteina_100g    REAL,
  carboidrato_100g REAL,
  gordura_100g     REAL,
  fibra_100g       REAL,
  nutrientes_json  TEXT,                      -- demais nutrientes, se a fonte tiver
  atualizado_em    TEXT NOT NULL,
  PRIMARY KEY (fonte, codigo)
);

CREATE INDEX IF NOT EXISTS ix_alimento_fonte ON alimento (fonte);

-- Busca por nome. A tabela tem rowid implícito, usado como content_rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS alimento_fts USING fts5 (
  nome,
  content = 'alimento',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS alimento_ai AFTER INSERT ON alimento BEGIN
  INSERT INTO alimento_fts (rowid, nome) VALUES (new.rowid, new.nome);
END;

CREATE TRIGGER IF NOT EXISTS alimento_ad AFTER DELETE ON alimento BEGIN
  INSERT INTO alimento_fts (alimento_fts, rowid, nome) VALUES ('delete', old.rowid, old.nome);
END;

CREATE TRIGGER IF NOT EXISTS alimento_au AFTER UPDATE ON alimento BEGIN
  INSERT INTO alimento_fts (alimento_fts, rowid, nome) VALUES ('delete', old.rowid, old.nome);
  INSERT INTO alimento_fts (rowid, nome) VALUES (new.rowid, new.nome);
END;

-- ---------------------------------------------------------------------------
-- Medições da balança. A data/hora da medição é a chave; reimportar o mesmo
-- CSV atualiza as linhas (INSERT ... ON CONFLICT (data_hora) DO UPDATE).
-- Colunas ajustadas quando o formato do CSV for conhecido.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medicao (
  data_hora         TEXT PRIMARY KEY,         -- ISO 8601 em UTC
  peso_kg           REAL,
  gordura_pct       REAL,
  massa_magra_kg    REAL,
  massa_muscular_kg REAL,
  agua_pct          REAL,
  massa_ossea_kg    REAL,
  gordura_visceral  REAL,
  imc               REAL,
  tmb_kcal          REAL,
  dados_json        TEXT,                     -- colunas do CSV sem coluna própria
  importado_em      TEXT NOT NULL
);
