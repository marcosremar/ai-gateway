import { $ } from 'bun';

const commit = (await $`git rev-parse HEAD`.text()).trim();
const dirty = (await $`git status --porcelain --untracked-files=no`.text()).trim() ? '-dirty' : '';
const info = { commit: commit + dirty, builtAt: new Date().toISOString() };
await Bun.write(new URL('../src/build-info.json', import.meta.url), `${JSON.stringify(info)}\n`);
console.log('build stamped', info);
