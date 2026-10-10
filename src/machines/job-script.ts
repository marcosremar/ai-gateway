import type { JobInputSpec } from './spec';

export const JOB_REPORT_PATH = '/v1/job-report';
export const JOB_LOG_LIMIT = 64 * 1024;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function jobScript(job: JobInputSpec & { id: string; token: string; reportUrl: string }): string {
  const lines = [
    `J=${quote(job.id)}; T=${quote(job.token)}; R=${quote(job.reportUrl)}; L=/job/job.log`,
    'mkdir -p /job && cd /job && : > "$L"',
    'rep() { tail -c ' + JOB_LOG_LIMIT + ' "$L" | curl -fsS -m 30 -X POST "$R" -H "x-job-id: $J" -H "x-job-token: $T" -H "x-job-status: $1" '
      + '-H "x-job-exit: ${2:-}" -H "x-job-result-bytes: ${3:-}" -H "x-job-result-sha256: ${4:-}" --data-binary @- > /dev/null 2>&1 || true; }',
    'rep running',
    '( while sleep 60; do rep running; done ) & HB=$!',
    'fail() { kill "$HB" 2>/dev/null; echo "aigw: $2" >> "$L"; rep failed "$1"; exit 1; }',
    ...job.inputs.map(f => `mkdir -p "$(dirname ${quote(f.path)})" && curl -fsSL --retry 3 -o ${quote(f.path)} ${quote(f.url)} >> "$L" 2>&1 || fail 90 ${quote(`input ${f.path} download failed`)}`),
    `bash -c ${quote(job.command)} >> "$L" 2>&1; C=$?`,
    'B=; S=',
  ];
  if (job.output) {
    lines.push(
      `tar -czf /job/.result.tgz -C "$(dirname ${quote(job.output.path)})" "$(basename ${quote(job.output.path)})" >> "$L" 2>&1 || fail 91 'result missing'`,
      `curl -fsS --retry 3 -X PUT --upload-file /job/.result.tgz ${quote(job.output.url)} >> "$L" 2>&1 || fail 92 'result upload failed'`,
      'B=$(wc -c < /job/.result.tgz | tr -d " "); S=$(sha256sum /job/.result.tgz | cut -d" " -f1)',
    );
  }
  lines.push('kill "$HB" 2>/dev/null', 'if [ "$C" -eq 0 ]; then rep succeeded 0 "$B" "$S"; else rep failed "$C" "$B" "$S"; fi');
  return lines.join('\n');
}
