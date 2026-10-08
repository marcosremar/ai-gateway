import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(__dirname, '../../.github/workflows/speech-stack.yml'), 'utf8');

describe('speech-stack image workflow', () => {
  it('builds on dispatch, on main and on pull requests of this repository only, never from a fork', () => {
    expect(workflow).toMatch(/^ {2}workflow_dispatch:/m);
    expect(workflow).toMatch(/^ {2}pull_request:/m);
    expect(workflow).not.toMatch(/pull_request_target/);
    expect(workflow).toMatch(/^ {4}if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/m);
  });

  it('a new push to a pull request cancels the build of the previous one', () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: speech-stack-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
  });

  it('holds no secret besides the job token', () => {
    expect([...workflow.matchAll(/secrets\.(\w+)/g)].map(m => m[1])).toEqual(['GITHUB_TOKEN']);
  });
});
