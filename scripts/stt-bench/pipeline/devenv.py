import json, re, urllib.request
def _token():
    for line in open('/Users/marcos/Documents/babylon-cinema/.env'):
        m = re.match(r'\s*(?:export\s+)?SANDBOX_TOKEN\s*=\s*"?([^"\n]+)"?', line)
        if m: return m.group(1).strip()
    raise SystemExit('no SANDBOX_TOKEN')
def env():
    req = urllib.request.Request('https://parle-palco.up.railway.app/api/sandbox-env', headers={'Authorization': 'Bearer ' + _token()})
    data = json.load(urllib.request.urlopen(req, timeout=30))
    return data.get('env', data) if isinstance(data, dict) else data
if __name__ == '__main__':
    e = env(); print(type(e).__name__, sorted(k for k in e if 'OPENROUTER' in k or 'AI_GATEWAY' in k))
