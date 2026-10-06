import assert from 'node:assert/strict';
import { cleanupManagedContainers } from '../zbrowse/gateway/managed-containers.js';

const calls = [];
const removed = [];
const docker = {
  async listContainers(options) {
    calls.push(options);
    return [{ Id: 'old-a' }, { Id: 'old-b' }];
  },
  getContainer(id) {
    return {
      async remove(options) {
        removed.push({ id, options });
      }
    };
  }
};

assert.equal(await cleanupManagedContainers(docker), 2);
assert.deepEqual(calls, [{
  all: true,
  filters: { label: ['zbrowse.managed=true'] }
}]);
assert.deepEqual(removed, [
  { id: 'old-a', options: { force: true } },
  { id: 'old-b', options: { force: true } }
]);

await assert.rejects(
  cleanupManagedContainers({
    async listContainers() {
      return [{ Id: 'stubborn' }];
    },
    getContainer() {
      return {
        async remove() {
          throw new Error('remove failed');
        }
      };
    }
  }),
  /remove failed/,
  'startup reconciliation must fail closed if a managed container cannot be removed'
);

console.log('zBrowse managed container cleanup tests passed');
