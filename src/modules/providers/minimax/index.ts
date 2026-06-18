// MiniMax provider lives in the `src/gateway/providers/cloud/minimax` tree
// (not yet mirrored under `src/modules/gateway/...`), so reach across to the
// real implementation rather than the non-existent modules-local copy.
export * from '../../../gateway/providers/cloud/minimax';
export * from '../../../gateway/providers/cloud/minimax/llm';
