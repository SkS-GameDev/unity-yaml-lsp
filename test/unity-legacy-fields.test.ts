import { describe, it } from 'node:test';

import { expect } from 'chai';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { filterUnitySchemaDiagnostics } from '../src/languageservice/unity/unityDiagnostics.js';

function diagnostic(message: string): Diagnostic {
  return Diagnostic.create(Range.create(0, 0, 0, 1), message, DiagnosticSeverity.Warning);
}

describe('Unity legacy serialized fields', () => {
  it('drops unknown-property diagnostics for m_TypeName and m_HashCode', () => {
    const result = filterUnitySchemaDiagnostics([
      diagnostic('Property m_TypeName is not allowed.'),
      diagnostic('Property m_HashCode is not allowed.'),
      diagnostic('Property m_Typo is not allowed.'),
    ]);
    expect(result.map((item) => item.message)).to.deep.equal(['Property m_Typo is not allowed.']);
  });
});
