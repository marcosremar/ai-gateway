/**
 * Vast.ai Diagnostic Test — Investigate why instances die
 *
 * Creates 3 machines and monitors them every 10s for 3 minutes.
 * Logs full API response to see status transitions and why they disappear.
 *
 * Run: cd packages/ai-gateway && source ../../.env && VAST_API_KEY=$VAST_API_KEY bunx tsx __tests__/vast-diagnose.ts
 */

const VAST_API_KEY = process.env.VAST_API_KEY!;
if (!VAST_API_KEY) { console.error('VAST_API_KEY not set'); process.exit(1); }

const VAST_API_BASE = 'https://console.vast.ai/api/v0';

function headers(): Record<string, string> {
  return { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${VAST_API_KEY}` };
}

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function apiGet(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${VAST_API_BASE}${path}`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(`    API ${path}: HTTP ${res.status} ${body.substring(0, 200)}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.log(`    API ${path}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function apiPut(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${VAST_API_BASE}${path}`, {
      method: 'PUT', headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => '');
    console.log(`    API PUT ${path}: HTTP ${res.status} ${text.substring(0, 300)}`);
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  } catch (err) {
    console.log(`    API PUT ${path}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function dumpInstance(raw: Record<string, unknown>, label: string) {
  console.log(`  ${label}:`);
  console.log(`    actual_status:    ${raw.actual_status}`);
  console.log(`    cur_state:        ${raw.cur_state}`);
  console.log(`    intended_status:  ${raw.intended_status}`);
  console.log(`    status_msg:       ${raw.status_msg}`);
  console.log(`    next_state:       ${raw.next_state}`);
  console.log(`    public_ipaddr:    ${raw.public_ipaddr}`);
  console.log(`    ports:            ${JSON.stringify(raw.ports)}`);
  console.log(`    direct_port_start:${raw.direct_port_start}`);
  console.log(`    start_date:       ${raw.start_date}`);
  console.log(`    end_date:         ${raw.end_date}`);
  console.log(`    image:            ${raw.image_uuid}`);
  console.log(`    gpu_name:         ${raw.gpu_name}`);
  console.log(`    reliability:      ${raw.reliability2}`);
  console.log(`    error_msg:        ${(raw as Record<string, unknown>).status_msg_short ?? raw.error ?? '-'}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(100));
  console.log('  VAST.AI DIAGNOSTIC — Investigating instance deaths');
  console.log('='.repeat(100));

  // ── Check account balance first ────────────────────────────────────────
  console.log('\n--- Account Info ---');
  const userInfo = await apiGet('/users/current/');
  if (userInfo) {
    console.log(`  balance: $${userInfo.balance}`);
    console.log(`  credit:  $${userInfo.credit}`);
    console.log(`  api_key_id: ${userInfo.api_key_id}`);
  }

  // ── Search for offers ─────────────────────────────────────────────────
  console.log('\n--- Search offers ---');
  const searchRes = await fetch(`${VAST_API_BASE}/bundles/`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      limit: 10, type: 'on-demand', rentable: { eq: true }, rented: { eq: false },
      num_gpus: { eq: 1 }, disk_space: { gte: 10 },
      gpu_name: { in: ['RTX 4090', 'RTX 3090', 'RTX A5000', 'RTX A4000', 'RTX 4080', 'RTX 3080'] },
      order: [['dph_total', 'asc']],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const searchData = (await searchRes.json()) as Record<string, unknown>;
  const offers = (searchData.offers || []) as Array<Record<string, unknown>>;
  console.log(`  Found ${offers.length} offers`);
  for (const o of offers.slice(0, 5)) {
    console.log(`    ${o.id} | ${o.gpu_name} | $${(o.dph_total as number).toFixed(3)}/hr | reliability=${o.reliability2} | direct_ports=${o.direct_port_count}`);
  }

  // ── Create 3 machines with DIFFERENT configs ──────────────────────────
  console.log('\n--- Creating 3 machines with different configs ---');

  const configs = [
    {
      label: 'A: env -p ports (new)',
      body: {
        client_id: 'me',
        image: 'marcosremar/parle-s2s-ultralight:latest',
        disk: 10,
        runtype: 'args',
        env: { TZ: 'UTC', '-p 8000:8000': '1', '-p 8001:8001/udp': '1' },
        cancel_unavail: false,
      },
    },
    {
      label: 'B: ports dict (old)',
      body: {
        client_id: 'me',
        image: 'marcosremar/parle-s2s-ultralight:latest',
        disk: 10,
        runtype: 'args',
        env: { TZ: 'UTC' },
        ports: { '8000/http': {} },
        cancel_unavail: false,
      },
    },
    {
      label: 'C: ssh mode + onstart',
      body: {
        client_id: 'me',
        image: 'marcosremar/parle-s2s-ultralight:latest',
        disk: 10,
        runtype: 'ssh',
        env: { TZ: 'UTC', '-p 8000:8000': '1' },
        onstart: 'echo "STARTED at $(date)" > /tmp/started.txt; python3 -m http.server 8000 || sleep infinity',
        cancel_unavail: false,
      },
    },
  ];

  const created: { id: string; label: string; offerId: string }[] = [];

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const offer = offers[i];
    if (!offer) { console.log(`  No offer for ${cfg.label}`); continue; }

    console.log(`\n  Creating ${cfg.label} on offer ${offer.id} (${offer.gpu_name})...`);
    console.log(`    Body: ${JSON.stringify(cfg.body).substring(0, 300)}`);

    await sleep(2000);
    const result = await apiPut(`/asks/${offer.id}/`, cfg.body);
    if (result?.success && result.new_contract) {
      const id = String(result.new_contract);
      created.push({ id, label: cfg.label, offerId: String(offer.id) });
      console.log(`    ✓ Created instance ${id}`);
    } else {
      console.log(`    ✗ Failed to create`);
    }
  }

  if (created.length === 0) {
    console.error('\nNo machines created, aborting.');
    process.exit(1);
  }

  // ── Monitor every 10s for 3 minutes ───────────────────────────────────
  console.log(`\n--- Monitoring ${created.length} instances every 10s for 3 min ---`);
  const monitorStart = Date.now();
  const monitorDuration = 180_000;

  while (Date.now() - monitorStart < monitorDuration) {
    const elapsed = Math.round((Date.now() - monitorStart) / 1000);
    console.log(`\n=== [${elapsed}s] Status check ===`);

    // List all instances (single API call)
    await sleep(300);
    const listData = await apiGet('/instances/');
    const allInstances = listData
      ? ((listData.instances || listData) as Array<Record<string, unknown>>)
      : [];

    if (!Array.isArray(allInstances)) {
      console.log('  WARNING: /instances/ returned non-array');
      await sleep(10_000);
      continue;
    }

    for (const c of created) {
      const raw = allInstances.find(i => String(i.id) === c.id);
      if (raw) {
        const status = raw.actual_status ?? raw.cur_state ?? '-';
        const ip = raw.public_ipaddr ?? '-';
        const ports = raw.ports ? JSON.stringify(raw.ports).substring(0, 100) : '-';
        const statusMsg = raw.status_msg ?? '-';
        console.log(`  ${c.label} (${c.id}): status=${status} | ip=${ip} | ports=${ports} | msg=${String(statusMsg).substring(0, 80)}`);
      } else {
        console.log(`  ${c.label} (${c.id}): *** NOT FOUND IN LIST — DEAD/DESTROYED ***`);

        // Try individual endpoint to get more info
        await sleep(300);
        const detail = await apiGet(`/instances/${c.id}/`);
        if (detail) {
          const inst = (detail.instances ?? detail) as Record<string, unknown>;
          if (inst && typeof inst === 'object') {
            dumpInstance(inst, `  ${c.label} (individual API)`);
          }
        }
      }
    }

    // Also check: are there any OTHER instances on the account?
    const ourIds = new Set(created.map(c => c.id));
    const otherInstances = allInstances.filter(i => !ourIds.has(String(i.id)));
    if (otherInstances.length > 0) {
      console.log(`  (${otherInstances.length} other instance(s) on account)`);
    }

    await sleep(10_000);
  }

  // ── Final full dump ─────────────────────────────────────────────────────
  console.log('\n--- Final full dump ---');
  for (const c of created) {
    await sleep(500);
    console.log(`\n${c.label} (${c.id}):`);
    const detail = await apiGet(`/instances/${c.id}/`);
    if (detail) {
      const inst = (detail.instances ?? detail) as Record<string, unknown>;
      if (inst && typeof inst === 'object') {
        dumpInstance(inst, c.label);
      }
    } else {
      console.log('  GONE (404)');
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  console.log('\n--- Cleanup ---');
  for (const c of created) {
    await sleep(1500);
    try {
      const res = await fetch(`${VAST_API_BASE}/instances/${c.id}/`, {
        method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text().catch(() => '');
      console.log(`  ${c.id}: HTTP ${res.status} ${text.substring(0, 100)}`);
    } catch (err) {
      console.log(`  ${c.id}: ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n' + '='.repeat(100));
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
