/**
 * DeployId — unique correlation ID for a deploy session.
 * Opaque, immutable, branded string.
 */

const BRAND: unique symbol = Symbol('DeployId');

export type DeployId = string & { readonly [BRAND]: true };

export const DeployId = {
  generate(): DeployId {
    const id = `dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return id as DeployId;
  },

  from(raw: string): DeployId {
    if (!raw || typeof raw !== 'string') {
      throw new Error(`Invalid DeployId: ${raw}`);
    }
    return raw as DeployId;
  },
};
