'use client';

import { useState, type ComponentType } from 'react';
import { useBotStatus } from '@/hooks/useBotStatus';
import { deployBot, joinMeeting, leaveBot, terminateBot } from '@/lib/gateway';
import { Card, CardHeader, CardBody, CardFooter, Button, FormInput, StatusBadge, AlertBanner, CardSectionHeader, Toggle, KV } from '@/components/ui';
import { Bot, Play, Square, LogIn, LogOut, RefreshCw, Copy, Check, ExternalLink, Cpu, Server, Cloud } from 'lucide-react';

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// 4-step timeline definition
const TIMELINE_STEPS = [
  { key: 'deploy', label: 'Deploy'  },
  { key: 'booting', label: 'Booting' },
  { key: 'ready',  label: 'Ready'   },
  { key: 'joined', label: 'Joined'  },
] as const;

function getStepIndex(status: string): number {
  if (status === 'booting') return 1;
  if (status === 'ready')   return 2;
  if (status === 'joined')  return 3;
  return 0;
}

type DeployMode = 'cpu' | 'gpu' | 'local';

const DEPLOY_OPTIONS: { mode: DeployMode; label: string; desc: string; icon: ComponentType<{ className?: string }> }[] = [
  { mode: 'cpu',   label: 'CPU Pod',      desc: 'RunPod CPU — ~60s boot',     icon: Server },
  { mode: 'gpu',   label: 'GPU Pod',      desc: 'RunPod GPU — more RAM',       icon: Cpu   },
  { mode: 'local', label: 'Cloud Docker', desc: 'Local Docker daemon',         icon: Cloud },
];

export function BotSection() {
  const { bot, error: botError, refresh } = useBotStatus(true, 5000);
  const [cpuOnly, setCpuOnly] = useState(true);
  const [localDeploy, setLocalDeploy] = useState(false);
  const [meetingUrl, setMeetingUrl] = useState('');
  const [botName, setBotName] = useState('BabelCast Bot');
  const [deploying, setDeploying] = useState(false);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Derive deploy mode from cpuOnly + localDeploy (keeps original state logic)
  const deployMode: DeployMode = localDeploy ? 'local' : cpuOnly ? 'cpu' : 'gpu';

  function setDeployMode(mode: DeployMode) {
    if (mode === 'local') {
      setLocalDeploy(true);
      setCpuOnly(true);
    } else if (mode === 'cpu') {
      setLocalDeploy(false);
      setCpuOnly(true);
    } else {
      setLocalDeploy(false);
      setCpuOnly(false);
    }
  }

  const isIdle = !bot || bot.status === 'idle';
  const canJoin = bot && (bot.status === 'ready' || bot.status === 'booting');
  const isJoined = bot && bot.status === 'joined';
  const isActive = bot && bot.status !== 'idle';

  // URL validation
  const urlValid = meetingUrl.trim().length > 0 && (() => {
    try { new URL(meetingUrl.trim()); return true; } catch { return false; }
  })();
  const urlInvalid = meetingUrl.trim().length > 0 && !urlValid;

  async function handleDeploy() {
    setDeploying(true);
    setActionError(null);
    try {
      await deployBot({ cpuOnly, local: localDeploy });
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }

  async function handleJoin() {
    if (!meetingUrl.trim()) return;
    setJoining(true);
    setActionError(null);
    try {
      await joinMeeting({ meetingUrl, botName });
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Join failed');
    } finally {
      setJoining(false);
    }
  }

  async function handleLeave() {
    setLeaving(true);
    setActionError(null);
    try {
      await leaveBot();
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Leave failed');
    } finally {
      setLeaving(false);
    }
  }

  async function handleTerminate() {
    setTerminating(true);
    setActionError(null);
    try {
      await terminateBot();
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Terminate failed');
    } finally {
      setTerminating(false);
    }
  }

  function copyEndpoint() {
    if (!bot?.endpoint) return;
    navigator.clipboard.writeText(bot.endpoint).then(() => {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    });
  }

  const currentStepIndex = isActive ? getStepIndex(bot!.status) : -1;

  return (
    <div className="p-6 space-y-6">
      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}
      {botError && <AlertBanner variant="warning">Cannot fetch bot status</AlertBanner>}

      {/* Deploy Card — visible always; form shown in idle state */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Bot} color="violet" title="Bot Pod" subtitle="Deploy a Meeting BaaS bot pod" />
        </CardHeader>
        <CardBody className="space-y-5">
          {isIdle ? (
            <>
              {/* Segmented deploy mode selector */}
              <div>
                <div className="text-xs font-medium mb-3" style={{ color: 'var(--color-text-muted)' }}>Deployment Target</div>
                <div
                  className="grid grid-cols-3 gap-2 p-1 rounded-xl"
                  style={{ background: 'var(--color-surface)' }}
                >
                  {DEPLOY_OPTIONS.map(({ mode, label, desc, icon: Icon }) => {
                    const active = deployMode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => setDeployMode(mode)}
                        className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg text-center transition-all"
                        style={{
                          background: active ? 'var(--color-surface-elevated)' : 'transparent',
                          color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
                          boxShadow: active ? '0 0 0 1px var(--color-border)' : 'none',
                          outline: 'none',
                        }}
                      >
                        <span style={{ color: active ? '#a78bfa' : 'var(--color-text-muted)' }}>
                          <Icon className="w-4 h-4" />
                        </span>
                        <span className="text-xs font-semibold">{label}</span>
                        <span className="text-xs leading-tight" style={{ color: 'var(--color-text-muted)' }}>{desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Empty state cue */}
              <div
                className="flex flex-col items-center gap-3 py-6 rounded-xl"
                style={{ background: 'var(--color-surface)' }}
              >
                <Bot className="w-12 h-12 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
                <div className="text-center">
                  <div className="font-medium mb-0.5" style={{ color: 'var(--color-text)' }}>No bot deployed</div>
                  <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    Deploy a {deployMode === 'local' ? 'local Docker' : deployMode === 'cpu' ? 'CPU' : 'GPU'} pod to get started
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* Active state: 4-step timeline */
            <div className="py-2">
              <div className="relative flex items-start justify-between">
                {/* Connecting line */}
                <div
                  className="absolute top-4 left-0 right-0 h-px"
                  style={{ background: 'var(--color-border)', zIndex: 0 }}
                />
                {TIMELINE_STEPS.map((step, idx) => {
                  const isDone    = idx < currentStepIndex;
                  const isCurrent = idx === currentStepIndex;
                  const isFuture  = idx > currentStepIndex;
                  const dotColor  = isDone ? '#34d399' : isCurrent ? '#a78bfa' : 'var(--color-border)';
                  return (
                    <div key={step.key} className="relative flex flex-col items-center gap-2 flex-1" style={{ zIndex: 1 }}>
                      {/* Dot */}
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center transition-all"
                        style={{
                          background: isDone
                            ? 'color-mix(in srgb, #34d399 20%, var(--color-surface))'
                            : isCurrent
                            ? 'color-mix(in srgb, #a78bfa 20%, var(--color-surface))'
                            : 'var(--color-surface)',
                          border: `2px solid ${dotColor}`,
                          boxShadow: isCurrent
                            ? '0 0 10px color-mix(in srgb, #a78bfa 40%, transparent)'
                            : 'none',
                        }}
                      >
                        {isDone ? (
                          <Check className="w-3.5 h-3.5" style={{ color: '#34d399' }} />
                        ) : (
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ background: isCurrent ? '#a78bfa' : 'var(--color-border)' }}
                          />
                        )}
                      </div>
                      {/* Label */}
                      <span
                        className="text-xs font-medium"
                        style={{
                          color: isFuture ? 'var(--color-text-muted)' : isCurrent ? '#a78bfa' : '#34d399',
                        }}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardBody>
        <CardFooter>
          <div className="flex gap-3">
            <Button onClick={handleDeploy} isLoading={deploying} loadingText="Deploying..." disabled={!isIdle}>
              <Play className="w-4 h-4" /> Deploy Bot
            </Button>
            <Button variant="danger" onClick={handleTerminate} isLoading={terminating} loadingText="Stopping..." disabled={isIdle}>
              <Square className="w-4 h-4" /> Terminate
            </Button>
          </div>
        </CardFooter>
      </Card>

      {/* Status Card — shown when bot is active */}
      {bot && bot.status !== 'idle' && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <h3 className="font-semibold">Bot Status</h3>
              <StatusBadge variant={bot.status === 'joined' ? 'emerald' : bot.status === 'error' ? 'red' : 'amber'}>{bot.status}</StatusBadge>
              <Button variant="ghost" size="sm" onClick={refresh}><RefreshCw className="w-3 h-3" /></Button>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            {/* Pod ID — monospace with truncation */}
            {bot.podId && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Pod</span>
                <span
                  className="font-mono text-xs px-2 py-1 rounded-md max-w-[200px] truncate"
                  style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)' }}
                  title={bot.podId}
                >
                  {bot.podId}
                </span>
              </div>
            )}

            {/* Endpoint — clickable link + copy button */}
            {bot.endpoint && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Endpoint</span>
                <div className="flex items-center gap-2 min-w-0">
                  <a
                    href={bot.endpoint}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs truncate max-w-[180px] hover:underline flex items-center gap-1"
                    style={{ color: '#38bdf8' }}
                    title={bot.endpoint}
                  >
                    {bot.endpoint}
                    <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-70" />
                  </a>
                  <button
                    onClick={copyEndpoint}
                    className="flex-shrink-0 p-1 rounded hover:opacity-70 transition-opacity"
                    title="Copy endpoint"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {copiedUrl
                      ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                      : <Copy className="w-3.5 h-3.5" />
                    }
                  </button>
                </div>
              </div>
            )}

            {bot.meetingUrl && <KV label="Meeting" value={bot.meetingUrl} mono />}
            {bot.botId && <KV label="Bot ID" value={bot.botId} mono />}

            {/* Uptime badge */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Elapsed</span>
              <span
                className="text-xs font-mono px-2 py-0.5 rounded-full font-semibold"
                style={{
                  background: 'color-mix(in srgb, #34d399 12%, transparent)',
                  color: '#34d399',
                }}
              >
                {formatUptime(bot.elapsedSec)}
              </span>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Join Meeting */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={LogIn} color="sky" title="Join Meeting" subtitle="Send bot to a meeting" />
        </CardHeader>
        <CardBody className="space-y-4">
          {/* Meeting URL with validation indicator */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Meeting URL</label>
            <div className="relative">
              <input
                type="url"
                value={meetingUrl}
                onChange={e => setMeetingUrl(e.target.value)}
                placeholder="https://teams.microsoft.com/l/meetup-join/..."
                className="w-full rounded-lg px-3 py-2 text-sm pr-8 outline-none focus:ring-1"
                style={{
                  background: 'var(--color-surface)',
                  border: `1px solid ${urlInvalid ? '#f87171' : urlValid ? '#34d399' : 'var(--color-border)'}`,
                  color: 'var(--color-text)',
                  caretColor: 'var(--color-text)',
                }}
              />
              {meetingUrl.trim().length > 0 && (
                <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                  {urlValid
                    ? <Check className="w-4 h-4 text-emerald-400" />
                    : <span className="text-red-400 text-xs font-bold">✕</span>
                  }
                </div>
              )}
            </div>
            {urlInvalid && (
              <p className="text-xs text-red-400">Enter a valid URL (https://...)</p>
            )}
          </div>

          <FormInput
            label="Bot Name"
            value={botName}
            onChange={e => setBotName(e.target.value)}
          />
        </CardBody>
        <CardFooter>
          <div className="flex gap-3">
            <Button onClick={handleJoin} isLoading={joining} loadingText="Joining..." disabled={!canJoin || !urlValid}>
              <LogIn className="w-4 h-4" /> Join
            </Button>
            <Button variant="outline" onClick={handleLeave} isLoading={leaving} loadingText="Leaving..." disabled={!isJoined}>
              <LogOut className="w-4 h-4" /> Leave
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
