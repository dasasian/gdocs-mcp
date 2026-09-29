import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';

interface Registered {
  description?: string;
}

function descriptionOf(server: ReturnType<typeof createServer>, tool: string): string {
  const tools = (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
  return tools[tool].description ?? '';
}

describe('the project default folder in tool descriptions (#55)', () => {
  it('write_doc says where new docs go by default when the server knows', () => {
    const description = descriptionOf(createServer({ defaultFolderPath: '/Work/Clients' }), 'write_doc');
    expect(description).toContain("This project's default folder for new docs is /Work/Clients.");
  });

  it('says nothing about a default when there is none', () => {
    expect(descriptionOf(createServer(), 'write_doc')).not.toContain('default folder for new docs is');
  });

  it('set_project_default says what the folder does now', () => {
    const description = descriptionOf(createServer(), 'set_project_default');
    expect(description).toContain('write_doc');
    expect(description).not.toContain('for new docs. To set');
  });
});
