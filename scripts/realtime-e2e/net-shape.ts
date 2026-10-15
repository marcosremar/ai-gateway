import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

export interface Profile {
  down?: string; up?: string; delayMs?: number; jitterMs?: number; lossPct?: number; udpBlocked?: boolean;
  flap?: { everyS: number; downS: number };
}
export const PROFILES: Record<string, Profile> = {
  clean: {},
  'campus-slow': { down: '2mbit', up: '512kbit', delayMs: 40, jitterMs: 10, lossPct: 1 },
  'udp-blocked': { udpBlocked: true },
  lossy: { delayMs: 75, lossPct: 5 },
  'loss-2': { delayMs: 20, lossPct: 2 },
  'loss-5': { delayMs: 20, lossPct: 5 },
  'loss-10': { delayMs: 20, lossPct: 10 },
  flap: { flap: { everyS: 30, downS: 3 } },
};

const NS = 'aigwload';
const HOST_IF = 'aigwl0';
const NS_IF = 'aigwl1';
const NET = '10.77.0';
export const HOST_IP = `${NET}.1`;
export const NS_EXEC = ['ip', 'netns', 'exec', NS];
const NAT_RULES = [
  ['-t', 'nat', 'POSTROUTING', '-s', `${NET}.0/24`, '!', '-o', HOST_IF, '-j', 'MASQUERADE'],
  ['FORWARD', '-i', HOST_IF, '-j', 'ACCEPT'],
  ['FORWARD', '-o', HOST_IF, '-j', 'ACCEPT'],
];
const iptables = (op: string, rule: string[]) => (rule[0] === '-t' ? ['iptables', '-t', rule[1], op, ...rule.slice(2)] : ['iptables', op, ...rule]);
const FORWARD_SYSCTL = '/proc/sys/net/ipv4/ip_forward';

const run = (...cmd: string[]) => Bun.spawnSync(cmd);
function must(...cmd: string[]): void {
  const r = run(...cmd);
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString().trim()}`);
}

let flapTimer: ReturnType<typeof setInterval> | null = null;
let forwardWas: string | null = null;

export function netDown(): void {
  if (flapTimer) clearInterval(flapTimer);
  flapTimer = null;
  for (const pid of run('ip', 'netns', 'pids', NS).stdout.toString().split('\n').filter(Boolean)) run('kill', '-9', pid);
  run('ip', 'netns', 'del', NS);
  run('ip', 'link', 'del', HOST_IF);
  for (const rule of NAT_RULES) while (run(...iptables('-D', rule)).exitCode === 0);
  if (forwardWas !== null) writeFileSync(FORWARD_SYSCTL, forwardWas);
  forwardWas = null;
  rmSync(`/etc/netns/${NS}`, { recursive: true, force: true });
}

function netem(p: Profile, lossPct = p.lossPct ?? 0): string[] {
  return ['netem', 'limit', '10000', ...(p.delayMs ? ['delay', `${p.delayMs}ms`, ...(p.jitterMs ? [`${p.jitterMs}ms`] : [])] : []), 'loss', `${lossPct}%`];
}

function shape(prefix: string[], dev: string, p: Profile, rate: string | undefined): void {
  must(...prefix, 'tc', 'qdisc', 'add', 'dev', dev, 'root', 'handle', '1:', ...netem(p));
  if (rate) must(...prefix, 'tc', 'qdisc', 'add', 'dev', dev, 'parent', '1:1', 'handle', '10:', 'fq', 'maxrate', rate);
}

export function netUp(name: string, nat: boolean, onFlap: (down: boolean) => void): void {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile '${name}' (${Object.keys(PROFILES).join(', ')})`);
  netDown();
  must('ip', 'netns', 'add', NS);
  must('ip', 'link', 'add', HOST_IF, 'type', 'veth', 'peer', 'name', NS_IF);
  must('ip', 'link', 'set', NS_IF, 'netns', NS);
  must('ip', 'addr', 'add', `${HOST_IP}/24`, 'dev', HOST_IF);
  must('ip', 'link', 'set', HOST_IF, 'up');
  must(...NS_EXEC, 'ip', 'addr', 'add', `${NET}.2/24`, 'dev', NS_IF);
  must(...NS_EXEC, 'ip', 'link', 'set', NS_IF, 'up');
  must(...NS_EXEC, 'ip', 'link', 'set', 'lo', 'up');
  must(...NS_EXEC, 'ip', 'route', 'add', 'default', 'via', HOST_IP);
  if (nat) {
    const resolv = '/run/systemd/resolve/resolv.conf';
    const servers = (existsSync(resolv) ? readFileSync(resolv, 'utf8') : '').split('\n').filter(l => /^nameserver (?!127\.)/.test(l));
    mkdirSync(`/etc/netns/${NS}`, { recursive: true });
    writeFileSync(`/etc/netns/${NS}/resolv.conf`, `${(servers.length ? servers : ['nameserver 1.1.1.1']).join('\n')}\n`);
    const forward = readFileSync(FORWARD_SYSCTL, 'utf8').trim();
    if (forward !== '1') { forwardWas = forward; writeFileSync(FORWARD_SYSCTL, '1'); }
    for (const rule of NAT_RULES) must(...iptables(rule[0] === '-t' ? '-A' : '-I', rule));
  }
  if (p.udpBlocked) must(...NS_EXEC, 'iptables', '-A', 'OUTPUT', '-p', 'udp', '!', '--dport', '53', '-j', 'DROP');
  if (name === 'clean' || p.udpBlocked) return;
  shape([], HOST_IF, p, p.down);
  shape(NS_EXEC, NS_IF, p, p.up);
  if (!p.flap) return;
  const set = (lossPct: number | undefined) => {
    for (const [prefix, dev] of [[[], HOST_IF], [NS_EXEC, NS_IF]] as Array<[string[], string]>) {
      run(...prefix, 'tc', 'qdisc', 'change', 'dev', dev, 'root', 'handle', '1:', ...netem(p, lossPct));
    }
    onFlap(lossPct === 100);
  };
  flapTimer = setInterval(() => { set(100); setTimeout(() => set(undefined), p.flap!.downS * 1000); }, p.flap.everyS * 1000);
}

export function netChange(name: string): void {
  const p = PROFILES[name];
  if (!p || p.udpBlocked || p.flap) throw new Error(`cannot change to profile '${name}' during a run`);
  for (const [prefix, dev, rate] of [[[], HOST_IF, p.down], [NS_EXEC, NS_IF, p.up]] as Array<[string[], string, string | undefined]>) {
    run(...prefix, 'tc', 'qdisc', 'del', 'dev', dev, 'root');
    if (name !== 'clean') shape(prefix, dev, p, rate);
  }
}

export function netState(): string {
  return ['tc qdisc show', 'iptables -S', 'iptables -t nat -S', 'ip netns list', `ip -o link show ${HOST_IF}`]
    .map(c => `$ ${c}\n${run(...c.split(' ')).stdout.toString().trim()}`).join('\n');
}
