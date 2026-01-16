/**
 * REST Server for LocalRAG CLI
 * Provides HTTP API for external tools to interact with the extension
 * 
 * Default port: 3875
 * Endpoints:
 *   GET /health - Server health check
 *   GET /search?q=<query>&limit=<n>&topic=<name> - Search documents
 *   GET /topics - List all topics
 *   GET /topics/:name - Get topic details
 *   GET /status - Get indexing and extension status
 */

import * as http from "http";
import * as url from "url";
import type { ParsedUrlQuery } from "querystring";
import { Logger } from "../utils/logger";
import type { TopicManager } from "../managers/topicManager";
import { ProgressTracker, type IndexingProgress } from "../utils/progressTracker";
import type { FileWatcherService } from "../utils/fileWatcherService";
import { RAGAgent, type RAGAgentOptions } from "../agents/ragAgent";
import { EmbeddingService } from "../embeddings/embeddingService";
import { CONFIG } from "../utils/constants";
import type { RetrievalStrategy } from "../utils/types";
import * as vscode from "vscode";

export const DEFAULT_PORT = 3875;

export interface ServerConfig {
  port?: number;
  host?: string;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  topic?: string;
}

export interface SearchResultItem {
  content: string;
  path: string;
  score: number;
  topic: string;
  chunkId?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  totalResults: number;
  executionTime: number;
  strategy: string;
}

export interface TopicInfo {
  id: string;
  name: string;
  description?: string;
  documentCount: number;
  chunkCount?: number;
  createdAt: number;
  updatedAt: number;
  embeddingModel?: string;
}

export interface StatusResponse {
  status: "idle" | "indexing" | "paused";
  watching: boolean;
  watchFolders: string[];
  activeOperations: IndexingProgress[];
  embeddingModel: string;
  totalTopics: number;
}

/**
 * REST Server for LocalRAG extension
 */
export class RestServer {
  private server: http.Server | null = null;
  private logger: Logger;
  private port: number;
  private host: string;
  private isRunning: boolean = false;

  // Services - will be set during start
  private topicManager: TopicManager | null = null;
  private progressTracker: ProgressTracker;
  private fileWatcherService: FileWatcherService | null = null;
  private embeddingService: EmbeddingService;

  // Cache for RAG agents per topic
  private agentCache: Map<string, RAGAgent> = new Map();

  constructor(config: ServerConfig = {}) {
    this.logger = new Logger("RestServer");
    this.port = config.port || DEFAULT_PORT;
    this.host = config.host || "127.0.0.1";
    this.progressTracker = ProgressTracker.getInstance();
    this.embeddingService = EmbeddingService.getInstance();
  }

  /**
   * Start the REST server
   */
  public async start(
    topicManager: TopicManager,
    fileWatcherService: FileWatcherService | null
  ): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Server is already running");
      return;
    }

    this.topicManager = topicManager;
    this.fileWatcherService = fileWatcherService;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          this.logger.warn(`Port ${this.port} is already in use`);
          reject(new Error(`Port ${this.port} is already in use. Another instance may be running.`));
        } else {
          this.logger.error("Server error", { error: error.message });
          reject(error);
        }
      });

      this.server.listen(this.port, this.host, () => {
        this.isRunning = true;
        this.logger.info(`REST server started on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the REST server
   */
  public async stop(): Promise<void> {
    if (!this.server || !this.isRunning) {
      return;
    }

    const server = this.server;
    return new Promise((resolve) => {
      server.close(() => {
        this.isRunning = false;
        this.server = null;
        this.agentCache.clear();
        this.logger.info("REST server stopped");
        resolve();
      });
    });
  }

  /**
   * Check if server is running
   */
  public getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the server port
   */
  public getPort(): number {
    return this.port;
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Set CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url || "", true);
    const pathname = parsedUrl.pathname || "";
    const query = parsedUrl.query;

    this.logger.debug("Incoming request", { method: req.method, path: pathname });

    try {
      // Route requests
      if (pathname === "/health") {
        await this.handleHealth(res);
      } else if (pathname === "/search" && req.method === "GET") {
        await this.handleSearch(res, query);
      } else if (pathname === "/topics" && req.method === "GET") {
        await this.handleListTopics(res);
      } else if (pathname.startsWith("/topics/") && req.method === "GET") {
        const topicName = decodeURIComponent(pathname.substring("/topics/".length));
        await this.handleGetTopic(res, topicName);
      } else if (pathname === "/status" && req.method === "GET") {
        await this.handleStatus(res);
      } else {
        this.sendError(res, 404, "Not found");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Request handler error", { error: errorMessage, path: pathname });
      this.sendError(res, 500, errorMessage);
    }
  }

  /**
   * Health check endpoint
   */
  private async handleHealth(res: http.ServerResponse): Promise<void> {
    this.sendJson(res, {
      status: "ok",
      version: "1.0.0",
      timestamp: Date.now(),
    });
  }

  /**
   * Search endpoint
   */
  private async handleSearch(
    res: http.ServerResponse,
    query: ParsedUrlQuery
  ): Promise<void> {
    const searchQuery = query.q as string;
    const limit = parseInt(query.limit as string) || 10;
    const topicName = query.topic as string;

    if (!searchQuery) {
      this.sendError(res, 400, "Missing required parameter: q");
      return;
    }

    if (!this.topicManager) {
      this.sendError(res, 503, "Topic manager not initialized");
      return;
    }

    // Find the topic to search
    const topics = this.topicManager.getAllTopics();
    let targetTopic = topics[0]; // Default to first topic

    if (topicName) {
      const found = topics.find(
        (t) => t.name.toLowerCase() === topicName.toLowerCase()
      );
      if (!found) {
        this.sendError(res, 404, `Topic not found: ${topicName}`);
        return;
      }
      targetTopic = found;
    }

    if (!targetTopic) {
      this.sendError(res, 404, "No topics available");
      return;
    }

    const startTime = Date.now();

    try {
      // Get topic's embedding model and ensure it matches current model
      const topicStats = await this.topicManager.getTopicStats(targetTopic.id);
      const topicEmbeddingModel = topicStats?.embeddingModel;
      const currentEmbeddingModel = this.embeddingService.getCurrentModel();

      if (topicEmbeddingModel && topicEmbeddingModel !== currentEmbeddingModel) {
        // Topic was indexed with a different model
        this.logger.warn("Topic embedding model mismatch", {
          topicModel: topicEmbeddingModel,
          currentModel: currentEmbeddingModel,
          topicId: targetTopic.id,
        });

        // Try to switch to the topic's model for this query
        try {
          this.logger.info("Switching to topic's embedding model", { model: topicEmbeddingModel });
          await this.embeddingService.initialize(topicEmbeddingModel);
          
          // Clear agent cache since we changed the model
          this.agentCache.clear();
        } catch (error) {
          const errorMsg = `Topic "${targetTopic.name}" was indexed with embedding model "${topicEmbeddingModel}", but the current setting is "${currentEmbeddingModel}". Failed to switch models: ${error instanceof Error ? error.message : String(error)}`;
          this.sendError(res, 500, errorMsg);
          return;
        }
      }

      // Get or create RAG agent for this topic
      let agent = this.agentCache.get(targetTopic.id);
      if (!agent) {
        agent = new RAGAgent();
        const vectorStore = await this.topicManager.getVectorStore(targetTopic.id);
        if (!vectorStore) {
          this.sendError(res, 500, "Vector store not available for topic");
          return;
        }
        await agent.initialize(vectorStore);
        this.agentCache.set(targetTopic.id, agent);
      }

      // Get config for retrieval strategy
      const config = vscode.workspace.getConfiguration(CONFIG.ROOT);
      const retrievalStrategy = config.get<string>(CONFIG.RETRIEVAL_STRATEGY, "hybrid");
      const useAgenticMode = config.get<boolean>(CONFIG.USE_AGENTIC_MODE, true);

      // Execute RAG query
      const agentOptions: RAGAgentOptions = {
        topicName: targetTopic.name,
        topK: limit,
        retrievalStrategy: retrievalStrategy as RetrievalStrategy,
        enableIterativeRefinement: useAgenticMode,
      };

      const ragResult = await agent.query(searchQuery, agentOptions);

      // Transform results to response format
      const results: SearchResultItem[] = ragResult.results.map((result) => ({
        content: result.document.pageContent,
        path: result.document.metadata?.source || result.document.metadata?.documentName || "",
        score: result.score,
        topic: targetTopic.name,
        chunkId: result.document.metadata?.chunkId,
        metadata: result.document.metadata,
      }));

      const response: SearchResponse = {
        query: searchQuery,
        results,
        totalResults: ragResult.metadata.totalResults,
        executionTime: Date.now() - startTime,
        strategy: ragResult.metadata.strategy,
      };

      this.sendJson(res, response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Search error", { error: errorMessage, query: searchQuery });
      this.sendError(res, 500, `Search failed: ${errorMessage}`);
    }
  }

  /**
   * List topics endpoint
   */
  private async handleListTopics(res: http.ServerResponse): Promise<void> {
    if (!this.topicManager) {
      this.sendError(res, 503, "Topic manager not initialized");
      return;
    }

    const topics = this.topicManager.getAllTopics();
    const embeddingModel = this.embeddingService.getCurrentModel();

    const topicInfos: TopicInfo[] = await Promise.all(
      topics.map(async (topic) => {
        let chunkCount: number | undefined;
        try {
          const stats = await this.topicManager?.getTopicStats(topic.id);
          chunkCount = stats?.chunkCount;
        } catch {
          // Ignore stats errors
        }

        return {
          id: topic.id,
          name: topic.name,
          description: topic.description,
          documentCount: topic.documentCount,
          chunkCount,
          createdAt: topic.createdAt,
          updatedAt: topic.updatedAt,
          embeddingModel,
        };
      })
    );

    this.sendJson(res, { topics: topicInfos });
  }

  /**
   * Get single topic endpoint
   */
  private async handleGetTopic(
    res: http.ServerResponse,
    topicName: string
  ): Promise<void> {
    if (!this.topicManager) {
      this.sendError(res, 503, "Topic manager not initialized");
      return;
    }

    const topics = this.topicManager.getAllTopics();
    const topic = topics.find(
      (t) => t.name.toLowerCase() === topicName.toLowerCase()
    );

    if (!topic) {
      this.sendError(res, 404, `Topic not found: ${topicName}`);
      return;
    }

    const embeddingModel = this.embeddingService.getCurrentModel();
    let chunkCount: number | undefined;
    let documents: Array<{ id: string; name: string; path: string; chunkCount: number }> = [];

    try {
      const stats = await this.topicManager.getTopicStats(topic.id);
      chunkCount = stats?.chunkCount;

      const topicDocuments = this.topicManager.getTopicDocuments(topic.id);
      documents = topicDocuments.map((doc) => ({
        id: doc.id,
        name: doc.name,
        path: doc.filePath,
        chunkCount: doc.chunkCount,
      }));
    } catch {
      // Ignore stats errors
    }

    const topicInfo: TopicInfo & { documents?: typeof documents } = {
      id: topic.id,
      name: topic.name,
      description: topic.description,
      documentCount: topic.documentCount,
      chunkCount,
      createdAt: topic.createdAt,
      updatedAt: topic.updatedAt,
      embeddingModel,
      documents,
    };

    this.sendJson(res, topicInfo);
  }

  /**
   * Status endpoint
   */
  private async handleStatus(res: http.ServerResponse): Promise<void> {
    const activeOperations = this.progressTracker.getAllProgress();
    const isPaused = this.progressTracker.isPaused;
    const hasActiveOps = activeOperations.length > 0;

    let status: StatusResponse["status"] = "idle";
    if (isPaused) {
      status = "paused";
    } else if (hasActiveOps) {
      status = "indexing";
    }

    // Get watch status from FileWatcherService
    let watching = false;
    let watchFolders: string[] = [];
    if (this.fileWatcherService) {
      watching = this.fileWatcherService.isWatchingEnabled();
      watchFolders = this.fileWatcherService.getConfiguredWatchFolders();
    }

    const embeddingModel = this.embeddingService.getCurrentModel();
    const totalTopics = this.topicManager?.getAllTopics().length || 0;

    const response: StatusResponse = {
      status,
      watching,
      watchFolders,
      activeOperations,
      embeddingModel,
      totalTopics,
    };

    this.sendJson(res, response);
  }

  /**
   * Send JSON response
   */
  private sendJson(res: http.ServerResponse, data: unknown): void {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send error response
   */
  private sendError(res: http.ServerResponse, code: number, message: string): void {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(code);
    res.end(JSON.stringify({ error: message }));
  }

  /**
   * Clear agent cache for a specific topic
   */
  public clearAgentCache(topicId: string): void {
    this.agentCache.delete(topicId);
  }
}

// Singleton instance
let serverInstance: RestServer | null = null;

/**
 * Get the REST server singleton
 */
export function getRestServer(): RestServer {
  if (!serverInstance) {
    serverInstance = new RestServer();
  }
  return serverInstance;
}

/**
 * Dispose the REST server singleton
 */
export async function disposeRestServer(): Promise<void> {
  if (serverInstance) {
    await serverInstance.stop();
    serverInstance = null;
  }
}
