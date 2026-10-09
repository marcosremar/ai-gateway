import { DEFAULT_EDGE_IMAGE } from './cloud-init';
import { DECLARED_DEPLOYMENTS, declaredImage } from './declared';
import { BUILTIN_PROFILES } from './profiles';

export const buildImages = (env: Record<string, string | undefined> = process.env) => ({
  edge: DEFAULT_EDGE_IMAGE,
  profiles: Object.fromEntries(BUILTIN_PROFILES.filter(p => p.spec.image).map(p => [p.name, p.spec.image])),
  declared: Object.fromEntries(DECLARED_DEPLOYMENTS.map(d => [d.name, declaredImage(d, env)])),
});
