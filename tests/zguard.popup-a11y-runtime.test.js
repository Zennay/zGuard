const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function exercise(relative) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const observers = [];

  function makeButton(active = false) {
    const button = {
      active,
      attributes: {},
      classList: {
        contains(name) {
          return name === 'active' && button.active;
        }
      },
      setAttribute(name, value) {
        button.attributes[name] = value;
      }
    };
    return button;
  }

  const balanced = makeButton(false);
  const strict = makeButton(false);
  const buttons = [balanced, strict];

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }

    observe(target, options) {
      this.observed.push({ target, options });
    }
  }

  vm.runInNewContext(source, {
    document: { querySelectorAll: () => buttons },
    MutationObserver
  });

  assert.equal(observers.length, 1, relative + ': exactly one class observer is required');
  assert.equal(observers[0].observed.length, 2, relative + ': both mode buttons must be observed');
  for (const entry of observers[0].observed) {
    assert.equal(entry.options.attributes, true);
    assert.deepEqual(Array.from(entry.options.attributeFilter), ['class']);
  }

  assert.equal(balanced.attributes['aria-pressed'], 'false');
  assert.equal(strict.attributes['aria-pressed'], 'false');

  balanced.active = true;
  observers[0].callback();
  assert.equal(balanced.attributes['aria-pressed'], 'true');
  assert.equal(strict.attributes['aria-pressed'], 'false');

  balanced.active = false;
  strict.active = true;
  observers[0].callback();
  assert.equal(balanced.attributes['aria-pressed'], 'false');
  assert.equal(strict.attributes['aria-pressed'], 'true');

  return source;
}

const chromium = exercise('chromium/popup-a11y.js');
exercise('firefox/popup-a11y.js');
const bundled = exercise('zbrowse/browser/zguard/popup-a11y.js');
assert.equal(bundled, chromium, 'zBrowse bundled popup accessibility helper must match Chromium');

console.log('zGuard popup ARIA runtime contract passed');
