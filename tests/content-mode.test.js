const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadContentScript(relativePath, mode, enabled = true) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const events = [];
  let allowedOpenCount = 0;
  let clickHandler;
  let submitHandler;

  const api = {
    runtime: {
      sendMessage(message) {
        events.push(message);
      }
    },
    storage: {
      local: {
        get(defaults, callback) {
          const settings = { ...defaults, enabled, mode };
          if (typeof callback === 'function') {
            callback(settings);
            return undefined;
          }
          return Promise.resolve(settings);
        }
      }
    }
  };

  const context = {
    URL,
    console,
    location: {
      href: 'https://origin.test/watch',
      origin: 'https://origin.test'
    },
    window: {
      open(url) {
        allowedOpenCount += 1;
        return { allowed: true, url };
      }
    },
    document: {
      addEventListener(name, listener) {
        if (name === 'click') clickHandler = listener;
        if (name === 'submit') submitHandler = listener;
      }
    }
  };

  if (relativePath.startsWith('firefox/')) context.browser = api;
  else context.chrome = api;

  vm.runInNewContext(source, context, { filename: relativePath });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    open: (url) => context.window.open(url),
    click(href, { target = '_blank', ctrlKey = false, metaKey = false, button = 0, elementTag = 'a' } = {}) {
      const actions = [];
      const event = {
        target: {
          closest: (selector) => selector.split(',').includes(elementTag)
            ? { href, target } : null
        },
        ctrlKey, metaKey, button,
        preventDefault() { actions.push('preventDefault'); },
        stopImmediatePropagation() { actions.push('stopImmediatePropagation'); }
      };
      if (clickHandler) clickHandler(event);
      return actions;
    },
    submit(action, { target = '_blank', submitterAction, submitterTarget } = {}) {
      const actions = [];
      const submitter = {
        hasAttribute(name) {
          return name === 'formaction' ? submitterAction !== undefined
            : name === 'formtarget' ? submitterTarget !== undefined : false;
        },
        formAction: submitterAction,
        formTarget: submitterTarget
      };
      const event = {
        target: { tagName: 'FORM', action, target },
        submitter,
        preventDefault() { actions.push('preventDefault'); },
        stopImmediatePropagation() { actions.push('stopImmediatePropagation'); }
      };
      if (submitHandler) submitHandler(event);
      return actions;
    },
    events,
    allowedOpenCount: () => allowedOpenCount
  };
}

async function verifyBrowser(relativePath) {
  const balanced = await loadContentScript(relativePath, 'balanced');
  assert.notEqual(
    balanced.open('https://example.org/movie'),
    null,
    `${relativePath}: balanced mode must allow ordinary external opens`
  );
  assert.equal(balanced.allowedOpenCount(), 1);
  assert.equal(balanced.events.length, 0);

  assert.equal(
    balanced.open('https://ads.al5sm.com/popup'),
    null,
    `${relativePath}: balanced mode must still block hostile hosts`
  );
  assert.equal(balanced.events.at(-1)?.event, 'window-open');

  // Hostile host classification must use the parsed URL authority, not text
  // before '@', a deceptive suffix, or a noncanonical spelling of the port.
  for (const hostile of [
    'https://user:secret@ads.al5sm.com/popup',
    'https://ads.al5sm.com:443/popup',
    'https://Sub.TMLL7.COM/popup',
    'https://ads.al5sm.com./popup',
    'https://WWW.NAP5K.COM./popup',
    'https://deep.Sub.TMLL7.COM./popup'
  ]) {
    assert.equal(balanced.open(hostile), null,
      relativePath + ': balanced must still block actual hostile authority ' + hostile);
  }
  for (const harmless of [
    'https://ads.al5sm.com@safe.example/popup',
    'https://al5sm.com.attacker.example/path',
    'https://al5sm.com.attacker.example./path'
  ]) {
    assert.notEqual(balanced.open(harmless), null,
      relativePath + ': a hostname-lookalike must not be blocked ' + harmless);
  }

  const strict = await loadContentScript(relativePath, 'strict');
  assert.equal(
    strict.open('https://example.org/movie'),
    null,
    `${relativePath}: strict mode must block external opens`
  );
  assert.equal(strict.allowedOpenCount(), 0);

  assert.notEqual(
    strict.open('https://origin.test/next'),
    null,
    `${relativePath}: strict mode must allow same-origin opens`
  );
  assert.equal(strict.allowedOpenCount(), 1);

  // Exercise link clicks, not only window.open: modified new-tab clicks must be guarded.
  assert.deepEqual(balanced.click('https://example.org/movie'), []);
  assert.deepEqual(
    balanced.click('https://sub.tmll7.com/popup', { target: '_self', ctrlKey: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile Ctrl-click must be intercepted'
  );
  assert.equal(balanced.events.at(-1)?.event, 'external-link');
  assert.deepEqual(
    balanced.click('https://WWW.NAP5K.COM./popup', { target: '_self', ctrlKey: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile DNS-root-dot control click must be intercepted'
  );
  assert.deepEqual(
    balanced.click('https://al5sm.com.attacker.example./popup', { target: '_blank' }),
    [],
    relativePath + ': root-dot suffix lookalike click must remain allowed'
  );
  assert.deepEqual(
    balanced.click('https://al5sm.com.attacker.example/'),
    [],
    relativePath + ': a lookalike domain must not be mistaken for a hostile subdomain'
  );
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup', { target: '_self' }),
    [],
    relativePath + ': ordinary same-tab navigation is not a popup gesture'
  );

  for (const gesture of [
    { target: '_blank' },
    { target: '_self', ctrlKey: true },
    { target: '_self', metaKey: true },
    { target: '_self', button: 1 }
  ]) {
    assert.deepEqual(
      strict.click('https://example.org/next', gesture),
      ['preventDefault', 'stopImmediatePropagation'],
      relativePath + ': strict mode must intercept each new-tab click gesture'
    );
  }
  assert.deepEqual(
    strict.click('https://origin.test/next', { target: '_blank' }),
    [],
    relativePath + ': strict mode must allow same-origin new-tab clicks'
  );
  assert.deepEqual(
    strict.click('https://example.org/next', { target: '_self' }),
    [],
    relativePath + ': strict mode must not prevent normal same-tab links'
  );
  assert.equal(
    strict.events.filter((event) => event.event === 'external-link').length,
    4,
    relativePath + ': each blocked click must be recorded once'
  );

  // Strict mode isolates origins rather than visual URL prefixes.
  for (const local of [
    '/next',
    'https://origin.test:443/next',
    'https://origin.test/watch?next=1'
  ]) {
    assert.notEqual(strict.open(local), null,
      relativePath + ': strict must retain canonical same-origin navigation ' + local);
  }
  for (const foreign of [
    'https://origin.test:8443/next',
    'https://origin.test@attacker.example/popup',
    'https://sub.origin.test/next'
  ]) {
    assert.equal(strict.open(foreign), null,
      relativePath + ': strict must reject deceptive/different-origin navigation ' + foreign);
    assert.deepEqual(strict.click(foreign, { target: '_blank' }),
      ['preventDefault', 'stopImmediatePropagation'],
      relativePath + ': strict click handler must enforce the same origin boundary');
  }

  // SVG links expose SVGAnimatedString.href/target with baseVal rather than
  // HTMLAnchorElement strings. Preserve hostile, strict, ordinary, relative
  // same-origin and disabled-mode semantics across Chrome, Firefox and zBrowse.
  const animated = (baseVal) => ({ baseVal });
  assert.deepEqual(
    balanced.click(animated('https://ads.al5sm.com/popup'),
      { target: animated('_blank') }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile inline SVG target=_blank must be intercepted'
  );
  assert.equal(balanced.events.at(-1)?.detail?.url, 'https://ads.al5sm.com/popup',
    relativePath + ': blocked SVG telemetry must carry the normalized URL');
  assert.deepEqual(
    balanced.click(animated('https://example.org/watch'),
      { target: animated('_blank') }),
    [], relativePath + ': ordinary SVG link stays allowed in balanced mode'
  );
  assert.deepEqual(
    strict.click(animated('https://example.org/watch'),
      { target: animated('_blank') }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': strict mode intercepts arbitrary external SVG popup'
  );
  assert.deepEqual(
    strict.click(animated('/next'), { target: animated('_blank') }),
    [], relativePath + ': same-origin relative SVG popup remains allowed'
  );
  assert.deepEqual(
    balanced.click(animated('https://ads.al5sm.com/popup'),
      { target: animated('_self') }),
    [], relativePath + ': ordinary same-tab SVG links retain navigation'
  );
  assert.deepEqual(
    balanced.click(animated('https://ads.al5sm.com/popup'),
      { target: animated('_self'), ctrlKey: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': modified hostile SVG click is still a popup gesture'
  );
  assert.deepEqual(
    strict.click(animated(''), { target: animated('_blank') }),
    [], relativePath + ': empty SVG href must never throw'
  );

  // Image-map hotspot events target HTMLAreaElement, not HTMLAnchorElement.
  // Preserve existing href/target policy and modified-click safeguards.
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup', { elementTag: 'area' }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile image-map area must be intercepted'
  );
  assert.deepEqual(
    balanced.click('https://example.org/video', { elementTag: 'area' }),
    [], relativePath + ': harmless image-map area must remain usable'
  );
  assert.deepEqual(
    strict.click('https://example.org/video', { elementTag: 'area' }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': strict mode rejects cross-origin image-map new tabs'
  );
  assert.deepEqual(
    strict.click('/next', { elementTag: 'area' }),
    [], relativePath + ': same-origin area must stay navigable'
  );
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup',
      { elementTag: 'area', target: '_self' }),
    [], relativePath + ': same-tab area should not be treated as popup'
  );
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup',
      { elementTag: 'area', target: '_self', ctrlKey: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': modified area gesture must be intercepted'
  );

  // Form submissions with target=_blank do not dispatch anchor click events.
  assert.deepEqual(
    balanced.submit('https://ads.al5sm.com/popup'),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile target=_blank form must be intercepted'
  );
  assert.deepEqual(
    balanced.submit('https://example.org/video'),
    [], relativePath + ': benign external form must remain usable in balanced mode'
  );
  assert.deepEqual(
    strict.submit('https://example.org/video'),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': strict form policy must block external new tabs'
  );
  assert.deepEqual(
    strict.submit('https://origin.test/next'),
    [], relativePath + ': same-origin form submission must remain available'
  );
  assert.deepEqual(
    balanced.submit('https://ads.al5sm.com/popup', { target: '_self' }),
    [], relativePath + ': ordinary same-tab form must remain available'
  );
  assert.deepEqual(
    balanced.submit('https://origin.test/next', {
      target: '_self',
      submitterAction: 'https://ads.al5sm.com/popup',
      submitterTarget: '_blank'
    }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': submitter formaction/formtarget must override the form target'
  );
  assert.deepEqual(
    strict.submit('https://example.org/video', { target: '_BLANK' }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': special target=_blank must be case-insensitive'
  );

  const disabled = await loadContentScript(relativePath, 'strict', false);
  assert.notEqual(
    disabled.open('https://ads.al5sm.com/popup'),
    null,
    relativePath + ': disabled mode must preserve native window.open'
  );
  assert.notEqual(
    disabled.open('https://ads.al5sm.com./popup'),
    null,
    relativePath + ': disabled mode must not filter DNS-root-dot hosts'
  );
  assert.deepEqual(disabled.click('https://ads.al5sm.com/popup'), []);
  assert.deepEqual(disabled.click('https://ads.al5sm.com/popup',
    { elementTag: 'area' }), [],
  relativePath + ': disabled mode must preserve native image-map hotspot behavior');
  assert.deepEqual(disabled.click({ baseVal: 'https://ads.al5sm.com/popup' },
    { target: { baseVal: '_blank' } }), [],
  relativePath + ': disabled guard must preserve SVG popup gestures');
  assert.deepEqual(disabled.submit('https://ads.al5sm.com/popup'), [],
    relativePath + ': disabled extension must not intercept forms');
  assert.equal(disabled.events.length, 0);
}

(async () => {
  await verifyBrowser('chromium/content.js');
  await verifyBrowser('firefox/content.js');
  await verifyBrowser('zbrowse/browser/zguard/content.js');
  console.log('zGuard content mode behavior tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
