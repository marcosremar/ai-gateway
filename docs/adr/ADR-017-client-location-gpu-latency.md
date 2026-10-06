# ADR-017: Rank GPUs by client → GPU latency, not gateway → GPU

**Status:** Accepted
**Date:** 2026-09-29
**Deciders:** ai-gateway maintainers

## Context

Real-time speech translation is dominated by the round trip between the
people talking and the GPU. The gateway's latency tooling measured and ranked
from the wrong place:

- `rankOffers` used the gateway's own IP geolocation as "the client" and the
  gateway's own TCP probes as host RTT. With the gateway in a cloud VM or
  another country, it picked the GPU closest to the gateway.
- Vast `listOffers` never exposed `hostIp`, so no Vast host was ever probed.
- `autoSelectCheapestGpu` looked latency up with a key that never matched
  latency-db, so `sortBy: latency|realtime` ignored latency entirely.
- RunPod `region: 'FR'` (or `'FR,CH'`) resolved to "any datacenter".
- `GET /v1/gpu/offers/ranked` existed but was not registered.

Concrete case: an experiment near Lyon, France.

## Decision

1. The client location is explicit: deploy body `clientLat`/`clientLon`, or
   `GPU_CLIENT_LOCATION="lat,lon"` on the gateway. It is never inferred from
   the gateway's IP for deploys.
2. `region: "near"` / `"near:<km>"` (default 1200 km) expands to the country
   codes whose hub lies within that radius of the client, nearest first.
   The same string works for Vast (country filter) and RunPod (country →
   Secure Cloud datacenters).
3. Gateway-origin host probes are only trusted when the gateway is within
   300 km of the client (`PROBE_ORIGIN_MAX_KM`); otherwise ranking falls back
   to a geo estimate from the client.
4. `region: "near"` implies `requireDirectPort: true` (overridable in the
   deploy body): SSH-only Vast hosts are reached through Vast's SSH proxy
   (`sshN.vast.ai`), an extra hop unrelated to the client's location, and a
   host whose direct port is unreachable is dropped instead of tunnelled.
5. The authoritative measurement is taken from the client machine:
   `ai-gateway latency nearest` TCP-probes candidate hosts locally.

## Alternatives Considered

### Keep probing from the gateway and add a fixed offset
Rejected: gateway→host and client→host routes share nothing beyond
geography; an offset is not more accurate than the geo estimate.

### Pod-side probes back to the client
Rejected for now: needs a rented pod per candidate (cost, minutes of boot),
and client networks usually block inbound probes.

## Consequences

### Positive
- Deploys for a client in Lyon stay in FR/CH/IT/DE… instead of the cheapest
  host anywhere.
- Latency sorts in auto-select actually use measured data.

### Negative
- Geo estimates use one hub per country (FR = Paris); a host in Marseille
  and one in Lille look the same until probed from the client.
- `near` requires the operator to state the client location.

## Monitoring

- `rttSource` / `hostProbesUsed` in `/v1/gpu/offers/ranked` responses.
- Gateway log line `[gpu] region "near" → …` on each deploy.
- Pipeline P50/P95 per deploy (existing latency tracker) before/after.
