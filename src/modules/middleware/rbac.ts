/**
 * Role-Based Access Control (RBAC) for AI Gateway.
 *
 * Defines permission levels for API operations:
 * - `admin` — Full access including GPU management, config changes, user management
 * - `operator` — Can use the pipeline and manage their own GPUs, but not change global config
 * - `readonly` — Can only query status and health, no mutations
 *
 * API keys are assigned roles. Each endpoint checks the required role.
 *
 * @example
 * ```ts
 * import { createRoleChecker, ROLES } from './middleware/rbac';
 *
 * const checkRole = createRoleChecker(apiKeys);
 *
 * // In request handler:
 * const hasAccess = checkRole(apiKey, ROLES.ADMIN);
 * if (!hasAccess) return res.writeHead(403).end('Forbidden');
 * ```
 */

/** Role levels — higher number = more permissions */
export const ROLES = {
  READONLY: 1,
  OPERATOR: 2,
  ADMIN: 3,
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_NAMES: Record<Role, string> = {
  [ROLES.READONLY]: 'readonly',
  [ROLES.OPERATOR]: 'operator',
  [ROLES.ADMIN]: 'admin',
} as const;

/** API key to role mapping */
export interface RoleMapping {
  [apiKey: string]: Role;
}

/** Endpoint to required role mapping */
export interface EndpointRoleMap {
  [pathPrefix: string]: Role;
}

/** Default endpoint role mapping */
export const DEFAULT_ENDPOINT_ROLES: EndpointRoleMap = {
  // Read-only endpoints
  '/health': ROLES.READONLY,
  '/health/detail': ROLES.READONLY,
  '/metrics': ROLES.READONLY,
  '/v1/models': ROLES.READONLY,
  '/v1/gpu/status': ROLES.READONLY,
  '/v1/gpu/offers': ROLES.READONLY,
  '/v1/gpu/types': ROLES.READONLY,
  '/v1/gpu/location': ROLES.READONLY,
  '/v1/gpu/logs': ROLES.READONLY,

  // Operator endpoints
  '/v1/speech': ROLES.OPERATOR,
  '/v1/chat': ROLES.OPERATOR,
  '/v1/chat/completions': ROLES.OPERATOR,
  '/v1/audio': ROLES.OPERATOR,
  '/v1/gpu/deploy': ROLES.OPERATOR,
  '/v1/gpu/stop': ROLES.OPERATOR,
  '/v1/gpu/resume': ROLES.OPERATOR,
  '/v1/gpu/terminate': ROLES.OPERATOR,
  '/v1/gpu/sweep': ROLES.OPERATOR,

  // Admin-only endpoints
  '/v1/config': ROLES.ADMIN,
  '/v1/keys': ROLES.ADMIN,
  '/v1/labs': ROLES.ADMIN,
  '/v1/bot': ROLES.ADMIN,
  '/v1/workloads': ROLES.ADMIN,
} as const;

/**
 * Create a role checker from an API key to role mapping.
 */
export function createRoleChecker(roleMapping: RoleMapping) {
  return {
    /**
     * Check if an API key has at least the required role.
     */
    hasRole(apiKey: string, requiredRole: Role): boolean {
      const userRole = roleMapping[apiKey];
      if (userRole === undefined) return false;
      return userRole >= requiredRole;
    },

    /**
     * Get the role for an API key.
     */
    getRole(apiKey: string): Role | undefined {
      return roleMapping[apiKey];
    },

    /**
     * Get all API keys with a specific role.
     */
    getKeysWithRole(role: Role): string[] {
      return Object.entries(roleMapping)
        .filter(([, r]) => r === role)
        .map(([key]) => key);
    },
  };
}

/**
 * Check if an endpoint requires a specific role.
 */
export function getRequiredRoleForEndpoint(
  path: string,
  mapping: EndpointRoleMap = DEFAULT_ENDPOINT_ROLES,
): Role {
  // Default ADMIN (most-restrictive) on no-match — fail-CLOSED.
  let bestMatch: Role = ROLES.ADMIN;
  let bestMatchLength = 0;
  let matched = false;

  for (const [prefix, role] of Object.entries(mapping)) {
    if (path.startsWith(prefix) && prefix.length > bestMatchLength) {
      bestMatch = role;
      bestMatchLength = prefix.length;
      matched = true;
    }
  }

  if (!matched) return ROLES.ADMIN;
  return bestMatch;
}

/**
 * Assign roles to API keys from environment variable.
 *
 * Format: `key1:admin,key2:operator,key3:readonly`
 * If no role specified, defaults to operator.
 *
 * @example
 * ```ts
 * // RBAC_ROLES="sk-abc:admin,sk-def:operator"
 * const roles = parseRolesFromEnv();
 * ```
 */
export function parseRolesFromEnv(envVar = 'RBAC_ROLES'): RoleMapping {
  const raw = process.env[envVar];
  if (!raw) return {};

  const mapping: RoleMapping = {};
  const roleByName: Record<string, Role> = {
    admin: ROLES.ADMIN,
    operator: ROLES.OPERATOR,
    readonly: ROLES.READONLY,
  };

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [key, roleStr] = trimmed.split(':');
    if (!key || !key.trim()) {
      console.warn(`[rbac] Skipping empty key in ${envVar}: "${trimmed}"`);
      continue;
    }
    const normalizedRole = roleStr?.toLowerCase().trim() ?? '';
    if (!normalizedRole) {
      throw new Error(`[rbac] ${envVar} entry "${trimmed}" missing role (expected key:role)`);
    }
    const role = roleByName[normalizedRole];
    if (!role) {
      throw new Error(`[rbac] ${envVar} entry "${trimmed}" has unknown role "${roleStr}". Expected: admin, operator, readonly`);
    }
    mapping[key] = role;
  }

  return mapping;
}
