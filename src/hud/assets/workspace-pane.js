// Workspace node rows — sub-project 1 of workspaces.
//
// A workspace is a declared system: services, what depends on what, and where
// each piece can come from. This pane is the smallest honest view of one — a
// row per node with its status, provider and URL, plus Up and Down. There is no
// graph drawing here yet; that is the next sub-project.
//
// The whole feature lives in this file. It is the *only* caller of the
// `workspace*` RPCs: core.js must not learn them, for the same reason it does
// not know about launch.json editing (see editor.js and test/hud.test.ts).
(function () {
  const { call, toast, projects, activeRoot, workspaces, extend, refresh } = window.baton;

  /** Build an element in one call — this file makes a lot of small ones. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // textContent throughout: node names, URLs and error text all come from a
    // manifest or a process, and none of it may be parsed as markup.
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, onClick, className) {
    const b = el('button', className, label);
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  const api = () => window.BatonWorkspace || {};

  /** Nodes in dependency order, falling back to declaration order. */
  function nodesOf(run) {
    const ordered = api().orderedNodes;
    return ordered ? ordered(run) : Object.values(run.nodes || {});
  }

  function toneOf(status) {
    const tone = api().nodeTone;
    return tone ? tone(status) : 'idle';
  }

  /** The project currently shown, or the only one, so the pane knows what to act on. */
  function currentProject() {
    const root = activeRoot();
    const all = projects();
    if (root) return all.find((p) => p.root === root);
    const withWorkspace = all.filter((p) => p.workspace);
    return withWorkspace.length === 1 ? withWorkspace[0] : undefined;
  }

  /** The live run for a project, matched by the id its description carries. */
  function runFor(project) {
    if (!project?.workspace) return undefined;
    return workspaces().find((run) => run.id === project.workspace.id
      || run.manifestPath === project.workspace.manifestPath);
  }

  let busy = false;

  async function act(label, fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      toast(label + ' failed: ' + err.message);
    } finally {
      busy = false;
      // Repaint once the action is over: the renders that happened *during* it
      // drew disabled buttons, and `up` changes which run a project points at.
      refresh();
    }
  }

  function providerSelect(run, node) {
    const select = el('select', 'node-provider');
    select.title = 'Where this node runs. Changing it restarts everything downstream.';
    // The manifest's other providers are not in the run, so the current one is
    // always present and correct; the rest arrive with the project description.
    const offered = node.providers || [node.provider];
    for (const name of offered) {
      const option = el('option', undefined, name);
      option.value = name;
      if (name === node.provider) option.selected = true;
      select.appendChild(option);
    }
    select.disabled = offered.length < 2 || busy;
    select.addEventListener('change', () => {
      const provider = select.value;
      act('Switch', async () => {
        toast(node.name + ' → ' + provider + '…');
        await call('workspaceSwitch', { id: run.id, node: node.name, provider });
      });
    });
    return select;
  }

  function nodeRow(run, node) {
    const row = el('div', 'node-row tone-' + toneOf(node.status));
    row.appendChild(el('span', 'node-dot'));
    row.appendChild(el('span', 'node-name', node.name));
    row.appendChild(el('span', 'node-status', node.status));
    row.appendChild(providerSelect(run, node));

    if (node.url) {
      const link = el('a', 'node-url', node.url);
      link.href = node.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      row.appendChild(link);
    } else {
      row.appendChild(el('span', 'spacer'));
    }

    // An external node is somebody else's: saying so is more useful than
    // offering a stop button that would be a lie.
    if (node.status === 'external' || node.readOnly) {
      const tag = el('span', 'node-tag', 'external');
      tag.title = 'Baton did not start this, and will not stop it.';
      row.appendChild(tag);
    } else {
      row.appendChild(button('Restart', 'Stop and start this node, then leave its dependents alone',
        () => act('Restart', async () => {
          await call('workspaceRestart', { id: run.id, node: node.name, cascade: false });
        }), 'ghost'));
    }

    if (node.error) {
      const why = el('div', 'node-error', node.error);
      const wrap = el('div', 'node-block');
      wrap.appendChild(row);
      wrap.appendChild(why);
      return wrap;
    }
    return row;
  }

  function pane(project, run) {
    const box = el('div', 'workspace-pane');
    const head = el('div', 'workspace-head');
    head.appendChild(el('span', 'pack-kind workflow', 'workspace'));
    head.appendChild(el('span', 'name', project.workspace.name));
    head.appendChild(el('span', 'spacer'));

    const up = button(run ? 'Up' : 'Start workspace', 'Bring every node up, in dependency order',
      () => act('Up', async () => {
        toast('Bringing ' + project.workspace.name + ' up…');
        const result = await call('workspaceUp', { cwd: project.root });
        const broken = Object.values(result.nodes).filter((n) => n.status === 'failed');
        toast(broken.length ? broken[0].name + ' failed: ' + broken[0].error : project.workspace.name + ' is up');
      }), 'primary');
    up.disabled = busy;
    head.appendChild(up);

    if (run) {
      const down = button('Down', 'Stop everything Baton started here', () => act('Down', async () => {
        const result = await call('workspaceDown', { id: run.id });
        // Never imply a full stop: what stayed up, stayed up on purpose.
        toast(result.left.length
          ? 'Stopped ' + result.stopped.length + '; left ' + result.left.join(', ') + ' (not ours)'
          : 'Stopped ' + result.stopped.length);
      }), 'danger');
      down.disabled = busy;
      head.appendChild(down);
    }
    box.appendChild(head);

    if (run) {
      for (const node of nodesOf(run)) box.appendChild(nodeRow(run, node));
    } else {
      const hint = el('div', 'node-hint');
      hint.textContent = project.workspace.nodes.join(' · ') + ' — not started yet';
      box.appendChild(hint);
    }
    return box;
  }

  extend({
    /** Painted on every core render, above the session list. */
    render(list) {
      const project = currentProject();
      if (!project?.workspace) return;
      const run = runFor(project);
      list.insertBefore(pane(project, run), list.firstChild);
    },
  });
}());
