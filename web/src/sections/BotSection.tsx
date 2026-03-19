'use client';

import { useState } from 'react';
import { useBotStatus } from '@/hooks/useBotStatus';
import { deployBot, joinMeeting, leaveBot, terminateBot } from '@/lib/gateway';
import { Card, CardHeader, CardBody, CardFooter, Button, FormInput, StatusBadge, AlertBanner, CardSectionHeader, Toggle, KV } from '@/components/ui';
import { Bot, Play, Square, LogIn, LogOut, RefreshCw } from 'lucide-react';

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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

  const isIdle = !bot || bot.status === 'idle';
  const canJoin = bot && (bot.status === 'ready' || bot.status === 'booting');
  const isJoined = bot && bot.status === 'joined';

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

  return (
    <div className="p-6 space-y-6">
      {actionError && <AlertBanner variant="error">{actionError}</AlertBanner>}
      {botError && <AlertBanner variant="warning">Cannot fetch bot status</AlertBanner>}

      {/* Deploy */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={Bot} color="violet" title="Bot Pod" subtitle="Deploy a Meeting BaaS bot pod" />
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <Toggle checked={cpuOnly} onChange={setCpuOnly} />
              <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>CPU only</span>
            </div>
            <div className="flex items-center gap-3">
              <Toggle checked={localDeploy} onChange={setLocalDeploy} />
              <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>Local Docker</span>
            </div>
          </div>
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

      {/* Status */}
      {bot && bot.status !== 'idle' && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <h3 className="font-semibold">Bot Status</h3>
              <StatusBadge variant={bot.status === 'joined' ? 'emerald' : bot.status === 'error' ? 'red' : 'amber'}>{bot.status}</StatusBadge>
              <Button variant="ghost" size="sm" onClick={refresh}><RefreshCw className="w-3 h-3" /></Button>
            </div>
          </CardHeader>
          <CardBody className="text-sm space-y-2">
            {bot.podId && <KV label="Pod" value={bot.podId} />}
            {bot.endpoint && <KV label="Endpoint" value={bot.endpoint} mono />}
            {bot.meetingUrl && <KV label="Meeting" value={bot.meetingUrl} mono />}
            {bot.botId && <KV label="Bot ID" value={bot.botId} mono />}
            <KV label="Elapsed" value={formatUptime(bot.elapsedSec)} />
          </CardBody>
        </Card>
      )}

      {/* Join Meeting */}
      <Card>
        <CardHeader>
          <CardSectionHeader icon={LogIn} color="sky" title="Join Meeting" subtitle="Send bot to a meeting" />
        </CardHeader>
        <CardBody className="space-y-4">
          <FormInput
            label="Meeting URL"
            value={meetingUrl}
            onChange={e => setMeetingUrl(e.target.value)}
            placeholder="https://teams.microsoft.com/l/meetup-join/..."
          />
          <FormInput
            label="Bot Name"
            value={botName}
            onChange={e => setBotName(e.target.value)}
          />
        </CardBody>
        <CardFooter>
          <div className="flex gap-3">
            <Button onClick={handleJoin} isLoading={joining} loadingText="Joining..." disabled={!canJoin || !meetingUrl.trim()}>
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