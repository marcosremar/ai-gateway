# Architecture Review Checklist

Use this checklist when evaluating significant architectural changes (>500 lines, new provider, new pipeline stage, etc.).

## 1. Problem Statement

- [ ] Clear description of the problem being solved
- [ ] Why is this change needed now?
- [ ] What happens if we don't make this change?
- [ ] Is this addressing a symptom or root cause?

## 2. Alternatives Considered

- [ ] At least 2 alternative approaches documented
- [ ] Trade-offs of each alternative listed
- [ ] Why was the chosen approach selected over others?
- [ ] What are the failure modes of each approach?

## 3. Design

### API Design
- [ ] Public interfaces documented
- [ ] Breaking vs non-breaking changes identified
- [ ] Backwards compatibility strategy defined
- [ ] Deprecation path outlined (if applicable)

### Data Model
- [ ] New state/schemas defined
- [ ] Migration path for existing data
- [ ] Persistence strategy (memory, file, database)
- [ ] Backup/recovery considerations

### Error Handling
- [ ] Error cases documented
- [ ] Error codes/classes defined
- [ ] Retry strategy outlined
- [ ] Circuit breaker considerations

### Observability
- [ ] New metrics to track
- [ ] New log events
- [ ] Alert conditions
- [ ] Dashboards affected

## 4. Security

- [ ] Authentication/authorization impact
- [ ] Input validation
- [ ] Output sanitization
- [ ] Secrets handling
- [ ] Rate limiting
- [ ] SSRF considerations

## 5. Performance

- [ ] Latency impact
- [ ] Throughput considerations
- [ ] Memory footprint
- [ ] Connection pooling
- [ ] Caching opportunities

## 6. Testing

- [ ] Unit test strategy
- [ ] Integration test strategy
- [ ] Contract tests for interfaces
- [ ] Property-based tests for pure functions
- [ ] Load testing plan (if applicable)

## 7. Rollout

- [ ] Deployment strategy (big bang, canary, feature flag)
- [ ] Rollback plan
- [ ] Migration steps
- [ ] Monitoring during rollout

## 8. Documentation

- [ ] ADRs created for key decisions
- [ ] Code comments for complex logic
- [ ] User-facing docs updated
- [ ] Internal docs updated

## 9. Dependencies

- [ ] New external dependencies
- [ ] Dependency version constraints
- [ ] Supply chain security
- [ ] License implications

## 10. Review

- [ ] Reviewed by at least 1 other engineer
- [ ] Security review (if applicable)
- [ ] Performance review (if applicable)
- [ ] UX review (if applicable)

## Questions to Ask

1. **What is the blast radius if this fails?**
2. **How will we know if it's not working?**
3. **Can we roll back easily?**
4. **What are the edge cases?**
5. **How does this interact with existing features?**
6. **What happens under load?**
7. **Are we creating technical debt?**
8. **Is this the right time to make this change?**

## Size Thresholds

| Change Size | Review Required |
|-------------|----------------|
| < 100 lines | Self-review only |
| 100-500 lines | 1 reviewer |
| 500-1000 lines | 1 reviewer + architecture review |
| > 1000 lines | Full review + ADR + migration plan |

## Reviewers

When requesting review, provide:
1. Summary of the change
2. Link to this checklist with status
3. Specific areas of concern
4. Testing performed
