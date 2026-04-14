import { describe, it, expect } from 'vitest';

// OpenAI models
import {
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_OMNI_MODELS,
  OPENAI_REALTIME_MODELS,
  OPENAI_IMAGE_MODELS,
  OPENAI_VOICES,
  getVoicesForModel,
} from '../../src/providers/openai/models';

// Groq models
import {
  GROQ_STT_MODELS,
  GROQ_TTS_MODELS,
  GROQ_TTS_VOICES,
  GROQ_LLM_MODELS,
} from '../../src/providers/groq/models';

// Fireworks models
import {
  FIREWORKS_STT_MODELS,
  FIREWORKS_LLM_MODELS,
  FIREWORKS_IMAGE_MODELS,
} from '../../src/providers/fireworks/models';

// OpenRouter models
import {
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_LLM_MODELS,
} from '../../src/providers/openrouter/models';

// ── Shared model validation helpers ──────────────────────────────────────────

function validateModelInfo(models: Array<{ id: string; name: string; capability: string }>) {
  for (const model of models) {
    expect(model.id).toBeTruthy();
    expect(model.name).toBeTruthy();
    expect(model.capability).toBeTruthy();
  }
}

// ── OpenAI Models ─────────────────────────────────────────────────────────────

describe('OPENAI_STT_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENAI_STT_MODELS.length).toBeGreaterThan(0);
  });

  it('should have valid model info for all entries', () => {
    validateModelInfo(OPENAI_STT_MODELS);
  });

  it('should have at least one default model', () => {
    expect(OPENAI_STT_MODELS.some((m) => m.isDefault)).toBe(true);
  });

  it('should all have capability=stt', () => {
    for (const m of OPENAI_STT_MODELS) {
      expect(m.capability).toBe('stt');
    }
  });

  it('should include whisper-1', () => {
    expect(OPENAI_STT_MODELS.some((m) => m.id === 'whisper-1')).toBe(true);
  });

  it('should include gpt-4o-transcribe', () => {
    expect(OPENAI_STT_MODELS.some((m) => m.id === 'gpt-4o-transcribe')).toBe(true);
  });
});

describe('OPENAI_TTS_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENAI_TTS_MODELS.length).toBeGreaterThan(0);
  });

  it('should have valid model info for all entries', () => {
    validateModelInfo(OPENAI_TTS_MODELS);
  });

  it('should have at least one default model', () => {
    expect(OPENAI_TTS_MODELS.some((m) => m.isDefault)).toBe(true);
  });

  it('should all have capability=tts', () => {
    for (const m of OPENAI_TTS_MODELS) {
      expect(m.capability).toBe('tts');
    }
  });

  it('should include tts-1', () => {
    expect(OPENAI_TTS_MODELS.some((m) => m.id === 'tts-1')).toBe(true);
  });
});

describe('OPENAI_OMNI_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENAI_OMNI_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=omni', () => {
    for (const m of OPENAI_OMNI_MODELS) {
      expect(m.capability).toBe('omni');
    }
  });

  it('should have at least one default model', () => {
    expect(OPENAI_OMNI_MODELS.some((m) => m.isDefault)).toBe(true);
  });
});

describe('OPENAI_REALTIME_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENAI_REALTIME_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=realtime', () => {
    for (const m of OPENAI_REALTIME_MODELS) {
      expect(m.capability).toBe('realtime');
    }
  });
});

describe('OPENAI_IMAGE_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENAI_IMAGE_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=image', () => {
    for (const m of OPENAI_IMAGE_MODELS) {
      expect(m.capability).toBe('image');
    }
  });

  it('should include dall-e-3', () => {
    expect(OPENAI_IMAGE_MODELS.some((m) => m.id === 'dall-e-3')).toBe(true);
  });
});

describe('OPENAI_VOICES', () => {
  it('should have many voices', () => {
    expect(OPENAI_VOICES.length).toBeGreaterThan(5);
  });

  it('should include alloy voice', () => {
    expect(OPENAI_VOICES.some((v) => v.id === 'alloy')).toBe(true);
  });

  it('should include nova voice', () => {
    expect(OPENAI_VOICES.some((v) => v.id === 'nova')).toBe(true);
  });

  it('should have id and name for each voice', () => {
    for (const v of OPENAI_VOICES) {
      expect(v.id).toBeTruthy();
      expect(v.name).toBeTruthy();
    }
  });
});

describe('getVoicesForModel()', () => {
  it('should return voices for gpt-4o-mini-tts-2025-03-20', () => {
    const voices = getVoicesForModel('gpt-4o-mini-tts-2025-03-20');
    expect(voices.length).toBeGreaterThan(0);
  });

  it('should include alloy for tts-1', () => {
    const voices = getVoicesForModel('tts-1');
    expect(voices.some((v) => v.id === 'alloy')).toBe(true);
  });

  it('should return all voices for unknown model (no filtering)', () => {
    const voices = getVoicesForModel('some-unknown-model');
    // Voices without supportedModels filter should be returned
    expect(Array.isArray(voices)).toBe(true);
  });

  it('should filter by supportedModels when specified', () => {
    const voices = getVoicesForModel('tts-1');
    // ballad and verse are only for gpt-4o-mini-tts models, not tts-1
    const balladVoice = voices.find((v) => v.id === 'ballad');
    expect(balladVoice).toBeUndefined();
  });
});

// ── Groq Models ───────────────────────────────────────────────────────────────

describe('GROQ_STT_MODELS', () => {
  it('should have at least one model', () => {
    expect(GROQ_STT_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=stt', () => {
    for (const m of GROQ_STT_MODELS) {
      expect(m.capability).toBe('stt');
    }
  });

  it('should have a default model', () => {
    expect(GROQ_STT_MODELS.some((m) => m.isDefault)).toBe(true);
  });

  it('should include whisper-large-v3-turbo', () => {
    expect(GROQ_STT_MODELS.some((m) => m.id === 'whisper-large-v3-turbo')).toBe(true);
  });
});

describe('GROQ_TTS_MODELS', () => {
  it('should have at least one model', () => {
    expect(GROQ_TTS_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=tts', () => {
    for (const m of GROQ_TTS_MODELS) {
      expect(m.capability).toBe('tts');
    }
  });

  it('should have a default model', () => {
    expect(GROQ_TTS_MODELS.some((m) => m.isDefault)).toBe(true);
  });
});

describe('GROQ_TTS_VOICES', () => {
  it('should have multiple voices', () => {
    expect(GROQ_TTS_VOICES.length).toBeGreaterThan(0);
  });

  it('should include autumn voice', () => {
    expect(GROQ_TTS_VOICES.some((v) => v.id === 'autumn')).toBe(true);
  });

  it('should have id and name for each voice', () => {
    for (const v of GROQ_TTS_VOICES) {
      expect(v.id).toBeTruthy();
      expect(v.name).toBeTruthy();
    }
  });
});

describe('GROQ_LLM_MODELS', () => {
  it('should have at least one model', () => {
    expect(GROQ_LLM_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=llm', () => {
    for (const m of GROQ_LLM_MODELS) {
      expect(m.capability).toBe('llm');
    }
  });

  it('should have a default model', () => {
    expect(GROQ_LLM_MODELS.some((m) => m.isDefault)).toBe(true);
  });
});

// ── Fireworks Models ──────────────────────────────────────────────────────────

describe('FIREWORKS_STT_MODELS', () => {
  it('should have at least one model', () => {
    expect(FIREWORKS_STT_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=stt', () => {
    for (const m of FIREWORKS_STT_MODELS) {
      expect(m.capability).toBe('stt');
    }
  });

  it('should have a default model', () => {
    expect(FIREWORKS_STT_MODELS.some((m) => m.isDefault)).toBe(true);
  });
});

describe('FIREWORKS_LLM_MODELS', () => {
  it('should have at least one model', () => {
    expect(FIREWORKS_LLM_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=llm', () => {
    for (const m of FIREWORKS_LLM_MODELS) {
      expect(m.capability).toBe('llm');
    }
  });
});

describe('FIREWORKS_IMAGE_MODELS', () => {
  it('should have at least one model', () => {
    expect(FIREWORKS_IMAGE_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=image', () => {
    for (const m of FIREWORKS_IMAGE_MODELS) {
      expect(m.capability).toBe('image');
    }
  });

  it('should have a default model', () => {
    expect(FIREWORKS_IMAGE_MODELS.some((m) => m.isDefault)).toBe(true);
  });
});

// ── OpenRouter Models ─────────────────────────────────────────────────────────

describe('OPENROUTER_IMAGE_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENROUTER_IMAGE_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=image', () => {
    for (const m of OPENROUTER_IMAGE_MODELS) {
      expect(m.capability).toBe('image');
    }
  });

  it('should have a default model', () => {
    expect(OPENROUTER_IMAGE_MODELS.some((m) => m.isDefault)).toBe(true);
  });
});

describe('OPENROUTER_LLM_MODELS', () => {
  it('should have at least one model', () => {
    expect(OPENROUTER_LLM_MODELS.length).toBeGreaterThan(0);
  });

  it('should all have capability=llm', () => {
    for (const m of OPENROUTER_LLM_MODELS) {
      expect(m.capability).toBe('llm');
    }
  });

  it('should have a default model', () => {
    expect(OPENROUTER_LLM_MODELS.some((m) => m.isDefault)).toBe(true);
  });

  it('should include GPT-4o-mini', () => {
    expect(OPENROUTER_LLM_MODELS.some((m) => m.id.includes('gpt-4o-mini'))).toBe(true);
  });
});
