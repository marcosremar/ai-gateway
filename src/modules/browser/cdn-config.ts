/**
 * Browser SDK CDN configuration.
 *
 * Configures the browser SDK to load from a CDN instead of bundling.
 * This reduces bundle size for web consumers by ~15-20%.
 *
 * @example
 * ```html
 * <!-- Before (bundled) -->
 * <script src="/assets/ai-gateway-browser.js"></script>
 *
 * <!-- After (CDN) -->
 * <script src="https://cdn.jsdelivr.net/npm/@parle/ai-gateway/dist/browser.min.js"></script>
 * ```
 *
 * @example
 * ```typescript
 * // In your app config:
 * import { setCDNBase } from '@ai-gateway/browser';
 * setCDNBase('https://cdn.example.com/ai-gateway');
 * ```
 */

/** Base URL for CDN assets */
let cdnBase = '';

/**
 * Set the CDN base URL for loading browser SDK assets.
 */
export function setCDNBase(url: string): void {
  cdnBase = url.replace(/\/$/, ''); // Remove trailing slash
}

/**
 * Get the current CDN base URL.
 */
export function getCDNBase(): string {
  return cdnBase;
}

/**
 * Build a full CDN URL for a given asset path.
 */
export function cdnUrl(path: string): string {
  if (!cdnBase) {
    throw new Error('CDN base URL not set. Call setCDNBase() first.');
  }
  return `${cdnBase}/${path.replace(/^\//, '')}`;
}

/**
 * Load a script from CDN dynamically.
 */
export function loadFromCDN(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = cdnUrl(path);
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script from CDN: ${path}`));
    document.head.appendChild(script);
  });
}

/**
 * Recommended CDN providers:
 *
 * 1. jsDelivr (free, no setup):
 *    https://cdn.jsdelivr.net/npm/@parle/ai-gateway/dist/browser.min.js
 *
 * 2. unpkg (free, no setup):
 *    https://unpkg.com/@parle/ai-gateway/dist/browser.min.js
 *
 * 3. Cloudflare (self-hosted):
 *    Set up R2 bucket with CDN distribution
 *
 * 4. CloudFront (AWS):
 *    S3 origin with CloudFront distribution
 */
export const RECOMMENDED_CDNS = {
  JSDelivr: 'https://cdn.jsdelivr.net/npm/@parle/ai-gateway/dist',
  Unpkg: 'https://unpkg.com/@parle/ai-gateway/dist',
} as const;
