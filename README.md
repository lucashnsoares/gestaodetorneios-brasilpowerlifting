[🇺🇸 English](README.md) | [🇧🇷 Português](README.pt-BR.md)

# Brasil Powerlifting Meet Management System (*Gestão de Torneios Brasil Powerlifting*)

A fast, **100% offline-first** powerlifting competition management and real-time LAN scoreboard system engineered to survive venue Wi-Fi dropouts, crashes, and meet-day unpredictability. Available in **English (US)** and **Portuguese (PT-BR)**.

> **Want a ready-to-run Windows app without compiling?**  
> Download the signed, auto-updating Windows version on the **[Microsoft Store ($9.99 / Free Trial)](https://apps.microsoft.com/detail/9n79d1086g2w)** or read the **[Official Manual](https://brasilpowerlifting.com.br/manual)**.

---

## Built for Total Ruleset Flexibility

Whether you are running a strict sanctioned meet or a grassroots gym lift-off, the software adapts to **any powerlifting ruleset—no matter how custom or loose**:

- **All Meet Formats:** Full Power, Push-Pull, Bench Only, Deadlift Only, and Squat Only.
- **Doubling Age Divisions Without Duplicating Lifters:** Enter a single lifter into multiple age divisions simultaneously (e.g., *Junior* + *Open* or *Master* + *Open*) without creating duplicate athlete records or splitting their attempts.
- **100% Customizable Categories:** Define your own weight classes, equipment divisions (Raw, Wraps, Equipped, custom), and age divisions.
- **Multi-Platform Support:** Run **1 to 5 simultaneous platforms** from a single server.
- **Zero-Lock Escape Hatch (*Spreadsheet Mode / Modo Planilha*):** Directly edit attempts, weights, or flights without queue locks whenever real-world meet chaos requires an instant manual override.

---

## Key Competition Features

- **Scorer's Table Console (`/admin`):** Live attempt control with an **automatic visual plate-loading calculator** (calibrated or standard plates).
- **Real-Time LAN Peripherals (Same Wi-Fi, Zero Internet):**
  - **Mobile Referee Panel (`/arbitro`):** Real-time white and red lights from referees' smartphones.
  - **Public Big Screen (`/display`) & Warm-Up Room Screen (`/aquecimento`):** Instant attempt order, rack heights, and timer updates on Smart TVs or projectors.
  - **Offline QR Code Generator:** Automatically generates PNG QR codes and printable A4 posters so referees and staff connect to the local server in seconds.
- **Official Weigh-In (`/pesagem`):** Manage bodyweight, openers (first attempts), rack/safety heights, and automatic weight-class change suggestions.
- **Smart Flights & Tie-Breakers:** Automatic flight assignments, manual drag/reassignment controls, and standalone flights for **Record Attempts** or **Tie-Breakers**.
- **Automated Results & Rankings (`/resultados`):** Instant standings with **DOTS** and **Wilks** Best Lifter scoring.
- **Offline Excel & JSON Import:** Import lifter rosters directly from Excel or `.json` files so you can keep your existing registration forms without typing lifters one by one—even completely offline.
- **Real-time backup export to USB flash drive / external hard drive:** Automatically export backups during competitions.
- **Optional password for tournament settings pages:** Lets you connect the computer to a shared Wi-Fi network without unauthorized users being able to access the pages.
- **Optional Cloud Hub (`/nuvem`):** Remote backups, 20-snapshot disaster recovery Vault, online registration downloads, live web broadcasts, and livestream overlays (using either [brasilpowerlifting.com.br](https://brasilpowerlifting.com.br) or your own self-hosted cloud).

---

## Meet-Day Resilience & Crash-Only Architecture

Amateur and local competitions are unpredictable—laptops freeze, cables get kicked, and operators make mistakes. Every layer of this system is engineered to prevent data corruption and keep the platform moving:

### Database & Synchronization Integrity
- **SQLite WAL Mode & Auto-Save:** Runs SQLite in Write-Ahead Logging (WAL) mode with strict concurrency control and automatic local backups to eliminate database corruption during sudden power loss.
- **Master/Slave Cloud Architecture:** On competition day, the offline desktop machine at the scorer's table is always the **Master** source of truth; the cloud operates strictly as a **Slave** replica.
- **Auto-Push with Controlled Retry:** Non-blocking background cloud synchronization with controlled retries so unstable venue internet never freezes the scorer's table.
- **SHA-256 Cryptographic Verification:** Every synchronized tournament package is verified with a deterministic canonical SHA-256 checksum to reject truncated or corrupted payloads.
- **Defensive Endpoints & Self-Healing State:** Full error handling across all HTTP endpoints and **Socket.io** channels, combined with self-healing routines built to absorb human input errors without crashing the event.

### Native C# Watchdog (`PainelPowerlifting.cs`)
Running the compiled Windows desktop launcher activates a native supervisor wrapper around Node.js:
- **Silent Crash Recovery & State Rehydration:** Monitors server health and automatically restarts `node.exe` in the background (~200ms recovery) if a crash or freeze occurs, silently rehydrating open browser screens from SQLite with zero lost attempts or data corruption.
- **Port 3000 Race Protection:** Prevents startup and rapid-restart port collisions on TCP port `3000`.
- **Duplicate Process Protection & Windows Job Objects:** Uses a global Windows Mutex and active-process checks to block duplicate server instances on launch or restart, and binds `node.exe` to a Windows Job Object so ghost processes are never left behind.
- **`.NET ServicePointManager` Starvation Protection:** Raises connection limits and configures TLS cleanly so watchdog health probes never stall or trigger false restarts.
- **Sleep & Hibernation Lock:** Prevents Windows from putting the host laptop to sleep during the meet and offers one-click Windows Firewall configuration for Wi-Fi/LAN access.

---

## Bring Your Own Cloud (Self-Hosting)

The source code contains **no hardcoded private API URLs or secrets**. Non-commercial clubs and developers who want cloud backups, live web broadcasts, or online registrations on their own infrastructure can plug in a custom backend.

👉 **Full Technical Specification:** **[Cloud Synchronization & Self-Hosting Guide (English)](docs/cloud_integration_guide_en.md)**  
*(Covers the 7 architectural safety mechanisms, canonical SHA-256 checksum code, REST API contracts, and complete SQL Server / Azure SQL setup script.)*

---

## Prerequisites

- **Node.js (x64, v20 or newer)** — [Download from nodejs.org](https://nodejs.org/)
- **Windows 10 (build 17763.0+) or Windows 11 (x64)** — 4 GB RAM minimum (8 GB recommended)
- **.NET Framework 4.x** (pre-installed on Windows) to compile `PainelPowerlifting.cs`
- **C++ Build Tools** (only if `better-sqlite3` requires compiling a native module for your Node.js version)

---

## Building & Running from Source

### 1. Clone and Install Dependencies

```powershell
git clone [https://github.com/lucashnsoares/gestaodetorneios-brasilpowerlifting](https://github.com/lucashnsoares/gestaodetorneios-brasilpowerlifting)
cd brasilpowerlifting
npm install
```

### 2. Choose How to Run

#### Option A: Quick Start via CLI (Windows, macOS, or Linux)
Run the server directly without the Windows desktop wrapper:

```bash
npm start
```

Open `http://localhost:3000` in your browser.

#### Option B: Build the Full Windows Desktop App (`PainelPowerlifting.exe`)
Compiling the C# watchdog gives you the desktop control panel, silent crash recovery, Wi-Fi IP detection, sleep prevention, and one-click Firewall setup.

1. **Compile `PainelPowerlifting.cs` (x64)** using the built-in Windows .NET compiler:

   ```powershell
   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /platform:x64 /optimize+ /out:PainelPowerlifting.exe /win32icon:icone_power.ico PainelPowerlifting.cs
   ```

2. **Copy `node.exe` into the project root folder:**  
   `PainelPowerlifting.exe` launches `node.exe` directly from the same folder as `server.js`:

   ```powershell
   Copy-Item (Get-Command node).Source .\node.exe
   ```

3. **Launch the app:**  
   Double-click `PainelPowerlifting.exe`. It starts the local server on port `3000` and automatically opens `http://localhost:3000`.

---

## Wi-Fi / LAN Setup & Local Backups

1. Connect the host PC, referees' phones, and Smart TVs to the same local Wi-Fi router.
2. Click **Allow Firewall (Wi-Fi)** in `PainelPowerlifting.exe` (or allow inbound TCP port `3000` manually in Windows Defender Firewall if using Option A).
3. Open the LAN URLs or scan the generated QR codes from the home dashboard (`/arbitro`, `/display`, `/aquecimento`, `/pesagem`).
4. Local SQLite databases and automatic backups are stored in `%LOCALAPPDATA%\BrasilPowerlifting`.

---

## Documentation & Support

- **Official User Manual:** [brasilpowerlifting.com.br/manual](https://brasilpowerlifting.com.br/manual)
- **Self-Hosting Cloud Guide:** [docs/cloud_integration_guide_en.md](docs/cloud_integration_guide_en.md)
- **Contact:** contato@brasilpowerlifting.com.br

---

## License (Source-Available — Noncommercial)

This project is licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE.md)**.

- **Free to compile, modify, and use:** Personal use, amateur competitions, charity lift-offs, and university or non-profit powerlifting clubs—including local meets that charge entry fees solely to cover venue, equipment, and event costs.
- **Commercial license required:** For-profit event promoters, commercial organizations, and sanctioned federations must purchase a license by contacting us at **[brasilpowerlifting.com.br](https://brasilpowerlifting.com.br)**.

## Notes from the developer

Beyond a simple password page, I added a security lock on the server routes that prevents unauthenticated devices from modifying database data, even if they manage to guess the routes or something like that, you never know.
When pages trigger alerts, I noticed that it freezes the Socket.IO connections. Based on my tests, this hasn't caused any issues, but it's something I'd like to change in the future.
I built a lot of redundancy into the system using error handling and self-healing mechanisms. In the case of an unhandled exception, I also took care to ensure the server can restart without interfering with the scoring table (admin.html). However, I didn't apply the same protections to the other pages, so if an unhandled exception occurs during a weigh-in registration, that entry might be lost. Though I don't expect any data inconsistency issues thanks to the safeguards in server.js.

Thanks for taking an interest in the project.