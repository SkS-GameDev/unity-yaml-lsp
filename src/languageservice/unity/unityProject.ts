/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { JSONSchema } from '../jsonSchema.js';
import type { SingleYAMLDocument } from '../parser/yamlParser07.js';
import { yamlDocumentsCache } from '../parser/yaml-documents.js';
import { getUnityScriptGuid, isTextUnityYaml, isUnityUri } from './unityUtils.js';

export interface UnityClassSchema {
  name?: string;
  schema: JSONSchema;
}

export interface UnityProjectSchema {
  version?: number;
  unityVersion?: string;
  classes?: Record<string, UnityClassSchema>;
  scripts?: Record<string, UnityClassSchema>;
}

interface CachedSchema {
  mtimeMs: number;
  schema: UnityProjectSchema;
}

interface MetaIndex {
  builtAt: number;
  guids: Map<string, string>;
}

const schemaCache = new Map<string, CachedSchema>();
const metaIndexes = new Map<string, MetaIndex>();
const SCHEMA_PATHS = [
  path.join('Library', 'UnityYaml', 'schema.json'),
  path.join('.opencode', 'unity-yaml', 'schema.json'),
  path.join('Assets', 'unity-yaml-schema.json'),
];

export function getProjectRoot(uri: string): string | undefined {
  try {
    let directory = path.dirname(URI.parse(uri).fsPath);
    for (;;) {
      if (existsSync(path.join(directory, 'Assets'))) return directory;
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  } catch {
    return undefined;
  }
}

export function getUnityProjectSchema(uri: string): UnityProjectSchema | undefined {
  const root = getProjectRoot(uri);
  if (!root) return undefined;
  for (const relativePath of SCHEMA_PATHS) {
    const schemaPath = path.join(root, relativePath);
    if (!existsSync(schemaPath)) continue;
    try {
      const mtimeMs = statSync(schemaPath).mtimeMs;
      const cached = schemaCache.get(schemaPath);
      if (cached && cached.mtimeMs === mtimeMs) return cached.schema;
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as UnityProjectSchema;
      schemaCache.set(schemaPath, { mtimeMs, schema });
      return schema;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function getUnitySchemaForDocument(uri: string, document: SingleYAMLDocument): JSONSchema | null | undefined {
  if (!isUnityUri(uri)) return undefined;
  if (!document.unityClassId || document.unityStripped) return null;

  const projectSchema = getUnityProjectSchema(uri);
  if (!projectSchema) return null;

  if (document.unityClassId === '114') {
    const scriptGuid = getUnityScriptGuid(document);
    const script = scriptGuid ? projectSchema.scripts?.[scriptGuid] : undefined;
    if (script) return script.schema;
  }
  return projectSchema.classes?.[document.unityClassId]?.schema ?? null;
}

export function getUnityClassSchemaName(uri: string, document: SingleYAMLDocument): string | undefined {
  const projectSchema = getUnityProjectSchema(uri);
  if (!projectSchema) return undefined;
  if (document.unityClassId === '114') {
    const scriptGuid = getUnityScriptGuid(document);
    const script = scriptGuid ? projectSchema.scripts?.[scriptGuid] : undefined;
    if (script?.name) return script.name;
  }
  return document.unityClassId ? projectSchema.classes?.[document.unityClassId]?.name : undefined;
}

function buildMetaIndex(root: string): MetaIndex {
  const guids = new Map<string, string>();
  for (const folder of ['Assets', 'Packages', path.join('Library', 'PackageCache')]) {
    const base = path.join(root, folder);
    if (!existsSync(base)) continue;
    let entries;
    try {
      entries = readdirSync(base, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.meta')) continue;
      const metaPath = path.join(entry.parentPath ?? entry.path, entry.name);
      try {
        const guid = /^guid: ([0-9a-f]{32})$/m.exec(readFileSync(metaPath, 'utf8').slice(0, 200))?.[1];
        if (guid) guids.set(guid, metaPath.slice(0, -5));
      } catch {
        // A single unreadable .meta must not break navigation.
      }
    }
  }
  return { builtAt: Date.now(), guids };
}

function getMetaIndex(root: string, force = false): MetaIndex {
  const cached = metaIndexes.get(root);
  if (cached && !force) return cached;
  // shortcut: index is cached for the server session; rebuild on a miss at most every 5s.
  if (cached && Date.now() - cached.builtAt < 5000) return cached;
  const index = buildMetaIndex(root);
  metaIndexes.set(root, index);
  return index;
}

export function resolveUnityGuid(uri: string, guid: string): string | undefined {
  const root = getProjectRoot(uri);
  if (!root) return undefined;
  let assetPath = getMetaIndex(root).guids.get(guid);
  if (!assetPath) assetPath = getMetaIndex(root, true).guids.get(guid);
  return assetPath;
}

export function hasUnityGuid(uri: string, guid: string): boolean | undefined {
  if (/^0{16}/.test(guid)) return true;
  const root = getProjectRoot(uri);
  if (!root) return undefined;
  const index = getMetaIndex(root);
  return index.guids.has(guid);
}

export interface UnityAssetLocation {
  assetPath: string;
  headerOffset?: number;
  headerEnd?: number;
  text?: string;
}

export function resolveUnityReference(uri: string, guid: string, fileID?: string): UnityAssetLocation | undefined {
  const assetPath = resolveUnityGuid(uri, guid);
  if (!assetPath) return undefined;

  try {
    const text = readFileSync(assetPath, 'utf8');
    if (!isTextUnityYaml(text) || !fileID || fileID === '0') return { assetPath };
    const assetUri = pathToFileURL(assetPath).toString();
    const document = TextDocument.create(assetUri, 'yaml', 0, text);
    const yamlDocument = yamlDocumentsCache.getYamlDocument(document);
    const target = yamlDocument.documents.find((candidate) => candidate.unityFileID === fileID);
    if (target?.unityHeaderOffset !== undefined && target.unityHeaderEnd !== undefined) {
      return { assetPath, headerOffset: target.unityHeaderOffset, headerEnd: target.unityHeaderEnd, text };
    }
    return { assetPath, text };
  } catch {
    // Binary or unreadable assets still resolve to the file itself.
  }
  return { assetPath };
}
