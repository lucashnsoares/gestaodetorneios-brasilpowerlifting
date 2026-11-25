[🇺🇸 English](README.md) | [🇧🇷 Português](README.pt-BR.md)

# Gestão de Torneios Brasil Powerlifting

Sistema **100% offline-first** para organização, arbitragem e placares em tempo real na rede local (Wi-Fi/LAN) de campeonatos de powerlifting e esportes de força — projetado para resistir a quedas de energia, falhas de internet e imprevistos de competição. Disponível em **Português (PT-BR)** e **Inglês (EN)**.

> **Prefere o aplicativo pronto para uso sem precisar compilar?**  
> Baixe a versão oficial gratuita no Brasil e assinada para Windows na **[Microsoft Store](https://apps.microsoft.com/detail/9n79d1086g2w)** ou consulte o **[Manual Oficial](https://brasilpowerlifting.com.br/manual)**.

---

## Flexibilidade Total de Regras

Feito para que qualquer organizador realize qualquer tipo de campeonato de powerlifting, independentemente de quão rígidas ou flexíveis sejam as regras:

- **Todas as Modalidades:** Full Power, Push-Pull, Supino Solo, Terra Solo e Agachamento Solo.
- **Dobra de Categorias de Idade sem Duplicar o Atleta:** Inscreva o mesmo atleta em múltiplas divisões etárias simultaneamente (ex.: *Júnior* + *Open* ou *Master* + *Open*) sem duplicar cadastros nem dividir tentativas.
- **Regras 100% Personalizáveis:** Configure livremente categorias de peso, divisões de equipamento (Raw, Equipado, Faixas, etc.) e divisões de idade.
- **Múltiplas Plataformas:** Gerencie de **1 a 5 plataformas simultâneas** no mesmo evento.
- **Modo Planilha (Escape de Emergência):** Permite edição direta sem travas de fila sempre que imprevistos do evento exigirem ajuste imediato pela mesa.

---

## Principais Recursos

- **Mesa de Controle (`/admin`):** Operação rápida de tentativas com **calculadora visual automática de montagem de anilhas** (calibradas ou convencionais).
- **Periféricos em Tempo Real na Rede Local (Mesmo Wi-Fi, Sem Internet):**
  - **Painel do Árbitro (`/arbitro`):** Luzes brancas e vermelhas em tempo real direto no celular dos árbitros.
  - **Telão da Plateia (`/display`) e TV de Aquecimento (`/aquecimento`):** Atualização instantânea de ordem de chamada, alturas de rack e cronômetro.
  - **Gerador de QR Codes Offline:** Gera automaticamente QR Codes em PNG e cartazes A4 imprimíveis para conexão rápida de celulares e Smart TVs.
- **Pesagem Oficial (`/pesagem`):** Registro de peso corporal, primeiras tentativas (pedidas), alturas de rack/trava e sugestão automática de mudança de categoria. Também pode ser realizador através de celulares ou tablets.
- **Baterias Inteligentes e Desempates:** Montagem automática de baterias, remanejamento manual e suporte a baterias avulsas para **Tentativas de Recorde** ou **Desempates**.
- **Resultados e Rankings Automáticos (`/resultados`):** Classificação imediata com cálculo de **DOTS** e **Wilks** (Melhor Atleta / *Best Lifter*).
- **Importação Offline via Excel e JSON:** Importe listas de inscritos diretamente de planilhas Excel ou arquivos `.json` sem digitar atleta por atleta — mesmo 100% offline.
- **Exportação de backup em tempo real para pendrive/HD externo**: Exporte backups automaticamente durante as competições.
- **Senha opcional para as páginas de configurações do campeonato**: Permite que você conecte o computador a uma rede wi-fi compartilhada sem que pessoas não autorizadas consigam acessar as páginas.
- **Central da Nuvem Opcional (`/nuvem`):** Backups remotos, Cofre de 20 snapshots, download de inscrições online, transmissão ao vivo pela web e *overlays* para lives (via [brasilpowerlifting.com.br](https://brasilpowerlifting.com.br) ou usando sua própria nuvem).

---

## Engenharia de Resiliência e Proteção Contra Falhas

Competições — especialmente torneios amadores — são imprevisíveis. Toda a arquitetura foi construída para impedir corrupção de dados e manter o campeonato rodando sem interrupções:

### Integridade de Dados e Sincronização
- **SQLite em Modo WAL e Salvamento Automático:** Opera com *Write-Ahead Logging* (WAL), controle rigoroso de concorrência e backups locais automáticos para evitar corrupção do banco em desligamentos bruscos.
- **Sincronização Master/Slave:** No dia do campeonato, o aplicativo desktop na mesa é sempre o **Master** (fonte única da verdade), mantendo a nuvem isolada como réplica **Slave**.
- **Auto-Push com Retentativa Controlada:** Sincronização em segundo plano sem bloqueio e com retentativas controladas para que instabilidades na internet do local nunca travem a mesa.
- **Verificação Criptográfica SHA-256:** Cada pacote sincronizado passa por validação determinística de hash SHA-256 para bloquear envios truncados ou corrompidos.
- **Tratamento Defensivo e Auto-Recuperação (*Self-Healing*):** Tratamento de erros em todos os endpoints HTTP e canais **Socket.io**, com rotinas de auto-recuperação desenhadas para absorver erros humanos sem derrubar o evento.

### Watchdog Nativo em C# (`PainelPowerlifting.cs`)
Ao compilar e usar o painel desktop do Windows, o aplicativo roda sob um supervisor nativo que protege o processo do servidor:
- **Reinício Silencioso e Reidratação de Telas:** Detecta falhas ou travamentos e reinicia o `node.exe` de forma segura e silenciosa (~200ms), reidratando automaticamente as telas abertas no navegador sem perder dados nem corromper o banco.
- **Proteção contra Corrida na Porta 3000 (*Port 3000 Race*):** Evita colisões de porta durante a inicialização e reinícios rápidos.
- **Proteção contra Processos Duplicados e *Job Objects*:** Impede instâncias duplicadas via Mutex global do Windows e vincula o `node.exe` a um *Windows Job Object* para jamais deixar processos fantasmas presos em segundo plano.
- **Proteção contra Starvation do `.NET ServicePointManager`:** Ajusta limites de conexões simultâneas e TLS para que verificações de saúde do watchdog nunca congelem nem causem falsos reinícios.
- **Bloqueio de Suspensão do Windows:** Mantém o notebook ativo durante toda a competição e oferece liberação do Firewall do Windows em um clique.

---

## Conecte Sua Própria Nuvem (Self-Hosting)

O código-fonte **não possui URLs privadas nem chaves embutidas**. Clubes sem fins lucrativos e desenvolvedores que desejarem backups remotos, transmissão ao vivo ou inscrições web na própria infraestrutura podem conectar sua própria API e banco de dados.

👉 **Especificação Técnica Completa:** **[Guia de Sincronização e Hospedagem em Nuvem Própria (PT-BR)](docs/cloud_integration_guide_pt-BR.md)**  
*(Inclui as 7 travas de segurança, especificação do checksum canônico SHA-256, contrato de todas as rotas REST e script completo para SQL Server / Azure SQL.)*

---

## Pré-requisitos

- **Node.js (x64, v20 ou superior)** — [Baixar em nodejs.org](https://nodejs.org/)
- **Windows 10 (versão 17763.0+) ou Windows 11 (x64)** — 4 GB de RAM mínimo (8 GB recomendado)
- **.NET Framework 4.x** (já incluso no Windows) para compilar o `PainelPowerlifting.cs`
- **C++ Build Tools** (apenas caso o `better-sqlite3` precise compilar o módulo nativo para sua versão do Node.js)

---

## Como Compilar e Executar a partir do Código-Fonte

### 1. Clonar e Instalar Dependências

```powershell
git clone [https://github.com/lucashnsoares/gestaodetorneios-brasilpowerlifting](https://github.com/lucashnsoares/gestaodetorneios-brasilpowerlifting)
cd brasilpowerlifting
npm install
```

### 2. Escolher o Modo de Execução

#### Opção A: Execução Rápida via Terminal (Windows, Linux ou macOS)
```bash
npm start
```
Acesse `http://localhost:3000` no navegador.

#### Opção B: Compilar o Painel Desktop do Windows (`PainelPowerlifting.exe`)
Compilar o supervisor C# ativa o painel de controle, reinício automático silencioso, detecção de IP Wi-Fi, bloqueio de suspensão e liberação do Firewall em um clique.

1. **Compile o `PainelPowerlifting.cs` (x64)** usando o compilador nativo do .NET no Windows:

   ```powershell
   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /platform:x64 /optimize+ /out:PainelPowerlifting.exe /win32icon:icone_power.ico PainelPowerlifting.cs
   ```

2. **Copie o `node.exe` para a pasta raiz do projeto:**  
   O `PainelPowerlifting.exe` executa o `node.exe` localizado na mesma pasta do `server.js`:

   ```powershell
   Copy-Item (Get-Command node).Source .\node.exe
   ```

3. **Execute o aplicativo:**  
   Abra o `PainelPowerlifting.exe`. O servidor iniciará na porta `3000` e abrirá automaticamente `http://localhost:3000`.

---

## Rede Local (Wi-Fi) e Backups Locais

1. Conecte o computador da mesa, celulares dos árbitros e Smart TVs ao mesmo roteador Wi-Fi.
2. Clique em **Liberar Firewall (Wi-Fi)** no `PainelPowerlifting.exe` (ou libere manualmente a porta TCP `3000` de entrada no Firewall do Windows caso use a Opção A).
3. Acesse os links LAN ou leia os QR Codes gerados no painel inicial (`/arbitro`, `/display`, `/aquecimento`, `/pesagem`).
4. O banco SQLite e os backups automáticos ficam salvos em `%LOCALAPPDATA%\BrasilPowerlifting`.

---

## Documentação e Contato

- **Manual Oficial:** [brasilpowerlifting.com.br/manual](https://brasilpowerlifting.com.br/manual)
- **Guia de Nuvem Própria:** [docs/cloud_integration_guide_pt-BR.md](docs/cloud_integration_guide_pt-BR.md)
- **Contato:** contato@brasilpowerlifting.com.br

---

## Licença (Código Disponível — Uso Não Comercial)

Este projeto é distribuído sob a licença **[PolyForm Noncommercial License 1.0.0](LICENSE.md)**.

- **Uso gratuito permitido:** Uso pessoal, campeonatos amadores, eventos beneficentes e clubes universitários ou sem fins lucrativos (incluindo cobrança de taxa de inscrição exclusivamente para custear a estrutura do evento).
- **Uso comercial:** Federações e promotores de eventos com fins lucrativos devem adquirir entrando em contato pelo site **[brasilpowerlifting.com.br](https://brasilpowerlifting.com.br)**.

## Notas do developer

Além de uma simples página de senha eu coloquei uma trava de seguranças nas rotas do servidor que impedem que dispositivos não autenticados consigam alterar dados do banco mesmo se eles conseguirem adivinhar as rotas ou algo do tipo, nunca se sabe.
Quando as páginas emitem avisos eu percebi que isso congela os socket.ios. Pelos meus testes isso não gerou nenhuma problema, mas é algo que eu gostaria de mudar no futuro.
Eu coloquei bastante redundância no sistema com error handling e auto-curas. No caso de unhandled exception eu também tomei cuidado pra garantir que o servidor consiga reiniciar sem interferir na mesa (admin.html), porém eu não apliquei as mesmas proteções para as outras páginas, então se um unhandled exception acontecer durante um cadastro de pesagem pode haver a perda do cadastro, mas eu não espero que haja problema de inconsistência devido as proteções no server.js.

Obrigado por se interessar pelo projeto.