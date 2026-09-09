#!/usr/bin/env node
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'hud', 'assets');
const destination = join(root, 'dist', 'hud', 'assets');

mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
