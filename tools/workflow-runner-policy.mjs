// Shared repository runner policy (commit e54e0d9, "enforce VPS-only
// self-hosted GitHub Actions runners"). Every job runs on the owner's VPS
// pool and is guarded so that pull requests only execute when they come from
// this repository and were opened by the owner; fork PRs never reach the VPS.
import assert from 'node:assert/strict';

export const VPS_RUNS_ON = 'runs-on: [self-hosted, portfolio-pool, vps]';
export const OWNER_PR_GUARD = "if: ((github.event_name != 'pull_request' && " +
  "github.event_name != 'pull_request_target') || " +
  "(github.event.pull_request.head.repo.full_name == github.repository && " +
  "github.actor == 'Zennay'))";

export function assertVpsOwnerGuardedJob(workflow, label) {
  assert.ok(workflow.includes('    ' + VPS_RUNS_ON + '\n'),
    label + ' must run on the VPS-only self-hosted runner pool');
  assert.ok(workflow.includes('    ' + OWNER_PR_GUARD + '\n'),
    label + ' must keep the same-repository owner pull-request guard');
}
