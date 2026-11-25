const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
    inicializarBanco,
    db,
    pastaDados,
    realizarBackupAutomatico,
    criarSnapshotSeguranca,
    fecharBancoComSeguranca
} = require('./database');

// 1. Inicializa e Migra o Banco de Dados Automaticamente
inicializarBanco();

// Auto-migração complementar para preservar metadados de inscrições vindas da Web (LGPD e Origem)
try {
    const colsInsc = db.prepare('PRAGMA table_info(inscricoes)').all();
    if (!colsInsc.some(c => c.name === 'anonimizar_historico')) {
        db.exec('ALTER TABLE inscricoes ADD COLUMN anonimizar_historico BOOLEAN DEFAULT 0');
    }
    if (!colsInsc.some(c => c.name === 'origem_inscricao')) {
        db.exec("ALTER TABLE inscricoes ADD COLUMN origem_inscricao TEXT DEFAULT 'APP'");
    }
    if (!colsInsc.some(c => c.name === 'aceite_termos_em')) {
        db.exec('ALTER TABLE inscricoes ADD COLUMN aceite_termos_em TEXT');
    }
} catch (erroMigWeb) {
    console.warn('⚠️ [MIGRAÇÃO WEB] Aviso ao verificar colunas complementares:', erroMigWeb.message);
}

// 2. Configura o Servidor Web (Express) e Tempo Real (Socket.io)
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 10000,
    pingTimeout: 20000,
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true
    }
});

app.use(express.json({ limit: '15mb' }));

// Verifica se a requisição partiu do próprio computador onde o servidor está rodando (localhost / IP da própria máquina)
function ehRequisicaoDaMaquinaLocal(req) {
    const ipRemoto = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (ipRemoto === '127.0.0.1' || ipRemoto === '::1' || ipRemoto === 'localhost') {
        return true;
    }
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName] || [];
        for (let i = 0; i < iface.length; i++) {
            if (iface[i].address === ipRemoto) {
                return true;
            }
        }
    }
    return false;
}

// ============================================================================
// DETECÇÃO DE IDIOMA E ROTEAMENTO SEGURO DE PÁGINAS (PT-BR PADRÃO / EN COM FALLBACK)
// ============================================================================
const caminhoArquivoIdioma = path.join(pastaDados, 'idioma.cfg');

function detectarIdiomaSistemaNode() {
    try {
        const envLang = String(process.env.POWERLIFTING_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').trim().toLowerCase();
        if (envLang.startsWith('en')) return 'en';
        if (envLang.startsWith('pt')) return 'pt';
        const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
        if (String(locale).toLowerCase().startsWith('en')) return 'en';
    } catch (e) {}
    return 'pt';
}

let idiomaServidor = detectarIdiomaSistemaNode();

function lerIdiomaSalvoNoDisco() {
    try {
        if (fs.existsSync(caminhoArquivoIdioma)) {
            const conteudo = String(fs.readFileSync(caminhoArquivoIdioma, 'utf8') || '').trim().toLowerCase();
            if (conteudo === 'en' || conteudo === 'pt') {
                idiomaServidor = conteudo;
                return idiomaServidor;
            }
        }
    } catch (e) {}
    return idiomaServidor;
}

function salvarIdiomaNoDisco(novoIdioma) {
    const limpo = String(novoIdioma || '').trim().toLowerCase().startsWith('en') ? 'en' : 'pt';
    idiomaServidor = limpo;
    try {
        fs.writeFileSync(caminhoArquivoIdioma, limpo, 'utf8');
    } catch (e) {
        console.warn('⚠️ [IDIOMA] Aviso ao gravar preferência de idioma:', e.message);
    }
    return idiomaServidor;
}

lerIdiomaSalvoNoDisco();

// Serve a versão _en.html quando o idioma ativo for 'en', com fallback automático para o .html original em português
function enviarPaginaHtml(req, res, nomeBase) {
    try {
        const baseLimpa = String(nomeBase || 'index')
            .replace(/\.html$/i, '')
            .replace(/_en$/i, '')
            .replace(/[^a-zA-Z0-9_-]/g, '');

        const idioma = lerIdiomaSalvoNoDisco();
        const pastaPublic = path.join(__dirname, 'public');
        const caminhoPt = path.join(pastaPublic, `${baseLimpa}.html`);
        const caminhoEn = path.join(pastaPublic, `${baseLimpa}_en.html`);

        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        let arquivoEscolhido = caminhoPt;
        if (idioma === 'en' && fs.existsSync(caminhoEn)) {
            arquivoEscolhido = caminhoEn;
        } else if (!fs.existsSync(caminhoPt) && fs.existsSync(caminhoEn)) {
            arquivoEscolhido = caminhoEn;
        }

        if (!fs.existsSync(arquivoEscolhido)) {
            const fallbackIndex = path.join(pastaPublic, 'index.html');
            if (ehRequisicaoDaMaquinaLocal(req) && fs.existsSync(fallbackIndex)) {
                return res.sendFile(fallbackIndex);
            }
            return res.status(404).send('Página não encontrada / Page not found');
        }

        return res.sendFile(arquivoEscolhido, (err) => {
            if (err && !res.headersSent) {
                if (arquivoEscolhido !== caminhoPt && fs.existsSync(caminhoPt)) {
                    return res.sendFile(caminhoPt);
                }
                res.status(500).end();
            }
        });
    } catch (erro) {
        console.error('⚠️ [IDIOMA HTML] Fallback acionado:', erro.message);
        try {
            const fallbackPt = path.join(__dirname, 'public', `${String(nomeBase || 'index').replace(/\.html$/i, '').replace(/_en$/i, '')}.html`);
            if (!res.headersSent && fs.existsSync(fallbackPt)) {
                return res.sendFile(fallbackPt);
            }
        } catch (eIgnorar) {}
        if (!res.headersSent) res.status(500).end();
    }
}

function exigirMaquinaLocalPagina(req, res, next) {
    if (ehRequisicaoDaMaquinaLocal(req)) return next();
    const emIngles = lerIdiomaSalvoNoDisco() === 'en';
    return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="${emIngles ? 'en' : 'pt-BR'}">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${emIngles ? 'Restricted Access' : 'Acesso Restrito'}</title></head>
        <body style="font-family: Arial, sans-serif; background: #eef2f3; padding: 40px 20px; text-align: center;">
            <div style="max-width: 540px; margin: 40px auto; background: white; padding: 30px; border-radius: 8px; border-top: 5px solid #e74c3c; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                <h2 style="color: #c0392b; margin-top: 0;">🔒 ${emIngles ? 'Access Restricted to Main Computer' : 'Acesso Restrito ao Computador Principal'}</h2>
                <p style="color: #555; line-height: 1.5;">${emIngles ? 'For security reasons, the main dashboard and event settings can only be accessed directly on the server computer.' : 'Por segurança, o Painel Inicial e as configurações de campeonato só podem ser acessados diretamente no computador principal do servidor.'}</p>
                <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 20px;">
                    <a href="/arbitro" style="background: #16a085; color: white; padding: 10px 16px; border-radius: 5px; text-decoration: none; font-weight: bold;">⚖️ ${emIngles ? 'Referees' : 'Árbitros'}</a>
                    <a href="/display" style="background: #27ae60; color: white; padding: 10px 16px; border-radius: 5px; text-decoration: none; font-weight: bold;">📺 ${emIngles ? 'Big Screen' : 'Telão'}</a>
                    <a href="/aquecimento" style="background: #d35400; color: white; padding: 10px 16px; border-radius: 5px; text-decoration: none; font-weight: bold;">🔥 ${emIngles ? 'Warm-up' : 'Aquecimento'}</a>
                    <a href="/resultados" style="background: #2c3e50; color: white; padding: 10px 16px; border-radius: 5px; text-decoration: none; font-weight: bold;">🏆 ${emIngles ? 'Results' : 'Resultados'}</a>
                </div>
            </div>
        </body>
        </html>
    `);
}

function exigirMaquinaLocalAPI(req, res, next) {
    if (ehRequisicaoDaMaquinaLocal(req)) return next();
    const emIngles = lerIdiomaSalvoNoDisco() === 'en';
    return res.status(403).json({
        erro: emIngles
            ? "🔒 Access denied: This operation is only allowed directly on the main server computer."
            : "🔒 Acesso negado: Esta operação só é permitida diretamente no computador principal do servidor."
    });
}

// Protege páginas administrativas (versões PT e _en) ANTES do express.static para bloquear acesso via Wi-Fi
const PAGINAS_RESTRITAS_LOCAL = ['index', 'criar-evento', 'inscricao', 'baterias', 'nuvem', 'importar-atletas'];

app.get('/', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'index'));
app.get('/setup', exigirMaquinaLocalPagina, (req, res) => res.redirect('/criar-evento'));
app.get('/setup.html', exigirMaquinaLocalPagina, (req, res) => res.redirect('/criar-evento'));
app.get('/setup_en.html', exigirMaquinaLocalPagina, (req, res) => res.redirect('/criar-evento'));

PAGINAS_RESTRITAS_LOCAL.forEach((pag) => {
    app.get(`/${pag}`, exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, pag));
    app.get(`/${pag}.html`, exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, pag));
    app.get(`/${pag}_en.html`, exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, pag));
});

// Intercepta requisições a '/' e a qualquer arquivo '.html' (incluindo '_en.html') com bloqueio local
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const reqPath = String(req.path || '');
    if (reqPath === '/') {
        return exigirMaquinaLocalPagina(req, res, () => enviarPaginaHtml(req, res, 'index'));
    }
    const matchHtml = reqPath.match(/^\/([a-zA-Z0-9_-]+)\.html$/i);
    if (matchHtml) {
        const base = matchHtml[1].replace(/_en$/i, '').toLowerCase();
        if (base === 'setup') {
            return exigirMaquinaLocalPagina(req, res, () => res.redirect('/criar-evento'));
        }
        if (PAGINAS_RESTRITAS_LOCAL.includes(base)) {
            return exigirMaquinaLocalPagina(req, res, () => enviarPaginaHtml(req, res, base));
        }
        return enviarPaginaHtml(req, res, base);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ============================================================================
// FUNÇÕES UTILITÁRIAS DE SANITIZAÇÃO E BLINDAGEM (ENTERPRISE GRADE)
// ============================================================================

const MOVIMENTOS_VALIDOS = ['agachamento', 'supino', 'terra'];

function validarMovimento(mov) {
    return MOVIMENTOS_VALIDOS.includes(mov) ? mov : 'agachamento';
}

function validarPlataforma(plat) {
    const n = parseInt(plat, 10);
    if (isNaN(n) || n < 1) return 1;
    if (n > 5) return 5;
    return n;
}

// Decodifica parâmetros de URL sem jamais lançar URIError caso o nome da bateria contenha '%' (ex: "100% Raw")
function decodificarParamSeguro(valor) {
    if (valor === undefined || valor === null) return '';
    const str = String(valor);
    try {
        return decodeURIComponent(str);
    } catch (e) {
        return str;
    }
}

// Obtém o nome da bateria via Query String (?bateria=...) ou Route Param (:bateria / :bateria_nome)
function obterBateriaDaRequisicao(req) {
    if (req.query && req.query.bateria !== undefined && String(req.query.bateria).trim() !== '') {
        return String(req.query.bateria).trim();
    }
    const bruto = req.params.bateria !== undefined ? req.params.bateria : req.params.bateria_nome;
    return decodificarParamSeguro(bruto).trim();
}

function sanitizarCPF(cpfBruto) {
    if (!cpfBruto) return null;
    const digitos = String(cpfBruto).replace(/\D/g, '').slice(0, 11);
    return digitos.length > 0 ? digitos : null;
}

function sanitizarOrganizadorId(orgBruto) {
    const limpo = String(orgBruto || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    return limpo || 'LOCAL';
}

function gerarUUIDNuvem() {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return 'ev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
}

function sanitizarPeso(valor, permitirNull = false) {
    if (valor === undefined || valor === null || valor === '') {
        return permitirNull ? null : 0;
    }
    if (typeof valor === 'number') {
        return !Number.isFinite(valor) || valor < 0 ? 0 : Math.round(valor * 100) / 100;
    }
    const limpo = String(valor).replace(',', '.').replace(/[^0-9.]/g, '');
    const numero = parseFloat(limpo);
    if (!Number.isFinite(numero) || numero < 0) {
        return permitirNull ? null : 0;
    }
    return Math.round(numero * 100) / 100;
}

function parseJSONSeguro(texto, valorPadrao = []) {
    if (texto === undefined || texto === null) return valorPadrao;
    if (typeof texto !== 'string') return texto;
    try {
        return JSON.parse(texto);
    } catch (e) {
        return valorPadrao;
    }
}

function normalizarDivisoesParaBanco(divisaoInput) {
    if (Array.isArray(divisaoInput)) {
        const limpas = divisaoInput.map(d => String(d).trim()).filter(Boolean);
        return JSON.stringify(limpas.length > 0 ? limpas : ['Open']);
    }
    if (typeof divisaoInput === 'string') {
        const trim = divisaoInput.trim();
        if (trim.startsWith('[')) {
            const parsed = parseJSONSeguro(trim, ['Open']);
            return JSON.stringify(Array.isArray(parsed) && parsed.length > 0 ? parsed : ['Open']);
        }
        return JSON.stringify(trim ? [trim] : ['Open']);
    }
    return JSON.stringify(['Open']);
}

function obterMovimentosDaModalidade(modalidade) {
    const mod = String(modalidade || 'Full Power').trim();
    if (mod === 'Agachamento Solo') return ['agachamento'];
    if (mod === 'Supino Solo') return ['supino'];
    if (mod === 'Terra Solo') return ['terra'];
    if (mod === 'Push-Pull') return ['supino', 'terra'];
    return ['agachamento', 'supino', 'terra']; // Full Power ou qualquer modalidade customizada
}

// Retorna cláusula SQL compatível tanto com modalidades padrão quanto com modalidades customizadas
function obterFiltroModalidadesExcluidas(movimento) {
    const mov = validarMovimento(movimento);
    if (mov === 'agachamento') return ['Supino Solo', 'Terra Solo', 'Push-Pull'];
    if (mov === 'supino') return ['Agachamento Solo', 'Terra Solo'];
    if (mov === 'terra') return ['Agachamento Solo', 'Supino Solo'];
    return [];
}

// Localiza bateria e plataforma existentes para realocação automática de categoria/modalidade
function buscarBateriaExistenteParaGrupo(eventoId, inscricaoIdIgnorar, mov, categoriaPeso, modalidade, equipamento, sexo) {
    const colBat = `bateria_${mov}`;
    const colPlat = `plataforma_${mov}`;

    let bateriaExistente = db.prepare(`
        SELECT i.${colBat} as nome_bateria, COALESCE(i.${colPlat}, 1) as plat
        FROM inscricoes i 
        JOIN atletas a ON i.atleta_id = a.id
        WHERE i.evento_id = ? 
          AND i.id != ?
          AND i.categoria_peso_escolhida = ? 
          AND i.modalidade_escolhida = ?
          AND COALESCE(i.equipamento_escolhido, 'Raw') = COALESCE(?, 'Raw')
          AND a.sexo = ? 
          AND COALESCE(i.remanejado_manual, 0) = 0
          AND i.${colBat} IS NOT NULL 
          AND TRIM(i.${colBat}) != ''
        LIMIT 1
    `).get(eventoId, inscricaoIdIgnorar, categoriaPeso, modalidade, equipamento, sexo);

    if (!bateriaExistente) {
        bateriaExistente = db.prepare(`
            SELECT i.${colBat} as nome_bateria, COALESCE(i.${colPlat}, 1) as plat
            FROM inscricoes i 
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ? 
              AND i.id != ?
              AND i.categoria_peso_escolhida = ? 
              AND COALESCE(i.equipamento_escolhido, 'Raw') = COALESCE(?, 'Raw')
              AND a.sexo = ? 
              AND COALESCE(i.remanejado_manual, 0) = 0
              AND i.${colBat} IS NOT NULL 
              AND TRIM(i.${colBat}) != ''
            LIMIT 1
        `).get(eventoId, inscricaoIdIgnorar, categoriaPeso, equipamento, sexo);
    }

    return bateriaExistente || null;
}

// Marca o evento como pendente de sincronização na nuvem (exceto se sync_nuvem == -1, quando foi encerrada pelo organizador)
function marcarEventoParaSyncNuvem(eventoId) {
    const idNum = Number(eventoId);
    if (!idNum) return;
    try {
        db.prepare(`
            UPDATE eventos
            SET sync_nuvem = CASE WHEN COALESCE(sync_nuvem, 0) = -1 THEN -1 ELSE 0 END,
                versao_sync = COALESCE(versao_sync, 1) + 1,
                atualizado_em = CURRENT_TIMESTAMP
            WHERE id = ? AND nome != 'Cadastros Cancelados'
        `).run(idNum);

        const ev = db.prepare('SELECT COALESCE(sync_nuvem, 0) as sync_nuvem FROM eventos WHERE id = ?').get(idNum);
        if (ev && Number(ev.sync_nuvem) !== -1 && typeof agendarPushImediatoNuvem === 'function') {
            agendarPushImediatoNuvem(250);
        }
    } catch (e) {
        console.error("⚠️ [SYNC TRACKER] Erro ao marcar evento para sync:", e.message);
    }
}

function marcarEventoPorInscricaoParaSync(inscricaoId) {
    const idNum = Number(inscricaoId);
    if (!idNum) return;
    try {
        const row = db.prepare('SELECT evento_id FROM inscricoes WHERE id = ?').get(idNum);
        if (row && row.evento_id) marcarEventoParaSyncNuvem(row.evento_id);
    } catch (e) {
        console.error("⚠️ [SYNC TRACKER] Erro ao localizar evento da inscrição:", e.message);
    }
}

function marcarEventoPorTentativaParaSync(tentativaId) {
    const idNum = Number(tentativaId);
    if (!idNum) return;
    try {
        const row = db.prepare(`
            SELECT i.evento_id
            FROM tentativas t
            JOIN inscricoes i ON t.inscricao_id = i.id
            WHERE t.id = ?
        `).get(idNum);
        if (row && row.evento_id) marcarEventoParaSyncNuvem(row.evento_id);
    } catch (e) {
        console.error("⚠️ [SYNC TRACKER] Erro ao localizar evento da tentativa:", e.message);
    }
}

// Garante que uma inscrição sempre tenha a 1ª tentativa criada APENAS para seus movimentos ativos
function garantirPrimeirasTentativasInscricao(inscricaoId, modalidadeEscolhida) {
    try {
        const movimentosAtivos = obterMovimentosDaModalidade(modalidadeEscolhida);
        const stmtCheck = db.prepare(`
            SELECT id FROM tentativas
            WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = 1
        `);
        const stmtInsert = db.prepare(`
            INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado)
            VALUES (?, ?, 1, 0, 'pendente')
        `);

        movimentosAtivos.forEach(mov => {
            const existe = stmtCheck.get(inscricaoId, mov);
            if (!existe) {
                stmtInsert.run(inscricaoId, mov);
            }
        });
    } catch (e) {
        console.error(`⚠️ [AUTO-HEAL] Erro ao garantir 1ªs tentativas para inscrição ${inscricaoId}:`, e.message);
    }
}

// Otimizado: Verifica em modo leitura primeiro e só abre transação de escrita se realmente faltar alguma 1ª tentativa
function garantirPrimeirasTentativasEvento(eventoId) {
    if (!eventoId) return;
    try {
        const inscricoes = db.prepare(`
            SELECT i.id, i.modalidade_escolhida,
                   GROUP_CONCAT(CASE WHEN t.numero_tentativa = 1 THEN t.movimento END) as movs_existentes
            FROM inscricoes i
            LEFT JOIN tentativas t ON t.inscricao_id = i.id AND t.numero_tentativa = 1
            WHERE i.evento_id = ?
            GROUP BY i.id
        `).all(eventoId);

        const faltantes = inscricoes.filter(insc => {
            const ativos = obterMovimentosDaModalidade(insc.modalidade_escolhida);
            const existentes = insc.movs_existentes ? insc.movs_existentes.split(',') : [];
            return ativos.some(m => !existentes.includes(m));
        });

        if (faltantes.length === 0) return;

        db.transaction(() => {
            faltantes.forEach(insc => {
                garantirPrimeirasTentativasInscricao(insc.id, insc.modalidade_escolhida);
            });
            marcarEventoParaSyncNuvem(eventoId);
        })();
    } catch (e) {
        console.error(`⚠️ [AUTO-HEAL] Erro ao verificar 1ªs tentativas do evento ${eventoId}:`, e.message);
    }
}

function registrarLogSeguranca(inscricaoId, acao, detalhesObj) {
    try {
        db.prepare(`
            INSERT INTO log_acoes (inscricao_id, acao, detalhes)
            VALUES (?, ?, ?)
        `).run(inscricaoId || null, acao, JSON.stringify(detalhesObj));
    } catch (e) {
        console.error("⚠️ [LOG] Falha ao gravar log de auditoria:", e.message);
    }
}

// ============================================================================
// 3. MÁQUINA DE ESTADOS PERSISTENTE (ATÉ 5 PLATAFORMAS SIMULTÂNEAS)
// ============================================================================

let estadoPlataformas = {};

function criarEstadoPadraoPlataforma(p) {
    return {
        plataforma: p,
        evento_id: null,
        movimento: null,
        bateria: null,
        atletaAtual: null,
        luzes: { esquerda: null, central: null, direita: null },
        resultado: null,
        modo_arbitro: 3,
        preVotoManualMesa: false
    };
}

function carregarEstadosDoBanco() {
    for (let p = 1; p <= 5; p++) {
        estadoPlataformas[p] = criarEstadoPadraoPlataforma(p);
    }
    try {
        const linhas = db.prepare('SELECT plataforma, estado_json FROM estado_plataformas').all();
        linhas.forEach(l => {
            const p = validarPlataforma(l.plataforma);
            const dados = parseJSONSeguro(l.estado_json, null);
            if (dados && typeof dados === 'object') {
                estadoPlataformas[p] = {
                    ...estadoPlataformas[p],
                    ...dados,
                    luzes: {
                        esquerda: dados.luzes?.esquerda ?? null,
                        central: dados.luzes?.central ?? null,
                        direita: dados.luzes?.direita ?? null
                    },
                    preVotoManualMesa: Boolean(dados.preVotoManualMesa),
                    plataforma: p
                };
            }
        });
    } catch (e) {
        console.error("⚠️ Erro ao restaurar estado das plataformas:", e.message);
    }
}

function salvarEstadoPlataforma(plataforma, marcarSyncEvento = true) {
    const p = validarPlataforma(plataforma);
    try {
        db.prepare(`
            INSERT INTO estado_plataformas (plataforma, estado_json, atualizado_em)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(plataforma) DO UPDATE SET
                estado_json = excluded.estado_json,
                atualizado_em = CURRENT_TIMESTAMP
        `).run(p, JSON.stringify(estadoPlataformas[p]));

        if (marcarSyncEvento && estadoPlataformas[p]?.evento_id) {
            marcarEventoParaSyncNuvem(estadoPlataformas[p].evento_id);
        }
    } catch (e) {
        console.error(`⚠️ Erro ao persistir estado da plataforma ${p}:`, e.message);
    }
}

function emitirEstadoPlataforma(plataforma, marcarSyncEvento = true) {
    const p = validarPlataforma(plataforma);
    salvarEstadoPlataforma(p, marcarSyncEvento);
    io.emit('estado_atualizado', estadoPlataformas[p]);
    io.emit('sincronizar_estado', estadoPlataformas[p]);
    io.emit('sincronizar_todas_plataformas', estadoPlataformas);
}

// Remove da plataforma ativa qualquer tentativa que tenha sido excluída, arquivada ou revertida
function limparTentativaDePlataformasAtivas(tentativaId, inscricaoId = null) {
    for (let p = 1; p <= 5; p++) {
        const atual = estadoPlataformas[p]?.atletaAtual;
        if (!atual) continue;
        const idTentPlataforma = atual.tentativa_id || atual.id;
        if (
            (tentativaId && Number(idTentPlataforma) === Number(tentativaId)) ||
            (inscricaoId && Number(atual.inscricao_id) === Number(inscricaoId))
        ) {
            estadoPlataformas[p].atletaAtual = null;
            estadoPlataformas[p].luzes = { esquerda: null, central: null, direita: null };
            estadoPlataformas[p].resultado = null;
            estadoPlataformas[p].preVotoManualMesa = false;
            emitirEstadoPlataforma(p);
        }
    }
}

// Auto-cura o estado das 5 plataformas caso o banco tenha sido alterado por importação, exclusão de bateria ou planilha
function sincronizarTodasPlataformasComBanco() {
    for (let p = 1; p <= 5; p++) {
        try {
            const est = estadoPlataformas[p];
            if (!est || !est.atletaAtual) continue;
            const idTent = est.atletaAtual.tentativa_id || est.atletaAtual.id;
            if (!idTent) {
                est.atletaAtual = null;
                est.luzes = { esquerda: null, central: null, direita: null };
                est.resultado = null;
                est.preVotoManualMesa = false;
                emitirEstadoPlataforma(p, false);
                continue;
            }

            const reg = db.prepare(`
                SELECT 
                    t.id as tentativa_id, t.numero_tentativa, t.peso_solicitado, t.estado, t.movimento,
                    i.id as inscricao_id, i.evento_id, i.rack_agachamento, i.rack_supino, i.trava_supino,
                    i.categoria_peso_escolhida, i.divisao_escolhida, i.equipamento_escolhido,
                    i.bateria_agachamento, i.bateria_supino, i.bateria_terra,
                    i.plataforma_agachamento, i.plataforma_supino, i.plataforma_terra,
                    a.nome, a.sexo, a.equipe, e.nome as nome_evento
                FROM tentativas t
                JOIN inscricoes i ON t.inscricao_id = i.id
                JOIN atletas a ON i.atleta_id = a.id
                JOIN eventos e ON i.evento_id = e.id
                WHERE t.id = ?
            `).get(idTent);

            if (!reg || reg.nome_evento === 'Cadastros Cancelados') {
                est.atletaAtual = null;
                est.luzes = { esquerda: null, central: null, direita: null };
                est.resultado = null;
                est.preVotoManualMesa = false;
                emitirEstadoPlataforma(p, false);
                continue;
            }

            const batDoMov = reg[`bateria_${reg.movimento}`];
            const platDoMov = validarPlataforma(reg[`plataforma_${reg.movimento}`] || 1);

            // Se o atleta foi desagrupado, movido para outra plataforma ou movido para outra bateria, limpa a plataforma atual
            if (!batDoMov || platDoMov !== p || (est.bateria && est.bateria !== batDoMov)) {
                est.atletaAtual = null;
                est.luzes = { esquerda: null, central: null, direita: null };
                est.resultado = null;
                est.preVotoManualMesa = false;
                emitirEstadoPlataforma(p, false);
                continue;
            }

            // Garante que o cabeçalho de contexto da plataforma e os dados do atleta estejam sempre sincronizados
            est.evento_id = reg.evento_id;
            est.movimento = reg.movimento;
            est.bateria = batDoMov;
            est.atletaAtual.nome = reg.nome;
            est.atletaAtual.sexo = reg.sexo;
            est.atletaAtual.equipe = reg.equipe;
            est.atletaAtual.categoria_peso_escolhida = reg.categoria_peso_escolhida;
            est.atletaAtual.divisao_escolhida = reg.divisao_escolhida;
            est.atletaAtual.equipamento_escolhido = reg.equipamento_escolhido;
            est.atletaAtual.pesoNaBarra = reg.peso_solicitado;
            est.atletaAtual.tentativa = reg.numero_tentativa;
            est.atletaAtual.rack_agachamento = reg.rack_agachamento;
            est.atletaAtual.rack_supino = reg.rack_supino;
            est.atletaAtual.trava_supino = reg.trava_supino;
            emitirEstadoPlataforma(p, false);
        } catch (e) {
            console.error(`⚠️ [AUTO-HEAL] Erro ao sincronizar estado da plataforma ${p}:`, e.message);
        }
    }
}

carregarEstadosDoBanco();
sincronizarTodasPlataformasComBanco();

// ============================================================================
// ROTAS DE PÁGINAS HTML
// ============================================================================

app.get('/', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'index'));
app.get('/criar-evento', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'criar-evento'));
app.get('/inscricao', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'inscricao'));
app.get('/baterias', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'baterias'));
app.get('/pesagem', (req, res) => enviarPaginaHtml(req, res, 'pesagem'));
app.get('/admin', (req, res) => enviarPaginaHtml(req, res, 'admin'));
app.get('/display', (req, res) => enviarPaginaHtml(req, res, 'display'));
app.get('/overlay', (req, res) => enviarPaginaHtml(req, res, 'overlay'));
app.get('/aquecimento', (req, res) => enviarPaginaHtml(req, res, 'aquecimento'));
app.get('/arbitro', (req, res) => enviarPaginaHtml(req, res, 'arbitro'));
app.get('/resultados', (req, res) => enviarPaginaHtml(req, res, 'resultados'));
app.get('/nuvem', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'nuvem'));
app.get('/importar-atletas', exigirMaquinaLocalPagina, (req, res) => enviarPaginaHtml(req, res, 'importar-atletas'));

// API para consultar e alternar o idioma ativo (PT-BR / EN)
app.get('/api/idioma', (req, res) => {
    res.json({ ok: true, idioma: lerIdiomaSalvoNoDisco() });
});

app.post('/api/idioma', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const novoIdioma = salvarIdiomaNoDisco(req.body?.idioma);
        io.emit('idioma_atualizado', { idioma: novoIdioma });
        res.json({ ok: true, idioma: novoIdioma });
    } catch (erro) {
        res.status(500).json({ ok: false, erro: erro.message });
    }
});

// API de Healthcheck para monitoramento em tempo real da Mesa e Cloud Run
app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({ ok: true, timestamp: Date.now() });
    } catch (erro) {
        res.status(500).json({ ok: false, erro: erro.message });
    }
});

// API para descobrir o IP da máquina na rede local (LAN) ignorando adaptadores virtuais (WSL/VirtualBox/VPN)
app.get('/api/rede', (req, res) => {
    const interfaces = os.networkInterfaces();
    const ipsPrioritarios = [];
    const ipsSecundarios = [];
    const regexVirtual = /vethernet|wsl|virtualbox|vmware|vbox|docker|hyper-v|hamachi|radmin|zerotier|tailscale|loopback|tap-|tun-/i;
    const regexFisico = /wi-fi|wireless|wlan|ethernet|eth|en0|lan/i;

    for (const devName in interfaces) {
        const iface = interfaces[devName] || [];
        const isVirtual = regexVirtual.test(devName);
        const isFisico = regexFisico.test(devName);

        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            const isIPv4 = alias.family === 'IPv4' || alias.family === 4;
            if (isIPv4 && alias.address !== '127.0.0.1' && !alias.internal && !alias.address.startsWith('169.254.')) {
                if (!isVirtual && isFisico) {
                    ipsPrioritarios.push(alias.address);
                } else if (!isVirtual) {
                    ipsSecundarios.push(alias.address);
                }
            }
        }
    }

    const todosIps = [...ipsPrioritarios, ...ipsSecundarios];
    res.json({
        ips: todosIps.length > 0 ? todosIps : ['localhost'],
        porta: PORT,
        eh_maquina_local: ehRequisicaoDaMaquinaLocal(req),
        pasta_dados: pastaDados
    });
});

// ============================================================================
// 🔐 MÓDULO ISOLADO: SENHA DE PROTEÇÃO DOS ÁRBITROS (WI-FI COMPARTILHADO)
// ============================================================================
const caminhoSenhaArbitro = path.join(pastaDados, 'senha_arbitro.cfg');
let configSenhaArbitro = { senha: '', salt: crypto.randomBytes(16).toString('hex') };
const tentativasFalhasArbitroPorIp = {};

function carregarSenhaArbitroDoDisco() {
    try {
        if (fs.existsSync(caminhoSenhaArbitro)) {
            const lido = JSON.parse(fs.readFileSync(caminhoSenhaArbitro, 'utf8'));
            if (lido && typeof lido.senha === 'string') {
                configSenhaArbitro = {
                    senha: lido.senha.trim(),
                    salt: lido.salt || crypto.randomBytes(16).toString('hex')
                };
            }
        }
    } catch (e) {}
}
carregarSenhaArbitroDoDisco();

function gerarTokenSessaoArbitro() {
    if (!configSenhaArbitro.senha) return '';
    return crypto.createHmac('sha256', configSenhaArbitro.salt).update('arb:' + configSenhaArbitro.senha).digest('hex');
}

function validarTokenSessaoArbitro(tokenRecebido) {
    if (!configSenhaArbitro.senha) return true; // Sem senha configurada = acesso livre
    if (!tokenRecebido || typeof tokenRecebido !== 'string') return false;
    const esperado = gerarTokenSessaoArbitro();
    const h1 = crypto.createHash('sha256').update(tokenRecebido).digest();
    const h2 = crypto.createHash('sha256').update(esperado).digest();
    return crypto.timingSafeEqual(h1, h2);
}

function exigirSenhaGlobalAPI(req, res, next) {
    if (!configSenhaArbitro.senha) return next();
    const tokenHeader = String(req.headers['x-auth-token'] || req.body?.token_acesso || '').trim();
    if (validarTokenSessaoArbitro(tokenHeader)) return next();
    return res.status(401).json({
        nao_autorizado: true,
        erro: "🔒 Acesso não autorizado: informe a senha configurada no Painel Inicial."
    });
}

app.get('/api/arbitro/config_senha', exigirMaquinaLocalAPI, (req, res) => {
    res.json({ ok: true, ativa: Boolean(configSenhaArbitro.senha), senha: configSenhaArbitro.senha });
});

app.post('/api/arbitro/config_senha', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const novaSenha = String(req.body?.senha || '').trim().slice(0, 64);
        configSenhaArbitro = {
            senha: novaSenha,
            salt: crypto.randomBytes(16).toString('hex') // Novo salt invalida celulares anteriores na hora
        };
        fs.writeFileSync(caminhoSenhaArbitro, JSON.stringify(configSenhaArbitro), 'utf8');
        io.emit('config_senha_arbitro_alterada', { exige_senha: Boolean(novaSenha) });
        console.log(novaSenha ? "🔐 [SEGURANÇA] Senha do Painel dos Árbitros ativada/atualizada." : "🔓 [SEGURANÇA] Senha do Painel dos Árbitros desativada.");
        res.json({ ok: true, ativa: Boolean(novaSenha) });
    } catch (erro) {
        res.status(500).json({ ok: false, erro: erro.message });
    }
});

app.get('/api/arbitro/status', (req, res) => {
    res.json({ ok: true, exige_senha: Boolean(configSenhaArbitro.senha) });
});

app.post('/api/arbitro/verificar_token', (req, res) => {
    res.json({ ok: true, autorizado: validarTokenSessaoArbitro(req.body?.token) });
});

app.post('/api/arbitro/autenticar', (req, res) => {
    try {
        if (!configSenhaArbitro.senha) {
            return res.json({ ok: true, token: '' });
        }
        const ip = String(req.ip || req.socket?.remoteAddress || 'desconhecido');
        const agora = Date.now();
        const regIp = tentativasFalhasArbitroPorIp[ip];
        if (regIp && regIp.bloqueadoAte > agora) {
            const segs = Math.ceil((regIp.bloqueadoAte - agora) / 1000);
            return res.status(429).json({ ok: false, erro: `Muitas tentativas incorretas. Aguarde ${segs}s.` });
        }

        const digitada = String(req.body?.senha || '').trim();
        const hDigitada = crypto.createHash('sha256').update(digitada).digest();
        const hCorreta = crypto.createHash('sha256').update(configSenhaArbitro.senha).digest();

        if (!crypto.timingSafeEqual(hDigitada, hCorreta)) {
            const falhas = (regIp?.falhas || 0) + 1;
            tentativasFalhasArbitroPorIp[ip] = {
                falhas,
                bloqueadoAte: falhas >= 5 ? agora + 25000 : 0
            };
            return res.status(401).json({ ok: false, erro: "Senha incorreta. Solicite a senha à Mesa." });
        }

        delete tentativasFalhasArbitroPorIp[ip];
        res.json({ ok: true, token: gerarTokenSessaoArbitro() });
    } catch (erro) {
        res.status(500).json({ ok: false, erro: "Erro ao verificar senha." });
    }
});

// ============================================================================
// 💾 MÓDULO ISOLADO: BACKUP EXTERNO / USB (3 SNAPSHOTS ROTATIVOS E ATÔMICOS)
// ============================================================================
const { execFile } = require('child_process');
const caminhoCfgBackupExterno = path.join(pastaDados, 'backup_externo.cfg');
let configBackupExterno = { pasta_destino: '', slot_atual: 0, ultimo_sucesso_em: null, ultimo_erro: null };
let backupExternoEmAndamento = false;
let ultimoLogErroUsbEm = 0;
let usbEstavaComErro = false;

function carregarConfigBackupExterno() {
    try {
        if (fs.existsSync(caminhoCfgBackupExterno)) {
            const lido = JSON.parse(fs.readFileSync(caminhoCfgBackupExterno, 'utf8'));
            if (lido && typeof lido === 'object') {
                configBackupExterno = {
                    pasta_destino: String(lido.pasta_destino || '').trim(),
                    slot_atual: Number(lido.slot_atual) || 0,
                    ultimo_sucesso_em: lido.ultimo_sucesso_em || null,
                    ultimo_erro: lido.ultimo_erro || null
                };
            }
        }
    } catch (e) {}
}
carregarConfigBackupExterno();

function salvarConfigBackupExternoNoDisco() {
    try {
        fs.writeFileSync(caminhoCfgBackupExterno, JSON.stringify(configBackupExterno), 'utf8');
    } catch (e) {}
}

async function substituirArquivoAtomicoExterno(caminhoTmp, caminhoFinal) {
    try {
        await fs.promises.rename(caminhoTmp, caminhoFinal);
    } catch (eRename) {
        try { await fs.promises.unlink(caminhoFinal); } catch (eUnlink) {}
        await fs.promises.rename(caminhoTmp, caminhoFinal);
    }
}

async function executarBackupExternoSeguro(motivo = 'automatico') {
    const pastaDestino = String(configBackupExterno.pasta_destino || '').trim();
    if (!pastaDestino || backupExternoEmAndamento) return { ignorado: true };
    backupExternoEmAndamento = true;

    const proximoSlot = (Number(configBackupExterno.slot_atual || 0) % 3) + 1;
    const stageLocalDb = path.join(pastaDados, 'usb_stage_temp.db');
    let tmpExternoDb = '';
    let tmpExternoJson = '';

    try {
        // 1. Verifica de forma 100% assíncrona se o pendrive/unidade está conectado antes de escrever
        const raizUnidade = path.parse(pastaDestino).root;
        if (raizUnidade) {
            await fs.promises.access(raizUnidade, fs.constants.F_OK);
        }
        await fs.promises.mkdir(pastaDestino, { recursive: true });

        // 2. Gera snapshot limpo e consolidado no SSD interno (nunca abre o SQLite direto no USB!)
        let gerouStageDb = false;
        if (typeof db.backup === 'function') {
            await db.backup(stageLocalDb);
            gerouStageDb = true;
        } else {
            const pastaBkpInterna = path.join(pastaDados, 'backups');
            if (fs.existsSync(pastaBkpInterna)) {
                const arqs = (await fs.promises.readdir(pastaBkpInterna))
                    .filter(f => f.endsWith('.db'))
                    .sort()
                    .reverse();
                if (arqs.length > 0) {
                    await fs.promises.copyFile(path.join(pastaBkpInterna, arqs[0]), stageLocalDb);
                    gerouStageDb = true;
                }
            }
        }

        // 3. Prepara também pacote JSON dos campeonatos ativos (importável pela Central da Nuvem)
        const eventosAtivos = db.prepare("SELECT id FROM eventos WHERE nome != 'Cadastros Cancelados' ORDER BY id DESC").all();
        const pacotesJson = eventosAtivos.map(e => gerarPacoteEventoParaNuvem(e.id)).filter(Boolean);
        const conteudoJson = JSON.stringify({
            gerado_em: new Date().toISOString(),
            slot_snapshot: proximoSlot,
            campeonatos: pacotesJson
        });

        // 4. Grava primeiro em arquivos .tmp no USB e só substitui o slot (1, 2 ou 3) após 100% concluído
        const sufixoTmp = `${Date.now()}_${process.pid}.tmp`;
        if (gerouStageDb) {
            tmpExternoDb = path.join(pastaDestino, `brasil_powerlifting_snapshot_${proximoSlot}.db.${sufixoTmp}`);
            const finalExternoDb = path.join(pastaDestino, `brasil_powerlifting_snapshot_${proximoSlot}.db`);
            await fs.promises.copyFile(stageLocalDb, tmpExternoDb);
            await substituirArquivoAtomicoExterno(tmpExternoDb, finalExternoDb);
            tmpExternoDb = '';
        }

        tmpExternoJson = path.join(pastaDestino, `brasil_powerlifting_campeonatos_${proximoSlot}.json.${sufixoTmp}`);
        const finalExternoJson = path.join(pastaDestino, `brasil_powerlifting_campeonatos_${proximoSlot}.json`);
        await fs.promises.writeFile(tmpExternoJson, conteudoJson, 'utf8');
        await substituirArquivoAtomicoExterno(tmpExternoJson, finalExternoJson);
        tmpExternoJson = '';

        try { await fs.promises.unlink(stageLocalDb); } catch (e) {}

        configBackupExterno.slot_atual = proximoSlot;
        configBackupExterno.ultimo_sucesso_em = new Date().toISOString();
        configBackupExterno.ultimo_erro = null;
        salvarConfigBackupExternoNoDisco();

        if (usbEstavaComErro || motivo === 'manual') {
            usbEstavaComErro = false;
            console.log(`💾 [BACKUP EXTERNO] Snapshot ${proximoSlot}/3 salvo com sucesso em: ${pastaDestino}`);
        }
        return { ok: true, slot: proximoSlot };
    } catch (erro) {
        if (tmpExternoDb) { try { await fs.promises.unlink(tmpExternoDb); } catch (e) {} }
        if (tmpExternoJson) { try { await fs.promises.unlink(tmpExternoJson); } catch (e) {} }
        try { await fs.promises.unlink(stageLocalDb); } catch (e) {}

        const msgCurta = erro.code === 'ENOENT' || erro.code === 'EIO' || erro.code === 'EPERM' || erro.code === 'EBUSY'
            ? `Unidade/pasta inacessível ou pendrive removido (${erro.code})`
            : erro.message;

        configBackupExterno.ultimo_erro = msgCurta;
        salvarConfigBackupExternoNoDisco();

        const agora = Date.now();
        if (!usbEstavaComErro || motivo === 'manual' || (agora - ultimoLogErroUsbEm) > 120000) {
            usbEstavaComErro = true;
            ultimoLogErroUsbEm = agora;
            console.warn(`⚠️ [BACKUP EXTERNO] Não foi possível gravar em "${pastaDestino}": ${msgCurta}. O campeonato segue 100% normal com o backup interno.`);
        }
        return { ok: false, erro: msgCurta };
    } finally {
        backupExternoEmAndamento = false;
    }
}

app.get('/api/backup-externo/config', exigirMaquinaLocalAPI, (req, res) => {
    res.json({ ok: true, ...configBackupExterno });
});

app.post('/api/backup-externo/selecionar-pasta', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const psScript = [
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
            "Add-Type -AssemblyName System.Windows.Forms;",
            "$f = New-Object System.Windows.Forms.Form;",
            "$f.TopMost = $true; $f.ShowInTaskbar = $false; $f.Opacity = 0; $f.Width = 1; $f.Height = 1;",
            "$f.StartPosition = 'CenterScreen'; $f.Show(); $f.Activate();",
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
            "$d.Description = 'Selecione o Pendrive (USB) ou pasta para salvar os 3 Snapshots automaticos';",
            "$d.ShowNewFolderButton = $true;",
            "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
            "$f.Close();"
        ].join(' ');

        execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', psScript], { windowsHide: true, timeout: 90000, encoding: 'utf8' }, (err, stdout) => {
            if (err) {
                return res.json({ ok: false, erro: "Não foi possível abrir o seletor automático. Digite ou cole o caminho da pasta manualmente." });
            }
            const caminho = String(stdout || '').trim();
            if (!caminho) return res.json({ ok: true, cancelado: true });
            res.json({ ok: true, pasta_destino: caminho });
        });
    } catch (erro) {
        res.json({ ok: false, erro: "Digite ou cole o caminho da pasta manualmente." });
    }
});

app.post('/api/backup-externo/config', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        const pastaLimpa = String(req.body?.pasta_destino || '').trim();
        configBackupExterno.pasta_destino = pastaLimpa;
        configBackupExterno.ultimo_erro = null;
        if (!pastaLimpa) {
            usbEstavaComErro = false;
            salvarConfigBackupExternoNoDisco();
            console.log("ℹ️ [BACKUP EXTERNO] Backup externo/USB desativado pelo organizador.");
            return res.json({ ok: true, desativado: true });
        }
        salvarConfigBackupExternoNoDisco();
        const teste = await executarBackupExternoSeguro('manual');
        if (!teste.ok) {
            return res.status(400).json({ ok: false, erro: `Pasta salva, mas não foi possível gravar agora: ${teste.erro}` });
        }
        res.json({ ok: true, ...configBackupExterno });
    } catch (erro) {
        res.status(500).json({ ok: false, erro: erro.message });
    }
});

// Restauração 1-clique a partir de qualquer snapshot .json (USB com vários campeonatos ou pacote único)
app.post('/api/backup-externo/restaurar-json', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        const bruto = req.body || {};
        const pacotes = Array.isArray(bruto.campeonatos)
            ? bruto.campeonatos
            : (bruto.evento ? [bruto] : []);

        if (pacotes.length === 0) {
            return res.status(400).json({ ok: false, erro: "O arquivo selecionado não contém nenhum campeonato válido." });
        }

        // 1. Valida TODOS os campeonatos e hashes SHA-256 ANTES de alterar qualquer dado no banco
        const pacotesValidados = [];
        for (const p of pacotes) {
            const val = validarESanitizarPacoteNuvem(p);
            if (!val.valido) {
                return res.status(422).json({
                    ok: false,
                    erro: `Arquivo de backup corrompido ou incompleto (${val.erro}). Tente outro slot (1, 2 ou 3).`
                });
            }
            pacotesValidados.push(val.pacote);
        }

        // 2. Cria um snapshot de segurança do banco atual antes de restaurar
        await criarSnapshotSeguranca('antes_restaurar_usb');

        let totalEventosRestaurados = 0;
        let totalAtletasRestaurados = 0;

        // 3. Restaura tudo em uma única transação atômica do SQLite
        db.transaction(() => {
            for (const pacote of pacotesValidados) {
                const evOrig = pacote.evento;
                const inscricoesOrig = Array.isArray(pacote.inscricoes) ? pacote.inscricoes : [];
                const tentativasOrig = Array.isArray(pacote.tentativas) ? pacote.tentativas : [];
                const nuvemEventoId = pacote.nuvem_id || evOrig.nuvem_evento_id || gerarUUIDNuvem();
                const orgId = sanitizarOrganizadorId(pacote.organizador_id || evOrig.organizador_id || 'LOCAL');

                const strModalidades = typeof evOrig.modalidades === 'string' ? evOrig.modalidades : JSON.stringify(evOrig.modalidades || ['Full Power']);
                const strDivisoes = typeof evOrig.divisoes_idade === 'string' ? evOrig.divisoes_idade : JSON.stringify(evOrig.divisoes_idade || ['Open']);
                const strPesoM = typeof evOrig.categorias_peso_masculino === 'string' ? evOrig.categorias_peso_masculino : JSON.stringify(evOrig.categorias_peso_masculino || []);
                const strPesoF = typeof evOrig.categorias_peso_feminino === 'string' ? evOrig.categorias_peso_feminino : JSON.stringify(evOrig.categorias_peso_feminino || []);
                const strEquip = typeof evOrig.equipamentos === 'string' ? evOrig.equipamentos : JSON.stringify(evOrig.equipamentos || ['Raw']);

                let existente = db.prepare('SELECT id FROM eventos WHERE nuvem_evento_id = ?').get(nuvemEventoId);
                if (!existente) {
                    existente = db.prepare("SELECT id FROM eventos WHERE LOWER(nome) = LOWER(?) AND nome != 'Cadastros Cancelados'").get(evOrig.nome);
                }

                let eventoLocalId;
                if (existente) {
                    eventoLocalId = existente.id;
                    db.prepare(`
                        UPDATE eventos
                        SET nome = ?, data = ?, modalidades = ?, divisoes_idade = ?,
                            categorias_peso_masculino = ?, categorias_peso_feminino = ?,
                            num_plataformas = ?, anilhas_calibradas = ?, equipamentos = ?,
                            organizador_id = ?, nuvem_evento_id = ?,
                            versao_sync = COALESCE(versao_sync, 1) + 1, sync_nuvem = 0, atualizado_em = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        evOrig.nome, evOrig.data, strModalidades, strDivisoes, strPesoM, strPesoF,
                        validarPlataforma(evOrig.num_plataformas || 1), evOrig.anilhas_calibradas ? 1 : 0,
                        strEquip, orgId, nuvemEventoId, eventoLocalId
                    );
                    db.prepare('DELETE FROM tentativas WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)').run(eventoLocalId);
                    db.prepare('DELETE FROM inscricoes WHERE evento_id = ?').run(eventoLocalId);
                } else {
                    eventoLocalId = db.prepare(`
                        INSERT INTO eventos (nome, data, modalidades, divisoes_idade, categorias_peso_masculino, categorias_peso_feminino, num_plataformas, anilhas_calibradas, equipamentos, organizador_id, nuvem_evento_id, versao_sync, sync_nuvem, atualizado_em)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `).run(
                        evOrig.nome, evOrig.data, strModalidades, strDivisoes, strPesoM, strPesoF,
                        validarPlataforma(evOrig.num_plataformas || 1), evOrig.anilhas_calibradas ? 1 : 0,
                        strEquip, orgId, nuvemEventoId, Number(pacote.versao_sync) || 1
                    ).lastInsertRowid;
                }

                const mapaInsc = {};
                const mapaTent = {};

                inscricoesOrig.forEach(insc => {
                    const cpfLimpo = sanitizarCPF(insc.cpf);
                    const nomeAtleta = String(insc.nome || 'Atleta').trim();
                    let idAtleta = null;

                    if (cpfLimpo) {
                        const exCpf = db.prepare('SELECT id, nome FROM atletas WHERE cpf = ? ORDER BY id DESC LIMIT 1').get(cpfLimpo);
                        if (exCpf && String(exCpf.nome || '').trim().toLowerCase() === nomeAtleta.toLowerCase()) idAtleta = exCpf.id;
                    }
                    if (!idAtleta) {
                        const exNome = db.prepare('SELECT id FROM atletas WHERE LOWER(nome) = LOWER(?) AND data_nascimento = ? AND sexo = ? LIMIT 1')
                            .get(nomeAtleta, String(insc.data_nascimento || ''), String(insc.sexo || 'M'));
                        if (exNome) idAtleta = exNome.id;
                    }

                    if (idAtleta) {
                        db.prepare(`
                            UPDATE atletas
                            SET nome = ?, cpf = COALESCE(?, cpf), data_nascimento = ?, sexo = ?, whatsapp = ?, cidade = ?, estado = ?, equipe = ?, pcd = ?,
                                instagram = COALESCE(?, instagram), youtube = COALESCE(?, youtube), outros_social = COALESCE(?, outros_social)
                            WHERE id = ?
                        `).run(
                            nomeAtleta, cpfLimpo, String(insc.data_nascimento || ''), insc.sexo === 'F' ? 'F' : 'M',
                            String(insc.whatsapp || ''), String(insc.cidade || ''), String(insc.estado || 'SP'),
                            String(insc.equipe || 'Sem Equipe'), insc.pcd ? 1 : 0,
                            insc.instagram || null, insc.youtube || null, insc.outros_social || null, idAtleta
                        );
                    } else {
                        idAtleta = db.prepare(`
                            INSERT INTO atletas (nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd, instagram, youtube, outros_social)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            nomeAtleta, cpfLimpo, String(insc.data_nascimento || ''), insc.sexo === 'F' ? 'F' : 'M',
                            String(insc.whatsapp || ''), String(insc.cidade || ''), String(insc.estado || 'SP'),
                            String(insc.equipe || 'Sem Equipe'), insc.pcd ? 1 : 0,
                            insc.instagram || null, insc.youtube || null, insc.outros_social || null
                        ).lastInsertRowid;
                    }

                    const novaInscId = db.prepare(`
                        INSERT INTO inscricoes (
                            evento_id, atleta_id, modalidade_escolhida, equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida,
                            bateria_agachamento, bateria_supino, bateria_terra,
                            plataforma_agachamento, plataforma_supino, plataforma_terra, remanejado_manual,
                            peso_corporal_oficial, numero_lote, rack_agachamento, rack_supino, trava_supino, versao,
                            anonimizar_historico, origem_inscricao, aceite_termos_em
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                    `).run(
                        eventoLocalId, idAtleta, insc.modalidade_escolhida || 'Full Power', insc.equipamento_escolhido || 'Raw',
                        normalizarDivisoesParaBanco(insc.divisao_escolhida), insc.categoria_peso_escolhida || 'Livre',
                        insc.bateria_agachamento || null, insc.bateria_supino || null, insc.bateria_terra || null,
                        validarPlataforma(insc.plataforma_agachamento || 1), validarPlataforma(insc.plataforma_supino || 1), validarPlataforma(insc.plataforma_terra || 1),
                        insc.remanejado_manual ? 1 : 0, insc.peso_corporal_oficial || null,
                        insc.numero_lote || (Math.floor(Math.random() * 9000) + 1000),
                        insc.rack_agachamento || null, insc.rack_supino || null, insc.trava_supino || null,
                        insc.anonimizar_historico ? 1 : 0, insc.origem_inscricao || 'APP', insc.aceite_termos_em || null
                    ).lastInsertRowid;

                    mapaInsc[insc.id] = novaInscId;
                    totalAtletasRestaurados++;
                });

                const stmtTent = db.prepare(`
                    INSERT OR IGNORE INTO tentativas (
                        inscricao_id, movimento, numero_tentativa, peso_solicitado, estado,
                        luz_esquerda, luz_central, luz_direita, resultado_valido, sync_nuvem
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                `);
                tentativasOrig.forEach(t => {
                    const novaInscId = mapaInsc[t.inscricao_id];
                    if (!novaInscId) return;
                    const infoT = stmtTent.run(
                        novaInscId, validarMovimento(t.movimento), Number(t.numero_tentativa) || 1,
                        sanitizarPeso(t.peso_solicitado, false),
                        ['pendente', 'aguardando_pedida', 'concluido'].includes(t.estado) ? t.estado : 'pendente',
                        t.luz_esquerda !== undefined ? t.luz_esquerda : null,
                        t.luz_central !== undefined ? t.luz_central : null,
                        t.luz_direita !== undefined ? t.luz_direita : null,
                        t.resultado_valido !== undefined ? t.resultado_valido : null
                    );
                    if (t.id && infoT.lastInsertRowid) mapaTent[t.id] = infoT.lastInsertRowid;
                });

                garantirPrimeirasTentativasEvento(eventoLocalId);

                if (pacote.estados_plataformas && typeof pacote.estados_plataformas === 'object') {
                    for (const platKey of Object.keys(pacote.estados_plataformas)) {
                        const pNum = validarPlataforma(platKey);
                        const estBkp = pacote.estados_plataformas[platKey];
                        if (!estBkp || typeof estBkp !== 'object') continue;
                        const novoEst = { ...criarEstadoPadraoPlataforma(pNum), ...estBkp, plataforma: pNum, evento_id: eventoLocalId };
                        if (novoEst.atletaAtual) {
                            const oldT = novoEst.atletaAtual.tentativa_id || novoEst.atletaAtual.id;
                            novoEst.atletaAtual.tentativa_id = mapaTent[oldT] || null;
                            novoEst.atletaAtual.inscricao_id = mapaInsc[novoEst.atletaAtual.inscricao_id] || null;
                        }
                        estadoPlataformas[pNum] = novoEst;
                        salvarEstadoPlataforma(pNum, false);
                    }
                }
                totalEventosRestaurados++;
            }
            registrarLogSeguranca(null, 'restaurar_backup_externo_json', {
                eventos: totalEventosRestaurados,
                atletas: totalAtletasRestaurados
            });
        })();

        sincronizarTodasPlataformasComBanco();
        for (let p = 1; p <= 5; p++) emitirEstadoPlataforma(p, false);
        io.emit('dados_atletas_atualizados', { acao: 'restaurado_backup_externo' });
        io.emit('fila_atualizada', {});

        console.log(`♻️ [BACKUP EXTERNO] Restauração concluída: ${totalEventosRestaurados} campeonato(s) e ${totalAtletasRestaurados} atleta(s).`);
        res.json({ ok: true, eventos: totalEventosRestaurados, atletas: totalAtletasRestaurados });
    } catch (erro) {
        console.error("❌ [BACKUP EXTERNO] Erro ao restaurar backup JSON:", erro.message);
        res.status(500).json({ ok: false, erro: erro.message });
    }
});

// Rota para encerramento seguro do servidor com backup e consolidação do WAL (Restrita à Máquina Principal)
app.post('/api/desligar', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        await realizarBackupAutomatico();
        // Tenta salvar snapshot externo final com limite máximo de 2s para nunca atrasar o fechamento caso o USB esteja travado
        await Promise.race([
            executarBackupExternoSeguro('desligamento'),
            new Promise(r => setTimeout(r, 2000))
        ]).catch(() => {});
        fecharBancoComSeguranca();
        res.json({ ok: true });
        console.log("[SHUTDOWN_INTENCIONAL] 🛑 Servidor encerrado com segurança pelo operador.");
        setTimeout(() => process.exit(0), 400);
    } catch (e) {
        fecharBancoComSeguranca();
        res.json({ ok: true });
        console.log("[SHUTDOWN_INTENCIONAL] 🛑 Servidor encerrado pelo operador.");
        setTimeout(() => process.exit(0), 400);
    }
});

// ============================================================================
// ROTAS DE EVENTOS (CAMPEONATOS)
// ============================================================================

app.get('/api/eventos', (req, res) => {
    try {
        const eventos = db.prepare(`
            SELECT id, nome, data, num_plataformas, anilhas_calibradas, organizador_id, nuvem_evento_id,
                   COALESCE(sync_nuvem, 0) as sync_nuvem,
                   COALESCE(versao_sync, 1) as versao_sync,
                   ultimo_sync_em, atualizado_em
            FROM eventos 
            WHERE nome != 'Cadastros Cancelados' 
            ORDER BY id DESC
        `).all();
        res.json(eventos);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/eventos/:id', (req, res) => {
    try {
        const evento = db.prepare('SELECT * FROM eventos WHERE id = ?').get(req.params.id);
        if (evento) {
            const mods = parseJSONSeguro(evento.modalidades, ['Full Power']);
            const divs = parseJSONSeguro(evento.divisoes_idade, ['Open']);
            const pesoM = parseJSONSeguro(evento.categorias_peso_masculino, []);
            const pesoF = parseJSONSeguro(evento.categorias_peso_feminino, []);
            const equips = parseJSONSeguro(evento.equipamentos, ['Raw']);

            // Auto-cura: garante que qualquer divisão, modalidade, equipamento ou categoria de peso
            // já atribuída a um atleta inscrito neste evento apareça sempre nos dropdowns do sistema
            const inscricoesEvento = db.prepare(`
                SELECT i.modalidade_escolhida, i.equipamento_escolhido, i.divisao_escolhida, i.categoria_peso_escolhida, a.sexo
                FROM inscricoes i
                JOIN atletas a ON i.atleta_id = a.id
                WHERE i.evento_id = ?
            `).all(req.params.id);

            inscricoesEvento.forEach(insc => {
                if (insc.modalidade_escolhida && !mods.includes(insc.modalidade_escolhida)) {
                    mods.push(insc.modalidade_escolhida);
                }
                const eq = insc.equipamento_escolhido || 'Raw';
                if (eq && !equips.includes(eq)) {
                    equips.push(eq);
                }
                const divsInsc = parseJSONSeguro(insc.divisao_escolhida, [insc.divisao_escolhida]);
                (Array.isArray(divsInsc) ? divsInsc : [insc.divisao_escolhida]).forEach(d => {
                    const dLimpo = String(d || '').trim();
                    if (dLimpo && !divs.includes(dLimpo)) divs.push(dLimpo);
                });
                const catPeso = String(insc.categoria_peso_escolhida || '').trim();
                if (catPeso && catPeso.toLowerCase() !== 'livre') {
                    if (insc.sexo === 'F' && !pesoF.includes(catPeso)) pesoF.push(catPeso);
                    else if (insc.sexo !== 'F' && !pesoM.includes(catPeso)) pesoM.push(catPeso);
                }
            });

            evento.modalidades = mods;
            evento.divisoes_idade = divs;
            evento.categorias_peso_masculino = pesoM;
            evento.categorias_peso_feminino = pesoF;
            evento.equipamentos = equips;
            evento.num_plataformas = validarPlataforma(evento.num_plataformas || 1);
            evento.anilhas_calibradas = evento.anilhas_calibradas ? 1 : 0;
            res.json(evento);
        } else {
            res.status(404).json({ erro: "Evento não encontrado" });
        }
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.post('/api/eventos', exigirMaquinaLocalAPI, async (req, res) => {
    const {
        nome, data, modalidades, divisoes_idade,
        categorias_peso_masculino, categorias_peso_feminino,
        num_plataformas, anilhas_calibradas, equipamentos, organizador_id,
        confirmar_cancelar_sync
    } = req.body || {};

    const nomeLimpo = String(nome || '').trim();
    const dataLimpa = String(data || '').trim();
    if (!nomeLimpo || !dataLimpa) {
        return res.status(400).json({ erro: "Nome e data do campeonato são obrigatórios." });
    }

    try {
        const cfgNuvem = db.prepare('SELECT organizador_id FROM config_nuvem WHERE id = 1').get();
        const orgIdFinal = sanitizarOrganizadorId(organizador_id || cfgNuvem?.organizador_id || 'LOCAL');
        let nuvemId = gerarUUIDNuvem();
        let statusSyncInicial = 0; // 0 = sincronizar com a nuvem | -1 = sincronização encerrada pelo organizador

        // Verifica se este campeonato já existe na nuvem com o mesmo nome ou se atingiu o teto de campeonatos da licença
        const checkLimite = await verificarLimiteLicencaParaNovoEvento(nomeLimpo);
        if (checkLimite.nuvem_id_existente) {
            nuvemId = checkLimite.nuvem_id_existente;
        } else if (checkLimite.atingiu_limite) {
            if (!confirmar_cancelar_sync) {
                const msgAviso = "O cadastro de um novo campeonato na plataforma offline fará com que a sincronização com a nuvem seja encerrada. Remova algum campeonato inativo na nuvem para poder criar mais campeonatos sem perder a sincronização.";
                return res.status(409).json({
                    requer_confirmacao_limite_nuvem: true,
                    tipo_limite: 'CAMPEONATOS',
                    erro: msgAviso,
                    mensagem: msgAviso
                });
            }
            statusSyncInicial = -1;
        }

        const stmt = db.prepare(`
            INSERT INTO eventos 
            (nome, data, modalidades, divisoes_idade, categorias_peso_masculino, categorias_peso_feminino, num_plataformas, anilhas_calibradas, equipamentos, organizador_id, nuvem_evento_id, sync_nuvem, versao_sync, atualizado_em) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        `);

        const info = stmt.run(
            nomeLimpo,
            dataLimpa,
            JSON.stringify(Array.isArray(modalidades) && modalidades.length > 0 ? modalidades : ['Full Power']),
            JSON.stringify(Array.isArray(divisoes_idade) && divisoes_idade.length > 0 ? divisoes_idade : ['Open']),
            JSON.stringify(Array.isArray(categorias_peso_masculino) ? categorias_peso_masculino : []),
            JSON.stringify(Array.isArray(categorias_peso_feminino) ? categorias_peso_feminino : []),
            validarPlataforma(num_plataformas || 1),
            anilhas_calibradas === false || anilhas_calibradas === 0 ? 0 : 1,
            JSON.stringify(Array.isArray(equipamentos) && equipamentos.length > 0 ? equipamentos : ['Raw']),
            orgIdFinal,
            nuvemId,
            statusSyncInicial
        );

        if (statusSyncInicial === -1) {
            registrarLogSeguranca(null, 'sync_nuvem_encerrado_novo_evento', {
                evento_id: info.lastInsertRowid,
                nome_evento: nomeLimpo
            });
        } else if (typeof agendarPushImediatoNuvem === 'function') {
            agendarPushImediatoNuvem(250);
        }

        res.json({
            sucesso: true,
            evento_id: info.lastInsertRowid,
            nuvem_evento_id: nuvemId,
            sync_cancelado: statusSyncInicial === -1
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.put('/api/eventos/:id', exigirMaquinaLocalAPI, (req, res) => {
    const {
        nome, data, modalidades, divisoes_idade,
        categorias_peso_masculino, categorias_peso_feminino,
        num_plataformas, anilhas_calibradas, equipamentos, organizador_id
    } = req.body || {};

    const nomeLimpo = String(nome || '').trim();
    const dataLimpa = String(data || '').trim();
    if (!nomeLimpo || !dataLimpa) {
        return res.status(400).json({ erro: "Nome e data do campeonato são obrigatórios." });
    }

    try {
        const atual = db.prepare('SELECT organizador_id, nuvem_evento_id, COALESCE(sync_nuvem, 0) as sync_nuvem FROM eventos WHERE id = ?').get(req.params.id);
        const cfgNuvem = db.prepare('SELECT organizador_id FROM config_nuvem WHERE id = 1').get();
        const orgSalvoNoEvento = (atual?.organizador_id && atual.organizador_id !== 'LOCAL') ? atual.organizador_id : null;
        const orgIdFinal = sanitizarOrganizadorId(organizador_id || orgSalvoNoEvento || cfgNuvem?.organizador_id || 'LOCAL');
        const nuvemIdFinal = atual?.nuvem_evento_id || gerarUUIDNuvem();
        const proxSyncStatus = Number(atual?.sync_nuvem) === -1 ? -1 : 0;

        const stmt = db.prepare(`
            UPDATE eventos 
            SET nome = ?, data = ?, modalidades = ?, divisoes_idade = ?, 
                categorias_peso_masculino = ?, categorias_peso_feminino = ?,
                num_plataformas = ?, anilhas_calibradas = ?, equipamentos = ?,
                organizador_id = ?, nuvem_evento_id = ?,
                sync_nuvem = ?, versao_sync = COALESCE(versao_sync, 1) + 1,
                atualizado_em = CURRENT_TIMESTAMP
            WHERE id = ?
        `);

        stmt.run(
            nomeLimpo,
            dataLimpa,
            JSON.stringify(Array.isArray(modalidades) && modalidades.length > 0 ? modalidades : ['Full Power']),
            JSON.stringify(Array.isArray(divisoes_idade) && divisoes_idade.length > 0 ? divisoes_idade : ['Open']),
            JSON.stringify(Array.isArray(categorias_peso_masculino) ? categorias_peso_masculino : []),
            JSON.stringify(Array.isArray(categorias_peso_feminino) ? categorias_peso_feminino : []),
            validarPlataforma(num_plataformas || 1),
            anilhas_calibradas === false || anilhas_calibradas === 0 ? 0 : 1,
            JSON.stringify(Array.isArray(equipamentos) && equipamentos.length > 0 ? equipamentos : ['Raw']),
            orgIdFinal,
            nuvemIdFinal,
            proxSyncStatus,
            req.params.id
        );

        if (proxSyncStatus !== -1 && typeof agendarPushImediatoNuvem === 'function') {
            agendarPushImediatoNuvem(250);
        }

        io.emit('dados_atletas_atualizados', { evento_id: Number(req.params.id), acao: 'evento_atualizado' });
        res.json({ sucesso: true });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Exclusão APENAS LOCAL do campeonato (exige confirmação exata do nome e nunca apaga dados da Nuvem)
app.delete('/api/eventos/:id', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        const eventoId = Number(req.params.id);
        const confirmacaoNome = String(req.body?.confirmacao_nome || '').trim();

        const evento = db.prepare("SELECT * FROM eventos WHERE id = ? AND nome != 'Cadastros Cancelados'").get(eventoId);
        if (!evento) {
            return res.status(404).json({ erro: "Campeonato não encontrado." });
        }

        if (confirmacaoNome !== String(evento.nome).trim()) {
            return res.status(400).json({
                erro: `O nome digitado ("${confirmacaoNome}") não corresponde exatamente ao nome do campeonato ("${evento.nome}"). Exclusão cancelada.`
            });
        }

        // Cria um snapshot de segurança local na pasta backups/ antes de excluir
        await criarSnapshotSeguranca('excluir_evento');

        db.transaction(() => {
            db.prepare('DELETE FROM tentativas WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)').run(eventoId);
            db.prepare('DELETE FROM log_acoes WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)').run(eventoId);
            db.prepare('DELETE FROM inscricoes WHERE evento_id = ?').run(eventoId);
            db.prepare('DELETE FROM eventos WHERE id = ?').run(eventoId);

            registrarLogSeguranca(null, 'excluir_evento_local', {
                evento_id: eventoId,
                nome_evento: evento.nome,
                data_evento: evento.data
            });
        })();

        // Invalida o cache de quota da licença para refletir imediatamente a exclusão local
        if (typeof cacheQuotaLicencaNuvem === 'object' && cacheQuotaLicencaNuvem) {
            cacheQuotaLicencaNuvem.atualizado_em = 0;
        }

        // Se alguma das 5 plataformas estava com este campeonato selecionado, limpa a plataforma
        for (let p = 1; p <= 5; p++) {
            if (Number(estadoPlataformas[p]?.evento_id) === eventoId) {
                estadoPlataformas[p] = criarEstadoPadraoPlataforma(p);
                emitirEstadoPlataforma(p, false);
            }
        }

        io.emit('dados_atletas_atualizados', { evento_id: eventoId, acao: 'evento_excluido_local' });
        io.emit('fila_atualizada', { evento_id: eventoId });

        res.json({ sucesso: true, nome_excluido: evento.nome });
    } catch (erro) {
        console.error("Erro ao excluir campeonato local:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// ROTAS DE INSCRIÇÃO, VERIFICAÇÃO DE CPF E EDIÇÃO DE ATLETAS
// ============================================================================

app.get('/api/atletas/buscar', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const termo = String(req.query.termo || '').trim();
        const cpfDigitos = sanitizarCPF(termo);

        if (!termo) return res.json([]);

        let atletas = [];
        if (cpfDigitos && cpfDigitos.length >= 3) {
            atletas = db.prepare(`
                SELECT * FROM atletas
                WHERE cpf LIKE ? OR LOWER(nome) LIKE LOWER(?)
                ORDER BY id DESC
                LIMIT 15
            `).all(`%${cpfDigitos}%`, `%${termo}%`);
        } else {
            atletas = db.prepare(`
                SELECT * FROM atletas
                WHERE LOWER(nome) LIKE LOWER(?)
                ORDER BY id DESC
                LIMIT 15
            `).all(`%${termo}%`);
        }
        res.json(atletas);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/atletas/verificar_cpf/:cpf', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const cpfLimpo = sanitizarCPF(req.params.cpf);
        if (!cpfLimpo || cpfLimpo.length !== 11) {
            return res.json({ encontrado: false, atletas: [] });
        }
        const atletas = db.prepare(`
            SELECT * FROM atletas
            WHERE cpf = ?
            ORDER BY id DESC
            LIMIT 5
        `).all(cpfLimpo);

        res.json({
            encontrado: atletas.length > 0,
            atleta: atletas[0] || null,
            atletas
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/inscricoes/evento/:evento_id', (req, res) => {
    try {
        const inscricoes = db.prepare(`
            SELECT 
                i.*, 
                a.nome, a.cpf, a.data_nascimento, a.sexo, a.whatsapp, a.cidade, a.estado, a.equipe, a.pcd,
                a.instagram, a.youtube, a.outros_social
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ?
            ORDER BY a.nome ASC
        `).all(req.params.evento_id);
        res.json(inscricoes);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.post('/api/inscricoes', exigirMaquinaLocalAPI, async (req, res) => {
    const {
        evento_id, nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd,
        instagram, youtube, outros_social,
        modalidade_escolhida, equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida,
        atleta_id_existente,
        forcar_novo_atleta,
        confirmar_cancelar_sync
    } = req.body || {};

    const nomeLimpo = String(nome || '').trim();
    const cpfLimpo = sanitizarCPF(cpf);
    const modalLimpa = String(modalidade_escolhida || 'Full Power').trim() || 'Full Power';
    const catPesoLimpa = String(categoria_peso_escolhida || 'Livre').trim() || 'Livre';
    const sexoLimpo = String(sexo || 'M').trim() === 'F' ? 'F' : 'M';
    const instaLimpo = String(instagram || '').trim() || null;
    const ytLimpo = String(youtube || '').trim() || null;
    const outrosSocialLimpo = String(outros_social || '').trim() || null;

    if (!evento_id || !nomeLimpo) {
        return res.status(400).json({ erro: "Evento e nome do atleta são obrigatórios." });
    }

    try {
        const divisaoNormalizada = normalizarDivisoesParaBanco(divisao_escolhida);
        const equipamentoNormalizado = String(equipamento_escolhido || 'Raw').trim() || 'Raw';
        const loteInicial = Math.floor(Math.random() * 9000) + 1000;

        // Verifica se é um clique duplo antes de checar o teto da licença
        const jaExisteDuplicado = db.prepare(`
            SELECT i.id
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ?
              AND LOWER(a.nome) = LOWER(?)
              AND i.modalidade_escolhida = ?
              AND COALESCE(i.equipamento_escolhido, 'Raw') = ?
              AND i.categoria_peso_escolhida = ?
              AND i.divisao_escolhida = ?
            LIMIT 1
        `).get(
            evento_id,
            nomeLimpo,
            modalLimpa,
            equipamentoNormalizado,
            catPesoLimpa,
            divisaoNormalizada
        );

        if (jaExisteDuplicado) {
            return res.json({ sucesso: true, inscricao_id: jaExisteDuplicado.id, aviso_duplicado: true });
        }

        // Verifica o teto de inscrições da licença na nuvem (caso o campeonato esteja sincronizando com a nuvem)
        const checkLimiteInsc = await verificarLimiteLicencaParaNovaInscricao(evento_id);
        let cancelarSyncNesteEvento = false;

        if (checkLimiteInsc.atingiu_limite) {
            if (!confirmar_cancelar_sync) {
                const msgAviso = "O cadastro de um novo usuário na plataforma offline fará com que a sincronização com a nuvem seja encerrada. Remova alguma inscrição ou campeonato inativo para poder cadastrar mais atletas sem perder a sincronização.";
                return res.status(409).json({
                    requer_confirmacao_limite_nuvem: true,
                    tipo_limite: 'INSCRICOES',
                    erro: msgAviso,
                    mensagem: msgAviso
                });
            }
            cancelarSyncNesteEvento = true;
        }

        const transaction = db.transaction(() => {
            if (cancelarSyncNesteEvento) {
                db.prepare('UPDATE eventos SET sync_nuvem = -1 WHERE id = ?').run(evento_id);
                registrarLogSeguranca(null, 'sync_nuvem_encerrado_nova_inscricao', {
                    evento_id,
                    atleta_nome: nomeLimpo
                });
            }

            let idAtleta = null;

            if (atleta_id_existente && !forcar_novo_atleta) {
                const confirmado = db.prepare('SELECT id FROM atletas WHERE id = ?').get(Number(atleta_id_existente));
                if (confirmado) idAtleta = confirmado.id;
            } else if (cpfLimpo && !forcar_novo_atleta) {
                const atletaMesmoCpf = db.prepare('SELECT id, nome FROM atletas WHERE cpf = ? ORDER BY id DESC LIMIT 1').get(cpfLimpo);
                if (atletaMesmoCpf && String(atletaMesmoCpf.nome || '').trim().toLowerCase() === nomeLimpo.toLowerCase()) {
                    idAtleta = atletaMesmoCpf.id;
                }
            }

            if (idAtleta) {
                db.prepare(`
                    UPDATE atletas
                    SET nome = ?, cpf = COALESCE(?, cpf), data_nascimento = ?, sexo = ?, whatsapp = ?, cidade = ?, estado = ?, equipe = ?, pcd = ?,
                        instagram = COALESCE(?, instagram), youtube = COALESCE(?, youtube), outros_social = COALESCE(?, outros_social)
                    WHERE id = ?
                `).run(
                    nomeLimpo,
                    cpfLimpo,
                    String(data_nascimento || '').trim(),
                    sexoLimpo,
                    String(whatsapp || '').trim(),
                    String(cidade || '').trim(),
                    String(estado || '').trim(),
                    String(equipe || 'Sem Equipe').trim() || 'Sem Equipe',
                    pcd ? 1 : 0,
                    instaLimpo,
                    ytLimpo,
                    outrosSocialLimpo,
                    idAtleta
                );
            } else {
                const stmtAtleta = db.prepare(`
                    INSERT INTO atletas (nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd, instagram, youtube, outros_social) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                idAtleta = stmtAtleta.run(
                    nomeLimpo,
                    cpfLimpo,
                    String(data_nascimento || '').trim(),
                    sexoLimpo,
                    String(whatsapp || '').trim(),
                    String(cidade || '').trim(),
                    String(estado || '').trim(),
                    String(equipe || 'Sem Equipe').trim() || 'Sem Equipe',
                    pcd ? 1 : 0,
                    instaLimpo,
                    ytLimpo,
                    outrosSocialLimpo
                ).lastInsertRowid;
            }

            const stmtInsc = db.prepare(`
                INSERT INTO inscricoes 
                (evento_id, atleta_id, modalidade_escolhida, equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida, numero_lote, versao, anonimizar_historico, origem_inscricao) 
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'APP')
            `);
            const idInscricao = stmtInsc.run(
                evento_id,
                idAtleta,
                modalLimpa,
                equipamentoNormalizado,
                divisaoNormalizada,
                catPesoLimpa,
                loteInicial
            ).lastInsertRowid;

            garantirPrimeirasTentativasInscricao(idInscricao, modalLimpa);
            marcarEventoParaSyncNuvem(evento_id);

            return { duplicado: false, id: idInscricao, atleta_id: idAtleta };
        });

        const resultado = transaction();
        io.emit('dados_atletas_atualizados', { evento_id, acao: 'nova_inscricao', inscricao_id: resultado.id });
        res.json({
            sucesso: true,
            inscricao_id: resultado.id,
            atleta_id: resultado.atleta_id,
            aviso_duplicado: resultado.duplicado,
            sync_cancelado: cancelarSyncNesteEvento
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.put('/api/inscricoes/:inscricao_id', exigirMaquinaLocalAPI, (req, res) => {
    const inscricaoId = req.params.inscricao_id;
    const {
        nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd,
        instagram, youtube, outros_social,
        modalidade_escolhida, equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida,
        versao
    } = req.body || {};

    const nomeLimpo = String(nome || '').trim();
    if (!nomeLimpo) {
        return res.status(400).json({ erro: "O nome do atleta não pode ficar vazio." });
    }

    const cpfLimpo = sanitizarCPF(cpf);
    const instaLimpo = String(instagram || '').trim() || null;
    const ytLimpo = String(youtube || '').trim() || null;
    const outrosSocialLimpo = String(outros_social || '').trim() || null;

    try {
        let tentativasExcluidasIds = [];

        const resultado = db.transaction(() => {
            const atual = db.prepare('SELECT * FROM inscricoes WHERE id = ?').get(inscricaoId);
            if (!atual) {
                return { status: 404, body: { erro: "Inscrição não encontrada." } };
            }

            if (versao !== undefined && versao !== null && Number(versao) !== Number(atual.versao)) {
                return {
                    status: 409,
                    body: {
                        conflito: true,
                        erro: "⚠️ CONFLITO EVITADO: Outro aparelho acabou de atualizar este atleta! Os dados mais recentes foram recarregados na sua tela."
                    }
                };
            }

            const atletaAnterior = db.prepare('SELECT * FROM atletas WHERE id = ?').get(atual.atleta_id);
            const divisaoNormalizada = normalizarDivisoesParaBanco(divisao_escolhida);
            const equipamentoNormalizado = String(equipamento_escolhido || atual.equipamento_escolhido || 'Raw').trim() || 'Raw';
            const modalLimpa = String(modalidade_escolhida || atual.modalidade_escolhida || 'Full Power').trim();
            const catPesoLimpa = String(categoria_peso_escolhida || atual.categoria_peso_escolhida).trim();
            const sexoLimpo = String(sexo || 'M').trim() === 'F' ? 'F' : 'M';

            const outrasInscricoesMesmoAtleta = db.prepare(`
                SELECT COUNT(1) as qtd FROM inscricoes WHERE atleta_id = ? AND id != ?
            `).get(atual.atleta_id, inscricaoId)?.qtd || 0;

            const trocouIdentidadePessoa = atletaAnterior && (
                String(atletaAnterior.nome || '').trim().toLowerCase() !== nomeLimpo.toLowerCase() ||
                String(atletaAnterior.sexo || 'M') !== sexoLimpo
            );

            let idAtletaFinal = atual.atleta_id;
            if (outrasInscricoesMesmoAtleta > 0 && trocouIdentidadePessoa) {
                idAtletaFinal = db.prepare(`
                    INSERT INTO atletas (nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd, instagram, youtube, outros_social)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    nomeLimpo,
                    cpfLimpo,
                    String(data_nascimento || '').trim(),
                    sexoLimpo,
                    String(whatsapp || '').trim(),
                    String(cidade || '').trim(),
                    String(estado || '').trim(),
                    String(equipe || 'Sem Equipe').trim() || 'Sem Equipe',
                    pcd ? 1 : 0,
                    instaLimpo,
                    ytLimpo,
                    outrosSocialLimpo
                ).lastInsertRowid;
            } else {
                db.prepare(`
                    UPDATE atletas
                    SET nome = ?, cpf = ?, data_nascimento = ?, sexo = ?, whatsapp = ?, cidade = ?, estado = ?, equipe = ?, pcd = ?,
                        instagram = ?, youtube = ?, outros_social = ?
                    WHERE id = ?
                `).run(
                    nomeLimpo,
                    cpfLimpo,
                    String(data_nascimento || '').trim(),
                    sexoLimpo,
                    String(whatsapp || '').trim(),
                    String(cidade || '').trim(),
                    String(estado || '').trim(),
                    String(equipe || 'Sem Equipe').trim() || 'Sem Equipe',
                    pcd ? 1 : 0,
                    instaLimpo,
                    ytLimpo,
                    outrosSocialLimpo,
                    idAtletaFinal
                );
            }

            const movsAtivos = obterMovimentosDaModalidade(modalLimpa);
            const fazAgachamento = movsAtivos.includes('agachamento');
            const fazSupino = movsAtivos.includes('supino');
            const fazTerra = movsAtivos.includes('terra');

            let novaBatAgacho = fazAgachamento ? atual.bateria_agachamento : null;
            let novaBatSupino = fazSupino ? atual.bateria_supino : null;
            let novaBatTerra = fazTerra ? atual.bateria_terra : null;
            let novaPlatAgacho = fazAgachamento ? validarPlataforma(atual.plataforma_agachamento || 1) : 1;
            let novaPlatSupino = fazSupino ? validarPlataforma(atual.plataforma_supino || 1) : 1;
            let novaPlatTerra = fazTerra ? validarPlataforma(atual.plataforma_terra || 1) : 1;

            const mudouChaveAgrupamento = (
                (atletaAnterior && atletaAnterior.sexo !== sexoLimpo) ||
                atual.categoria_peso_escolhida !== catPesoLimpa ||
                atual.divisao_escolhida !== divisaoNormalizada ||
                atual.modalidade_escolhida !== modalLimpa ||
                (atual.equipamento_escolhido || 'Raw') !== equipamentoNormalizado
            );

            // Se mudou de categoria/divisão, tenta encontrar bateria do novo grupo; se não houver, PRESERVA a bateria atual (nunca desagrupa o atleta para NULL no meio do evento!)
            if (mudouChaveAgrupamento && Number(atual.remanejado_manual) === 0) {
                const ajustarBateriaDoMovimento = (mov, batAtual, platAtual) => {
                    const temConcluida = db.prepare(`
                        SELECT COUNT(1) as qtd FROM tentativas
                        WHERE inscricao_id = ? AND movimento = ? AND estado = 'concluido'
                    `).get(inscricaoId, mov)?.qtd || 0;

                    if (temConcluida > 0) {
                        return { bat: batAtual, plat: platAtual };
                    }
                    const batExistente = buscarBateriaExistenteParaGrupo(
                        atual.evento_id,
                        inscricaoId,
                        mov,
                        catPesoLimpa,
                        modalLimpa,
                        equipamentoNormalizado,
                        sexoLimpo
                    );
                    if (batExistente && batExistente.nome_bateria) {
                        return { bat: batExistente.nome_bateria, plat: validarPlataforma(batExistente.plat) };
                    }
                    // Mantém a bateria atual caso já estivesse alocado (evita sumir da Mesa em campeonatos com Bateria Única)
                    return { bat: batAtual || null, plat: batAtual ? platAtual : 1 };
                };

                if (fazAgachamento) {
                    const resAg = ajustarBateriaDoMovimento('agachamento', novaBatAgacho, novaPlatAgacho);
                    novaBatAgacho = resAg.bat;
                    novaPlatAgacho = resAg.plat;
                }
                if (fazSupino) {
                    const resSup = ajustarBateriaDoMovimento('supino', novaBatSupino, novaPlatSupino);
                    novaBatSupino = resSup.bat;
                    novaPlatSupino = resSup.plat;
                }
                if (fazTerra) {
                    const resTer = ajustarBateriaDoMovimento('terra', novaBatTerra, novaPlatTerra);
                    novaBatTerra = resTer.bat;
                    novaPlatTerra = resTer.plat;
                }
            }

            const coletarERemoverMovimento = (mov) => {
                const removidas = db.prepare(`SELECT id FROM tentativas WHERE inscricao_id = ? AND movimento = ? AND estado != 'concluido'`).all(inscricaoId, mov);
                removidas.forEach(r => tentativasExcluidasIds.push(r.id));
                db.prepare(`DELETE FROM tentativas WHERE inscricao_id = ? AND movimento = ? AND estado != 'concluido'`).run(inscricaoId, mov);
            };

            if (!fazAgachamento) coletarERemoverMovimento('agachamento');
            if (!fazSupino) coletarERemoverMovimento('supino');
            if (!fazTerra) coletarERemoverMovimento('terra');

            garantirPrimeirasTentativasInscricao(inscricaoId, modalLimpa);

            db.prepare(`
                UPDATE inscricoes
                SET atleta_id = ?,
                    modalidade_escolhida = ?,
                    equipamento_escolhido = ?,
                    divisao_escolhida = ?,
                    categoria_peso_escolhida = ?,
                    bateria_agachamento = ?,
                    bateria_supino = ?,
                    bateria_terra = ?,
                    plataforma_agachamento = ?,
                    plataforma_supino = ?,
                    plataforma_terra = ?,
                    versao = COALESCE(versao, 1) + 1
                WHERE id = ?
            `).run(
                idAtletaFinal,
                modalLimpa,
                equipamentoNormalizado,
                divisaoNormalizada,
                catPesoLimpa,
                novaBatAgacho,
                novaBatSupino,
                novaBatTerra,
                novaPlatAgacho,
                novaPlatSupino,
                novaPlatTerra,
                inscricaoId
            );

            marcarEventoParaSyncNuvem(atual.evento_id);
            registrarLogSeguranca(inscricaoId, 'edicao_atleta', { nome: nomeLimpo, cpf: cpfLimpo, modalidade_escolhida: modalLimpa, categoria_peso_escolhida: catPesoLimpa });
            return { status: 200, body: { sucesso: true }, evento_id: atual.evento_id };
        })();

        if (resultado.status !== 200) {
            return res.status(resultado.status).json(resultado.body);
        }

        tentativasExcluidasIds.forEach(tId => limparTentativaDePlataformasAtivas(tId));

        for (let p = 1; p <= 5; p++) {
            const atualPlat = estadoPlataformas[p]?.atletaAtual;
            if (atualPlat && Number(atualPlat.inscricao_id) === Number(inscricaoId)) {
                estadoPlataformas[p].atletaAtual.nome = nomeLimpo;
                emitirEstadoPlataforma(p, false);
            }
        }

        sincronizarTodasPlataformasComBanco();
        io.emit('dados_atletas_atualizados', { evento_id: resultado.evento_id, acao: 'edicao_inscricao', inscricao_id: inscricaoId });
        io.emit('fila_atualizada', { evento_id: resultado.evento_id });
        res.json(resultado.body);
    } catch (erro) {
        console.error("Erro ao editar atleta:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

app.put('/api/inscricoes/:inscricao_id/arquivar', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        await criarSnapshotSeguranca('arquivar_atleta');

        const inscricaoId = req.params.inscricao_id;
        let eventoOriginalId = null;
        let tentativasRemovidas = [];

        db.transaction(() => {
            const insc = db.prepare('SELECT evento_id FROM inscricoes WHERE id = ?').get(inscricaoId);
            if (insc) eventoOriginalId = insc.evento_id;

            tentativasRemovidas = db.prepare('SELECT id FROM tentativas WHERE inscricao_id = ?').all(inscricaoId).map(t => t.id);

            let arquivo = db.prepare("SELECT id FROM eventos WHERE nome = 'Cadastros Cancelados'").get();
            if (!arquivo) {
                const info = db.prepare(`
                    INSERT INTO eventos (nome, data, modalidades, divisoes_idade, categorias_peso_masculino, categorias_peso_feminino, sync_nuvem) 
                    VALUES ('Cadastros Cancelados', '2099-12-31', '[]', '[]', '[]', '[]', 1)
                `).run();
                arquivo = { id: info.lastInsertRowid };
            }

            db.prepare(`
                UPDATE inscricoes 
                SET evento_id = ?, bateria_agachamento = NULL, bateria_supino = NULL, bateria_terra = NULL, versao = COALESCE(versao, 1) + 1
                WHERE id = ?
            `).run(arquivo.id, inscricaoId);

            db.prepare('DELETE FROM tentativas WHERE inscricao_id = ?').run(inscricaoId);
            if (eventoOriginalId) marcarEventoParaSyncNuvem(eventoOriginalId);
            registrarLogSeguranca(inscricaoId, 'arquivar_inscricao', { de_evento: eventoOriginalId, para_evento: arquivo.id });
        })();

        // Invalida o cache de quota da licença para permitir novas inscrições imediatamente após arquivar
        if (typeof cacheQuotaLicencaNuvem === 'object' && cacheQuotaLicencaNuvem) {
            cacheQuotaLicencaNuvem.atualizado_em = 0;
        }

        tentativasRemovidas.forEach(tId => limparTentativaDePlataformasAtivas(tId, inscricaoId));

        if (eventoOriginalId) {
            io.emit('dados_atletas_atualizados', { evento_id: eventoOriginalId, acao: 'arquivado', inscricao_id: inscricaoId });
            io.emit('fila_atualizada', { evento_id: eventoOriginalId });
        }
        res.json({ sucesso: true });
    } catch (erro) {
        console.error("Erro ao arquivar inscrição:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// ROTAS DE AGRUPAMENTO, REMANEJAMENTO INDIVIDUAL E BATERIAS AVULSAS (PR / 4ª TENTATIVA)
// ============================================================================

app.get('/api/agrupamentos/:evento_id', (req, res) => {
    try {
        const grupos = db.prepare(`
            SELECT 
                a.sexo, 
                i.divisao_escolhida, 
                i.categoria_peso_escolhida, 
                i.modalidade_escolhida,
                i.equipamento_escolhido,
                COUNT(i.id) as qtd_atletas,
                i.bateria_agachamento as bateria
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ?
            GROUP BY a.sexo, i.divisao_escolhida, i.categoria_peso_escolhida, i.modalidade_escolhida, i.equipamento_escolhido, i.bateria_agachamento
            ORDER BY i.modalidade_escolhida ASC, i.equipamento_escolhido ASC, a.sexo ASC, i.divisao_escolhida ASC
        `).all(req.params.evento_id);

        res.json(grupos);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/agrupamentos/:evento_id/:movimento', (req, res) => {
    const evento_id = req.params.evento_id;
    const movimento = validarMovimento(req.params.movimento);
    const excluidas = obterFiltroModalidadesExcluidas(movimento);
    const placeholders = excluidas.map(() => '?').join(',');
    const colunaBateria = 'bateria_' + movimento;
    const colunaPlataforma = 'plataforma_' + movimento;

    try {
        const grupos = db.prepare(`
            SELECT 
                a.sexo, 
                i.divisao_escolhida, 
                i.categoria_peso_escolhida, 
                i.modalidade_escolhida,
                COALESCE(i.equipamento_escolhido, 'Raw') as equipamento_escolhido,
                COUNT(i.id) as qtd_atletas, 
                i.${colunaBateria} as bateria,
                COALESCE(i.${colunaPlataforma}, 1) as plataforma
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ? AND i.modalidade_escolhida NOT IN (${placeholders})
            GROUP BY a.sexo, i.divisao_escolhida, i.categoria_peso_escolhida, i.modalidade_escolhida, COALESCE(i.equipamento_escolhido, 'Raw'), i.${colunaBateria}, COALESCE(i.${colunaPlataforma}, 1)
            ORDER BY i.modalidade_escolhida ASC, equipamento_escolhido ASC, a.sexo ASC, i.categoria_peso_escolhida ASC
        `).all(evento_id, ...excluidas);

        res.json(grupos);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.post('/api/baterias/agrupar', exigirMaquinaLocalAPI, (req, res) => {
    const { evento_id, movimento, nome_bateria, plataforma, grupos_selecionados, aplicar_todos_movimentos } = req.body || {};
    const movPrincipal = validarMovimento(movimento);
    const platSegura = validarPlataforma(plataforma || 1);
    const nomeBatLimpo = String(nome_bateria || '').trim();

    if (!evento_id || !nomeBatLimpo) {
        return res.status(400).json({ erro: "Nome da bateria e evento são obrigatórios." });
    }

    const movimentosAlvo = aplicar_todos_movimentos ? MOVIMENTOS_VALIDOS : [movPrincipal];

    try {
        const transaction = db.transaction(() => {
            movimentosAlvo.forEach(movAlvo => {
                const colunaBateria = 'bateria_' + movAlvo;
                const colunaPlataforma = 'plataforma_' + movAlvo;
                const excluidas = obterFiltroModalidadesExcluidas(movAlvo);

                const updateStmtComBateriaEspecifica = db.prepare(`
                    UPDATE inscricoes 
                    SET ${colunaBateria} = ?, ${colunaPlataforma} = ?, remanejado_manual = 0
                    WHERE evento_id = ? 
                      AND divisao_escolhida = ? 
                      AND categoria_peso_escolhida = ? 
                      AND modalidade_escolhida = ?
                      AND COALESCE(equipamento_escolhido, 'Raw') = ?
                      AND COALESCE(${colunaBateria}, '') = COALESCE(?, '')
                      AND COALESCE(${colunaPlataforma}, 1) = COALESCE(?, 1)
                      AND atleta_id IN (SELECT id FROM atletas WHERE sexo = ?)
                `);

                const updateStmtGeral = db.prepare(`
                    UPDATE inscricoes 
                    SET ${colunaBateria} = ?, ${colunaPlataforma} = ?, remanejado_manual = 0
                    WHERE evento_id = ? 
                      AND divisao_escolhida = ? 
                      AND categoria_peso_escolhida = ? 
                      AND modalidade_escolhida = ?
                      AND COALESCE(equipamento_escolhido, 'Raw') = ?
                      AND atleta_id IN (SELECT id FROM atletas WHERE sexo = ?)
                `);

                for (const g of (grupos_selecionados || [])) {
                    if (excluidas.includes(g.modalidade)) continue;

                    if (movAlvo === movPrincipal && g.bateria_atual !== undefined) {
                        updateStmtComBateriaEspecifica.run(
                            nomeBatLimpo,
                            platSegura,
                            evento_id,
                            g.divisao,
                            g.categoria,
                            g.modalidade,
                            g.equipamento || 'Raw',
                            g.bateria_atual || '',
                            validarPlataforma(g.plataforma_atual || 1),
                            g.sexo
                        );
                    } else {
                        updateStmtGeral.run(
                            nomeBatLimpo,
                            platSegura,
                            evento_id,
                            g.divisao,
                            g.categoria,
                            g.modalidade,
                            g.equipamento || 'Raw',
                            g.sexo
                        );
                    }
                }
            });

            marcarEventoParaSyncNuvem(evento_id);
        });

        transaction();
        garantirPrimeirasTentativasEvento(evento_id);
        sincronizarTodasPlataformasComBanco();
        io.emit('fila_atualizada', { evento_id, movimento: movPrincipal });
        res.json({ sucesso: true });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/baterias/atletas_movimento/:evento_id/:movimento', (req, res) => {
    const evento_id = req.params.evento_id;
    const movSeguro = validarMovimento(req.params.movimento);
    const colBat = `bateria_${movSeguro}`;
    const colPlat = `plataforma_${movSeguro}`;
    const excluidas = obterFiltroModalidadesExcluidas(movSeguro);
    const placeholders = excluidas.map(() => '?').join(',');

    try {
        garantirPrimeirasTentativasEvento(evento_id);

        const atletas = db.prepare(`
            SELECT 
                i.id as inscricao_id,
                a.nome,
                a.cpf,
                a.sexo,
                i.modalidade_escolhida,
                COALESCE(i.equipamento_escolhido, 'Raw') as equipamento_escolhido,
                i.divisao_escolhida,
                i.categoria_peso_escolhida,
                i.${colBat} as bateria,
                COALESCE(i.${colPlat}, 1) as plataforma,
                COALESCE(i.remanejado_manual, 0) as remanejado_manual,
                MAX(t.numero_tentativa) as max_tentativa,
                SUM(CASE WHEN t.estado = 'pendente' THEN 1 ELSE 0 END) as qtd_pendentes,
                SUM(CASE WHEN t.estado = 'concluido' THEN 1 ELSE 0 END) as qtd_concluidas
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            LEFT JOIN tentativas t ON t.inscricao_id = i.id AND t.movimento = ?
            WHERE i.evento_id = ? AND i.modalidade_escolhida NOT IN (${placeholders})
            GROUP BY i.id
            ORDER BY a.nome ASC
        `).all(movSeguro, evento_id, ...excluidas);

        res.json(atletas);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.post('/api/baterias/remanejar_atletas', exigirMaquinaLocalAPI, (req, res) => {
    const {
        evento_id,
        movimento,
        nome_bateria,
        plataforma,
        inscricoes_ids,
        modo_avulsa_extra,
        peso_inicial_extra,
        aplicar_todos_movimentos,
        remover_da_bateria
    } = req.body || {};

    const movPrincipal = validarMovimento(movimento);
    const platSegura = validarPlataforma(plataforma || 1);
    const nomeBatLimpo = String(nome_bateria || '').trim();
    const pesoExtraSeguro = sanitizarPeso(peso_inicial_extra, false);
    const ehRemocao = Boolean(remover_da_bateria);

    if (!evento_id || !Array.isArray(inscricoes_ids) || inscricoes_ids.length === 0) {
        return res.status(400).json({ erro: "Selecione pelo menos um atleta." });
    }

    if (!ehRemocao && !nomeBatLimpo) {
        return res.status(400).json({ erro: "Informe o nome da bateria de destino." });
    }

    try {
        let qtdAtualizados = 0;
        let qtdTentativasExtrasCriadas = 0;

        db.transaction(() => {
            inscricoes_ids.forEach(idBruto => {
                const inscId = Number(idBruto);
                if (!inscId) return;

                const insc = db.prepare('SELECT id, modalidade_escolhida FROM inscricoes WHERE id = ? AND evento_id = ?').get(inscId, evento_id);
                if (!insc) return;

                const movsAtivosAtleta = obterMovimentosDaModalidade(insc.modalidade_escolhida);
                const movsParaAlocar = aplicar_todos_movimentos
                    ? movsAtivosAtleta
                    : [movPrincipal];

                if (ehRemocao) {
                    // Remove da bateria e marca remanejado_manual = 1 para que o auto_sincronizar não o reagrupe sozinho
                    movsParaAlocar.forEach(m => {
                        const colB = `bateria_${m}`;
                        const colP = `plataforma_${m}`;
                        db.prepare(`
                            UPDATE inscricoes
                            SET ${colB} = NULL, ${colP} = 1,
                                remanejado_manual = 1,
                                versao = COALESCE(versao, 1) + 1
                            WHERE id = ? AND evento_id = ?
                        `).run(inscId, evento_id);
                    });
                    qtdAtualizados++;
                    return;
                }

                movsParaAlocar.forEach(m => {
                    const colB = `bateria_${m}`;
                    const colP = `plataforma_${m}`;
                    db.prepare(`
                        UPDATE inscricoes
                        SET ${colB} = ?, ${colP} = ?,
                            remanejado_manual = 1,
                            versao = COALESCE(versao, 1) + 1
                        WHERE id = ? AND evento_id = ?
                    `).run(nomeBatLimpo, platSegura, inscId, evento_id);
                });

                qtdAtualizados++;
                garantirPrimeirasTentativasInscricao(inscId, insc.modalidade_escolhida);

                if (modo_avulsa_extra) {
                    const tentPendente = db.prepare(`
                        SELECT id FROM tentativas
                        WHERE inscricao_id = ? AND movimento = ? AND estado = 'pendente'
                        ORDER BY numero_tentativa DESC LIMIT 1
                    `).get(inscId, movPrincipal);

                    const tentAguardando = db.prepare(`
                        SELECT id FROM tentativas
                        WHERE inscricao_id = ? AND movimento = ? AND estado = 'aguardando_pedida'
                        ORDER BY numero_tentativa DESC LIMIT 1
                    `).get(inscId, movPrincipal);

                    if (tentPendente) {
                        if (pesoExtraSeguro > 0) {
                            db.prepare('UPDATE tentativas SET peso_solicitado = ?, sync_nuvem = 0 WHERE id = ?')
                                .run(pesoExtraSeguro, tentPendente.id);
                        }
                    } else if (tentAguardando) {
                        db.prepare(`
                            UPDATE tentativas
                            SET estado = 'pendente',
                                peso_solicitado = CASE WHEN ? > 0 THEN ? ELSE peso_solicitado END,
                                sync_nuvem = 0
                            WHERE id = ?
                        `).run(pesoExtraSeguro, pesoExtraSeguro, tentAguardando.id);
                    } else {
                        const maxRow = db.prepare(`
                            SELECT COALESCE(MAX(numero_tentativa), 0) as max_num
                            FROM tentativas
                            WHERE inscricao_id = ? AND movimento = ?
                        `).get(inscId, movPrincipal);

                        const novaTentativaNum = (maxRow?.max_num || 0) + 1;
                        db.prepare(`
                            INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado, sync_nuvem)
                            VALUES (?, ?, ?, ?, 'pendente', 0)
                        `).run(inscId, movPrincipal, novaTentativaNum, pesoExtraSeguro);
                        qtdTentativasExtrasCriadas++;
                    }
                }
            });

            marcarEventoParaSyncNuvem(evento_id);
            registrarLogSeguranca(null, ehRemocao ? 'remover_atletas_bateria' : 'remanejar_atletas_bateria', {
                evento_id,
                movimento: movPrincipal,
                nome_bateria: ehRemocao ? null : nomeBatLimpo,
                plataforma: platSegura,
                qtd_atletas: qtdAtualizados,
                remover_da_bateria: ehRemocao,
                modo_avulsa_extra: Boolean(modo_avulsa_extra),
                tentativas_extras: qtdTentativasExtrasCriadas
            });
        })();

        sincronizarTodasPlataformasComBanco();
        io.emit('dados_atletas_atualizados', { evento_id, acao: ehRemocao ? 'remocao_bateria' : 'remanejamento_bateria' });
        io.emit('fila_atualizada', { evento_id, movimento: movPrincipal });

        res.json({
            sucesso: true,
            remanejados: qtdAtualizados,
            removidos: ehRemocao ? qtdAtualizados : 0,
            tentativas_extras_criadas: qtdTentativasExtrasCriadas
        });
    } catch (erro) {
        console.error("Erro ao remanejar/remover atletas da bateria:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

app.post('/api/baterias/excluir', async (req, res) => {
    const { evento_id, movimento, nome_bateria, plataforma } = req.body || {};
    const movSeguro = validarMovimento(movimento);
    const colunaBateria = 'bateria_' + movSeguro;
    const colunaPlataforma = 'plataforma_' + movSeguro;
    const filtroPlat = plataforma !== undefined && plataforma !== null && plataforma !== ''
        ? validarPlataforma(plataforma)
        : null;

    try {
        await criarSnapshotSeguranca('excluir_bateria');

        let info;
        if (filtroPlat !== null) {
            info = db.prepare(`
                UPDATE inscricoes 
                SET ${colunaBateria} = NULL, ${colunaPlataforma} = 1, remanejado_manual = 0
                WHERE evento_id = ? AND ${colunaBateria} = ? AND COALESCE(${colunaPlataforma}, 1) = ?
            `).run(evento_id, nome_bateria, filtroPlat);
        } else {
            info = db.prepare(`
                UPDATE inscricoes 
                SET ${colunaBateria} = NULL, ${colunaPlataforma} = 1, remanejado_manual = 0
                WHERE evento_id = ? AND ${colunaBateria} = ?
            `).run(evento_id, nome_bateria);
        }

        marcarEventoParaSyncNuvem(evento_id);
        registrarLogSeguranca(null, 'excluir_bateria', {
            evento_id,
            movimento: movSeguro,
            nome_bateria,
            plataforma: filtroPlat,
            desagrupados: info.changes
        });

        sincronizarTodasPlataformasComBanco();
        io.emit('fila_atualizada', { evento_id, movimento: movSeguro });
        res.json({ sucesso: true, desagrupados: info.changes });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/baterias_disponiveis/:evento_id/:movimento', (req, res) => {
    const evento_id = req.params.evento_id;
    const movSeguro = validarMovimento(req.params.movimento);
    const colunaBateria = 'bateria_' + movSeguro;
    const colunaPlataforma = 'plataforma_' + movSeguro;
    const filtroPlat = req.query.plataforma ? validarPlataforma(req.query.plataforma) : null;

    try {
        let sql = `
            SELECT DISTINCT ${colunaBateria} as bateria, COALESCE(${colunaPlataforma}, 1) as plataforma 
            FROM inscricoes 
            WHERE evento_id = ? AND ${colunaBateria} IS NOT NULL AND TRIM(${colunaBateria}) != ''
        `;
        const params = [evento_id];

        if (filtroPlat !== null) {
            sql += ` AND COALESCE(${colunaPlataforma}, 1) = ?`;
            params.push(filtroPlat);
        }

        sql += ` ORDER BY plataforma ASC, bateria ASC`;
        res.json(db.prepare(sql).all(...params));
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/baterias/auto_sincronizar/:evento_id', (req, res) => {
    try {
        const eventoId = req.params.evento_id;
        let houveAlteracao = false;

        db.transaction(() => {
            MOVIMENTOS_VALIDOS.forEach((mov) => {
                const colBat = `bateria_${mov}`;
                const colPlat = `plataforma_${mov}`;
                const excluidas = obterFiltroModalidadesExcluidas(mov);
                const placeholders = excluidas.map(() => '?').join(',');

                const pioneiros = db.prepare(`
                    SELECT 
                        i.modalidade_escolhida,
                        i.divisao_escolhida,
                        i.categoria_peso_escolhida,
                        COALESCE(i.equipamento_escolhido, 'Raw') as equip,
                        a.sexo,
                        MIN(i.${colBat}) as bat,
                        COALESCE(MIN(i.${colPlat}), 1) as plat
                    FROM inscricoes i
                    JOIN atletas a ON i.atleta_id = a.id
                    WHERE i.evento_id = ?
                      AND i.modalidade_escolhida NOT IN (${placeholders})
                      AND COALESCE(i.remanejado_manual, 0) = 0
                      AND i.${colBat} IS NOT NULL
                      AND TRIM(i.${colBat}) != ''
                    GROUP BY i.modalidade_escolhida, i.divisao_escolhida, i.categoria_peso_escolhida, COALESCE(i.equipamento_escolhido, 'Raw'), a.sexo
                    HAVING COUNT(DISTINCT i.${colBat}) = 1 AND COUNT(DISTINCT COALESCE(i.${colPlat}, 1)) = 1
                `).all(eventoId, ...excluidas);

                const stmtUpdate = db.prepare(`
                    UPDATE inscricoes 
                    SET ${colBat} = ?, ${colPlat} = ?
                    WHERE evento_id = ? 
                      AND modalidade_escolhida = ?
                      AND divisao_escolhida = ?
                      AND categoria_peso_escolhida = ?
                      AND COALESCE(equipamento_escolhido, 'Raw') = ?
                      AND atleta_id IN (SELECT id FROM atletas WHERE sexo = ?)
                      AND modalidade_escolhida NOT IN (${placeholders})
                      AND COALESCE(remanejado_manual, 0) = 0
                      AND ${colBat} IS NULL
                `);

                pioneiros.forEach(p => {
                    const info = stmtUpdate.run(
                        p.bat,
                        p.plat,
                        eventoId,
                        p.modalidade_escolhida,
                        p.divisao_escolhida,
                        p.categoria_peso_escolhida,
                        p.equip,
                        p.sexo,
                        ...excluidas
                    );
                    if (info.changes > 0) houveAlteracao = true;
                });
            });

            if (houveAlteracao) marcarEventoParaSyncNuvem(eventoId);
        })();

        garantirPrimeirasTentativasEvento(eventoId);
        res.json({ sucesso: true });
    } catch (erro) {
        console.error("Erro na auto-sincronização de baterias:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// ROTAS DE PESAGEM (COM CONTROLE DE CONCORRÊNCIA E PROTEÇÃO DE BATERIAS ATIVAS)
// ============================================================================

app.put('/api/pesagem/:inscricao_id', exigirSenhaGlobalAPI, (req, res) => {
    try {
        const inscricaoId = req.params.inscricao_id;
        const dados = req.body || {};
        const lote_aleatorio = Math.floor(Math.random() * 9000) + 1000;

        const resultadoTransacao = db.transaction(() => {
            const current = db.prepare(`
                SELECT i.*, a.sexo, a.nome
                FROM inscricoes i
                JOIN atletas a ON i.atleta_id = a.id
                WHERE i.id = ?
            `).get(inscricaoId);

            if (!current) {
                return { status: 404, body: { erro: "Inscrição não encontrada." } };
            }

            if (dados.versao !== undefined && dados.versao !== null && Number(dados.versao) !== Number(current.versao)) {
                return {
                    status: 409,
                    body: {
                        conflito: true,
                        erro: "⚠️ CONFLITO EVITADO: Outro mesário/aparelho acabou de salvar a pesagem deste atleta! A ficha foi atualizada com os dados mais recentes."
                    }
                };
            }

            const movsAtivos = obterMovimentosDaModalidade(current.modalidade_escolhida);

            let avisoRealocacao = null;
            if (dados.categoria_peso_escolhida && dados.categoria_peso_escolhida !== current.categoria_peso_escolhida) {
                db.prepare(`
                    UPDATE inscricoes 
                    SET categoria_peso_escolhida = ?
                    WHERE id = ?
                `).run(dados.categoria_peso_escolhida, inscricaoId);

                if (Number(current.remanejado_manual) === 1) {
                    avisoRealocacao = `Categoria alterada para ${dados.categoria_peso_escolhida}kg (bateria mantida pois o atleta foi alocado manualmente).`;
                } else {
                    const realocados = [];
                    const mantidos = [];

                    movsAtivos.forEach(mov => {
                        const colBat = `bateria_${mov}`;
                        const colPlat = `plataforma_${mov}`;

                        const concluidasNoMov = db.prepare(`
                            SELECT COUNT(1) as qtd FROM tentativas
                            WHERE inscricao_id = ? AND movimento = ? AND estado = 'concluido'
                        `).get(inscricaoId, mov)?.qtd || 0;

                        if (concluidasNoMov > 0) return;

                        const bateriaExistente = buscarBateriaExistenteParaGrupo(
                            current.evento_id,
                            inscricaoId,
                            mov,
                            dados.categoria_peso_escolhida,
                            current.modalidade_escolhida,
                            current.equipamento_escolhido,
                            current.sexo
                        );

                        if (bateriaExistente && bateriaExistente.nome_bateria) {
                            db.prepare(`UPDATE inscricoes SET ${colBat} = ?, ${colPlat} = ? WHERE id = ?`)
                                .run(bateriaExistente.nome_bateria, validarPlataforma(bateriaExistente.plat), inscricaoId);
                            realocados.push(`${mov}: ${bateriaExistente.nome_bateria}`);
                        } else if (current[colBat]) {
                            // Preserva a bateria atual se não houver outra bateria específica criada para a nova categoria
                            mantidos.push(`${mov}: ${current[colBat]}`);
                        }
                    });

                    if (realocados.length > 0) {
                        avisoRealocacao = `Categoria alterada para ${dados.categoria_peso_escolhida}kg (${realocados.join(', ')}).`;
                    } else if (mantidos.length > 0) {
                        avisoRealocacao = `Categoria alterada para ${dados.categoria_peso_escolhida}kg (bateria atual mantida: ${mantidos.join(', ')}).`;
                    } else {
                        avisoRealocacao = `Categoria alterada para ${dados.categoria_peso_escolhida}kg.`;
                    }
                }
            }

            const pesoCorporalSeguro = sanitizarPeso(dados.peso_corporal, false);
            const rackAgachoLimpo = dados.rack_agachamento ? String(dados.rack_agachamento).trim() : null;
            const rackSupinoLimpo = dados.rack_supino ? String(dados.rack_supino).trim() : null;
            const travaSupinoLimpa = dados.trava_supino ? String(dados.trava_supino).trim() : null;

            db.prepare(`
                UPDATE inscricoes 
                SET peso_corporal_oficial = ?, 
                    numero_lote = COALESCE(numero_lote, ?), 
                    rack_agachamento = ?, 
                    rack_supino = ?, 
                    trava_supino = ?,
                    versao = COALESCE(versao, 1) + 1
                WHERE id = ?
            `).run(
                pesoCorporalSeguro,
                lote_aleatorio,
                rackAgachoLimpo,
                rackSupinoLimpo,
                travaSupinoLimpa,
                inscricaoId
            );

            const salvarPrimeiraPedida = (movimento, valorBruto) => {
                if (!movsAtivos.includes(movimento)) {
                    db.prepare(`DELETE FROM tentativas WHERE inscricao_id = ? AND movimento = ? AND estado != 'concluido'`)
                        .run(inscricaoId, movimento);
                    return;
                }
                if (valorBruto === undefined || valorBruto === null) return;
                const pesoPedida = sanitizarPeso(valorBruto, false);

                const existente = db.prepare(`
                    SELECT id, estado FROM tentativas 
                    WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = 1
                `).get(inscricaoId, movimento);

                if (existente) {
                    if (existente.estado !== 'concluido') {
                        db.prepare(`UPDATE tentativas SET peso_solicitado = ?, estado = 'pendente', sync_nuvem = 0 WHERE id = ?`)
                            .run(pesoPedida, existente.id);
                    }
                } else {
                    db.prepare(`
                        INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado) 
                        VALUES (?, ?, 1, ?, 'pendente')
                    `).run(inscricaoId, movimento, pesoPedida);
                }
            };

            salvarPrimeiraPedida('agachamento', dados.pedida_agachamento);
            salvarPrimeiraPedida('supino', dados.pedida_supino);
            salvarPrimeiraPedida('terra', dados.pedida_terra);

            garantirPrimeirasTentativasInscricao(inscricaoId, current.modalidade_escolhida);
            marcarEventoParaSyncNuvem(current.evento_id);

            const atualizado = db.prepare('SELECT versao, rack_agachamento, rack_supino, trava_supino, categoria_peso_escolhida FROM inscricoes WHERE id = ?').get(inscricaoId);
            return {
                status: 200,
                evento_id: current.evento_id,
                atualizado,
                body: {
                    sucesso: true,
                    nova_versao: atualizado.versao,
                    aviso_realocacao: avisoRealocacao
                }
            };
        })();

        if (resultadoTransacao.status !== 200) {
            return res.status(resultadoTransacao.status).json(resultadoTransacao.body);
        }

        for (let p = 1; p <= 5; p++) {
            const estPlat = estadoPlataformas[p];
            const atualPlat = estPlat?.atletaAtual;
            if (atualPlat && Number(atualPlat.inscricao_id) === Number(inscricaoId)) {
                atualPlat.rack_agachamento = resultadoTransacao.atualizado.rack_agachamento;
                atualPlat.rack_supino = resultadoTransacao.atualizado.rack_supino;
                atualPlat.trava_supino = resultadoTransacao.atualizado.trava_supino;
                atualPlat.categoria_peso_escolhida = resultadoTransacao.atualizado.categoria_peso_escolhida;

                const idTentPlat = atualPlat.tentativa_id || atualPlat.id;
                if (idTentPlat && estPlat.resultado === null) {
                    const tentNoBanco = db.prepare('SELECT peso_solicitado, estado FROM tentativas WHERE id = ?').get(idTentPlat);
                    if (tentNoBanco && tentNoBanco.estado !== 'concluido') {
                        atualPlat.pesoNaBarra = tentNoBanco.peso_solicitado;
                    }
                }
                emitirEstadoPlataforma(p, false);
            }
        }

        sincronizarTodasPlataformasComBanco();
        io.emit('dados_atletas_atualizados', {
            evento_id: resultadoTransacao.evento_id,
            acao: 'pesagem_salva',
            inscricao_id: inscricaoId
        });
        io.emit('fila_atualizada', { evento_id: resultadoTransacao.evento_id });

        res.json(resultadoTransacao.body);
    } catch (erro) {
        console.error("Erro na pesagem:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/pedidas/:inscricao_id', (req, res) => {
    try {
        const pedidas = db.prepare(`
            SELECT movimento, peso_solicitado, estado 
            FROM tentativas 
            WHERE inscricao_id = ? AND numero_tentativa = 1
        `).all(req.params.inscricao_id);
        res.json(pedidas);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.get('/api/todas_pedidas/:evento_id', (req, res) => {
    try {
        const pedidas = db.prepare(`
            SELECT inscricao_id, movimento, peso_solicitado, estado 
            FROM tentativas 
            WHERE numero_tentativa = 1 AND inscricao_id IN (
                SELECT id FROM inscricoes WHERE evento_id = ?
            )
        `).all(req.params.evento_id);
        res.json(pedidas);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// ROTAS DA MESA DE CONTROLE (ADMIN), AQUECIMENTO E RESULTADOS (ISOLADAS POR PLATAFORMA)
// ============================================================================

function handlerAuditoriaBateria(req, res) {
    try {
        const evento_id = req.params.evento_id;
        const movSeguro = validarMovimento(req.params.movimento);
        const batDecodificada = obterBateriaDaRequisicao(req);
        const colunaBateria = `bateria_${movSeguro}`;
        const colunaPlataforma = `plataforma_${movSeguro}`;
        const filtroPlat = req.query.plataforma ? validarPlataforma(req.query.plataforma) : null;

        if (!batDecodificada) return res.json([]);

        garantirPrimeirasTentativasEvento(evento_id);

        let sql = `
            SELECT a.nome, i.peso_corporal_oficial, i.rack_agachamento, i.rack_supino, i.trava_supino, t.peso_solicitado, t.estado
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            LEFT JOIN tentativas t ON t.inscricao_id = i.id AND t.movimento = ? AND t.numero_tentativa = 1
            WHERE i.evento_id = ? AND i.${colunaBateria} = ?
        `;
        const params = [movSeguro, evento_id, batDecodificada];

        if (filtroPlat !== null) {
            sql += ` AND COALESCE(i.${colunaPlataforma}, 1) = ?`;
            params.push(filtroPlat);
        }

        const atletas = db.prepare(sql).all(...params);
        let faltantes = [];

        atletas.forEach(atleta => {
            if (atleta.estado === 'concluido') return;
            let pendencias = [];
            if (!atleta.peso_corporal_oficial) pendencias.push("Peso Corporal");
            if (movSeguro === 'agachamento' && (!atleta.rack_agachamento || atleta.rack_agachamento === '')) pendencias.push("Rack");
            if (movSeguro === 'supino' && (!atleta.rack_supino || !atleta.trava_supino || atleta.rack_supino === '' || atleta.trava_supino === '')) pendencias.push("Rack/Trava");
            if (atleta.peso_solicitado === null || Number(atleta.peso_solicitado) <= 0) pendencias.push("1ª Pedida (0kg)");

            if (pendencias.length > 0) {
                faltantes.push(`${atleta.nome} (Falta: ${pendencias.join(" + ")})`);
            }
        });

        res.json(faltantes);
    } catch (erro) {
        console.error("Erro na auditoria da bateria:", erro.message);
        res.status(500).json({ erro: erro.message });
    }
}

app.get('/api/auditoria_bateria/:evento_id/:movimento', handlerAuditoriaBateria);
app.get('/api/auditoria_bateria/:evento_id/:movimento/:bateria', handlerAuditoriaBateria);

// Fila Principal Ordenada ("A Barra Só Sobe" - Isolada por plataforma quando informada)
function handlerFilaBateria(req, res) {
    const evento_id = req.params.evento_id;
    const movSeguro = validarMovimento(req.params.movimento);
    const bateria_nome = obterBateriaDaRequisicao(req);
    const colunaBateria = 'i.bateria_' + movSeguro;
    const colunaPlataforma = 'i.plataforma_' + movSeguro;
    const filtroPlat = req.query.plataforma ? validarPlataforma(req.query.plataforma) : null;

    if (!bateria_nome) return res.json([]);

    try {
        garantirPrimeirasTentativasEvento(evento_id);

        let sql = `
            SELECT 
                t.id as tentativa_id,
                i.id as inscricao_id,
                a.nome, 
                t.numero_tentativa, 
                t.peso_solicitado, 
                i.peso_corporal_oficial,
                i.rack_agachamento, 
                i.rack_supino, 
                i.trava_supino,
                COALESCE(${colunaPlataforma}, 1) as plataforma
            FROM tentativas t 
            JOIN inscricoes i ON t.inscricao_id = i.id 
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ? AND t.movimento = ? AND ${colunaBateria} = ? AND t.estado = 'pendente'
        `;
        const params = [evento_id, movSeguro, bateria_nome];

        if (filtroPlat !== null) {
            sql += ` AND COALESCE(${colunaPlataforma}, 1) = ?`;
            params.push(filtroPlat);
        }

        sql += `
            ORDER BY 
                t.numero_tentativa ASC,
                CASE WHEN COALESCE(t.peso_solicitado, 0) <= 0 THEN 1 ELSE 0 END ASC,
                t.peso_solicitado ASC, 
                COALESCE(i.peso_corporal_oficial, 999) ASC, 
                COALESCE(i.numero_lote, 99999) ASC, 
                t.id ASC
        `;

        res.json(db.prepare(sql).all(...params));
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
}

app.get('/api/bateria/:evento_id/:movimento', handlerFilaBateria);
app.get('/api/bateria/:evento_id/:movimento/:bateria_nome', handlerFilaBateria);

// Fila de Atletas Aguardando Próxima Pedida (1 minuto - Preserva maior peso anterior mesmo se o atleta passou tentativa)
function handlerAguardandoPedida(req, res) {
    const evento_id = req.params.evento_id;
    const movSeguro = validarMovimento(req.params.movimento);
    const bateria_nome = obterBateriaDaRequisicao(req);
    const colunaBateria = 'i.bateria_' + movSeguro;
    const colunaPlataforma = 'i.plataforma_' + movSeguro;
    const filtroPlat = req.query.plataforma ? validarPlataforma(req.query.plataforma) : null;

    if (!bateria_nome) return res.json([]);

    try {
        let sql = `
            SELECT 
                t.id as tentativa_id,
                i.id as inscricao_id,
                a.nome, 
                t.numero_tentativa,
                i.rack_agachamento, 
                i.rack_supino, 
                i.trava_supino,
                COALESCE(
                    (
                        SELECT MAX(ta.peso_solicitado)
                        FROM tentativas ta
                        WHERE ta.inscricao_id = t.inscricao_id
                          AND ta.movimento = t.movimento
                          AND ta.numero_tentativa < t.numero_tentativa
                          AND COALESCE(ta.peso_solicitado, 0) > 0
                    ),
                    t_ant.peso_solicitado,
                    0
                ) as peso_solicitado,
                t_ant.resultado_valido as resultado_anterior
            FROM tentativas t 
            JOIN inscricoes i ON t.inscricao_id = i.id 
            JOIN atletas a ON i.atleta_id = a.id
            LEFT JOIN tentativas t_ant 
                ON t_ant.inscricao_id = t.inscricao_id 
                AND t_ant.movimento = t.movimento 
                AND t_ant.numero_tentativa = t.numero_tentativa - 1
            WHERE i.evento_id = ? 
              AND t.movimento = ? 
              AND ${colunaBateria} = ? 
              AND t.estado = 'aguardando_pedida'
        `;
        const params = [evento_id, movSeguro, bateria_nome];

        if (filtroPlat !== null) {
            sql += ` AND COALESCE(${colunaPlataforma}, 1) = ?`;
            params.push(filtroPlat);
        }

        sql += ` ORDER BY t.id ASC`;
        res.json(db.prepare(sql).all(...params));
    } catch (erro) {
        console.error("Erro na rota de pendentes:", erro.message);
        res.status(500).json({ erro: erro.message });
    }
}

app.get('/api/aguardando_pedida/:evento_id/:movimento', handlerAguardandoPedida);
app.get('/api/aguardando_pedida/:evento_id/:movimento/:bateria_nome', handlerAguardandoPedida);

// Salvar 2ª ou 3ª pedida e devolver atleta para a Fila Principal
app.put('/api/pedida/:tentativa_id', exigirSenhaGlobalAPI, (req, res) => {
    try {
        const tentId = req.params.tentativa_id;
        const pesoSeguro = sanitizarPeso(req.body?.peso_solicitado, false);
        db.transaction(() => {
            db.prepare(`
                UPDATE tentativas 
                SET peso_solicitado = ?, estado = 'pendente', sync_nuvem = 0 
                WHERE id = ?
            `).run(pesoSeguro, tentId);
            marcarEventoPorTentativaParaSync(tentId);
        })();

        io.emit('fila_atualizada', { tentativa_id: Number(tentId) });
        res.json({ sucesso: true });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Correção rápida de peso/rack diretamente da Mesa (inclusive com atleta na plataforma)
app.put('/api/mesa/corrigir_tentativa/:tentativa_id', exigirSenhaGlobalAPI, (req, res) => {
    try {
        const tentativaId = req.params.tentativa_id;
        const { peso_solicitado, rack_agachamento, rack_supino, trava_supino } = req.body || {};
        const pesoSeguro = sanitizarPeso(peso_solicitado, false);

        const tent = db.prepare('SELECT id, inscricao_id, movimento, numero_tentativa FROM tentativas WHERE id = ?').get(tentativaId);
        if (!tent) {
            return res.status(404).json({ erro: "Tentativa não encontrada." });
        }

        db.transaction(() => {
            db.prepare(`
                UPDATE tentativas
                SET peso_solicitado = ?, sync_nuvem = 0
                WHERE id = ?
            `).run(pesoSeguro, tentativaId);

            if (rack_agachamento !== undefined || rack_supino !== undefined || trava_supino !== undefined) {
                const insc = db.prepare('SELECT rack_agachamento, rack_supino, trava_supino FROM inscricoes WHERE id = ?').get(tent.inscricao_id);
                if (insc) {
                    db.prepare(`
                        UPDATE inscricoes
                        SET rack_agachamento = ?, rack_supino = ?, trava_supino = ?, versao = COALESCE(versao, 1) + 1
                        WHERE id = ?
                    `).run(
                        rack_agachamento !== undefined ? String(rack_agachamento).trim() : insc.rack_agachamento,
                        rack_supino !== undefined ? String(rack_supino).trim() : insc.rack_supino,
                        trava_supino !== undefined ? String(trava_supino).trim() : insc.trava_supino,
                        tent.inscricao_id
                    );
                }
            }

            marcarEventoPorInscricaoParaSync(tent.inscricao_id);
            registrarLogSeguranca(tent.inscricao_id, 'correcao_mesa', { tentativa_id: tentativaId, novo_peso: pesoSeguro });
        })();

        for (let p = 1; p <= 5; p++) {
            const atualPlat = estadoPlataformas[p]?.atletaAtual;
            const idNaPlat = atualPlat ? (atualPlat.tentativa_id || atualPlat.id) : null;
            if (idNaPlat && Number(idNaPlat) === Number(tentativaId)) {
                estadoPlataformas[p].atletaAtual.pesoNaBarra = pesoSeguro;
                if (rack_agachamento !== undefined) estadoPlataformas[p].atletaAtual.rack_agachamento = String(rack_agachamento).trim();
                if (rack_supino !== undefined) estadoPlataformas[p].atletaAtual.rack_supino = String(rack_supino).trim();
                if (trava_supino !== undefined) estadoPlataformas[p].atletaAtual.trava_supino = String(trava_supino).trim();
                emitirEstadoPlataforma(p, false);
            }
        }

        io.emit('fila_atualizada', { tentativa_id: Number(tentativaId) });
        res.json({ sucesso: true, peso_solicitado: pesoSeguro });
    } catch (erro) {
        console.error("Erro ao corrigir tentativa na mesa:", erro.message);
        res.status(500).json({ erro: erro.message });
    }
});

// Anular Julgamento / Repetir Tentativa (Re-Lift ou voto acidental de árbitro no telemóvel)
// Blindado para nunca apagar uma 3ª tentativa já cadastrada se houver tentativa posterior concluída
app.post('/api/mesa/anular_julgamento/:tentativa_id', exigirSenhaGlobalAPI, (req, res) => {
    try {
        const tentativaId = req.params.tentativa_id;
        const tent = db.prepare('SELECT * FROM tentativas WHERE id = ?').get(tentativaId);
        if (!tent) {
            return res.status(404).json({ erro: "Tentativa não encontrada." });
        }

        db.transaction(() => {
            db.prepare(`
                UPDATE tentativas
                SET estado = 'pendente',
                    resultado_valido = NULL,
                    luz_esquerda = NULL,
                    luz_central = NULL,
                    luz_direita = NULL,
                    sync_nuvem = 0
                WHERE id = ?
            `).run(tentativaId);

            const temConcluidaPosterior = db.prepare(`
                SELECT COUNT(1) as qtd FROM tentativas
                WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa > ? AND estado = 'concluido'
            `).get(tent.inscricao_id, tent.movimento, tent.numero_tentativa)?.qtd || 0;

            if (temConcluidaPosterior === 0) {
                // Remove apenas tentativas posteriores que ainda estavam vazias (0kg) em aguardando_pedida
                db.prepare(`
                    DELETE FROM tentativas
                    WHERE inscricao_id = ?
                      AND movimento = ?
                      AND numero_tentativa > ?
                      AND estado != 'concluido'
                      AND COALESCE(peso_solicitado, 0) <= 0
                `).run(tent.inscricao_id, tent.movimento, tent.numero_tentativa);

                // Se já havia peso digitado na tentativa seguinte, apenas retorna para aguardando_pedida preservando o peso
                db.prepare(`
                    UPDATE tentativas
                    SET estado = 'aguardando_pedida', sync_nuvem = 0
                    WHERE inscricao_id = ?
                      AND movimento = ?
                      AND numero_tentativa > ?
                      AND estado = 'pendente'
                `).run(tent.inscricao_id, tent.movimento, tent.numero_tentativa);
            }

            marcarEventoPorInscricaoParaSync(tent.inscricao_id);
            registrarLogSeguranca(tent.inscricao_id, 'anular_julgamento_mesa', { tentativa_id: tentativaId, numero_tentativa: tent.numero_tentativa });
        })();

        for (let p = 1; p <= 5; p++) {
            const atualPlat = estadoPlataformas[p]?.atletaAtual;
            const idNaPlat = atualPlat ? (atualPlat.tentativa_id || atualPlat.id) : null;
            if (idNaPlat && Number(idNaPlat) === Number(tentativaId)) {
                estadoPlataformas[p].luzes = { esquerda: null, central: null, direita: null };
                estadoPlataformas[p].resultado = null;
                estadoPlataformas[p].preVotoManualMesa = false;
                emitirEstadoPlataforma(p, false);
            }
        }

        io.emit('fila_atualizada', { tentativa_id: Number(tentativaId) });
        res.json({ sucesso: true });
    } catch (erro) {
        console.error("Erro ao anular julgamento:", erro.message);
        res.status(500).json({ erro: erro.message });
    }
});

// Desistir / Passar Tentativa (Atleta ausente na chamada ou abdicou da 2ª/3ª pedida)
app.post('/api/mesa/desistir_tentativa/:tentativa_id', exigirSenhaGlobalAPI, (req, res) => {
    try {
        const tentativaId = req.params.tentativa_id;
        const { desistir_restantes } = req.body || {};

        const tent = db.prepare('SELECT * FROM tentativas WHERE id = ?').get(tentativaId);
        if (!tent) {
            return res.status(404).json({ erro: "Tentativa não encontrada." });
        }

        db.transaction(() => {
            db.prepare(`
                UPDATE tentativas
                SET estado = 'concluido',
                    resultado_valido = 0,
                    luz_esquerda = 0,
                    luz_central = 0,
                    luz_direita = 0,
                    sync_nuvem = 0
                WHERE id = ?
            `).run(tentativaId);

            if (desistir_restantes) {
                for (let num = tent.numero_tentativa + 1; num <= 3; num++) {
                    const existente = db.prepare(`
                        SELECT id FROM tentativas
                        WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = ?
                    `).get(tent.inscricao_id, tent.movimento, num);

                    if (existente) {
                        db.prepare(`
                            UPDATE tentativas
                            SET estado = 'concluido', resultado_valido = 0, luz_esquerda = 0, luz_central = 0, luz_direita = 0, sync_nuvem = 0
                            WHERE id = ?
                        `).run(existente.id);
                    } else {
                        db.prepare(`
                            INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado, resultado_valido, luz_esquerda, luz_central, luz_direita, sync_nuvem)
                            VALUES (?, ?, ?, 0, 'concluido', 0, 0, 0, 0, 0)
                        `).run(tent.inscricao_id, tent.movimento, num);
                    }
                }
            } else if (tent.numero_tentativa < 3) {
                const proxNum = tent.numero_tentativa + 1;
                const existeProx = db.prepare(`
                    SELECT id FROM tentativas
                    WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = ?
                `).get(tent.inscricao_id, tent.movimento, proxNum);

                if (!existeProx) {
                    db.prepare(`
                        INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado)
                        VALUES (?, ?, ?, 0, 'aguardando_pedida')
                    `).run(tent.inscricao_id, tent.movimento, proxNum);
                }
            }

            marcarEventoPorInscricaoParaSync(tent.inscricao_id);
            registrarLogSeguranca(tent.inscricao_id, 'desistir_tentativa', {
                tentativa_id: tentativaId,
                numero_tentativa: tent.numero_tentativa,
                desistir_restantes: Boolean(desistir_restantes)
            });
        })();

        limparTentativaDePlataformasAtivas(tentativaId);
        io.emit('fila_atualizada', { tentativa_id: Number(tentativaId) });
        res.json({ sucesso: true });
    } catch (erro) {
        console.error("Erro ao registar desistência de tentativa:", erro.message);
        res.status(500).json({ erro: erro.message });
    }
});

// Painel Geral de Aquecimento (Suporta filtro por plataforma)
app.get('/api/painel_geral/:evento_id', (req, res) => {
    const filtroPlat = req.query.plataforma ? validarPlataforma(req.query.plataforma) : null;
    try {
        garantirPrimeirasTentativasEvento(req.params.evento_id);

        let sql = `
            SELECT 
                t.movimento,
                CASE 
                    WHEN t.movimento = 'agachamento' THEN i.bateria_agachamento
                    WHEN t.movimento = 'supino' THEN i.bateria_supino
                    WHEN t.movimento = 'terra' THEN i.bateria_terra
                END as bateria,
                CASE 
                    WHEN t.movimento = 'agachamento' THEN COALESCE(i.plataforma_agachamento, 1)
                    WHEN t.movimento = 'supino' THEN COALESCE(i.plataforma_supino, 1)
                    WHEN t.movimento = 'terra' THEN COALESCE(i.plataforma_terra, 1)
                END as plataforma,
                a.nome,
                i.categoria_peso_escolhida,
                COALESCE(i.equipamento_escolhido, 'Raw') as equipamento_escolhido,
                t.numero_tentativa,
                t.peso_solicitado,
                i.rack_agachamento, i.rack_supino, i.trava_supino
            FROM tentativas t
            JOIN inscricoes i ON t.inscricao_id = i.id
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ? AND t.estado = 'pendente'
        `;
        const rows = db.prepare(sql + `
            ORDER BY 
                plataforma ASC, 
                t.movimento ASC, 
                bateria ASC, 
                t.numero_tentativa ASC,
                CASE WHEN COALESCE(t.peso_solicitado, 0) <= 0 THEN 1 ELSE 0 END ASC,
                t.peso_solicitado ASC
        `).all(req.params.evento_id);
        const filtrados = filtroPlat ? rows.filter(r => Number(r.plataforma) === filtroPlat) : rows;
        res.json(filtrados);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Resultados Oficiais Consolidados (Usa LEFT JOIN a partir de inscricoes para exibir atletas em andamento mesmo antes da 1ª tentativa concluída)
app.get('/api/resultados/:evento_id', (req, res) => {
    try {
        garantirPrimeirasTentativasEvento(req.params.evento_id);

        const stmt = db.prepare(`
            SELECT 
                i.id as inscricao_id,
                a.sexo, 
                a.pcd,
                a.cpf,
                a.instagram,
                a.youtube,
                a.outros_social,
                i.modalidade_escolhida,
                COALESCE(i.equipamento_escolhido, 'Raw') as equipamento_escolhido,
                i.divisao_escolhida, 
                i.categoria_peso_escolhida, 
                i.peso_corporal_oficial,
                i.numero_lote,
                i.bateria_agachamento,
                i.bateria_supino,
                i.bateria_terra,
                COALESCE(i.plataforma_agachamento, 1) as plataforma_agachamento,
                COALESCE(i.plataforma_supino, 1) as plataforma_supino,
                COALESCE(i.plataforma_terra, 1) as plataforma_terra,
                t.movimento, 
                a.nome, 
                a.equipe,
                t.numero_tentativa, 
                t.peso_solicitado, 
                t.resultado_valido,
                t.luz_esquerda, 
                t.luz_central, 
                t.luz_direita,
                (SELECT COUNT(1) FROM tentativas tp WHERE tp.inscricao_id = i.id AND tp.movimento = 'agachamento' AND tp.estado != 'concluido') as pendentes_agachamento,
                (SELECT COUNT(1) FROM tentativas tp WHERE tp.inscricao_id = i.id AND tp.movimento = 'supino' AND tp.estado != 'concluido') as pendentes_supino,
                (SELECT COUNT(1) FROM tentativas tp WHERE tp.inscricao_id = i.id AND tp.movimento = 'terra' AND tp.estado != 'concluido') as pendentes_terra
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            LEFT JOIN tentativas t ON t.inscricao_id = i.id AND t.estado = 'concluido'
            WHERE i.evento_id = ?
            ORDER BY a.sexo ASC, i.categoria_peso_escolhida ASC, t.movimento ASC, a.nome ASC, t.numero_tentativa ASC
        `);
        res.json(stmt.all(req.params.evento_id));
    } catch (erro) {
        console.error("Erro na Rota Resultados:", erro.message);
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// MODO PLANILHA (FALLBACK MANUAL DE EMERGÊNCIA BLINDADO E ISOLADO POR PLATAFORMA)
// ============================================================================

function handlerPlanilha(req, res) {
    const evento_id = req.params.evento_id;
    const movSeguro = validarMovimento(req.params.movimento);
    const bateria_nome = obterBateriaDaRequisicao(req);
    const colunaBateria = 'i.bateria_' + movSeguro;
    const colunaPlataforma = 'i.plataforma_' + movSeguro;
    const filtroPlat = req.query.plataforma ? validarPlataforma(req.query.plataforma) : null;

    if (!bateria_nome) return res.json([]);

    try {
        garantirPrimeirasTentativasEvento(evento_id);

        let sql = `
            SELECT 
                a.id as atleta_id,
                i.id as inscricao_id,
                a.nome,
                i.peso_corporal_oficial,
                t.id as tentativa_id,
                t.numero_tentativa,
                t.peso_solicitado,
                t.estado,
                t.resultado_valido
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            JOIN tentativas t ON t.inscricao_id = i.id AND t.movimento = ?
            WHERE i.evento_id = ? AND ${colunaBateria} = ?
        `;
        const params = [movSeguro, evento_id, bateria_nome];

        if (filtroPlat !== null) {
            sql += ` AND COALESCE(${colunaPlataforma}, 1) = ?`;
            params.push(filtroPlat);
        }

        sql += ` ORDER BY a.nome ASC, t.numero_tentativa ASC`;
        res.json(db.prepare(sql).all(...params));
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
}

app.get('/api/planilha/:evento_id/:movimento', handlerPlanilha);
app.get('/api/planilha/:evento_id/:movimento/:bateria_nome', handlerPlanilha);

app.put('/api/planilha/forcar_salvar', exigirSenhaGlobalAPI, (req, res) => {
    const { tentativa_id, peso_solicitado, resultado_valido, estado } = req.body || {};
    const pesoSeguro = sanitizarPeso(peso_solicitado, false);
    const estadoSeguro = ['pendente', 'aguardando_pedida', 'concluido'].includes(estado) ? estado : 'pendente';

    try {
        db.transaction(() => {
            const tentAtual = db.prepare('SELECT * FROM tentativas WHERE id = ?').get(tentativa_id);
            if (!tentAtual) {
                throw new Error("Tentativa não encontrada no banco de dados.");
            }

            if (estadoSeguro === 'concluido') {
                const isValido = Number(resultado_valido) === 1 ? 1 : 0;
                const luzPadrao = isValido ? 1 : 0;
                const luzEsq = tentAtual.luz_esquerda !== null ? tentAtual.luz_esquerda : luzPadrao;
                const luzCen = tentAtual.luz_central !== null ? tentAtual.luz_central : luzPadrao;
                const luzDir = tentAtual.luz_direita !== null ? tentAtual.luz_direita : luzPadrao;

                db.prepare(`
                    UPDATE tentativas 
                    SET peso_solicitado = ?, resultado_valido = ?, luz_esquerda = ?, luz_central = ?, luz_direita = ?, estado = 'concluido', sync_nuvem = 0
                    WHERE id = ?
                `).run(pesoSeguro, isValido, luzEsq, luzCen, luzDir, tentativa_id);

                if (tentAtual.numero_tentativa < 3) {
                    const existeProxima = db.prepare(`
                        SELECT id FROM tentativas 
                        WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = ?
                    `).get(tentAtual.inscricao_id, tentAtual.movimento, tentAtual.numero_tentativa + 1);

                    if (!existeProxima) {
                        db.prepare(`
                            INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado) 
                            VALUES (?, ?, ?, 0, 'aguardando_pedida')
                        `).run(tentAtual.inscricao_id, tentAtual.movimento, tentAtual.numero_tentativa + 1);
                    }
                }
            } else {
                db.prepare(`
                    UPDATE tentativas 
                    SET peso_solicitado = ?, resultado_valido = NULL, luz_esquerda = NULL, luz_central = NULL, luz_direita = NULL, estado = ?, sync_nuvem = 0
                    WHERE id = ?
                `).run(pesoSeguro, estadoSeguro, tentativa_id);

                const temConcluidaPosterior = db.prepare(`
                    SELECT COUNT(1) as qtd FROM tentativas
                    WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa > ? AND estado = 'concluido'
                `).get(tentAtual.inscricao_id, tentAtual.movimento, tentAtual.numero_tentativa)?.qtd || 0;

                if (temConcluidaPosterior === 0) {
                    db.prepare(`
                        DELETE FROM tentativas
                        WHERE inscricao_id = ?
                          AND movimento = ?
                          AND numero_tentativa > ?
                          AND estado = 'aguardando_pedida'
                          AND COALESCE(peso_solicitado, 0) <= 0
                    `).run(tentAtual.inscricao_id, tentAtual.movimento, tentAtual.numero_tentativa);

                    db.prepare(`
                        UPDATE tentativas
                        SET estado = 'aguardando_pedida', sync_nuvem = 0
                        WHERE inscricao_id = ?
                          AND movimento = ?
                          AND numero_tentativa > ?
                          AND estado = 'pendente'
                    `).run(tentAtual.inscricao_id, tentAtual.movimento, tentAtual.numero_tentativa);
                }
            }

            marcarEventoPorInscricaoParaSync(tentAtual.inscricao_id);
            registrarLogSeguranca(tentAtual.inscricao_id, 'planilha_forcar_salvar', {
                tentativa_id,
                peso_solicitado: pesoSeguro,
                estado: estadoSeguro,
                resultado_valido
            });
        })();

        limparTentativaDePlataformasAtivas(tentativa_id);
        io.emit('fila_atualizada', { tentativa_id: Number(tentativa_id) });
        res.json({ sucesso: true });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Criar nova tentativa (2ª, 3ª ou 4ª+ Extra/PR) diretamente da Planilha ou Mesa
app.post('/api/planilha/nova_tentativa', exigirSenhaGlobalAPI, (req, res) => {
    try {
        const inscricaoId = Number(req.body?.inscricao_id);
        const movSeguro = validarMovimento(req.body?.movimento);
        const pesoSeguro = sanitizarPeso(req.body?.peso_solicitado, false);

        if (!inscricaoId) {
            return res.status(400).json({ erro: "ID da inscrição é obrigatório." });
        }

        let novoNum = 1;
        let novoId = null;

        db.transaction(() => {
            const maxRow = db.prepare(`
                SELECT COALESCE(MAX(numero_tentativa), 0) as max_num
                FROM tentativas
                WHERE inscricao_id = ? AND movimento = ?
            `).get(inscricaoId, movSeguro);

            novoNum = (maxRow?.max_num || 0) + 1;
            const info = db.prepare(`
                INSERT INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado, sync_nuvem)
                VALUES (?, ?, ?, ?, 'pendente', 0)
            `).run(inscricaoId, movSeguro, novoNum, pesoSeguro);

            novoId = info.lastInsertRowid;
            marcarEventoPorInscricaoParaSync(inscricaoId);
            registrarLogSeguranca(inscricaoId, 'planilha_nova_tentativa', {
                movimento: movSeguro,
                numero_tentativa: novoNum,
                peso_solicitado: pesoSeguro
            });
        })();

        io.emit('fila_atualizada', { inscricao_id: inscricaoId });
        res.json({ sucesso: true, tentativa_id: novoId, numero_tentativa: novoNum });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// ☁️ CENTRAL DE NUVEM (4 PILARES: OFFLINE-MASTER, CIRCUIT-BREAKER, SHA-256 GATEKEEPER E COFRE DE 20 SNAPSHOTS)
// ============================================================================

// Cache em memória dos limites da licença na nuvem (evita atrasos quando offline)
let cacheQuotaLicencaNuvem = {
    atualizado_em: 0,
    ultimo_erro_rede_em: 0,
    organizador_id: '',
    max_campeonatos: 30,
    max_inscricoes: 500,
    campeonatos_remotos: [] // [{ nuvem_id, nome_evento, qtd_atletas, versao_sync }]
};

// Serializador JSON Canónico Determinístico (Garante que o hash SHA-256 seja idêntico em qualquer plataforma/SO)
function serializarJSONCanonico(valor) {
    if (valor === null || valor === undefined) return 'null';
    if (typeof valor === 'number') return Number.isFinite(valor) ? String(valor) : 'null';
    if (typeof valor === 'boolean') return valor ? 'true' : 'false';
    if (typeof valor === 'string') return JSON.stringify(valor);
    if (Array.isArray(valor)) {
        return '[' + valor.map(item => serializarJSONCanonico(item)).join(',') + ']';
    }
    if (typeof valor === 'object') {
        const chaves = Object.keys(valor).filter(k => valor[k] !== undefined).sort();
        return '{' + chaves.map(k => JSON.stringify(k) + ':' + serializarJSONCanonico(valor[k])).join(',') + '}';
    }
    return 'null';
}

function calcularHashPacoteNuvem(pacote) {
    const nucleo = {
        nuvem_id: String(pacote?.nuvem_id || ''),
        organizador_id: sanitizarOrganizadorId(pacote?.organizador_id || pacote?.evento?.organizador_id || 'LOCAL'),
        nome_evento: String(pacote?.evento?.nome || '').trim(),
        data_evento: String(pacote?.evento?.data || '').trim(),
        inscricoes: Array.isArray(pacote?.inscricoes) ? pacote.inscricoes.map(i => ({
            id: Number(i.id) || 0,
            nome: String(i.nome || '').trim(),
            cpf: sanitizarCPF(i.cpf),
            sexo: i.sexo === 'F' ? 'F' : 'M',
            modalidade_escolhida: String(i.modalidade_escolhida || 'Full Power'),
            equipamento_escolhido: String(i.equipamento_escolhido || 'Raw'),
            divisao_escolhida: normalizarDivisoesParaBanco(i.divisao_escolhida),
            categoria_peso_escolhida: String(i.categoria_peso_escolhida || 'Livre'),
            peso_corporal_oficial: sanitizarPeso(i.peso_corporal_oficial, true),
            rack_agachamento: i.rack_agachamento ? String(i.rack_agachamento).trim() : null,
            rack_supino: i.rack_supino ? String(i.rack_supino).trim() : null,
            trava_supino: i.trava_supino ? String(i.trava_supino).trim() : null,
            bateria_agachamento: i.bateria_agachamento || null,
            bateria_supino: i.bateria_supino || null,
            bateria_terra: i.bateria_terra || null,
            plataforma_agachamento: validarPlataforma(i.plataforma_agachamento || 1),
            plataforma_supino: validarPlataforma(i.plataforma_supino || 1),
            plataforma_terra: validarPlataforma(i.plataforma_terra || 1),
            remanejado_manual: i.remanejado_manual ? 1 : 0
        })) : [],
        tentativas: Array.isArray(pacote?.tentativas) ? pacote.tentativas.map(t => ({
            inscricao_id: Number(t.inscricao_id) || 0,
            movimento: validarMovimento(t.movimento),
            numero_tentativa: Number(t.numero_tentativa) || 1,
            peso_solicitado: sanitizarPeso(t.peso_solicitado, false),
            estado: String(t.estado || 'pendente'),
            luz_esquerda: t.luz_esquerda !== undefined && t.luz_esquerda !== null ? Number(t.luz_esquerda) : null,
            luz_central: t.luz_central !== undefined && t.luz_central !== null ? Number(t.luz_central) : null,
            luz_direita: t.luz_direita !== undefined && t.luz_direita !== null ? Number(t.luz_direita) : null,
            resultado_valido: t.resultado_valido !== undefined && t.resultado_valido !== null ? Number(t.resultado_valido) : null
        })) : [],
        estados_plataformas: pacote?.estados_plataformas && typeof pacote.estados_plataformas === 'object'
            ? pacote.estados_plataformas
            : {}
    };
    return crypto.createHash('sha256').update(serializarJSONCanonico(nucleo), 'utf8').digest('hex');
}

// Gatekeeper de Integridade (Pilar 3: Rejeita pacotes truncados, corrompidos ou com falha de SHA-256)
function validarESanitizarPacoteNuvem(pacoteBruto, hashHeaderOpcional = null) {
    if (!pacoteBruto || typeof pacoteBruto !== 'object') {
        return { valido: false, status: 400, erro: "Pacote de campeonato ausente ou formato inválido." };
    }
    const ev = pacoteBruto.evento;
    if (!ev || typeof ev !== 'object' || !String(ev.nome || '').trim() || !String(ev.data || '').trim()) {
        return { valido: false, status: 422, erro: "Estrutura do evento inválida (nome e data são obrigatórios)." };
    }
    if (pacoteBruto.inscricoes !== undefined && !Array.isArray(pacoteBruto.inscricoes)) {
        return { valido: false, status: 422, erro: "Lista de inscrições corrompida (não é um Array)." };
    }
    if (pacoteBruto.tentativas !== undefined && !Array.isArray(pacoteBruto.tentativas)) {
        return { valido: false, status: 422, erro: "Lista de tentativas corrompida (não é um Array)." };
    }

    const hashEsperado = hashHeaderOpcional || pacoteBruto.checksum_sha256 || null;
    const hashCalculado = calcularHashPacoteNuvem(pacoteBruto);

    if (hashEsperado && String(hashEsperado).trim().toLowerCase() !== hashCalculado.toLowerCase()) {
        return {
            valido: false,
            status: 422,
            erro: "Falha de integridade SHA-256: o pacote foi truncado ou corrompido durante a transmissão de rede."
        };
    }

    pacoteBruto.checksum_sha256 = hashCalculado;
    return { valido: true, pacote: pacoteBruto, checksum_sha256: hashCalculado };
}

// Fetch para a Nuvem com Circuit-Breaker (Pilar 2: Nunca trava o app local se o Wi-Fi ou Cloud Run oscilar)
async function fetchNuvemComTimeout(url, opcoes = {}, timeoutMs = 8000, redirectsRestantes = 3) {
    if (typeof fetch === 'function' && typeof AbortController === 'function') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resposta = await fetch(url, { ...opcoes, signal: controller.signal });
            clearTimeout(timer);
            return resposta;
        } catch (erro) {
            clearTimeout(timer);
            throw erro;
        }
    }

    // Fallback nativo para Node.js legado (Windows 7) com suporte a UTF-8, Redirects e Hard Timeout
    return new Promise((resolve, reject) => {
        let finalizado = false;
        const urlObj = new URL(url);
        const lib = urlObj.protocol === 'https:' ? https : http;
        const headers = { ...(opcoes.headers || {}) };
        let bodyBuffer = null;

        if (opcoes.body !== undefined && opcoes.body !== null) {
            bodyBuffer = Buffer.isBuffer(opcoes.body) ? opcoes.body : Buffer.from(String(opcoes.body), 'utf8');
            if (!headers['Content-Length'] && !headers['content-length']) {
                headers['Content-Length'] = bodyBuffer.length;
            }
        }

        const hardTimer = setTimeout(() => {
            if (finalizado) return;
            finalizado = true;
            req.destroy();
            reject(new Error('Timeout de conexão com a nuvem'));
        }, timeoutMs);

        const req = lib.request(urlObj, {
            method: opcoes.method || 'GET',
            headers
        }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsRestantes > 0) {
                clearTimeout(hardTimer);
                finalizado = true;
                res.resume();
                const novaUrl = new URL(res.headers.location, url).toString();
                const novoMetodo = (res.statusCode === 301 || res.statusCode === 302) ? 'GET' : opcoes.method;
                const novoBody = (novoMetodo === 'GET') ? undefined : opcoes.body;
                return resolve(fetchNuvemComTimeout(novaUrl, { ...opcoes, method: novoMetodo, body: novoBody }, timeoutMs, redirectsRestantes - 1));
            }

            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                if (finalizado) return;
                finalizado = true;
                clearTimeout(hardTimer);
                const bodyText = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: async () => JSON.parse(bodyText),
                    text: async () => bodyText
                });
            });
        });

        req.on('error', (err) => {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(hardTimer);
            reject(err);
        });

        if (bodyBuffer) req.write(bodyBuffer);
        req.end();
    });
}

// Resolve a configuração remota da Nuvem: só ativa tráfego se o organizador tiver inserido Token e ID != LOCAL
function obterContextoRemotoNuvem(organizadorOverride = null, urlOverride = null) {
    const cfg = db.prepare('SELECT * FROM config_nuvem WHERE id = 1').get() || {};
    const orgId = sanitizarOrganizadorId(organizadorOverride || cfg.organizador_id || 'LOCAL');
    const token = String(cfg.cloud_token || '').trim();
    const urlSalva = String(urlOverride || cfg.cloud_url || '').trim().replace(/\/+$/, '');

    const remoteUrl = urlSalva || ((token && orgId !== 'LOCAL') ? 'https://app.brasilpowerlifting.com.br' : '');

    return {
        cfg,
        orgId,
        token,
        remoteUrl,
        temCredencialRemota: Boolean(remoteUrl && token && orgId !== 'LOCAL'),
        headersPadrao: {
            'Authorization': `Bearer ${token}`,
            'X-Organizador-Id': orgId
        }
    };
}

// Atualiza o cache local dos limites da licença na nuvem (com Circuit-Breaker rápido de 2s)
async function atualizarCacheQuotaDaNuvem(forcarRede = false) {
    const ctx = obterContextoRemotoNuvem();
    if (!ctx.temCredencialRemota) return null;

    const agora = Date.now();
    if (!forcarRede) {
        if (cacheQuotaLicencaNuvem.organizador_id === ctx.orgId && (agora - cacheQuotaLicencaNuvem.atualizado_em) < 25000) {
            return cacheQuotaLicencaNuvem;
        }
        // Se a internet caiu há menos de 20s, não atrasa o cadastro local tentando rede novamente
        if ((agora - cacheQuotaLicencaNuvem.ultimo_erro_rede_em) < 20000) {
            return cacheQuotaLicencaNuvem.atualizado_em > 0 ? cacheQuotaLicencaNuvem : null;
        }
    }

    try {
        const resp = await fetchNuvemComTimeout(
            `${ctx.remoteUrl}/api/nuvem/campeonatos?organizador_id=${encodeURIComponent(ctx.orgId)}&apenas_local=1`,
            { headers: ctx.headersPadrao },
            2200
        );
        if (resp.ok) {
            const lista = await resp.json();
            if (Array.isArray(lista)) {
                const primeiro = lista[0] || {};
                cacheQuotaLicencaNuvem = {
                    atualizado_em: Date.now(),
                    ultimo_erro_rede_em: 0,
                    organizador_id: ctx.orgId,
                    max_campeonatos: Number(primeiro.max_campeonatos) || cacheQuotaLicencaNuvem.max_campeonatos || 30,
                    max_inscricoes: Number(primeiro.max_inscricoes) || cacheQuotaLicencaNuvem.max_inscricoes || 500,
                    campeonatos_remotos: lista.map(c => ({
                        nuvem_id: String(c.nuvem_id || ''),
                        nome_evento: String(c.nome_evento || '').trim(),
                        qtd_atletas: Number(c.qtd_atletas) || 0,
                        versao_sync: Number(c.versao_sync) || 1
                    }))
                };

                // Se a conta ainda não tem nenhum campeonato na nuvem, consulta /resumo-conta para ler o max_campeonatos/max_inscricoes exato
                if (lista.length === 0) {
                    try {
                        const resResumo = await fetchNuvemComTimeout(`${ctx.remoteUrl}/api/nuvem/resumo-conta`, { headers: ctx.headersPadrao }, 2000);
                        if (resResumo.ok) {
                            const dadosResumo = await resResumo.json();
                            cacheQuotaLicencaNuvem.max_campeonatos = Number(dadosResumo.max_campeonatos) || 30;
                            cacheQuotaLicencaNuvem.max_inscricoes = Number(dadosResumo.max_inscricoes) || 500;
                        }
                    } catch (eIgnorar) {}
                }
                return cacheQuotaLicencaNuvem;
            }
        }
    } catch (e) {
        cacheQuotaLicencaNuvem.ultimo_erro_rede_em = Date.now();
    }
    return cacheQuotaLicencaNuvem.atualizado_em > 0 ? cacheQuotaLicencaNuvem : null;
}

// Verifica se a criação de um novo evento local ultrapassa o limite de campeonatos da licença na nuvem
async function verificarLimiteLicencaParaNovoEvento(nomeEvento) {
    const ctx = obterContextoRemotoNuvem();
    if (!ctx.temCredencialRemota) return { atingiu_limite: false, nuvem_id_existente: null };

    const quota = await atualizarCacheQuotaDaNuvem(false);
    if (!quota) return { atingiu_limite: false, nuvem_id_existente: null };

    const nomeLimpo = String(nomeEvento || '').trim().toLowerCase();
    const existenteMesmoNome = quota.campeonatos_remotos.find(
        c => c.nome_evento.toLowerCase() === nomeLimpo
    );
    if (existenteMesmoNome) {
        // Só reaproveita o nuvem_id se nenhum outro campeonato local ativo já estiver vinculado a ele
        const jaUsadoLocalmente = db.prepare(
            "SELECT id FROM eventos WHERE nuvem_evento_id = ? AND nome != 'Cadastros Cancelados' LIMIT 1"
        ).get(existenteMesmoNome.nuvem_id);
        if (!jaUsadoLocalmente) {
            return { atingiu_limite: false, nuvem_id_existente: existenteMesmoNome.nuvem_id };
        }
    }

    // Conta campeonatos na nuvem + campeonatos locais com sincronização ativa que ainda não subiram
    const nuvemIdsRemotos = new Set(quota.campeonatos_remotos.map(c => c.nuvem_id));
    const locaisAtivos = db.prepare(`
        SELECT nuvem_evento_id, nome FROM eventos
        WHERE nome != 'Cadastros Cancelados' AND COALESCE(sync_nuvem, 0) != -1
    `).all();

    let totalCampeonatosSincronizados = quota.campeonatos_remotos.length;
    locaisAtivos.forEach(ev => {
        const jaNaNuvemPorId = ev.nuvem_evento_id && nuvemIdsRemotos.has(ev.nuvem_evento_id);
        const jaNaNuvemPorNome = quota.campeonatos_remotos.some(c => c.nome_evento.toLowerCase() === String(ev.nome || '').trim().toLowerCase());
        if (!jaNaNuvemPorId && !jaNaNuvemPorNome) {
            totalCampeonatosSincronizados++;
        }
    });

    return {
        atingiu_limite: totalCampeonatosSincronizados >= quota.max_campeonatos,
        nuvem_id_existente: null
    };
}

// Verifica se a adição de +1 inscrição no evento local ultrapassa o limite total de inscrições da licença na nuvem
async function verificarLimiteLicencaParaNovaInscricao(eventoId) {
    const ev = db.prepare('SELECT id, nome, nuvem_evento_id, COALESCE(sync_nuvem, 0) as sync_nuvem FROM eventos WHERE id = ?').get(eventoId);
    if (!ev || Number(ev.sync_nuvem) === -1) return { atingiu_limite: false };

    const ctx = obterContextoRemotoNuvem();
    if (!ctx.temCredencialRemota) return { atingiu_limite: false };

    const quota = await atualizarCacheQuotaDaNuvem(false);
    if (!quota) return { atingiu_limite: false };

    const qtdLocalNesteEvento = db.prepare('SELECT COUNT(1) as qtd FROM inscricoes WHERE evento_id = ?').get(eventoId)?.qtd || 0;
    const nomeEvLower = String(ev.nome || '').trim().toLowerCase();

    let somaOutrosCampeonatosNaNuvem = 0;
    let qtdNuvemDesteEvento = 0;

    quota.campeonatos_remotos.forEach(c => {
        const ehMesmoEvento = (ev.nuvem_evento_id && c.nuvem_id === ev.nuvem_evento_id) ||
                              (c.nome_evento.toLowerCase() === nomeEvLower);
        if (ehMesmoEvento) {
            qtdNuvemDesteEvento = Math.max(qtdNuvemDesteEvento, c.qtd_atletas);
        } else {
            somaOutrosCampeonatosNaNuvem += c.qtd_atletas;
        }
    });

    // Soma também inscritos de outros campeonatos locais com sync ativo que ainda não estão na lista remota
    const outrosLocaisAtivos = db.prepare(`
        SELECT e.id, e.nome, e.nuvem_evento_id, COUNT(i.id) as qtd
        FROM eventos e
        LEFT JOIN inscricoes i ON i.evento_id = e.id
        WHERE e.id != ? AND e.nome != 'Cadastros Cancelados' AND COALESCE(e.sync_nuvem, 0) != -1
        GROUP BY e.id
    `).all(eventoId);

    outrosLocaisAtivos.forEach(outro => {
        const jaContadoNaNuvem = quota.campeonatos_remotos.some(c =>
            (outro.nuvem_evento_id && c.nuvem_id === outro.nuvem_evento_id) ||
            (c.nome_evento.toLowerCase() === String(outro.nome || '').trim().toLowerCase())
        );
        if (!jaContadoNaNuvem) {
            somaOutrosCampeonatosNaNuvem += (Number(outro.qtd) || 0);
        }
    });

    const totalInscricoesContaAtual = somaOutrosCampeonatosNaNuvem + Math.max(qtdLocalNesteEvento, qtdNuvemDesteEvento);
    return {
        atingiu_limite: (totalInscricoesContaAtual + 1) > quota.max_inscricoes
    };
}

// Localiza uma inscrição equivalente dentro de um evento local (evita duplicar atletas entre Web e App Offline)
function localizarInscricaoEquivalenteNoEvento(eventoLocalId, inscNuvem, listaInscricoesLocaisPreCarregada = null) {
    const cpfLimpo = sanitizarCPF(inscNuvem.cpf);
    const nomeLimpo = String(inscNuvem.nome || '').trim();
    const modalLimpa = String(inscNuvem.modalidade_escolhida || 'Full Power').trim();
    const equipLimpo = String(inscNuvem.equipamento_escolhido || 'Raw').trim();
    const catPesoLimpa = String(inscNuvem.categoria_peso_escolhida || 'Livre').trim();
    const divNormalizada = normalizarDivisoesParaBanco(inscNuvem.divisao_escolhida);

    const inscricoesLocais = Array.isArray(listaInscricoesLocaisPreCarregada)
        ? listaInscricoesLocaisPreCarregada
        : db.prepare(`
            SELECT i.*, a.nome, a.cpf, a.sexo
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ?
        `).all(eventoLocalId);

    // 0. Se possui o mesmo número de lote neste evento E (mesmo ID ou mesmo CPF/Nome),
    // é a mesma inscrição (mesmo que modalidade/equipamento/nome tenham sido editados localmente)
    if (inscNuvem.numero_lote) {
        const mesmoLote = inscricoesLocais.find(loc => {
            if (Number(loc.numero_lote) !== Number(inscNuvem.numero_lote)) return false;
            if (inscNuvem.id && Number(loc.id) === Number(inscNuvem.id)) return true;
            return (cpfLimpo && loc.cpf && sanitizarCPF(loc.cpf) === cpfLimpo) ||
                   (String(loc.nome || '').trim().toLowerCase() === nomeLimpo.toLowerCase());
        });
        if (mesmoLote) return mesmoLote;
    }

    // 1. Busca correspondência exata (Atleta + Modalidade + Equipamento + Categoria + Divisão)
    let encontrada = inscricoesLocais.find(loc => {
        const mesmoAtleta = (cpfLimpo && loc.cpf && sanitizarCPF(loc.cpf) === cpfLimpo) ||
                            (String(loc.nome || '').trim().toLowerCase() === nomeLimpo.toLowerCase());
        if (!mesmoAtleta) return false;
        return String(loc.modalidade_escolhida || 'Full Power') === modalLimpa &&
               String(loc.equipamento_escolhido || 'Raw') === equipLimpo &&
               String(loc.categoria_peso_escolhida || 'Livre') === catPesoLimpa &&
               normalizarDivisoesParaBanco(loc.divisao_escolhida) === divNormalizada;
    });

    // 2. Fallback caso o atleta já tenha pesado no App Offline e mudado de categoria de peso durante a pesagem
    if (!encontrada) {
        encontrada = inscricoesLocais.find(loc => {
            const mesmoAtleta = (cpfLimpo && loc.cpf && sanitizarCPF(loc.cpf) === cpfLimpo) ||
                                (String(loc.nome || '').trim().toLowerCase() === nomeLimpo.toLowerCase());
            if (!mesmoAtleta) return false;
            return String(loc.modalidade_escolhida || 'Full Power') === modalLimpa &&
                   String(loc.equipamento_escolhido || 'Raw') === equipLimpo;
        });
    }

    return encontrada || null;
}

// Retorna a lista de atletas arquivados especificamente deste eventoLocalId (para bloquear re-importação local e na nuvem)
function obterAtletasArquivadosDoEvento(eventoLocalId) {
    try {
        const evCancelados = db.prepare("SELECT id FROM eventos WHERE nome = 'Cadastros Cancelados' LIMIT 1").get();
        if (!evCancelados) return [];

        const rows = db.prepare(`
            SELECT i.id, i.numero_lote, i.modalidade_escolhida, COALESCE(i.equipamento_escolhido, 'Raw') as equipamento_escolhido, a.nome, a.cpf, l.detalhes
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            JOIN log_acoes l ON l.inscricao_id = i.id AND l.acao = 'arquivar_inscricao'
            WHERE i.evento_id = ?
        `).all(evCancelados.id);

        return rows
            .filter(r => {
                const det = parseJSONSeguro(r.detalhes, {});
                return !det.de_evento || Number(det.de_evento) === Number(eventoLocalId);
            })
            .map(r => ({
                id: Number(r.id) || 0,
                numero_lote: Number(r.numero_lote) || null,
                cpf: sanitizarCPF(r.cpf),
                nome: String(r.nome || '').trim(),
                modalidade_escolhida: String(r.modalidade_escolhida || 'Full Power').trim(),
                equipamento_escolhido: String(r.equipamento_escolhido || 'Raw').trim()
            }));
    } catch (e) {
        return [];
    }
}

// Verifica se um atleta da nuvem foi intencionalmente removido/arquivado pelo organizador neste campeonato específico
function verificarSeAtletaFoiArquivadoLocalmente(eventoLocalId, inscNuvem, listaArquivadosPreCarregada = null) {
    try {
        const cpfLimpo = sanitizarCPF(inscNuvem.cpf);
        const nomeLimpo = String(inscNuvem.nome || '').trim().toLowerCase();
        const modalLimpa = String(inscNuvem.modalidade_escolhida || 'Full Power').trim();

        const cancelados = Array.isArray(listaArquivadosPreCarregada)
            ? listaArquivadosPreCarregada
            : obterAtletasArquivadosDoEvento(eventoLocalId);

        return cancelados.some(c => {
            if (inscNuvem.numero_lote && c.numero_lote && Number(inscNuvem.numero_lote) === Number(c.numero_lote)) {
                return true;
            }
            if (c.modalidade_escolhida !== modalLimpa) return false;
            return (cpfLimpo && c.cpf && sanitizarCPF(c.cpf) === cpfLimpo) ||
                   (String(c.nome || '').trim().toLowerCase() === nomeLimpo);
        });
    } catch (e) {
        return false;
    }
}

// Mescla no SQLite local os atletas inscritos na Web que ainda não existem no campeonato local (Zero Perda de Inscritos)
function mesclarAtletasDoPacoteNuvemNoEventoLocal(eventoLocalId, pacoteNuvem, respeitarArquivadosLocais = true) {
    const inscricoesNuvem = Array.isArray(pacoteNuvem?.inscricoes) ? pacoteNuvem.inscricoes : [];
    const tentativasNuvem = Array.isArray(pacoteNuvem?.tentativas) ? pacoteNuvem.tentativas : [];
    if (inscricoesNuvem.length === 0) return 0;

    let novosAdicionados = 0;

    db.transaction(() => {
        const evLocalInfo = db.prepare('SELECT ultimo_sync_em FROM eventos WHERE id = ?').get(eventoLocalId);
        const inscricoesLocaisAtuais = db.prepare(`
            SELECT i.*, a.nome, a.cpf, a.sexo
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ?
        `).all(eventoLocalId);
        const arquivadosDesteEvento = respeitarArquivadosLocais ? obterAtletasArquivadosDoEvento(eventoLocalId) : [];

        inscricoesNuvem.forEach(insc => {
            const existenteLocal = localizarInscricaoEquivalenteNoEvento(eventoLocalId, insc, inscricoesLocaisAtuais);
            if (existenteLocal) {
                // Preserva a escolha de anonimização histórica (LGPD) e origem feitas na Web
                if (insc.anonimizar_historico) {
                    db.prepare('UPDATE inscricoes SET anonimizar_historico = 1 WHERE id = ?').run(existenteLocal.id);
                }
                return;
            }

            // Se este campeonato local já havia sincronizado antes e o registro na nuvem tinha origem 'APP',
            // significa que ele foi criado neste computador e depois foi editado ou removido localmente.
            if (respeitarArquivadosLocais && evLocalInfo?.ultimo_sync_em && String(insc.origem_inscricao || 'APP').toUpperCase() === 'APP') {
                return;
            }

            if (respeitarArquivadosLocais && verificarSeAtletaFoiArquivadoLocalmente(eventoLocalId, insc, arquivadosDesteEvento)) {
                return;
            }

            const cpfLimpo = sanitizarCPF(insc.cpf);
            const nomeAtleta = String(insc.nome || 'Atleta').trim();
            let idAtletaLocal = null;

            if (cpfLimpo) {
                const existenteCpf = db.prepare('SELECT id, nome FROM atletas WHERE cpf = ? ORDER BY id DESC LIMIT 1').get(cpfLimpo);
                if (existenteCpf && String(existenteCpf.nome || '').trim().toLowerCase() === nomeAtleta.toLowerCase()) {
                    idAtletaLocal = existenteCpf.id;
                }
            }
            if (!idAtletaLocal) {
                const existenteNome = db.prepare(`
                    SELECT id FROM atletas
                    WHERE LOWER(nome) = LOWER(?) AND data_nascimento = ? AND sexo = ?
                    LIMIT 1
                `).get(nomeAtleta, String(insc.data_nascimento || ''), String(insc.sexo || 'M'));
                if (existenteNome) idAtletaLocal = existenteNome.id;
            }

            if (idAtletaLocal) {
                db.prepare(`
                    UPDATE atletas
                    SET nome = ?, cpf = COALESCE(?, cpf), data_nascimento = ?, sexo = ?, whatsapp = ?, cidade = ?, estado = ?, equipe = ?, pcd = ?,
                        instagram = COALESCE(?, instagram), youtube = COALESCE(?, youtube), outros_social = COALESCE(?, outros_social)
                    WHERE id = ?
                `).run(
                    nomeAtleta,
                    cpfLimpo,
                    String(insc.data_nascimento || ''),
                    insc.sexo === 'F' ? 'F' : 'M',
                    String(insc.whatsapp || ''),
                    String(insc.cidade || ''),
                    String(insc.estado || 'SP'),
                    String(insc.equipe || 'Sem Equipe'),
                    insc.pcd ? 1 : 0,
                    insc.instagram || null,
                    insc.youtube || null,
                    insc.outros_social || null,
                    idAtletaLocal
                );
            } else {
                idAtletaLocal = db.prepare(`
                    INSERT INTO atletas (nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd, instagram, youtube, outros_social)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    nomeAtleta,
                    cpfLimpo,
                    String(insc.data_nascimento || ''),
                    insc.sexo === 'F' ? 'F' : 'M',
                    String(insc.whatsapp || ''),
                    String(insc.cidade || ''),
                    String(insc.estado || 'SP'),
                    String(insc.equipe || 'Sem Equipe'),
                    insc.pcd ? 1 : 0,
                    insc.instagram || null,
                    insc.youtube || null,
                    insc.outros_social || null
                ).lastInsertRowid;
            }

            const lote = insc.numero_lote || (Math.floor(Math.random() * 9000) + 1000);
            const novaInscId = db.prepare(`
                INSERT INTO inscricoes (
                    evento_id, atleta_id, modalidade_escolhida, equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida,
                    bateria_agachamento, bateria_supino, bateria_terra,
                    plataforma_agachamento, plataforma_supino, plataforma_terra, remanejado_manual,
                    peso_corporal_oficial, numero_lote, rack_agachamento, rack_supino, trava_supino, versao,
                    anonimizar_historico, origem_inscricao, aceite_termos_em
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            `).run(
                eventoLocalId,
                idAtletaLocal,
                insc.modalidade_escolhida || 'Full Power',
                insc.equipamento_escolhido || 'Raw',
                normalizarDivisoesParaBanco(insc.divisao_escolhida),
                insc.categoria_peso_escolhida || 'Livre',
                insc.bateria_agachamento || null,
                insc.bateria_supino || null,
                insc.bateria_terra || null,
                validarPlataforma(insc.plataforma_agachamento || 1),
                validarPlataforma(insc.plataforma_supino || 1),
                validarPlataforma(insc.plataforma_terra || 1),
                insc.remanejado_manual ? 1 : 0,
                insc.peso_corporal_oficial || null,
                lote,
                insc.rack_agachamento || null,
                insc.rack_supino || null,
                insc.trava_supino || null,
                insc.anonimizar_historico ? 1 : 0,
                insc.origem_inscricao || 'WEB',
                insc.aceite_termos_em || null
            ).lastInsertRowid;

            // Atualiza a lista em memória para evitar duplicatas no mesmo lote
            inscricoesLocaisAtuais.push({
                id: novaInscId,
                evento_id: eventoLocalId,
                atleta_id: idAtletaLocal,
                nome: nomeAtleta,
                cpf: cpfLimpo,
                sexo: insc.sexo === 'F' ? 'F' : 'M',
                modalidade_escolhida: insc.modalidade_escolhida || 'Full Power',
                equipamento_escolhido: insc.equipamento_escolhido || 'Raw',
                divisao_escolhida: normalizarDivisoesParaBanco(insc.divisao_escolhida),
                categoria_peso_escolhida: insc.categoria_peso_escolhida || 'Livre',
                numero_lote: lote
            });

            const tentsDoAtletaNaNuvem = tentativasNuvem.filter(t => Number(t.inscricao_id) === Number(insc.id));
            if (tentsDoAtletaNaNuvem.length > 0) {
                const stmtTent = db.prepare(`
                    INSERT OR IGNORE INTO tentativas (
                        inscricao_id, movimento, numero_tentativa, peso_solicitado, estado,
                        luz_esquerda, luz_central, luz_direita, resultado_valido, sync_nuvem
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                `);
                tentsDoAtletaNaNuvem.forEach(t => {
                    stmtTent.run(
                        novaInscId,
                        validarMovimento(t.movimento),
                        Number(t.numero_tentativa) || 1,
                        sanitizarPeso(t.peso_solicitado, false),
                        ['pendente', 'aguardando_pedida', 'concluido'].includes(t.estado) ? t.estado : 'pendente',
                        t.luz_esquerda !== undefined ? t.luz_esquerda : null,
                        t.luz_central !== undefined ? t.luz_central : null,
                        t.luz_direita !== undefined ? t.luz_direita : null,
                        t.resultado_valido !== undefined ? t.resultado_valido : null
                    );
                });
            }
            garantirPrimeirasTentativasInscricao(novaInscId, insc.modalidade_escolhida || 'Full Power');
            novosAdicionados++;
        });
    })();

    if (novosAdicionados > 0) {
        io.emit('dados_atletas_atualizados', { evento_id: Number(eventoLocalId), acao: 'mesclado_da_nuvem' });
        io.emit('fila_atualizada', { evento_id: Number(eventoLocalId) });
    }
    return novosAdicionados;
}

// Antes de subir um pacote local para a nuvem, verifica se já existe campeonato na nuvem com o mesmo ID ou Nome
// e puxa eventuais inscritos da Web para o SQLite local para nunca sobrescrever nem perder atletas online!
async function sincronizarEMesclarComNuvemAntesDoPush(eventoId, ctx) {
    if (!ctx || !ctx.temCredencialRemota) return;
    const evLocal = db.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId);
    if (!evLocal || evLocal.nome === 'Cadastros Cancelados') return;

    try {
        let nuvemIdAlvo = evLocal.nuvem_evento_id;
        let pacoteRemoto = null;

        if (nuvemIdAlvo) {
            const resp = await fetchNuvemComTimeout(
                `${ctx.remoteUrl}/api/nuvem/pacote/${encodeURIComponent(nuvemIdAlvo)}?apenas_local=1`,
                { headers: ctx.headersPadrao },
                4500
            );
            if (resp.ok) {
                pacoteRemoto = await resp.json();
            }
        }

        // Se não encontrou pelo ID (ex: organizador criou no App Offline com o mesmo nome do evento criado na Web), busca pelo Nome
        if (!pacoteRemoto) {
            const quota = await atualizarCacheQuotaDaNuvem(true);
            if (quota && Array.isArray(quota.campeonatos_remotos)) {
                const matchNome = quota.campeonatos_remotos.find(
                    c => c.nome_evento.toLowerCase() === String(evLocal.nome || '').trim().toLowerCase()
                );
                if (matchNome && matchNome.nuvem_id) {
                    const jaUsadoOutroEventoLocal = db.prepare(
                        "SELECT id FROM eventos WHERE nuvem_evento_id = ? AND id != ? AND nome != 'Cadastros Cancelados' LIMIT 1"
                    ).get(matchNome.nuvem_id, eventoId);

                    if (!jaUsadoOutroEventoLocal) {
                        nuvemIdAlvo = matchNome.nuvem_id;
                        db.prepare('UPDATE eventos SET nuvem_evento_id = ? WHERE id = ?').run(nuvemIdAlvo, eventoId);
                        const respNome = await fetchNuvemComTimeout(
                            `${ctx.remoteUrl}/api/nuvem/pacote/${encodeURIComponent(nuvemIdAlvo)}?apenas_local=1`,
                            { headers: ctx.headersPadrao },
                            4500
                        );
                        if (respNome.ok) {
                            pacoteRemoto = await respNome.json();
                        }
                    }
                }
            }
        }

        if (pacoteRemoto && Array.isArray(pacoteRemoto.inscricoes) && pacoteRemoto.inscricoes.length > 0) {
            mesclarAtletasDoPacoteNuvemNoEventoLocal(eventoId, pacoteRemoto, true);
        }

        // Garante que versao_sync local seja superior à da nuvem quando o Offline atualiza a nuvem
        if (pacoteRemoto && Number(pacoteRemoto.versao_sync) >= Number(evLocal.versao_sync || 1)) {
            db.prepare('UPDATE eventos SET versao_sync = ? WHERE id = ?')
                .run(Number(pacoteRemoto.versao_sync) + 1, eventoId);
        }
    } catch (e) {
        // Silencioso se offline: segue operando normalmente
    }
}

function gerarPacoteEventoParaNuvem(eventoId, organizadorIdOverride = null) {
    const evento = db.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId);
    if (!evento || evento.nome === 'Cadastros Cancelados') return null;

    const orgId = sanitizarOrganizadorId(organizadorIdOverride || evento.organizador_id || 'LOCAL');
    const nuvemId = evento.nuvem_evento_id || gerarUUIDNuvem();

    if (!evento.nuvem_evento_id || evento.organizador_id !== orgId) {
        db.prepare('UPDATE eventos SET organizador_id = ?, nuvem_evento_id = ? WHERE id = ?')
            .run(orgId, nuvemId, eventoId);
        evento.organizador_id = orgId;
        evento.nuvem_evento_id = nuvemId;
    }

    const inscricoes = db.prepare(`
        SELECT 
            i.*,
            a.nome, a.cpf, a.data_nascimento, a.sexo, a.whatsapp, a.cidade, a.estado, a.equipe, a.pcd,
            a.instagram, a.youtube, a.outros_social
        FROM inscricoes i
        JOIN atletas a ON i.atleta_id = a.id
        WHERE i.evento_id = ?
        ORDER BY i.id ASC
    `).all(eventoId);

    const tentativas = db.prepare(`
        SELECT t.*
        FROM tentativas t
        JOIN inscricoes i ON t.inscricao_id = i.id
        WHERE i.evento_id = ?
        ORDER BY t.id ASC
    `).all(eventoId);

    // Pilar 4: Inclui o estado ativo das plataformas vinculadas a este campeonato para recuperação instantânea
    const estadosDasPlataformasDoEvento = {};
    for (let p = 1; p <= 5; p++) {
        const est = estadoPlataformas[p];
        if (est && Number(est.evento_id) === Number(eventoId)) {
            estadosDasPlataformasDoEvento[p] = JSON.parse(JSON.stringify(est));
        }
    }

    const pacote = {
        nuvem_id: nuvemId,
        organizador_id: orgId,
        versao_sync: Number(evento.versao_sync) || 1,
        evento,
        inscricoes,
        tentativas,
        atletas_arquivados: obterAtletasArquivadosDoEvento(eventoId),
        estados_plataformas: estadosDasPlataformasDoEvento,
        exportado_em: new Date().toISOString()
    };

    pacote.checksum_sha256 = calcularHashPacoteNuvem(pacote);
    return pacote;
}

// Salva no Repositório Principal da Nuvem + Cofre Rotativo de 20 Snapshots Point-in-Time (Pilar 4)
function salvarPacoteNoRepositorioNuvem(pacote, opcoes = {}) {
    const validacao = validarESanitizarPacoteNuvem(pacote);
    if (!validacao.valido) {
        throw new Error(validacao.erro);
    }

    const nuvemId = pacote.nuvem_id || pacote.evento.nuvem_evento_id || gerarUUIDNuvem();
    const orgId = sanitizarOrganizadorId(pacote.organizador_id || pacote.evento.organizador_id || 'LOCAL');
    const qtdAtletas = Array.isArray(pacote.inscricoes) ? pacote.inscricoes.length : 0;
    const versaoSync = Number(pacote.versao_sync || pacote.evento?.versao_sync) || 1;
    const checksum = validacao.checksum_sha256;
    const payloadStr = JSON.stringify(pacote);

    db.transaction(() => {
        if (!opcoes.permitir_zerar_atletas && qtdAtletas === 0) {
            const atualNuvem = db.prepare('SELECT qtd_atletas FROM nuvem_campeonatos WHERE nuvem_id = ?').get(nuvemId);
            if (atualNuvem && Number(atualNuvem.qtd_atletas) > 0) {
                throw new Error(`Proteção Anti-Corrupção: O campeonato na nuvem possui ${atualNuvem.qtd_atletas} atletas e recusou ser sobrescrito por um pacote vazio (0 atletas).`);
            }
        }

        db.prepare(`
            INSERT INTO nuvem_campeonatos (nuvem_id, organizador_id, nome_evento, data_evento, qtd_atletas, versao_sync, checksum_sha256, payload_json, atualizado_em)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(nuvem_id) DO UPDATE SET
                organizador_id = excluded.organizador_id,
                nome_evento = excluded.nome_evento,
                data_evento = excluded.data_evento,
                qtd_atletas = excluded.qtd_atletas,
                versao_sync = excluded.versao_sync,
                checksum_sha256 = excluded.checksum_sha256,
                payload_json = excluded.payload_json,
                atualizado_em = CURRENT_TIMESTAMP
        `).run(
            nuvemId,
            orgId,
            pacote.evento.nome,
            pacote.evento.data,
            qtdAtletas,
            versaoSync,
            checksum,
            payloadStr
        );

        const ultimoSnap = db.prepare(`
            SELECT checksum_sha256 FROM nuvem_snapshots_historico
            WHERE nuvem_id = ?
            ORDER BY id DESC LIMIT 1
        `).get(nuvemId);

        if (!ultimoSnap || ultimoSnap.checksum_sha256 !== checksum) {
            db.prepare(`
                INSERT INTO nuvem_snapshots_historico (nuvem_id, organizador_id, versao_sync, qtd_atletas, checksum_sha256, payload_json, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(nuvemId, orgId, versaoSync, qtdAtletas, checksum, payloadStr);

            db.prepare(`
                DELETE FROM nuvem_snapshots_historico
                WHERE nuvem_id = ?
                  AND id NOT IN (
                      SELECT id FROM nuvem_snapshots_historico
                      WHERE nuvem_id = ?
                      ORDER BY id DESC
                      LIMIT 20
                  )
            `).run(nuvemId, nuvemId);
        }
    })();

    return nuvemId;
}

// 1. Ler e Salvar Configuração/Login do Organizador
app.get('/api/nuvem/config', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const cfg = db.prepare('SELECT * FROM config_nuvem WHERE id = 1').get();
        res.json(cfg || { organizador_id: '', organizador_nome: '', cloud_url: '', cloud_token: '' });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.post('/api/nuvem/config', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const { organizador_id, organizador_nome, cloud_url, cloud_token } = req.body || {};
        const orgLimpo = sanitizarOrganizadorId(organizador_id);
        const urlLimpa = String(cloud_url || '').trim().replace(/\/+$/, '');
        const tokenLimpo = String(cloud_token || '').trim();

        db.transaction(() => {
            const cfgAtual = db.prepare('SELECT organizador_id, cloud_url, cloud_token FROM config_nuvem WHERE id = 1').get() || {};
            const mudouCredencial = (
                cfgAtual.organizador_id !== orgLimpo ||
                String(cfgAtual.cloud_url || '') !== urlLimpa ||
                String(cfgAtual.cloud_token || '') !== tokenLimpo
            );

            db.prepare(`
                UPDATE config_nuvem
                SET organizador_id = ?, organizador_nome = ?, cloud_url = ?, cloud_token = ?, atualizado_em = CURRENT_TIMESTAMP
                WHERE id = 1
            `).run(
                orgLimpo,
                String(organizador_nome || '').trim(),
                urlLimpa,
                tokenLimpo
            );

            // Só coloca os eventos locais na fila de re-sincronização se a conta/credencial realmente mudou
            if (mudouCredencial && orgLimpo !== 'LOCAL' && tokenLimpo) {
                cacheQuotaLicencaNuvem.atualizado_em = 0;
                db.prepare(`
                    UPDATE eventos
                    SET sync_nuvem = CASE WHEN COALESCE(sync_nuvem, 0) = -1 THEN -1 ELSE 0 END
                    WHERE nome != 'Cadastros Cancelados'
                `).run();

                if (typeof agendarPushImediatoNuvem === 'function') {
                    agendarPushImediatoNuvem(250);
                }
            }
        })();

        res.json({ sucesso: true, organizador_id: orgLimpo });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// 2. Rotas de Hub da Nuvem (Para receber envios e listar campeonatos por organizador_id)
app.get('/api/nuvem/campeonatos', async (req, res) => {
    try {
        const ctx = obterContextoRemotoNuvem(req.query.organizador_id, req.query.cloud_url);

        if (ctx.temCredencialRemota && !req.query.apenas_local) {
            try {
                const respostaRemota = await fetchNuvemComTimeout(
                    `${ctx.remoteUrl}/api/nuvem/campeonatos?organizador_id=${encodeURIComponent(ctx.orgId)}&apenas_local=1`,
                    { headers: ctx.headersPadrao },
                    8000
                );
                if (respostaRemota.ok) {
                    const dadosRemotos = await respostaRemota.json();
                    if (Array.isArray(dadosRemotos)) {
                        const primeiro = dadosRemotos[0] || {};
                        cacheQuotaLicencaNuvem = {
                            atualizado_em: Date.now(),
                            ultimo_erro_rede_em: 0,
                            organizador_id: ctx.orgId,
                            max_campeonatos: Number(primeiro.max_campeonatos) || cacheQuotaLicencaNuvem.max_campeonatos || 30,
                            max_inscricoes: Number(primeiro.max_inscricoes) || cacheQuotaLicencaNuvem.max_inscricoes || 500,
                            campeonatos_remotos: dadosRemotos.map(c => ({
                                nuvem_id: String(c.nuvem_id || ''),
                                nome_evento: String(c.nome_evento || '').trim(),
                                qtd_atletas: Number(c.qtd_atletas) || 0,
                                versao_sync: Number(c.versao_sync) || 1
                            }))
                        };
                    }
                    return res.json(dadosRemotos);
                }
                if (respostaRemota.status === 401 || respostaRemota.status === 403) {
                    const errBody = await respostaRemota.json().catch(() => ({}));
                    return res.status(respostaRemota.status).json({
                        erro: errBody.erro || "Falha de autenticação na Nuvem (verifique seu ID de Organizador e Token)."
                    });
                }
            } catch (e) {
                console.warn("⚠️ [NUVEM] Servidor remoto indisponível no momento, exibindo repositório local:", e.message);
            }
        }

        const lista = db.prepare(`
            SELECT nuvem_id, organizador_id, nome_evento, data_evento, qtd_atletas, versao_sync, checksum_sha256, atualizado_em
            FROM nuvem_campeonatos
            WHERE organizador_id = ?
            ORDER BY atualizado_em DESC
        `).all(ctx.orgId);

        res.json(lista);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Listar os últimos 20 Snapshots Point-in-Time de um campeonato na Nuvem
app.get('/api/nuvem/historico/:nuvem_id', async (req, res) => {
    try {
        const nuvemId = req.params.nuvem_id;
        const ctx = obterContextoRemotoNuvem();

        if (ctx.temCredencialRemota && !req.query.apenas_local) {
            try {
                const resp = await fetchNuvemComTimeout(
                    `${ctx.remoteUrl}/api/nuvem/historico/${encodeURIComponent(nuvemId)}?apenas_local=1`,
                    { headers: ctx.headersPadrao },
                    8000
                );
                if (resp.ok) {
                    return res.json(await resp.json());
                }
                if (resp.status === 401 || resp.status === 403) {
                    const errBody = await resp.json().catch(() => ({}));
                    return res.status(resp.status).json({
                        erro: errBody.erro || "Falha de autenticação na Nuvem ao consultar histórico."
                    });
                }
            } catch (e) {
                console.warn("⚠️ [NUVEM] Histórico remoto indisponível, exibindo cofre local:", e.message);
            }
        }

        const historico = db.prepare(`
            SELECT id, nuvem_id, organizador_id, versao_sync, qtd_atletas, checksum_sha256, criado_em
            FROM nuvem_snapshots_historico
            WHERE nuvem_id = ?
            ORDER BY id DESC
            LIMIT 20
        `).all(nuvemId);

        res.json(historico);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Enviar / Publicar manualmente um campeonato local para a Nuvem sob o organizador_id
app.post('/api/nuvem/publicar/:evento_id', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        const eventoId = req.params.evento_id;
        const ctx = obterContextoRemotoNuvem(req.body?.organizador_id);
        const criarNovaCopiaNaNuvem = Boolean(req.body?.como_nova_copia);
        const apenasLocal = Boolean(req.body?.apenas_local);

        // Antes de publicar na nuvem remota, mescla eventuais atletas inscritos pela Web no mesmo campeonato
        if (!apenasLocal && !criarNovaCopiaNaNuvem && ctx.temCredencialRemota) {
            await sincronizarEMesclarComNuvemAntesDoPush(eventoId, ctx);
        }

        const pacote = gerarPacoteEventoParaNuvem(eventoId, ctx.orgId);
        if (!pacote) {
            return res.status(404).json({ erro: "Campeonato local não encontrado." });
        }

        if (criarNovaCopiaNaNuvem) {
            pacote.nuvem_id = gerarUUIDNuvem();
            pacote.evento.nome = `${pacote.evento.nome} (Cópia Nuvem)`;
            pacote.checksum_sha256 = calcularHashPacoteNuvem(pacote);
        }

        const nuvemId = salvarPacoteNoRepositorioNuvem(pacote, { permitir_zerar_atletas: true });

        let enviadoRemoto = false;
        let erroRemoto = null;

        if (!apenasLocal) {
            if (ctx.temCredencialRemota) {
                try {
                    const resp = await fetchNuvemComTimeout(`${ctx.remoteUrl}/api/nuvem/receber_pacote`, {
                        method: 'POST',
                        headers: {
                            ...ctx.headersPadrao,
                            'Content-Type': 'application/json',
                            'X-Payload-SHA256': pacote.checksum_sha256
                        },
                        body: JSON.stringify({
                            ...pacote,
                            permitir_zerar_atletas: true
                        })
                    }, 8000);

                    if (resp.ok) {
                        enviadoRemoto = true;
                        await atualizarCacheQuotaDaNuvem(true);
                    } else {
                        const errBody = await resp.json().catch(() => ({}));
                        erroRemoto = errBody.erro || `HTTP ${resp.status}`;
                    }
                } catch (e) {
                    erroRemoto = e.message;
                    console.warn("⚠️ [NUVEM] Salvo no repositório local; falha ao contactar nuvem remota:", e.message);
                }
            } else {
                erroRemoto = "Chave/Token de Acesso ausente ou Organizador definido como LOCAL (salvo apenas no cofre deste computador).";
            }
        }

        if (enviadoRemoto || (!ctx.temCredencialRemota && apenasLocal)) {
            db.transaction(() => {
                db.prepare(`
                    UPDATE eventos
                    SET sync_nuvem = 1, ultimo_sync_em = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(eventoId);

                db.prepare(`
                    UPDATE tentativas SET sync_nuvem = 1
                    WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)
                `).run(eventoId);
            })();
        }

        res.json({
            sucesso: true,
            nuvem_id: nuvemId,
            organizador_id: ctx.orgId,
            checksum_sha256: pacote.checksum_sha256,
            enviado_remoto: enviadoRemoto,
            aviso_remoto: erroRemoto,
            qtd_atletas: pacote.inscricoes.length
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Publicar resultados finais diretamente da aba Resultados do aplicativo desktop para o Acervo Brasil Powerlifting
app.post('/api/nuvem/publicar-acervo-local/:evento_id', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        const eventoId = req.params.evento_id;
        const ctx = obterContextoRemotoNuvem();

        if (!ctx.temCredencialRemota) {
            return res.status(400).json({
                erro: "Você está no modo Offline (LOCAL) ou sem Chave/Token configurado. Acesse a aba '☁️ Nuvem' no topo da tela, insira seu ID de Organizador e Token de Acesso e tente novamente."
            });
        }

        await sincronizarEMesclarComNuvemAntesDoPush(eventoId, ctx);

        const pacote = gerarPacoteEventoParaNuvem(eventoId, ctx.orgId);
        if (!pacote) {
            return res.status(404).json({ erro: "Campeonato local não encontrado." });
        }

        // 1. Salva no cofre local e garante que o último estado da Mesa/Resultados subiu para a Nuvem
        salvarPacoteNoRepositorioNuvem(pacote, { permitir_zerar_atletas: true });

        const respSync = await fetchNuvemComTimeout(`${ctx.remoteUrl}/api/nuvem/receber_pacote`, {
            method: 'POST',
            headers: {
                ...ctx.headersPadrao,
                'Content-Type': 'application/json',
                'X-Payload-SHA256': pacote.checksum_sha256
            },
            body: JSON.stringify({
                ...pacote,
                permitir_zerar_atletas: true
            })
        }, 12000);

        if (!respSync.ok) {
            const errSync = await respSync.json().catch(() => ({}));
            return res.status(respSync.status).json({
                erro: errSync.erro || `Falha ao sincronizar pacote com a nuvem (HTTP ${respSync.status}).`
            });
        }

        // Marca o evento local como sincronizado
        db.transaction(() => {
            db.prepare(`
                UPDATE eventos
                SET sync_nuvem = 1, ultimo_sync_em = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(eventoId);

            db.prepare(`
                UPDATE tentativas SET sync_nuvem = 1
                WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)
            `).run(eventoId);
        })();

        // 2. Aciona a publicação no Acervo Estático (JSON + Índice Global + llms.txt)
        const respAcervo = await fetchNuvemComTimeout(`${ctx.remoteUrl}/api/nuvem/publicar-acervo/${encodeURIComponent(pacote.nuvem_id)}`, {
            method: 'POST',
            headers: {
                ...ctx.headersPadrao,
                'Content-Type': 'application/json'
            }
        }, 15000);

        const dadosAcervo = await respAcervo.json().catch(() => ({}));
        if (!respAcervo.ok) {
            return res.status(respAcervo.status).json({
                erro: dadosAcervo.erro || `Erro ao gerar acervo estático na nuvem (HTTP ${respAcervo.status}).`
            });
        }

        res.json({
            sucesso: true,
            nuvem_id: pacote.nuvem_id,
            nome_evento: pacote.evento.nome,
            qtd_atletas_exportados: dadosAcervo.qtd_atletas_exportados || pacote.inscricoes.length,
            publicado_github_estatico: dadosAcervo.publicado_github_estatico
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Endpoint recetor local
app.post('/api/nuvem/receber_pacote', (req, res) => {
    try {
        const cfg = db.prepare('SELECT cloud_token FROM config_nuvem WHERE id = 1').get();
        const tokenEsperado = String(cfg?.cloud_token || '').trim();
        if (tokenEsperado) {
            const authHeader = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
            if (authHeader !== tokenEsperado) {
                return res.status(401).json({ erro: "Token de acesso da Nuvem inválido." });
            }
        }

        const hashHeader = req.headers['x-payload-sha256'] || null;
        const validacao = validarESanitizarPacoteNuvem(req.body, hashHeader);
        if (!validacao.valido) {
            return res.status(validacao.status || 422).json({ erro: validacao.erro });
        }

        const nuvemId = salvarPacoteNoRepositorioNuvem(validacao.pacote, {
            permitir_zerar_atletas: Boolean(req.body?.permitir_zerar_atletas)
        });
        res.json({
            sucesso: true,
            nuvem_id: nuvemId,
            checksum_sha256: validacao.checksum_sha256
        });
    } catch (erro) {
        res.status(422).json({ erro: erro.message });
    }
});

// Obter o pacote completo de um campeonato da nuvem pelo nuvem_id (ou de um snapshot específico do histórico)
app.get('/api/nuvem/pacote/:nuvem_id', async (req, res) => {
    try {
        const nuvemId = req.params.nuvem_id;
        const snapshotId = req.query.snapshot_id ? Number(req.query.snapshot_id) : null;
        const ctx = obterContextoRemotoNuvem();

        if (ctx.temCredencialRemota && !req.query.apenas_local) {
            try {
                const querySnap = snapshotId
                    ? `?snapshot_id=${encodeURIComponent(snapshotId)}&apenas_local=1`
                    : '?apenas_local=1';
                const resp = await fetchNuvemComTimeout(
                    `${ctx.remoteUrl}/api/nuvem/pacote/${encodeURIComponent(nuvemId)}${querySnap}`,
                    { headers: ctx.headersPadrao },
                    10000
                );
                if (resp.ok) {
                    return res.json(await resp.json());
                }
                if (resp.status === 401 || resp.status === 403) {
                    const errBody = await resp.json().catch(() => ({}));
                    return res.status(resp.status).json({
                        erro: errBody.erro || "Falha de autenticação na Nuvem ao baixar pacote."
                    });
                }
            } catch (e) {
                console.warn("⚠️ [NUVEM] Pacote remoto indisponível, buscando no cofre local:", e.message);
            }
        }

        if (snapshotId) {
            const snap = db.prepare('SELECT payload_json FROM nuvem_snapshots_historico WHERE id = ? AND nuvem_id = ?')
                .get(snapshotId, nuvemId);
            if (!snap) return res.status(404).json({ erro: "Snapshot histórico não encontrado na nuvem." });
            return res.json(parseJSONSeguro(snap.payload_json, {}));
        }

        const row = db.prepare('SELECT payload_json FROM nuvem_campeonatos WHERE nuvem_id = ?').get(nuvemId);
        if (!row) return res.status(404).json({ erro: "Campeonato não encontrado na nuvem." });
        res.json(parseJSONSeguro(row.payload_json, {}));
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// MOTOR DE IMPORTAÇÃO / DOWNLOAD DA NUVEM COM FUSÃO INTELIGENTE (ZERO PERDA DE ATLETAS):
// 1. 'SUBSTITUIR'     -> Atualiza configurações do campeonato com as da Nuvem e ADICIONA novos atletas da Web mantendo os atletas locais (ou restaura snapshot histórico se snapshot_id for escolhido)
// 2. 'COPIA'          -> Cria uma cópia independente do campeonato (local e opcionalmente na nuvem)
// 3. 'APENAS_ATLETAS' -> Mescla todos os atletas da Nuvem + App Offline e reinicia pesagens/tentativas de teste
// ============================================================================
app.post('/api/nuvem/importar', exigirMaquinaLocalAPI, async (req, res) => {
    const {
        nuvem_id,
        snapshot_id,
        pacote_direto,
        modo,
        evento_local_alvo_id,
        novo_nome_evento,
        salvar_copia_na_nuvem
    } = req.body || {};

    const modoSeguro = ['SUBSTITUIR', 'COPIA', 'APENAS_ATLETAS'].includes(modo) ? modo : 'COPIA';

    try {
        await criarSnapshotSeguranca('importar_nuvem');

        const ctx = obterContextoRemotoNuvem();
        let pacote = pacote_direto || null;
        let baixadoDaNuvemRemota = false;

        if (!pacote && nuvem_id) {
            const querySnap = snapshot_id ? `?snapshot_id=${encodeURIComponent(snapshot_id)}&apenas_local=1` : '?apenas_local=1';

            if (ctx.temCredencialRemota) {
                try {
                    const r = await fetchNuvemComTimeout(
                        `${ctx.remoteUrl}/api/nuvem/pacote/${encodeURIComponent(nuvem_id)}${querySnap}`,
                        { headers: ctx.headersPadrao },
                        10000
                    );
                    if (r.ok) {
                        pacote = await r.json();
                        baixadoDaNuvemRemota = true;
                    } else if (r.status === 401 || r.status === 403) {
                        const errBody = await r.json().catch(() => ({}));
                        return res.status(r.status).json({
                            erro: errBody.erro || "Falha de autenticação na Nuvem ao importar pacote."
                        });
                    }
                } catch (e) {
                    console.warn("⚠️ [NUVEM] Buscando pacote do cache local:", e.message);
                }
            }

            if (!pacote) {
                if (snapshot_id) {
                    const snapRow = db.prepare('SELECT payload_json FROM nuvem_snapshots_historico WHERE id = ? AND nuvem_id = ?')
                        .get(Number(snapshot_id), nuvem_id);
                    if (snapRow) pacote = parseJSONSeguro(snapRow.payload_json, null);
                } else {
                    const row = db.prepare('SELECT payload_json FROM nuvem_campeonatos WHERE nuvem_id = ?').get(nuvem_id);
                    if (row) pacote = parseJSONSeguro(row.payload_json, null);
                }
            }
        }

        const validacao = validarESanitizarPacoteNuvem(pacote);
        if (!validacao.valido) {
            return res.status(validacao.status || 422).json({ erro: validacao.erro });
        }
        pacote = validacao.pacote;

        if (baixadoDaNuvemRemota && !snapshot_id) {
            try {
                salvarPacoteNoRepositorioNuvem(pacote, { permitir_zerar_atletas: true });
            } catch (eCache) {
                console.warn("⚠️ [NUVEM] Aviso ao atualizar cache local de nuvem:", eCache.message);
            }
        }

        const evOrig = pacote.evento;
        const inscricoesOrig = Array.isArray(pacote.inscricoes) ? pacote.inscricoes : [];
        const tentativasOrig = Array.isArray(pacote.tentativas) ? pacote.tentativas : [];
        const orgIdPacote = sanitizarOrganizadorId(pacote.organizador_id || evOrig.organizador_id || 'LOCAL');
        const orgId = (ctx.orgId && ctx.orgId !== 'LOCAL') ? ctx.orgId : orgIdPacote;
        const versaoSyncImportada = Number(pacote.versao_sync || evOrig.versao_sync) || 1;
        const ehRestauracaoSnapshotEspecifico = Boolean(snapshot_id);

        const resultadoImportacao = db.transaction(() => {
            let eventoLocalId = null;
            let nuvemEventoIdFinal = pacote.nuvem_id || evOrig.nuvem_evento_id || gerarUUIDNuvem();
            let usarModoMesclagemAditiva = false;

            const strModalidades = typeof evOrig.modalidades === 'string' ? evOrig.modalidades : JSON.stringify(evOrig.modalidades || ['Full Power']);
            const strDivisoes = typeof evOrig.divisoes_idade === 'string' ? evOrig.divisoes_idade : JSON.stringify(evOrig.divisoes_idade || ['Open']);
            const strPesoM = typeof evOrig.categorias_peso_masculino === 'string' ? evOrig.categorias_peso_masculino : JSON.stringify(evOrig.categorias_peso_masculino || []);
            const strPesoF = typeof evOrig.categorias_peso_feminino === 'string' ? evOrig.categorias_peso_feminino : JSON.stringify(evOrig.categorias_peso_feminino || []);
            const strEquip = typeof evOrig.equipamentos === 'string' ? evOrig.equipamentos : JSON.stringify(evOrig.equipamentos || ['Raw']);

            if (modoSeguro === 'SUBSTITUIR') {
                let existente = null;
                if (evento_local_alvo_id) {
                    existente = db.prepare('SELECT id, versao_sync FROM eventos WHERE id = ?').get(evento_local_alvo_id);
                }
                if (!existente && nuvemEventoIdFinal) {
                    existente = db.prepare('SELECT id, versao_sync FROM eventos WHERE nuvem_evento_id = ?').get(nuvemEventoIdFinal);
                }
                if (!existente) {
                    existente = db.prepare("SELECT id, versao_sync FROM eventos WHERE LOWER(nome) = LOWER(?) AND nome != 'Cadastros Cancelados'").get(evOrig.nome);
                }

                if (existente) {
                    eventoLocalId = existente.id;
                    const qtdAtletasLocaisAntes = db.prepare('SELECT COUNT(1) as qtd FROM inscricoes WHERE evento_id = ?').get(eventoLocalId)?.qtd || 0;
                    const novaVersaoSync = Math.max(versaoSyncImportada, Number(existente.versao_sync) || 1) + 1;

                    // Atualiza os dados estruturais do campeonato com as configurações vindas da nuvem
                    db.prepare(`
                        UPDATE eventos
                        SET nome = ?, data = ?, modalidades = ?, divisoes_idade = ?,
                            categorias_peso_masculino = ?, categorias_peso_feminino = ?,
                            num_plataformas = ?, anilhas_calibradas = ?, equipamentos = ?,
                            organizador_id = ?, nuvem_evento_id = ?,
                            versao_sync = ?, sync_nuvem = 0, atualizado_em = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(
                        novo_nome_evento ? String(novo_nome_evento).trim() : evOrig.nome,
                        evOrig.data,
                        strModalidades,
                        strDivisoes,
                        strPesoM,
                        strPesoF,
                        validarPlataforma(evOrig.num_plataformas || 1),
                        evOrig.anilhas_calibradas ? 1 : 0,
                        strEquip,
                        orgId,
                        nuvemEventoIdFinal,
                        novaVersaoSync,
                        eventoLocalId
                    );

                    // Se NÃO for restauração de um snapshot histórico específico e o campeonato local já possui atletas,
                    // fazemos a MESCLAGEM ADITIVA (adiciona os atletas da nuvem sem apagar os atletas locais!)
                    if (!ehRestauracaoSnapshotEspecifico && qtdAtletasLocaisAntes > 0) {
                        usarModoMesclagemAditiva = true;
                    } else {
                        db.prepare('DELETE FROM tentativas WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)').run(eventoLocalId);
                        db.prepare('DELETE FROM inscricoes WHERE evento_id = ?').run(eventoLocalId);
                    }
                } else {
                    const info = db.prepare(`
                        INSERT INTO eventos (nome, data, modalidades, divisoes_idade, categorias_peso_masculino, categorias_peso_feminino, num_plataformas, anilhas_calibradas, equipamentos, organizador_id, nuvem_evento_id, versao_sync, sync_nuvem, ultimo_sync_em, atualizado_em)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    `).run(
                        novo_nome_evento ? String(novo_nome_evento).trim() : evOrig.nome,
                        evOrig.data,
                        strModalidades,
                        strDivisoes,
                        strPesoM,
                        strPesoF,
                        validarPlataforma(evOrig.num_plataformas || 1),
                        evOrig.anilhas_calibradas ? 1 : 0,
                        strEquip,
                        orgId,
                        nuvemEventoIdFinal,
                        versaoSyncImportada
                    );
                    eventoLocalId = info.lastInsertRowid;
                }
            } else if (modoSeguro === 'COPIA') {
                nuvemEventoIdFinal = gerarUUIDNuvem();
                const nomeCopia = novo_nome_evento
                    ? String(novo_nome_evento).trim()
                    : `${evOrig.nome} (Cópia)`;

                const info = db.prepare(`
                    INSERT INTO eventos (nome, data, modalidades, divisoes_idade, categorias_peso_masculino, categorias_peso_feminino, num_plataformas, anilhas_calibradas, equipamentos, organizador_id, nuvem_evento_id, versao_sync, sync_nuvem, atualizado_em)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, CURRENT_TIMESTAMP)
                `).run(
                    nomeCopia,
                    evOrig.data,
                    strModalidades,
                    strDivisoes,
                    strPesoM,
                    strPesoF,
                    validarPlataforma(evOrig.num_plataformas || 1),
                    evOrig.anilhas_calibradas ? 1 : 0,
                    strEquip,
                    orgId,
                    nuvemEventoIdFinal
                );
                eventoLocalId = info.lastInsertRowid;
            } else if (modoSeguro === 'APENAS_ATLETAS') {
                if (evento_local_alvo_id) {
                    const alvo = db.prepare('SELECT id FROM eventos WHERE id = ?').get(evento_local_alvo_id);
                    if (alvo) {
                        eventoLocalId = alvo.id;
                        // Limpa apenas pesagens, baterias e tentativas de teste dos atletas locais (preservando os atletas inscritos localmente!)
                        db.prepare('DELETE FROM tentativas WHERE inscricao_id IN (SELECT id FROM inscricoes WHERE evento_id = ?)').run(eventoLocalId);
                        db.prepare(`
                            UPDATE inscricoes
                            SET peso_corporal_oficial = NULL,
                                rack_agachamento = NULL,
                                rack_supino = NULL,
                                trava_supino = NULL,
                                bateria_agachamento = NULL,
                                bateria_supino = NULL,
                                bateria_terra = NULL,
                                plataforma_agachamento = 1,
                                plataforma_supino = 1,
                                plataforma_terra = 1,
                                remanejado_manual = 0
                            WHERE evento_id = ?
                        `).run(eventoLocalId);
                        usarModoMesclagemAditiva = true;
                        marcarEventoParaSyncNuvem(eventoLocalId);
                    }
                }

                if (!eventoLocalId) {
                    nuvemEventoIdFinal = gerarUUIDNuvem();
                    const nomeOficial = novo_nome_evento
                        ? String(novo_nome_evento).trim()
                        : `${evOrig.nome} (Oficial)`;

                    const info = db.prepare(`
                        INSERT INTO eventos (nome, data, modalidades, divisoes_idade, categorias_peso_masculino, categorias_peso_feminino, num_plataformas, anilhas_calibradas, equipamentos, organizador_id, nuvem_evento_id, versao_sync, sync_nuvem, atualizado_em)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, CURRENT_TIMESTAMP)
                    `).run(
                        nomeOficial,
                        evOrig.data,
                        strModalidades,
                        strDivisoes,
                        strPesoM,
                        strPesoF,
                        validarPlataforma(evOrig.num_plataformas || 1),
                        evOrig.anilhas_calibradas ? 1 : 0,
                        strEquip,
                        orgId,
                        nuvemEventoIdFinal
                    );
                    eventoLocalId = info.lastInsertRowid;
                }
            }

            if (!usarModoMesclagemAditiva) {
                for (let p = 1; p <= 5; p++) {
                    if (Number(estadoPlataformas[p]?.evento_id) === Number(eventoLocalId)) {
                        estadoPlataformas[p] = criarEstadoPadraoPlataforma(p);
                        salvarEstadoPlataforma(p, false);
                    }
                }
            }

            const mapaInscricaoAntigaParaNova = {};
            const mapaTentativaAntigaParaNova = {};

            inscricoesOrig.forEach(insc => {
                // Se estivermos mesclando com um evento local que já tem atletas, verifica se o atleta já está inscrito localmente
                if (usarModoMesclagemAditiva) {
                    const existenteNoEvento = localizarInscricaoEquivalenteNoEvento(eventoLocalId, insc);
                    if (existenteNoEvento) {
                        mapaInscricaoAntigaParaNova[insc.id] = existenteNoEvento.id;

                        // Atualiza dados pessoais e preserva flag LGPD sem destruir pesagem/baterias já feitas no App Offline
                        const cpfLimpoExistente = sanitizarCPF(insc.cpf);
                        db.prepare(`
                            UPDATE atletas
                            SET cpf = COALESCE(?, cpf),
                                whatsapp = CASE WHEN COALESCE(whatsapp, '') = '' THEN ? ELSE whatsapp END,
                                cidade = CASE WHEN COALESCE(cidade, '') = '' THEN ? ELSE cidade END,
                                equipe = CASE WHEN COALESCE(equipe, 'Sem Equipe') = 'Sem Equipe' THEN ? ELSE equipe END,
                                instagram = COALESCE(?, instagram),
                                youtube = COALESCE(?, youtube),
                                outros_social = COALESCE(?, outros_social)
                            WHERE id = ?
                        `).run(
                            cpfLimpoExistente,
                            String(insc.whatsapp || ''),
                            String(insc.cidade || ''),
                            String(insc.equipe || 'Sem Equipe'),
                            insc.instagram || null,
                            insc.youtube || null,
                            insc.outros_social || null,
                            existenteNoEvento.atleta_id
                        );

                        if (insc.anonimizar_historico) {
                            db.prepare('UPDATE inscricoes SET anonimizar_historico = 1 WHERE id = ?').run(existenteNoEvento.id);
                        }
                        if (modoSeguro === 'APENAS_ATLETAS') {
                            garantirPrimeirasTentativasInscricao(existenteNoEvento.id, existenteNoEvento.modalidade_escolhida || 'Full Power');
                        }
                        return;
                    }
                }

                const cpfLimpo = sanitizarCPF(insc.cpf);
                const nomeAtleta = String(insc.nome || 'Atleta').trim();
                let idAtletaLocal = null;

                if (cpfLimpo) {
                    const existenteCpf = db.prepare('SELECT id, nome FROM atletas WHERE cpf = ? ORDER BY id DESC LIMIT 1').get(cpfLimpo);
                    if (existenteCpf && String(existenteCpf.nome || '').trim().toLowerCase() === nomeAtleta.toLowerCase()) {
                        idAtletaLocal = existenteCpf.id;
                    }
                }
                if (!idAtletaLocal) {
                    const existenteNome = db.prepare(`
                        SELECT id FROM atletas
                        WHERE LOWER(nome) = LOWER(?) AND data_nascimento = ? AND sexo = ?
                        LIMIT 1
                    `).get(nomeAtleta, String(insc.data_nascimento || ''), String(insc.sexo || 'M'));
                    if (existenteNome) idAtletaLocal = existenteNome.id;
                }

                if (idAtletaLocal) {
                    db.prepare(`
                        UPDATE atletas
                        SET nome = ?, cpf = COALESCE(?, cpf), data_nascimento = ?, sexo = ?, whatsapp = ?, cidade = ?, estado = ?, equipe = ?, pcd = ?,
                            instagram = COALESCE(?, instagram), youtube = COALESCE(?, youtube), outros_social = COALESCE(?, outros_social)
                        WHERE id = ?
                    `).run(
                        nomeAtleta,
                        cpfLimpo,
                        String(insc.data_nascimento || ''),
                        insc.sexo === 'F' ? 'F' : 'M',
                        String(insc.whatsapp || ''),
                        String(insc.cidade || ''),
                        String(insc.estado || 'SP'),
                        String(insc.equipe || 'Sem Equipe'),
                        insc.pcd ? 1 : 0,
                        insc.instagram || null,
                        insc.youtube || null,
                        insc.outros_social || null,
                        idAtletaLocal
                    );
                } else {
                    idAtletaLocal = db.prepare(`
                        INSERT INTO atletas (nome, cpf, data_nascimento, sexo, whatsapp, cidade, estado, equipe, pcd, instagram, youtube, outros_social)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(
                        nomeAtleta,
                        cpfLimpo,
                        String(insc.data_nascimento || ''),
                        insc.sexo === 'F' ? 'F' : 'M',
                        String(insc.whatsapp || ''),
                        String(insc.cidade || ''),
                        String(insc.estado || 'SP'),
                        String(insc.equipe || 'Sem Equipe'),
                        insc.pcd ? 1 : 0,
                        insc.instagram || null,
                        insc.youtube || null,
                        insc.outros_social || null
                    ).lastInsertRowid;
                }

                const zerarDadosDeCompeticao = (modoSeguro === 'APENAS_ATLETAS');
                const lote = insc.numero_lote || (Math.floor(Math.random() * 9000) + 1000);

                const novaInscId = db.prepare(`
                    INSERT INTO inscricoes (
                        evento_id, atleta_id, modalidade_escolhida, equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida,
                        bateria_agachamento, bateria_supino, bateria_terra,
                        plataforma_agachamento, plataforma_supino, plataforma_terra, remanejado_manual,
                        peso_corporal_oficial, numero_lote, rack_agachamento, rack_supino, trava_supino, versao,
                        anonimizar_historico, origem_inscricao, aceite_termos_em
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                `).run(
                    eventoLocalId,
                    idAtletaLocal,
                    insc.modalidade_escolhida || 'Full Power',
                    insc.equipamento_escolhido || 'Raw',
                    normalizarDivisoesParaBanco(insc.divisao_escolhida),
                    insc.categoria_peso_escolhida || 'Livre',
                    zerarDadosDeCompeticao ? null : (insc.bateria_agachamento || null),
                    zerarDadosDeCompeticao ? null : (insc.bateria_supino || null),
                    zerarDadosDeCompeticao ? null : (insc.bateria_terra || null),
                    zerarDadosDeCompeticao ? 1 : validarPlataforma(insc.plataforma_agachamento || 1),
                    zerarDadosDeCompeticao ? 1 : validarPlataforma(insc.plataforma_supino || 1),
                    zerarDadosDeCompeticao ? 1 : validarPlataforma(insc.plataforma_terra || 1),
                    zerarDadosDeCompeticao ? 0 : (insc.remanejado_manual ? 1 : 0),
                    zerarDadosDeCompeticao ? null : (insc.peso_corporal_oficial || null),
                    lote,
                    zerarDadosDeCompeticao ? null : (insc.rack_agachamento || null),
                    zerarDadosDeCompeticao ? null : (insc.rack_supino || null),
                    zerarDadosDeCompeticao ? null : (insc.trava_supino || null),
                    insc.anonimizar_historico ? 1 : 0,
                    insc.origem_inscricao || 'WEB',
                    insc.aceite_termos_em || null
                ).lastInsertRowid;

                mapaInscricaoAntigaParaNova[insc.id] = novaInscId;

                if (zerarDadosDeCompeticao) {
                    garantirPrimeirasTentativasInscricao(novaInscId, insc.modalidade_escolhida || 'Full Power');
                }
            });

            if (modoSeguro === 'APENAS_ATLETAS') {
                garantirPrimeirasTentativasEvento(eventoLocalId);
            } else {
                const stmtInsertTent = db.prepare(`
                    INSERT OR IGNORE INTO tentativas (
                        inscricao_id, movimento, numero_tentativa, peso_solicitado, estado,
                        luz_esquerda, luz_central, luz_direita, resultado_valido, sync_nuvem
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                `);

                tentativasOrig.forEach(t => {
                    const novaInscId = mapaInscricaoAntigaParaNova[t.inscricao_id];
                    if (!novaInscId) return;
                    const infoTent = stmtInsertTent.run(
                        novaInscId,
                        validarMovimento(t.movimento),
                        Number(t.numero_tentativa) || 1,
                        sanitizarPeso(t.peso_solicitado, false),
                        ['pendente', 'aguardando_pedida', 'concluido'].includes(t.estado) ? t.estado : 'pendente',
                        t.luz_esquerda !== undefined ? t.luz_esquerda : null,
                        t.luz_central !== undefined ? t.luz_central : null,
                        t.luz_direita !== undefined ? t.luz_direita : null,
                        t.resultado_valido !== undefined ? t.resultado_valido : null
                    );
                    if (t.id && infoTent.lastInsertRowid) {
                        mapaTentativaAntigaParaNova[t.id] = infoTent.lastInsertRowid;
                    }
                });

                garantirPrimeirasTentativasEvento(eventoLocalId);

                if (!usarModoMesclagemAditiva && modoSeguro === 'SUBSTITUIR' && pacote.estados_plataformas && typeof pacote.estados_plataformas === 'object') {
                    for (const platKey of Object.keys(pacote.estados_plataformas)) {
                        const p = validarPlataforma(platKey);
                        const estNuvem = pacote.estados_plataformas[platKey];
                        if (!estNuvem || typeof estNuvem !== 'object') continue;

                        const novoEstadoPlat = {
                            ...criarEstadoPadraoPlataforma(p),
                            ...estNuvem,
                            plataforma: p,
                            evento_id: eventoLocalId
                        };

                        if (novoEstadoPlat.atletaAtual) {
                            const idTentAntigo = novoEstadoPlat.atletaAtual.tentativa_id || novoEstadoPlat.atletaAtual.id;
                            const idInscAntigo = novoEstadoPlat.atletaAtual.inscricao_id;
                            novoEstadoPlat.atletaAtual.tentativa_id = mapaTentativaAntigaParaNova[idTentAntigo] || null;
                            novoEstadoPlat.atletaAtual.inscricao_id = mapaInscricaoAntigaParaNova[idInscAntigo] || null;
                        }

                        estadoPlataformas[p] = novoEstadoPlat;
                        salvarEstadoPlataforma(p, false);
                    }
                }
            }

            const totalFinalNoEvento = db.prepare('SELECT COUNT(1) as qtd FROM inscricoes WHERE evento_id = ?').get(eventoLocalId)?.qtd || 0;

            registrarLogSeguranca(null, 'importar_campeonato_nuvem', {
                modo: modoSeguro,
                mesclagem_aditiva: usarModoMesclagemAditiva,
                evento_local_id: eventoLocalId,
                qtd_atletas: totalFinalNoEvento
            });

            if (usarModoMesclagemAditiva) {
                marcarEventoParaSyncNuvem(eventoLocalId);
            }

            return { evento_local_id: eventoLocalId, qtd_atletas: totalFinalNoEvento };
        })();

        if ((modoSeguro === 'COPIA' || modoSeguro === 'APENAS_ATLETAS') && salvar_copia_na_nuvem) {
            const novoPacote = gerarPacoteEventoParaNuvem(resultadoImportacao.evento_local_id, orgId);
            if (novoPacote) {
                salvarPacoteNoRepositorioNuvem(novoPacote, { permitir_zerar_atletas: true });
                if (ctx.temCredencialRemota) {
                    try {
                        const resp = await fetchNuvemComTimeout(`${ctx.remoteUrl}/api/nuvem/receber_pacote`, {
                            method: 'POST',
                            headers: {
                                ...ctx.headersPadrao,
                                'Content-Type': 'application/json',
                                'X-Payload-SHA256': novoPacote.checksum_sha256
                            },
                            body: JSON.stringify({
                                ...novoPacote,
                                permitir_zerar_atletas: true
                            })
                        }, 8000);
                        if (resp.ok) {
                            db.prepare(`
                                UPDATE eventos
                                SET sync_nuvem = 1, ultimo_sync_em = CURRENT_TIMESTAMP
                                WHERE id = ? AND versao_sync = ?
                            `).run(resultadoImportacao.evento_local_id, novoPacote.versao_sync);
                        }
                    } catch (ePush) {
                        console.warn("⚠️ [NUVEM] Cópia salva localmente; envio remoto ficará para o sync automático:", ePush.message);
                    }
                }
            }
        }

        sincronizarTodasPlataformasComBanco();
        for (let p = 1; p <= 5; p++) {
            emitirEstadoPlataforma(p, false);
        }
        io.emit('dados_atletas_atualizados', { evento_id: resultadoImportacao.evento_local_id, acao: 'importado_nuvem' });
        io.emit('fila_atualizada', { evento_id: resultadoImportacao.evento_local_id });

        res.json({
            sucesso: true,
            modo: modoSeguro,
            evento_id: resultadoImportacao.evento_local_id,
            qtd_atletas: resultadoImportacao.qtd_atletas
        });
    } catch (erro) {
        console.error("Erro ao importar campeonato da nuvem:", erro);
        res.status(500).json({ erro: erro.message });
    }
});

// ============================================================================
// 📥 ROTAS ISOLADAS DE APOIO À IMPORTAÇÃO DE ATLETAS (CSV / JSON / XLSX)
// ============================================================================

function decodificarEntidadesXml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function colunaExcelParaIndice(letras) {
    let idx = 0;
    const limpo = String(letras || '').toUpperCase();
    for (let i = 0; i < limpo.length; i++) {
        idx = idx * 26 + (limpo.charCodeAt(i) - 64);
    }
    return Math.max(0, idx - 1);
}

// Leitor nativo de arquivos .XLSX usando apenas o módulo 'zlib' nativo do Node.js (Zero dependências externas)
function extrairLinhasDeBufferXlsx(bufferZip) {
    let eocdOffset = -1;
    for (let i = bufferZip.length - 22; i >= Math.max(0, bufferZip.length - 65557); i--) {
        if (bufferZip.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) {
        throw new Error('O arquivo enviado não é um arquivo Excel (.xlsx) válido.');
    }

    const totalEntries = bufferZip.readUInt16LE(eocdOffset + 10);
    const cdOffset = bufferZip.readUInt32LE(eocdOffset + 16);
    const arquivosXml = {};

    let ptr = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (ptr + 46 > bufferZip.length || bufferZip.readUInt32LE(ptr) !== 0x02014b50) break;
        const metodo = bufferZip.readUInt16LE(ptr + 10);
        const tamComprimido = bufferZip.readUInt32LE(ptr + 20);
        const tamNome = bufferZip.readUInt16LE(ptr + 28);
        const tamExtra = bufferZip.readUInt16LE(ptr + 30);
        const tamComentario = bufferZip.readUInt16LE(ptr + 32);
        const offsetLocal = bufferZip.readUInt32LE(ptr + 42);
        const nomeArquivo = bufferZip.slice(ptr + 46, ptr + 46 + tamNome).toString('utf8');

        if (nomeArquivo === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(nomeArquivo)) {
            if (offsetLocal + 30 <= bufferZip.length && bufferZip.readUInt32LE(offsetLocal) === 0x04034b50) {
                const localNomeLen = bufferZip.readUInt16LE(offsetLocal + 26);
                const localExtraLen = bufferZip.readUInt16LE(offsetLocal + 28);
                const inicioDados = offsetLocal + 30 + localNomeLen + localExtraLen;
                const fatia = bufferZip.slice(inicioDados, inicioDados + tamComprimido);
                if (metodo === 0) {
                    arquivosXml[nomeArquivo] = fatia.toString('utf8');
                } else if (metodo === 8) {
                    arquivosXml[nomeArquivo] = zlib.inflateRawSync(fatia).toString('utf8');
                }
            }
        }
        ptr += 46 + tamNome + tamExtra + tamComentario;
    }

    const chavePlanilha = arquivosXml['xl/worksheets/sheet1.xml']
        ? 'xl/worksheets/sheet1.xml'
        : Object.keys(arquivosXml).find(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));

    if (!chavePlanilha) {
        throw new Error('Nenhuma aba de planilha encontrada dentro do arquivo .xlsx.');
    }

    const sharedStrings = [];
    const xmlShared = arquivosXml['xl/sharedStrings.xml'] || '';
    if (xmlShared) {
        const regexSi = /<si[\s>]([\s\S]*?)<\/si>/g;
        let matchSi;
        while ((matchSi = regexSi.exec(xmlShared)) !== null) {
            const blocoSi = matchSi[1];
            const regexT = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
            let matchT;
            let textoConcatenado = '';
            while ((matchT = regexT.exec(blocoSi)) !== null) {
                textoConcatenado += decodificarEntidadesXml(matchT[1]);
            }
            sharedStrings.push(textoConcatenado);
        }
    }

    const xmlSheet = arquivosXml[chavePlanilha];
    const matrizLinhas = [];
    const regexRow = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let matchRow;

    while ((matchRow = regexRow.exec(xmlSheet)) !== null) {
        const blocoRow = matchRow[1];
        const linhaAtual = [];
        const regexCell = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let matchCell;
        let proximoIndiceCol = 0;

        while ((matchCell = regexCell.exec(blocoRow)) !== null) {
            const atributos = matchCell[1] || '';
            const interior = matchCell[2] || '';

            const matchRef = atributos.match(/\br="([A-Z]+)\d+"/i);
            const colIdx = matchRef ? colunaExcelParaIndice(matchRef[1]) : proximoIndiceCol;
            proximoIndiceCol = colIdx + 1;

            const matchTipo = atributos.match(/\bt="([^"]+)"/);
            const tipo = matchTipo ? matchTipo[1] : '';

            let valorCelula = '';
            if (tipo === 'inlineStr' || tipo === 'str') {
                const regexT = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
                let mT;
                while ((mT = regexT.exec(interior)) !== null) {
                    valorCelula += decodificarEntidadesXml(mT[1]);
                }
            } else {
                const matchV = interior.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
                if (matchV) {
                    const brutoV = decodificarEntidadesXml(matchV[1]).trim();
                    if (tipo === 's') {
                        const idxStr = parseInt(brutoV, 10);
                        valorCelula = sharedStrings[idxStr] !== undefined ? sharedStrings[idxStr] : '';
                    } else if (tipo === 'b') {
                        valorCelula = brutoV === '1' ? 'SIM' : 'NAO';
                    } else {
                        valorCelula = brutoV;
                    }
                }
            }

            while (linhaAtual.length < colIdx) {
                linhaAtual.push('');
            }
            linhaAtual[colIdx] = String(valorCelula ?? '').trim();
        }

        if (linhaAtual.some(v => v !== '')) {
            matrizLinhas.push(linhaAtual);
        }
    }

    if (matrizLinhas.length < 2) {
        return [];
    }

    const cabecalhos = matrizLinhas[0].map(h =>
        String(h || '').trim().toLowerCase().replace(/^\uFEFF/, '')
    );

    const objetos = [];
    for (let r = 1; r < matrizLinhas.length; r++) {
        const valores = matrizLinhas[r];
        if (!valores.some(v => String(v || '').trim() !== '')) continue;
        const obj = { __linha_arquivo: r + 1 };
        cabecalhos.forEach((nomeCol, idx) => {
            if (!nomeCol) return;
            let val = valores[idx] !== undefined ? String(valores[idx]).trim() : '';
            // Converte serial de data do Excel (ex: 34926 -> 15/08/1995) caso esteja na coluna data_nascimento
            if (nomeCol === 'data_nascimento' && /^\d{5}$/.test(val)) {
                const serial = parseInt(val, 10);
                if (serial > 10000 && serial < 60000) {
                    const dt = new Date(Math.round((serial - 25569) * 86400 * 1000));
                    const dia = String(dt.getUTCDate()).padStart(2, '0');
                    const mes = String(dt.getUTCMonth() + 1).padStart(2, '0');
                    const ano = dt.getUTCFullYear();
                    val = `${dia}/${mes}/${ano}`;
                }
            }
            obj[nomeCol] = val;
        });
        objetos.push(obj);
    }

    return objetos;
}

app.post('/api/importar-atletas/ler-xlsx', exigirMaquinaLocalAPI, (req, res) => {
    try {
        const base64 = String(req.body?.arquivo_base64 || '').replace(/^data:.*?;base64,/, '');
        if (!base64) {
            return res.status(400).json({ erro: 'Arquivo .xlsx vazio ou não enviado.' });
        }
        const buffer = Buffer.from(base64, 'base64');
        const registros = extrairLinhasDeBufferXlsx(buffer);
        res.json({ sucesso: true, registros });
    } catch (erro) {
        res.status(400).json({ erro: 'Falha ao ler arquivo Excel (.xlsx): ' + erro.message });
    }
});

// Pre-check: Cria snapshot de segurança, busca atletas locais + atletas na nuvem (se conectada) e valida SHA-256 inicial
app.post('/api/importar-atletas/pre-check/:evento_id', exigirMaquinaLocalAPI, async (req, res) => {
    try {
        const eventoId = Number(req.params.evento_id);
        const evento = db.prepare("SELECT * FROM eventos WHERE id = ? AND nome != 'Cadastros Cancelados'").get(eventoId);
        if (!evento) {
            return res.status(404).json({ erro: 'Campeonato local não encontrado.' });
        }

        await criarSnapshotSeguranca('antes_importar_atletas');

        const inscritosLocais = db.prepare(`
            SELECT 
                i.*, 
                a.nome, a.cpf, a.data_nascimento, a.sexo, a.whatsapp, a.cidade, a.estado, a.equipe, a.pcd,
                a.instagram, a.youtube, a.outros_social
            FROM inscricoes i
            JOIN atletas a ON i.atleta_id = a.id
            WHERE i.evento_id = ?
        `).all(eventoId);

        const ctx = obterContextoRemotoNuvem();
        let nuvemConectada = false;
        let inscritosNuvem = [];

        if (ctx.temCredencialRemota && Number(evento.sync_nuvem) !== -1) {
            try {
                let nuvemIdAlvo = evento.nuvem_evento_id;
                let pacoteRemoto = null;

                if (nuvemIdAlvo) {
                    const resp = await fetchNuvemComTimeout(
                        `${ctx.remoteUrl}/api/nuvem/pacote/${encodeURIComponent(nuvemIdAlvo)}?apenas_local=1`,
                        { headers: ctx.headersPadrao },
                        4500
                    );
                    if (resp.ok) {
                        pacoteRemoto = await resp.json();
                        nuvemConectada = true;
                    }
                }

                if (!pacoteRemoto) {
                    const respLista = await fetchNuvemComTimeout(
                        `${ctx.remoteUrl}/api/nuvem/campeonatos?organizador_id=${encodeURIComponent(ctx.orgId)}&apenas_local=1`,
                        { headers: ctx.headersPadrao },
                        4500
                    );
                    if (respLista.ok) {
                        nuvemConectada = true;
                        const listaRemota = await respLista.json();
                        if (Array.isArray(listaRemota)) {
                            const matchNome = listaRemota.find(
                                c => String(c.nome_evento || '').trim().toLowerCase() === String(evento.nome || '').trim().toLowerCase()
                            );
                            if (matchNome && matchNome.nuvem_id) {
                                const respPacoteNome = await fetchNuvemComTimeout(
                                    `${ctx.remoteUrl}/api/nuvem/pacote/${encodeURIComponent(matchNome.nuvem_id)}?apenas_local=1`,
                                    { headers: ctx.headersPadrao },
                                    4500
                                );
                                if (respPacoteNome.ok) {
                                    pacoteRemoto = await respPacoteNome.json();
                                }
                            }
                        }
                    }
                }

                if (pacoteRemoto && Array.isArray(pacoteRemoto.inscricoes)) {
                    inscritosNuvem = pacoteRemoto.inscricoes;
                }
            } catch (eNuvem) {
                nuvemConectada = false;
            }
        }

        // Verifica se a geração de pacote e SHA-256 está íntegra antes de começar
        const pacoteInicial = gerarPacoteEventoParaNuvem(eventoId);
        const validacaoSha = validarESanitizarPacoteNuvem(pacoteInicial);
        if (!validacaoSha.valido) {
            return res.status(422).json({
                erro: 'Falha na verificação inicial de integridade SHA-256: ' + validacaoSha.erro
            });
        }

        res.json({
            sucesso: true,
            nuvem_conectada: nuvemConectada,
            checksum_sha256: validacaoSha.checksum_sha256,
            inscritos_locais: inscritosLocais,
            inscritos_nuvem: inscritosNuvem
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

// Verifica e grava o novo SHA-256 após cada atleta cadastrado (e desfaz a inscrição se houver qualquer falha de SHA-256)
app.post('/api/importar-atletas/verificar-sha256/:evento_id', exigirMaquinaLocalAPI, (req, res) => {
    const eventoId = Number(req.params.evento_id);
    const ultimoInscricaoId = req.body?.ultimo_inscricao_id ? Number(req.body.ultimo_inscricao_id) : null;

    try {
        const ctx = obterContextoRemotoNuvem();
        const orgOverride = (ctx.orgId && ctx.orgId !== 'LOCAL') ? ctx.orgId : null;
        const pacote = gerarPacoteEventoParaNuvem(eventoId, orgOverride);

        if (!pacote) {
            throw new Error('Não foi possível gerar o pacote do campeonato para cálculo do SHA-256.');
        }

        const validacao = validarESanitizarPacoteNuvem(pacote);
        if (!validacao.valido) {
            throw new Error(validacao.erro || 'Hash SHA-256 inválido.');
        }

        salvarPacoteNoRepositorioNuvem(pacote, { permitir_zerar_atletas: true });

        res.json({
            sucesso: true,
            checksum_sha256: validacao.checksum_sha256,
            versao_sync: pacote.versao_sync,
            qtd_atletas: Array.isArray(pacote.inscricoes) ? pacote.inscricoes.length : 0
        });
    } catch (erro) {
        // Se ocorrer qualquer problema na geração do SHA-256, reverte a última inscrição para proteger o banco
        if (ultimoInscricaoId) {
            try {
                db.transaction(() => {
                    db.prepare('DELETE FROM tentativas WHERE inscricao_id = ?').run(ultimoInscricaoId);
                    db.prepare('DELETE FROM inscricoes WHERE id = ?').run(ultimoInscricaoId);
                })();
            } catch (eRollback) {}
        }
        res.status(422).json({
            sucesso: false,
            erro: 'Falha crítica ao gerar/validar integridade SHA-256: ' + erro.message
        });
    }
});

// ============================================================================
// MOTOR DE TEMPO REAL (SOCKET.IO) - SUPORTE A 5 PLATAFORMAS INDEPENDENTES
// ============================================================================

io.on('connection', (socket) => {
    socket.emit('sincronizar_todas_plataformas', estadoPlataformas);
    for (let p = 1; p <= 5; p++) {
        if (p === 1 || estadoPlataformas[p]?.evento_id) {
            socket.emit('estado_atualizado', estadoPlataformas[p]);
            socket.emit('sincronizar_estado', estadoPlataformas[p]);
        }
    }

    socket.on('solicitar_estado_plataforma', (plat) => {
        const p = validarPlataforma(plat || 1);
        socket.emit('sincronizar_estado', estadoPlataformas[p]);
        socket.emit('sincronizar_todas_plataformas', estadoPlataformas);
    });

    socket.on('admin_selecionou_bateria', (dados) => {
        try {
            if (!validarTokenSessaoArbitro(dados?.token_acesso)) {
                socket.emit('mesa_nao_autorizada');
                return;
            }
            const p = validarPlataforma(dados?.plataforma || 1);
            const estAtual = estadoPlataformas[p];
            const eventoIdAnterior = estAtual.evento_id;
            const novoEvId = dados?.evento_id ? Number(dados.evento_id) || dados.evento_id : null;
            const novoMov = dados?.movimento ? validarMovimento(dados.movimento) : null;
            const novaBat = dados?.bateria !== undefined && dados?.bateria !== null && String(dados.bateria).trim() !== ''
                ? String(dados.bateria).trim()
                : null;

            // Proteção contra 2ª aba aberta na mesma plataforma: se já há um atleta ativo na plataforma
            // e o contexto enviado (evento/movimento/bateria) é o mesmo, não limpa o atleta em andamento
            if (
                estAtual.atletaAtual &&
                String(estAtual.evento_id || '') === String(novoEvId || '') &&
                String(estAtual.movimento || '') === String(novoMov || '') &&
                String(estAtual.bateria || '') === String(novaBat || '')
            ) {
                emitirEstadoPlataforma(p, false);
                return;
            }

            estAtual.evento_id = novoEvId;
            estAtual.movimento = novoMov;
            estAtual.bateria = novaBat;
            estAtual.atletaAtual = null;
            estAtual.luzes = { esquerda: null, central: null, direita: null };
            estAtual.resultado = null;
            estAtual.preVotoManualMesa = false;

            emitirEstadoPlataforma(p);

            // Se o mesário limpou o dropdown de campeonato, garante que o evento anterior também suba para a nuvem
            if (eventoIdAnterior && String(eventoIdAnterior) !== String(novoEvId || '')) {
                marcarEventoParaSyncNuvem(eventoIdAnterior);
            }
        } catch (e) {
            console.error("Erro em admin_selecionou_bateria:", e.message);
        }
    });

    socket.on('proximo_atleta', (dados) => {
        try {
            if (!validarTokenSessaoArbitro(dados?.token_acesso)) {
                socket.emit('mesa_nao_autorizada');
                return;
            }
            const p = validarPlataforma(dados?.plataforma || 1);
            const idTentativa = dados?.tentativa_id || dados?.id;

            let dadosFinaisAtleta = dados ? { ...dados, plataforma: p } : null;

            // Consulta autoritativa no SQLite pelo tentativa_id para garantir carga, categoria, idade e alturas de rack 100% atualizadas
            if (idTentativa) {
                const regBanco = db.prepare(`
                    SELECT 
                        t.id as tentativa_id, t.numero_tentativa, t.peso_solicitado, t.movimento,
                        i.id as inscricao_id, i.evento_id, i.rack_agachamento, i.rack_supino, i.trava_supino,
                        i.categoria_peso_escolhida, i.divisao_escolhida, i.equipamento_escolhido,
                        i.bateria_agachamento, i.bateria_supino, i.bateria_terra,
                        a.nome, a.sexo, a.equipe
                    FROM tentativas t
                    JOIN inscricoes i ON t.inscricao_id = i.id
                    JOIN atletas a ON i.atleta_id = a.id
                    WHERE t.id = ?
                `).get(idTentativa);

                if (regBanco) {
                    const batBanco = regBanco[`bateria_${regBanco.movimento}`];
                    estadoPlataformas[p].evento_id = regBanco.evento_id;
                    estadoPlataformas[p].movimento = regBanco.movimento;
                    if (batBanco) estadoPlataformas[p].bateria = batBanco;

                    dadosFinaisAtleta = {
                        plataforma: p,
                        evento_id: regBanco.evento_id,
                        movimento: regBanco.movimento,
                        bateria: batBanco || dados?.bateria || estadoPlataformas[p].bateria,
                        tentativa_id: regBanco.tentativa_id,
                        inscricao_id: regBanco.inscricao_id,
                        nome: regBanco.nome,
                        sexo: regBanco.sexo,
                        equipe: regBanco.equipe,
                        categoria_peso_escolhida: regBanco.categoria_peso_escolhida,
                        divisao_escolhida: regBanco.divisao_escolhida,
                        equipamento_escolhido: regBanco.equipamento_escolhido,
                        pesoNaBarra: regBanco.peso_solicitado,
                        tentativa: regBanco.numero_tentativa,
                        rack_agachamento: regBanco.rack_agachamento,
                        rack_supino: regBanco.rack_supino,
                        trava_supino: regBanco.trava_supino
                    };
                }
            }

            if (dados?.evento_id && !estadoPlataformas[p].evento_id) {
                estadoPlataformas[p].evento_id = Number(dados.evento_id) || dados.evento_id;
            }
            if (dados?.movimento && !estadoPlataformas[p].movimento) {
                estadoPlataformas[p].movimento = validarMovimento(dados.movimento);
            }
            if (dados?.bateria !== undefined && dados?.bateria !== null && String(dados.bateria).trim() !== '') {
                estadoPlataformas[p].bateria = String(dados.bateria).trim();
            }

            estadoPlataformas[p].atletaAtual = dadosFinaisAtleta;
            estadoPlataformas[p].luzes = { esquerda: null, central: null, direita: null };
            estadoPlataformas[p].resultado = null;
            estadoPlataformas[p].preVotoManualMesa = false;

            emitirEstadoPlataforma(p);
        } catch (e) {
            console.error("Erro em proximo_atleta:", e.message);
        }
    });

    socket.on('destravar_plataforma', (dados, callback) => {
        try {
            if (!validarTokenSessaoArbitro(dados?.token_acesso)) {
                socket.emit('mesa_nao_autorizada');
                if (typeof callback === 'function') callback({ sucesso: false, nao_autorizado: true, erro: "🔒 Sessão não autorizada. Informe a senha." });
                return;
            }
            const p = validarPlataforma(dados?.plataforma || 1);
            estadoPlataformas[p].atletaAtual = null;
            estadoPlataformas[p].luzes = { esquerda: null, central: null, direita: null };
            estadoPlataformas[p].resultado = null;
            estadoPlataformas[p].preVotoManualMesa = false;

            emitirEstadoPlataforma(p);
            if (typeof callback === 'function') callback({ sucesso: true });
        } catch (e) {
            console.error("Erro em destravar_plataforma:", e.message);
            if (typeof callback === 'function') callback({ sucesso: false, erro: e.message });
        }
    });

    socket.on('limpar_plataforma', (dados) => {
        try {
            if (!validarTokenSessaoArbitro(dados?.token_acesso)) {
                socket.emit('mesa_nao_autorizada');
                return;
            }
            const p = validarPlataforma(dados?.plataforma || 1);
            estadoPlataformas[p].atletaAtual = null;
            estadoPlataformas[p].luzes = { esquerda: null, central: null, direita: null };
            estadoPlataformas[p].resultado = null;
            estadoPlataformas[p].preVotoManualMesa = false;

            emitirEstadoPlataforma(p);
        } catch (e) {
            console.error("Erro em limpar_plataforma:", e.message);
        }
    });

    socket.on('configurar_modo_arbitro', (dados) => {
        try {
            const isObj = typeof dados === 'object' && dados !== null;
            if (!validarTokenSessaoArbitro(isObj ? dados.token_acesso : '')) {
                socket.emit('mesa_nao_autorizada');
                return;
            }
            const p = validarPlataforma(isObj ? dados.plataforma : 1);
            const modo = isObj ? dados.modo : dados;
            estadoPlataformas[p].modo_arbitro = Number(modo) === 1 ? 1 : 3;

            emitirEstadoPlataforma(p);
        } catch (e) {
            console.error("Erro em configurar_modo_arbitro:", e.message);
        }
    });

    socket.on('mesa_pre_voto_manual', (dados) => {
        try {
            if (!validarTokenSessaoArbitro(dados?.token_acesso)) {
                socket.emit('mesa_nao_autorizada');
                return;
            }
            const p = validarPlataforma(dados?.plataforma || 1);
            const estadoPlat = estadoPlataformas[p];
            if (!estadoPlat.atletaAtual) return;

            const votoBruto = dados?.voto;
            const votoNum = Number(votoBruto);
            if (votoBruto === null || votoBruto === undefined || votoBruto === '' || (votoNum !== 0 && votoNum !== 1)) {
                return;
            }

            const idAtivo = estadoPlat.atletaAtual.tentativa_id || estadoPlat.atletaAtual.id;
            if (dados.tentativa_id && idAtivo && Number(dados.tentativa_id) !== Number(idAtivo)) {
                return;
            }

            if (estadoPlat.resultado !== null) {
                return;
            }

            estadoPlat.preVotoManualMesa = true;

            if (['esquerda', 'central', 'direita'].includes(dados.posicao)) {
                estadoPlat.luzes[dados.posicao] = votoNum;
            }
            if (Number(estadoPlat.modo_arbitro) === 1 && dados.posicao === 'central') {
                estadoPlat.luzes.esquerda = votoNum;
                estadoPlat.luzes.direita = votoNum;
            }
            emitirEstadoPlataforma(p);
        } catch (e) {
            console.error("Erro em mesa_pre_voto_manual:", e.message);
        }
    });

    function processarLuzesESalvar(plataforma, isRetificacao = false) {
        const p = validarPlataforma(plataforma);
        const estadoPlat = estadoPlataformas[p];

        if (!estadoPlat.atletaAtual) {
            console.error(`[PLATAFORMA ${p}] Tentativa de salvar ignorada: Nenhum atleta na plataforma.`);
            return false;
        }

        const tentativaId = estadoPlat.atletaAtual.tentativa_id || estadoPlat.atletaAtual.id;
        if (!tentativaId) {
            console.error(`[PLATAFORMA ${p}] ID da tentativa não encontrado.`);
            return false;
        }

        const luzes = estadoPlat.luzes;
        if (luzes.esquerda === null || luzes.central === null || luzes.direita === null) {
            console.error(`[PLATAFORMA ${p}] Luzes incompletas ao tentar salvar.`);
            return false;
        }

        const totalBrancas = Object.values(luzes).filter(l => Number(l) === 1).length;
        const isValido = totalBrancas >= 2 ? 1 : 0;

        try {
            const gravarNoBanco = db.transaction(() => {
                const tentExistente = db.prepare('SELECT id, inscricao_id, movimento, numero_tentativa FROM tentativas WHERE id = ?').get(tentativaId);
                if (!tentExistente) {
                    throw new Error(`Tentativa #${tentativaId} não encontrada no banco de dados.`);
                }

                const resultadoUpdate = db.prepare(`
                    UPDATE tentativas 
                    SET luz_esquerda = ?, luz_central = ?, luz_direita = ?, resultado_valido = ?, estado = 'concluido', sync_nuvem = 0 
                    WHERE id = ?
                `).run(luzes.esquerda, luzes.central, luzes.direita, isValido, tentativaId);

                if (resultadoUpdate.changes === 0) {
                    throw new Error(`Nenhuma linha atualizada para a tentativa #${tentativaId}.`);
                }

                // Garante que a próxima tentativa regulamentar (2ª ou 3ª) exista sempre que a anterior for concluída
                if (tentExistente.numero_tentativa < 3) {
                    const proxTentativa = tentExistente.numero_tentativa + 1;
                    const existeProx = db.prepare('SELECT id FROM tentativas WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = ?')
                        .get(tentExistente.inscricao_id, tentExistente.movimento, proxTentativa);

                    if (!existeProx) {
                        db.prepare(`
                            INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado) 
                            VALUES (?, ?, ?, 0, 'aguardando_pedida')
                        `).run(tentExistente.inscricao_id, tentExistente.movimento, proxTentativa);
                    }
                }

                // Auto-cura extra: se a 1ª e a 2ª tentativas já estão concluídas e a 3ª tentativa não existe, garante a criação da 3ª
                const concluidas1e2 = db.prepare(`
                    SELECT COUNT(1) as qtd FROM tentativas
                    WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa IN (1, 2) AND estado = 'concluido'
                `).get(tentExistente.inscricao_id, tentExistente.movimento)?.qtd || 0;

                if (concluidas1e2 === 2) {
                    const existeTerceira = db.prepare(`
                        SELECT id FROM tentativas
                        WHERE inscricao_id = ? AND movimento = ? AND numero_tentativa = 3
                    `).get(tentExistente.inscricao_id, tentExistente.movimento);

                    if (!existeTerceira) {
                        db.prepare(`
                            INSERT OR IGNORE INTO tentativas (inscricao_id, movimento, numero_tentativa, peso_solicitado, estado) 
                            VALUES (?, ?, 3, 0, 'aguardando_pedida')
                        `).run(tentExistente.inscricao_id, tentExistente.movimento);
                    }
                }

                marcarEventoPorTentativaParaSync(tentativaId);
            });

            gravarNoBanco();

            // Só atualiza o estado da plataforma e o Telão após confirmação de gravação no SQLite
            estadoPlat.resultado = isValido ? 'valido' : 'invalido';

            io.emit('resultado_luzes', {
                plataforma: p,
                luzes: estadoPlat.luzes,
                resultado: isValido ? 'MOVIMENTO VÁLIDO' : 'MOVIMENTO INVÁLIDO'
            });
            emitirEstadoPlataforma(p, false);
            io.emit('fila_atualizada', { plataforma: p, evento_id: estadoPlat.evento_id });
            return true;
        } catch (error) {
            console.error(`[PLATAFORMA ${p}] ERRO CRÍTICO AO SALVAR DADOS DA LUZ:`, error.message);
            return false;
        }
    }

    socket.on('arbitro_votou', (dados) => {
        try {
            if (!validarTokenSessaoArbitro(dados?.token_arbitro)) {
                socket.emit('arbitro_nao_autorizado');
                return;
            }
            const p = validarPlataforma(dados?.plataforma || 1);
            const estadoPlat = estadoPlataformas[p];

            const votoBruto = dados?.voto;
            const votoNum = Number(votoBruto);
            if (votoBruto === null || votoBruto === undefined || votoBruto === '' || (votoNum !== 0 && votoNum !== 1)) {
                return;
            }

            if (estadoPlat.atletaAtual && estadoPlat.resultado === null) {
                const idAtivo = estadoPlat.atletaAtual.tentativa_id || estadoPlat.atletaAtual.id;
                if (dados.tentativa_id && idAtivo && Number(dados.tentativa_id) !== Number(idAtivo)) {
                    console.warn(`[PLATAFORMA ${p}] Voto atrasado de telemóvel ignorado (Tentativa ${dados.tentativa_id} != Ativa ${idAtivo}).`);
                    return;
                }

                if (['esquerda', 'central', 'direita'].includes(dados.posicao)) {
                    estadoPlat.luzes[dados.posicao] = votoNum;
                }

                if (Number(estadoPlat.modo_arbitro) === 1 && dados.posicao === 'central') {
                    estadoPlat.luzes.esquerda = votoNum;
                    estadoPlat.luzes.direita = votoNum;
                }

                emitirEstadoPlataforma(p);

                if (!estadoPlat.preVotoManualMesa &&
                    estadoPlat.luzes.esquerda !== null &&
                    estadoPlat.luzes.central !== null &&
                    estadoPlat.luzes.direita !== null) {
                    processarLuzesESalvar(p, false);
                }
            }
        } catch (e) {
            console.error("Erro em arbitro_votou:", e.message);
        }
    });

    socket.on('registrar_luzes', (dadosLuzes, callback) => {
        try {
            if (!validarTokenSessaoArbitro(dadosLuzes?.token_acesso)) {
                socket.emit('mesa_nao_autorizada');
                if (typeof callback === 'function') callback({ sucesso: false, nao_autorizado: true, erro: "🔒 Sessão não autorizada. Informe a senha." });
                return;
            }
            const p = validarPlataforma(dadosLuzes?.plataforma || 1);
            const estadoPlat = estadoPlataformas[p];
            if (!estadoPlat.atletaAtual) {
                if (typeof callback === 'function') callback({ sucesso: false, erro: "Nenhum atleta na plataforma." });
                return;
            }

            const idAtivo = estadoPlat.atletaAtual.tentativa_id || estadoPlat.atletaAtual.id;
            if (dadosLuzes.tentativa_id && idAtivo && Number(dadosLuzes.tentativa_id) !== Number(idAtivo)) {
                if (typeof callback === 'function') callback({ sucesso: false, erro: "O atleta na plataforma já foi alterado." });
                return;
            }

            const isRetificacao = estadoPlat.resultado !== null;

            estadoPlat.luzes = {
                esquerda: Number(dadosLuzes.esquerda) === 1 ? 1 : 0,
                central: Number(dadosLuzes.central) === 1 ? 1 : 0,
                direita: Number(dadosLuzes.direita) === 1 ? 1 : 0
            };

            const ok = processarLuzesESalvar(p, isRetificacao);
            if (typeof callback === 'function') {
                callback(ok
                    ? { sucesso: true }
                    : { sucesso: false, erro: "Não foi possível gravar a decisão no banco de dados. A tentativa pode ter sido alterada." }
                );
            }
        } catch (e) {
            console.error("Erro em registrar_luzes:", e.message);
            if (typeof callback === 'function') callback({ sucesso: false, erro: e.message });
        }
    });
});

// ============================================================================
// ☁️ MOTOR DE SINCRONIZAÇÃO IMEDIATA (EVENT-DRIVEN) + VARREDURA DE 30s
// (100% ISOLADO DA MESA: NUNCA BLOQUEIA O EVENT LOOP NEM ATRASA O SOCKET.IO)
// ============================================================================

let syncEmAndamento = false;
let syncPendenteAposAtual = false;
let timerPushImediato = null;
const ultimoPullMesclagemPorEvento = {};

function agendarPushImediatoNuvem(delayMs = 250) {
    if (timerPushImediato) clearTimeout(timerPushImediato);
    timerPushImediato = setTimeout(() => {
        timerPushImediato = null;
        executarCicloSincronizacaoNuvem(false);
    }, delayMs);
}

async function executarCicloSincronizacaoNuvem(executarBackupDisco = false) {
    if (syncEmAndamento) {
        // Se já há um envio em curso, marca para rodar novamente assim que o atual terminar
        syncPendenteAposAtual = true;
        return;
    }
    syncEmAndamento = true;

    try {
        if (executarBackupDisco) {
            await realizarBackupAutomatico();
            executarBackupExternoSeguro('automatico').catch(() => {});
        }

        // Seleciona apenas campeonatos que NÃO estejam com sync_nuvem = -1 (sincronização cancelada pelo organizador)
        const eventosPendentes = db.prepare(`
            SELECT DISTINCT e.id as evento_id
            FROM eventos e
            LEFT JOIN inscricoes i ON i.evento_id = e.id
            LEFT JOIN tentativas t ON t.inscricao_id = i.id AND t.sync_nuvem = 0
            WHERE e.nome != 'Cadastros Cancelados'
              AND COALESCE(e.sync_nuvem, 0) != -1
              AND (COALESCE(e.sync_nuvem, 0) = 0 OR t.id IS NOT NULL)
        `).all();

        if (eventosPendentes.length === 0) return;

        const ctx = obterContextoRemotoNuvem();
        const orgOverride = (ctx.orgId && ctx.orgId !== 'LOCAL') ? ctx.orgId : null;

        for (const ev of eventosPendentes) {
            const eventoId = ev.evento_id;

            // Antes de enviar para a nuvem remota, verifica e mescla eventuais atletas inscritos pela Web no mesmo campeonato
            // (Limitado a 1 verificação a cada 30s durante competição ao vivo para não atrasar os cliques da Mesa/Árbitros)
            if (ctx.temCredencialRemota) {
                const agoraMs = Date.now();
                const ultimoPull = ultimoPullMesclagemPorEvento[eventoId] || 0;
                const evInfo = db.prepare('SELECT ultimo_sync_em FROM eventos WHERE id = ?').get(eventoId);

                if (!evInfo?.ultimo_sync_em || executarBackupDisco || (agoraMs - ultimoPull) > 30000) {
                    ultimoPullMesclagemPorEvento[eventoId] = agoraMs;
                    await sincronizarEMesclarComNuvemAntesDoPush(eventoId, ctx);
                }
            }

            const pacote = gerarPacoteEventoParaNuvem(eventoId, orgOverride);
            if (!pacote) continue;

            // 1. Atualiza sempre o Cofre Local de Nuvem (e Histórico de 20 Snapshots)
            salvarPacoteNoRepositorioNuvem(pacote, { permitir_zerar_atletas: true });

            // 2. Se o organizador configurou credencial de nuvem, faz o Auto-Push com Circuit Breaker
            let uploadRemotoOk = true;
            if (ctx.temCredencialRemota) {
                uploadRemotoOk = false;
                try {
                    const resp = await fetchNuvemComTimeout(`${ctx.remoteUrl}/api/nuvem/receber_pacote`, {
                        method: 'POST',
                        headers: {
                            ...ctx.headersPadrao,
                            'Content-Type': 'application/json',
                            'X-Payload-SHA256': pacote.checksum_sha256
                        },
                        body: JSON.stringify(pacote)
                    }, 5000);

                    if (resp.ok) {
                        uploadRemotoOk = true;
                        // Invalida o cache de quota para refletir imediatamente a nova contagem sincronizada
                        cacheQuotaLicencaNuvem.atualizado_em = 0;
                    } else if (resp.status === 403) {
                        // Se atingiu o limite da licença na nuvem, desliga o auto-sync deste evento (-1) para não entrar em loop
                        console.warn(`🛑 [CLOUD AUTO-PUSH] Limite da licença na nuvem atingido para o evento #${eventoId} (HTTP 403). Sincronização encerrada para este evento.`);
                        db.prepare('UPDATE eventos SET sync_nuvem = -1 WHERE id = ?').run(eventoId);
                        continue;
                    } else {
                        console.warn(`⚠️ [CLOUD AUTO-PUSH] Servidor remoto recusou pacote do evento #${eventoId} (HTTP ${resp.status}). Retentará automaticamente.`);
                    }
                } catch (errRede) {
                    console.warn(`⚠️ [CLOUD AUTO-PUSH] Sem conexão com a nuvem remota (${errRede.message}). App offline segue operando 100% normal.`);
                }
            }

            // 3. Só marca sync_nuvem = 1 se o upload teve sucesso E se nenhuma nova alteração aconteceu durante o envio
            if (uploadRemotoOk) {
                let versaoMantida = false;
                db.transaction(() => {
                    const infoEv = db.prepare(`
                        UPDATE eventos
                        SET sync_nuvem = 1, ultimo_sync_em = CURRENT_TIMESTAMP
                        WHERE id = ? AND versao_sync = ? AND COALESCE(sync_nuvem, 0) != -1
                    `).run(eventoId, pacote.versao_sync);

                    if (infoEv.changes > 0) {
                        versaoMantida = true;
                        db.prepare(`
                            UPDATE tentativas 
                            SET sync_nuvem = 1 
                            WHERE id IN (
                                SELECT t.id FROM tentativas t 
                                JOIN inscricoes i ON t.inscricao_id = i.id 
                                WHERE i.evento_id = ? AND t.sync_nuvem = 0
                            )
                        `).run(eventoId);
                    }
                })();

                if (versaoMantida) {
                    console.log(`📦 [SYNC/BACKUP] Snapshot #v${pacote.versao_sync} do Evento [${pacote.evento.nome}] (SHA-256: ${pacote.checksum_sha256.slice(0, 8)}...) sincronizado.`);
                } else {
                    // Ocorreu uma nova ação na Mesa enquanto o pacote subia: agenda envio imediato da nova versão
                    syncPendenteAposAtual = true;
                }
            }
        }
    } catch (error) {
        console.error("⚠️ [SYNC/BACKUP] Aviso temporário isolado:", error.message);
    } finally {
        syncEmAndamento = false;
        if (syncPendenteAposAtual) {
            syncPendenteAposAtual = false;
            agendarPushImediatoNuvem(150);
        }
    }
}

// Varredura periódica de 30s (Garante retry automático se a internet tiver oscilado + Backup rotativo em disco)
setInterval(() => {
    executarCicloSincronizacaoNuvem(true);
}, 30000);

// ============================================================================
// CAMADA DE ISOLAMENTO DE ERROS
// ============================================================================

app.use((err, req, res, next) => {
    console.error("🛡️ [ERRO DE ROTA ISOLADO]:", err.message);
    registrarLogSeguranca(null, 'express_route_error', {
        rota: req?.originalUrl,
        metodo: req?.method,
        mensagem: err.message
    });
    if (!res.headersSent) {
        res.status(500).json({ erro: "Erro interno processado com segurança. Tente novamente." });
    }
});

process.on('unhandledRejection', (motivo) => {
    console.error("🛡️ [PROMISE ISOLADA] Falha assíncrona em segundo plano interceptada:", motivo);
    syncEmAndamento = false;
    registrarLogSeguranca(null, 'unhandledRejection', {
        motivo: motivo instanceof Error ? motivo.message : String(motivo),
        stack: motivo instanceof Error ? motivo.stack : null
    });
});

let encerrandoPorExcecao = false;
process.on('uncaughtException', (erro) => {
    if (erro && (erro.code === 'ECONNRESET' || erro.code === 'EPIPE' || erro.code === 'ECONNABORTED')) {
        console.warn("⚠️ [REDE LOCAL] Conexão TCP interrompida pelo cliente (ignorada):", erro.code);
        return;
    }

    if (encerrandoPorExcecao) return;
    encerrandoPorExcecao = true;

    console.error("🔄 [AUTO-RECOVERY] Exceção crítica detectada. Consolidando banco WAL para reinício instantâneo:", erro);

    const killTimer = setTimeout(() => process.exit(1), 400);
    if (typeof killTimer.unref === 'function') killTimer.unref();

    try {
        registrarLogSeguranca(null, 'uncaughtException_restart', {
            mensagem: erro.message,
            stack: erro.stack
        });
    } catch (e) {}

    try {
        fecharBancoComSeguranca();
    } catch (e) {}

    process.exit(1);
});

// ============================================================================
// INICIALIZAÇÃO DO SERVIDOR NA REDE LOCAL (COM RETRY DE PORTA PÓS-REINÍCIO)
// ============================================================================

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sinal => {
    process.on(sinal, () => {
        console.log(`\n🛑 Sinal ${sinal} recebido. Salvando checkpoint do banco de dados...`);
        fecharBancoComSeguranca();
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
let tentativasBindPorta = 0;

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && tentativasBindPorta < 6) {
        tentativasBindPorta++;
        console.warn(`⏳ Porta ${PORT} em liberação pelo Windows. Nova tentativa (${tentativasBindPorta}/6) em 250ms...`);
        setTimeout(() => {
            server.close();
            server.listen(PORT, '0.0.0.0');
        }, 250);
    } else {
        console.error("❌ Erro fatal ao abrir porta do servidor:", err.message);
        fecharBancoComSeguranca();
        process.exit(1);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    tentativasBindPorta = 0;
    console.log(`🚀 Servidor Brasil Powerlifting rodando!`);
    console.log(`- Neste computador: http://localhost:${PORT}`);
    console.log(`- Em telemóveis/tablets/TVs na mesma rede Wi-Fi: veja os IPs na tela inicial`);
});