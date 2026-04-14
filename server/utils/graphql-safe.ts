/**
 * Safe GraphQL queries — prevents GraphQL injection.
 *
 * Fixes: #386 (GraphQL injection), #401 (parameterized queries)
 *
 * Usage:
 * ```ts
 * import { graphqlQuery } from './graphql-safe';
 *
 * // Instead of: `{ pod(input: {podId: "${podId}"}) { ... } }`
 * const result = await graphqlQuery(endpoint, PodQuery, { podId });
 * ```
 */

import { createLogger } from '../../src/logger';

const log = createLogger('graphql-safe');

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
}

export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: GraphQLError[];
}

/**
 * Validate a GraphQL query/mutation string for safety.
 * Rejects queries with string interpolation patterns.
 */
export function validateGraphQLQuery(query: string): void {
  // Reject queries with template literal patterns
  const dangerousPatterns = [
    /\$\{[^}]*\}/, // Template literals
    /'\s*\+\s*'/, // String concatenation
    /"\s*\+\s*"/,
    /;\s*DROP\s/i, // SQL injection through GraphQL
    /;\s*DELETE\s/i,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(query)) {
      throw new Error('GraphQL query contains potentially dangerous patterns');
    }
  }
}

/**
 * Execute a GraphQL query with parameterized variables.
 *
 * @example
 * ```ts
 * const PodQuery = `
 *   query GetPod($podId: String!) {
 *     pod(input: { podId: $podId }) {
 *       machine { dataCenterId }
 *     }
 *   }
 * `;
 *
 * const result = await graphqlQuery(endpoint, PodQuery, { podId });
 * ```
 */
export async function graphqlQuery<T = unknown>(
  endpoint: string,
  query: string,
  variables: Record<string, unknown> = {},
  apiKey?: string,
  timeoutMs = 10_000,
): Promise<GraphQLResponse<T>> {
  // Validate query for injection patterns
  validateGraphQLQuery(query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as GraphQLResponse<T>;

    if (result.errors && result.errors.length > 0) {
      log.error(
        { errors: result.errors.map((e) => e.message) },
        'GraphQL errors returned',
      );
    }

    return result;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

/**
 * Build a safe GraphQL query with typed variables.
 */
export function buildGraphQLQuery(
  operation: string,
  fields: string[],
  variables: Record<string, { type: string; value: unknown }> = {},
): { query: string; variables: Record<string, unknown> } {
  const varDefinitions = Object.entries(variables)
    .map(([name, { type }]) => `$${name}: ${type}!`)
    .join(', ');

  const varUsage = Object.entries(variables)
    .map(([name]) => `${name}: $${name}`)
    .join(', ');

  const query = `
    ${operation}(${varDefinitions}) {
      ${fields.join('\n      ')}
    }
  `;

  const varValues = Object.fromEntries(
    Object.entries(variables).map(([name, { value }]) => [name, value]),
  );

  return { query, variables: varValues };
}
