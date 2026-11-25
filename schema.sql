-- ============================================================================
-- SCHEMA OFICIAL
-- ============================================================================

-- 1. Eventos (Configurações, Regras do Campeonato e Vínculo com Organizador/Nuvem)
CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    data TEXT NOT NULL,
    modalidades TEXT NOT NULL,               -- JSON: ["Full Power", "Push-Pull", "Supino Solo", ...]
    divisoes_idade TEXT NOT NULL,            -- JSON: ["Sub-Júnior", "Júnior", "Open", "Master 1", ...]
    categorias_peso_masculino TEXT NOT NULL, -- JSON: ["-52", "-56", ..., "+140"]
    categorias_peso_feminino TEXT NOT NULL,  -- JSON: ["-44", "-48", ..., "+90"]
    num_plataformas INTEGER DEFAULT 1,       -- De 1 a 5 plataformas simultâneas
    anilhas_calibradas BOOLEAN DEFAULT 1,    -- 1 = Calibradas (IPF/Powerlifting), 0 = Padrão Academia
    equipamentos TEXT DEFAULT '["Raw"]',     -- JSON: ["Raw", "Equipado", "Wraps", ...]
    organizador_id TEXT DEFAULT 'LOCAL',     -- Identificador do Organizador na Nuvem
    nuvem_evento_id TEXT,                    -- UUID/ID único do campeonato na Nuvem
    sync_nuvem BOOLEAN DEFAULT 0,            -- 0 = Mudanças locais pendentes de envio p/ Nuvem, 1 = Sincronizado
    versao_sync INTEGER DEFAULT 1,           -- Contador monotônico anti-condição de corrida durante upload
    ultimo_sync_em DATETIME,                 -- Timestamp da última confirmação de envio à Nuvem
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Atletas (Dados Pessoais, CPF Único Opcional e Redes Sociais)
CREATE TABLE IF NOT EXISTS atletas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT,                                -- Opcional (apenas números, permite rastrear o atleta entre eventos)
    data_nascimento TEXT NOT NULL,           -- Formato YYYY-MM-DD
    sexo TEXT NOT NULL,                      -- 'M' ou 'F'
    whatsapp TEXT,
    cidade TEXT,
    estado TEXT,
    equipe TEXT DEFAULT 'Sem Equipe',
    pcd BOOLEAN DEFAULT 0,
    instagram TEXT,                          -- Opcional: @usuario
    youtube TEXT,                            -- Opcional: @canal ou link
    outros_social TEXT                       -- Opcional: TikTok, site ou outra rede
);

-- 3. Inscrições e Pesagem (Vínculo único por atleta/modalidade no evento)
CREATE TABLE IF NOT EXISTS inscricoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL,
    atleta_id INTEGER NOT NULL,
    modalidade_escolhida TEXT NOT NULL,
    equipamento_escolhido TEXT DEFAULT 'Raw',
    divisao_escolhida TEXT NOT NULL,         -- String ou JSON Array: '["Open", "Master 1"]'
    categoria_peso_escolhida TEXT NOT NULL,
    
    -- Baterias e Plataformas separadas por movimento
    bateria_agachamento TEXT,
    bateria_supino TEXT,
    bateria_terra TEXT,
    plataforma_agachamento INTEGER DEFAULT 1,
    plataforma_supino INTEGER DEFAULT 1,
    plataforma_terra INTEGER DEFAULT 1,
    remanejado_manual BOOLEAN DEFAULT 0,     -- 1 = Atleta movido individualmente ou em bateria avulsa
    
    -- Dados preenchidos na Pesagem
    peso_corporal_oficial REAL,
    numero_lote INTEGER,
    rack_agachamento TEXT,
    rack_supino TEXT,
    trava_supino TEXT,
    
    -- Controle de concorrência otimista (evita conflitos entre múltiplos celulares)
    versao INTEGER DEFAULT 1,
    
    FOREIGN KEY(evento_id) REFERENCES eventos(id),
    FOREIGN KEY(atleta_id) REFERENCES atletas(id)
);

-- 4. Tentativas (Controle da Fila, Julgamento dos Árbitros e Rodadas Extras/PR)
CREATE TABLE IF NOT EXISTS tentativas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inscricao_id INTEGER NOT NULL,
    movimento TEXT NOT NULL,                 -- 'agachamento', 'supino', 'terra'
    numero_tentativa INTEGER NOT NULL,       -- 1, 2, 3 (ou 4+ para Bateria Avulsa / PR / Desempate)
    peso_solicitado REAL NOT NULL DEFAULT 0, -- Carga solicitada em kg
    estado TEXT DEFAULT 'pendente',          -- 'pendente', 'aguardando_pedida', 'concluido'
    luz_esquerda INTEGER,                    -- 1 = Branca, 0 = Vermelha, NULL = Não julgado
    luz_central INTEGER,
    luz_direita INTEGER,
    resultado_valido BOOLEAN,                -- 1 = Válido (2+ brancas), 0 = Inválido
    sync_nuvem BOOLEAN DEFAULT 0,
    FOREIGN KEY(inscricao_id) REFERENCES inscricoes(id)
);

-- 5. Auditoria e Logs de Segurança
CREATE TABLE IF NOT EXISTS log_acoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inscricao_id INTEGER,
    acao TEXT NOT NULL,
    detalhes TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. Estado em Tempo Real por Plataforma (1 a 5)
CREATE TABLE IF NOT EXISTS estado_plataformas (
    plataforma INTEGER PRIMARY KEY CHECK (plataforma BETWEEN 1 AND 5),
    estado_json TEXT NOT NULL,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. Configuração Local do Organizador e Repositório de Nuvem (Suporta Nuvem Remota e Hub Cloud)
CREATE TABLE IF NOT EXISTS config_nuvem (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    organizador_id TEXT DEFAULT '',
    organizador_nome TEXT DEFAULT '',
    cloud_url TEXT DEFAULT '',
    cloud_token TEXT DEFAULT '',
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nuvem_campeonatos (
    nuvem_id TEXT PRIMARY KEY,
    organizador_id TEXT NOT NULL,
    nome_evento TEXT NOT NULL,
    data_evento TEXT NOT NULL,
    qtd_atletas INTEGER DEFAULT 0,
    versao_sync INTEGER DEFAULT 1,
    checksum_sha256 TEXT,
    payload_json TEXT NOT NULL,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8. Cofre de Snapshots Point-in-Time (Últimas 20 versões íntegras por campeonato)
CREATE TABLE IF NOT EXISTS nuvem_snapshots_historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nuvem_id TEXT NOT NULL,
    organizador_id TEXT NOT NULL,
    versao_sync INTEGER DEFAULT 1,
    qtd_atletas INTEGER DEFAULT 0,
    checksum_sha256 TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9. Índices de Performance e Unicidade
CREATE INDEX IF NOT EXISTS idx_inscricoes_evento ON inscricoes(evento_id);
CREATE INDEX IF NOT EXISTS idx_inscricoes_atleta ON inscricoes(atleta_id);
CREATE INDEX IF NOT EXISTS idx_atletas_cpf ON atletas(cpf);
CREATE INDEX IF NOT EXISTS idx_eventos_organizador ON eventos(organizador_id);
CREATE INDEX IF NOT EXISTS idx_eventos_nuvem_id ON eventos(nuvem_evento_id);
CREATE INDEX IF NOT EXISTS idx_eventos_sync ON eventos(sync_nuvem);
CREATE INDEX IF NOT EXISTS idx_nuvem_org ON nuvem_campeonatos(organizador_id);
CREATE INDEX IF NOT EXISTS idx_nuvem_hist_id ON nuvem_snapshots_historico(nuvem_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tentativas_inscricao_mov ON tentativas(inscricao_id, movimento, numero_tentativa);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tentativas_unico_mov ON tentativas(inscricao_id, movimento, numero_tentativa);
CREATE INDEX IF NOT EXISTS idx_tentativas_estado ON tentativas(estado);
CREATE INDEX IF NOT EXISTS idx_tentativas_sync ON tentativas(sync_nuvem);