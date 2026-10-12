| scenario | approach | tool calls | text tokens (cl100k) | text tokens (legacy Claude) | image tokens (hi-res tier) | total | agent-written call tokens | chars |
|---|---|---|---|---|---|---|---|---|
| s1-happy-edit | with-baton-cli | 1 | 94 | 100 | 0 | 94 | 20 | 255 |
| s1-happy-edit | with-baton-mcp | 1 | 56 | 62 | 434 | 490 | 16 | 139 |
| s1-happy-edit | with-baton-mcp-noshot | 1 | 21 | 21 | 0 | 21 | 21 | 56 |
| s1-happy-edit | without-playwright-mcp | 4 | 703 (702–703) | 736 (736–737) | 434 | 1137 (1136–1137) | 67 | 1933 |
| s1-happy-edit | without-script | 2 | 195 | 207 | 1708 | 1903 | 40 | 631 |
| s1-happy-edit | without-typical-shell | 4 | 382 | 414 | 1708 | 2090 | 85 | 1255 |
| s2-broken-edit | with-baton-cli | 2 | 913 (904–931) | 988 (988–1015) | 0 | 913 (904–931) | 40 | 2398 |
| s2-broken-edit | with-baton-mcp | 2 | 821 (812–839) | 895 (891–918) | 868 | 1689 (1680–1707) | 32 | 2143 |
| s2-broken-edit | with-baton-mcp-noshot | 2 | 752 (743–770) | 813 (809–836) | 0 | 752 (743–770) | 42 | 1977 |
| s2-broken-edit | without-playwright-mcp | 8 | 2581 (2551–2581) | 2774 | 868 | 3449 (3419–3449) | 134 | 6663 |
| s2-broken-edit | without-script | 4 | 1784 (1757–1784) | 1934 | 3416 | 5200 (5173–5200) | 80 | 4699 |
| s2-broken-edit | without-typical-shell | 7 | 1992 (1965–1992) | 2165 | 3416 | 5408 (5381–5408) | 148 | 5374 |
| s3-log-debugging | with-baton-diagnose | 1 | 146 | 150 | 0 | 146 | 11 | 426 |
| s3-log-debugging | with-baton-read_logs-filter | 1 | 322 | 328 | 0 | 322 | 21 | 1035 |
| s3-log-debugging | with-baton-read_logs-filter-default-tail | 1 | 322 | 328 | 0 | 322 | 16 | 1035 |
| s3-log-debugging | without-grep | 1 | 1281 | 1462 | 0 | 1281 | 33 | 3911 |
| s3-log-debugging | without-tail-200 | 1 | 5359 | 5254 | 0 | 5359 | 22 | 11322 |
| s3-log-debugging | without-whole-log | 1 | 30299 | 29721 (29714–29722) | 0 | 30299 | 18 | 64195 |

| scenario | approach | step | median text tokens | median chars | median lines | image tokens | image size |
|---|---|---|---|---|---|---|---|
| s1-happy-edit | with-baton-mcp | 01-check_change | 56 | 139 | 2 | 434 | 390x844 |
| s1-happy-edit | with-baton-mcp-noshot | 01-check_change | 21 | 56 | 1 | 0 |  |
| s1-happy-edit | with-baton-cli | 01-baton-check | 94 | 255 | 11 | 0 |  |
| s1-happy-edit | without-script | 01-check-script | 195 | 631 | 21 | 0 |  |
| s1-happy-edit | without-script | 02-read-screenshot | 0 | 0 | 0 | 1708 | 780x1688 |
| s1-happy-edit | without-playwright-mcp | 01-navigate | 120 | 318 | 11 | 0 |  |
| s1-happy-edit | without-playwright-mcp | 02-read-snapshot | 367 | 980 | 25 | 0 |  |
| s1-happy-edit | without-playwright-mcp | 03-console | 96 | 306 | 5 | 0 |  |
| s1-happy-edit | without-playwright-mcp | 04-screenshot | 120 | 329 | 11 | 434 | 390x844 |
| s1-happy-edit | without-typical-shell | 01-dev-server-output | 21 | 51 | 2 | 0 |  |
| s1-happy-edit | without-typical-shell | 02-curl-page | 166 | 573 | 20 | 0 |  |
| s1-happy-edit | without-typical-shell | 03-check-script | 195 | 631 | 21 | 0 |  |
| s1-happy-edit | without-typical-shell | 04-read-screenshot | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | with-baton-mcp | 01-check_change-broken | 765 | 2004 | 27 | 434 | 390x844 |
| s2-broken-edit | with-baton-mcp | 02-check_change-fixed | 56 | 139 | 2 | 434 | 390x844 |
| s2-broken-edit | with-baton-mcp-noshot | 01-check_change-broken | 731 | 1921 | 26 | 0 |  |
| s2-broken-edit | with-baton-mcp-noshot | 02-check_change-fixed | 21 | 56 | 1 | 0 |  |
| s2-broken-edit | with-baton-cli | 01-baton-check-broken | 819 | 2143 | 16 | 0 |  |
| s2-broken-edit | with-baton-cli | 02-baton-check-fixed | 94 | 255 | 11 | 0 |  |
| s2-broken-edit | without-script | 01-check-script-broken | 1589 | 4068 | 47 | 0 |  |
| s2-broken-edit | without-script | 02-read-screenshot-broken | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | without-script | 03-check-script-fixed | 195 | 631 | 21 | 0 |  |
| s2-broken-edit | without-script | 04-read-screenshot-fixed | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | without-playwright-mcp | 01-navigate-broken | 133 | 354 | 12 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 02-read-snapshot-broken | 0 | 0 | 0 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 03-console-broken | 1624 | 4046 | 44 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 04-screenshot-broken | 120 | 329 | 11 | 434 | 390x844 |
| s2-broken-edit | without-playwright-mcp | 05-navigate-fixed | 120 | 318 | 11 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 06-read-snapshot-fixed | 368 | 981 | 25 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 07-console-fixed | 96 | 306 | 5 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 08-screenshot-fixed | 120 | 329 | 11 | 434 | 390x844 |
| s2-broken-edit | without-typical-shell | 01-dev-server-output-broken | 21 | 51 | 2 | 0 |  |
| s2-broken-edit | without-typical-shell | 02-curl-page-broken | 166 | 573 | 20 | 0 |  |
| s2-broken-edit | without-typical-shell | 03-check-script-broken | 1589 | 4068 | 47 | 0 |  |
| s2-broken-edit | without-typical-shell | 04-read-screenshot-broken | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | without-typical-shell | 05-dev-server-output-fixed | 21 | 51 | 2 | 0 |  |
| s2-broken-edit | without-typical-shell | 06-check-script-fixed | 195 | 631 | 21 | 0 |  |
| s2-broken-edit | without-typical-shell | 07-read-screenshot-fixed | 0 | 0 | 0 | 1708 | 780x1688 |
| s3-log-debugging | with-baton-diagnose | 01-diagnose | 146 | 426 | 7 | 0 |  |
| s3-log-debugging | with-baton-read_logs-filter | 01-read_logs | 322 | 1035 | 14 | 0 |  |
| s3-log-debugging | with-baton-read_logs-filter-default-tail | 01-read_logs | 322 | 1035 | 14 | 0 |  |
| s3-log-debugging | without-tail-200 | 01-tail | 5359 | 11322 | 201 | 0 |  |
| s3-log-debugging | without-grep | 01-grep | 1281 | 3911 | 63 | 0 |  |
| s3-log-debugging | without-whole-log | 01-cat | 30299 | 64195 | 1133 | 0 |  |

| MCP server | tools | schema chars | schema tokens (cl100k) |
|---|---|---|---|
| baton-mcp | 29 | 21341 | 4737 |
| playwright-mcp | 25 | 20102 | 4274 |
