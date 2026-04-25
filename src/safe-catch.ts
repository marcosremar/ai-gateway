/**
 * Safe Error Handling — Utilities for consistent error handling
 * 
 * Replaces empty catch blocks with proper logging and error tracking.
 */

import { createLogger } from './logger';

const log = createLogger('safe-catch');

/**
 * Safely execute a promise and log errors instead of swallowing them
 */
export async function safePromise<T>(
  promise: Promise<T>,
  context: string,
  options: {
    logSuccess?: boolean;
    defaultValue?: T;
    rethrow?: boolean;
  } = {}
): Promise<T | undefined> {
  const { logSuccess = false, defaultValue, rethrow = false } = options;
  
  try {
    const result = await promise;
    if (logSuccess) {
      log.debug(`[${context}] Operation succeeded`);
    }
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[${context}] Operation failed: ${errorMsg}`);
    
    if (rethrow) {
      throw err;
    }
    
    return defaultValue;
  }
}

/**
 * Safely execute a synchronous function and log errors
 */
export function safeSync<T>(
  fn: () => T,
  context: string,
  options: {
    defaultValue?: T;
    rethrow?: boolean;
  } = {}
): T | undefined {
  const { defaultValue, rethrow = false } = options;
  
  try {
    return fn();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[${context}] Sync operation failed: ${errorMsg}`);
    
    if (rethrow) {
      throw err;
    }
    
    return defaultValue;
  }
}

/**
 * Safely close a resource (client, connection, etc.)
 * Replaces: await client.end().catch(() => {})
 */
export async function safeClose(
  closeable: { close?: () => Promise<void>; end?: () => Promise<void>; destroy?: () => void } | null | undefined,
  context: string
): Promise<void> {
  if (!closeable) return;
  
  try {
    if (closeable.close) {
      await closeable.close();
    } else if (closeable.end) {
      await closeable.end();
    } else if (closeable.destroy) {
      closeable.destroy();
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.debug(`[${context}] Close operation failed (may already be closed): ${errorMsg}`);
    // Intentionally not rethrowing - close errors are usually benign
  }
}

/**
 * Safely cleanup multiple resources
 */
export async function safeCleanup(
  resources: Array<{ name: string; resource: { close?: () => Promise<void>; end?: () => Promise<void>; destroy?: () => void } | null | undefined }>
): Promise<void> {
  for (const { name, resource } of resources) {
    await safeClose(resource, name);
  }
}

/**
 * Create a safe version of a catch handler that logs but doesn't throw
 * Usage: .catch(safeCatch('context'))
 */
export function safeCatch(context: string): (err: unknown) => void {
  return (err: unknown) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[${context}] Caught error: ${errorMsg}`);
  };
}

/**
 * Wrap a promise with timeout and proper error handling
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${context} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  // Clear the timer once the underlying promise settles so the Node event
  // loop can exit instead of being held open by a pending rejection.
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
