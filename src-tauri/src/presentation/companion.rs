use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const COMPANION_PORT_CANDIDATES: [u16; 3] = [43821, 43822, 43823];
static ACTIVE_COMPANION_PORT: OnceLock<u16> = OnceLock::new();

pub fn active_companion_port() -> Option<u16> {
    ACTIVE_COMPANION_PORT.get().copied()
}

pub async fn start_test_server() -> Result<(), String> {
    let listener = bind_listener()
        .await
        .map_err(|e| format!("Failed to bind companion test server: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to resolve companion test server address: {}", e))?
        .port();
    let _ = ACTIVE_COMPANION_PORT.set(port);

    log::info!("📱 Companion test server listening on http://127.0.0.1:{port}");
    if let Some(ip) = detect_primary_ipv4() {
        log::info!("📱 Open on phone: http://{}:{port}", ip);
    } else {
        log::info!("📱 Open on phone: http://<your-mac-ip>:{port}");
    }

    loop {
        let (stream, peer) = listener
            .accept()
            .await
            .map_err(|e| format!("Companion test server accept failed: {}", e))?;
        log::debug!("Companion test server accepted connection from {}", peer);

        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream).await {
                log::debug!("Companion test server connection failed: {}", e);
            }
        });
    }
}

async fn bind_listener() -> std::io::Result<TcpListener> {
    for port in COMPANION_PORT_CANDIDATES {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => {
                log::warn!(
                    "Companion test server failed to bind 0.0.0.0:{}: {}",
                    port,
                    err
                );
            }
        }
    }

    TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await
}

async fn handle_connection(mut stream: TcpStream) -> std::io::Result<()> {
    let mut buf = [0_u8; 8192];
    let n = stream.read(&mut buf).await?;
    if n == 0 {
        return Ok(());
    }

    let request = String::from_utf8_lossy(&buf[..n]);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");

    let response = match (method, path) {
        ("GET", "/") | ("GET", "/index.html") => html_response(companion_html()),
        ("GET", "/health") | ("GET", "/api/health") => json_response(companion_health_json()),
        ("HEAD", "/") | ("HEAD", "/index.html") => empty_response("200 OK"),
        ("HEAD", "/health") | ("HEAD", "/api/health") => empty_response("200 OK"),
        ("GET", "/favicon.ico") => empty_response("204 No Content"),
        _ => text_response("404 Not Found", "Not Found"),
    };

    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

fn html_response(body: String) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
}

fn json_response(body: String) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
}

fn text_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
}

fn empty_response(status: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

fn companion_health_json() -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let port = active_companion_port().unwrap_or(0);

    serde_json::json!({
        "ok": true,
        "name": "HackInterviewAI companion test",
        "port": port,
        "timestamp_ms": now_ms,
    })
    .to_string()
}

fn companion_html() -> String {
    r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>HackInterviewAI Companion Test</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --card: #161b22;
        --line: rgba(255, 255, 255, 0.08);
        --text: #e6edf3;
        --muted: #9ba7b4;
        --accent: #4a9eff;
        --accent-soft: rgba(74, 158, 255, 0.12);
        --ok: #2ea043;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(74, 158, 255, 0.18), transparent 38%),
          var(--bg);
        color: var(--text);
      }

      .wrap {
        width: min(720px, 100%);
        margin: 0 auto;
        padding: 24px 16px 40px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 18px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
      }

      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        line-height: 1.05;
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 18px 0 14px;
        padding: 10px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--text);
        font-weight: 600;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--ok);
        box-shadow: 0 0 0 6px rgba(46, 160, 67, 0.12);
      }

      .grid {
        display: grid;
        gap: 12px;
        margin-top: 12px;
      }

      .metric {
        padding: 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.02);
      }

      .label {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }

      .value {
        font-size: 16px;
        line-height: 1.35;
        word-break: break-word;
      }

      .hint {
        margin-top: 16px;
        font-size: 14px;
      }

      button {
        margin-top: 16px;
        border: none;
        border-radius: 12px;
        background: var(--accent);
        color: white;
        padding: 12px 14px;
        font-size: 15px;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>HackInterviewAI</h1>
        <p>Companion test page from your Mac. If you see this page on your phone, local Wi‑Fi access works.</p>

        <div class="pill"><span class="dot"></span><span>Connected to Mac test server</span></div>

        <div class="grid">
          <div class="metric">
            <span class="label">Health</span>
            <div class="value" id="health">Loading...</div>
          </div>
          <div class="metric">
            <span class="label">Phone Browser</span>
            <div class="value" id="ua"></div>
          </div>
          <div class="metric">
            <span class="label">Opened At</span>
            <div class="value" id="opened-at"></div>
          </div>
        </div>

        <button id="refresh" type="button">Refresh Health</button>
        <p class="hint">Next step can be live transcript stream and control buttons from this page.</p>
      </div>
    </div>

    <script>
      const healthEl = document.getElementById('health');
      const uaEl = document.getElementById('ua');
      const openedAtEl = document.getElementById('opened-at');
      const refreshButton = document.getElementById('refresh');

      uaEl.textContent = navigator.userAgent;
      openedAtEl.textContent = new Date().toLocaleString();

      async function loadHealth() {
        try {
          const res = await fetch('/health', { cache: 'no-store' });
          const json = await res.json();
          healthEl.textContent = JSON.stringify(json, null, 2);
        } catch (err) {
          healthEl.textContent = 'Request failed: ' + (err && err.message ? err.message : String(err));
        }
      }

      refreshButton.addEventListener('click', loadHealth);
      loadHealth();
      setInterval(loadHealth, 4000);
    </script>
  </body>
</html>"#
        .to_string()
}

fn detect_primary_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;

    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}
