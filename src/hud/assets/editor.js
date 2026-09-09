// project open + launch.json editor — Phase 1 track C
//
// Two features that answer the same complaint: you should never have to open an
// IDE to tell Baton about a project.
//
// A browser page cannot open a native folder picker, so "+" opens a directory
// browser built out of the daemon's own listing, annotated so a project is
// recognisable rather than remembered. And a project with no launch.json is not
// a dead end -- Baton offers to write one from what it already detected, and the
// ⚙ on each project tab edits it afterwards, either as a form or as raw JSONC.
//
// Hooks into core.js through `window.baton` rather than being wired into it, so
// the whole feature is this file plus its stylesheet block.
(function () {
  const { call, toast, projects, activeRoot, focusProject, refresh, extend, iconButton, iconEl } = window.baton;

  const basename = (path) => String(path).split(/[\\/]/).filter(Boolean).pop() || path;

  /** Build an element in one call -- this file makes a lot of small ones. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // textContent throughout: every string here is a path, a name or an
    // argument the user typed, and none of it may be parsed as markup.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, onClick, className) {
    const b = el('button', className, label);
    if (title) b.title = title;
    b.onclick = onClick;
    return b;
  }

  function field(label, value, onChange, placeholder) {
    const row = el('label', 'ed-field');
    row.appendChild(el('span', 'ed-key', label));
    const input = el('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    input.onchange = () => onChange(input.value);
    row.appendChild(input);
    return row;
  }

  // =========================================================================
  // the project browser
  // =========================================================================

  let modal = null;
  let listing = null;        // the last browseDirs result
  let here = null;           // the directory currently listed
  let creating = null;       // {project, text, targets} while offering a config

  function ensureModal() {
    if (modal) return modal;
    modal = el('div', 'sheet-wrap');
    modal.hidden = true;
    // Clicking the backdrop closes; clicking inside must not.
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    const sheet = el('div', 'sheet');
    sheet.appendChild(el('div', 'sheet-body'));
    modal.appendChild(sheet);
    document.body.appendChild(modal);
    return modal;
  }

  const sheetBody = () => modal.querySelector('.sheet-body');

  function closeModal() {
    if (modal) modal.hidden = true;
    creating = null;
  }

  async function openProject() {
    ensureModal();
    creating = null;
    modal.hidden = false;
    await browse(here ?? undefined);
  }

  async function browse(path) {
    try {
      listing = await call('browseDirs', { path });
    } catch (err) {
      return toast(err.message, true);
    }
    here = listing.path;
    paintBrowse();
  }

  /**
   * The path as clickable segments.
   *
   * Splitting on both separators so a Windows path is navigable too; the first
   * segment of a POSIX path is empty and stands for the root itself.
   */
  function crumbs(path) {
    const windows = /^[A-Za-z]:/.test(path);
    const sep = windows ? '\\' : '/';
    const parts = String(path).split(/[\\/]/);
    const out = [];
    let acc = '';
    parts.forEach((part, i) => {
      if (i === 0) {
        acc = part === '' ? sep : part;
        out.push({ label: part === '' ? sep : part, path: acc });
        return;
      }
      if (!part) return;
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
      out.push({ label: part, path: acc });
    });
    return out;
  }

  function paintBrowse() {
    const body = sheetBody();
    body.textContent = '';

    const head = el('div', 'sheet-head');
    head.appendChild(el('strong', null, 'Open a project'));
    head.appendChild(el('span', 'spacer'));
    head.appendChild(iconButton('close', 'Close', true, closeModal));
    body.appendChild(head);

    // Shortcuts: home, the folders this machine actually has, mounted volumes.
    const shortcuts = el('div', 'sheet-chips');
    for (const shortcut of listing.shortcuts) {
      const chip = el('div', 'chip' + (shortcut.path === here ? ' on' : ''), shortcut.label);
      chip.title = shortcut.path;
      chip.onclick = () => browse(shortcut.path);
      shortcuts.appendChild(chip);
    }
    body.appendChild(shortcuts);

    const crumbBar = el('div', 'crumbs');
    if (listing.parent) {
      crumbBar.appendChild(iconButton('up', 'Up one level', true, () => browse(listing.parent)));
    }
    crumbs(here).forEach((crumb, i, all) => {
      const part = el('span', 'crumb' + (i === all.length - 1 ? ' on' : ''), crumb.label);
      part.onclick = () => browse(crumb.path);
      crumbBar.appendChild(part);
    });
    body.appendChild(crumbBar);

    const list = el('div', 'sheet-list');
    if (listing.error) {
      list.appendChild(el('div', 'sheet-empty', listing.error));
    } else if (!listing.entries.length) {
      list.appendChild(el('div', 'sheet-empty', 'no projects or folders here'));
    }
    for (const entry of listing.entries) {
      const row = el('div', 'sheet-row' + (entry.isProject ? ' project' : ''));
      const nativeBundle = /\.(?:xcodeproj|xcworkspace)$/.test(entry.name);
      row.onclick = () => (entry.isDirectory && !nativeBundle) ? browse(entry.path) : openPath(entry.path);
      row.appendChild(iconEl('folder'));
      row.lastChild.classList.add('sheet-icon');
      row.appendChild(el('span', 'name', entry.name));
      if (entry.isProject) row.appendChild(el('span', 'tag', '▶ project'));
      if (!entry.isDirectory || nativeBundle) row.appendChild(el('span', 'tag', 'project file'));
      if (entry.hasLaunchJson) row.appendChild(el('span', 'tag', 'launch.json'));
      const open = button('Open', 'Track ' + entry.name + ' as a project', (e) => {
        e.stopPropagation();
        openPath(entry.path);
      }, entry.isProject ? 'go' : '');
      open.classList.add('sheet-go');
      row.appendChild(open);
      list.appendChild(row);
    }
    body.appendChild(list);

    // The escape hatch: a path pasted from a terminal beats any amount of
    // clicking, and `~` works the way it does in a shell.
    const manual = el('div', 'sheet-foot');
    const input = el('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = '~/code/my-app — or paste a path';
    input.onkeydown = (e) => { if (e.key === 'Enter') openPath(input.value.trim()); };
    manual.appendChild(input);
    manual.appendChild(button('Open', 'Open the path typed here', () => openPath(input.value.trim()), 'go'));
    manual.appendChild(button(
      'Open this folder',
      'Track ' + here + ' itself',
      () => openPath(here),
    ));
    body.appendChild(manual);

    const recent = projects();
    if (recent.length) {
      const bar = el('div', 'sheet-chips');
      bar.appendChild(el('span', 'ed-key', 'Recent'));
      for (const project of recent) {
        const chip = el('div', 'chip' + (project.root === activeRoot() ? ' on' : ''), project.name);
        chip.title = project.root;
        chip.onclick = async () => { await focusProject(project.root); closeModal(); };
        bar.appendChild(chip);
      }
      body.appendChild(bar);
    }
  }

  async function openPath(path) {
    if (!path) return;
    let project;
    try {
      project = await call('addProject', { path });
    } catch (err) {
      return toast(err.message, true);
    }
    // A real project with nothing runnable is not an error and is deliberately
    // not remembered yet -- this is the moment to offer to configure it.
    if (project.needsConfig) return offerConfig(project);
    await focusProject(project.root);
    closeModal();
    toast(project.name + ' — ' + project.targets.length + ' targets');
  }

  async function offerConfig(project) {
    creating = { project, text: '', targets: [] };
    try {
      const preview = await call('generateLaunchConfig', { root: project.root });
      creating.text = preview.text;
      creating.targets = preview.targets;
    } catch (err) {
      toast(err.message, true);
    }
    paintCreate();
  }

  function paintCreate() {
    const body = sheetBody();
    const { project, targets, text } = creating;
    body.textContent = '';

    const head = el('div', 'sheet-head');
    head.appendChild(el('strong', null, 'No launch config in ' + project.name));
    head.appendChild(el('span', 'spacer'));
    head.appendChild(iconButton('close', 'Close', true, closeModal));
    body.appendChild(head);

    body.appendChild(el('div', 'sheet-note', targets.length
      ? 'Baton found ' + targets.length + ' thing' + (targets.length === 1 ? '' : 's') +
        ' it can run here. Save this and they become launch configurations you can edit anywhere — ' +
        'VS Code and Cursor read the same file.'
      : 'Nothing was detected here automatically, so this is an empty file to fill in. ' +
        'Save it and use the form, or write it yourself.'));

    if (targets.length) {
      const chips = el('div', 'sheet-chips');
      for (const target of targets) {
        const chip = el('div', 'chip', target.name);
        chip.title = target.kind + ' · ' + target.source;
        chips.appendChild(chip);
      }
      body.appendChild(chips);
    }

    const preview = el('textarea', 'ed-raw');
    preview.spellcheck = false;
    preview.value = text;
    preview.oninput = () => { creating.text = preview.value; };
    body.appendChild(preview);

    const foot = el('div', 'sheet-foot');
    foot.appendChild(button('Save it', 'Write this file and start tracking the project', async () => {
      try {
        const written = await call('writeLaunchConfig', { root: project.root, text: preview.value });
        await focusProject(project.root);
        closeModal();
        toast(project.name + ' — ' + written.configs.length + ' configurations');
      } catch (err) { toast(err.message, true); }
    }, 'go'));
    foot.appendChild(button('Edit first', 'Open the editor with this as a starting point', () => {
      const draft = preview.value;
      closeModal();
      openEditor(project.root, draft);
    }));
    foot.appendChild(button('Cancel', 'Leave the project alone', closeModal));
    body.appendChild(foot);
  }

  // =========================================================================
  // the launch.json editor
  // =========================================================================

  let panel = null;
  let root = null;           // project being edited
  let view = null;           // the last readLaunchConfig result
  let generated = null;      // generateLaunchConfig, for "add configuration"
  let tab = 'form';
  let draft = '';            // the raw tab's text
  let edits = new Map();     // jsonc path (stringified) -> {path, value}
  let diagnostics = null;    // last validateLaunchConfig result for the draft
  let debounce;

  function ensurePanel() {
    if (panel) return panel;
    panel = el('div', 'ed');
    panel.hidden = true;
    document.querySelector('nav').after(panel);
    return panel;
  }

  function closeEditor() {
    if (panel) panel.hidden = true;
    clearTimeout(debounce);
    edits.clear();
  }

  async function openEditor(forRoot, startingDraft, keepTab) {
    ensurePanel();
    root = forRoot;
    edits.clear();
    generated = null;
    diagnostics = null;
    panel.hidden = false;
    try {
      view = await call('readLaunchConfig', { root });
    } catch (err) {
      return toast(err.message, true);
    }
    draft = startingDraft !== undefined ? startingDraft : (view.text ?? '');
    // A file that does not parse cannot be shown as a form, and an unsaved draft
    // has to be visible -- both start on the raw text. After a save, though, the
    // tab stays put: being bounced out of the text you are working in, as a
    // reward for saving it, is its own small betrayal.
    if (!keepTab || (tab === 'form' && view.parseErrors.length)) {
      tab = startingDraft !== undefined || view.parseErrors.length || !view.file ? 'raw' : 'form';
    }
    paintEditor();
  }

  /** Re-read from disk, so the panel shows what is actually there. */
  async function reloadEditor(keepTab) {
    await openEditor(root, undefined, keepTab === true);
  }

  function paintEditor() {
    panel.textContent = '';

    const head = el('div', 'ed-head');
    const title = el('span', 'name', basename(root) || root);
    title.title = view.file || root + ' (no launch.json yet)';
    head.appendChild(title);

    for (const name of ['form', 'raw']) {
      const t = el('div', 'chip' + (tab === name ? ' on' : ''), name === 'form' ? 'Form' : 'Raw');
      t.onclick = () => {
        // Switching away from a form with unsaved edits would silently drop
        // them, so say so rather than losing someone's work.
        if (tab === 'form' && name === 'raw' && queuedBlocks('leaving the form')) return;
        tab = name;
        paintEditor();
      };
      head.appendChild(t);
    }

    head.appendChild(el('span', 'spacer'));
    head.appendChild(iconButton('close', 'Close the editor', true, closeEditor));
    panel.appendChild(head);

    const body = el('div', 'ed-body');
    panel.appendChild(body);
    if (tab === 'raw') paintRaw(body);
    else paintForm(body);
    // A repaint mid-edit (adding an argument, removing an env row) must not
    // throw the reader back to the top of a long file.
    body.scrollTop = scrollWas;
  }

  /** Kept across repaints so editing configuration nine does not scroll to one. */
  let scrollWas = 0;

  function repaint() {
    const body = panel.querySelector('.ed-body');
    scrollWas = body ? body.scrollTop : 0;
    paintEditor();
  }

  // --- form tab ------------------------------------------------------------

  function paintForm(body) {
    if (view.parseErrors.length) {
      body.appendChild(el('div', 'ed-err',
        'This file cannot be read as JSON, so there is no form to show. Fix it in the Raw tab.'));
      for (const error of view.parseErrors) {
        body.appendChild(el('div', 'ed-err', error.line + ':' + error.col + '  ' + error.message));
      }
      return;
    }
    if (!view.configs.length) {
      body.appendChild(el('div', 'sheet-empty', 'no configurations yet'));
    }

    view.configs.forEach((config, i) => {
      body.appendChild(configCard(config, view.configIndexes[i]));
    });

    body.appendChild(addConfigRow());

    const foot = el('div', 'ed-foot');
    const save = button('Save', 'Write these changes, keeping the file\'s comments and layout', saveForm, 'go ed-save');
    save.disabled = edits.size === 0;
    foot.appendChild(save);
    // Always present, enabled alongside Save. Rendering it only when there are
    // edits would mean it never appeared for a plain text change, which does not
    // repaint -- leaving "save or discard" as advice with nothing to click.
    const discard = button('Discard', 'Throw these changes away and show the file as it is',
      discardEdits, 'ed-discard');
    discard.disabled = edits.size === 0;
    foot.appendChild(discard);
    foot.appendChild(el('span', 'ed-key',
      edits.size ? edits.size + ' unsaved change' + (edits.size === 1 ? '' : 's') : 'no changes'));
    body.appendChild(foot);
  }

  /**
   * Queue a change to one key of one configuration.
   *
   * An emptied optional field is sent as `undefined`, which deletes the key
   * rather than writing `""` -- a `"program": ""` is a configuration that fails
   * at launch, not one that falls back to the default entrypoint.
   *
   * `structural` repaints. A plain text field must NOT: the input already shows
   * what was typed, and rebuilding the card under the cursor would take the
   * focus away mid-edit. Chips and env rows change the shape of the card, so
   * those do repaint -- and every field reads through `current()` so a repaint
   * shows the queued value rather than reverting to what is on disk.
   */
  function set(index, key, value, structural) {
    const path = ['configurations', index, key];
    edits.set(JSON.stringify(path), { path, value });
    if (structural) return repaint();
    for (const selector of ['.ed-save', '.ed-discard']) {
      const b = panel.querySelector(selector);
      if (b) b.disabled = false;
    }
    const count = panel.querySelector('.ed-foot .ed-key');
    if (count) count.textContent = edits.size + ' unsaved change' + (edits.size === 1 ? '' : 's');
  }

  /**
   * Refuse an action that would throw queued form edits away.
   *
   * Remove and Add both apply an edit of their own and then land in
   * `afterSave`, which clears the queue -- so a rename typed into card 0 used to
   * vanish the moment Remove was pressed on card 2, with a success toast on top.
   * Both re-address indices too, which is why flushing first is not enough to
   * make it safe. The tab switch already refused for this reason; now they all
   * refuse the same way, and the form offers a Discard so refusing is not a
   * dead end.
   */
  function queuedBlocks(what) {
    if (!edits.size) return false;
    toast(
      'save or discard the ' + edits.size + ' unsaved change' +
        (edits.size === 1 ? '' : 's') + ' before ' + what,
      true,
    );
    return true;
  }

  function discardEdits() {
    edits.clear();
    repaint();
  }

  /** What a field should show: the queued edit if there is one, else the file. */
  function current(config, index, key) {
    const pending = edits.get(JSON.stringify(['configurations', index, key]));
    return pending ? pending.value : config[key];
  }

  function configCard(config, index) {
    const card = el('div', 'ed-card');

    const head = el('div', 'ed-card-head');
    head.appendChild(el('span', 'tag', config.kind));
    head.appendChild(el('span', 'name', config.name));
    head.appendChild(el('span', 'spacer'));
    head.appendChild(button('Remove', 'Delete this configuration from the file', () => {
      if (queuedBlocks('removing a configuration')) return;
      if (!confirm('Remove "' + config.name + '" from launch.json?')) return;
      // Applied on its own rather than queued: removing shifts every later
      // index, and a queued edit addressed by the old index would then land on
      // the wrong configuration.
      applyEdits([{ path: ['configurations', index], value: undefined }], 'removed ' + config.name);
    }, 'danger'));
    card.appendChild(head);

    const value = (key) => current(config, index, key);

    card.appendChild(field('name', value('name'), (v) => {
      if (!v.trim()) return toast('a configuration needs a name', true);
      set(index, 'name', v.trim());
    }));

    if (config.kind === 'flutter') {
      card.appendChild(field('program', value('program'), (v) => set(index, 'program', v || undefined),
        'lib/main.dart'));
      card.appendChild(field('deviceId', value('deviceId'), (v) => set(index, 'deviceId', v || undefined),
        'left blank: pick a device at run time'));
      card.appendChild(chipsField('toolArgs', value('toolArgs') ?? [], index, 'toolArgs', config));
      card.appendChild(chipsField('args', value('args') ?? [], index, 'args', config));
    } else {
      card.appendChild(field('command', value('runtimeExecutable'),
        (v) => set(index, 'runtimeExecutable', v || undefined), 'npm'));
      card.appendChild(chipsField('runtimeArgs', value('runtimeArgs') ?? [], index, 'runtimeArgs', config));
      // `args` is read by the loader for both kinds but only ever *used* by a
      // Flutter run, so offering an empty one here would invite someone to fill
      // in a key that does nothing. Shown only when the file already has one, so
      // a stray copy is visible and removable rather than invisible and inert.
      const inert = value('args') ?? [];
      if (inert.length) {
        const row = chipsField('args', inert, index, 'args', config);
        row.title = 'Only a Flutter configuration passes these to the app; here they are ignored';
        row.querySelector('.ed-key').textContent = 'args (unused)';
        card.appendChild(row);
      }
      const port = value('port');
      card.appendChild(field('port', port === undefined ? '' : String(port), (v) => {
        const n = Number(v);
        if (v && !Number.isFinite(n)) return toast('port must be a number', true);
        set(index, 'port', v ? n : undefined);
      }, 'the port this serves on, if any'));
    }

    card.appendChild(envField(value('env') ?? {}, index));
    return card;
  }

  /**
   * A string array as removable chips plus one input to add to it.
   *
   * Edited as a whole array rather than per element: `modify` addressing a
   * single element by index would need re-indexing after every removal, and a
   * whole-array write is what the reader means anyway.
   */
  function chipsField(label, values, index, key, config) {
    const row = el('div', 'ed-field ed-chips');
    row.appendChild(el('span', 'ed-key', label));
    const box = el('div', 'ed-chipbox');

    const write = (next) => set(index, key, next.length ? next : undefined, true);
    const issues = (view.issues[config.name] || []);

    values.forEach((value, i) => {
      const chip = el('span', 'ed-chip');
      // A --dart-define-from-file pointing at a file that is not there is the
      // single most common reason a config that looks fine will not run, so it
      // is marked here rather than only at launch.
      const define = /^--dart-define-from-file[= ]/.test(value);
      if (define) {
        const missing = issues.some((issue) => value.includes(issue.path));
        const mark = el('span', missing ? 'ed-warn' : 'ed-ok', missing ? '⚠' : '✓');
        mark.title = missing
          ? (issues.find((issue) => value.includes(issue.path)) || {}).hint || 'file not found'
          : 'that file exists';
        chip.appendChild(mark);
      }
      chip.appendChild(el('span', null, value));
      const x = el('span', 'x', '×');
      x.title = 'Remove this argument';
      x.onclick = () => write(values.filter((_, j) => j !== i));
      chip.appendChild(x);
      box.appendChild(chip);
    });

    const add = el('input');
    add.type = 'text';
    add.spellcheck = false;
    add.placeholder = '+ add';
    add.onkeydown = (e) => {
      if (e.key !== 'Enter' || !add.value.trim()) return;
      write([...values, add.value.trim()]);
    };
    box.appendChild(add);
    row.appendChild(box);
    return row;
  }

  function envField(env, index) {
    const row = el('div', 'ed-field ed-chips');
    row.appendChild(el('span', 'ed-key', 'env'));
    const box = el('div', 'ed-envbox');

    const write = (next) => set(index, 'env', Object.keys(next).length ? next : undefined, true);

    for (const [key, value] of Object.entries(env)) {
      const line = el('div', 'ed-env');
      const k = el('input');
      k.type = 'text'; k.spellcheck = false; k.value = key;
      k.onchange = () => {
        const next = {};
        // Rebuilt in order so renaming a key does not move it to the end.
        for (const [oldKey, oldValue] of Object.entries(env)) {
          next[oldKey === key ? k.value : oldKey] = oldValue;
        }
        write(next);
      };
      const v = el('input');
      v.type = 'text'; v.spellcheck = false; v.value = value;
      v.onchange = () => write({ ...env, [key]: v.value });
      const x = el('span', 'x', '×');
      x.title = 'Remove ' + key;
      x.onclick = () => {
        const next = { ...env };
        delete next[key];
        write(next);
      };
      line.appendChild(k);
      line.appendChild(v);
      line.appendChild(x);
      box.appendChild(line);
    }

    const add = el('input');
    add.type = 'text';
    add.spellcheck = false;
    add.placeholder = '+ NAME=value';
    add.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const match = /^([^=]+)=(.*)$/.exec(add.value.trim());
      if (!match) return toast('write it as NAME=value', true);
      write({ ...env, [match[1].trim()]: match[2] });
    };
    box.appendChild(add);
    row.appendChild(box);
    return row;
  }

  /** Offer the detected targets that are not configurations yet. */
  function addConfigRow() {
    const row = el('div', 'ed-add');
    if (!generated) {
      row.appendChild(button('+ Add configuration', 'See what else could be run here', async () => {
        try {
          generated = await call('generateLaunchConfig', { root });
        } catch (err) { return toast(err.message, true); }
        paintEditor();
      }));
      return row;
    }

    const have = new Set(view.configs.map((c) => c.name));
    const missing = generated.targets.filter((t) => !have.has(t.name));
    if (!missing.length) {
      row.appendChild(el('span', 'ed-key', 'everything detected here is already configured'));
      return row;
    }
    row.appendChild(el('span', 'ed-key', 'add'));
    for (const target of missing) {
      const chip = el('div', 'chip', '+ ' + target.name);
      chip.title = 'Add a ' + target.kind + ' configuration for ' + target.name;
      chip.onclick = () => addConfiguration(target);
      row.appendChild(chip);
    }
    return row;
  }

  async function addConfiguration(target) {
    if (queuedBlocks('adding a configuration')) return;
    // Take the shape from the generator rather than rebuilding it here: it is
    // the one place that knows what `loader.ts` reads back.
    let body;
    try {
      const parsed = JSON.parse(stripComments(generated.text));
      body = (parsed.configurations || []).find((c) => c.name === target.name);
    } catch { /* fall through to the guard below */ }
    if (!body) return toast('could not work out a configuration for ' + target.name, true);
    // The raw array's length, not one past the last *named* entry: a file whose
    // last entry has no name is skipped by `configs`, and writing at that
    // entry's index would replace it instead of appending after it. Applied on
    // its own so no queued edit is addressed against a stale length.
    const at = view.configCount;
    await applyEdits([{ path: ['configurations', at], value: body }], 'added ' + target.name);
  }

  /** The generator's header is `//` lines only, so this is enough to JSON.parse it. */
  const stripComments = (text) =>
    String(text).split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  const saveForm = () => applyEdits([...edits.values()], 'saved');

  async function applyEdits(list, what) {
    if (!list.length) return;
    try {
      const result = await call('editLaunchConfig', {
        root, edits: list, expectedMtimeMs: view.mtimeMs,
      });
      await afterSave(result, what);
    } catch (err) {
      if (/conflict/.test(err.message)) {
        return offerConflict(err.message, () =>
          call('editLaunchConfig', { root, edits: list }).then((r) => afterSave(r, what)));
      }
      toast(err.message, true);
    }
  }

  async function afterSave(result, what) {
    edits.clear();
    toast(what + ' → ' + result.file);
    // The set of runnable targets just changed, so the picker and the tabs have
    // to be rebuilt, not just this panel.
    await refresh();
    await reloadEditor(true);
  }

  // --- raw tab -------------------------------------------------------------

  function paintRaw(body) {
    const area = el('textarea', 'ed-raw');
    area.spellcheck = false;
    area.value = draft;
    area.oninput = () => {
      draft = area.value;
      clearTimeout(debounce);
      // Debounced: this is a round trip to the daemon, and validating a file
      // that is mid-keystroke would flash errors for every half-typed key.
      debounce = setTimeout(checkDraft, 400);
    };
    body.appendChild(area);

    const report = el('div', 'ed-report');
    body.appendChild(report);
    paintReport(report);

    const foot = el('div', 'ed-foot');
    foot.appendChild(button('Save', 'Replace the file with this text', saveRaw, 'go'));
    foot.appendChild(button('Revert', 'Throw this away and re-read the file', reloadEditor));
    body.appendChild(foot);
  }

  async function checkDraft() {
    try {
      diagnostics = await call('validateLaunchConfig', { root, text: draft });
    } catch (err) {
      return toast(err.message, true);
    }
    const report = panel.querySelector('.ed-report');
    if (report) paintReport(report);
  }

  function paintReport(report) {
    report.textContent = '';
    if (!diagnostics) return;
    for (const error of diagnostics.parseErrors) {
      report.appendChild(el('div', 'ed-err', error.line + ':' + error.col + '  ' + error.message));
    }
    if (diagnostics.parseErrors.length) return;

    let clean = true;
    for (const [name, issues] of Object.entries(diagnostics.issues)) {
      for (const issue of issues) {
        clean = false;
        report.appendChild(el('div', 'ed-warn',
          name + ': missing ' + issue.path + ' — ' + issue.hint));
      }
    }
    if (clean) report.appendChild(el('div', 'ed-ok', '✓ valid, nothing blocking'));
  }

  async function saveRaw() {
    const text = draft;
    try {
      const result = await call('writeLaunchConfig', { root, text, expectedMtimeMs: view.mtimeMs });
      await afterSave(result, 'saved');
    } catch (err) {
      if (/conflict/.test(err.message)) {
        // Retrying without the guard is exactly "overwrite anyway".
        return offerConflict(err.message, () =>
          call('writeLaunchConfig', { root, text }).then((r) => afterSave(r, 'overwrote')));
      }
      toast(err.message, true);
    }
  }

  /**
   * Someone else saved this file while it was open here.
   *
   * Neither answer is safe to pick automatically -- discarding their change and
   * discarding yours are both real losses -- so both are offered by name.
   */
  function offerConflict(message, overwrite) {
    const body = panel.querySelector('.ed-body');
    if (!body) return;
    const bar = el('div', 'ed-conflict');
    bar.appendChild(el('span', null, message + ' — someone else saved it while this was open.'));
    bar.appendChild(button('Reload theirs', 'Throw away these changes and re-read the file', reloadEditor));
    bar.appendChild(button('Overwrite', 'Replace what is on disk with what is here', async () => {
      try { await overwrite(); } catch (err) { toast(err.message, true); }
    }, 'danger'));
    body.insertBefore(bar, body.firstChild);
  }

  // =========================================================================
  // wiring into the HUD
  // =========================================================================

  extend({
    openProject,

    chip(project, element) {
      const gear = iconButton('inspect', 'Edit ' + project.name + '’s launch.json', true, (e) => {
        e.stopPropagation();
        openEditor(project.root);
      });
      element.appendChild(gear);
    },
  });
})();
