# Cloud Synchronization & Self-Hosting Guide (Bring Your Own Cloud)

ME: I USED AI TO CREATE THIS GUIDE, USE WITH CAUTION. This application is **100% offline-first** and operates locally out of the box using its built-in SQLite engine. However, if you want to enable **Cloud Backup, Multi-Device Synchronization, Live Broadcast Data, or Web Registrations** on your own infrastructure, you can connect the desktop application to your own custom API and database.

This document specifies the **security safeguards**, **cryptographic payload contracts**, **REST API endpoints**, and **SQL schema** required to connect a custom cloud backend to the desktop application without errors.

---

## 1. Architectural Safeguards & Safety Mechanisms

To prevent data loss during live competitions and protect low-tier cloud databases from overload, your cloud API implementation must enforce the following seven safeguards expected by the desktop client:

### 1.1. Cryptographic Network Integrity (SHA-256 Gatekeeper)
Whenever the desktop app pushes a tournament package (`POST /api/nuvem/receber_pacote`), it computes a deterministic **SHA-256 checksum** over a canonicalized JSON subset of the tournament (`nucleo`) and sends it in both the `X-Payload-SHA256` HTTP header and `body.checksum_sha256`.
* **Safety Rule:** The server must independently recompute the canonical SHA-256 hash upon arrival. If the computed hash does not match the client's hash, the server **must reject the request with `HTTP 422`** before touching the database. This guarantees that truncated or corrupted network payloads never overwrite a competition.

### 1.2. Multi-Tenant Bearer Authentication & Timing-Safe Hash Comparison
The desktop app authenticates using an **Organizer ID** (`organizador_id`) and a **Bearer Token** (`Authorization: Bearer <TOKEN>`).
* **Safety Rule:** Plain-text tokens must never be stored in the database. Store only the lowercase 64-character **SHA-256 hex digest** (`token_hash`) and compare incoming token hashes using constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks.

### 1.3. Per-Tournament Concurrency Mutex Lock
During weigh-ins or live scoring, multiple requests for the same championship (`nuvem_id`) could arrive nearly simultaneously.
* **Safety Rule:** Wrap all write and delete operations per `nuvem_id` inside an in-memory sequential Promise queue (mutex lock) so database transactions for the same championship never race against each other.

### 1.4. Anti-Wipe Protection (Zero-Athlete Guard)
If an organizer accidentally pushes an empty state over a populated championship in the cloud, all registered athletes could be wiped.
* **Safety Rule:** If the championship already exists in the cloud with `qtd_atletas > 0` and the incoming payload has `0` athletes, the database stored procedure must block the write (throwing custom SQL error `50005` -> `HTTP 403`) unless the desktop app explicitly passes `permitir_zerar_atletas: true` or provides a non-empty `atletas_arquivados` array confirming intentional removal.

### 1.5. Competition-Day Lock & Web-Registration Merge Protection
If your cloud also hosts a web panel or online athlete registration:
* **Competition-Day Lock:** Any modification originating from a web browser (`origem_painel_web: true` or missing `exportado_em` timestamp from the desktop app) must be blocked (`HTTP 403`) when the current date (in `UTC-3`) is on or after `evento.data`. On competition day, the offline desktop app at the scorekeeper's table is the single source of truth.
* **Anti-Loss Merge & Privacy Preservation:** Before saving an incoming package, compare it against the existing `payload_json` in the cloud:
  * Preserve web-specific metadata (`anonimizar_historico`, `origem_inscricao`, `aceite_termos_em`) on matching athletes.
  * If an athlete with `origem_inscricao === 'WEB'` is missing from the incoming payload and is **not** listed in `body.atletas_arquivados` (and `permitir_zerar_atletas` is false), automatically merge that athlete and their initial attempts (`pendente`) into the package so simultaneous web sign-ups are never lost.

### 1.6. Dual-Layer Storage & Rolling 20-Snapshot Disaster Recovery Vault
Every synchronization saves data in two formats inside a single atomic transaction:
1. **Master JSON Vault & Rolling History:** Full JSON packages are stored in `nuvem_campeonatos` and appended to `nuvem_snapshots_historico` (retaining the latest **20 versions** per `nuvem_id`). Organizers can inspect and restore any previous snapshot directly from the desktop app.
2. **Unpacked Relational Tables:** Event metadata, platform states, registrations, and attempts are unpacked into relational tables (`eventos_relacional`, `estado_plataformas_relacional`, `inscricoes_relacional`, `tentativas_relacional`) for fast live queries.

### 1.7. 24-Hour Live Broadcast Gatekeeper & RAM Cache
ME: I RECOMMEND THIS TO AVOID CONSTANT REQUESTS TO THE API FROM PEOPLE WITH ACTIVE STRINGS OPENED ON OBS.

---

## 2. HTTP Server & CORS Requirements

Configure your HTTP server with a **15 MB JSON body limit** (`express.json({ limit: '15mb' })`) and the following CORS headers so the desktop client can communicate seamlessly:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Payload-SHA256, X-Organizador-Id, X-Overlay-Key, x-admin-master-key, x-admin-totp, x-admin-password
```

Respond to `OPTIONS` preflight requests with `HTTP 204 No Content`.

---

## 3. Canonical SHA-256 Checksum Specification

To validate `X-Payload-SHA256` on `POST /api/nuvem/receber_pacote`, your server **must** normalize fields and serialize keys in alphabetical order using the exact logic below:

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

## 4. Required API Endpoints Specification

All `/api/nuvem/*` endpoints require the `Authorization: Bearer <TOKEN>` header and optionally accept `X-Organizador-Id`.

### 4.1. `GET /api/health`
Healthcheck endpoint to verify API and database availability.
* **Auth:** Public (None)
* **Response (`200 OK`):**
```json
{
  "ok": true,
  "service": "powerlifting-cloud-api",
  "timestamp": 1763275200000
}
```

### 4.2. `POST /api/nuvem/receber_pacote`
Receives a full championship synchronization package from the desktop app, verifies the `X-Payload-SHA256` checksum, merges any protected web registrations, and executes `powerlifting.sp_SincronizarPacoteCampeonato`.
* **Headers:** `Authorization: Bearer <TOKEN>`, `X-Payload-SHA256: <64_CHAR_HEX>`
* **Response (`200 OK`):**
```json
{
  "sucesso": true,
  "nuvem_id": "uuid-or-custom-id",
  "organizador_id": "ORG_01",
  "checksum_sha256": "computed_64_char_sha256_hex"
}
```
* **Error Responses:**
  * `400 / 422`: Invalid structure or SHA-256 integrity mismatch (`{ "erro": "..." }`).
  * `403`: Competition-day web modification lock, quota exceeded (`50003` / `50004`), or zero-athlete anti-wipe block (`50005`).

### 4.3. `GET /api/nuvem/resumo-conta`
Returns the authenticated organizer's quota usage and remaining limits.
* **Response (`200 OK`):**
```json
{
  "organizador_id": "ORG_01",
  "nome_organizacao": "My Federation",
  "total_campeonatos_conta": 4,
  "max_campeonatos": 30,
  "campeonatos_restantes": 26,
  "total_inscricoes_conta": 120,
  "max_inscricoes": 500,
  "inscricoes_restantes": 380
}
```

### 4.4. `GET /api/nuvem/campeonatos`
Lists all championships stored in the cloud for the authenticated organizer, ordered by `atualizado_em DESC`.
* **Response (`200 OK`):** Must return a pure JSON Array where each object includes quota metadata:
```json
[
  {
    "nuvem_id": "uuid-1234",
    "organizador_id": "ORG_01",
    "nome_evento": "National Cup 2026",
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
Returns up to the last **20 rolling snapshots** for a championship so the organizer can recover from mistakes.
* **Response (`200 OK`):**
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
Downloads the complete JSON package (`payload_json`) for a championship to import/restore into the desktop app.
* **Query Parameters (Optional):** `?snapshot_id=105` — If provided, fetches `payload_json` from `powerlifting.nuvem_snapshots_historico` where `id = @snapshot_id`; otherwise fetches the latest `payload_json` from `powerlifting.nuvem_campeonatos`.
* **Response (`200 OK`):** Returns the parsed `payload_json` object directly.

### 4.7. `DELETE /api/nuvem/inscricao/:nuvem_id/:inscricao_id`
Removes a single athlete registration and their associated attempts from the cloud package (blocked on or after competition day `data_evento <= today`).
* **Response (`200 OK`):**
```json
{
  "sucesso": true,
  "inscricao_id_removida": 14,
  "nome_removido": "Athlete Name",
  "qtd_inscritos_atual": 44
}
```

### 4.8. `DELETE /api/nuvem/campeonatos/:nuvem_id`
Permanently deletes a championship and all its relational/snapshot records inside an atomic transaction.
* **Safety Requirement:** Requires `{ "confirmacao_nome": "Exact Event Name" }` in the request body. If `confirmacao_nome` does not match `nome_evento` character-for-character, return `HTTP 400`.
* **Response (`200 OK`):**
```json
{
  "sucesso": true,
  "nuvem_id": "uuid-1234",
  "nome_excluido": "National Cup 2026"
}
```

---

## 5. Database Setup Script compatible with SQL Server or Azure SQL

Run the following SQL script on your COMPATIBLE Database instance to create the `[powerlifting]` schema, all required tables, and the `powerlifting.sp_SincronizarPacoteCampeonato` stored procedure with built-in quota and anti-wipe safeguards:

```sql
-- 1. Create Schema
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'powerlifting')
BEGIN
    EXEC('CREATE SCHEMA [powerlifting]');
END
GO

-- 2. Organizers Table (Multi-Tenant Auth & Quotas)
CREATE TABLE powerlifting.organizadores (
    organizador_id NVARCHAR(100) NOT NULL PRIMARY KEY,
    nome_organizacao NVARCHAR(200) NOT NULL,
    token_hash CHAR(64) NOT NULL, -- Lowercase 64-char SHA-256 hex digest of the Bearer token
    ativo BIT NOT NULL DEFAULT 1,
    max_campeonatos INT NOT NULL DEFAULT 30,
    max_inscricoes INT NOT NULL DEFAULT 500,
    criado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- 3. Active Cloud Championships (Master JSON Vault)
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

-- 4. Rolling Snapshot History (Disaster Recovery Vault)
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

-- 5. Relational Events Table
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

-- 6. Relational Platform Live States Table
CREATE TABLE powerlifting.estado_plataformas_relacional (
    nuvem_id NVARCHAR(100) NOT NULL,
    plataforma INT NOT NULL,
    estado_json NVARCHAR(MAX) NULL,
    atualizado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY (nuvem_id, plataforma)
);

-- 7. Relational Registrations (Athletes) Table
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

-- 8. Relational Attempts Table
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

-- 9. Web Registration Config Table (Used via LEFT JOIN in /api/nuvem/campeonatos)
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

    -- Check Organizer Quotas (Error 50003 = Max Championships, Error 50004 = Max Registrations)
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

    -- Anti-Wipe Safety Check (Error 50005)
    DECLARE @qtd_anterior INT = (
        SELECT qtd_atletas FROM powerlifting.nuvem_campeonatos
        WHERE nuvem_id = @nuvem_id AND organizador_id = @organizador_id
    );
    IF @qtd_anterior IS NOT NULL AND @qtd_anterior > 0 AND @qtd_atletas = 0 AND @permitir_zerar_atletas = 0
        THROW 50005, 'Protecao anti-perda: bloqueada tentativa de zerar atletas sem confirmacao explicita.', 1;

    BEGIN TRANSACTION;

    -- Upsert Master Vault
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

    -- Append to Rolling Snapshot History (Retain latest 20 snapshots per meet)
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

    -- Upsert Relational Event Metadata
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

    -- Refresh Relational Registrations
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

    -- Refresh Relational Attempts
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

    -- Refresh Platform Live States
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

## 6. Generating Credentials & Connecting the Desktop App

### Step 1: Generate an Organizer Token & SHA-256 Hash
Run this one-liner in your terminal using Node.js to generate a secret token and its 64-character SHA-256 hash:

```bash
node -e "const crypto = require('crypto'); const token = 'my-secret-key-2026'; console.log('Plain Token (use in App):', token); console.log('SHA-256 Hash (save in DB):', crypto.createHash('sha256').update(token, 'utf8').digest('hex'));"
```

### Step 2: Register the Organizer in SQL
Insert your Organizer ID and the 64-character `token_hash` into `powerlifting.organizadores`:

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
    'My Powerlifting Federation',
    'PASTE_64_CHARACTER_SHA256_HASH_HERE',
    1,
    50,
    2000
);
```

### Step 3: Point the Desktop App to Your Cloud API
1. Update the Cloud API base URL in your local desktop app configuration to point to your deployed API URL (e.g., `https://your-custom-api.example.com`).
2. Open the **Cloud (Nuvem)** panel in the desktop app.
3. Enter your **Organizer ID** (`ORG_01`) and your **Plain-Text Token** (`my-secret-key-2026`).
4. Click **Synchronize**. The app will compute the canonical SHA-256 checksum, push your tournament package, and create your first cloud snapshot.