import { describe, it, expect } from 'vitest';
import { parseSource } from './extract.js';

const ts = (src: string) => parseSource(src, 'typescript');
const tsx = (src: string) => parseSource(src, 'tsx');

describe('Phase 14 walker — extract.ts', () => {
  // 14.4
  it('extracts dynamic import() and require() as IMPORTS', async () => {
    const src = `
async function load() {
  const a = await import('./mod-a');
  const b = require('./mod-b');
  return [a, b];
}
`;
    const out = await ts(src);
    const importEdges = out.edges.filter((e) => e.kind === 'IMPORTS').map((e) => e.target_name);
    expect(importEdges).toContain('./mod-a');
    expect(importEdges).toContain('./mod-b');
    // and they got recorded as bindings (so the resolver runs on them)
    const specs = out.imports.map((i) => i.moduleSpecifier);
    expect(specs).toContain('./mod-a');
    expect(specs).toContain('./mod-b');
  });

  // 14.5
  it('extracts re-exports including `export type from`', async () => {
    const src = `
export * from './a';
export { Foo, Bar as Baz } from './b';
export type { OnlyTypes } from './c';
`;
    const out = await ts(src);
    const byMod = (mod: string) => out.imports.filter((i) => i.moduleSpecifier === mod);
    expect(byMod('./a').length).toBeGreaterThanOrEqual(1);
    expect(byMod('./a')[0]?.localName).toBe('*');

    const b = byMod('./b');
    const baz = b.find((x) => x.localName === 'Baz');
    expect(baz?.importedName).toBe('Bar');

    const cTypes = byMod('./c');
    expect(cTypes[0]?.kind).toBe('type');
  });

  // 14.6
  it('emits a function symbol for `const fn = () => …`', async () => {
    const src = `
const greet = (name: string) => \`hi \${name}\`;
export const sum = function (a: number, b: number) { return a + b; };
const data = 42; // should NOT become a function
`;
    const out = await ts(src);
    const fnNames = out.symbols.filter((s) => s.kind === 'function').map((s) => s.name);
    expect(fnNames).toContain('greet');
    expect(fnNames).toContain('sum');
    expect(fnNames).not.toContain('data');
  });

  // 14.7
  it('emits REFERENCES edges for class decorators', async () => {
    const src = `
@Injectable
@Controller('users')
class UserController {
  @Get('/')
  list() { return []; }
}
`;
    const out = await ts(src);
    const refs = out.edges.filter((e) => e.kind === 'REFERENCES').map((e) => e.target_name);
    expect(refs).toContain('Injectable');
    expect(refs).toContain('Controller');
    expect(refs).toContain('Get');
  });

  // 14.8
  it('emits REFERENCES edges for JSX component usages', async () => {
    const src = `
import { Button } from './ui';
export function Page() {
  return <div><Button label="x" /><Card><span>hi</span></Card></div>;
}
`;
    const out = await tsx(src);
    const refs = out.edges.filter((e) => e.kind === 'REFERENCES').map((e) => e.target_name);
    expect(refs).toContain('Button');
    expect(refs).toContain('Card');
    // Lowercase intrinsic tags must NOT show up.
    expect(refs).not.toContain('div');
    expect(refs).not.toContain('span');
  });

  // 14.9
  it('captures preceding JSDoc into symbols.doc', async () => {
    const src = `
/**
 * Adds two numbers.
 * @param a left
 * @param b right
 */
function add(a: number, b: number) { return a + b; }
`;
    const out = await ts(src);
    const sym = out.symbols.find((s) => s.name === 'add');
    expect(sym?.doc).toContain('Adds two numbers');
    expect(sym?.doc).toContain('@param a left');
  });

  // 14.10
  it('tags type-only imports with kind="type"', async () => {
    const src = `
import type { A } from './a';
import { type B, C } from './b';
import D from './d';
`;
    const out = await ts(src);
    const a = out.imports.find((i) => i.moduleSpecifier === './a' && i.localName === 'A');
    const b = out.imports.find((i) => i.moduleSpecifier === './b' && i.localName === 'B');
    const c = out.imports.find((i) => i.moduleSpecifier === './b' && i.localName === 'C');
    const d = out.imports.find((i) => i.moduleSpecifier === './d');
    expect(a?.kind).toBe('type');
    expect(b?.kind).toBe('type');
    expect(c?.kind).toBe('value');
    expect(d?.kind).toBe('value');
  });
});
