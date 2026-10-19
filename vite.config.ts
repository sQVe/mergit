import { format, lint } from '@sqve/seam';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    extends: [lint],
    jsPlugins: ['./scripts/lintRules.ts'],
    rules: { 'mergit/module-boundaries': 'error' },
  },
  fmt: {
    ...format,
    // Local agent state is not source and must not be reformatted.
    ignorePatterns: ['bun.lock', '.tau/**'],
  },
  staged: {
    '*.{ts,tsx,js,jsx,mjs,cjs}': [
      'bunx --bun seam',
      'bunx --bun vp fmt --check --no-error-on-unmatched-pattern',
    ],
    '*.{json,md,yaml,yml,css}': 'bunx --bun vp fmt --check --no-error-on-unmatched-pattern',
  },
});
