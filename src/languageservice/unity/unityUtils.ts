/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode-languageserver-textdocument';
import { Range } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';
import type { CST } from 'yaml';
import { isMap, isScalar } from 'yaml';
import type { SingleYAMLDocument, YAMLDocument } from '../parser/yamlParser07.js';
import type { YAMLMap } from 'yaml';

const UNITY_EXTENSIONS = new Set([
  '.unity',
  '.prefab',
  '.asset',
  '.mat',
  '.anim',
  '.controller',
  '.overridecontroller',
  '.physicmaterial',
  '.physicsmaterial2d',
  '.preset',
  '.mask',
  '.lighting',
  '.meta',
]);

export interface UnityReference {
  fileID?: string;
  guid?: string;
  start: number;
  end: number;
}

export function isUnityUri(uri: string): boolean {
  try {
    const extension = URI.parse(uri).path.toLowerCase().match(/\.[^./]+$/)?.[0];
    return extension !== undefined && UNITY_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

export function isTextUnityYaml(text: string): boolean {
  if (text.includes('\u0000')) return false;
  return text.includes('%YAML') || text.includes('--- !u!') || /^fileFormatVersion:/m.test(text);
}

export function isUnityDocument(document: TextDocument): boolean {
  return isUnityUri(document.uri) && isTextUnityYaml(document.getText());
}

/**
 * Unity's `stripped` keyword is not valid YAML. It is replaced in-place so
 * every offset stays identical.
 */
export function preprocessUnityText(text: string): string {
  return text.replace(
    /^(--- !u!\d+ &-?\d+) stripped(?=\r?$)/gm,
    (line, head: string) => head + ' '.repeat(line.length - head.length)
  );
}

/**
 * The YAML parser leaves Unity document tags unresolved, so class IDs are read
 * from the document start tokens instead of the AST.
 */
export function attachUnityMetadata(yamlDocument: YAMLDocument, originalText: string): void {
  let index = 0;
  for (const token of yamlDocument.tokens) {
    if (token.type !== 'document') continue;
    const document = yamlDocument.documents[index++];
    if (!document) break;
    const lineEnd = originalText.indexOf('\n', token.offset);
    const line = originalText.slice(token.offset, lineEnd < 0 ? undefined : lineEnd);
    const match = /^--- !u!(\d+) &(-?\d+)(?: stripped)?/.exec(line);
    document.unityHeaderOffset = token.offset;
    document.unityHeaderEnd = token.offset + line.length;
    if (match) {
      document.unityClassId = match[1];
      document.unityFileID = match[2];
      document.unityStripped = line.includes(' stripped');
    }
  }
}

export function getUnityRootKey(document: SingleYAMLDocument): string | undefined {
  const contents = document.internalDocument?.contents;
  if (!isMap(contents)) return undefined;
  const first = contents.items[0];
  return first && isScalar(first.key) && typeof first.key.value === 'string' ? first.key.value : undefined;
}

function getUnityFields(document: SingleYAMLDocument): YAMLMap | undefined {
  const contents = document.internalDocument?.contents;
  if (!isMap(contents)) return undefined;
  const first = contents.items[0];
  return first && isMap(first.value) ? first.value : undefined;
}

export function getUnityObjectName(document: SingleYAMLDocument): string | undefined {
  const fields = getUnityFields(document);
  if (!fields) return undefined;
  const name = fields.items.find((pair) => isScalar(pair.key) && pair.key.value === 'm_Name');
  if (!name || !isScalar(name.value)) return undefined;
  const value = name.value.source ?? name.value.value;
  return value === null || value === undefined ? undefined : String(value);
}

export function getUnityScriptGuid(document: SingleYAMLDocument): string | undefined {
  const fields = getUnityFields(document);
  if (!fields) return undefined;
  const script = fields.items.find((pair) => isScalar(pair.key) && pair.key.value === 'm_Script');
  if (!script || !isMap(script.value)) return undefined;
  const guid = script.value.items.find((pair) => isScalar(pair.key) && pair.key.value === 'guid');
  if (!guid || !isScalar(guid.value)) return undefined;
  const value = guid.value.source ?? guid.value.value;
  return typeof value === 'string' ? value.replace(/^['"]|['"]$/g, '') : undefined;
}

export function findUnityReferenceAt(document: TextDocument, position: { line: number; character: number }): UnityReference | undefined {
  const line = document.getText(Range.create(position.line, 0, position.line + 1, 0));
  const reference = /\{fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-fA-F]{32}))?[^}]*\}/g;
  let match: RegExpExecArray;
  while ((match = reference.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return { fileID: match[1], guid: match[2], start, end };
    }
  }
  return undefined;
}

export function getUnityHeaderRange(document: TextDocument, yamlDocument: SingleYAMLDocument): Range | undefined {
  if (yamlDocument.unityHeaderOffset === undefined || yamlDocument.unityHeaderEnd === undefined) return undefined;
  return Range.create(
    document.positionAt(yamlDocument.unityHeaderOffset),
    document.positionAt(yamlDocument.unityHeaderEnd)
  );
}

export function getUnityDocumentEnd(document: SingleYAMLDocument): number {
  return document.internalDocument?.range?.[2] ?? 0;
}

export function getDocumentStartTokenOffset(token: CST.Token): number {
  return token.offset;
}
