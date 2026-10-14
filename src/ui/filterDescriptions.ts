import type { Filter } from '../session/session.ts';

const fieldDescriptions = new Map([
  ['kind', 'The type of thread: pr, issue, release, discussion, commit, or ci.'],
  ['repo', 'The repository, as owner/name. One `*` matches any text, such as `hups-co/*`.'],
  ['org', 'The owner of the repository. One `*` matches any text.'],
  ['author', 'Who opened the pull request or issue. `@me` is you; bots end in `[bot]`.'],
  ['reason', 'Why GitHub notified you.'],
  ['state', 'Whether the pull request or issue is open, closed, or merged.'],
  ['new', 'Activity you have not seen in Zeta, by someone other than you.'],
  ['unread', 'Unread on GitHub. Reading it on github.com marks it read.'],
  ['age', 'Time since the last update: `<` newer or `>` older than a number with m, h, d, or w.'],
  ['title', 'Words the title contains. Quote text with spaces.'],
]);

const valueDescriptions = new Map([
  ['kind:pr', 'Pull requests.'],
  ['kind:issue', 'Issues.'],
  ['kind:release', 'Releases.'],
  ['kind:discussion', 'Discussions.'],
  ['kind:commit', 'Commits.'],
  ['kind:ci', 'GitHub Actions workflow runs.'],
  ['state:open', 'Still open.'],
  ['state:closed', 'Closed without merging.'],
  ['state:merged', 'Merged pull requests.'],
  ['new:true', 'Activity you have not seen in Zeta yet.'],
  ['new:false', 'Nothing new since you last viewed it in Zeta.'],
  ['unread:true', 'Unread on GitHub.'],
  ['unread:false', 'Already read on GitHub.'],
  ['author:@me', 'Opened by you.'],
  ['reason:approval_requested', 'You were asked to approve a deployment.'],
  ['reason:assign', 'You were assigned.'],
  ['reason:author', 'You opened it.'],
  ['reason:comment', 'You commented on it.'],
  ['reason:ci_activity', 'A workflow run you started finished.'],
  ['reason:invitation', 'You accepted an invitation to the repository.'],
  ['reason:manual', 'You subscribed to this thread yourself.'],
  ['reason:member_feature_requested', 'Organization members asked to turn on a feature.'],
  ['reason:mention', 'You were @mentioned.'],
  ['reason:review_requested', 'You or your team were asked to review.'],
  ['reason:security_alert', 'GitHub found a vulnerability in the repository.'],
  ['reason:security_advisory_credit', 'You were credited on a security advisory.'],
  ['reason:state_change', 'You closed, reopened, or merged it.'],
  ['reason:subscribed', 'You watch the repository.'],
  ['reason:team_mention', 'A team you are on was @mentioned.'],
]);

export const fieldDescription = (field: string): string | undefined => fieldDescriptions.get(field);

export const filterDescription = (filter: Filter): string | undefined =>
  valueDescriptions.get(`${filter.field}:${filter.value.toLowerCase()}`) ??
  fieldDescriptions.get(filter.field);
