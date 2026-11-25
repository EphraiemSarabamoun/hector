/** Browser tests run separately in Chromium; engine and reducer tests stay capped at four workers. */
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { exclude: ['tests/browser/**', 'node_modules/**', 'dist/**'], maxWorkers: 4 } });
