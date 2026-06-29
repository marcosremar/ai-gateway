/**
 * Unit tests for server/utils/graphql-safe.ts
 *
 * Covers: validateGraphQLQuery (safe queries, template literal injection,
 * string concatenation injection, SQL injection through GraphQL, case
 * insensitivity, edge cases) and buildGraphQLQuery (no variables, single
 * variable, multiple variables, fields, returned variables map).
 *
 * graphqlQuery is intentionally excluded — it makes network calls and is
 * covered by integration tests.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/logger', () => ({
  createLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  validateGraphQLQuery,
  buildGraphQLQuery,
} from '../../server/utils/graphql-safe';

// ── validateGraphQLQuery — safe queries ──────────────────────────────────────

describe('validateGraphQLQuery — safe queries', () => {
  it('accepts a plain query string with no variables', () => {
    const query = `query { pods { id status } }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts a query with GraphQL dollar-sign variables ($podId)', () => {
    const query = `query GetPod($podId: String!) { pod(input: { podId: $podId }) { id } }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts a mutation with multiple typed variables', () => {
    const query = `
      mutation CreatePod($gpuType: String!, $imageId: String!, $cloudType: CloudTypeEnum!) {
        podFindAndDeployOnDemand(input: { gpuTypeId: $gpuType, imageName: $imageId, cloudType: $cloudType }) {
          id
        }
      }
    `;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts an empty string without throwing', () => {
    expect(() => validateGraphQLQuery('')).not.toThrow();
  });

  it('accepts a query with double-quoted string literals (not concatenation)', () => {
    // "foo" alone is fine; only "foo" + "bar" triggers the rule
    const query = `query { pod(status: "RUNNING") { id } }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts a query with single-quoted string literals (not concatenation)', () => {
    const query = `query { pod(region: 'US-TX') { id } }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts queries with nested braces in variable types', () => {
    const query = `query($filter: FilterInput!) { pods(filter: $filter) { id } }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts a query with semicolons not followed by DROP/DELETE', () => {
    // semicolons in comments or descriptions are fine
    const query = `# note: use $id; always required\nquery GetPod($id: String!) { pod(input:{podId:$id}){id} }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('accepts a query with DROP as part of a field name (not ;DROP)', () => {
    const query = `query { dropdownOptions { label value } }`;
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });
});

// ── validateGraphQLQuery — template literal injection ────────────────────────

describe('validateGraphQLQuery — template literal injection', () => {
  it('rejects ${variable} interpolation', () => {
    const query = `{ pod(input: {podId: "${`${'user-supplied-id'}`}"}) { id } }`;
    // Construct without backtick interpolation so the pattern is in the string
    const injected = '{ pod(input: {podId: "${podId}"}) { id } }';
    expect(() => validateGraphQLQuery(injected)).toThrow(
      'GraphQL query contains potentially dangerous patterns',
    );
  });

  it('rejects ${...} with content inside braces', () => {
    expect(() => validateGraphQLQuery('query { pod(id: "${user.id}") { status } }')).toThrow();
  });

  it('rejects ${...} with empty content', () => {
    expect(() => validateGraphQLQuery('query { pod(id: "${}") { status } }')).toThrow();
  });

  it('rejects multiple interpolations in one query', () => {
    expect(() =>
      validateGraphQLQuery('mutation { create(name: "${name}", region: "${region}") { id } }'),
    ).toThrow();
  });

  it('rejects ${...} anywhere in the query including inside comments', () => {
    expect(() => validateGraphQLQuery('# user id: ${userId}\nquery { pods { id } }')).toThrow();
  });
});

// ── validateGraphQLQuery — string concatenation injection ────────────────────

describe('validateGraphQLQuery — string concatenation injection', () => {
  it('rejects single-quote concatenation: "foo" + "bar"', () => {
    const q = "query { pod(id: 'abc' + 'injected') { id } }";
    expect(() => validateGraphQLQuery(q)).toThrow(
      'GraphQL query contains potentially dangerous patterns',
    );
  });

  it('rejects double-quote concatenation: "foo" + "bar"', () => {
    const q = 'query { pod(id: "abc" + "injected") { id } }';
    expect(() => validateGraphQLQuery(q)).toThrow();
  });

  it('rejects concatenation with spaces around +', () => {
    expect(() => validateGraphQLQuery("query { f(x: 'a'   +   'b') { id } }")).toThrow();
  });

  it('rejects concatenation with tab between quotes and +', () => {
    expect(() => validateGraphQLQuery("query { f(x: 'a'\t+\t'b') { id } }")).toThrow();
  });
});

// ── validateGraphQLQuery — SQL injection through GraphQL ─────────────────────

describe('validateGraphQLQuery — SQL injection patterns', () => {
  it('rejects ; DROP TABLE injection', () => {
    expect(() =>
      validateGraphQLQuery('query { pod(id: "x; DROP TABLE pods") { id } }'),
    ).toThrow('GraphQL query contains potentially dangerous patterns');
  });

  it('rejects ; DELETE FROM injection', () => {
    expect(() =>
      validateGraphQLQuery('query { pod(id: "x; DELETE FROM pods") { id } }'),
    ).toThrow();
  });

  it('is case-insensitive for DROP', () => {
    expect(() => validateGraphQLQuery('query { x(id: "a; drop pods") { id } }')).toThrow();
    expect(() => validateGraphQLQuery('query { x(id: "a; Drop pods") { id } }')).toThrow();
    expect(() => validateGraphQLQuery('query { x(id: "a; DROP pods") { id } }')).toThrow();
  });

  it('is case-insensitive for DELETE', () => {
    expect(() => validateGraphQLQuery('query { x(id: "a; delete pods") { id } }')).toThrow();
    expect(() => validateGraphQLQuery('query { x(id: "a; Delete pods") { id } }')).toThrow();
    expect(() => validateGraphQLQuery('query { x(id: "a; DELETE pods") { id } }')).toThrow();
  });

  it('rejects ; DROP with multiple spaces before keyword', () => {
    expect(() => validateGraphQLQuery('query { x(id: ";  DROP users") { id } }')).toThrow();
  });

  it('rejects ; DELETE with newline before keyword', () => {
    expect(() => validateGraphQLQuery('query { x(id: ";\nDELETE pods") { id } }')).toThrow();
  });
});

// ── buildGraphQLQuery ────────────────────────────────────────────────────────

describe('buildGraphQLQuery', () => {
  it('builds a query with no variables', () => {
    const { query, variables } = buildGraphQLQuery('query ListPods', ['id', 'status']);
    expect(query).toContain('query ListPods');
    expect(query).toContain('id');
    expect(query).toContain('status');
    expect(variables).toEqual({});
  });

  it('builds a query with a single variable definition in the operation signature', () => {
    // NOTE: buildGraphQLQuery computes varUsage (e.g. "podId: $podId") internally
    // but the current implementation does NOT embed it in the query body — callers
    // must reference $podId directly in their fields. This test pins that behaviour.
    const { query, variables } = buildGraphQLQuery('query GetPod', ['id', 'status'], {
      podId: { type: 'String', value: 'pod-123' },
    });
    expect(query).toContain('$podId: String!');
    expect(variables).toEqual({ podId: 'pod-123' });
  });

  it('builds a query with multiple variable definitions in the operation signature', () => {
    const { query, variables } = buildGraphQLQuery(
      'mutation CreatePod',
      ['id', 'desiredStatus'],
      {
        gpuType: { type: 'String', value: 'RTX4090' },
        region: { type: 'String', value: 'US-TX' },
      },
    );
    expect(query).toContain('$gpuType: String!');
    expect(query).toContain('$region: String!');
    expect(variables).toEqual({ gpuType: 'RTX4090', region: 'US-TX' });
  });

  it('includes all fields in the query body', () => {
    const { query } = buildGraphQLQuery('query GetPod', ['id', 'status', 'gpuType', 'cost'], {
      podId: { type: 'String', value: 'abc' },
    });
    expect(query).toContain('id');
    expect(query).toContain('status');
    expect(query).toContain('gpuType');
    expect(query).toContain('cost');
  });

  it('returns an empty variables map when no variables are passed', () => {
    const { variables } = buildGraphQLQuery('query Pods', ['id']);
    expect(Object.keys(variables)).toHaveLength(0);
  });

  it('preserves variable values including numbers and booleans', () => {
    const { variables } = buildGraphQLQuery('mutation Deploy', ['id'], {
      gpuCount: { type: 'Int', value: 2 },
      interruptible: { type: 'Boolean', value: true },
    });
    expect(variables.gpuCount).toBe(2);
    expect(variables.interruptible).toBe(true);
  });

  it('preserves null variable values', () => {
    const { variables } = buildGraphQLQuery('query Get', ['id'], {
      filter: { type: 'String', value: null },
    });
    expect(variables.filter).toBeNull();
  });

  it('appends ! to every variable type in the definition', () => {
    const { query } = buildGraphQLQuery('mutation M', ['id'], {
      x: { type: 'String', value: 'v' },
      y: { type: 'Int', value: 1 },
    });
    // Both should have ! appended
    expect(query).toContain('$x: String!');
    expect(query).toContain('$y: Int!');
  });

  it('query output passes validateGraphQLQuery (no injection risk)', () => {
    const { query } = buildGraphQLQuery('query GetPod', ['id'], {
      podId: { type: 'String', value: 'pod-abc' },
    });
    // buildGraphQLQuery uses $varName syntax, not template literal ${...}
    expect(() => validateGraphQLQuery(query)).not.toThrow();
  });

  it('handles an empty fields array without throwing', () => {
    expect(() => buildGraphQLQuery('query Empty', [], {})).not.toThrow();
  });

  it('handles an empty operation string without throwing', () => {
    expect(() => buildGraphQLQuery('', ['id'])).not.toThrow();
  });
});
