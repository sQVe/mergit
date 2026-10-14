import type { BrowserPage } from './work/work.ts';

export type GhRun =
  | { kind: 'missing' }
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string };

export interface ActionEffects {
  runGh: (args: readonly string[], signal: AbortSignal) => Promise<GhRun>;
}

export type OpenResult = { ok: true } | { ok: false; message: string };

const browseArguments = (page: BrowserPage): string[] => {
  if (page.kind === 'item') {
    return ['browse', String(page.number)];
  }

  if (page.kind === 'commit') {
    return ['browse', page.sha];
  }

  if (page.kind === 'releases') {
    return ['browse', '--releases'];
  }

  return page.kind === 'actions' ? ['browse', '--actions'] : ['browse'];
};

export const openInBrowser = async (
  effects: ActionEffects,
  page: BrowserPage,
  signal: AbortSignal,
): Promise<OpenResult> => {
  const run = await effects.runGh([...browseArguments(page), '--repo', page.repository], signal);

  if (run.kind === 'missing') {
    return { ok: false, message: 'gh is not installed' };
  }

  if (run.exitCode === 0) {
    return { ok: true };
  }

  const reason = run.stderr.trim();

  return { ok: false, message: reason === '' ? `gh exited with code ${run.exitCode}` : reason };
};
