# fly-computer-mcp

Desktop Linux no Fly.io (XFCE/Fluxbox + VNC) com **internet livre**, controlável por MCP.
Backend de controle = `flyctl machine exec` (xdotool/scrot) — sem porta de controle exposta;
auth usa o login do `flyctl` da máquina.

Imagem do desktop: [`../fly-computer-desktop/`](../fly-computer-desktop). App: `weathered-canyon-498`.

## Tools

| Tool | Função |
|------|--------|
| `machine_status()` | id/estado/região da máquina |
| `machine_start()` / `machine_stop()` | liga/desliga (custo só roda ligado) |
| `vnc_url()` | URL noVNC pública (ver/controlar manual) |
| `screenshot()` | PNG da tela |
| `click(x,y,button,double)` / `move(x,y)` / `scroll(x,y,direction,amount)` | mouse |
| `type_text(text)` / `press_key(key,modifiers)` | teclado (ex: `key="Return"`, `modifiers=["ctrl"]`) |
| `open_url(url)` | abre Chromium numa URL |
| `launch(command)` | roda app GUI (`DISPLAY=:0`) |
| `exec_shell(command,timeout)` | shell na máquina |

## Pré-requisitos

- `flyctl` instalado e autenticado (`fly auth login`)
- `pip install mcp`

## Registrar

**Claude Code:**
```bash
claude mcp add fly-computer --scope user -e FLY_APP=weathered-canyon-498 -- python3 "/Volumes/HD 1TB/projects/ai-gateway/fly-computer-mcp/server.py"
```

**Claude Desktop / Cursor:** ver `.mcp.json`.

## Custo / operação

- Máquina `shared-cpu-2x` / 2GB. Parada ≈ $0; rodando ≈ centavos/h.
- **Idle-stop de 10 min** (watchdog em [`../fly-computer-desktop/idle-stop.sh`](../fly-computer-desktop/idle-stop.sh)):
  para sozinha após 10 min sem input X (cobre VNC **e** xdotool do MCP) **e** sem viewer VNC.
  Ajustar: `IDLE_STOP_MS` em `fly.toml` `[env]` + `fly deploy`.
- `auto_stop_machines="off"` (o watchdog manda no stop); `auto_start_machines=true` (abrir o VNC religa).
- Para por token escopado no app (secret `FLY_STOP_TOKEN`).
- `machine_stop()` quando terminar; `machine_start()` antes de usar.
- Gerir imagem/deploy:
  ```bash
  cd ../fly-computer-desktop
  fly deploy --remote-only --ha=false
  fly machine list --app weathered-canyon-498
  ```

## Fluxo típico

1. `machine_start()` → `vnc_url()` (opcional, pra assistir)
2. `open_url("https://...")` → `screenshot()`
3. `click` / `type_text` / `press_key` → controlar
4. `machine_stop()`
