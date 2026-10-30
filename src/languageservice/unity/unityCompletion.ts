/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem, CompletionList, Position } from 'vscode-languageserver-types';
import { CompletionItemKind } from 'vscode-languageserver-types';
import type { Node, Pair } from 'yaml';
import { isMap, isScalar, isSeq } from 'yaml';
import type { JSONSchema } from '../jsonSchema.js';
import type { SingleYAMLDocument } from '../parser/yamlParser07.js';
import { yamlDocumentsCache } from '../parser/yaml-documents.js';
import { matchOffsetToDocument } from '../utils/arrUtils.js';
import { getUnitySchemaForDocument } from './unityProject.js';
import { isTextUnityYaml, isUnityUri } from './unityUtils.js';

function schemaProperties(schema: JSONSchema | undefined): Record<string, JSONSchema> | undefined {
  return schema && typeof schema === 'object' ? (schema.properties as Record<string, JSONSchema>) : undefined;
}

function isOnKeyLine(document: TextDocument, pair: Pair, position: Position): boolean {
  const key = pair.key as Node | undefined;
  return !!key && !!key.range && document.positionAt(key.range[0]).line === position.line;
}

function resolveAtCursor(
  document: TextDocument,
  yamlDoc: SingleYAMLDocument,
  schema: JSONSchema,
  position: Position
): { schema: JSONSchema; map: Node } | undefined {
  const offset = document.offsetAt(position);
  let currentSchema = schema;
  let node: Node = yamlDoc.internalDocument.contents as Node;

  for (;;) {
    if (!node) return undefined;
    if (isMap(node)) {
      let descended = false;
      for (const pair of node.items) {
        const value = pair.value as Node | undefined;
        if (!value || !value.range) continue;
        if (value.range[0] <= offset && offset <= value.range[1] && !isOnKeyLine(document, pair, position)) {
          const key = isScalar(pair.key) ? pair.key.value : undefined;
          const properties = schemaProperties(currentSchema);
          currentSchema = (key !== undefined && properties && properties[String(key)]) || {};
          node = value;
          descended = true;
          break;
        }
      }
      if (!descended) return { schema: currentSchema, map: node };
    } else if (isSeq(node)) {
      let descended = false;
      for (const item of node.items) {
        const itemNode = item as Node | undefined;
        if (!itemNode || !itemNode.range) continue;
        if (itemNode.range[0] <= offset && offset <= itemNode.range[1]) {
          currentSchema = currentSchema && typeof currentSchema === 'object' ? (currentSchema.items as JSONSchema) : {};
          node = itemNode;
          descended = true;
          break;
        }
      }
      if (!descended) return { schema: currentSchema, map: node };
    } else {
      return undefined;
    }
  }
}

export function getUnityCompletion(document: TextDocument, position: Position): CompletionList | undefined {
  if (!isUnityUri(document.uri) || !isTextUnityYaml(document.getText())) return undefined;

  let yamlDocument: ReturnType<typeof yamlDocumentsCache.getYamlDocument>;
  try {
    yamlDocument = yamlDocumentsCache.getYamlDocument(document);
  } catch {
    return undefined;
  }
  const current = matchOffsetToDocument(document.offsetAt(position), yamlDocument);
  if (!current) return undefined;

  const schema = getUnitySchemaForDocument(document.uri, current);
  if (!schema) return undefined;

  const resolved = resolveAtCursor(document, current, schema, position);
  if (!resolved || !isMap(resolved.map)) return undefined;
  const properties = schemaProperties(resolved.schema);
  if (!properties) return undefined;

  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
  const beforeCursor = line.slice(0, position.character);
  if (beforeCursor.includes(':')) return undefined;

  const prefix = beforeCursor.trim();
  const existing = new Set(
    resolved.map.items
      .map((pair) => (isScalar(pair.key) ? String(pair.key.value) : undefined))
      .filter((key): key is string => key !== undefined)
  );

  const items: CompletionItem[] = [];
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (existing.has(key)) continue;
    const description = propertySchema && typeof propertySchema === 'object' ? propertySchema.description : undefined;
    items.push({
      label: key,
      kind: CompletionItemKind.Property,
      insertText: `${key}: `,
      documentation: typeof description === 'string' ? description : undefined,
      detail: propertySchema && typeof propertySchema === 'object' && propertySchema.type ? String(propertySchema.type) : undefined,
    });
  }

  return items.length > 0 ? { isIncomplete: false, items } : undefined;
}
