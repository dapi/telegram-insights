#!/usr/bin/env node
import { buildProgram } from '../src/cli.js';

buildProgram().parseAsync(process.argv).catch((error) => {
  process.stderr.write(`telegram-insights: ${error.message}\n`);
  process.exit(1);
});
