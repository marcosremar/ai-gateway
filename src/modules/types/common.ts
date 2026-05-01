/**
 * Common Types — Replacing 'any' with proper TypeScript types
 */

/**
 * Generic JSON value type - replaces 'any' for JSON data
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonArray extends Array<JsonValue> {}

/**
 * API Response types
 */
export interface ApiResponse<T = JsonValue> {
  data?: T;
  error?: ApiError;
  status: number;
  ok: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: JsonObject;
}

/**
 * HTTP Request/Response body types
 */
export type RequestBody = JsonObject | FormData | string | Buffer | undefined;
export type ResponseBody = JsonValue | Buffer | ArrayBuffer;

/**
 * Provider configuration type
 */
export interface ProviderConfig {
  apiKey?: string;
  authId?: string;
  endpoint?: string;
  timeout?: number;
  retries?: number;
}

/**
 * GPU Instance types
 */
export interface GpuInstance {
  id: string;
  provider: string;
  status: 'creating' | 'running' | 'stopped' | 'error' | 'terminated';
  endpoint?: string;
  gpuType?: string;
  costPerHr?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Deployment state type
 */
export type DeploymentStatus =
  | 'idle'
  | 'creating'
  | 'booting'
  | 'ready'
  | 'error'
  | 'stopped'
  | 'terminated';

export interface DeploymentState {
  status: DeploymentStatus;
  deployId: string;
  podId?: string;
  endpoint?: string;
  gpuType?: string;
  dockerImage?: string;
  message?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Logger interface
 */
export interface Logger {
  debug: (message: string, meta?: JsonObject) => void;
  log: (message: string, meta?: JsonObject) => void;
  info: (message: string, meta?: JsonObject) => void;
  warn: (message: string, meta?: JsonObject) => void;
  error: (message: string, meta?: JsonObject) => void;
}

/**
 * Event handler types
 */
export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;
export type AsyncEventHandler<T = unknown> = (data: T) => Promise<void>;

/**
 * Result type for operations that can fail
 */
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

/**
 * Optional type alias
 */
export type Optional<T> = T | undefined | null;

/**
 * Record with string keys and typed values
 */
export type StringRecord<T> = Record<string, T>;

/**
 * Deep partial type
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Nullable type
 */
export type Nullable<T> = T | null;

/**
 * Safe type for unknown values
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}
