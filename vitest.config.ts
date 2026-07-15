import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before any test module is imported — sandboxes GDOCS_MCP_CONFIG_DIR so
    // the suite never touches a real ~/.config (see test/setup.ts).
    setupFiles: ['./test/setup.ts'],
  },
});
