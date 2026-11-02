#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'Library/UnityYaml/schema.json';
if (!existsSync(file)) {
  console.error(`schema not found: ${file}`);
  process.exit(2);
}

const schema = JSON.parse(readFileSync(file, 'utf8'));
const problems = [];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

if (schema.version !== 1) problems.push(`version is ${String(schema.version)}, expected 1`);
if (typeof schema.unityVersion !== 'string' || schema.unityVersion.length === 0) problems.push('unityVersion is missing');
if (!isObject(schema.classes)) problems.push('classes is not an object');
if (!isObject(schema.scripts)) problems.push('scripts is not an object');

for (const [classId, entry] of Object.entries(schema.classes ?? {})) {
  if (!/^\d+$/.test(classId)) problems.push(`class id ${classId} is not numeric`);
  if (!isObject(entry) || typeof entry.name !== 'string' || !isObject(entry.schema)) {
    problems.push(`class ${classId} has no name/schema`);
    continue;
  }
  const roots = Object.keys(entry.schema.properties ?? {});
  if (roots.length !== 1 || roots[0] !== entry.name) {
    problems.push(`class ${classId} root ${roots.join(',')} does not match name ${entry.name}`);
  }
}
if ('114' in (schema.classes ?? {})) problems.push('class 114 must not be in classes (MonoBehaviour is per-script)');

for (const [guid, entry] of Object.entries(schema.scripts ?? {})) {
  if (!/^[0-9a-f]{32}$/i.test(guid)) problems.push(`script key ${guid} is not a GUID`);
  if (!isObject(entry) || typeof entry.name !== 'string' || !isObject(entry.schema)) {
    problems.push(`script ${guid} has no name/schema`);
    continue;
  }
  if (!isObject(entry.schema.properties?.MonoBehaviour)) problems.push(`script ${entry.name} has no MonoBehaviour schema`);
}

const classCount = Object.keys(schema.classes ?? {}).length;
const scriptCount = Object.keys(schema.scripts ?? {}).length;
console.log(`${classCount} classes, ${scriptCount} scripts, ${problems.length} problem(s)`);
for (const problem of problems.slice(0, 40)) console.log(`- ${problem}`);
if (problems.length > 40) console.log(`- ... and ${problems.length - 40} more`);
process.exit(problems.length > 0 ? 1 : 0);
