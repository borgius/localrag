/**
 * Topic Manager - Manages topic lifecycle and vector stores
 * Handles creation, deletion, updates, and document ingestion
 *
 * Architecture: Singleton pattern with integrated pipeline
 * Replaces manual topic management from vectorDatabase.ts
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import archiver from "archiver";
import AdmZip from "adm-zip";
import { VectorStore } from "@langchain/core/vectorstores";
import { Topic, TopicsIndex, Document as TopicDocument, FolderChunkNode, FolderChunkStats, FolderChunkNodeSerialized, ExportedTopicData, TopicSource } from "../utils/types";
import {
  DocumentPipeline,
  PipelineOptions,
  PipelineResult,
} from "./documentPipeline";
import { VectorStoreFactory } from "../stores/vectorStoreFactory";
import { EmbeddingService } from "../embeddings/embeddingService";
import { TransformersEmbeddings } from "../embeddings/langchainEmbeddings";
import { Logger } from "../utils/logger";
import { CONFIG, EXTENSION } from "../utils/constants";

/** Current export format version */
const EXPORT_FORMAT_VERSION = "1.0";

export interface CreateTopicOptions {
  name: string;
  description?: string;
  initialDocuments?: string[];
}

export interface TopicStats {
  documentCount: number;
  chunkCount: number;
  lastUpdated: number;
  embeddingModel: string;
}

export interface AddDocumentResult {
  topic: Topic;
  document: TopicDocument;
  pipelineResult: PipelineResult;
}

/**
 * Manages all topic operations and vector stores
 */
export class TopicManager {
  private static instance: TopicManager;
  private static initPromise: Promise<void> | null = null;

  // Callback registry for external components to register cleanup functions
  // This allows TopicManager to notify other components (like RAGTool) without creating circular dependencies
  private static agentCacheCleanupCallback: ((topicId: string) => void) | null = null;

  private context: vscode.ExtensionContext;
  private logger: Logger;
  private topicsIndex: TopicsIndex | null = null;
  private documentPipeline: DocumentPipeline;
  private vectorStoreFactory: VectorStoreFactory | null = null;
  private embeddingService: EmbeddingService;
  private isInitialized: boolean = false;

  // Cache for loaded vector stores
  private vectorStoreCache: Map<string, VectorStore> = new Map();

  // Cache for topic documents
  private topicDocuments: Map<string, Map<string, TopicDocument>> = new Map();

  // Cache for folder chunk statistics per topic
  private folderChunkStats: Map<string, FolderChunkStats> = new Map();

  // Common database support
  private commonTopicsIndex: TopicsIndex | null = null;
  private commonTopicDocuments: Map<string, Map<string, TopicDocument>> = new Map();
  private commonDatabasePath: string | null = null;

  private constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.logger = new Logger("TopicManager");
    this.documentPipeline = new DocumentPipeline();
    this.embeddingService = EmbeddingService.getInstance();

    this.logger.info("TopicManager created");
  }

  public static async getInstance(
    context?: vscode.ExtensionContext
  ): Promise<TopicManager> {
    if (!TopicManager.instance) {
      if (!context) {
        throw new Error(
          "TopicManager not initialized. Context required for first call."
        );
      }
      TopicManager.instance = new TopicManager(context);
      // Automatically initialize on first getInstance call
      TopicManager.initPromise = TopicManager.instance.init();
    }

    // Wait for initialization to complete
    if (TopicManager.initPromise) {
      try {
        await TopicManager.initPromise;
      } catch (error) {
        // Clear instance on failure to allow retry
        TopicManager.instance = null as any;
        TopicManager.initPromise = null;
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`TopicManager initialization failed: ${errorMessage}`);
      } finally {
        TopicManager.initPromise = null;
      }
    }

    // Verify initialization succeeded
    if (!TopicManager.instance.isInitialized) {
      TopicManager.instance = null as any;
      throw new Error("TopicManager initialization failed - instance is not initialized");
    }

    return TopicManager.instance;
  }

  /**
   * Initialize the manager and load topics index
   */
  private async init(): Promise<void> {
    if (this.isInitialized) {
      this.logger.info("TopicManager already initialized, skipping");
      return;
    }

    this.logger.info("Initializing TopicManager");

    try {
      // Ensure storage directory exists
      await this.ensureStorageDirectory();

      // Ensure embedding service is initialized so we know the active model
      await this.embeddingService.initialize();

      // Load topics index (creates a new one if missing)
      await this.loadTopicsIndex();

      // Initialize document pipeline
      const storageDir = this.getDatabaseDir();
      await this.documentPipeline.initialize(storageDir);

      // Create LangChain-compatible embeddings wrapper
      const embeddings = new TransformersEmbeddings();

      this.vectorStoreFactory = new VectorStoreFactory(
        embeddings,
        storageDir,
        this.topicsIndex!.modelName
      );

      // Load common database if configured
      await this.loadCommonDatabase();

      this.isInitialized = true;
      this.logger.info("TopicManager initialized successfully", {
        topicCount: Object.keys(this.topicsIndex?.topics || {}).length,
        commonTopicCount: Object.keys(this.commonTopicsIndex?.topics || {}).length,
        embeddingModel: this.topicsIndex?.modelName,
      });
    } catch (error) {
      this.logger.error("Failed to initialize TopicManager", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Ensure the manager is initialized
   */
  public async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.init();
    }
  }

  /**
   * Ensure a default topic exists, create if necessary
   * This is called during initialization to support folder watching
   */
  public async ensureDefaultTopic(): Promise<Topic> {
    await this.ensureInitialized();
    
    if (!this.topicsIndex) {
      throw new Error("TopicManager not initialized");
    }

    // Look for existing default topic
    let defaultTopic = Object.values(this.topicsIndex.topics).find(
      t => t.name === EXTENSION.DEFAULT_TOPIC_NAME
    );

    if (!defaultTopic) {
      // Create default topic
      this.logger.info("Creating default topic for folder watching");
      defaultTopic = await this.createTopic({
        name: EXTENSION.DEFAULT_TOPIC_NAME,
        description: "Automatically managed topic for watched folder",
      });
    }

    return defaultTopic;
  }

  /**
   * Create a new topic
   */
  public async createTopic(options: CreateTopicOptions): Promise<Topic> {
    this.logger.info("Creating topic", { name: options.name });

    try {
      // Ensure initialized
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // Check for duplicate names
      const existingTopic = Object.values(this.topicsIndex.topics).find(
        (t) => t.name.toLowerCase() === options.name.toLowerCase()
      );

      if (existingTopic) {
        throw new Error(`Topic with name "${options.name}" already exists`);
      }

      // Create topic object
      const topic: Topic = {
        id: this.generateTopicId(),
        name: options.name,
        description: options.description,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        documentCount: 0,
      };

      // Add to index
      this.topicsIndex.topics[topic.id] = topic;
      this.topicsIndex.lastUpdated = Date.now();

      // Save index
      await this.saveTopicsIndex();

      // Initialize document map for this topic
      this.topicDocuments.set(topic.id, new Map());

      // Add initial documents if provided
      if (options.initialDocuments && options.initialDocuments.length > 0) {
        this.logger.info("Adding initial documents to topic", {
          topicId: topic.id,
          documentCount: options.initialDocuments.length,
        });

        await this.addDocuments(topic.id, options.initialDocuments);
      }

      this.logger.info("Topic created successfully", {
        topicId: topic.id,
        name: topic.name,
      });

      return topic;
    } catch (error) {
      this.logger.error("Failed to create topic", {
        error: error instanceof Error ? error.message : String(error),
        name: options.name,
      });
      throw error;
    }
  }

  /**
   * Delete only the vector store for a topic (keeps topic metadata)
   * Used when reindexing with a different model
   */
  public async deleteTopicVectorStore(topicId: string): Promise<void> {
    this.logger.info("Deleting topic vector store", { topicId });

    try {
      if (!this.topicsIndex || !this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      // Check if topic exists
      if (!this.topicsIndex.topics[topicId]) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      // Delete vector store
      await this.vectorStoreFactory.deleteStore(topicId);

      // Remove from cache
      this.vectorStoreCache.delete(topicId);

      // Clear folder chunk statistics since we'll rebuild them
      this.folderChunkStats.delete(topicId);

      // Notify external components to clear their caches
      this.notifyAgentCacheCleanup(topicId);

      this.logger.info("Topic vector store deleted", { topicId });
    } catch (error) {
      this.logger.error("Failed to delete topic vector store", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Delete a topic and its vector store
   */
  public async deleteTopic(topicId: string): Promise<void> {
    this.logger.info("Deleting topic", { topicId });

    try {
      if (!this.topicsIndex || !this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      // Check if topic exists
      if (!this.topicsIndex.topics[topicId]) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const topicName = this.topicsIndex.topics[topicId].name;

      // Delete vector store
      await this.vectorStoreFactory.deleteStore(topicId);

      // Remove from cache
      this.vectorStoreCache.delete(topicId);
      this.topicDocuments.delete(topicId);

      // Delete document metadata file
      try {
        const documentsPath = this.getTopicDocumentsPath(topicId);
        await fs.unlink(documentsPath);
      } catch {
        // File might not exist
      }

      // Remove from index
      delete this.topicsIndex.topics[topicId];
      this.topicsIndex.lastUpdated = Date.now();

      // Save index
      await this.saveTopicsIndex();

      this.notifyAgentCacheCleanup(topicId);

      this.logger.info("Topic deleted successfully", { topicId, topicName });
    } catch (error) {
      this.logger.error("Failed to delete topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Notify registered components to clear cached agents for a topic
   */
  private notifyAgentCacheCleanup(topicId: string): void {
    if (!TopicManager.agentCacheCleanupCallback) {
      return;
    }

    try {
      TopicManager.agentCacheCleanupCallback(topicId);
    } catch (error) {
      // Don't fail the caller if cache cleanup fails
      this.logger.debug("Agent cache cleanup callback failed", {
        topicId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update topic metadata
   */
  public async updateTopic(
    topicId: string,
    updates: Partial<Pick<Topic, "name" | "description">>
  ): Promise<Topic> {
    this.logger.info("Updating topic", { topicId, updates });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      // Check for name conflicts if renaming
      if (updates.name && updates.name !== topic.name) {
        const existingTopic = Object.values(this.topicsIndex.topics).find(
          (t) =>
            t.id !== topicId &&
            t.name.toLowerCase() === updates.name!.toLowerCase()
        );

        if (existingTopic) {
          throw new Error(`Topic with name "${updates.name}" already exists`);
        }
      }

      // Apply updates
      if (updates.name) topic.name = updates.name;
      if (updates.description !== undefined)
        topic.description = updates.description;
      topic.updatedAt = Date.now();

      // Save index
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      this.logger.info("Topic updated successfully", { topicId });

      return topic;
    } catch (error) {
      this.logger.error("Failed to update topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Get a topic by ID (from local or common database)
   */
  public getTopic(topicId: string): Topic | null {
    // Check local topics first
    if (this.topicsIndex?.topics[topicId]) {
      return { ...this.topicsIndex.topics[topicId], source: 'local' as TopicSource };
    }
    // Check common topics
    if (this.commonTopicsIndex?.topics[topicId]) {
      return { ...this.commonTopicsIndex.topics[topicId], source: 'common' as TopicSource };
    }
    return null;
  }

  /**
   * Get all topics (local + common merged)
   */
  public getAllTopics(): Topic[] {
    const localTopics = this.topicsIndex
      ? Object.values(this.topicsIndex.topics).map(t => ({ ...t, source: 'local' as TopicSource }))
      : [];

    const commonTopics = this.commonTopicsIndex
      ? Object.values(this.commonTopicsIndex.topics).map(t => ({ ...t, source: 'common' as TopicSource }))
      : [];

    return [...localTopics, ...commonTopics];
  }

  /**
   * Check if a topic is from the common database (read-only)
   */
  public isCommonTopic(topicId: string): boolean {
    return this.commonTopicsIndex?.topics[topicId] !== undefined;
  }

  /**
   * Get documents for a specific topic (local or common)
   */
  public getTopicDocuments(topicId: string): TopicDocument[] {
    // Check local documents first
    const localDocs = this.topicDocuments.get(topicId);
    if (localDocs) {
      return Array.from(localDocs.values());
    }
    // Check common documents
    const commonDocs = this.commonTopicDocuments.get(topicId);
    if (commonDocs) {
      return Array.from(commonDocs.values());
    }
    return [];
  }

  /**
   * Remove a document from a topic by file path
   * This is used when a file is modified to remove old chunks before adding new ones
   */
  public async removeDocumentByFilePath(
    topicId: string,
    filePath: string
  ): Promise<boolean> {
    this.logger.info("Removing document by file path", { topicId, filePath });

    try {
      if (!this.topicsIndex || !this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      // Find document with matching file path
      const documents = this.topicDocuments.get(topicId);
      if (!documents) {
        this.logger.debug("No documents found for topic", { topicId });
        return false;
      }

      let documentToRemove: TopicDocument | null = null;
      for (const doc of documents.values()) {
        if (doc.filePath === filePath) {
          documentToRemove = doc;
          break;
        }
      }

      if (!documentToRemove) {
        this.logger.debug("Document with file path not found", { filePath });
        return false;
      }

      // Remove document metadata from cache
      documents.delete(documentToRemove.id);

      // Remove chunks from vector store
      // We need to delete chunks that match this document's file path
      const vectorStore = await this.getVectorStore(topicId);
      if (vectorStore) {
        // LanceDB allows us to delete by filter
        // We'll need to use the documentName metadata to filter
        try {
          // Get the store and delete matching records
          const lanceTable = (vectorStore as any).table;
          if (lanceTable) {
            // Delete all records where metadata.documentName matches the file name
            const fileName = path.basename(filePath);
            await lanceTable.delete(`documentName = '${fileName.replace(/'/g, "''")}'`);
            this.logger.info("Chunks removed from vector store", {
              documentId: documentToRemove.id,
              fileName,
            });
          }
        } catch (error) {
          this.logger.warn("Failed to remove chunks from vector store", {
            error: error instanceof Error ? error.message : String(error),
            documentId: documentToRemove.id,
          });
          // Continue even if chunk removal fails - metadata is already removed
        }
      }

      // Update topic document count
      topic.documentCount = documents.size;
      topic.updatedAt = Date.now();
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      // Persist document metadata to disk
      await this.saveTopicDocuments(topicId);

      // Update folder chunk statistics
      this.removeFolderChunkStats(topicId, filePath);

      this.logger.info("Document removed successfully", {
        topicId,
        documentId: documentToRemove.id,
        filePath,
      });

      return true;
    } catch (error) {
      this.logger.error("Failed to remove document", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
        filePath,
      });
      throw error;
    }
  }

  /**
   * Add documents to a topic
   */
  public async addDocuments(
    topicId: string,
    filePaths: string[],
    options?: PipelineOptions
  ): Promise<AddDocumentResult[]> {
    this.logger.info("Adding documents to topic", {
      topicId,
      documentCount: filePaths.length,
    });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const results: AddDocumentResult[] = [];

      // Process each document
      for (const filePath of filePaths) {
        try {
          // Process document through pipeline
          const pipelineResult = await this.documentPipeline.processDocument(
            filePath,
            topicId,
            options
          );

          if (!pipelineResult.success) {
            this.logger.warn("Document processing failed", {
              filePath,
              errors: pipelineResult.errors,
            });
            continue;
          }

          // Create document metadata
          const fileName = path.basename(filePath);
          const fileExt = path.extname(filePath).substring(1);

          const document: TopicDocument = {
            id: this.generateDocumentId(),
            topicId,
            name: fileName,
            filePath,
            fileType: this.mapFileType(fileExt),
            addedAt: Date.now(),
            chunkCount: pipelineResult.metadata.chunksStored,
          };

          // Store document metadata
          if (!this.topicDocuments.has(topicId)) {
            this.topicDocuments.set(topicId, new Map());
          }
          this.topicDocuments.get(topicId)!.set(document.id, document);

          // Update folder chunk statistics
          this.updateFolderChunkStats(topicId, filePath, document.chunkCount);

          results.push({
            topic,
            document,
            pipelineResult,
          });

          this.logger.info("Document added successfully", {
            topicId,
            documentId: document.id,
            fileName,
            chunkCount: document.chunkCount,
          });
        } catch (error) {
          this.logger.error("Failed to add document", {
            error: error instanceof Error ? error.message : String(error),
            filePath,
          });
          // Continue with other documents
        }
      }

      // Update topic document count
      topic.documentCount = this.topicDocuments.get(topicId)?.size || 0;
      topic.updatedAt = Date.now();
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      // Persist document metadata to disk
      await this.saveTopicDocuments(topicId);

      this.logger.info("Documents added to topic", {
        topicId,
        successCount: results.length,
        totalCount: filePaths.length,
      });

      return results;
    } catch (error) {
      this.logger.error("Failed to add documents", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Get vector store for a topic
   */
  public async getVectorStore(topicId: string): Promise<VectorStore | null> {
    this.logger.debug("Getting vector store", { topicId });

    try {
      if (!this.vectorStoreFactory) {
        throw new Error("TopicManager not initialized");
      }

      await this.ensureEmbeddingModelCompatibility(topicId);

      // Check cache first
      const cachedStore = this.vectorStoreCache.get(topicId);
      if (cachedStore) {
        this.logger.debug("Returning cached vector store", { topicId });
        return cachedStore;
      }

      // Load from disk
      let store;
      if (this.isCommonTopic(topicId) && this.commonDatabasePath) {
        this.logger.debug("Loading vector store from common database", { topicId });
        store = await this.vectorStoreFactory.loadStore(topicId, this.commonDatabasePath);
      } else {
        store = await this.vectorStoreFactory.loadStore(topicId);
      }

      if (store) {
        this.vectorStoreCache.set(topicId, store);
        this.logger.debug("Vector store loaded and cached", { topicId });
      }

      return store;
    } catch (error) {
      this.logger.error("Failed to get vector store", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Prevent mixing embeddings generated with incompatible models
   */
  private async ensureEmbeddingModelCompatibility(topicId: string): Promise<void> {
    if (!this.vectorStoreFactory) {
      return;
    }

    const metadata = await this.vectorStoreFactory.getStoreMetadata(topicId);
    if (!metadata?.embeddingModel) {
      return;
    }

    const currentModel = this.embeddingService.getCurrentModel();
    if (metadata.embeddingModel === currentModel) {
      return;
    }

    // Check if the stored model is available (downloaded/local)
    const availableModels = await this.embeddingService.listAvailableModels();
    const isModelAvailable = availableModels.some(
      (m) => m.name === metadata.embeddingModel && (m.downloaded || m.source === 'local')
    );

    if (isModelAvailable) {
      // Model is available, proceed (VectorStoreFactory will handle loading the correct model)
      return;
    }

    const topicName = this.topicsIndex?.topics[topicId]?.name ?? topicId;

    this.logger.warn("Embedding model mismatch detected for topic", {
      topicId,
      topicName,
      storedModel: metadata.embeddingModel,
      currentModel,
    });

    const message = `Topic "${topicName}" was indexed with embedding model "${metadata.embeddingModel}", but the current setting is "${currentModel}". ` +
      `The model "${metadata.embeddingModel}" is not currently available/downloaded. ` +
      `Please switch back to "${metadata.embeddingModel}" in settings to download it, or recreate the topic.`;

    throw new Error(message);
  }

  /**
   * Get statistics for a topic
   */
  public async getTopicStats(topicId: string): Promise<TopicStats | null> {
    this.logger.debug("Getting topic stats", { topicId });

    try {
      if (!this.topicsIndex || !this.vectorStoreFactory) {
        return null;
      }

      let topic = this.topicsIndex.topics[topicId];
      let databaseDir = this.getDatabaseDir();
      let isCommon = false;

      // If not in local, check common
      if (!topic && this.commonTopicsIndex && this.commonTopicsIndex.topics[topicId]) {
        topic = this.commonTopicsIndex.topics[topicId];
        if (this.commonDatabasePath) {
          databaseDir = this.commonDatabasePath;
          isCommon = true;
        }
      }

      if (!topic) {
        return null;
      }

      // Get document count
      const documents = isCommon
        ? this.commonTopicDocuments.get(topicId)
        : this.topicDocuments.get(topicId);

      const documentCount = documents?.size || 0;

      // Load vector store metadata
      const metadataPath = path.join(
        databaseDir,
        `vector-${topicId}-metadata.json`
      );

      let chunkCount = 0;
      let embeddingModel =
        this.embeddingService.getCurrentModel() ||
        this.topicsIndex?.modelName ||
        "unknown";

      try {
        const metadataJson = await fs.readFile(metadataPath, "utf-8");
        const metadata = JSON.parse(metadataJson);
        chunkCount = metadata.chunkCount || 0;
        if (metadata.embeddingModel) {
          embeddingModel = metadata.embeddingModel;
        }
      } catch {
        // Metadata not available
      }

      return {
        documentCount,
        chunkCount,
        lastUpdated: topic.updatedAt,
        embeddingModel,
      };
    } catch (error) {
      this.logger.error("Failed to get topic stats", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      return null;
    }
  }

  /**
   * Get folder chunk statistics for a topic (hierarchical tree structure)
   */
  public getFolderChunkStats(topicId: string): FolderChunkStats | null {
    return this.folderChunkStats.get(topicId) || null;
  }

  /**
   * Get the watch folder that contains a given file path
   * Returns the resolved watch folder path and its display name (basename or relative path)
   */
  private getWatchFolderForPath(filePath: string): { watchFolder: string; displayName: string } | null {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const watchFolders = config.get<string[]>(CONFIG.WATCH_FOLDERS, []);
    const legacyWatchFolder = config.get<string>(CONFIG.WATCH_FOLDER, "");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    
    // Combine all configured folders
    const allFolders = [...watchFolders];
    if (legacyWatchFolder && legacyWatchFolder.trim().length > 0) {
      allFolders.push(legacyWatchFolder);
    }
    
    const normalizedFilePath = path.normalize(filePath);
    
    for (const folder of allFolders) {
      const trimmedFolder = folder.trim();
      if (trimmedFolder.length === 0) continue;
      
      // Resolve relative paths to absolute
      const resolvedFolder = path.isAbsolute(trimmedFolder)
        ? trimmedFolder
        : path.resolve(workspaceRoot, trimmedFolder);
      
      const normalizedWatchFolder = path.normalize(resolvedFolder);
      
      if (normalizedFilePath.startsWith(normalizedWatchFolder + path.sep) || normalizedFilePath === normalizedWatchFolder) {
        // Use the folder's basename as the display name
        const displayName = path.basename(normalizedWatchFolder);
        return { watchFolder: normalizedWatchFolder, displayName };
      }
    }
    
    return null;
  }

  /**
   * Update folder chunk statistics when a document is added
   */
  public updateFolderChunkStats(topicId: string, filePath: string, chunkCount: number): void {
    let stats = this.folderChunkStats.get(topicId);
    if (!stats) {
      stats = {
        roots: new Map(),
        totalChunks: 0,
        lastUpdated: Date.now(),
      };
      this.folderChunkStats.set(topicId, stats);
    }

    const normalizedFilePath = path.normalize(filePath);
    
    // Find which watch folder this file belongs to
    const watchFolderInfo = this.getWatchFolderForPath(filePath);
    
    let rootKey: string;
    let rootDisplayName: string;
    let relativeParts: string[];
    
    if (watchFolderInfo) {
      // Build tree relative to watch folder
      rootKey = watchFolderInfo.watchFolder;
      rootDisplayName = watchFolderInfo.displayName;
      
      // Get path relative to watch folder
      const relativePath = path.relative(watchFolderInfo.watchFolder, normalizedFilePath);
      relativeParts = relativePath.split(path.sep).filter(p => p.length > 0);
    } else {
      // Fallback: use file's immediate parent folder as root (for files not in watch folders)
      const parentDir = path.dirname(normalizedFilePath);
      rootKey = parentDir;
      rootDisplayName = path.basename(parentDir);
      relativeParts = [path.basename(normalizedFilePath)];
    }
    
    if (relativeParts.length === 0) {
      return;
    }

    // Create root node if it doesn't exist
    if (!stats.roots.has(rootKey)) {
      stats.roots.set(rootKey, {
        name: rootDisplayName,
        path: rootKey,
        isFile: false,
        chunkCount: 0,
        children: new Map(),
      });
    }

    // Traverse/build the tree from the root
    let currentNode = stats.roots.get(rootKey)!;
    let currentPath = rootKey;

    for (let i = 0; i < relativeParts.length; i++) {
      const part = relativeParts[i];
      currentPath = path.join(currentPath, part);
      const isLastPart = i === relativeParts.length - 1;

      if (!currentNode.children.has(part)) {
        currentNode.children.set(part, {
          name: part,
          path: currentPath,
          isFile: isLastPart,
          chunkCount: 0,
          children: new Map(),
        });
      }

      currentNode = currentNode.children.get(part)!;
      
      if (isLastPart) {
        currentNode.isFile = true;
        currentNode.chunkCount = chunkCount;
      }
    }

    // Recalculate all folder totals
    this.recalculateFolderTotals(stats);
    stats.lastUpdated = Date.now();

    // Persist to disk
    this.saveFolderChunkStats(topicId).catch(err => {
      this.logger.warn("Failed to save folder chunk stats", { topicId, error: err });
    });
  }

  /**
   * Remove a file from folder chunk statistics
   */
  public removeFolderChunkStats(topicId: string, filePath: string): void {
    const stats = this.folderChunkStats.get(topicId);
    if (!stats) {
      return;
    }

    const normalizedFilePath = path.normalize(filePath);
    
    // Find which watch folder this file belongs to (same logic as updateFolderChunkStats)
    const watchFolderInfo = this.getWatchFolderForPath(filePath);
    
    let rootKey: string;
    let relativeParts: string[];
    
    if (watchFolderInfo) {
      rootKey = watchFolderInfo.watchFolder;
      const relativePath = path.relative(watchFolderInfo.watchFolder, normalizedFilePath);
      relativeParts = relativePath.split(path.sep).filter(p => p.length > 0);
    } else {
      // Fallback: try to find the file in existing roots
      const parentDir = path.dirname(normalizedFilePath);
      rootKey = parentDir;
      relativeParts = [path.basename(normalizedFilePath)];
    }
    
    if (relativeParts.length === 0) {
      return;
    }

    const root = stats.roots.get(rootKey);
    if (!root) {
      return;
    }

    // Navigate to parent of the file
    let currentNode = root;
    const pathStack: { parent: FolderChunkNode; childKey: string }[] = [];

    for (let i = 0; i < relativeParts.length; i++) {
      const part = relativeParts[i];
      const child = currentNode.children.get(part);
      if (!child) {
        return; // File not found in stats
      }

      pathStack.push({ parent: currentNode, childKey: part });
      currentNode = child;
    }

    // Remove the file node
    if (pathStack.length > 0) {
      const lastEntry = pathStack[pathStack.length - 1];
      lastEntry.parent.children.delete(lastEntry.childKey);

      // Clean up empty parent folders
      for (let i = pathStack.length - 2; i >= 0; i--) {
        const entry = pathStack[i];
        const child = entry.parent.children.get(entry.childKey);
        if (child && child.children.size === 0 && !child.isFile) {
          entry.parent.children.delete(entry.childKey);
        } else {
          break;
        }
      }
    } else {
      // The file is directly under root
      stats.roots.delete(rootKey);
    }

    // Remove empty roots
    if (root.children.size === 0 && !root.isFile) {
      stats.roots.delete(rootKey);
    }

    // Recalculate totals
    this.recalculateFolderTotals(stats);
    stats.lastUpdated = Date.now();

    // Persist to disk
    this.saveFolderChunkStats(topicId).catch(err => {
      this.logger.warn("Failed to save folder chunk stats after removal", { topicId, error: err });
    });
  }

  /**
   * Recalculate chunk totals for all folders in the stats tree
   */
  private recalculateFolderTotals(stats: FolderChunkStats): void {
    const calculateNodeTotal = (node: FolderChunkNode): number => {
      if (node.isFile) {
        return node.chunkCount;
      }
      let total = 0;
      for (const child of node.children.values()) {
        total += calculateNodeTotal(child);
      }
      node.chunkCount = total;
      return total;
    };

    let totalChunks = 0;
    for (const root of stats.roots.values()) {
      totalChunks += calculateNodeTotal(root);
    }
    stats.totalChunks = totalChunks;
  }

  /**
   * Save folder chunk statistics to disk
   */
  private async saveFolderChunkStats(topicId: string): Promise<void> {
    const stats = this.folderChunkStats.get(topicId);
    if (!stats) {
      return;
    }

    try {
      const statsPath = this.getFolderChunkStatsPath(topicId);
      const serialized = this.serializeFolderChunkStats(stats);
      await fs.writeFile(statsPath, JSON.stringify(serialized, null, 2), "utf-8");
      this.logger.debug("Folder chunk stats saved", { topicId });
    } catch (error) {
      this.logger.error("Failed to save folder chunk stats", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
    }
  }

  /**
   * Load folder chunk statistics from disk
   */
  private async loadFolderChunkStats(topicId: string): Promise<void> {
    try {
      const statsPath = this.getFolderChunkStatsPath(topicId);
      const data = await fs.readFile(statsPath, "utf-8");
      const serialized = JSON.parse(data);
      const stats = this.deserializeFolderChunkStats(serialized);
      this.folderChunkStats.set(topicId, stats);
      this.logger.debug("Folder chunk stats loaded", { topicId });
    } catch {
      // File might not exist for older topics
      this.logger.debug("No folder chunk stats found for topic", { topicId });
    }
  }

  /**
   * Get path for folder chunk stats file
   */
  private getFolderChunkStatsPath(topicId: string): string {
    return path.join(this.getDatabaseDir(), `topic-${topicId}-folder-stats.json`);
  }

  /**
   * Serialize FolderChunkStats for JSON storage
   */
  private serializeFolderChunkStats(stats: FolderChunkStats): any {
    const serializeNode = (node: FolderChunkNode): FolderChunkNodeSerialized => {
      const children: { [key: string]: FolderChunkNodeSerialized } = {};
      for (const [key, child] of node.children) {
        children[key] = serializeNode(child);
      }
      return {
        name: node.name,
        path: node.path,
        isFile: node.isFile,
        chunkCount: node.chunkCount,
        children,
      };
    };

    const roots: { [key: string]: FolderChunkNodeSerialized } = {};
    for (const [key, root] of stats.roots) {
      roots[key] = serializeNode(root);
    }

    return {
      roots,
      totalChunks: stats.totalChunks,
      lastUpdated: stats.lastUpdated,
    };
  }

  /**
   * Deserialize FolderChunkStats from JSON storage
   */
  private deserializeFolderChunkStats(data: any): FolderChunkStats {
    const deserializeNode = (serialized: FolderChunkNodeSerialized): FolderChunkNode => {
      const children = new Map<string, FolderChunkNode>();
      for (const [key, child] of Object.entries(serialized.children)) {
        children.set(key, deserializeNode(child as FolderChunkNodeSerialized));
      }
      return {
        name: serialized.name,
        path: serialized.path,
        isFile: serialized.isFile,
        chunkCount: serialized.chunkCount,
        children,
      };
    };

    const roots = new Map<string, FolderChunkNode>();
    for (const [key, root] of Object.entries(data.roots)) {
      roots.set(key, deserializeNode(root as FolderChunkNodeSerialized));
    }

    return {
      roots,
      totalChunks: data.totalChunks || 0,
      lastUpdated: data.lastUpdated || Date.now(),
    };
  }

  /**
   * Register a callback function to be called when topics are deleted
   * This allows external components (like RAGTool) to clean up their caches
   * without creating circular dependencies
   */
  public static registerAgentCacheCleanupCallback(callback: (topicId: string) => void): void {
    TopicManager.agentCacheCleanupCallback = callback;
  }

  /**
   * Refresh topics from disk
   */
  public async refresh(): Promise<void> {
    this.logger.info("Refreshing topics");
    await this.loadTopicsIndex();
  }

  /**
   * Reinitialize with the currently configured embedding model
   * Called when the embedding model configuration changes
   */
  public async reinitializeWithNewModel(): Promise<void> {
    this.logger.info("Reinitializing TopicManager with new embedding model");

    try {
      const topicIds = this.topicsIndex
        ? Object.keys(this.topicsIndex.topics)
        : [];

      // 1. Dispose old factory first to release resources
      if (this.vectorStoreFactory) {
        this.vectorStoreFactory.dispose();
      }

      // 2. Clear local caches
      this.vectorStoreCache.clear();

      // 3. Notify external components to clear their caches
      for (const topicId of topicIds) {
        this.notifyAgentCacheCleanup(topicId);
      }

      // Reinitialize document pipeline with new model
      const storageDir = this.getDatabaseDir();
      await this.documentPipeline.initialize(storageDir);

      // Create new LangChain-compatible embeddings wrapper
      const embeddings = new TransformersEmbeddings();

      // Update topics index with new model
      const currentModel = this.embeddingService.getCurrentModel();

      if (this.topicsIndex) {
        this.topicsIndex.modelName = currentModel;
        this.topicsIndex.lastUpdated = Date.now();
        await this.saveTopicsIndex();

        this.vectorStoreFactory = new VectorStoreFactory(
          embeddings,
          storageDir,
          this.topicsIndex.modelName
        );
      }

      this.logger.info("TopicManager reinitialized successfully with new model", {
        embeddingModel: this.topicsIndex?.modelName,
      });
    } catch (error) {
      this.logger.error("Failed to reinitialize TopicManager with new model", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Dispose of all resources and clean up
   * Should be called when TopicManager is no longer needed
   */
  public dispose(): void {
    this.logger.info("Disposing TopicManager");

    // Clear all caches
    this.vectorStoreCache.clear();
    this.topicDocuments.clear();

    // Dispose of document pipeline
    if (this.documentPipeline) {
      this.documentPipeline.dispose();
    }

    // Dispose of vector store factory if it exists
    if (this.vectorStoreFactory) {
      this.vectorStoreFactory.dispose();
      this.vectorStoreFactory = null;
    }

    // Clear references
    this.topicsIndex = null;
    this.isInitialized = false;

    // Clear static callback
    TopicManager.agentCacheCleanupCallback = null;

    this.logger.info("TopicManager disposed");
  }

  // ==================== Export/Import Methods ====================

  /**
   * Export a topic to a .rag archive file (ZIP format with DEFLATE compression)
   */
  public async exportTopic(topicId: string, exportPath: string): Promise<void> {
    this.logger.info("Exporting topic", { topicId, exportPath });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // Only allow exporting local topics
      if (this.isCommonTopic(topicId)) {
        throw new Error("Cannot export topics from common database");
      }

      const topic = this.topicsIndex.topics[topicId];
      if (!topic) {
        throw new Error(`Topic not found: ${topicId}`);
      }

      const documents = this.getTopicDocuments(topicId);
      const databaseDir = this.getDatabaseDir();

      // Create export metadata
      const exportData: ExportedTopicData = {
        version: EXPORT_FORMAT_VERSION,
        topic: { ...topic },
        documents,
        embeddingModel: this.topicsIndex.modelName,
        exportedAt: Date.now(),
      };

      // Create ZIP archive
      const output = fsSync.createWriteStream(exportPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      const archivePromise = new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
      });

      archive.pipe(output);

      // Add topic metadata
      archive.append(JSON.stringify(exportData, null, 2), { name: 'topic.json' });

      // Add vector store files (LanceDB tables are directories with .lance extension)
      const lanceDbDir = path.join(databaseDir, 'lancedb', `${topicId}.lance`);
      try {
        await fs.access(lanceDbDir);
        archive.directory(lanceDbDir, `lancedb/${topicId}.lance`);
      } catch {
        this.logger.debug("No LanceDB directory found for topic", { topicId, path: lanceDbDir });
      }

      // Add vector metadata file
      const vectorMetadataPath = path.join(databaseDir, `vector-${topicId}-metadata.json`);
      try {
        await fs.access(vectorMetadataPath);
        archive.file(vectorMetadataPath, { name: `vector-${topicId}-metadata.json` });
      } catch {
        this.logger.debug("No vector metadata file found for topic", { topicId });
      }

      await archive.finalize();
      await archivePromise;

      this.logger.info("Topic exported successfully", { topicId, exportPath });
    } catch (error) {
      this.logger.error("Failed to export topic", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Import a topic from a .rag archive file
   */
  public async importTopic(archivePath: string): Promise<Topic> {
    this.logger.info("Importing topic", { archivePath });

    try {
      if (!this.topicsIndex) {
        throw new Error("TopicManager not initialized");
      }

      // Use adm-zip for extraction
      const zip = new AdmZip(archivePath);
      const entries = zip.getEntries();

      // Find and parse topic.json
      const topicEntry = entries.find((e: AdmZip.IZipEntry) => e.entryName === 'topic.json');
      if (!topicEntry) {
        throw new Error("Invalid archive: topic.json not found");
      }

      const exportData: ExportedTopicData = JSON.parse(topicEntry.getData().toString('utf8'));

      // Log if embedding model differs - actual compatibility check happens at query time
      const currentModel = this.embeddingService.getCurrentModel();
      if (exportData.embeddingModel !== currentModel) {
        this.logger.warn("Imported topic uses different embedding model", {
          importedModel: exportData.embeddingModel,
          currentModel,
          note: "Switch to the imported model before querying this topic",
        });
      }

      // Generate new topic ID to avoid conflicts
      const newTopicId = this.generateTopicId();
      const originalTopicId = exportData.topic.id;

      // Create new topic with imported data
      const newTopic: Topic = {
        ...exportData.topic,
        id: newTopicId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: 'local',
      };

      // Check for name conflicts
      const existingTopic = Object.values(this.topicsIndex.topics).find(
        t => t.name.toLowerCase() === newTopic.name.toLowerCase()
      );
      if (existingTopic) {
        newTopic.name = `${newTopic.name} (imported)`;
      }

      // Extract LanceDB files with new topic ID
      const databaseDir = this.getDatabaseDir();

      // Target directory should always match what VectorStoreFactory expects (now checking .lance)
      const targetDirName = `${newTopicId}.lance`;
      const lanceDbDir = path.join(databaseDir, 'lancedb', targetDirName);
      await fs.mkdir(lanceDbDir, { recursive: true });

      for (const entry of entries) {
        // Handle standard .lance extension
        if (entry.entryName.startsWith(`lancedb/${originalTopicId}.lance/`)) {
          const relativePath = entry.entryName.replace(`lancedb/${originalTopicId}.lance/`, '');
          // Skip directories (they are created recursively by mkdir)
          if (entry.isDirectory) continue;

          const targetPath = path.join(lanceDbDir, relativePath);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, entry.getData());
        }
        // Handle legacy/no-extension format
        else if (entry.entryName.startsWith(`lancedb/${originalTopicId}/`)) {
          const relativePath = entry.entryName.replace(`lancedb/${originalTopicId}/`, '');
          // Skip directories
          if (entry.isDirectory) continue;

          const targetPath = path.join(lanceDbDir, relativePath);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, entry.getData());
        }
      }

      // Extract and update vector metadata
      const vectorMetadataEntry = entries.find((e: AdmZip.IZipEntry) => e.entryName === `vector-${originalTopicId}-metadata.json`);
      if (vectorMetadataEntry) {
        const metadata = JSON.parse(vectorMetadataEntry.getData().toString('utf8'));
        metadata.topicId = newTopicId;
        const newMetadataPath = path.join(databaseDir, `vector-${newTopicId}-metadata.json`);
        await fs.writeFile(newMetadataPath, JSON.stringify(metadata, null, 2));
      }

      // Update document IDs and topic references
      const newDocuments = exportData.documents.map(doc => ({
        ...doc,
        id: this.generateDocumentId(),
        topicId: newTopicId,
      }));

      // Save to index
      this.topicsIndex.topics[newTopicId] = newTopic;
      this.topicsIndex.lastUpdated = Date.now();
      await this.saveTopicsIndex();

      // Save documents
      const documentsMap = new Map<string, TopicDocument>();
      for (const doc of newDocuments) {
        documentsMap.set(doc.id, doc);
      }
      this.topicDocuments.set(newTopicId, documentsMap);
      await this.saveTopicDocuments(newTopicId);

      this.logger.info("Topic imported successfully", {
        originalId: originalTopicId,
        newId: newTopicId,
        name: newTopic.name,
        documentCount: newDocuments.length,
      });

      return newTopic;
    } catch (error) {
      this.logger.error("Failed to import topic", {
        error: error instanceof Error ? error.message : String(error),
        archivePath,
      });
      throw error;
    }
  }

  /**
   * Load topics from common database path (read-only)
   */
  public async loadCommonDatabase(): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const commonPath = config.get<string>(CONFIG.COMMON_DATABASE_PATH);

    if (!commonPath) {
      this.logger.debug("No common database path configured");
      this.commonTopicsIndex = null;
      this.commonTopicDocuments.clear();
      this.commonDatabasePath = null;
      return;
    }

    try {
      // Verify path exists
      await fs.access(commonPath);
      this.commonDatabasePath = commonPath;

      // Check for topics.json
      const indexPath = path.join(commonPath, EXTENSION.TOPICS_INDEX_FILENAME);
      try {
        await fs.access(indexPath);
      } catch {
        this.logger.warn("Common database path exists but missing topics.json", { path: commonPath });
        vscode.window.showWarningMessage(`Common database path found, but missing "${EXTENSION.TOPICS_INDEX_FILENAME}". Is the path correct?`);
        this.commonTopicsIndex = null;
        this.commonTopicDocuments.clear();
        return;
      }

      // Load topics index from common path
      const data = await fs.readFile(indexPath, 'utf-8');
      this.commonTopicsIndex = JSON.parse(data);

      this.logger.info("Common database loaded", {
        path: commonPath,
        topicCount: Object.keys(this.commonTopicsIndex?.topics || {}).length,
      });

      // Load document metadata for each common topic
      if (this.commonTopicsIndex) {
        // Check for name conflicts with local topics BEFORE fully loading
        const localTopicNames = new Set(
          Object.values(this.topicsIndex?.topics || {}).map(t => t.name.toLowerCase())
        );

        const conflicts: string[] = [];

        for (const topic of Object.values(this.commonTopicsIndex.topics)) {
          if (localTopicNames.has(topic.name.toLowerCase())) {
            conflicts.push(topic.name);
          }
        }

        if (conflicts.length > 0) {
          const conflictList = conflicts.slice(0, 3).join(", ") + (conflicts.length > 3 ? "..." : "");
          const message = `Cannot load common database due to name conflicts. Local topics [${conflictList}] already exist. Please rename your local topics first.`;

          this.logger.warn("Common database load aborted due to name conflicts", { conflicts });
          vscode.window.showErrorMessage(message);

          // Abort loading
          this.commonTopicsIndex = null;
          this.commonTopicDocuments.clear();
          this.commonDatabasePath = null;
          return;
        }

        // No conflicts, proceed to load documents
        for (const topicId of Object.keys(this.commonTopicsIndex.topics)) {
          await this.loadCommonTopicDocuments(topicId);
        }
      }
    } catch (error) {
      this.logger.warn("Failed to load common database", {
        path: commonPath,
        error: error instanceof Error ? error.message : String(error),
      });
      vscode.window.showErrorMessage(`Failed to load common database: ${error instanceof Error ? error.message : String(error)}`);
      this.commonTopicsIndex = null;
      this.commonTopicDocuments.clear();
      this.commonDatabasePath = null;
    }
  }

  /**
   * Load document metadata for a common topic
   */
  private async loadCommonTopicDocuments(topicId: string): Promise<void> {
    if (!this.commonDatabasePath) return;

    try {
      const documentsPath = path.join(this.commonDatabasePath, `topic-${topicId}-documents.json`);
      const data = await fs.readFile(documentsPath, 'utf-8');
      const documentsArray: TopicDocument[] = JSON.parse(data);

      const documentsMap = new Map<string, TopicDocument>();
      for (const doc of documentsArray) {
        documentsMap.set(doc.id, doc);
      }

      this.commonTopicDocuments.set(topicId, documentsMap);
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
         this.logger.warn("Document file missing for common topic", { topicId, error: "File not found" });
      } else {
         this.logger.error("Failed to load documents for common topic", { topicId, error });
      }
      this.commonTopicDocuments.set(topicId, new Map());
    }
  }

  /**
   * Get common database path if configured
   */
  public getCommonDatabasePath(): string | null {
    return this.commonDatabasePath;
  }

  // ==================== Private Methods ====================

  /**
   * Get the database directory path
   */
  private getDatabaseDir(): string {
    const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
    const configuredPath = (config.get<string>(CONFIG.EMBEDDING_DB_PATH, "") || "").trim();

    if (!configuredPath) {
      return path.join(
        this.context.globalStorageUri.fsPath,
        EXTENSION.DATABASE_DIR
      );
    }

    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.logger.warn(
        "Embedding DB path is relative but no workspace folder found. Falling back to default.",
        { configuredPath }
      );
      return path.join(
        this.context.globalStorageUri.fsPath,
        EXTENSION.DATABASE_DIR
      );
    }

    return path.join(workspaceFolder.uri.fsPath, configuredPath);
  }

  /**
   * Get the topics index file path
   */
  private getTopicsIndexPath(): string {
    return path.join(this.getDatabaseDir(), EXTENSION.TOPICS_INDEX_FILENAME);
  }

  /**
   * Ensure storage directory exists
   */
  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.getDatabaseDir(), { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
  }

  /**
   * Load topics index from file
   */
  private async loadTopicsIndex(): Promise<void> {
    try {
      const indexPath = this.getTopicsIndexPath();
      const data = await fs.readFile(indexPath, "utf-8");
      this.topicsIndex = JSON.parse(data);

      this.logger.info("Topics index loaded", {
        topicCount: Object.keys(this.topicsIndex?.topics || {}).length,
      });

      // Load document metadata for each topic
      await this.loadAllTopicDocuments();
    } catch (error) {
      // File doesn't exist, create new index
      this.logger.info("Topics index not found, creating new one");

      // Embedding service is already initialized by init()
      this.topicsIndex = {
        topics: {},
        modelName: this.embeddingService.getCurrentModel(),
        lastUpdated: Date.now(),
      };

      await this.saveTopicsIndex();
    }
  }

  /**
   * Save topics index to file
   */
  private async saveTopicsIndex(): Promise<void> {
    if (!this.topicsIndex) {
      return;
    }

    try {
      const indexPath = this.getTopicsIndexPath();
      await fs.writeFile(
        indexPath,
        JSON.stringify(this.topicsIndex, null, 2),
        "utf-8"
      );

      this.logger.debug("Topics index saved");
    } catch (error) {
      this.logger.error("Failed to save topics index", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate a unique topic ID
   */
  private generateTopicId(): string {
    return `topic-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Generate a unique document ID
   */
  private generateDocumentId(): string {
    return `doc-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Map file extension to document file type
   */
  private mapFileType(extension: string): "pdf" | "markdown" | "html" {
    switch (extension.toLowerCase()) {
      case "pdf":
        return "pdf";
      case "md":
      case "markdown":
        return "markdown";
      case "html":
      case "htm":
        return "html";
      default:
        return "markdown"; // Default fallback
    }
  }

  /**
   * Get the file path for storing topic documents metadata
   */
  private getTopicDocumentsPath(topicId: string): string {
    return path.join(this.getDatabaseDir(), `topic-${topicId}-documents.json`);
  }

  /**
   * Save document metadata for a topic to disk
   */
  private async saveTopicDocuments(topicId: string): Promise<void> {
    try {
      const documents = this.topicDocuments.get(topicId);
      if (!documents) {
        return;
      }

      const documentsPath = this.getTopicDocumentsPath(topicId);
      const documentsArray = Array.from(documents.values());

      await fs.writeFile(
        documentsPath,
        JSON.stringify(documentsArray, null, 2),
        "utf-8"
      );

      this.logger.debug("Topic documents saved", {
        topicId,
        documentCount: documentsArray.length,
      });
    } catch (error) {
      this.logger.error("Failed to save topic documents", {
        error: error instanceof Error ? error.message : String(error),
        topicId,
      });
      throw error;
    }
  }

  /**
   * Load document metadata for a topic from disk
   */
  private async loadTopicDocuments(topicId: string): Promise<void> {
    try {
      const documentsPath = this.getTopicDocumentsPath(topicId);
      const data = await fs.readFile(documentsPath, "utf-8");
      const documentsArray: TopicDocument[] = JSON.parse(data);

      const documentsMap = new Map<string, TopicDocument>();
      for (const doc of documentsArray) {
        documentsMap.set(doc.id, doc);
      }

      this.topicDocuments.set(topicId, documentsMap);

      this.logger.debug("Topic documents loaded", {
        topicId,
        documentCount: documentsArray.length,
      });
    } catch (error) {
      // File might not exist for older topics
      this.logger.debug("No document metadata found for topic", { topicId });
      this.topicDocuments.set(topicId, new Map());
    }
  }

  /**
   * Load document metadata for all topics
   */
  private async loadAllTopicDocuments(): Promise<void> {
    if (!this.topicsIndex) {
      return;
    }

    const topicIds = Object.keys(this.topicsIndex.topics);
    this.logger.debug("Loading documents for all topics", {
      topicCount: topicIds.length,
    });

    for (const topicId of topicIds) {
      await this.loadTopicDocuments(topicId);
      await this.loadFolderChunkStats(topicId);
    }
  }
}
