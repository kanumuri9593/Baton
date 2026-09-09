/**
 * Named HUD icons. 16×16, 1.75px stroke, currentColor so they follow the theme.
 *
 * Reload is a closed loop (state stays). Restart is that loop with a skip,
 * so the two cannot be mistaken for each other at 16px.
 */
(function (g) {
  const wrap = (inner, extra) =>
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ' +
    'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
    'stroke-linejoin="round"' + (extra ? ' ' + extra : '') + '>' + inner + '</svg>';

  g.BatonIcons = {
    run: wrap('<path d="M4 3.2 12.6 8 4 12.8Z" fill="currentColor" stroke="none"/>'),
    reload: wrap(
      '<path d="M3 8a5 5 0 0 1 8.4-3.6"/>' +
      '<path d="M11.4 2.4v3.1H8.3"/>' +
      '<path d="M13 8a5 5 0 0 1-8.4 3.6"/>' +
      '<path d="M4.6 13.6v-3.1h3.1"/>',
    ),
    restart: wrap(
      '<path d="M3 8a5 5 0 0 1 8.4-3.6"/>' +
      '<path d="M11.4 2.4v3.1H8.3"/>' +
      '<path d="M5.2 10.4h6.2"/>' +
      '<path d="M9.4 8.4 12.2 10.4 9.4 12.4"/>',
    ),
    stop: wrap('<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none"/>'),
    logs: wrap('<path d="M3 4.2h10M3 8h10M3 11.8h6.5"/>'),
    network: wrap(
      '<path d="M2.2 5.2h8.2"/>' +
      '<path d="M8.4 3.2 10.4 5.2 8.4 7.2"/>' +
      '<path d="M13.8 10.8H5.6"/>' +
      '<path d="M7.6 8.8 5.6 10.8 7.6 12.8"/>',
    ),
    expand: wrap('<path d="M9.2 3h4v4M13.2 3 9 7M6.8 13h-4V9M2.8 13 7 9"/>'),
    minimize: wrap('<path d="M13.2 7V3h-4M13.2 3 9 7M2.8 9v4h4M2.8 13 7 9"/>'),
    chevron: wrap('<path d="M6 3.8 10.2 8 6 12.2"/>'),
    external: wrap('<path d="M9 3h4v4M13 3 6.5 9M5 5.2V13h8"/>'),
    inspect: wrap('<circle cx="7.2" cy="7.2" r="4"/><path d="M10.4 10.4 14 13.8"/>'),
    clear: wrap('<circle cx="8" cy="8" r="5.4"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/>'),
    copy: wrap('<rect x="5.2" y="5" width="7.4" height="8.4" rx="1.4"/><path d="M3.6 10.6V3.8A1.4 1.4 0 0 1 5 2.4h6"/>'),
    warning: wrap('<path d="M8 2.4 14.2 13.4H1.8Z"/><path d="M8 6.4v3.4M8 12.2h.01"/>'),
    close: wrap('<path d="M4 4l8 8M12 4l-8 8"/>'),
    up: wrap('<path d="M8 12.4V4M4.6 7.4 8 4l3.4 3.4"/>'),
    folder: wrap('<path d="M2.5 4.2h4.2l1.2 1.6H13.5v7.6H2.5Z"/>'),
    ios: wrap(
      '<rect x="5" y="2.2" width="6" height="11.6" rx="1.6"/>' +
      '<path d="M7.2 11.8h1.6"/>',
    ),
    android: wrap(
      '<path d="M5.2 7.2h5.6v5.2H5.2Z"/>' +
      '<path d="M6.2 4.4 5 3.2M9.8 4.4 11 3.2"/>' +
      '<path d="M5.6 6.2a2.4 2.4 0 0 1 4.8 0"/>' +
      '<path d="M6.4 8.6h.01M9.6 8.6h.01"/>',
    ),
    web: wrap(
      '<circle cx="8" cy="8" r="5.2"/>' +
      '<path d="M2.8 8h10.4M8 2.8c1.6 1.8 2.4 3.6 2.4 5.2S9.6 11.4 8 13.2C6.4 11.4 5.6 9.6 5.6 8S6.4 4.6 8 2.8Z"/>',
    ),
    grid: wrap(
      '<rect x="3" y="3" width="4" height="4" rx="0.8"/>' +
      '<rect x="9" y="3" width="4" height="4" rx="0.8"/>' +
      '<rect x="3" y="9" width="4" height="4" rx="0.8"/>' +
      '<rect x="9" y="9" width="4" height="4" rx="0.8"/>',
    ),
    plus: wrap('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
    settings: wrap(
      '<circle cx="8" cy="8" r="2.2"/>' +
      '<path d="M8 2.2v1.2M8 12.6v1.2M2.2 8h1.2M12.6 8h1.2M3.9 3.9l.9.9M11.2 11.2l.9.9M12.1 3.9l-.9.9M4.8 11.2l-.9.9"/>',
    ),
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
