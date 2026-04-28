import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { deepgramSTT } from '../src/gateway/providers/cloud/deepgram';

// Mock fetch
global.fetch = vi.fn();

describe('Deepgram STT Provider - Audio Type Handling', () => {
  const mockApiKey = 'test-api-key';
  const mockAudioBlob = new Blob(['test audio'], { type: 'audio/wav' });
  const mockAudioBuffer = Buffer.from('test audio');

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEEPGRAM_API_KEY = mockApiKey;
  });

  afterEach(() => {
    delete process.env.DEEPGRAM_API_KEY;
  });

  test('should handle Blob audio input without throwing type error', async () => {
    // Mock successful response
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        results: {
          channels: [{
            alternatives: [{
              transcript: 'Hello world',
              words: [
                { word: 'Hello', start: 0, end: 0.5, confidence: 0.9 },
                { word: 'world', start: 0.5, end: 1, confidence: 0.9 }
              ]
            }]
          }]
        }
      }),
      text: () => Promise.resolve('')
    };

    (fetch as any).mockResolvedValue(mockResponse);

    const result = await deepgramSTT.transcribe({
      audio: mockAudioBlob,
      language: 'en'
    });

    expect(result.text).toBe('Hello world');
    expect(result.words).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.deepgram.com/v1/listen'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'audio/wav',
          'Authorization': `Token ${mockApiKey}`
        })
      })
    );
  });

  test('should handle Buffer audio input without throwing type error', async () => {
    // Mock successful response
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        results: {
          channels: [{
            alternatives: [{
              transcript: 'Test transcription',
              confidence: 0.95
            }]
          }]
        }
      }),
      text: () => Promise.resolve('')
    };

    (fetch as any).mockResolvedValue(mockResponse);

    const result = await deepgramSTT.transcribe({
      audio: mockAudioBuffer
    });

    expect(result.text).toBe('Test transcription');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.deepgram.com/v1/listen'),
      expect.objectContaining({
        body: mockAudioBuffer
      })
    );
  });
});