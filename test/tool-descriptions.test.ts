import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A description that points at a tool which does not exist sends the model
// somewhere there is nothing. It cannot fail a build, a type check or any other
// test, and it survives a rename indefinitely — `set_style` told callers to run
// `inspect_style` long after that tool became `get_style`, and `list_suggestions`
// pointed at `apply_suggestion` after the singular was deleted (#45).
//
// So this reads the source rather than the built server: descriptions are prose,
// and prose is exactly what nothing else here checks.

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'),
  'utf8',
);

const toolNames = new Set([...SRC.matchAll(/\n {2}server\.registerTool\(\n\s*'([a-z_]+)'/g)].map((m) => m[1]));
const descriptions = [...SRC.matchAll(/'([a-z_]+)',\n\s*\{\n\s*title:[^\n]*\n\s*description:\s*\n?\s*'(.*?)',\n\s*inputSchema/gs)].map(
  ([, tool, text]) => ({ tool, text }),
);

// snake_case things in a description that are deliberately NOT tool names:
// parameter names and result statuses. Add to this only after checking the token
// really is one of those — the point of the test is that a typo lands here.
const NOT_TOOLS = new Set(['old_string', 'new_string', 'whole_document', 'wrong_doc']);

describe('tool descriptions (#45)', () => {
  it('finds every registered tool and its description', () => {
    expect(toolNames.size).toBeGreaterThan(30);
    expect(descriptions.length).toBe(toolNames.size);
  });

  it('never points at a tool that does not exist', () => {
    const dangling: string[] = [];
    for (const { tool, text } of descriptions) {
      for (const token of new Set([...text.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((m) => m[1]))) {
        if (!toolNames.has(token) && !NOT_TOOLS.has(token)) dangling.push(`${tool} -> ${token}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('never refers to itself in the third person, which reads as another tool', () => {
    const selfRefs = descriptions.filter(({ tool, text }) => new RegExp(`\\buse ${tool}\\b`, 'i').test(text));
    expect(selfRefs.map((s) => s.tool)).toEqual([]);
  });
});
