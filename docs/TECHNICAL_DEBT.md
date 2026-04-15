# Technical Debt Register

This document tracks known technical debt, TODOs, and areas for improvement in the AI Gateway codebase.

## Active TODOs

### High Priority

#### 1. Move RunPod GraphQL Call to Client (server/ip-location.ts:114)
**Location:** `server/ip-location.ts:114-117`
**Issue:** Direct GraphQL call used instead of RunpodClient method
**Reason:** RunpodClient.getInstanceDetail() uses REST API which doesn't expose dataCenterId
**Action:** Add getDatacenterInfo() method to RunpodClient using GraphQL
**Estimated Effort:** 2-3 hours

#### 2. Consolidate Configuration Directory (server/config-persistence.ts:20)
**Location:** `server/config-persistence.ts:20`
**Issue:** Configuration scattered in multiple directories
**Current:** `~/.babelcast/`, `~/.ai-gateway/`
**Target:** Single `~/.ai-gateway/` directory
**Action:** Migrate all config files to unified location
**Estimated Effort:** 4-6 hours
**Breaking Change:** Yes - requires migration path

### Medium Priority

#### 3. Modularize Large Files
**Files to Split:**
- ✅ `src/gateway/providers/gpu/vast-client.ts` (2,765 lines) → **Completed**
- ✅ `src/gateway/providers/gpu/runpod-client.ts` (1,661 lines) → **Completed**
- ✅ `server/gpu-handlers.ts` (1,656 lines) → **Completed**
- `server/ai-handlers.ts` (1,422 lines) → Not Started
- `server/bot-handlers.ts` (1,271 lines) → Not Started
- `src/errors/deploy-errors.ts` (1,028 lines) → Not Started

**Strategy:**
1. Extract types to separate files
2. Group related functionality into modules
3. Maintain backward compatibility with re-exports
4. Add tests for each new module

#### 4. Replace Empty Catch Blocks
**Count:** 19+ instances
**Pattern:** `.catch(() => {})` or `.catch(() => { /* ignore */ })`
**Solution:** Use `safe-catch.ts` utilities:
```typescript
// Before
await client.end().catch(() => {});

// After
import { safeClose } from './safe-catch';
await safeClose(client, 'context');
```

**Files to Update:**
- `src/database/pg-driver.ts` (2 instances)
- `server/bot-handlers.ts` (3 instances)
- `server/diagnostics-handlers.ts` (3 instances)
- `server/gpu-handlers-offers.ts` (2 instances)
- `server/gpu-handlers.ts` (2 instances)
- And others...

#### 5. Migrate Timers to TimerManager
**Count:** 256 setTimeout/setInterval calls
**Solution:** Gradually migrate to `timerManager`:
```typescript
// Before
const id = setTimeout(() => {}, 1000);
clearTimeout(id);

// After
const key = timerManager.setTimeout('context', () => {}, 1000);
timerManager.clear(key);
```

**Priority:** High for long-running timers, medium for one-shot

### Low Priority

#### 6. Reduce 'any' Type Usage
**Current:** 825 usages
**Strategy:**
1. Use new common types from `src/types/common.ts`
2. Add explicit interfaces for API responses
3. Use type guards for runtime validation
4. Enable strict TypeScript flags incrementally

#### 7. Optimize Sequential API Calls
**Pattern:** Sequential awaits that could be parallel
**Example:**
```typescript
// Before
const a = await fetchA();
const b = await fetchB();

// After
const [a, b] = await Promise.all([fetchA(), fetchB()]);
```

**Files to Review:**
- GPU deploy orchestration
- Provider health checks
- Batch operations

#### 8. Add Performance Metrics
**Missing:**
- API call latency tracking
- GPU deploy timing breakdown
- Cache hit/miss ratios
- Memory usage monitoring

**Solution:** Extend existing metrics system in `server/metrics.ts`

## Completed Improvements

### ✅ Modularized vast-client.ts
**Date:** 2026-04-15
**Changes:** Split 2,765 lines into 5 modules
- `types.ts`, `utils.ts`, `instances.ts`, `offers.ts`, `templates.ts`
**Tests:** 22 new tests
**Impact:** Improved maintainability and testability

### ✅ Modularized runpod-client.ts
**Date:** 2026-04-15
**Changes:** Split 1,661 lines into 6 modules
- `types.ts`, `constants.ts`, `utils.ts`, `instances.ts`, `volumes.ts`, `offers.ts`
**Tests:** 16 new tests
**Impact:** Reduced complexity, better separation of concerns

### ✅ Modularized gpu-handlers.ts
**Date:** 2026-04-15
**Changes:** Split 1,656 lines into 5 modules
- `types.ts`, `vram.ts`, `deploy-utils.ts`, `lifecycle.ts`, `snapshots.ts`
**Tests:** 22 new tests
**Impact:** Better separation of concerns, easier testing

### ✅ Created Safe Catch Module
**Date:** 2026-04-15
**Changes:** Added `src/safe-catch.ts` with error handling utilities
**Tests:** 17 new tests
**Impact:** Replaces empty catch blocks with proper logging

### ✅ Created Common Types
**Date:** 2026-04-15
**Changes:** Added `src/types/common.ts` with shared TypeScript types
**Tests:** 12 new tests
**Impact:** Reduces usage of `any` type across codebase

### ✅ Created Timer Manager
**Date:** 2026-04-15
**Changes:** Added `src/timer-manager.ts` for centralized timer management
**Tests:** 17 new tests
**Impact:** Prevents memory leaks from orphaned timers

## How to Add New TODOs

When adding technical debt:

1. **In Code:** Use format:
   ```typescript
   // TODO(category): Brief description
   // Reason: Why this needs to be done
   // Action: Specific steps
   // Effort: Estimated time
   ```

2. **In This File:** Add to appropriate priority section

3. **Tracking:** Reference issue/PR numbers when available

## Maintenance

**Review Cycle:** Monthly
**Owner:** Development team
**Last Updated:** 2026-04-15
