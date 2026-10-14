import type { OpenResult } from '../actions.ts';
import type { BrowserPage } from '../work/work.ts';
import type { MessageToastOwner } from './messageToast.ts';

export interface BrowserOpenInputs {
  openInBrowser: (page: BrowserPage, signal: AbortSignal) => Promise<OpenResult>;
  isStopped: () => boolean;
  showToast: MessageToastOwner['show'];
}

export interface BrowserOpenOwner {
  open: (pages: readonly BrowserPage[]) => void;
  stop: () => void;
}

export const createBrowserOpen = (inputs: BrowserOpenInputs): BrowserOpenOwner => {
  const controller = new AbortController();
  let queue: Promise<void> = Promise.resolve();

  const openPages = async (pages: readonly BrowserPage[]) => {
    const results: OpenResult[] = [];

    for (const page of pages) {
      if (inputs.isStopped()) {
        return;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- opens run one at a time, in order
      results.push(await inputs.openInBrowser(page, controller.signal));
    }

    if (inputs.isStopped()) {
      return;
    }

    const failures = results.filter((result) => !result.ok);
    const [first] = failures;

    if (first === undefined) {
      return;
    }

    const title =
      pages.length === 1
        ? 'Could not open the page in the browser'
        : `Could not open ${failures.length} of ${pages.length} pages in the browser`;

    inputs.showToast({ title, lines: [first.message], tone: 'error' });
  };

  const open = (pages: readonly BrowserPage[]) => {
    queue = queue.then(() => openPages(pages)).catch(() => undefined);
  };

  const stop = () => {
    controller.abort();
  };

  return { open, stop };
};
