#!/usr/bin/env python3
"""
RunPod Pod Log Scraper — Playwright headless browser.

RunPod has no public API for GPU pod logs. This script uses Playwright to
access the RunPod web console and scrape container/system logs.

Usage:
  # First run — opens browser for login, saves cookies:
  python3 scripts/runpod-logs.py --login

  # Fetch logs for a specific pod (uses saved cookies):
  python3 scripts/runpod-logs.py --pod <POD_ID>

  # Fetch logs for all pods:
  python3 scripts/runpod-logs.py --all

  # Fetch logs for most recent pod:
  python3 scripts/runpod-logs.py --latest

Cookies are saved to ~/.runpod/browser-cookies.json for reuse.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

COOKIES_PATH = Path.home() / ".runpod" / "browser-cookies.json"
RUNPOD_CONSOLE = "https://www.runpod.io/console/pods"


def ensure_cookies_dir():
    COOKIES_PATH.parent.mkdir(parents=True, exist_ok=True)


def login():
    """Open visible browser for user to log in, then save cookies."""
    from playwright.sync_api import sync_playwright

    ensure_cookies_dir()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        print(f"Opening RunPod console: {RUNPOD_CONSOLE}")
        print("Please log in manually in the browser window.")
        page.goto(RUNPOD_CONSOLE)

        # Poll until we detect a logged-in state or user signals done
        print("\nWaiting for login... (will auto-detect or press Ctrl+C to save now)")
        try:
            for _ in range(600):  # 10 min max
                time.sleep(1)
                url = page.url
                # Detect successful login by checking URL patterns
                if any(x in url for x in ["/console/pods", "/console/gpu", "/console/serverless", "/console/user"]):
                    print(f"Login detected! Current URL: {url}")
                    page.wait_for_load_state("networkidle")
                    time.sleep(2)
                    break
                # Also check if cookies contain auth tokens
                current_cookies = context.cookies()
                auth_cookies = [c for c in current_cookies if any(
                    k in c.get("name", "").lower() for k in ["token", "session", "auth", "clerk"]
                )]
                if len(auth_cookies) >= 2:
                    print(f"Auth cookies detected ({len(auth_cookies)} auth cookies)")
                    time.sleep(2)
                    break
        except KeyboardInterrupt:
            print("\nManual save triggered.")

        cookies = context.cookies()
        COOKIES_PATH.write_text(json.dumps(cookies, indent=2))
        print(f"Cookies saved to {COOKIES_PATH} ({len(cookies)} cookies)")

        browser.close()


def load_cookies():
    """Load saved cookies or exit with login instructions."""
    if not COOKIES_PATH.exists():
        print(f"No cookies found at {COOKIES_PATH}")
        print("Run with --login first to authenticate:")
        print(f"  python3 {sys.argv[0]} --login")
        sys.exit(1)

    cookies = json.loads(COOKIES_PATH.read_text())
    print(f"Loaded {len(cookies)} cookies from {COOKIES_PATH}")
    return cookies


def fetch_pod_logs(pod_id: str, cookies: list, log_type: str = "all") -> dict:
    """Fetch logs for a specific pod via headless Playwright browser.

    Uses the RunPod console SPA flow:
    1. Navigate to console.runpod.io/pods (establishes Clerk auth session)
    2. Click on the pod row to expand it
    3. Click "Logs" tab — triggers fetch to hapi.runpod.net/v1/pod/{id}/logs
    4. Intercept the hapi response containing { container: [], system: [] }
    """
    from playwright.sync_api import sync_playwright

    result = {"pod_id": pod_id, "container_logs": None, "system_logs": None, "error": None}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1400, "height": 900})
        context.add_cookies(cookies)

        page = context.new_page()
        hapi_logs = []

        def on_response(response):
            if "hapi" in response.url and "/logs" in response.url:
                try:
                    body = response.text()
                    hapi_logs.append({"status": response.status, "body": body})
                except Exception:
                    pass

        page.on("response", on_response)

        try:
            # Step 1: Navigate to pods list
            page.goto("https://console.runpod.io/pods", timeout=30_000)
            time.sleep(4)

            if "login" in page.url.lower() or "sign" in page.url.lower():
                result["error"] = "Session expired — run with --login to re-authenticate"
                browser.close()
                return result

            # Step 2: Click on the pod row to expand it
            pod_row = page.locator("tr, [class*='row'], [class*='Row']").filter(has_text=pod_id[:12])
            if pod_row.count() > 0:
                pod_row.first.click()
                time.sleep(3)
            else:
                result["error"] = f"Pod {pod_id} not found on pods page"
                browser.close()
                return result

            # Step 3: Click "Logs" tab in expanded pod
            logs_clicked = False
            for sel in ['text="Logs"', 'button:has-text("Logs")']:
                try:
                    el = page.locator(sel).first
                    if el.is_visible(timeout=2000):
                        el.click()
                        logs_clicked = True
                        break
                except Exception:
                    continue

            if not logs_clicked:
                # Try kebab menu → Logs
                buttons = page.locator("button").all()
                for btn in buttons[-10:]:
                    try:
                        box = btn.bounding_box()
                        if box and box["x"] > 600:
                            btn.click()
                            time.sleep(1)
                            logs_el = page.locator('text="Logs"').first
                            if logs_el.is_visible(timeout=1000):
                                logs_el.click()
                                logs_clicked = True
                                break
                    except Exception:
                        continue

            # Step 4: Wait for hapi log responses (polled every 5s)
            time.sleep(7)

            # Step 5: Parse captured hapi responses
            if hapi_logs:
                latest = hapi_logs[-1]
                if latest["status"] == 200:
                    import json as _json
                    data = _json.loads(latest["body"])
                    container = data.get("container", [])
                    system = data.get("system", [])
                    result["container_logs"] = "\n".join(container) if container else None
                    result["system_logs"] = "\n".join(system) if system else None
                    print(f"  Captured {len(container)} container + {len(system)} system log lines via hapi")
                else:
                    result["error"] = f"hapi returned HTTP {latest['status']}"
            else:
                # Fallback: read visible page text
                body_text = page.locator("body").inner_text(timeout=5000)
                result["container_logs"] = body_text
                print(f"  No hapi response captured — fallback to page text ({len(body_text)} chars)")

        except Exception as e:
            result["error"] = f"Failed to extract logs: {e}"

        browser.close()

    return result


def list_pods(cookies: list) -> list:
    """List all pods from the RunPod console."""
    from playwright.sync_api import sync_playwright

    pods = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        context.add_cookies(cookies)

        page = context.new_page()
        print(f"Loading pods list from {RUNPOD_CONSOLE}...")

        try:
            page.goto(RUNPOD_CONSOLE, timeout=30_000)
            page.wait_for_load_state("networkidle", timeout=15_000)
        except Exception as e:
            if "login" in page.url.lower() or "sign" in page.url.lower():
                print("Session expired — run with --login to re-authenticate")
                browser.close()
                return pods
            print(f"Failed to load: {e}")
            browser.close()
            return pods

        # Intercept API calls to get pod data
        # RunPod console makes GraphQL or REST calls — capture them
        page.wait_for_timeout(3000)

        # Try to extract pod IDs from the page
        try:
            # Look for pod rows/cards in the console
            pod_selectors = [
                '[class*="pod"]',
                '[data-testid*="pod"]',
                'tr[class*="Pod"]',
                '[class*="instance"]',
            ]
            for sel in pod_selectors:
                try:
                    elements = page.locator(sel).all()
                    for el in elements:
                        text = el.inner_text(timeout=2000)
                        if text:
                            pods.append({"text": text.strip()[:200]})
                except Exception:
                    continue

            if not pods:
                body = page.locator("body").inner_text(timeout=5000)
                print(f"Page content ({len(body)} chars):")
                print(body[:2000])
        except Exception as e:
            print(f"Error extracting pods: {e}")

        browser.close()

    return pods


def main():
    parser = argparse.ArgumentParser(description="RunPod Pod Log Scraper")
    parser.add_argument("--login", action="store_true", help="Open browser for login, save cookies")
    parser.add_argument("--pod", type=str, help="Fetch logs for a specific pod ID")
    parser.add_argument("--all", action="store_true", help="Fetch logs for all pods")
    parser.add_argument("--latest", action="store_true", help="Fetch logs for the most recent pod")
    parser.add_argument("--lines", type=int, default=500, help="Max log lines to display")
    parser.add_argument("--output", type=str, help="Save logs to file")
    args = parser.parse_args()

    if args.login:
        login()
        return

    if not (args.pod or args.all or args.latest):
        parser.print_help()
        return

    cookies = load_cookies()

    if args.pod:
        result = fetch_pod_logs(args.pod, cookies)
        _print_result(result, args)

    elif args.all or args.latest:
        # Use RunPod REST API to list pods (faster than scraping)
        api_key = os.environ.get("RUNPOD_API_KEY")
        if not api_key:
            # Try loading from .env
            env_path = Path(__file__).parent.parent / ".env"
            if env_path.exists():
                for line in env_path.read_text().splitlines():
                    if line.startswith("RUNPOD_API_KEY="):
                        api_key = line.split("=", 1)[1].strip()
                        break

        if api_key:
            import urllib.request
            req = urllib.request.Request(
                "https://rest.runpod.io/v1/pods",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                pods = json.loads(resp.read())

            if not pods:
                print("No pods found")
                return

            if args.latest:
                pods = [pods[0]]

            for pod in pods:
                pid = pod["id"]
                status = pod.get("desiredStatus", "?")
                name = pod.get("name", "?")
                print(f"\n{'='*60}")
                print(f"Pod: {pid} ({name}) — {status}")
                print(f"{'='*60}")
                result = fetch_pod_logs(pid, cookies)
                _print_result(result, args)
        else:
            print("RUNPOD_API_KEY not found — cannot list pods. Use --pod <ID> instead.")


def _print_result(result: dict, args):
    if result.get("error"):
        print(f"  ERROR: {result['error']}")

    if result.get("container_logs"):
        logs = result["container_logs"]
        lines = logs.splitlines()
        if len(lines) > args.lines:
            lines = lines[-args.lines:]
        output = "\n".join(lines)
        print(f"\n--- Container Logs ({len(lines)} lines) ---")
        print(output)

    if result.get("system_logs"):
        print(f"\n--- System Logs ---")
        print(result["system_logs"][:5000])

    if args.output:
        Path(args.output).write_text(json.dumps(result, indent=2))
        print(f"\nSaved to {args.output}")


if __name__ == "__main__":
    main()
