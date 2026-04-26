/**
 * Bug: renderStatusHtml() interpolates user-controlled fields directly
 * into the response HTML without escaping:
 *   - Provider id, type
 *   - GPU type, podId, status
 *   - Version, timestamp
 *
 * Several of these come from external sources (provider API instance
 * names, gpu types from RunPod/Vast, version from package.json or env).
 * If any contains "<script>...</script>" it executes when an admin
 * opens /status in a browser. This is stored XSS via the status page.
 */
import { describe, it, expect } from 'vitest';
import { renderStatusHtml } from '../../src/middleware/status-page';

describe('renderStatusHtml — escapes user-controlled fields', () => {
  it('does NOT inject raw <script> from provider id', () => {
    const html = renderStatusHtml({
      version: '1.0.0',
      uptimeSec: 100,
      timestamp: '2026-04-26T00:00:00Z',
      healthy: true,
      providers: [
        {
          id: '<script>alert("xss")</script>',
          type: 'llm',
          healthy: true,
          lastChecked: '2026-04-26T00:00:00Z',
        },
      ],
      gpu: { available: true },
      requests: { total: 0, lastMinute: 0 },
    });
    // Raw <script> must not appear unescaped in the output.
    expect(html).not.toContain('<script>alert("xss")</script>');
    // The escaped form should be present so the data is still visible.
    expect(html).toContain('&lt;script&gt;');
  });

  it('does NOT inject raw <script> from GPU podId', () => {
    const html = renderStatusHtml({
      version: '1.0.0',
      uptimeSec: 100,
      timestamp: '2026-04-26T00:00:00Z',
      healthy: true,
      providers: [],
      gpu: { available: true, podId: '"><img src=x onerror=alert(1)>' },
      requests: { total: 0, lastMinute: 0 },
    });
    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
  });
});
