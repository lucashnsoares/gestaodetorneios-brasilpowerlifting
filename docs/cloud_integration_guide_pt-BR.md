# Guia de Sincronização e Hospedagem em Nuvem Própria (Bring Your Own Cloud)

Eu: Eu pedi pra IA criar esse guia, então USE COM CUIDADO. Esse aplicativo foi projetado com arquitetura **100% Offline-First**, funcionando localmente de forma completa através do seu banco de dados SQLite integrado. No entanto, caso deseje habilitar **Backup em Nuvem, Sincronização entre Múltiplos Dispositivos, Transmissão de Resultados Ao Vivo ou Inscrições Web** utilizando a sua própria infraestrutura, você pode conectar o aplicativo desktop à sua própria API e banco de dados.

Este documento especifica todas as **travas de segurança**, **contratos criptográficos de integridade**, **rotas da API REST** e o **schema SQL** necessários para conectar a sua própria nuvem ao aplicativo desktop sem erros.

---

## 1. Travas de Segurança e Salvaguardas da Arquitetura

Para impedir perda de dados durante competições ao vivo e proteger bancos de dados em nuvem de baixo custo contra sobrecarga, a sua API em nuvem deve implementar as sete salvaguardas abaixo, que são esperadas pelo aplicativo desktop:

### 1.1. Gatekeeper de Integridade Criptográfica (SHA-256)
Sempre que o aplicativo desktop envia um pacote de campeonato (`POST /api/nuvem/receber_pacote`), ele calcula um **hash SHA-256** determinístico sobre uma estrutura JSON canônica do campeonato (`nucleo`) e o envia tanto no cabeçalho HTTP `X-Payload-SHA256` quanto no campo `body.checksum_sha256`.
* **Regra de Segurança:** O servidor deve recalcular de forma independente o hash SHA-256 canônico ao receber a requisição. Se o hash calculado divergir do hash enviado pelo aplicativo, o servidor **deve rejeitar a gravação com `HTTP 422`** antes de tocar no banco de dados. Isso garante que pacotes truncados ou corrompidos por instabilidades de rede jamais sobrescrevam um campeonato.

### 1.2. Autenticação Multi-Tenant Bearer & Comparação Timing-Safe
O aplicativo autentica o usuário utilizando um **ID de Organizador** (`organizador_id`) e uma **Chave de Acesso / Token** (`Authorization: Bearer <TOKEN>`).
* **Regra de Segurança:** A chave em texto puro nunca deve ser salva no banco de dados. Armazene apenas o **hash SHA-256 em hexadecimal minúsculo de 64 caracteres** (`token_hash`) e compare o hash recebido utilizando comparação em tempo constante (`crypto.timingSafeEqual`) para mitigar ataques de temporização (*timing attacks*).

### 1.3. Trava de Concorrência em Memória por Campeonato (Mutex Lock)
Durante a pesagem ou operação de mesa, múltiplas requisições para o mesmo campeonato (`nuvem_id`) podem chegar quase simultaneamente.
* **Regra de Segurança:** Encapsule todas as operações de gravação e exclusão de um mesmo `nuvem_id` em uma fila sequencial de Promises em memória (*mutex lock*), garantindo que transações do mesmo campeonato nunca disputem condição de corrida (*race condition*) no banco de dados.

### 1.4. Proteção Anti-Perda de Atletas (Bloqueio contra Zerar Inscritos)
Se um organizador enviar acidentalmente um campeonato vazio sobre um campeonato que já possui atletas na nuvem, todas as inscrições poderiam ser apagadas.
* **Regra de Segurança:** Se o campeonato já existir na nuvem com `qtd_atletas > 0` e o novo pacote chegar com `0` atletas, a *stored procedure* do banco de dados deve bloquear a gravação (disparando o erro SQL customizado `50005` -> `HTTP 403`), a menos que o aplicativo envie explicitamente a flag `permitir_zerar_atletas: true` ou informe uma lista não vazia em `atletas_arquivados` confirmando a exclusão intencional.

### 1.5. Trava do Dia da Competição & Preservação de Inscritos Web / LGPD
Caso a sua nuvem também ofereça painel web ou formulário público de inscrições:
* **Trava do Dia do Campeonato:** Qualquer alteração originada de um navegador web (`origem_painel_web: true` ou ausência do campo `exportado_em` gerado pelo app offline) deve ser bloqueada (`HTTP 403`) quando a data atual (no fuso horário do Brasil `UTC-3`) for igual ou posterior à data do campeonato (`evento.data`). No dia da competição, o aplicativo offline na mesa é a única fonte da verdade.
* **Mesclagem Anti-Perda e Preservação LGPD:** Antes de gravar um novo pacote, compare-o com o `payload_json` atual salvo na nuvem:
  * Preserve metadados originados na web (`anonimizar_historico`, `origem_inscricao`, `aceite_termos_em`) nos atletas correspondentes.
  * Se um atleta com `origem_inscricao === 'WEB'` não estiver no pacote recebido e **não** constar na lista `body.atletas_arquivados` (e `permitir_zerar_atletas` for `false`), mescle automaticamente esse atleta e suas tentativas iniciais (`pendente`) no pacote antes de salvar, impedindo que inscrições online simultâneas sejam perdidas.

### 1.6. Armazenamento em Dupla Camada & Cofre de 20 Snapshots (Recuperação de Desastres)
Cada sincronização grava os dados em dois formatos dentro de uma única transação atômica:
1. **Cofre JSON Mestre & Histórico Rotativo:** O pacote JSON completo é salvo em `nuvem_campeonatos` e inserido em `nuvem_snapshots_historico` (mantendo as **últimas 20 versões** por `nuvem_id`). Isso permite restaurar qualquer versão anterior diretamente pelo aplicativo desktop.
2. **Tabelas Relacionais Descompactadas:** Os dados do evento, estados das plataformas, inscrições e tentativas são descompactados em tabelas relacionais (`eventos_relacional`, `estado_plataformas_relacional`, `inscricoes_relacional`, `tentativas_relacional`) para leitura rápida.

### 1.7. Gatekeeper de 24 Horas para Transmissão Ao Vivo & Cache em RAM
Eu: Eu recomendo fazer isso pra evitar requisições constantes no banco de dados por causa de usuários com a string salva no OBS. Depois do fim do campeonato as requisições tem que ser bloqueadas.

---

## 2. Configuração do Servidor HTTP e Cabeçalhos CORS

Configure o seu servidor HTTP com limite de payload JSON de **15 MB** (`express.json({ limit: '15mb' })`) e habilite os seguintes cabeçalhos CORS para comunicação com o aplicativo:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Payload-SHA256, X-Organizador-Id, X-Overlay-Key, x-admin-master-key, x-admin-totp, x-admin-password
```

Responda às requisições *preflight* `OPTIONS` com status `HTTP 204 No Content`.

---

## 3. Especificação do Checksum Canônico SHA-256

Para validar o cabeçalho `X-Payload-SHA256` na rota `POST /api/nuvem/receber_pacote`, o seu servidor **deve** normalizar os campos e ordenar as chaves JSON alfabeticamente utilizando exatamente a lógica abaixo:

```javascript
const crypto = require('crypto');

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

function sanitizarCPF(cpfBruto) {
    if (!cpfBruto) return null;
    const digitos = String(cpfBruto).replace(/\D/g, '').slice(0, 11);
    return digitos.length > 0 ? digitos : null;
}

function sanitizarOrganizadorId(orgBruto) {
    const limpo = String(orgBruto || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    return limpo || '';
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

function normalizarDivisoesParaBanco(divisaoInput) {
    if (Array.isArray(divisaoInput)) {
        const limpas = divisaoInput.map(d => String(d).trim()).filter(Boolean);
        return JSON.stringify(limpas.length > 0 ? limpas : ['Open']);
    }
    if (typeof divisaoInput === 'string') {
        const trim = divisaoInput.trim();
        if (trim.startsWith('[')) {
            try {
                const parsed = JSON.parse(trim);
                return JSON.stringify(Array.isArray(parsed) && parsed.length > 0 ? parsed : ['Open']);
            } catch (_) {
                return JSON.stringify(['Open']);
            }
        }
        return JSON.stringify(trim ? [trim] : ['Open']);
    }
    return JSON.stringify(['Open']);
}

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
        organizador_id: sanitizarOrganizadorId(pacote?.organizador_id || pacote?.evento?.organizador_id || 'LOCAL') || 'LOCAL',
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
```

---

## 4. Contrato das Rotas da API (`/api/nuvem/*`)

Todas as rotas `/api/nuvem/*` exigem o cabeçalho `Authorization: Bearer <TOKEN>` e aceitam opcionalmente o cabeçalho `X-Organizador-Id`.

### 4.1. `GET /api/health`
Rota pública de verificação de saúde da API e da conexão com o banco de dados.
* **Autenticação:** Pública (Nenhuma)
* **Resposta (`200 OK`):**
```json
{
  "ok": true,
  "service": "powerlifting-cloud-api",
  "timestamp": 1763275200000
}
```

### 4.2. `POST /api/nuvem/receber_pacote`
Recebe o pacote completo do campeonato enviado pelo aplicativo desktop, valida a integridade via `X-Payload-SHA256`, preserva inscrições web ativas e executa a procedure `powerlifting.sp_SincronizarPacoteCampeonato`.
* **Cabeçalhos:** `Authorization: Bearer <TOKEN>`, `X-Payload-SHA256: <HASH_HEX_64_CHARS>`
* **Resposta (`200 OK`):**
```json
{
  "sucesso": true,
  "nuvem_id": "uuid-ou-id-customizado",
  "organizador_id": "ORG_01",
  "checksum_sha256": "hash_sha256_calculado_64_chars"
}
```
* **Respostas de Erro:**
  * `400 / 422`: Estrutura JSON inválida ou falha de integridade SHA-256 (`{ "erro": "..." }`).
  * `403`: Bloqueio de edição web no dia do campeonato, limite da licença atingido (`50003` / `50004`) ou proteção anti-perda de atletas acionada (`50005`).

### 4.3. `GET /api/nuvem/resumo-conta`
Retorna o consumo atual e os limites de campeonatos e inscrições da conta autenticada.
* **Resposta (`200 OK`):**
```json
{
  "organizador_id": "ORG_01",
  "nome_organizacao": "Minha Federação",
  "total_campeonatos_conta": 4,
  "max_campeonatos": 30,
  "campeonatos_restantes": 26,
  "total_inscricoes_conta": 120,
  "max_inscricoes": 500,
  "inscricoes_restantes": 380
}
```

### 4.4. `GET /api/nuvem/campeonatos`
Lista todos os campeonatos sincronizados na nuvem pelo organizador autenticado, ordenados por `atualizado_em DESC`.
* **Resposta (`200 OK`):** Deve retornar um Array JSON puro onde cada item inclui os metadados de limite da licença:
```json
[
  {
    "nuvem_id": "uuid-1234",
    "organizador_id": "ORG_01",
    "nome_evento": "Copa Nacional 2026",
    "data_evento": "2026-11-20",
    "qtd_atletas": 45,
    "versao_sync": 12,
    "checksum_sha256": "a1b2c3...",
    "publicado_acervo": 0,
    "inscricoes_abertas": 0,
    "listado_publicamente": 1,
    "atualizado_em": "2026-11-16 14:30:00",
    "max_campeonatos": 30,
    "max_inscricoes": 500,
    "total_campeonatos_conta": 4,
    "total_inscricoes_conta": 120
  }
]
```

### 4.5. `GET /api/nuvem/historico/:nuvem_id`
Retorna os **últimos 20 snapshots históricos** de um campeonato para recuperação de desastres.
* **Resposta (`200 OK`):**
```json
[
  {
    "id": 105,
    "nuvem_id": "uuid-1234",
    "organizador_id": "ORG_01",
    "versao_sync": 12,
    "qtd_atletas": 45,
    "checksum_sha256": "a1b2c3...",
    "criado_em": "2026-11-16 14:30:00"
  }
]
```

### 4.6. `GET /api/nuvem/pacote/:nuvem_id`
Baixa o pacote JSON completo (`payload_json`) de um campeonato para restauração ou importação no aplicativo desktop.
* **Query Parameter (Opcional):** `?snapshot_id=105` — Se informado, busca o `payload_json` na tabela `powerlifting.nuvem_snapshots_historico` correspondente ao `id`; caso contrário, retorna o `payload_json` mais recente de `powerlifting.nuvem_campeonatos`.
* **Resposta (`200 OK`):** Retorna diretamente o objeto JSON do pacote.

### 4.7. `DELETE /api/nuvem/inscricao/:nuvem_id/:inscricao_id`
Remove uma inscrição individual e suas respectivas tentativas do pacote na nuvem (bloqueado no dia da competição ou após: `data_evento <= hoje`).
* **Resposta (`200 OK`):**
```json
{
  "sucesso": true,
  "inscricao_id_removida": 14,
  "nome_removido": "Nome do Atleta",
  "qtd_inscritos_atual": 44
}
```

### 4.8. `DELETE /api/nuvem/campeonatos/:nuvem_id`
Exclui definitivamente um campeonato e todos os seus registros relacionais e históricos em uma transação atômica.
* **Trava de Segurança:** Exige o envio de `{ "confirmacao_nome": "Nome Exato do Evento" }` no corpo da requisição. Se o texto digitado não coincidir exatamente com `nome_evento`, deve retornar `HTTP 400`.
* **Resposta (`200 OK`):**
```json
{
  "sucesso": true,
  "nuvem_id": "uuid-1234",
  "nome_excluido": "Copa Nacional 2026"
}
```

---

## 5. Script de Criação do Banco de Dados compatível com SQL Server ou Azure SQL

Execute o script SQL abaixo na sua instância compatível para criar o schema `[powerlifting]`, todas as tabelas necessárias e a *stored procedure* `powerlifting.sp_SincronizarPacoteCampeonato` com todas as travas de licença e proteção anti-perda:

```sql
-- 1. Criação do Schema
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'powerlifting')
BEGIN
    EXEC('CREATE SCHEMA [powerlifting]');
END
GO

-- 2. Tabela de Organizadores (Autenticação Multi-Tenant e Limites)
CREATE TABLE powerlifting.organizadores (
    organizador_id NVARCHAR(100) NOT NULL PRIMARY KEY,
    nome_organizacao NVARCHAR(200) NOT NULL,
    token_hash CHAR(64) NOT NULL, -- Hash SHA-256 hex minúsculo (64 caracteres) da chave de acesso
    ativo BIT NOT NULL DEFAULT 1,
    max_campeonatos INT NOT NULL DEFAULT 30,
    max_inscricoes INT NOT NULL DEFAULT 500,
    criado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- 3. Campeonatos Ativos na Nuvem (Cofre JSON Mestre)
CREATE TABLE powerlifting.nuvem_campeonatos (
    nuvem_id NVARCHAR(100) NOT NULL PRIMARY KEY,
    organizador_id NVARCHAR(100) NOT NULL,
    nome_evento NVARCHAR(255) NOT NULL,
    data_evento NVARCHAR(50) NOT NULL,
    qtd_atletas INT NOT NULL DEFAULT 0,
    versao_sync INT NOT NULL DEFAULT 1,
    checksum_sha256 CHAR(64) NOT NULL,
    payload_json NVARCHAR(MAX) NOT NULL,
    atualizado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_nuvem_camp_org ON powerlifting.nuvem_campeonatos (organizador_id, atualizado_em DESC);

-- 4. Histórico Rotativo de Snapshots (Cofre de Recuperação de Desastres)
CREATE TABLE powerlifting.nuvem_snapshots_historico (
    id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    nuvem_id NVARCHAR(100) NOT NULL,
    organizador_id NVARCHAR(100) NOT NULL,
    versao_sync INT NOT NULL,
    qtd_atletas INT NOT NULL,
    checksum_sha256 CHAR(64) NOT NULL,
    payload_json NVARCHAR(MAX) NOT NULL,
    criado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_snapshots_nuvem_org ON powerlifting.nuvem_snapshots_historico (nuvem_id, organizador_id, id DESC);

-- 5. Tabela Relacional de Eventos
CREATE TABLE powerlifting.eventos_relacional (
    nuvem_id NVARCHAR(100) NOT NULL PRIMARY KEY,
    organizador_id NVARCHAR(100) NOT NULL,
    nome NVARCHAR(255) NOT NULL,
    data NVARCHAR(50) NOT NULL,
    modalidades NVARCHAR(MAX) NULL,
    divisoes_idade NVARCHAR(MAX) NULL,
    categorias_peso_masculino NVARCHAR(MAX) NULL,
    categorias_peso_feminino NVARCHAR(MAX) NULL,
    num_plataformas INT NOT NULL DEFAULT 1,
    anilhas_calibradas BIT NOT NULL DEFAULT 1,
    equipamentos NVARCHAR(MAX) NULL,
    versao_sync INT NOT NULL DEFAULT 1,
    publicado_acervo BIT NOT NULL DEFAULT 0,
    atualizado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- 6. Tabela Relacional de Estado Ao Vivo das Plataformas
CREATE TABLE powerlifting.estado_plataformas_relacional (
    nuvem_id NVARCHAR(100) NOT NULL,
    plataforma INT NOT NULL,
    estado_json NVARCHAR(MAX) NULL,
    atualizado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY (nuvem_id, plataforma)
);

-- 7. Tabela Relacional de Inscrições (Atletas)
CREATE TABLE powerlifting.inscricoes_relacional (
    nuvem_id NVARCHAR(100) NOT NULL,
    inscricao_local_id INT NOT NULL,
    nome NVARCHAR(255) NOT NULL,
    sexo CHAR(1) NOT NULL DEFAULT 'M',
    equipe NVARCHAR(255) NULL,
    pcd BIT NOT NULL DEFAULT 0,
    instagram NVARCHAR(255) NULL,
    youtube NVARCHAR(255) NULL,
    outros_social NVARCHAR(255) NULL,
    modalidade_escolhida NVARCHAR(100) NULL,
    equipamento_escolhido NVARCHAR(100) NULL,
    divisao_escolhida NVARCHAR(MAX) NULL,
    categoria_peso_escolhida NVARCHAR(100) NULL,
    peso_corporal_oficial DECIMAL(6,2) NULL,
    numero_lote INT NULL,
    rack_agachamento NVARCHAR(50) NULL,
    rack_supino NVARCHAR(50) NULL,
    trava_supino NVARCHAR(50) NULL,
    bateria_agachamento INT NULL,
    bateria_supino INT NULL,
    bateria_terra INT NULL,
    plataforma_agachamento INT NOT NULL DEFAULT 1,
    plataforma_supino INT NOT NULL DEFAULT 1,
    plataforma_terra INT NOT NULL DEFAULT 1,
    remanejado_manual BIT NOT NULL DEFAULT 0,
    PRIMARY KEY (nuvem_id, inscricao_local_id)
);

-- 8. Tabela Relacional de Tentativas
CREATE TABLE powerlifting.tentativas_relacional (
    nuvem_id NVARCHAR(100) NOT NULL,
    tentativa_local_id INT NOT NULL,
    inscricao_local_id INT NOT NULL,
    movimento NVARCHAR(50) NOT NULL,
    numero_tentativa INT NOT NULL,
    peso_solicitado DECIMAL(6,2) NOT NULL DEFAULT 0,
    estado NVARCHAR(50) NOT NULL DEFAULT 'pendente',
    luz_esquerda INT NULL,
    luz_central INT NULL,
    luz_direita INT NULL,
    resultado_valido INT NULL,
    PRIMARY KEY (nuvem_id, tentativa_local_id)
);

-- 9. Tabela Opcional de Configuração de Inscrição Web (Usada no LEFT JOIN de /api/nuvem/campeonatos)
CREATE TABLE powerlifting.config_inscricao_web (
    nuvem_id NVARCHAR(100) NOT NULL PRIMARY KEY,
    organizador_id NVARCHAR(100) NOT NULL,
    inscricoes_abertas BIT NOT NULL DEFAULT 0,
    listado_publicamente BIT NOT NULL DEFAULT 1
);
GO

-- 10. Stored Procedure: sp_SincronizarPacoteCampeonato
CREATE OR ALTER PROCEDURE powerlifting.sp_SincronizarPacoteCampeonato
    @nuvem_id NVARCHAR(100),
    @organizador_id NVARCHAR(100),
    @checksum_sha256 CHAR(64),
    @payload_json NVARCHAR(MAX),
    @permitir_zerar_atletas BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @nome_evento NVARCHAR(255) = ISNULL(JSON_VALUE(@payload_json, '$.evento.nome'), 'Evento');
    DECLARE @data_evento NVARCHAR(50)  = ISNULL(JSON_VALUE(@payload_json, '$.evento.data'), '');
    DECLARE @versao_sync INT           = ISNULL(TRY_CAST(JSON_VALUE(@payload_json, '$.versao_sync') AS INT), 1);
    DECLARE @qtd_atletas INT           = (SELECT COUNT(1) FROM OPENJSON(@payload_json, '$.inscricoes'));

    -- Verificação de Limites da Conta (Erro 50003 = Max Campeonatos, Erro 50004 = Max Inscrições)
    DECLARE @max_camp INT = 30, @max_insc INT = 500;
    SELECT @max_camp = ISNULL(max_campeonatos, 30), @max_insc = ISNULL(max_inscricoes, 500)
    FROM powerlifting.organizadores WHERE organizador_id = @organizador_id;

    DECLARE @existe_camp BIT = CASE WHEN EXISTS (
        SELECT 1 FROM powerlifting.nuvem_campeonatos WHERE nuvem_id = @nuvem_id
    ) THEN 1 ELSE 0 END;

    IF @existe_camp = 0
    BEGIN
        DECLARE @total_camp_atual INT = (
            SELECT COUNT(1) FROM powerlifting.nuvem_campeonatos WHERE organizador_id = @organizador_id
        );
        IF @total_camp_atual >= @max_camp
            THROW 50003, 'Limite maximo de campeonatos da conta atingido na Nuvem.', 1;
    END

    DECLARE @total_insc_outros INT = (
        SELECT ISNULL(SUM(ISNULL(qtd_atletas, 0)), 0)
        FROM powerlifting.nuvem_campeonatos
        WHERE organizador_id = @organizador_id AND nuvem_id <> @nuvem_id
    );
    IF (@total_insc_outros + @qtd_atletas) > @max_insc
        THROW 50004, 'Limite maximo de inscricoes da conta atingido na Nuvem.', 1;

    -- Trava Anti-Perda de Atletas (Erro 50005)
    DECLARE @qtd_anterior INT = (
        SELECT qtd_atletas FROM powerlifting.nuvem_campeonatos
        WHERE nuvem_id = @nuvem_id AND organizador_id = @organizador_id
    );
    IF @qtd_anterior IS NOT NULL AND @qtd_anterior > 0 AND @qtd_atletas = 0 AND @permitir_zerar_atletas = 0
        THROW 50005, 'Protecao anti-perda: bloqueada tentativa de zerar atletas sem confirmacao explicita.', 1;

    BEGIN TRANSACTION;

    -- Upsert do Cofre Mestre
    IF @existe_camp = 1
    BEGIN
        UPDATE powerlifting.nuvem_campeonatos
        SET nome_evento = @nome_evento,
            data_evento = @data_evento,
            qtd_atletas = @qtd_atletas,
            versao_sync = @versao_sync,
            checksum_sha256 = @checksum_sha256,
            payload_json = @payload_json,
            atualizado_em = SYSUTCDATETIME()
        WHERE nuvem_id = @nuvem_id AND organizador_id = @organizador_id;
    END
    ELSE
    BEGIN
        INSERT INTO powerlifting.nuvem_campeonatos (
            nuvem_id, organizador_id, nome_evento, data_evento,
            qtd_atletas, versao_sync, checksum_sha256, payload_json, atualizado_em
        )
        VALUES (
            @nuvem_id, @organizador_id, @nome_evento, @data_evento,
            @qtd_atletas, @versao_sync, @checksum_sha256, @payload_json, SYSUTCDATETIME()
        );
    END

    -- Grava Snapshot no Histórico Rotativo (Mantém os 20 mais recentes por campeonato)
    INSERT INTO powerlifting.nuvem_snapshots_historico (
        nuvem_id, organizador_id, versao_sync, qtd_atletas, checksum_sha256, payload_json
    )
    VALUES (
        @nuvem_id, @organizador_id, @versao_sync, @qtd_atletas, @checksum_sha256, @payload_json
    );

    DELETE FROM powerlifting.nuvem_snapshots_historico
    WHERE nuvem_id = @nuvem_id
      AND id NOT IN (
          SELECT TOP 20 id
          FROM powerlifting.nuvem_snapshots_historico
          WHERE nuvem_id = @nuvem_id
          ORDER BY id DESC
      );

    -- Upsert dos Metadados Relacionais do Evento
    MERGE powerlifting.eventos_relacional AS target
    USING (SELECT @nuvem_id AS nuvem_id) AS source
    ON (target.nuvem_id = source.nuvem_id)
    WHEN MATCHED THEN
        UPDATE SET
            nome = @nome_evento,
            data = @data_evento,
            modalidades = JSON_QUERY(@payload_json, '$.evento.modalidades'),
            divisoes_idade = JSON_QUERY(@payload_json, '$.evento.divisoes_idade'),
            categorias_peso_masculino = JSON_QUERY(@payload_json, '$.evento.categorias_peso_masculino'),
            categorias_peso_feminino = JSON_QUERY(@payload_json, '$.evento.categorias_peso_feminino'),
            num_plataformas = ISNULL(TRY_CAST(JSON_VALUE(@payload_json, '$.evento.num_plataformas') AS INT), 1),
            anilhas_calibradas = ISNULL(TRY_CAST(JSON_VALUE(@payload_json, '$.evento.anilhas_calibradas') AS BIT), 1),
            equipamentos = JSON_QUERY(@payload_json, '$.evento.equipamentos'),
            versao_sync = @versao_sync,
            atualizado_em = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN
        INSERT (
            nuvem_id, organizador_id, nome, data, modalidades, divisoes_idade,
            categorias_peso_masculino, categorias_peso_feminino, num_plataformas,
            anilhas_calibradas, equipamentos, versao_sync, atualizado_em
        )
        VALUES (
            @nuvem_id, @organizador_id, @nome_evento, @data_evento,
            JSON_QUERY(@payload_json, '$.evento.modalidades'),
            JSON_QUERY(@payload_json, '$.evento.divisoes_idade'),
            JSON_QUERY(@payload_json, '$.evento.categorias_peso_masculino'),
            JSON_QUERY(@payload_json, '$.evento.categorias_peso_feminino'),
            ISNULL(TRY_CAST(JSON_VALUE(@payload_json, '$.evento.num_plataformas') AS INT), 1),
            ISNULL(TRY_CAST(JSON_VALUE(@payload_json, '$.evento.anilhas_calibradas') AS BIT), 1),
            JSON_QUERY(@payload_json, '$.evento.equipamentos'),
            @versao_sync, SYSUTCDATETIME()
        );

    -- Atualiza Inscrições Relacionais
    DELETE FROM powerlifting.inscricoes_relacional WHERE nuvem_id = @nuvem_id;
    INSERT INTO powerlifting.inscricoes_relacional (
        nuvem_id, inscricao_local_id, nome, sexo, equipe, pcd,
        instagram, youtube, outros_social, modalidade_escolhida,
        equipamento_escolhido, divisao_escolhida, categoria_peso_escolhida,
        peso_corporal_oficial, numero_lote, rack_agachamento, rack_supino,
        trava_supino, bateria_agachamento, bateria_supino, bateria_terra,
        plataforma_agachamento, plataforma_supino, plataforma_terra, remanejado_manual
    )
    SELECT
        @nuvem_id,
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.id') AS INT), 0),
        ISNULL(JSON_VALUE(value, '$.nome'), 'Atleta'),
        ISNULL(JSON_VALUE(value, '$.sexo'), 'M'),
        JSON_VALUE(value, '$.equipe'),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.pcd') AS BIT), 0),
        JSON_VALUE(value, '$.instagram'),
        JSON_VALUE(value, '$.youtube'),
        JSON_VALUE(value, '$.outros_social'),
        JSON_VALUE(value, '$.modalidade_escolhida'),
        JSON_VALUE(value, '$.equipamento_escolhido'),
        COALESCE(JSON_QUERY(value, '$.divisao_escolhida'), JSON_VALUE(value, '$.divisao_escolhida')),
        JSON_VALUE(value, '$.categoria_peso_escolhida'),
        TRY_CAST(JSON_VALUE(value, '$.peso_corporal_oficial') AS DECIMAL(6,2)),
        TRY_CAST(JSON_VALUE(value, '$.numero_lote') AS INT),
        JSON_VALUE(value, '$.rack_agachamento'),
        JSON_VALUE(value, '$.rack_supino'),
        JSON_VALUE(value, '$.trava_supino'),
        TRY_CAST(JSON_VALUE(value, '$.bateria_agachamento') AS INT),
        TRY_CAST(JSON_VALUE(value, '$.bateria_supino') AS INT),
        TRY_CAST(JSON_VALUE(value, '$.bateria_terra') AS INT),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.plataforma_agachamento') AS INT), 1),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.plataforma_supino') AS INT), 1),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.plataforma_terra') AS INT), 1),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.remanejado_manual') AS BIT), 0)
    FROM OPENJSON(@payload_json, '$.inscricoes');

    -- Atualiza Tentativas Relacionais
    DELETE FROM powerlifting.tentativas_relacional WHERE nuvem_id = @nuvem_id;
    INSERT INTO powerlifting.tentativas_relacional (
        nuvem_id, tentativa_local_id, inscricao_local_id, movimento,
        numero_tentativa, peso_solicitado, estado,
        luz_esquerda, luz_central, luz_direita, resultado_valido
    )
    SELECT
        @nuvem_id,
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.id') AS INT), CAST([key] AS INT) + 1),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.inscricao_id') AS INT), 0),
        ISNULL(JSON_VALUE(value, '$.movimento'), 'agachamento'),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.numero_tentativa') AS INT), 1),
        ISNULL(TRY_CAST(JSON_VALUE(value, '$.peso_solicitado') AS DECIMAL(6,2)), 0),
        ISNULL(JSON_VALUE(value, '$.estado'), 'pendente'),
        TRY_CAST(JSON_VALUE(value, '$.luz_esquerda') AS INT),
        TRY_CAST(JSON_VALUE(value, '$.luz_central') AS INT),
        TRY_CAST(JSON_VALUE(value, '$.luz_direita') AS INT),
        TRY_CAST(JSON_VALUE(value, '$.resultado_valido') AS INT)
    FROM OPENJSON(@payload_json, '$.tentativas');

    -- Atualiza Estados Ao Vivo das Plataformas
    DELETE FROM powerlifting.estado_plataformas_relacional WHERE nuvem_id = @nuvem_id;
    INSERT INTO powerlifting.estado_plataformas_relacional (nuvem_id, plataforma, estado_json, atualizado_em)
    SELECT
        @nuvem_id,
        TRY_CAST([key] AS INT),
        value,
        SYSUTCDATETIME()
    FROM OPENJSON(@payload_json, '$.estados_plataformas')
    WHERE TRY_CAST([key] AS INT) IS NOT NULL;

    COMMIT TRANSACTION;
END
GO
```

---

## 6. Gerando Credenciais e Conectando o Aplicativo Desktop

### Passo 1: Gere uma Chave de Acesso e seu Hash SHA-256
Execute o comando abaixo no terminal com Node.js para escolher a sua chave secreta e obter o hash SHA-256 de 64 caracteres:

```bash
node -e "const crypto = require('crypto'); const token = 'minha-chave-secreta-2026'; console.log('Chave em Texto Puro (usar no App):', token); console.log('Hash SHA-256 (salvar no Banco):', crypto.createHash('sha256').update(token, 'utf8').digest('hex'));"
```

### Passo 2: Cadastre o Organizador no Banco SQL
Insira o seu ID de Organizador e o `token_hash` gerado de 64 caracteres na tabela `powerlifting.organizadores`:

```sql
INSERT INTO powerlifting.organizadores (
    organizador_id,
    nome_organizacao,
    token_hash,
    ativo,
    max_campeonatos,
    max_inscricoes
)
VALUES (
    'ORG_01',
    'Minha Federação de Powerlifting',
    'COLE_AQUI_O_HASH_SHA256_DE_64_CARACTERES',
    1,
    50,
    2000
);
```

### Passo 3: Conecte o Aplicativo Desktop à sua Nuvem
1. Aponte a URL base da Nuvem na configuração local do aplicativo desktop para o endereço da sua API (ex: `https://sua-api.seudominio.com.br`).
2. Abra a página **Nuvem** dentro do aplicativo desktop.
3. Informe o seu **ID de Organizador** (`ORG_01`) e a sua **Chave de Acesso em texto puro** (`minha-chave-secreta-2026`).
4. Clique em **Sincronizar**. O aplicativo calculará automaticamente o checksum canônico SHA-256, enviará o pacote completo e criará o seu primeiro snapshot seguro na nuvem.