(() => {
  const { call } = window.baton;
  const panel = document.getElementById('diagnostics');
  const input = document.createElement('input'); input.type = 'text';
  input.placeholder = 'Search error, path or trace ID'; input.setAttribute('aria-label', 'Diagnostic search');
  const allLabel = document.createElement('label');
  const all = document.createElement('input'); all.type = 'checkbox';
  allLabel.append(all, ' Include successful requests');
  const search = document.createElement('button'); search.textContent = 'Search';
  const result = document.createElement('div'); result.setAttribute('aria-live','polite');
  panel.append(input, allLabel, search, result);
  let request = 0;
  async function run() {
    const current = ++request;
    result.textContent = 'Searching…';
    try {
      const data = await call('diagnose', { query:input.value, errorsOnly:!all.checked, limit:20 });
      if (current !== request) return;
      result.replaceChildren();
      const count = document.createElement('p'); count.textContent = `${data.total} matches across ${data.scope.length} sessions`;
      result.appendChild(count);
      for (const finding of data.findings) {
        const item = document.createElement('p');
        item.textContent = `${finding.session} · ${finding.kind}: ${finding.message}`;
        if (finding.traceId) {
          const trace = document.createElement('button'); trace.textContent = 'Follow trace'; trace.title = finding.traceId;
          trace.onclick = () => { input.value=finding.traceId; all.checked=true; run(); };
          item.appendChild(trace);
        }
        result.appendChild(item);
      }
    } catch(error) { if(current === request) result.textContent=error.message; }
  }
  search.onclick=run;
  input.onkeydown=(event)=>{if(event.key==='Enter') run();};
  document.getElementById('diagnoseBtn').onclick=()=>{panel.hidden=!panel.hidden;if(!panel.hidden)run();};
})();
