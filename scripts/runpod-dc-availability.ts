#!/usr/bin/env bun
/**
 * RunPod Datacenter Availability Discovery
 *
 * Queries RunPod's GraphQL API to learn:
 *   - Which datacenters exist
 *   - Which support network volumes (storageSupport)
 *   - Which GPUs are available in each DC and their stock status
 *
 * Output: a matrix of (DC × GPU) showing stock status, filtered to network-volume DCs.
 *
 * This costs $0 — pure GraphQL query, no pods deployed.
 */

import 'dotenv/config';

const GRAPHQL_URL = process.env.RUNPOD_GRAPHQL_URL || 'https://api.runpod.io/graphql';

async function gql<T = any>(query: string, apiKey: string): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GraphQL HTTP ${res.status}: ${body.substring(0, 500)}`);
  }
  const json = await res.json() as any;
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).substring(0, 500)}`);
  }
  return json.data;
}

async function main() {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) { console.error('FATAL: RUNPOD_API_KEY not set'); process.exit(1); }

  console.log('=== RunPod DC × GPU Availability ===\n');

  // Query 1: List datacenters with storage support
  const dcQuery = `{
    dataCenters {
      id
      name
      location
      storageSupport
      listed
      gpuAvailability {
        gpuTypeId
        gpuTypeDisplayName
        stockStatus
        gpuType { displayName memoryInGb securePrice }
      }
    }
  }`;

  let dcData: any;
  try {
    dcData = await gql(dcQuery, apiKey);
  } catch (e) {
    console.error(`✗ Failed to query datacenters: ${(e as Error).message}`);
    // Try simpler query
    console.log('Falling back to simpler query...');
    try {
      dcData = await gql(`{ dataCenters { id name location storageSupport gpuAvailability { gpuTypeId stockStatus } } }`, apiKey);
    } catch (e2) {
      console.error(`✗ Simpler query also failed: ${(e2 as Error).message}`);
      process.exit(1);
    }
  }

  const dcs: any[] = dcData.dataCenters || [];
  if (!dcs.length) {
    console.error('No datacenters returned');
    process.exit(1);
  }

  console.log(`Found ${dcs.length} datacenters total\n`);

  // Filter to DCs with network volume support
  const nvDcs = dcs.filter(d => d.storageSupport === true);
  console.log(`${nvDcs.length} datacenters support network volumes:\n`);

  // For each NV-supporting DC, list GPUs and their stock status
  type StockEntry = { dc: string; gpuId: string; gpu: string; status: string; price?: number };
  const allEntries: StockEntry[] = [];

  for (const dc of nvDcs) {
    console.log(`📍 ${dc.id} (${dc.name || dc.location || '?'}) — storage: ✓`);
    const avail = dc.gpuAvailability || [];
    for (const a of avail) {
      const gpuId = a.gpuTypeId || a.gpuType?.id || '?';
      const gpuName = a.gpuTypeDisplayName || a.gpuType?.displayName || gpuId;
      const status = a.stockStatus || 'unknown';
      const price = a.gpuType?.securePrice;
      allEntries.push({ dc: dc.id, gpuId, gpu: gpuName, status, price });
      const icon = status === 'High' ? '🟢' : status === 'Medium' ? '🟡' : status === 'Low' ? '🟠' : '🔴';
      const priceStr = price ? `$${price.toFixed(2)}/hr` : '';
      console.log(`    ${icon} ${gpuName.padEnd(35)} ${status.padEnd(10)} ${priceStr}`);
    }
    console.log('');
  }

  // ── Aggregation: which GPU is in the most NV-supporting DCs? ────────────
  console.log('\n=== Cross-DC summary: GPUs by # of network-volume DCs ===\n');
  const gpuCounts = new Map<string, { name: string; dcs: string[]; statuses: string[]; price?: number }>();
  for (const e of allEntries) {
    const key = e.gpuId;
    let entry = gpuCounts.get(key);
    if (!entry) {
      entry = { name: e.gpu, dcs: [], statuses: [], price: e.price };
      gpuCounts.set(key, entry);
    }
    entry.dcs.push(e.dc);
    entry.statuses.push(e.status);
  }

  const sorted = [...gpuCounts.values()].sort((a, b) => {
    // Sort by: in-stock count desc, then total DC count desc
    const aInStock = a.statuses.filter(s => s === 'High' || s === 'Medium').length;
    const bInStock = b.statuses.filter(s => s === 'High' || s === 'Medium').length;
    if (bInStock !== aInStock) return bInStock - aInStock;
    return b.dcs.length - a.dcs.length;
  });

  console.log('GPU Type'.padEnd(35) + 'NV-DCs   In-Stock  Stock Detail');
  console.log('─'.repeat(95));
  for (const g of sorted) {
    const inStock = g.statuses.filter(s => s === 'High' || s === 'Medium').length;
    const detail = g.dcs.map((d, i) => {
      const s = g.statuses[i];
      const icon = s === 'High' ? '🟢' : s === 'Medium' ? '🟡' : s === 'Low' ? '🟠' : '🔴';
      return `${icon}${d}`;
    }).join(' ');
    const priceStr = g.price ? `$${g.price.toFixed(2)}` : '   ?';
    console.log(`${g.name.padEnd(35)} ${String(g.dcs.length).padStart(3)}      ${String(inStock).padStart(3)}      ${detail}`);
  }

  console.log('\n=== Recommendation ===');
  // Pick the GPU with the most "in stock" DCs and reasonable price
  const candidates = sorted.filter(g =>
    g.statuses.some(s => s === 'High' || s === 'Medium') && g.price && g.price < 2.0,
  );
  if (candidates.length > 0) {
    const top = candidates[0];
    const bestDc = top.dcs.find((_, i) => top.statuses[i] === 'High') ||
                   top.dcs.find((_, i) => top.statuses[i] === 'Medium');
    console.log(`Best for benchmark: ${top.name} in ${bestDc} ($${top.price?.toFixed(2)}/hr)`);
  } else {
    console.log('No clearly available GPUs at this moment under $2/hr');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
