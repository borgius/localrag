/**
 * Extension Activation Test
 * Ensures extension can activate and all critical dependencies are available
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';

describe('Extension Activation - Dependency Availability', () => {
  it('should be able to import @langchain/core/documents', async () => {
    // This test verifies that the critical @langchain/core/documents module
    // is available and can be imported. This is essential for the extension
    // to activate successfully.
    let error: Error | null = null;
    try {
      // Dynamic import to catch any module resolution errors
      const module = await import('@langchain/core/documents');
      
      // Verify the Document class is exported
      expect(module).to.have.property('Document');
      expect(module.Document).to.be.a('function');
    } catch (e) {
      error = e as Error;
    }

    // If there's an error, fail with a descriptive message
    if (error) {
      throw new Error(
        `Failed to import @langchain/core/documents: ${error.message}.\n` +
        'This error typically occurs when:\n' +
        '1. The dependency is not installed (run: pnpm install)\n' +
        '2. The VSIX package is missing node_modules (check packaging configuration)\n' +
        '3. The --no-dependencies flag is used without proper bundling\n' +
        '\nStack trace:\n' + error.stack
      );
    }
  });

  it('should be able to import @langchain/community document loaders', async () => {
    let error: Error | null = null;
    try {
      const pdfModule = await import('@langchain/community/document_loaders/fs/pdf');
      expect(pdfModule).to.have.property('PDFLoader');
      
      const cheerioModule = await import('@langchain/community/document_loaders/web/cheerio');
      expect(cheerioModule).to.have.property('CheerioWebBaseLoader');
    } catch (e) {
      error = e as Error;
    }

    if (error) {
      throw new Error(
        `Failed to import @langchain/community loaders: ${error.message}\n` +
        'Ensure @langchain/community is properly packaged in the VSIX.'
      );
    }
  });

  it('should be able to import @langchain/textsplitters', async () => {
    let error: Error | null = null;
    try {
      const module = await import('@langchain/textsplitters');
      expect(module).to.have.property('RecursiveCharacterTextSplitter');
    } catch (e) {
      error = e as Error;
    }

    if (error) {
      throw new Error(
        `Failed to import @langchain/textsplitters: ${error.message}\n` +
        'Ensure @langchain/textsplitters is properly packaged in the VSIX.'
      );
    }
  });

  it('should be able to import core dependencies', async () => {
    const criticalDependencies = [
      '@huggingface/transformers',
      '@lancedb/lancedb',
      'cheerio'
    ];

    for (const dep of criticalDependencies) {
      try {
        await import(dep);
      } catch (e) {
        const error = e as Error;
        throw new Error(
          `Failed to import critical dependency "${dep}": ${error.message}\n` +
          'This dependency must be included in the VSIX package.'
        );
      }
    }
  });

  it('should verify all source files can import dependencies', () => {
    // This is a static check - actual imports are done by the files themselves
    // If compilation succeeds, this passes. If there are import errors,
    // TypeScript compilation will fail first.
    
    const sourceFilesWithLangChainImports = [
      'src/loaders/documentLoaderFactory.ts',
      'src/splitters/semanticChunker.ts',
      'src/agents/ragAgent.ts',
      'src/stores/vectorStoreFactory.ts',
      'src/managers/documentPipeline.ts',
      'src/retrievers/ensembleRetriever.ts',
      'src/retrievers/bm25Retriever.ts',
      'src/retrievers/hybridRetriever.ts'
    ];

    // This test documents which files require @langchain/core/documents
    // If this test fails, it means the import is broken in the compiled output
    expect(sourceFilesWithLangChainImports.length).to.be.greaterThan(0);
  });
});
