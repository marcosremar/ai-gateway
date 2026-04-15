/**
 * GPU Deploy Architecture Changes — Unit Tests
 *
 * Tests for recent architectural changes:
 *   1. Preflight skip behavior (continue to next tier instead of aborting)
 *   2. STT inference test accepts empty text (silence is valid)
 *   3. Translation endpoint test before chat completions fallback
 *
 * Issue: Fixes cascade abort when preflight fails and inference test rejections
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// ── Source code verification tests ────────────────────────────────────────────
const deployWithTiersSource = readFileSync('server/gpu-deploy-with-tiers.ts', 'utf8');
const pollHealthSource = readFileSync('server/gpu-poll-health.ts', 'utf8');

describe('Preflight Skip Behavior - Source Code Verification', () => {
  it('#1 should have preflightOk array to filter passing tiers', () => {
    expect(deployWithTiersSource).toContain('const preflightOk: GpuTier[] = []');
    expect(deployWithTiersSource).toContain('preflightOk.push(tier)');
  });

  it('#2 should continue to next tier when preflight fails (not throw)', () => {
    // Should use continue instead of throw
    expect(deployWithTiersSource).toContain('continue; // skip this tier, try next');
    
    // Should NOT throw when preflight fails
    const preflightSection = deployWithTiersSource.slice(
      deployWithTiersSource.indexOf('runPreFlightChecks'),
      deployWithTiersSource.indexOf('canAffordDeploy')
    );
    expect(preflightSection).not.toContain('throw new Error');
  });

  it('#3 should check if all providers failed preflight', () => {
    expect(deployWithTiersSource).toContain('if (preflightOk.length === 0)');
    expect(deployWithTiersSource).toContain('All providers failed preflight');
  });

  it('#4 should use preflightOk tiers for deployment', () => {
    expect(deployWithTiersSource).toContain('tiers = preflightOk');
  });

  it('#5 should log skipped providers', () => {
    expect(deployWithTiersSource).toContain('preflightSkip.push(tier.name)');
    expect(deployWithTiersSource).toContain('Preflight:')
    expect(deployWithTiersSource).toContain('OK — skipped');
  });
});

describe('STT Inference Test - Empty Text Acceptance', () => {
  it('#6 should check typeof body.text === string (accepts empty string)', () => {
    const inferenceTestSection = pollHealthSource.slice(
      pollHealthSource.indexOf('/v1/audio/transcriptions'),
      pollHealthSource.indexOf('/v1/translate/text')
    );
    
    expect(inferenceTestSection).toContain("typeof body.text === 'string'");
  });

  it('#7 should have comment explaining empty text is valid (silence)', () => {
    expect(pollHealthSource).toContain('text can be "" (silence)');
    expect(pollHealthSource).toContain("that's still a valid response");
  });

  it('#8 should log the text value in test results', () => {
    expect(pollHealthSource).toContain('text="${(body.text || \'\').slice(0, 30)}"');
  });
});

describe('Translation Endpoint Test', () => {
  it('#9 should have translation endpoint test before chat completions', () => {
    const translateIndex = pollHealthSource.indexOf('/v1/translate/text');
    const chatIndex = pollHealthSource.indexOf('/v1/chat/completions');
    
    expect(translateIndex).toBeGreaterThan(0);
    expect(chatIndex).toBeGreaterThan(0);
    expect(translateIndex).toBeLessThan(chatIndex);
  });

  it('#10 should call translation endpoint with correct parameters', () => {
    expect(pollHealthSource).toContain('/v1/translate/text');
    expect(pollHealthSource).toContain('source_lang');
    expect(pollHealthSource).toContain('target_lang');
    expect(pollHealthSource).toContain("'en'");
    expect(pollHealthSource).toContain("'pt'");
  });

  it('#11 should accept multiple translation response formats', () => {
    const translateSection = pollHealthSource.slice(
      pollHealthSource.indexOf('/v1/translate/text'),
      pollHealthSource.indexOf('/v1/chat/completions')
    );
    
    expect(translateSection).toContain('body.text');
    expect(translateSection).toContain('body.translation');
    expect(translateSection).toContain('body.output');
  });

  it('#12 should set passedStage to LLM(translate) on success', () => {
    expect(pollHealthSource).toContain("passedStage = 'LLM(translate)'");
  });

  it('#13 should log translation test attempts and results', () => {
    expect(pollHealthSource).toContain('[gpu] Translation test:');
    expect(pollHealthSource).toContain('[gpu] Inference test PASSED (translation)');
  });
});

describe('Inference Test Fallback Chain', () => {
  it('#14 should try STT first, then translation, then chat completions, then TTS', () => {
    const sttIndex = pollHealthSource.indexOf('/v1/audio/transcriptions');
    const translateIndex = pollHealthSource.indexOf('/v1/translate/text');
    const chatIndex = pollHealthSource.indexOf('/v1/chat/completions');
    const ttsIndex = pollHealthSource.indexOf('/v1/audio/speech');
    
    expect(sttIndex).toBeGreaterThan(0);
    expect(translateIndex).toBeGreaterThan(sttIndex);
    expect(chatIndex).toBeGreaterThan(translateIndex);
    expect(ttsIndex).toBeGreaterThan(chatIndex);
  });

  it('#15 should use inferenceOk flag to track success across tests', () => {
    expect(pollHealthSource).toContain('let inferenceOk = false');
    expect(pollHealthSource).toContain('if (!inferenceOk)');
    expect(pollHealthSource).toContain('inferenceOk = true');
  });

  it('#16 should track which stage passed in passedStage variable', () => {
    expect(pollHealthSource).toContain('passedStage = ');
    expect(pollHealthSource).toContain("'STT'");
    expect(pollHealthSource).toContain("'LLM'");
    expect(pollHealthSource).toContain("'TTS'");
  });
});

describe('Probe Behavior (No Reordering)', () => {
  it('#17 should probe providers but not reorder tiers', () => {
    // Should have probe code
    expect(deployWithTiersSource).toContain('Promise.allSettled');
    expect(deployWithTiersSource).toContain('probeResults');
    
    // Should log probe results
    expect(deployWithTiersSource).toContain('Provider probe:');
    
    // Should NOT reorder availableTiers based on probe results
    // (This is verified by the absence of sorting/reordering code after probe)
    const probeSection = deployWithTiersSource.slice(
      deployWithTiersSource.indexOf('probeResults'),
      deployWithTiersSource.indexOf('for (let i = 0; i < availableTiers.length')
    );
    expect(probeSection).not.toContain('sort');
    expect(probeSection).not.toContain('availableTiers = ');
  });

  it('#18 should have comment explaining why not to reorder', () => {
    expect(deployWithTiersSource).toContain('DO NOT reorder');
    expect(deployWithTiersSource).toContain('preserve the configured cascade order');
  });
});
