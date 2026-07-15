import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point CONFIG_DIR at a throwaway temp dir before any test module (transitively)
// imports src/config.ts, so no test run can ever read or mutate a real user's
// ~/.config/gdocs-mcp. Defense-in-depth: even if future code re-introduces a
// filesystem side effect on a config path, tests stay sandboxed. (setupFiles are
// evaluated before test files, so this env var is set prior to config.ts import.)
process.env.GDOCS_MCP_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'gdocs-test-cfg-'));
