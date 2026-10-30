/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import type { YAMLMap } from 'yaml';
import { isMap, isScalar, visit } from 'yaml';
import type { SingleYAMLDocument, YAMLDocument } from '../../parser/yaml-documents.js';
import { yamlDocumentsCache } from '../../parser/yaml-documents.js';
import type { AdditionalValidator } from './types.js';
import { getUnityHeaderRange, isUnityUri } from '../../unity/unityUtils.js';
import { hasUnityGuid } from '../../unity/unityProject.js';

interface UnityReference {
  fileID?: string;
  guid?: string;
  start: number;
  end: number;
}

const anchorCache = new WeakMap<YAMLDocument, Map<string, SingleYAMLDocument[]>>();

function anchorsOf(yamlDocument: YAMLDocument): Map<string, SingleYAMLDocument[]> {
  const cached = anchorCache.get(yamlDocument);
  if (cached) return cached;
  const anchors = new Map<string, SingleYAMLDocument[]>();
  for (const document of yamlDocument.documents) {
    if (!document.unityFileID) continue;
    const list = anchors.get(document.unityFileID);
    if (list) list.push(document);
    else anchors.set(document.unityFileID, [document]);
  }
  anchorCache.set(yamlDocument, anchors);
  return anchors;
}

function sourceOf(document: TextDocument, node: { range?: [number, number, number] }): string | undefined {
  if (!node.range) return undefined;
  return document.getText(Range.create(document.positionAt(node.range[0]), document.positionAt(node.range[1]))).trim();
}

function referencesOf(document: TextDocument, yamlDoc: SingleYAMLDocument): UnityReference[] {
  const references: UnityReference[] = [];
  if (!yamlDoc.internalDocument) return references;
  visit(yamlDoc.internalDocument, (_key, node) => {
    if (!isMap(node)) return;
    let fileID: string | undefined;
    let guid: string | undefined;
    for (const pair of (node as YAMLMap).items) {
      if (!isScalar(pair.key) || !isScalar(pair.value)) continue;
      if (pair.key.value === 'fileID') fileID = sourceOf(document, pair.value);
      if (pair.key.value === 'guid') guid = sourceOf(document, pair.value);
    }
    if (fileID === undefined && guid === undefined) return;
    if (!node.range) return;
    references.push({ fileID, guid, start: node.range[0], end: node.range[1] });
  });
  return references;
}

export class UnityReferenceValidator implements AdditionalValidator {
  validate(document: TextDocument, yamlDoc: SingleYAMLDocument): Diagnostic[] {
    if (!isUnityUri(document.uri) || !yamlDoc.unityClassId) return [];
    const diagnostics: Diagnostic[] = [];

    let yamlDocument: YAMLDocument;
    try {
      yamlDocument = yamlDocumentsCache.getYamlDocument(document);
    } catch {
      return diagnostics;
    }

    const anchors = anchorsOf(yamlDocument);
    if (yamlDoc.unityFileID) {
      const duplicates = anchors.get(yamlDoc.unityFileID) ?? [];
      if (duplicates.length > 1 && duplicates[0] !== yamlDoc) {
        const range = getUnityHeaderRange(document, yamlDoc);
        if (range) {
          diagnostics.push(
            Diagnostic.create(range, `Duplicate fileID ${yamlDoc.unityFileID}`, DiagnosticSeverity.Error, 'unity-duplicate-fileid')
          );
        }
      }
    }

    for (const reference of referencesOf(document, yamlDoc)) {
      const range = Range.create(document.positionAt(reference.start), document.positionAt(reference.end));
      if (reference.guid) {
        if (hasUnityGuid(document.uri, reference.guid) === false) {
          diagnostics.push(
            Diagnostic.create(
              range,
              `guid ${reference.guid} not found in the project`,
              DiagnosticSeverity.Warning,
              'unity-missing-guid'
            )
          );
        }
        continue;
      }
      if (reference.fileID && reference.fileID !== '0' && !anchors.has(reference.fileID)) {
        diagnostics.push(
          Diagnostic.create(
            range,
            `fileID ${reference.fileID} not found in this file`,
            DiagnosticSeverity.Warning,
            'unity-missing-fileid'
          )
        );
      }
    }

    return diagnostics;
  }
}
