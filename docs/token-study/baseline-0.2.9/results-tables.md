| scenario | approach | tool calls | text tokens (cl100k) | text tokens (legacy Claude) | image tokens (hi-res tier) | total | agent-written call tokens | chars |
|---|---|---|---|---|---|---|---|---|
| s1-happy-edit | with-baton-cli | 1 | 93 | 100 | 0 | 93 | 20 | 257 |
| s1-happy-edit | with-baton-mcp | 1 | 55 | 62 | 1708 | 1763 | 16 | 141 |
| s1-happy-edit | with-baton-mcp-noshot | 1 | 21 | 20 (20–21) | 0 | 21 | 21 | 56 |
| s1-happy-edit | without-playwright-mcp | 4 | 704 (704–705) | 738 (737–738) | 434 | 1138 (1138–1139) | 65 | 1933 |
| s1-happy-edit | without-script | 2 | 195 | 207 | 1708 | 1903 | 40 | 631 |
| s1-happy-edit | without-typical-shell | 4 | 382 | 414 (414–415) | 1708 | 2090 | 83 | 1255 |
| s2-broken-edit | with-baton-cli | 2 | 920 (902–938) | 993 (989–1011) | 0 | 920 (902–938) | 40 | 2402 |
| s2-broken-edit | with-baton-mcp | 2 | 828 (810–846) | 900 (891–922) | 3416 | 4244 (4226–4262) | 32 | 2147 |
| s2-broken-edit | with-baton-mcp-noshot | 2 | 42 | 42 | 0 | 42 | 42 | 112 |
| s2-broken-edit | without-playwright-mcp | 8 | 2611 (2611–2641) | 2830 (2800–2834) | 868 | 3479 (3479–3509) | 130 | 6663 |
| s2-broken-edit | without-script | 4 | 1811 (1811–1838) | 1988 (1961–1992) | 3416 | 5227 (5227–5254) | 80 | 4699 |
| s2-broken-edit | without-typical-shell | 7 | 2019 (2019–2046) | 2224 (2192–2224) | 3416 | 5435 (5435–5462) | 144 | 5374 |
| s3-log-debugging | with-baton-diagnose | 1 | 1416 | 1620 (1620–1626) | 0 | 1416 | 11 | 4927 |
| s3-log-debugging | with-baton-read_logs-filter | 1 | 322 | 328 | 0 | 322 | 21 | 1035 |
| s3-log-debugging | without-grep | 1 | 1253 | 1434 | 0 | 1253 | 31 | 3869 |
| s3-log-debugging | without-tail-200 | 1 | 5355 | 5253 (5250–5261) | 0 | 5355 | 20 | 11316 |
| s3-log-debugging | without-whole-log | 1 | 30271 | 29698 (29686–29708) | 0 | 30271 | 16 | 64153 |
| s4-workflow-startup | with-baton-run_workflow | 1 | 196 | 206 | 0 | 196 | 63 | 680 |
| s4-workflow-startup | without-one-command | 1 | 30 | 30 | 0 | 30 | 148 | 60 |
| s4-workflow-startup | without-step-by-step | 4 | 54 | 54 | 0 | 54 | 153 | 140 |

| scenario | approach | step | median text tokens | median chars | median lines | image tokens | image size |
|---|---|---|---|---|---|---|---|
| s1-happy-edit | with-baton-mcp | 01-check_change | 55 | 141 | 2 | 1708 | 780x1688 |
| s1-happy-edit | with-baton-mcp-noshot | 01-check_change | 21 | 56 | 1 | 0 |  |
| s1-happy-edit | with-baton-cli | 01-baton-check | 93 | 257 | 11 | 0 |  |
| s1-happy-edit | without-script | 01-check-script | 195 | 631 | 21 | 0 |  |
| s1-happy-edit | without-script | 02-read-screenshot | 0 | 0 | 0 | 1708 | 780x1688 |
| s1-happy-edit | without-playwright-mcp | 01-navigate | 120 | 318 | 11 | 0 |  |
| s1-happy-edit | without-playwright-mcp | 02-read-snapshot | 367 | 980 | 25 | 0 |  |
| s1-happy-edit | without-playwright-mcp | 03-console | 97 | 306 | 5 | 0 |  |
| s1-happy-edit | without-playwright-mcp | 04-screenshot | 120 | 329 | 11 | 434 | 390x844 |
| s1-happy-edit | without-typical-shell | 01-dev-server-output | 21 | 51 | 2 | 0 |  |
| s1-happy-edit | without-typical-shell | 02-curl-page | 166 | 573 | 20 | 0 |  |
| s1-happy-edit | without-typical-shell | 03-check-script | 195 | 631 | 21 | 0 |  |
| s1-happy-edit | without-typical-shell | 04-read-screenshot | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | with-baton-mcp | 01-check_change-broken | 773 | 2006 | 27 | 1708 | 780x1688 |
| s2-broken-edit | with-baton-mcp | 02-check_change-fixed | 55 | 141 | 2 | 1708 | 780x1688 |
| s2-broken-edit | with-baton-mcp-noshot | 01-check_change-broken | 21 | 56 | 1 | 0 |  |
| s2-broken-edit | with-baton-mcp-noshot | 02-check_change-fixed | 21 | 56 | 1 | 0 |  |
| s2-broken-edit | with-baton-cli | 01-baton-check-broken | 827 | 2145 | 16 | 0 |  |
| s2-broken-edit | with-baton-cli | 02-baton-check-fixed | 93 | 257 | 11 | 0 |  |
| s2-broken-edit | without-script | 01-check-script-broken | 1616 | 4068 | 47 | 0 |  |
| s2-broken-edit | without-script | 02-read-screenshot-broken | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | without-script | 03-check-script-fixed | 195 | 631 | 21 | 0 |  |
| s2-broken-edit | without-script | 04-read-screenshot-fixed | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | without-playwright-mcp | 01-navigate-broken | 133 | 354 | 12 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 02-read-snapshot-broken | 0 | 0 | 0 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 03-console-broken | 1653 | 4046 | 44 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 04-screenshot-broken | 120 | 329 | 11 | 434 | 390x844 |
| s2-broken-edit | without-playwright-mcp | 05-navigate-fixed | 120 | 318 | 11 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 06-read-snapshot-fixed | 368 | 981 | 25 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 07-console-fixed | 97 | 306 | 5 | 0 |  |
| s2-broken-edit | without-playwright-mcp | 08-screenshot-fixed | 120 | 329 | 11 | 434 | 390x844 |
| s2-broken-edit | without-typical-shell | 01-dev-server-output-broken | 21 | 51 | 2 | 0 |  |
| s2-broken-edit | without-typical-shell | 02-curl-page-broken | 166 | 573 | 20 | 0 |  |
| s2-broken-edit | without-typical-shell | 03-check-script-broken | 1616 | 4068 | 47 | 0 |  |
| s2-broken-edit | without-typical-shell | 04-read-screenshot-broken | 0 | 0 | 0 | 1708 | 780x1688 |
| s2-broken-edit | without-typical-shell | 05-dev-server-output-fixed | 21 | 51 | 2 | 0 |  |
| s2-broken-edit | without-typical-shell | 06-check-script-fixed | 195 | 631 | 21 | 0 |  |
| s2-broken-edit | without-typical-shell | 07-read-screenshot-fixed | 0 | 0 | 0 | 1708 | 780x1688 |
| s3-log-debugging | with-baton-diagnose | 01-diagnose | 1416 | 4927 | 153 | 0 |  |
| s3-log-debugging | with-baton-read_logs-filter | 01-read_logs | 322 | 1035 | 14 | 0 |  |
| s3-log-debugging | without-tail-200 | 01-tail | 5355 | 11316 | 201 | 0 |  |
| s3-log-debugging | without-grep | 01-grep | 1253 | 3869 | 63 | 0 |  |
| s3-log-debugging | without-whole-log | 01-cat | 30271 | 64153 | 1133 | 0 |  |
| s4-workflow-startup | with-baton-run_workflow | 01-run_workflow | 196 | 680 | 23 | 0 |  |
| s4-workflow-startup | without-one-command | 01-start-and-wait | 30 | 60 | 3 | 0 |  |
| s4-workflow-startup | without-step-by-step | 01-start-api | 15 | 30 | 2 | 0 |  |
| s4-workflow-startup | without-step-by-step | 02-poll-api | 22 | 76 | 1 | 0 |  |
| s4-workflow-startup | without-step-by-step | 03-start-console | 15 | 30 | 2 | 0 |  |
| s4-workflow-startup | without-step-by-step | 04-poll-console | 2 | 4 | 2 | 0 |  |

| MCP server | tools | schema chars | schema tokens (cl100k) |
|---|---|---|---|
| baton-mcp | 29 | 20518 | 4536 |
| playwright-mcp | 25 | 20102 | 4274 |
