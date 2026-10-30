/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocument as TextDocumentImpl } from 'vscode-languageserver-textdocument';
import type { DocumentSymbol, Hover, Position } from 'vscode-languageserver-types';
import { LocationLink, MarkupKind, Range, SymbolKind } from 'vscode-languageserver-types';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { SingleYAMLDocument } from '../parser/yamlParser07.js';
import { yamlDocumentsCache } from '../parser/yaml-documents.js';
import {
  findUnityReferenceAt,
  getUnityDocumentEnd,
  getUnityHeaderRange,
  getUnityObjectName,
  getUnityRootKey,
  isUnityDocument,
  isUnityUri,
} from './unityUtils.js';
import { getProjectRoot, getUnityClassSchemaName, resolveUnityReference } from './unityProject.js';

function documentAt(text: string, uri: string): TextDocument {
  return TextDocumentImpl.create(uri, 'yaml', 0, text);
}

export function getUnityDefinition(document: TextDocument, position: Position): LocationLink[] | undefined {
  if (!isUnityDocument(document)) return undefined;
  const reference = findUnityReferenceAt(document, position);
  if (!reference) return undefined;

  if (reference.guid) {
    const target = resolveUnityReference(document.uri, reference.guid, reference.fileID);
    if (!target) return undefined;
    const targetUri = pathToFileURL(target.assetPath).toString();
    if (target.headerOffset === undefined || target.headerEnd === undefined || target.text === undefined) {
      const empty = Range.create(0, 0, 0, 0);
      return [LocationLink.create(targetUri, empty, empty)];
    }
    const targetDocument = documentAt(target.text, targetUri);
    const range = Range.create(targetDocument.positionAt(target.headerOffset), targetDocument.positionAt(target.headerEnd));
    return [LocationLink.create(targetUri, range, range)];
  }

  if (!reference.fileID) return undefined;
  try {
    const yamlDocument = yamlDocumentsCache.getYamlDocument(document);
    const target = yamlDocument.documents.find((candidate) => candidate.unityFileID === reference.fileID);
    const range = target ? getUnityHeaderRange(document, target) : undefined;
    if (range) return [LocationLink.create(document.uri, range, range)];
  } catch {
    return undefined;
  }
  return undefined;
}

function describeDocument(document: TextDocument, yamlDocument: SingleYAMLDocument): string {
  const className = getUnityClassSchemaName(document.uri, yamlDocument) ?? getUnityRootKey(yamlDocument) ?? 'Unity object';
  const name = getUnityObjectName(yamlDocument);
  const lines = [`**${className}**${name ? ` — \`${name}\`` : ''}`];
  if (yamlDocument.unityClassId) {
    lines.push(`Class ID: \`!u!${yamlDocument.unityClassId}\`${yamlDocument.unityFileID ? ` · fileID: \`${yamlDocument.unityFileID}\`` : ''}`);
  }
  if (yamlDocument.unityStripped) lines.push('Stripped prefab reference');
  if (yamlDocument.unityClassId) {
    lines.push(`[Unity class reference](https://docs.unity3d.com/Manual/ClassIDReference.html)`);
  }
  return lines.join('\n\n');
}

export function getUnityHover(document: TextDocument, position: Position): Hover | undefined {
  if (!isUnityDocument(document)) return undefined;

  const reference = findUnityReferenceAt(document, position);
  if (reference) {
    const range = Range.create(position.line, reference.start, position.line, reference.end);
    if (reference.guid) {
      const target = resolveUnityReference(document.uri, reference.guid, reference.fileID);
      if (target) {
        const root = getProjectRoot(document.uri);
        const display = root ? path.relative(root, target.assetPath) : target.assetPath;
        return { contents: { kind: MarkupKind.Markdown, value: `\`${display}\`${reference.fileID ? ` · fileID \`${reference.fileID}\`` : ''}` }, range };
      }
    }
    if (reference.fileID) {
      try {
        const yamlDocument = yamlDocumentsCache.getYamlDocument(document);
        const target = yamlDocument.documents.find((candidate) => candidate.unityFileID === reference.fileID);
        if (target) {
          return { contents: { kind: MarkupKind.Markdown, value: describeDocument(document, target) }, range };
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  try {
    const yamlDocument = yamlDocumentsCache.getYamlDocument(document);
    const offset = document.offsetAt(position);
    const current = yamlDocument.documents.find((candidate) => {
      const start = candidate.unityHeaderOffset;
      return start !== undefined && offset >= start && offset <= (candidate.unityHeaderEnd ?? start);
    });
    if (!current) return undefined;
    const headerRange = getUnityHeaderRange(document, current);
    return headerRange ? { contents: { kind: MarkupKind.Markdown, value: describeDocument(document, current) }, range: headerRange } : undefined;
  } catch {
    return undefined;
  }
}

export function getUnityDocumentSymbols(document: TextDocument): DocumentSymbol[] | undefined {
  if (!isUnityUri(document.uri) || !isUnityDocument(document)) return undefined;
  try {
    const yamlDocument = yamlDocumentsCache.getYamlDocument(document);
    const symbols: DocumentSymbol[] = [];
    for (const yamlDoc of yamlDocument.documents) {
      const headerRange = getUnityHeaderRange(document, yamlDoc);
      if (!headerRange || yamlDoc.unityClassId === undefined) continue;
      const className = getUnityClassSchemaName(document.uri, yamlDoc) ?? getUnityRootKey(yamlDoc) ?? `!u!${yamlDoc.unityClassId}`;
      const name = getUnityObjectName(yamlDoc);
      const end = document.positionAt(Math.max(getUnityDocumentEnd(yamlDoc), document.offsetAt(headerRange.end)));
      symbols.push({
        name: name ? `${className} "${name}"` : className,
        detail: `!u!${yamlDoc.unityClassId}${yamlDoc.unityFileID ? ` &${yamlDoc.unityFileID}` : ''}`,
        kind: SymbolKind.Object,
        range: Range.create(headerRange.start, end),
        selectionRange: headerRange,
      });
    }
    return symbols;
  } catch {
    return undefined;
  }
}
