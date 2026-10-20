import type { GitHubResult } from '../github/github.ts';

export const guardEffect = async <Value>(
  run: () => Promise<Value>,
  onError: (message: string) => Value,
): Promise<Value> => {
  try {
    return await run();
  } catch (error) {
    return onError(error instanceof Error ? error.message : String(error));
  }
};

export const requestFailed = (message: string): GitHubResult<never> => ({
  ok: false,
  failure: { kind: 'requestFailed', status: null, message },
});
