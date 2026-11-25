using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Gestão de Torneios Brasil Powerlifting")]
[assembly: AssemblyDescription("Gerenciador de Servidor Local Powerlifting")]
[assembly: AssemblyCompany("Hiroshi Tecnologia")]
[assembly: AssemblyProduct("Gestão de Torneios Brasil Powerlifting")]
[assembly: AssemblyVersion("1.3.2.0")]
[assembly: AssemblyFileVersion("1.3.2.0")]

namespace PowerliftingLauncher
{
    public class MainForm : Form
    {
        // APIs nativas do Windows para impedir Sleep/Hibernação enquanto a janela estiver aberta
        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern uint SetThreadExecutionState(uint esFlags);
        private const uint ES_CONTINUOUS = 0x80000000;
        private const uint ES_SYSTEM_REQUIRED = 0x00000001;
        private const uint ES_DISPLAY_REQUIRED = 0x00000002;

        // API nativa do Windows para detetar se está a correr dentro de um pacote MSIX da Microsoft Store
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetCurrentPackageFamilyName(ref uint packageFamilyNameLength, StringBuilder packageFamilyName);

        // Job Object do Windows: garante que nunca fique um node.exe fantasma a bloquear a porta 3000
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll")]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        private Process nodeProcess;
        private IntPtr jobHandle = IntPtr.Zero;
        private bool encerrandoIntencionalmente = false;
        private bool navegadorJaAberto = false;
        private bool nuvemConectada = false;
        private bool usuarioInteragiu = false;
        private DateTime instanteInicializacao = DateTime.UtcNow;
        private string pastaApp;
        private string pastaDadosGravavel;
        private string ipPrincipalLan = "localhost";

        private string idiomaAtual = "pt";
        private bool servidorOnline = false;
        private bool erroCriticoArquivos = false;

        private Panel panelStatus;
        private Label lblStatus;
        private Button btnIdioma;
        private Panel badgeAvisoNuvem;
        private Label lblAvisoNuvem;
        private PictureBox picIconeNuvem;
        private ToolTip toolTipNuvem;
        private Label lblAvisoLicenca;
        private Label lblSubStatus;
        private Button btnAbrirInicio;
        private Button btnMesa;
        private Button btnTelao;
        private Button btnAquecimento;
        private Button btnPesagem;
        private Button btnResultados;
        private Button btnNuvem;
        private GroupBox grpRede;
        private Button btnCopiarArbitro;
        private Button btnFirewall;
        private Button btnAtualizarIp;
        private Button btnPastaBackups;
        private Button btnMinimizar;
        private Button btnDesligar;
        private GroupBox grpLogs;
        private TextBox txtLinksRede;
        private TextBox txtLogs;
        private List<string> bufferLogs = new List<string>();
        private System.Windows.Forms.Timer timerHealth;
        private int falhasConsecutivasHealth = 0;
        private int verificandoSaudeEmAndamento = 0;
        private DateTime ultimoInicioNodeUtc = DateTime.UtcNow;
        private DateTime ultimaVerificacaoNuvemUtc = DateTime.MinValue;
        private Queue<DateTime> historicoReinicios = new Queue<DateTime>();

        public MainForm()
        {
            pastaApp = AppDomain.CurrentDomain.BaseDirectory;
            pastaDadosGravavel = ResolverPastaDadosGravavel();
            idiomaAtual = DetectarIdiomaSistema();
            SalvarIdiomaNoDisco();

            // Habilita TLS 1.2 e amplia o limite de conexões simultâneas do .NET (evita fila falsa no Watchdog)
            try
            {
                ServicePointManager.DefaultConnectionLimit = 32;
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | SecurityProtocolType.Tls;
            }
            catch { }

            InicializarJobObject();
            ConfigurarInterface();
            AplicarIdiomaInterface();

            // Impede que o Windows entre em modo de suspensão na tomada ou bateria
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        }

        // Detecta o idioma do Windows: usa Inglês ("en") somente se o sistema estiver explicitamente em Inglês; caso contrário usa Português ("pt")
        private string DetectarIdiomaSistema()
        {
            try
            {
                CultureInfo ci = CultureInfo.CurrentUICulture;
                if (ci != null && String.Equals(ci.TwoLetterISOLanguageName, "en", StringComparison.OrdinalIgnoreCase))
                {
                    return "en";
                }
            }
            catch { }
            return "pt";
        }

        private void SalvarIdiomaNoDisco()
        {
            try
            {
                string caminhoIdioma = Path.Combine(pastaDadosGravavel, "idioma.cfg");
                File.WriteAllText(caminhoIdioma, idiomaAtual, Encoding.UTF8);
            }
            catch { }
        }

        private void AlternarIdioma()
        {
            try
            {
                idiomaAtual = (idiomaAtual == "en") ? "pt" : "en";
                SalvarIdiomaNoDisco();
                AplicarIdiomaInterface();
                AtualizarIpsLocais();

                string idiomaParaEnviar = idiomaAtual;
                ThreadPool.QueueUserWorkItem(delegate {
                    try
                    {
                        byte[] bodyBytes = Encoding.UTF8.GetBytes("{\"idioma\":\"" + idiomaParaEnviar + "\"}");
                        HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/idioma");
                        req.Method = "POST";
                        req.ContentType = "application/json; charset=utf-8";
                        req.Timeout = 2000;
                        req.ContentLength = bodyBytes.Length;
                        using (Stream reqStream = req.GetRequestStream())
                        {
                            reqStream.Write(bodyBytes, 0, bodyBytes.Length);
                        }
                        using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) { }
                    }
                    catch { }
                });

                if (idiomaAtual == "en")
                    AdicionarLog("🌐 Language changed to English (EN). Any page opened or refreshed in the browser will now load in English.");
                else
                    AdicionarLog("🌐 Idioma alterado para Português (PT-BR). As páginas abertas ou atualizadas no navegador serão carregadas em Português.");
            }
            catch { }
        }

        // Resolve o caminho real de gravação (compatível com desinstalação limpa da Microsoft Store MSIX e Inno Setup)
        private string ResolverPastaDadosGravavel()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            try
            {
                uint length = 0;
                int res = GetCurrentPackageFamilyName(ref length, null);
                if (length > 0)
                {
                    StringBuilder sb = new StringBuilder((int)length);
                    if (GetCurrentPackageFamilyName(ref length, sb) == 0 && sb.Length > 0)
                    {
                        string pastaMsixLocalState = Path.Combine(localAppData, "Packages", sb.ToString(), "LocalState", "BrasilPowerlifting");
                        if (!Directory.Exists(pastaMsixLocalState))
                        {
                            Directory.CreateDirectory(pastaMsixLocalState);
                        }
                        return pastaMsixLocalState;
                    }
                }
            }
            catch { }

            string pastaPadrao = Path.Combine(localAppData, "BrasilPowerlifting");
            try
            {
                if (!Directory.Exists(pastaPadrao))
                {
                    Directory.CreateDirectory(pastaPadrao);
                }
            }
            catch { }
            return pastaPadrao;
        }

        private void InicializarJobObject()
        {
            try
            {
                jobHandle = CreateJobObject(IntPtr.Zero, null);
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr ptr = Marshal.AllocHGlobal(length);
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(jobHandle, 9, ptr, (uint)length);
                Marshal.FreeHGlobal(ptr);
            }
            catch { }
        }

        private void ConfigurarInterface()
        {
            this.Text = "Gestão de Torneios Brasil Powerlifting - Painel do Servidor";
            this.Size = new Size(800, 660);
            this.MinimumSize = new Size(760, 610);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(238, 242, 243);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            toolTipNuvem = new ToolTip();

            string caminhoIcone = Path.Combine(pastaApp, "icone_power.ico");
            if (File.Exists(caminhoIcone))
            {
                try { this.Icon = new Icon(caminhoIcone); } catch { }
            }

            // 1. Banner de Status Superior
            panelStatus = new Panel();
            panelStatus.Dock = DockStyle.Top;
            panelStatus.Height = 124;
            panelStatus.BackColor = Color.FromArgb(44, 62, 80);
            panelStatus.Padding = new Padding(18, 10, 18, 8);

            lblStatus = new Label();
            lblStatus.Text = "⏳ Iniciando Servidor Powerlifting...";
            lblStatus.ForeColor = Color.FromArgb(241, 196, 15);
            lblStatus.Font = new Font("Segoe UI", 13.5f, FontStyle.Bold);
            lblStatus.AutoSize = true;
            lblStatus.Location = new Point(18, 8);

            panelStatus.Width = this.ClientSize.Width;

            // Botão Seletor de Idioma (PT-BR / EN) no canto superior direito do banner
            btnIdioma = CriarBotao("🌐 PT-BR | EN", Color.FromArgb(243, 156, 18), 27);
            btnIdioma.Font = new Font("Segoe UI", 8.75f, FontStyle.Bold);
            btnIdioma.ForeColor = Color.FromArgb(30, 39, 46);
            btnIdioma.Size = new Size(165, 27);
            btnIdioma.Location = new Point(panelStatus.ClientSize.Width - 165 - 18, 6);
            btnIdioma.Click += delegate {
                usuarioInteragiu = true;
                AlternarIdioma();
            };

            // Faixa de Aviso da Central de Nuvem (Texto em Vermelho + Ícone Vetorial da Nuvem)
            badgeAvisoNuvem = new Panel();
            badgeAvisoNuvem.BackColor = Color.FromArgb(255, 248, 248);
            badgeAvisoNuvem.Location = new Point(18, 38);
            badgeAvisoNuvem.Size = new Size(panelStatus.ClientSize.Width - 36, 32);
            badgeAvisoNuvem.Cursor = Cursors.Hand;
            badgeAvisoNuvem.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/nuvem"); };

            lblAvisoNuvem = new Label();
            lblAvisoNuvem.Text = "O uso da Nuvem é opcional (100% funcional Offline). Para sincronizar ou baixar eventos, clique aqui.";
            lblAvisoNuvem.ForeColor = Color.FromArgb(204, 0, 0);
            lblAvisoNuvem.Font = new Font("Segoe UI", 9.25f, FontStyle.Bold);
            lblAvisoNuvem.AutoSize = true;
            lblAvisoNuvem.Location = new Point(10, 7);
            lblAvisoNuvem.Cursor = Cursors.Hand;
            lblAvisoNuvem.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/nuvem"); };

            picIconeNuvem = new PictureBox();
            picIconeNuvem.Size = new Size(36, 26);
            picIconeNuvem.BackColor = Color.Transparent;
            picIconeNuvem.Cursor = Cursors.Hand;
            picIconeNuvem.Paint += PicIconeNuvem_Paint;
            picIconeNuvem.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/nuvem"); };

            badgeAvisoNuvem.Controls.Add(lblAvisoNuvem);
            badgeAvisoNuvem.Controls.Add(picIconeNuvem);

            // Calcula a posição real após adicionar ao painel e garante que o botão de idioma e o ícone fiquem sempre visíveis
            Action posicionarIconeNuvem = delegate {
                if (panelStatus != null && panelStatus.ClientSize.Width > 300)
                {
                    if (badgeAvisoNuvem != null)
                    {
                        badgeAvisoNuvem.Width = panelStatus.ClientSize.Width - 36;
                    }
                    if (btnIdioma != null)
                    {
                        btnIdioma.Location = new Point(panelStatus.ClientSize.Width - btnIdioma.Width - 18, 6);
                        btnIdioma.BringToFront();
                    }
                }
                int posX = lblAvisoNuvem.Left + lblAvisoNuvem.PreferredWidth + 8;
                if (posX + picIconeNuvem.Width > badgeAvisoNuvem.ClientSize.Width - 6)
                {
                    posX = Math.Max(lblAvisoNuvem.Left + lblAvisoNuvem.PreferredWidth + 4, badgeAvisoNuvem.ClientSize.Width - picIconeNuvem.Width - 6);
                }
                picIconeNuvem.Location = new Point(posX, 3);
                picIconeNuvem.BringToFront();
            };

            lblAvisoNuvem.SizeChanged += delegate { posicionarIconeNuvem(); };
            panelStatus.Resize += delegate { posicionarIconeNuvem(); };
            this.Resize += delegate { posicionarIconeNuvem(); };
            posicionarIconeNuvem();

            lblAvisoLicenca = new Label();
            lblAvisoLicenca.Text = "Para baixar inscrições online ou disponibilizar os resultados pela web, configure a sua nuvem ou solicite uma licença gratuita em https://brasilpowerlifting.com.br";
            lblAvisoLicenca.ForeColor = Color.FromArgb(241, 196, 15);
            lblAvisoLicenca.Font = new Font("Segoe UI", 8.25f, FontStyle.Bold);
            lblAvisoLicenca.AutoSize = true;
            lblAvisoLicenca.Location = new Point(18, 75);
            lblAvisoLicenca.Cursor = Cursors.Hand;
            lblAvisoLicenca.Click += delegate { usuarioInteragiu = true; AbrirUrl("https://brasilpowerlifting.com.br"); };

            lblSubStatus = new Label();
            lblSubStatus.Text = "Mantenha esta janela aberta ou minimizada durante todo o campeonato.";
            lblSubStatus.ForeColor = Color.FromArgb(236, 240, 241);
            lblSubStatus.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lblSubStatus.AutoSize = true;
            lblSubStatus.Location = new Point(18, 96);

            panelStatus.Controls.Add(btnIdioma);
            panelStatus.Controls.Add(lblStatus);
            panelStatus.Controls.Add(badgeAvisoNuvem);
            panelStatus.Controls.Add(lblAvisoLicenca);
            panelStatus.Controls.Add(lblSubStatus);
            btnIdioma.BringToFront();

            // 2. Container Principal
            Panel container = new Panel();
            container.Dock = DockStyle.Fill;
            container.Padding = new Padding(18);

            // Botão Principal Grande
            btnAbrirInicio = CriarBotao("🌐 ABRIR PAINEL PRINCIPAL NO NAVEGADOR (Início)", Color.FromArgb(41, 128, 185), 48);
            btnAbrirInicio.Font = new Font("Segoe UI", 11.5f, FontStyle.Bold);
            btnAbrirInicio.Dock = DockStyle.Top;
            btnAbrirInicio.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000"); };

            // Grade de Atalhos Diretos
            TableLayoutPanel gridBotoes = new TableLayoutPanel();
            gridBotoes.Dock = DockStyle.Top;
            gridBotoes.Height = 96;
            gridBotoes.ColumnCount = 3;
            gridBotoes.RowCount = 2;
            gridBotoes.Padding = new Padding(0, 8, 0, 8);
            gridBotoes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33f));
            gridBotoes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33f));
            gridBotoes.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.34f));
            gridBotoes.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            gridBotoes.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));

            btnMesa = CriarBotao("🎛️ 5. Mesa de Controle", Color.FromArgb(52, 73, 94), 38);
            btnMesa.Dock = DockStyle.Fill;
            btnMesa.Margin = new Padding(0, 0, 6, 6);
            btnMesa.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/admin"); };

            btnTelao = CriarBotao("📺 6. Telão (Plateia)", Color.FromArgb(39, 174, 96), 38);
            btnTelao.Dock = DockStyle.Fill;
            btnTelao.Margin = new Padding(3, 0, 3, 6);
            btnTelao.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/display"); };

            btnAquecimento = CriarBotao("🔥 7. Aquecimento", Color.FromArgb(211, 84, 0), 38);
            btnAquecimento.Dock = DockStyle.Fill;
            btnAquecimento.Margin = new Padding(6, 0, 0, 6);
            btnAquecimento.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/aquecimento"); };

            btnPesagem = CriarBotao("⚖️ 4. Pesagem Oficial", Color.FromArgb(142, 68, 173), 38);
            btnPesagem.Dock = DockStyle.Fill;
            btnPesagem.Margin = new Padding(0, 0, 6, 0);
            btnPesagem.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/pesagem"); };

            btnResultados = CriarBotao("🏆 Resultados Oficiais", Color.FromArgb(192, 57, 43), 38);
            btnResultados.Dock = DockStyle.Fill;
            btnResultados.Margin = new Padding(3, 0, 3, 0);
            btnResultados.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/resultados"); };

            btnNuvem = CriarBotao("☁️ Central da Nuvem", Color.FromArgb(22, 160, 133), 38);
            btnNuvem.Dock = DockStyle.Fill;
            btnNuvem.Margin = new Padding(6, 0, 0, 0);
            btnNuvem.Click += delegate { usuarioInteragiu = true; AbrirUrl("http://localhost:3000/nuvem"); };

            gridBotoes.Controls.Add(btnMesa, 0, 0);
            gridBotoes.Controls.Add(btnTelao, 1, 0);
            gridBotoes.Controls.Add(btnAquecimento, 2, 0);
            gridBotoes.Controls.Add(btnPesagem, 0, 1);
            gridBotoes.Controls.Add(btnResultados, 1, 1);
            gridBotoes.Controls.Add(btnNuvem, 2, 1);

            // Caixa de Links Wi-Fi (LAN)
            grpRede = new GroupBox();
            grpRede.Text = "📱 Endereços para Telemóveis dos Árbitros e Smart TVs (Mesmo Wi-Fi)";
            grpRede.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            grpRede.ForeColor = Color.FromArgb(44, 62, 80);
            grpRede.Dock = DockStyle.Top;
            grpRede.Height = 122;
            grpRede.Padding = new Padding(10);

            txtLinksRede = new TextBox();
            txtLinksRede.Multiline = true;
            txtLinksRede.ReadOnly = true;
            txtLinksRede.BackColor = Color.White;
            txtLinksRede.ForeColor = Color.FromArgb(44, 62, 80);
            txtLinksRede.Font = new Font("Consolas", 10f, FontStyle.Bold);
            txtLinksRede.BorderStyle = BorderStyle.FixedSingle;
            txtLinksRede.Dock = DockStyle.Fill;

            Panel painelBotoesRede = new Panel();
            painelBotoesRede.Dock = DockStyle.Right;
            painelBotoesRede.Width = 205;
            painelBotoesRede.Padding = new Padding(8, 0, 0, 0);

            btnCopiarArbitro = CriarBotao("📋 Copiar Link Árbitros", Color.FromArgb(22, 160, 133), 30);
            btnCopiarArbitro.Dock = DockStyle.Top;
            btnCopiarArbitro.Click += delegate {
                usuarioInteragiu = true;
                try
                {
                    string link = String.Format("http://{0}:3000/arbitro", ipPrincipalLan);
                    Clipboard.SetText(link);
                    if (idiomaAtual == "en")
                        MessageBox.Show("Link copied to clipboard:\n\n" + link, "Link Copied", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    else
                        MessageBox.Show("Link copiado para a área de transferência:\n\n" + link, "Link Copiado", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch { }
            };

            btnFirewall = CriarBotao("🛡️ Liberar Firewall (Wi-Fi)", Color.FromArgb(211, 84, 0), 30);
            btnFirewall.Dock = DockStyle.Top;
            btnFirewall.Click += delegate {
                usuarioInteragiu = true;
                ConfigurarFirewallWindowsUAC();
            };

            btnAtualizarIp = CriarBotao("🔄 Atualizar IP Wi-Fi", Color.FromArgb(127, 140, 141), 28);
            btnAtualizarIp.Dock = DockStyle.Bottom;
            btnAtualizarIp.Click += delegate {
                usuarioInteragiu = true;
                AtualizarIpsLocais();
            };

            painelBotoesRede.Controls.Add(btnFirewall);
            painelBotoesRede.Controls.Add(btnCopiarArbitro);
            painelBotoesRede.Controls.Add(btnAtualizarIp);

            grpRede.Controls.Add(txtLinksRede);
            grpRede.Controls.Add(painelBotoesRede);

            // Barra Inferior (Pasta de Backups + Minimizar + Desligar com Segurança)
            Panel painelRodape = new Panel();
            painelRodape.Dock = DockStyle.Bottom;
            painelRodape.Height = 46;
            painelRodape.Padding = new Padding(0, 8, 0, 0);

            btnPastaBackups = CriarBotao("📂 Abrir Pasta de Backups Locais", Color.FromArgb(52, 73, 94), 38);
            btnPastaBackups.Width = 250;
            btnPastaBackups.Dock = DockStyle.Left;
            btnPastaBackups.Click += delegate {
                usuarioInteragiu = true;
                try
                {
                    string pastaBkp = Path.Combine(pastaDadosGravavel, "backups");
                    if (!Directory.Exists(pastaBkp)) Directory.CreateDirectory(pastaBkp);
                    Process.Start("explorer.exe", "\"" + pastaBkp + "\"");
                }
                catch (Exception ex)
                {
                    if (idiomaAtual == "en")
                        MessageBox.Show("Backups path:\n" + Path.Combine(pastaDadosGravavel, "backups") + "\n\nError opening folder: " + ex.Message);
                    else
                        MessageBox.Show("Caminho dos backups:\n" + Path.Combine(pastaDadosGravavel, "backups") + "\n\nErro ao abrir janela: " + ex.Message);
                }
            };

            btnMinimizar = CriarBotao("➖ Minimizar Janela", Color.FromArgb(127, 140, 141), 38);
            btnMinimizar.Width = 175;
            btnMinimizar.Dock = DockStyle.Left;
            btnMinimizar.Click += delegate {
                usuarioInteragiu = true;
                this.WindowState = FormWindowState.Minimized;
            };

            btnDesligar = CriarBotao("🛑 Encerrar Servidor com Segurança", Color.FromArgb(192, 57, 43), 38);
            btnDesligar.Width = 270;
            btnDesligar.Dock = DockStyle.Right;
            btnDesligar.Click += delegate {
                usuarioInteragiu = true;
                ConfirmarEEncerrarServidor();
            };

            painelRodape.Controls.Add(btnMinimizar);
            painelRodape.Controls.Add(btnPastaBackups);
            painelRodape.Controls.Add(btnDesligar);

            // Caixa de Logs do Servidor
            grpLogs = new GroupBox();
            grpLogs.Text = "🖥️ Registo de Atividades do Servidor (Tempo Real)";
            grpLogs.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            grpLogs.ForeColor = Color.FromArgb(44, 62, 80);
            grpLogs.Dock = DockStyle.Fill;
            grpLogs.Padding = new Padding(10);

            txtLogs = new TextBox();
            txtLogs.Multiline = true;
            txtLogs.ReadOnly = true;
            txtLogs.ScrollBars = ScrollBars.Vertical;
            txtLogs.BackColor = Color.FromArgb(30, 39, 46);
            txtLogs.ForeColor = Color.FromArgb(210, 218, 226);
            txtLogs.Font = new Font("Consolas", 9.5f, FontStyle.Regular);
            txtLogs.Dock = DockStyle.Fill;
            grpLogs.Controls.Add(txtLogs);

            // Ordem de adição para Dock correto no Windows Forms
            container.Controls.Add(grpLogs);
            container.Controls.Add(painelRodape);
            container.Controls.Add(grpRede);
            container.Controls.Add(gridBotoes);
            container.Controls.Add(btnAbrirInicio);

            this.Controls.Add(container);
            this.Controls.Add(panelStatus);

            AtualizarTooltipNuvem();
            this.Load += MainForm_Load;
        }

        // Libera a porta TCP 3000 e o node.exe em todos os perfis (Público, Privado e Domínio) via UAC
        private void ConfigurarFirewallWindowsUAC()
        {
            try
            {
                string nodeExe = Path.Combine(pastaApp, "node.exe");
                string cmdArgs = String.Format(
                    "/c netsh advfirewall firewall delete rule name=\"Powerlifting Server TCP 3000\" >nul 2>&1 & " +
                    "netsh advfirewall firewall delete rule name=\"Powerlifting Server Node\" >nul 2>&1 & " +
                    "netsh advfirewall firewall add rule name=\"Powerlifting Server TCP 3000\" dir=in action=allow protocol=TCP localport=3000 profile=any enable=yes & " +
                    "netsh advfirewall firewall add rule name=\"Powerlifting Server Node\" dir=in action=allow program=\"{0}\" profile=any enable=yes",
                    nodeExe
                );

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "cmd.exe";
                psi.Arguments = cmdArgs;
                psi.Verb = "runas";
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.UseShellExecute = true;

                Process proc = Process.Start(psi);
                if (proc != null) proc.WaitForExit(8000);

                if (idiomaAtual == "en")
                {
                    AdicionarLog("🛡️ Windows Firewall configured successfully (TCP Port 3000 allowed for Wi-Fi/LAN).");
                    MessageBox.Show(
                        "✅ Windows Firewall configured successfully!\n\n" +
                        "Referees' phones and Smart TVs on the same Wi-Fi network can now access the server on port 3000.",
                        "Firewall Allowed",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
                else
                {
                    AdicionarLog("🛡️ Firewall do Windows configurado com sucesso (Porta TCP 3000 liberada para Wi-Fi/LAN).");
                    MessageBox.Show(
                        "✅ Firewall do Windows configurado com sucesso!\n\n" +
                        "Os telemóveis dos árbitros e as Smart TVs na mesma rede Wi-Fi já podem aceder ao servidor na porta 3000.",
                        "Firewall Liberado",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
            }
            catch (Exception ex)
            {
                AdicionarLog((idiomaAtual == "en" ? "⚠️ Firewall configuration warning: " : "⚠️ Aviso ao configurar Firewall: ") + ex.Message);
            }
        }

        private void AplicarIdiomaInterface()
        {
            try
            {
                bool en = (idiomaAtual == "en");

                this.Text = en
                    ? "Brasil Powerlifting Tournament Management - Server Panel"
                    : "Gestão de Torneios Brasil Powerlifting - Painel do Servidor";

                if (btnIdioma != null)
                {
                    btnIdioma.Text = en ? "🌐 Language: EN (PT)" : "🌐 Idioma: PT-BR (EN)";
                    if (toolTipNuvem != null)
                    {
                        toolTipNuvem.SetToolTip(btnIdioma, en
                            ? "Click to switch the application and browser pages to Portuguese (PT-BR)"
                            : "Clique para alternar o aplicativo e as páginas do navegador para Inglês (EN)");
                    }
                }

                if (lblStatus != null)
                {
                    if (erroCriticoArquivos)
                        lblStatus.Text = en ? "❌ Error: Server files missing" : "❌ Erro: Ficheiros do servidor ausentes";
                    else if (servidorOnline)
                        lblStatus.Text = en ? "🟢 SERVER ACTIVE AND READY (PORT 3000)" : "🟢 SERVIDOR ATIVO E PRONTO (PORTA 3000)";
                    else
                        lblStatus.Text = en ? "⏳ Starting Powerlifting Server..." : "⏳ Iniciando Servidor Powerlifting...";
                }

                if (lblAvisoNuvem != null)
                    lblAvisoNuvem.Text = en
                        ? "Cloud usage is optional (100% functional Offline). To sync or download events, click here."
                        : "O uso da Nuvem é opcional (100% funcional Offline). Para sincronizar ou baixar eventos, clique aqui.";

                if (lblAvisoLicenca != null)
                    lblAvisoLicenca.Text = en
                        ? "To download online registrations or publish results on the web, configure your cloud or request a free license at https://brasilpowerlifting.com.br"
                        : "Para baixar inscrições online ou disponibilizar os resultados pela web, configure a sua nuvem ou solicite uma licença gratuita em https://brasilpowerlifting.com.br";

                if (lblSubStatus != null)
                    lblSubStatus.Text = en
                        ? "Keep this window open or minimized throughout the entire competition."
                        : "Mantenha esta janela aberta ou minimizada durante todo o campeonato.";

                if (btnAbrirInicio != null)
                    btnAbrirInicio.Text = en
                        ? "🌐 OPEN MAIN DASHBOARD IN BROWSER (Home)"
                        : "🌐 ABRIR PAINEL PRINCIPAL NO NAVEGADOR (Início)";

                if (btnMesa != null) btnMesa.Text = en ? "🎛️ 5. Scorer's Table" : "🎛️ 5. Mesa de Controle";
                if (btnTelao != null) btnTelao.Text = en ? "📺 6. Big Screen (Audience)" : "📺 6. Telão (Plateia)";
                if (btnAquecimento != null) btnAquecimento.Text = en ? "🔥 7. Warm-up Room" : "🔥 7. Aquecimento";
                if (btnPesagem != null) btnPesagem.Text = en ? "⚖️ 4. Official Weigh-in" : "⚖️ 4. Pesagem Oficial";
                if (btnResultados != null) btnResultados.Text = en ? "🏆 Official Results" : "🏆 Resultados Oficiais";
                if (btnNuvem != null) btnNuvem.Text = en ? "☁️ Cloud Center" : "☁️ Central da Nuvem";

                if (grpRede != null)
                    grpRede.Text = en
                        ? "📱 Links for Referees' Phones and Smart TVs (Same Wi-Fi)"
                        : "📱 Endereços para Telemóveis dos Árbitros e Smart TVs (Mesmo Wi-Fi)";

                if (btnCopiarArbitro != null) btnCopiarArbitro.Text = en ? "📋 Copy Referee Link" : "📋 Copiar Link Árbitros";
                if (btnFirewall != null) btnFirewall.Text = en ? "🛡️ Allow Firewall (Wi-Fi)" : "🛡️ Liberar Firewall (Wi-Fi)";
                if (btnAtualizarIp != null) btnAtualizarIp.Text = en ? "🔄 Refresh Wi-Fi IP" : "🔄 Atualizar IP Wi-Fi";

                if (btnPastaBackups != null) btnPastaBackups.Text = en ? "📂 Open Local Backups Folder" : "📂 Abrir Pasta de Backups Locais";
                if (btnMinimizar != null) btnMinimizar.Text = en ? "➖ Minimize Window" : "➖ Minimizar Janela";
                if (btnDesligar != null) btnDesligar.Text = en ? "🛑 Safely Shut Down Server" : "🛑 Encerrar Servidor com Segurança";

                if (grpLogs != null)
                    grpLogs.Text = en
                        ? "🖥️ Server Activity Log (Real-Time)"
                        : "🖥️ Registo de Atividades do Servidor (Tempo Real)";

                AtualizarTooltipNuvem();
            }
            catch { }
        }

        // Desenha o ícone vetorial da Nuvem (Conectada vs Offline/Local)
        private void PicIconeNuvem_Paint(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            Color corBorda = nuvemConectada ? Color.FromArgb(41, 128, 185) : Color.FromArgb(211, 47, 47);
            Color corPreenchimento = nuvemConectada ? Color.FromArgb(214, 234, 248) : Color.FromArgb(250, 219, 216);

            using (SolidBrush bBorda = new SolidBrush(corBorda))
            {
                g.FillEllipse(bBorda, 2, 9, 14, 13);
                g.FillEllipse(bBorda, 7, 3, 16, 15);
                g.FillEllipse(bBorda, 16, 5, 14, 14);
                g.FillEllipse(bBorda, 20, 9, 13, 13);
                g.FillRectangle(bBorda, 8, 12, 19, 10);
            }

            using (SolidBrush bInterno = new SolidBrush(corPreenchimento))
            {
                g.FillEllipse(bInterno, 4, 11, 10, 9);
                g.FillEllipse(bInterno, 9, 5, 12, 11);
                g.FillEllipse(bInterno, 18, 7, 10, 10);
                g.FillEllipse(bInterno, 22, 11, 9, 9);
                g.FillRectangle(bInterno, 9, 13, 17, 7);
            }

            if (nuvemConectada)
            {
                using (Pen penCheck = new Pen(Color.FromArgb(31, 97, 141), 2.2f))
                {
                    penCheck.StartCap = LineCap.Round;
                    penCheck.EndCap = LineCap.Round;
                    g.DrawLine(penCheck, 13, 14, 16, 17);
                    g.DrawLine(penCheck, 16, 17, 22, 11);
                }
            }
            else
            {
                using (Pen penHalo = new Pen(Color.FromArgb(255, 248, 248), 4.5f))
                {
                    penHalo.StartCap = LineCap.Round;
                    penHalo.EndCap = LineCap.Round;
                    g.DrawLine(penHalo, 5, 2, 30, 24);
                }
                using (Pen penCorte = new Pen(Color.FromArgb(204, 0, 0), 2.6f))
                {
                    penCorte.StartCap = LineCap.Round;
                    penCorte.EndCap = LineCap.Round;
                    g.DrawLine(penCorte, 5, 2, 30, 24);
                }
            }
        }

        private void AtualizarTooltipNuvem()
        {
            if (toolTipNuvem == null || picIconeNuvem == null) return;
            string msg;
            if (idiomaAtual == "en")
            {
                msg = nuvemConectada
                    ? "Cloud Connected and Active (Click to open Cloud Center)"
                    : "Local Offline Mode Active / No Cloud Account Configured (Click to open Cloud Center)";
            }
            else
            {
                msg = nuvemConectada
                    ? "Nuvem Conectada e Ativa (Clique para abrir a Central da Nuvem)"
                    : "Modo Offline Local Ativo / Sem Conta de Nuvem Configurada (Clique para abrir a Central da Nuvem)";
            }
            toolTipNuvem.SetToolTip(picIconeNuvem, msg);
            toolTipNuvem.SetToolTip(lblAvisoNuvem, msg);
            toolTipNuvem.SetToolTip(badgeAvisoNuvem, msg);
        }

        private Button CriarBotao(string texto, Color corFundo, int altura)
        {
            Button btn = new Button();
            btn.Text = texto;
            btn.BackColor = corFundo;
            btn.ForeColor = Color.White;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderSize = 0;
            btn.Height = altura;
            btn.Cursor = Cursors.Hand;
            btn.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            return btn;
        }

        private void MainForm_Load(object sender, EventArgs e)
        {
            if (idiomaAtual == "en")
                AdicionarLog("📂 Safe data directory: " + pastaDadosGravavel);
            else
                AdicionarLog("📂 Diretório seguro de dados: " + pastaDadosGravavel);

            AtualizarIpsLocais();
            IniciarProcessoNode();

            timerHealth = new System.Windows.Forms.Timer();
            timerHealth.Interval = 2500;
            timerHealth.Tick += TimerHealth_Tick;
            timerHealth.Start();
        }

        private void AtualizarIpsLocais()
        {
            try
            {
                List<string> prioritarios = new List<string>();
                List<string> secundarios = new List<string>();
                string[] palavrasVirtuais = new string[] { "vethernet", "wsl", "virtualbox", "vmware", "vbox", "docker", "hyper-v", "hamachi", "radmin", "zerotier", "tailscale", "loopback", "tap-", "tun-" };

                NetworkInterface[] interfaces = NetworkInterface.GetAllNetworkInterfaces();
                foreach (NetworkInterface ni in interfaces)
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                    string nomeDesc = (ni.Name + " " + ni.Description).ToLowerInvariant();
                    bool ehVirtual = false;
                    foreach (string v in palavrasVirtuais)
                    {
                        if (nomeDesc.Contains(v)) { ehVirtual = true; break; }
                    }
                    if (ehVirtual) continue;

                    IPInterfaceProperties props = ni.GetIPProperties();
                    foreach (UnicastIPAddressInformation ip in props.UnicastAddresses)
                    {
                        if (ip.Address.AddressFamily == AddressFamily.InterNetwork)
                        {
                            string ipStr = ip.Address.ToString();
                            if (ipStr == "127.0.0.1" || ipStr.StartsWith("169.254.")) continue;

                            if (ni.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 || ni.NetworkInterfaceType == NetworkInterfaceType.Ethernet)
                                prioritarios.Add(ipStr);
                            else
                                secundarios.Add(ipStr);
                        }
                    }
                }

                List<string> todos = new List<string>();
                todos.AddRange(prioritarios);
                todos.AddRange(secundarios);

                if (todos.Count > 0)
                {
                    ipPrincipalLan = todos[0];
                    StringBuilder sb = new StringBuilder();
                    if (idiomaAtual == "en")
                    {
                        sb.AppendLine(String.Format("⚖️ Referees' Phones:       http://{0}:3000/arbitro", ipPrincipalLan));
                        sb.AppendLine(String.Format("📺 Big Screen Smart TV:    http://{0}:3000/display", ipPrincipalLan));
                        sb.AppendLine(String.Format("🔥 Warm-up Room TV:        http://{0}:3000/aquecimento", ipPrincipalLan));
                        sb.Append(String.Format("⚖️ Scale / Weigh-in:       http://{0}:3000/pesagem", ipPrincipalLan));
                    }
                    else
                    {
                        sb.AppendLine(String.Format("⚖️ Telemóvel dos Árbitros: http://{0}:3000/arbitro", ipPrincipalLan));
                        sb.AppendLine(String.Format("📺 Smart TV Telão:         http://{0}:3000/display", ipPrincipalLan));
                        sb.AppendLine(String.Format("🔥 TV Aquecimento:         http://{0}:3000/aquecimento", ipPrincipalLan));
                        sb.Append(String.Format("⚖️ Balança / Pesagem:      http://{0}:3000/pesagem", ipPrincipalLan));
                    }
                    txtLinksRede.Text = sb.ToString();
                }
                else
                {
                    ipPrincipalLan = "localhost";
                    txtLinksRede.Text = (idiomaAtual == "en")
                        ? "⚠️ Computer not connected to Wi-Fi/Network right now.\r\nConnect to the competition Wi-Fi router and click 'Refresh Wi-Fi IP'."
                        : "⚠️ Computador sem Wi-Fi/Rede conectada no momento.\r\nConecte ao roteador Wi-Fi do campeonato e clique em 'Atualizar IP Wi-Fi'.";
                }
            }
            catch (Exception ex)
            {
                txtLinksRede.Text = (idiomaAtual == "en" ? "Error detecting IP: " : "Erro ao detetar IP: ") + ex.Message;
            }
        }

        private void IniciarProcessoNode()
        {
            IniciarProcessoNode(false);
        }

        private void IniciarProcessoNode(bool reinicioRapido)
        {
            if (encerrandoIntencionalmente) return;

            // Garante que nunca seja criado um segundo node.exe se o atual ainda estiver vivo
            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited) return;
            }
            catch { }

            SalvarIdiomaNoDisco();

            // No reinício rápido pós-falha, pula o teste HTTP de 1.2s para subir o novo node.exe em < 200ms
            if (!reinicioRapido && VerificarSaudeServidor())
    {
        AtualizarStatusOnline();
        AdicionarLog(idiomaAtual == "en" ? "ℹ️ Server was already active on port 3000." : "ℹ️ Servidor já estava ativo na porta 3000.");
        if (!navegadorJaAberto)
        {
            navegadorJaAberto = true;
            AbrirUrl("http://localhost:3000");
        }
        return;
    }

            string nodePath = Path.Combine(pastaApp, "node.exe");
            string serverPath = Path.Combine(pastaApp, "server.js");

            if (!File.Exists(nodePath) || !File.Exists(serverPath))
            {
                erroCriticoArquivos = true;
                AdicionarLog((idiomaAtual == "en" ? "❌ CRITICAL ERROR: node.exe or server.js not found in folder " : "❌ ERRO CRÍTICO: node.exe ou server.js não encontrados na pasta ") + pastaApp);
                lblStatus.Text = (idiomaAtual == "en") ? "❌ Error: Server files missing" : "❌ Erro: Ficheiros do servidor ausentes";
                lblStatus.ForeColor = Color.FromArgb(231, 76, 60);
                return;
            }

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodePath;
                psi.Arguments = "\"" + serverPath + "\"";
                psi.WorkingDirectory = pastaApp;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                psi.EnvironmentVariables["NODE_SKIP_PLATFORM_CHECK"] = "1";
                psi.EnvironmentVariables["PORT"] = "3000";
                psi.EnvironmentVariables["POWERLIFTING_DATA_DIR"] = pastaDadosGravavel;
                psi.EnvironmentVariables["POWERLIFTING_LANG"] = idiomaAtual;

                nodeProcess = new Process();
                nodeProcess.StartInfo = psi;
                nodeProcess.EnableRaisingEvents = true;
                nodeProcess.OutputDataReceived += delegate(object s, DataReceivedEventArgs args) {
                    if (!String.IsNullOrEmpty(args.Data))
                    {
                        if (args.Data.Contains("[SHUTDOWN_INTENCIONAL]"))
                        {
                            encerrandoIntencionalmente = true;
                            if (!this.IsDisposed && this.IsHandleCreated)
                            {
                                try { this.BeginInvoke((MethodInvoker)delegate { Application.Exit(); }); } catch { }
                            }
                            return;
                        }
                        AdicionarLog(args.Data);
                    }
                };
                nodeProcess.ErrorDataReceived += delegate(object s, DataReceivedEventArgs args) {
                    if (!String.IsNullOrEmpty(args.Data)) AdicionarLog("[AVISO] " + args.Data);
                };
                nodeProcess.Exited += NodeProcess_Exited;

                nodeProcess.Start();
                ultimoInicioNodeUtc = DateTime.UtcNow;
                falhasConsecutivasHealth = 0;

                if (jobHandle != IntPtr.Zero)
                {
                    try { AssignProcessToJobObject(jobHandle, nodeProcess.Handle); } catch { }
                }

                nodeProcess.BeginOutputReadLine();
                nodeProcess.BeginErrorReadLine();
                AdicionarLog("▶️ Processo node.exe iniciado em segundo plano (PID: " + nodeProcess.Id + ").");
            }
            catch (Exception ex)
            {
                AdicionarLog("❌ Falha ao iniciar node.exe: " + ex.Message);
            }
        }

        private void NodeProcess_Exited(object sender, EventArgs e)
        {
            if (encerrandoIntencionalmente) return;

            servidorOnline = false;
            falhasConsecutivasHealth = 0;

            // Proteção anti-loop: reinicia em 200ms (imperceptível na Mesa), mas desacelera se houver 4 quedas em 15s
            int delayMs = 200;
            lock (historicoReinicios)
            {
                DateTime agora = DateTime.UtcNow;
                while (historicoReinicios.Count > 0 && (agora - historicoReinicios.Peek()).TotalSeconds > 15)
                {
                    historicoReinicios.Dequeue();
                }
                historicoReinicios.Enqueue(agora);
                if (historicoReinicios.Count > 4) delayMs = 2000;
            }

            AdicionarLog("🔄 Auto-recuperação: reiniciando motor do servidor em segundo plano...");
            Thread.Sleep(delayMs);

            if (!this.IsDisposed && this.IsHandleCreated && !encerrandoIntencionalmente)
            {
                this.BeginInvoke((MethodInvoker)delegate {
                    IniciarProcessoNode(true);
                });
            }
        }

        private void TimerHealth_Tick(object sender, EventArgs e)
        {
            if (encerrandoIntencionalmente) return;

            // Impede empilhamento de threads caso a rede ou disco estejam lentos
            if (Interlocked.CompareExchange(ref verificandoSaudeEmAndamento, 1, 0) != 0) return;

            ThreadPool.QueueUserWorkItem(delegate {
                try
                {
                    bool online = VerificarSaudeServidor();
                    if (online)
                    {
                        falhasConsecutivasHealth = 0;
                    }
                    else if (servidorOnline && (DateTime.UtcNow - ultimoInicioNodeUtc).TotalSeconds > 20)
                    {
                        falhasConsecutivasHealth++;
                        // Watchdog seguro: só atua após 20s do boot e 6 falhas reais seguidas (~18s de travamento total)
                        if (falhasConsecutivasHealth >= 6)
                        {
                            falhasConsecutivasHealth = 0;
                            try
                            {
                                if (nodeProcess != null && !nodeProcess.HasExited)
                                {
                                    AdicionarLog("⚠️ Watchdog: Servidor congelado por mais de 18s. Forçando reinício rápido...");
                                    nodeProcess.Kill();
                                }
                            }
                            catch { }
                        }
                    }

                    // Verifica a Nuvem a cada 15s (evita sobrecarregar conexões locais e Cloud Run a cada 2.5s)
                    bool cloudOk = nuvemConectada;
                    if (!online)
                    {
                        cloudOk = false;
                    }
                    else if ((DateTime.UtcNow - ultimaVerificacaoNuvemUtc).TotalSeconds >= 15)
                    {
                        ultimaVerificacaoNuvemUtc = DateTime.UtcNow;
                        cloudOk = VerificarConexaoNuvem();
                    }

                    if (!this.IsDisposed && this.IsHandleCreated && !encerrandoIntencionalmente)
                    {
                        this.BeginInvoke((MethodInvoker)delegate {
                            if (online)
                            {
                                AtualizarStatusOnline();
                                if (!navegadorJaAberto)
                                {
                                    navegadorJaAberto = true;
                                    AbrirUrl("http://localhost:3000");
                                }
                            }

                            if (nuvemConectada != cloudOk)
                            {
                                nuvemConectada = cloudOk;
                                AtualizarTooltipNuvem();
                                picIconeNuvem.Invalidate();
                            }
                        });
                    }
                }
                finally
                {
                    Interlocked.Exchange(ref verificandoSaudeEmAndamento, 0);
                }
            });
        }

        private void AtualizarStatusOnline()
        {
            servidorOnline = true;
            erroCriticoArquivos = false;
            panelStatus.BackColor = Color.FromArgb(22, 160, 133);
            lblStatus.Text = (idiomaAtual == "en")
                ? "🟢 SERVER ACTIVE AND READY (PORT 3000)"
                : "🟢 SERVIDOR ATIVO E PRONTO (PORTA 3000)";
            lblStatus.ForeColor = Color.White;
        }

        private bool VerificarSaudeServidor()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/health");
                req.Method = "GET";
                req.Timeout = 1200;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        // Verifica se a conta da Nuvem está configurada (organizador_id != LOCAL e cloud_token preenchido) e acessível
        private bool VerificarConexaoNuvem()
        {
            try
            {
                string orgIdConfigurado = "";
                string tokenConfigurado = "";
                string cloudUrlConfigurada = "";

                HttpWebRequest reqCfg = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/nuvem/config");
                reqCfg.Method = "GET";
                reqCfg.Timeout = 1200;
                using (HttpWebResponse resCfg = (HttpWebResponse)reqCfg.GetResponse())
                using (StreamReader sr = new StreamReader(resCfg.GetResponseStream(), Encoding.UTF8))
                {
                    string json = sr.ReadToEnd();
                    Match mOrg = Regex.Match(json, "\"organizador_id\"\\s*:\\s*\"([^\"]*)\"");
                    if (mOrg.Success) orgIdConfigurado = mOrg.Groups[1].Value.Trim();

                    Match mToken = Regex.Match(json, "\"cloud_token\"\\s*:\\s*\"([^\"]*)\"");
                    if (mToken.Success) tokenConfigurado = mToken.Groups[1].Value.Trim();

                    Match mUrl = Regex.Match(json, "\"cloud_url\"\\s*:\\s*\"([^\"]*)\"");
                    if (mUrl.Success) cloudUrlConfigurada = mUrl.Groups[1].Value.Trim();
                }

                // Se estiver em modo LOCAL ou sem token, o app está no modo 100% Offline (não exibe falso ícone verde de nuvem)
                if (String.IsNullOrEmpty(orgIdConfigurado) ||
                    orgIdConfigurado.Equals("LOCAL", StringComparison.OrdinalIgnoreCase) ||
                    String.IsNullOrEmpty(tokenConfigurado))
                {
                    return false;
                }

                string urlBase = String.IsNullOrEmpty(cloudUrlConfigurada)
                    ? "https://app.brasilpowerlifting.com.br"
                    : cloudUrlConfigurada.TrimEnd('/');

                string urlTesteAuth = "http://127.0.0.1:3000/api/nuvem/campeonatos?organizador_id=" + Uri.EscapeDataString(orgIdConfigurado);
                HttpWebRequest reqCloud = (HttpWebRequest)WebRequest.Create(urlTesteAuth);
                reqCloud.Method = "GET";
                reqCloud.Timeout = 3500;
                using (HttpWebResponse resCloud = (HttpWebResponse)reqCloud.GetResponse())
                {
                    return resCloud.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void AdicionarLog(string linha)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;
            try
            {
                this.BeginInvoke((MethodInvoker)delegate {
                    string horario = DateTime.Now.ToString("HH:mm:ss");
                    bufferLogs.Add("[" + horario + "] " + linha);
                    if (bufferLogs.Count > 250) bufferLogs.RemoveAt(0);
                    txtLogs.Text = String.Join("\r\n", bufferLogs.ToArray());
                    txtLogs.SelectionStart = txtLogs.Text.Length;
                    txtLogs.ScrollToCaret();
                });
            }
            catch { }
        }

        private void AbrirUrl(string url)
        {
            try
            {
                Process.Start(url);
            }
            catch (Exception ex)
            {
                if (idiomaAtual == "en")
                    MessageBox.Show("Could not open the browser automatically.\nPlease access manually: " + url + "\n\nDetail: " + ex.Message);
                else
                    MessageBox.Show("Não foi possível abrir o navegador automaticamente.\nAceda manualmente a: " + url + "\n\nDetalhe: " + ex.Message);
            }
        }

        private void ConfirmarEEncerrarServidor()
        {
            DialogResult resp = MessageBox.Show(
                (idiomaAtual == "en")
                    ? "Do you want to save the final database backup and SHUT DOWN the server now?\n\n⚠️ Warning: All referees' phones and big screens will be disconnected."
                    : "Deseja salvar o backup final do banco de dados e ENCERRAR o servidor agora?\n\n⚠️ Atenção: Todos os telemóveis de árbitros e telões serão desconectados.",
                (idiomaAtual == "en") ? "Shut Down Powerlifting Server" : "Encerrar Servidor Powerlifting",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2
            );

            if (resp == DialogResult.Yes)
            {
                ExecutarDesligamentoLimpo();
                Application.Exit();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Compatibilidade com o Windows App Certification Kit (WACK) da Microsoft Store:
            // Se o fecho ocorrer nos primeiros 15s sem interação humana (teste automatizado WACK), encerra imediatamente sem bloquear
            bool ehTesteAutomatizadoInicial = !usuarioInteragiu && (DateTime.UtcNow - instanteInicializacao).TotalSeconds < 15;

            if (!encerrandoIntencionalmente && e.CloseReason == CloseReason.UserClosing && !ehTesteAutomatizadoInicial)
            {
                DialogResult resp = MessageBox.Show(
                    (idiomaAtual == "en")
                        ? "Do you want to shut down the competition server and close the application?\n\n" +
                          "• Click [YES] to SAVE THE FINAL BACKUP and SHUT DOWN the server.\n" +
                          "• Click [NO] to only MINIMIZE this window and keep the competition running.\n" +
                          "• Click [CANCEL] to go back."
                        : "Deseja encerrar o servidor do campeonato e fechar o aplicativo?\n\n" +
                          "• Clique em [SIM] para SALVAR O BACKUP FINAL e DESLIGAR o servidor.\n" +
                          "• Clique em [NÃO] para apenas MINIMIZAR esta janela e continuar o campeonato.\n" +
                          "• Clique em [CANCELAR] para voltar.",
                    (idiomaAtual == "en") ? "Shut Down or Minimize Powerlifting Server" : "Encerrar ou Minimizar Servidor Powerlifting",
                    MessageBoxButtons.YesNoCancel,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2
                );

                if (resp == DialogResult.No)
                {
                    e.Cancel = true;
                    this.WindowState = FormWindowState.Minimized;
                    return;
                }
                else if (resp == DialogResult.Cancel)
                {
                    e.Cancel = true;
                    return;
                }
            }

            ExecutarDesligamentoLimpo();
            base.OnFormClosing(e);
        }

        private void ExecutarDesligamentoLimpo()
        {
            if (encerrandoIntencionalmente) return;
            encerrandoIntencionalmente = true;

            if (timerHealth != null) timerHealth.Stop();

            // Restaura configuração normal de energia do Windows
            SetThreadExecutionState(ES_CONTINUOUS);

            // Solicita ao server.js que faça o backup final e feche o WAL do SQLite
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:3000/api/desligar");
                req.Method = "POST";
                req.Timeout = 2500;
                req.ContentLength = 0;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse()) { }
                Thread.Sleep(400);
            }
            catch { }

            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    if (!nodeProcess.WaitForExit(1500))
                    {
                        nodeProcess.Kill();
                    }
                }
            }
            catch { }
        }

        [STAThread]
        public static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Global\\BrasilPowerliftingServerAppMutex", out createdNew))
            {
                if (!createdNew)
                {
                    // Se o organizador clicar no atalho da Área de Trabalho com o app já aberto, abre o navegador
                    try { Process.Start("http://localhost:3000"); } catch { }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }
}