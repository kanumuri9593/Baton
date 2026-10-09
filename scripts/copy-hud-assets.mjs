#!/usr/bin/env node
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'hud', 'assets');
const destination = join(root, 'dist', 'hud', 'assets');

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });

// tsc only emits .ts files; the Node tracing preload is plain .mjs and must ship too,
// or any launch config with "batonTrace": true fails with ERR_MODULE_NOT_FOUND.
const instrumentation = join(root, 'dist', 'instrumentation');
mkdirSync(instrumentation, { recursive: true });
cpSync(join(root, 'src', 'instrumentation', 'node.mjs'), join(instrumentation, 'node.mjs'));
