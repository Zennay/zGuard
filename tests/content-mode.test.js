const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function loadContentScript(relativePath, mode, enabled = true, overrideSource = null) {
  const source = overrideSource ?? fs.readFileSync(path.join(root, relativePath), 'utf8');
  const events = [];
  let allowedOpenCount = 0;
  let clickHandler;
  let auxclickHandler;
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
        if (name === 'auxclick') auxclickHandler = listener;
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
    click(href, { target = '_blank', ctrlKey = false, metaKey = false,
      button = 0, elementTag = 'a', eventType = 'click', shadow = false } = {}) {
      const actions = [];
      // Retarget to a host on document capture but preserve the inner link
      // in composedPath(), exactly as open Shadow DOM does in the browser.
      const clickedNode = {
        closest: (selector) => selector.split(',').includes(elementTag)
          ? { href, target } : null
      };
      const shadowHost = { closest: () => null };
      const event = {
        type: eventType,
        target: shadow ? shadowHost : clickedNode,
        composedPath() { return shadow ? [clickedNode, shadowHost] : [clickedNode]; },
        ctrlKey, metaKey, button,
        preventDefault() { actions.push('preventDefault'); },
        stopImmediatePropagation() { actions.push('stopImmediatePropagation'); }
      };
      const handler = eventType === 'auxclick' ? auxclickHandler : clickHandler;
      if (handler) handler(event);
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

  // Browsers treat reserved browsing-context targets such as _blank as
  // ASCII case-insensitive. A hostile link with target=_BLANK must not
  // bypass click protection while normal external and same-origin targets
  // remain available across Chromium, Firefox and the zBrowse bundle.
  for (const target of ['_BLANK', '_BlAnK']) {
    for (const options of [{ target }, { target, elementTag: 'area' },
      { target, shadow: true }]) {
      assert.deepEqual(
        balanced.click('https://ads.al5sm.com/popup', options),
        ['preventDefault', 'stopImmediatePropagation'],
        relativePath + ': mixed-case popup target must block hostile links'
      );
      assert.deepEqual(
        strict.click('https://example.org/popup', options),
        ['preventDefault', 'stopImmediatePropagation'],
        relativePath + ': strict mode must block mixed-case new-tab targets'
      );
      assert.deepEqual(
        strict.click('/same-origin', options), [],
        relativePath + ': same-origin mixed-case target must stay usable'
      );
      assert.deepEqual(
        balanced.click('https://example.org/popup', options), [],
        relativePath + ': balanced mode must allow ordinary mixed-case targets'
      );
    }
  }

  // A non-reserved named target can open a separate tab/window when no
  // matching browsing context exists. A hostile site must not escape the
  // guard merely by replacing _blank with a name; keep the browser's
  // same-context special keywords and harmless destinations available.
  for (const target of ['adPopupWindow', 'reportPanel']) {
    for (const options of [{ target }, { target, elementTag: 'area' },
      { target, shadow: true }]) {
      assert.deepEqual(balanced.click('https://ads.al5sm.com/popup', options),
        ['preventDefault', 'stopImmediatePropagation'],
        relativePath + ': named window must not bypass hostile-host protection');
      assert.deepEqual(strict.click('https://example.org/video', options),
        ['preventDefault', 'stopImmediatePropagation'],
        relativePath + ': strict mode must guard named cross-origin contexts');
      assert.deepEqual(strict.click('/same-origin', options), [],
        relativePath + ': named same-origin browsing is not blocked');
      assert.deepEqual(balanced.click('https://example.org/video', options), [],
        relativePath + ': harmless named browsing is preserved in balanced mode');
    }
    assert.deepEqual(balanced.submit('https://ads.al5sm.com/popup', { target }),
      ['preventDefault', 'stopImmediatePropagation'],
      relativePath + ': named hostile form targets must be intercepted');
    assert.deepEqual(strict.submit('https://example.org/video', { target }),
      ['preventDefault', 'stopImmediatePropagation'],
      relativePath + ': strict named form submission must not create an external window');
    assert.deepEqual(strict.submit('/same-origin', { target }), [],
      relativePath + ': named same-origin form remains available');
    assert.deepEqual(strict.submit('/same-origin', { target: '_self',
      submitterAction: 'https://example.org/video', submitterTarget: target }),
      ['preventDefault', 'stopImmediatePropagation'],
      relativePath + ': named formtarget override must not bypass strict mode');
  }
  for (const target of ['', '_self', '_PARENT', '_TOP', '_unfencedTop']) {
    assert.deepEqual(balanced.click('https://ads.al5sm.com/popup', { target }), [],
      relativePath + ': same-context special target must not become a popup');
    assert.deepEqual(strict.submit('https://example.org/video', { target }), [],
      relativePath + ': same-context form target must remain navigable');
  }

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

  // Source-executing browser parity: shadow-retargeted popup gestures.
  assert.deepEqual(balanced.click('https://ads.al5sm.com/popup', { shadow: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile Shadow DOM popup must be intercepted');
  assert.equal(balanced.events.at(-1)?.event, 'external-link',
    relativePath + ': shadow interception preserves existing telemetry');
  assert.deepEqual(balanced.click('https://example.org/watch', { shadow: true }),
    [], relativePath + ': benign shadow popup stays available in balanced mode');
  assert.deepEqual(balanced.click('https://ads.al5sm.com/popup',
    { shadow: true, target: '_self', ctrlKey: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile shadow Ctrl-click must be intercepted');
  assert.deepEqual(balanced.click('https://ads.al5sm.com/popup',
    { shadow: true, target: '_self' }),
    [], relativePath + ': ordinary same-tab shadow link stays available');
  assert.deepEqual(balanced.click('https://ads.al5sm.com/popup',
    { shadow: true, elementTag: 'span' }),
    [], relativePath + ': unrelated shadow node is not a link');
  assert.deepEqual(strict.click('https://example.org/watch', { shadow: true }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': strict mode blocks external shadow-root popups');
  assert.deepEqual(strict.click('/next', { shadow: true }),
    [], relativePath + ': strict mode allows same-origin shadow-root popups');
  assert.deepEqual(strict.click('https://ads.al5sm.com/popup',
    { shadow: true, elementTag: 'area' }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': shadow-root image-map hotspot stays protected');

  // Actual browser middle-button release emits auxclick, not click.
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup',
      { target: '_self', button: 1, eventType: 'auxclick' }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': hostile native middle auxclick must be intercepted'
  );
  assert.deepEqual(
    balanced.click('https://example.org/video',
      { target: '_self', button: 1, eventType: 'auxclick' }),
    [], relativePath + ': harmless middle auxclick must remain available'
  );
  assert.deepEqual(
    strict.click('https://example.org/video',
      { target: '_self', button: 1, eventType: 'auxclick' }),
    ['preventDefault', 'stopImmediatePropagation'],
    relativePath + ': strict middle auxclick must block external navigation'
  );
  assert.deepEqual(
    strict.click('/next',
      { target: '_self', button: 1, eventType: 'auxclick' }),
    [], relativePath + ': same-origin middle auxclick must remain available'
  );
  assert.deepEqual(
    balanced.click('https://ads.al5sm.com/popup',
      { target: '_blank', button: 2, eventType: 'auxclick' }),
    [], relativePath + ': ordinary right-button auxclick must not be blocked'
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
  assert.deepEqual(disabled.click('https://ads.al5sm.com/popup',
    { button: 1, eventType: 'auxclick' }), [],
  relativePath + ': disabled mode must preserve native middle click');
  assert.deepEqual(disabled.click('https://ads.al5sm.com/popup',
    { shadow: true }), [],
    relativePath + ': disabled mode preserves native shadow popup behavior');
  assert.deepEqual(disabled.submit('https://ads.al5sm.com/popup'), [],
    relativePath + ': disabled extension must not intercept forms');
  assert.equal(disabled.events.length, 0);
}

// Mutate the shipped source in memory and run the SAME content VM harness.
// If named contexts, form submitters or case-insensitive reserved keywords
// silently regress, these controls must actually fail observable assertions.
async function verifyPopupTargetMutationControls(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  async function broken(label, original, replacement, mode, verify) {
    assert.ok(source.includes(original),
      relativePath + ': expected mutation source missing: ' + label);
    const altered = source.replace(original, replacement);
    assert.notEqual(altered, source, label + ': mutation must change source');
    const script = await loadContentScript(relativePath, mode, true, altered);
    assert.throws(() => verify(script), { code: 'ERR_ASSERTION' },
      relativePath + ': ' + label + ' regression must cause a genuine behavioral failure');
  }
  await broken('named anchor bypass',
    'opensSeparateContext(target) || event.ctrlKey',
    "target.toLowerCase() === '_blank' || event.ctrlKey",
    'balanced', (app) => assert.deepEqual(
      app.click('https://ads.al5sm.com/popup', { target: 'adPopupWindow' }),
      ['preventDefault', 'stopImmediatePropagation']));
  await broken('named form bypass',
    '!opensSeparateContext(target)',
    "String(target).toLowerCase() !== '_blank'",
    'strict', (app) => assert.deepEqual(
      app.submit('https://example.org/video', { target: 'reportPanel' }),
      ['preventDefault', 'stopImmediatePropagation']));
  await broken('lost case-folding of special targets',
    "const name = String(target || '').toLowerCase();",
    "const name = String(target || '');",
    'balanced', (app) => assert.deepEqual(
      app.click('https://ads.al5sm.com/popup', { target: '_PARENT' }), []));
  await broken('named-window classifier narrowed to _blank',
    "return Boolean(name) && !['_self', '_parent', '_top', '_unfencedtop'].includes(name);",
    "return name === '_blank';",
    'strict', (app) => assert.deepEqual(
      app.submit('https://example.org/video', { target: 'reportPanel' }),
      ['preventDefault', 'stopImmediatePropagation']));
}

(async () => {
  await verifyBrowser('chromium/content.js');
  await verifyBrowser('firefox/content.js');
  await verifyBrowser('zbrowse/browser/zguard/content.js');
  for (const relativePath of [
    'chromium/content.js', 'firefox/content.js', 'zbrowse/browser/zguard/content.js'
  ]) await verifyPopupTargetMutationControls(relativePath);
  console.log('zGuard content mode behavior and 12 popup-target mutations passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
