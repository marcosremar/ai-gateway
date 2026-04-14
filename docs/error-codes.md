# Error Code Registry

All AI Gateway errors carry a structured `code` field. This registry ensures consistent error codes across the system.

## Error Code Format

```
{MODULE}_{SPECIFIC_ERROR}
```

Example: `PROVIDER_TIMEOUT`, `GPU_BOOT_ERROR`, `BUDGET_EXCEEDED`

## Error Codes

### Authentication & Authorization

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `AUTH_ERROR` | 401 | No | API key missing or invalid |
| `FORBIDDEN` | 403 | No | Insufficient permissions |

### Provider Errors

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `PROVIDER_ERROR` | 502 | Yes | Generic provider failure |
| `PROVIDER_TIMEOUT` | 504 | Yes | Provider did not respond in time |
| `PROVIDER_RATE_LIMITED` | 429 | Yes | Provider rate limit exceeded |
| `PROVIDER_AUTH_FAILED` | 502 | No | Provider API key rejected |
| `CREDIT_EXHAUSTED` | 402 | No | Provider credits/balance exhausted |

### GPU Errors

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `GPU_NOT_READY` | 503 | Yes | GPU instance not yet available |
| `GPU_BOOT_ERROR` | 500 | Yes | Failed to boot GPU instance |
| `GPU_HEALTH_UNHEALTHY` | 503 | No | GPU health check failed |

### Pipeline Errors

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `PIPELINE_ERROR` | 500 | Yes | A pipeline stage (STT/LLM/TTS) failed |

### Config Errors

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `CONFIG_ERROR` | 400 | No | Invalid configuration |
| `VALIDATION_ERROR` | 422 | No | Input validation failed |

### Cost Errors

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `BUDGET_EXCEEDED` | 429 | No | Spend budget exceeded |

### Internal Errors

| Code | HTTP Status | Retryable | Description |
|------|------------|-----------|-------------|
| `INTERNAL_ERROR` | 500 | Yes | Unexpected internal error |
| `DATABASE_ERROR` | 500 | Yes | Database operation failed |
| `NOT_FOUND` | 404 | No | Resource not found |

## Error Response Format

```json
{
  "error": "ProviderError",
  "code": "PROVIDER_TIMEOUT",
  "message": "Provider groq timed out after 30000ms",
  "statusCode": 504,
  "retryable": true,
  "context": {
    "providerId": "groq",
    "model": "whisper-large-v3",
    "requestId": "abc-123"
  }
}
```

## Usage

```typescript
import { ProviderTimeoutError, ProviderError } from './errors';

// In provider code:
throw new ProviderTimeoutError('groq', 30_000, { model: 'whisper-large-v3' });

// In handler code:
try {
  await provider.chat(messages);
} catch (err) {
  if (err instanceof ProviderError) {
    // Handle provider-specific errors
    log.error({ providerId: err.context.providerId }, err.message);
  }
  throw err;
}
```
