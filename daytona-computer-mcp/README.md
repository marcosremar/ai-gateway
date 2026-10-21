# daytona-computer-mcp

MCP server que expõe um desktop Linux do Daytona (Computer Use + VNC) como tools, pra qualquer LLM (Claude Code, Claude Desktop, Cursor) controlar mouse/teclado/tela.

## Tools

| Tool | Função |
|------|--------|
| `desktop_start(allow_network, auto_stop_minutes)` | cria sandbox + sobe GUI (Xvfb+XFCE+x11vnc+noVNC), retorna `sandbox_id` + `vnc_url` |
| `desktop_attach(sandbox_id)` | conecta a um sandbox existente e garante a GUI ligada |
| `desktop_list()` | lista sandboxes |
| `vnc_url()` | URL noVNC assinada (web) + token |
| `screenshot(show_cursor)` | PNG da tela (retorno tipo imagem) |
| `click(x, y, button, double)` | clique do mouse |
| `move(x, y)` | move o cursor |
| `scroll(x, y, direction, amount)` | rolagem |
| `type_text(text)` | digita texto |
| `press_key(key, modifiers)` | tecla/atalho (ex: `key="Return"`, `modifiers=["ctrl"]`) |
| `exec_shell(command, timeout)` | roda comando shell no sandbox (ex: abrir um app) |
| `desktop_stop()` / `desktop_delete()` | para / remove o sandbox |

## Setup

```bash
pip install -r requirements.txt
```

Auth: usa a API key da CLI do Daytona (`~/Library/Application Support/daytona/config.json`)
automaticamente, ou `DAYTONA_API_KEY` no env.

## Registrar

**Claude Code** (escopo usuário):
```bash
claude mcp add daytona-computer --scope user -- python3 "/Volumes/HD 1TB/projects/ai-gateway/daytona-computer-mcp/server.py"
```

**Claude Desktop / Cursor** — adicione ao `mcpServers` do config (ver `.mcp.json`):
```json
{
  "mcpServers": {
    "daytona-computer": {
      "command": "python3",
      "args": ["/Volumes/HD 1TB/projects/ai-gateway/daytona-computer-mcp/server.py"]
    }
  }
}
```

## Fluxo típico

1. `desktop_start()` → pega `sandbox_id` e `vnc_url`
2. `exec_shell("DISPLAY=:0 nohup chromium --no-sandbox https://... &")` pra abrir um app
3. `screenshot()` → ver a tela
4. `click` / `type_text` / `press_key` → controlar
5. `desktop_stop()` quando terminar (evita gastar crédito)
