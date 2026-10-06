/**
 * Compile-time contract: the client-side mirrors in gateway-types.ts stay assignable from the server's own types.
 * Type-only (erased at runtime); `bun run typecheck` fails when a server shape changes without its mirror. Not
 * exported from the package (it would make consumers type-check server modules).
 */

import type { S2SConfig as ServerS2SConfig } from '../../src/s2s/composite';
import type { ModelRoutesSpec as ServerRoutes } from '../../src/config/serve-providers';
import type { AppImage as ServerAppImage } from '../../src/deployments/apps';
import type { FallbackPlan as ServerFallbackPlan } from '../../src/deployments/app-fallback';
import type { AppImage, FallbackPlan, ModelRoutesSpec, S2SConfig } from './gateway-types';

type Assignable<To, From extends To> = From;

type GatewayClientContract = [
  Assignable<S2SConfig, ServerS2SConfig>,
  Assignable<ServerS2SConfig, S2SConfig>,
  Assignable<ModelRoutesSpec, ServerRoutes>,
  Assignable<AppImage, ServerAppImage>,
  Assignable<FallbackPlan, ServerFallbackPlan>,
];
export {};
