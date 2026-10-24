#!/usr/bin/env node
import { resolve } from 'node:path';
import { syncPackageIndex } from './package-tools.mjs';
const [command, directory] = process.argv.slice(2);
if (!['check', 'sync'].includes(command) || !directory) throw new Error('Usage: hocpkg <check|sync> <package-index-directory>');
if (await syncPackageIndex(resolve(directory), { check: command === 'check' }) && command === 'check') process.exitCode = 1;
