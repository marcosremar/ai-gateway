'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getVoiceProfileStatus, resetVoiceProfile, uploadVoiceReference,
  type VoiceProfileStatus,
} from '@/lib/gateway';
import {
  Card, CardHeader, CardBody, CardFooter, Button, AlertBanner, CardSectionHeader, ConfirmModal, useToast,
} from '@/components/ui';
import { Mic, Upload, Trash2, RefreshCw, CheckCircle2 } from 'lucide-react';

export function VoiceSection() {
  const [status, setStatus] = useState<VoiceProfileStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getVoiceProfileStatus();
      setStatus(s);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await uploadVoiceReference(file);
      setSuccess(result.message || 'Voice sample uploaded');
      toast('Voice sample uploaded', 'success');
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      toast('Upload failed', 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleReset() {
    setResetting(true);
    setError(null);
    setSuccess(null);
    setConfirmReset(false);
    try {
      await resetVoiceProfile();
      setSuccess('Voice profile reset');
      toast('Voice profile reset', 'info');
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
      toast('Reset failed', 'error');
    } finally { setResetting(false); }
  }

  const totalSec = status?.totalDurationSec ?? 0;
  const minSec   = status?.minDurationSec   ?? 15;
  const progress = minSec > 0 ? Math.min(100, (totalSec / minSec) * 100) : 0;

  return (
    <div className="p-6 space-y-6">
      {error && <AlertBanner variant="error">{error}</AlertBanner>}
      {success && <AlertBanner variant="success">{success}</AlertBanner>}

      <Card>
        <CardHeader>
          <CardSectionHeader icon={Mic} color="rose" title="Voice Cloning" subtitle="Upload voice samples for TTS voice cloning" />
        </CardHeader>
        <CardBody className="space-y-4">
          {/* GPU unavailable notice */}
          {status && status.state !== 'available' && (
            <AlertBanner variant="warning">
              {status.state === 'unavailable' ? 'No GPU pod active — deploy a GPU to enable voice cloning.' : 'Could not reach GPU pod.'}
            </AlertBanner>
          )}

          {/* How it works */}
          <div className="p-4 rounded-xl space-y-2" style={{ background: 'var(--color-surface)' }}>
            <div className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>How it works</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg)' }}>
                <div className="font-semibold mb-1" style={{ color: '#f43f5e' }}>1. Upload Samples</div>
                Upload audio clips of the target speaker. At least 15 seconds of total audio is needed for cloning.
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg)' }}>
                <div className="font-semibold mb-1" style={{ color: '#a78bfa' }}>2. Build Profile</div>
                The system extracts voice characteristics, detects gender, and builds a speaker embedding automatically.
              </div>
              <div className="p-3 rounded-lg" style={{ background: 'var(--color-bg)' }}>
                <div className="font-semibold mb-1" style={{ color: '#34d399' }}>3. Clone Voice</div>
                TTS output uses the cloned voice when the GPU is deployed and the profile is ready.
              </div>
            </div>
          </div>

          {/* Status */}
          {status && (
            <div className="p-4 rounded-xl" style={{ background: 'var(--color-surface)' }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold">Profile Status</span>
                <Button variant="ghost" size="sm" onClick={fetchStatus}>
                  <RefreshCw className="w-3 h-3" />
                </Button>
              </div>

              {/* Progress bar */}
              <div className="space-y-2 mb-3">
                <div className="flex items-center justify-between text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  <span>{totalSec.toFixed(1)}s / {minSec}s accumulated</span>
                  <span className="font-mono">{progress.toFixed(0)}%</span>
                </div>
                <div className="h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                  <div
                    className="h-2.5 rounded-full transition-all duration-500"
                    style={{
                      width: `${progress}%`,
                      background: status.ready
                        ? '#34d399'
                        : progress > 50
                        ? 'linear-gradient(90deg, #60a5fa, #a78bfa)'
                        : '#60a5fa',
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatBox
                  value={status.ready ? <CheckCircle2 className="w-5 h-5 inline" style={{ color: '#34d399' }} /> : `${progress.toFixed(0)}%`}
                  label={status.ready ? 'Ready' : 'Building'}
                  color={status.ready ? '#34d399' : undefined}
                />
                <StatBox value={String(status.samplesCount)} label="Samples" />
                <StatBox value={`${totalSec.toFixed(1)}s`} label="Duration" />
                <StatBox value={status.gender || '\u2014'} label="Gender" />
              </div>
            </div>
          )}

          {loading && !status && (
            <div className="text-sm text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
              Loading voice profile...
            </div>
          )}
        </CardBody>
        <CardFooter>
          <div className="flex gap-3">
            <label
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium cursor-pointer transition-colors ${
                uploading ? 'opacity-50 pointer-events-none' : ''
              }`}
              style={{ background: 'var(--color-btn-primary-bg)', color: 'white' }}
            >
              <Upload className="w-4 h-4" />
              {uploading ? 'Uploading...' : 'Upload Audio'}
              <input
                ref={fileInputRef} type="file" accept="audio/*"
                className="hidden" onChange={handleUpload} disabled={uploading}
              />
            </label>
            <Button
              variant="danger" onClick={() => setConfirmReset(true)}
              isLoading={resetting} loadingText="Resetting..."
              disabled={!status || status.samplesCount === 0}
            >
              <Trash2 className="w-4 h-4" /> Reset Profile
            </Button>
          </div>
        </CardFooter>
      </Card>

      {/* Confirm reset */}
      <ConfirmModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={handleReset}
        title="Reset Voice Profile?"
        description="This will delete all uploaded voice samples and reset the speaker profile. You will need to upload new samples to re-enable voice cloning."
        confirmLabel="Reset"
        variant="danger"
        isLoading={resetting}
      />
    </div>
  );
}

function StatBox({ value, label, color }: { value: React.ReactNode; label: string; color?: string }) {
  return (
    <div className="text-center p-2 rounded-lg" style={{ background: 'var(--color-bg)' }}>
      <div className="text-lg font-bold font-mono" style={{ color: color || 'var(--color-text)' }}>{value}</div>
      <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
    </div>
  );
}
