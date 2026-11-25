const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Resolve diretório gravável seguro (compatível com Microsoft Store MSIX, Program Files e modo portátil)
const pastaDados = process.env.POWERLIFTING_DATA_DIR || path.join(
    process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(),
    'BrasilPowerlifting'
);

try {
    if (!fs.existsSync(pastaDados)) {
        fs.mkdirSync(pastaDados, { recursive: true });
    }
} catch (erroPasta) {
    console.error('⚠️ [STORAGE] Erro ao criar pasta de dados em LOCALAPPDATA:', erroPasta.message);
}

const dbPath = path.join(pastaDados, 'campeonato.db');

// Migração automática caso exista um campeonato.db legado na pasta do script (__dirname)
try {
    const dbLegadoPath = path.join(__dirname, 'campeonato.db');
    if (!fs.existsSync(dbPath) && fs.existsSync(dbLegadoPath) && path.resolve(dbLegadoPath) !== path.resolve(dbPath)) {
        fs.copyFileSync(dbLegadoPath, dbPath);
        console.log('📦 [MIGRAÇÃO] Banco de dados existente migrado automaticamente para:', dbPath);
    }
} catch (erroMigracaoArquivo) {
    console.warn('⚠️ [MIGRAÇÃO] Aviso ao verificar banco legado:', erroMigracaoArquivo.message);
}

const db = new Database(dbPath);

// Função auxiliar para migrar bancos existentes sem perder dados
function garantirColuna(tabela, coluna, definicaoSQL) {
    try {
        const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all();
        const existe = colunas.some(c => c.name === coluna);
        if (!existe) {
            db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicaoSQL}`);
            console.log(`[MIGRAÇÃO] Coluna '${coluna}' adicionada com sucesso na tabela '${tabela}'.`);
        }
    } catch (erro) {
        console.error(`⚠️ [MIGRAÇÃO] Erro ao verificar/adicionar coluna '${coluna}' em '${tabela}':`, erro.message);
    }
}

function inicializarBanco() {
    // Controle de concorrência em tempo real
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000'); // Aguarda até 5s se dois tablets salvarem no mesmo milissegundo

    db.exec(`
        CREATE TABLE IF NOT EXISTS eventos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            data TEXT NOT NULL,
            modalidades TEXT NOT NULL,
            divisoes_idade TEXT NOT NULL,
            categorias_peso_masculino TEXT NOT NULL,
            categorias_peso_feminino TEXT NOT NULL,
            num_plataformas INTEGER DEFAULT 1,
            anilhas_calibradas BOOLEAN DEFAULT 1,
            equipamentos TEXT DEFAULT '["Raw"]',
            organizador_id TEXT DEFAULT 'LOCAL',
            nuvem_evento_id TEXT,
            sync_nuvem BOOLEAN DEFAULT 0,
            versao_sync INTEGER DEFAULT 1,
            ultimo_sync_em DATETIME,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS atletas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT NOT NULL,
            cpf TEXT,
            data_nascimento TEXT NOT NULL,
            sexo TEXT NOT NULL,
            whatsapp TEXT,
            cidade TEXT,
            estado TEXT,
            equipe TEXT DEFAULT 'Sem Equipe',
            pcd BOOLEAN DEFAULT 0,
            instagram TEXT,
            youtube TEXT,
            outros_social TEXT
        );

        CREATE TABLE IF NOT EXISTS inscricoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evento_id INTEGER NOT NULL,
            atleta_id INTEGER NOT NULL,
            modalidade_escolhida TEXT NOT NULL,
            equipamento_escolhido TEXT DEFAULT 'Raw',
            divisao_escolhida TEXT NOT NULL,
            categoria_peso_escolhida TEXT NOT NULL,
            
            -- Baterias e Plataformas separadas por movimento
            bateria_agachamento TEXT,
            bateria_supino TEXT,
            bateria_terra TEXT,
            plataforma_agachamento INTEGER DEFAULT 1,
            plataforma_supino INTEGER DEFAULT 1,
            plataforma_terra INTEGER DEFAULT 1,
            remanejado_manual BOOLEAN DEFAULT 0,
            
            peso_corporal_oficial REAL,
            numero_lote INTEGER,
            rack_agachamento TEXT,
            rack_supino TEXT,
            trava_supino TEXT,
            
            -- Controle de concorrência para múltiplos telemóveis/tablets
            versao INTEGER DEFAULT 1,
            
            FOREIGN KEY(evento_id) REFERENCES eventos(id),
            FOREIGN KEY(atleta_id) REFERENCES atletas(id)
        );

        CREATE TABLE IF NOT EXISTS tentativas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inscricao_id INTEGER NOT NULL,
            movimento TEXT NOT NULL,
            numero_tentativa INTEGER NOT NULL,
            peso_solicitado REAL NOT NULL DEFAULT 0,
            estado TEXT DEFAULT 'pendente',
            luz_esquerda INTEGER,
            luz_central INTEGER,
            luz_direita INTEGER,
            resultado_valido BOOLEAN,
            sync_nuvem BOOLEAN DEFAULT 0,
            FOREIGN KEY(inscricao_id) REFERENCES inscricoes(id)
        );

        CREATE TABLE IF NOT EXISTS log_acoes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inscricao_id INTEGER,
            acao TEXT NOT NULL,
            detalhes TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Persistência de estado das 5 plataformas (sobrevive a reinicializações do servidor)
        CREATE TABLE IF NOT EXISTS estado_plataformas (
            plataforma INTEGER PRIMARY KEY CHECK (plataforma BETWEEN 1 AND 5),
            estado_json TEXT NOT NULL,
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Configuração Local da Conta do Organizador para Sincronização / Download na Nuvem
        CREATE TABLE IF NOT EXISTS config_nuvem (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            organizador_id TEXT DEFAULT '',
            organizador_nome TEXT DEFAULT '',
            cloud_url TEXT DEFAULT '',
            cloud_token TEXT DEFAULT '',
            atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Repositório de Campeonatos na Nuvem (Permite que este mesmo servidor opere como Cloud Hub ou Cache de Nuvem)
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

        -- Cofre de Snapshots Point-in-Time (Mantém as últimas 20 versões íntegras por campeonato)
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
    `);

    // Migrações automáticas caso o arquivo campeonato.db já exista de versões anteriores
    garantirColuna('eventos', 'num_plataformas', 'INTEGER DEFAULT 1');
    garantirColuna('eventos', 'anilhas_calibradas', 'BOOLEAN DEFAULT 1');
    garantirColuna('eventos', 'equipamentos', `TEXT DEFAULT '["Raw"]'`);
    garantirColuna('eventos', 'organizador_id', `TEXT DEFAULT 'LOCAL'`);
    garantirColuna('eventos', 'nuvem_evento_id', 'TEXT');
    garantirColuna('eventos', 'sync_nuvem', 'BOOLEAN DEFAULT 0');
    garantirColuna('eventos', 'versao_sync', 'INTEGER DEFAULT 1');
    garantirColuna('eventos', 'ultimo_sync_em', 'DATETIME');
    garantirColuna('eventos', 'atualizado_em', 'DATETIME');

    garantirColuna('atletas', 'cpf', 'TEXT');
    garantirColuna('atletas', 'instagram', 'TEXT');
    garantirColuna('atletas', 'youtube', 'TEXT');
    garantirColuna('atletas', 'outros_social', 'TEXT');

    garantirColuna('inscricoes', 'equipamento_escolhido', `TEXT DEFAULT 'Raw'`);
    garantirColuna('inscricoes', 'plataforma_agachamento', 'INTEGER DEFAULT 1');
    garantirColuna('inscricoes', 'plataforma_supino', 'INTEGER DEFAULT 1');
    garantirColuna('inscricoes', 'plataforma_terra', 'INTEGER DEFAULT 1');
    garantirColuna('inscricoes', 'remanejado_manual', 'BOOLEAN DEFAULT 0');
    garantirColuna('inscricoes', 'versao', 'INTEGER DEFAULT 1');

    garantirColuna('nuvem_campeonatos', 'versao_sync', 'INTEGER DEFAULT 1');
    garantirColuna('nuvem_campeonatos', 'checksum_sha256', 'TEXT');

    // Garante registo inicial de configuração da nuvem
    db.prepare(`
        INSERT OR IGNORE INTO config_nuvem (id, organizador_id, organizador_nome, cloud_url, cloud_token)
        VALUES (1, '', '', '', '')
    `).run();

    // Limpeza preventiva de eventuais tentativas duplicadas legadas (mesma inscrição, movimento e número de tentativa)
    try {
        db.exec(`
            DELETE FROM tentativas
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM tentativas
                GROUP BY inscricao_id, movimento, numero_tentativa
            );
        `);
    } catch (e) {
        console.error("⚠️ [AUTO-HEAL] Aviso ao verificar duplicidades em tentativas:", e.message);
    }

    // Índices de alta performance + Índice Único para impedir criação duplicada de tentativas sob concorrência
    db.exec(`
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
    `);

    // Inicializa os registos das 5 plataformas caso ainda não existam
    const stmtInitPlat = db.prepare(`
        INSERT OR IGNORE INTO estado_plataformas (plataforma, estado_json)
        VALUES (?, ?)
    `);
    for (let p = 1; p <= 5; p++) {
        const estadoInicial = JSON.stringify({
            plataforma: p,
            evento_id: null,
            movimento: null,
            bateria: null,
            atletaAtual: null,
            luzes: { esquerda: null, central: null, direita: null },
            resultado: null,
            modo_arbitro: 3,
            preVotoManualMesa: false
        });
        stmtInitPlat.run(p, estadoInicial);
    }

    console.log(`Banco de dados SQLite inicializado e blindado com sucesso em: ${dbPath}`);
}

// ============================================================================
// SISTEMA DE BACKUP EM ANEL + SNAPSHOT PRÉ-AÇÃO DESTRUTIVA
// ============================================================================

let filaBackupPromise = Promise.resolve();
let backupRotativoEmAndamento = false;
let ultimoBackupSlotTimestamp = 0;
let indiceSlotRotativo = 0;
let indiceSnapshotPreAcao = 0;

function garantirPastaBackup() {
    const pastaBackup = path.join(pastaDados, 'backups');
    if (!fs.existsSync(pastaBackup)) {
        fs.mkdirSync(pastaBackup, { recursive: true });
    }
    return pastaBackup;
}

// Proteção contra bloqueio temporário de ficheiro pelo Windows Defender / Search Indexer (EPERM / EACCES)
function substituirArquivoComSeguranca(arquivoTmp, arquivoDestino) {
    try {
        fs.renameSync(arquivoTmp, arquivoDestino);
    } catch (erroRename) {
        try {
            fs.copyFileSync(arquivoTmp, arquivoDestino);
            fs.unlinkSync(arquivoTmp);
        } catch (erroCopy) {
            throw erroRename;
        }
    }
}

function realizarBackupAutomatico() {
    if (backupRotativoEmAndamento) return filaBackupPromise;
    backupRotativoEmAndamento = true;

    filaBackupPromise = filaBackupPromise.then(async () => {
        try {
            const pastaBackup = garantirPastaBackup();
            const arquivoRecente = path.join(pastaBackup, 'campeonato_backup_recente.db');
            const arquivoRecenteTmp = path.join(pastaBackup, 'campeonato_backup_recente.db.tmp');

            // Grava em ficheiro temporário e substitui atomicamente (imune a queda de energia e antivírus)
            await db.backup(arquivoRecenteTmp);
            substituirArquivoComSeguranca(arquivoRecenteTmp, arquivoRecente);

            // A cada 5 minutos (300.000 ms), grava também num dos 10 slots rotativos (50 min de histórico seguro)
            const agora = Date.now();
            if (agora - ultimoBackupSlotTimestamp >= 300000) {
                const arquivoSlot = path.join(pastaBackup, `campeonato_slot_${indiceSlotRotativo}.db`);
                const arquivoSlotTmp = `${arquivoSlot}.tmp`;
                await db.backup(arquivoSlotTmp);
                substituirArquivoComSeguranca(arquivoSlotTmp, arquivoSlot);
                indiceSlotRotativo = (indiceSlotRotativo + 1) % 10;
                ultimoBackupSlotTimestamp = agora;
            }
        } catch (erro) {
            console.error("⚠️ [BACKUP] Aviso ao gerar cópia de segurança:", erro.message);
        } finally {
            backupRotativoEmAndamento = false;
        }
    });

    return filaBackupPromise;
}

function criarSnapshotSeguranca(motivo = 'acao') {
    filaBackupPromise = filaBackupPromise.then(async () => {
        try {
            const pastaBackup = garantirPastaBackup();
            const sufixoLimpo = String(motivo).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'acao';
            const arquivoPreAcao = path.join(pastaBackup, `campeonato_pre_${sufixoLimpo}_${indiceSnapshotPreAcao}.db`);
            const arquivoPreAcaoTmp = `${arquivoPreAcao}.tmp`;
            await db.backup(arquivoPreAcaoTmp);
            substituirArquivoComSeguranca(arquivoPreAcaoTmp, arquivoPreAcao);
            indiceSnapshotPreAcao = (indiceSnapshotPreAcao + 1) % 5;
        } catch (erro) {
            console.error("⚠️ [SNAPSHOT] Aviso ao gerar snapshot pré-ação:", erro.message);
        }
    });

    return filaBackupPromise;
}

function fecharBancoComSeguranca() {
    try {
        if (db && db.open) {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            console.log("🔒 [SQLITE] Checkpoint WAL concluído e banco fechado com segurança.");
        }
    } catch (erro) {
        console.error("⚠️ [SQLITE] Aviso ao fechar banco:", erro.message);
    }
}

module.exports = {
    db,
    pastaDados,
    garantirPastaBackup,
    inicializarBanco,
    realizarBackupAutomatico,
    criarSnapshotSeguranca,
    fecharBancoComSeguranca
};