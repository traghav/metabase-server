#!/usr/bin/env node

// 为老版本 Node.js 添加 AbortController polyfill
import AbortController from 'abort-controller';
global.AbortController = global.AbortController || AbortController;

/**
 * Metabase MCP 服务器
 * 实现与 Metabase API 的交互，提供以下功能：
 * - 获取仪表板列表
 * - 获取问题列表
 * - 获取数据库列表
 * - 执行问题查询
 * - 获取仪表板详情
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequestSchema,
  ListResourcesResult,
  ReadResourceResult,
  ResourceSchema,
  ToolSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios, { AxiosInstance } from "axios";
import {
  MetabaseDatabaseResource,
  MetabaseCollectionResource,
  MetabaseTableResource,
  MetabaseCardResource,
  MetabaseDashboardResource
} from "./metabase-types";

// 自定义错误枚举
enum ErrorCode {
  InternalError = "internal_error",
  InvalidRequest = "invalid_request",
  InvalidParams = "invalid_params",
  MethodNotFound = "method_not_found"
}

// 自定义错误类
class McpError extends Error {
  code: ErrorCode;
  
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "McpError";
  }
}

// 从环境变量获取 Metabase 配置
const METABASE_URL = process.env.METABASE_URL;
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;

if (!METABASE_URL || !METABASE_USERNAME || !METABASE_PASSWORD) {
  throw new Error("METABASE_URL, METABASE_USERNAME, and METABASE_PASSWORD environment variables are required");
}

// 创建自定义 Schema 对象，使用 z.object
const ListResourceTemplatesRequestSchema = z.object({
  method: z.literal("resources/list_templates")
});

const ListToolsRequestSchema = z.object({
  method: z.literal("tools/list")
});

class MetabaseServer {
  private server: Server;
  private axiosInstance: AxiosInstance;
  private sessionToken: string | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "metabase-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: METABASE_URL,
      headers: {
        "Content-Type": "application/json",
      },
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();
    
    // Enhanced error handling with logging
    this.server.onerror = (error: Error) => {
      this.logError('Server Error', error);
    };

    process.on('SIGINT', async () => {
      this.logInfo('Shutting down server...');
      await this.server.close();
      process.exit(0);
    });
  }

  // Add logging utilities
  private logInfo(message: string, data?: unknown) {
    const logMessage = {
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      data
    };
    console.error(JSON.stringify(logMessage));
    // MCP SDK changed, can't directly access session
    try {
      // Use current session if available
      console.error(`INFO: ${message}`);
    } catch (e) {
      // Ignore if session not available
    }
  }

  private logError(message: string, error: unknown) {
    const errorObj = error as Error;
    const apiError = error as { response?: { data?: { message?: string } }, message?: string };
    
    const logMessage = {
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      error: errorObj.message || 'Unknown error',
      stack: errorObj.stack
    };
    console.error(JSON.stringify(logMessage));
    // MCP SDK changed, can't directly access session
    try {
      console.error(`ERROR: ${message} - ${errorObj.message || 'Unknown error'}`);
    } catch (e) {
      // Ignore if session not available
    }
  }

  /**
   * 获取 Metabase 会话令牌
   */
  private async getSessionToken(): Promise<string> {
    if (this.sessionToken) {
      return this.sessionToken;
    }

    this.logInfo('Authenticating with Metabase...');
    try {
      const response = await this.axiosInstance.post('/api/session', {
        username: METABASE_USERNAME,
        password: METABASE_PASSWORD,
      });

      this.sessionToken = response.data.id;
      
      // 设置默认请求头
      this.axiosInstance.defaults.headers.common['X-Metabase-Session'] = this.sessionToken;
      
      this.logInfo('Successfully authenticated with Metabase');
      return this.sessionToken as string;
    } catch (error) {
      this.logError('Authentication failed', error);
      throw new McpError(
        ErrorCode.InternalError,
        'Failed to authenticate with Metabase'
      );
    }
  }

  /**
   * 设置资源处理程序
   */
  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request): Promise<ListResourcesResult> => {
      this.logInfo('Listing resources...', { requestStructure: JSON.stringify(request) });
      await this.getSessionToken();
      const resources: ResourceSchema[] = [];

      try {
        const requestUri = request.params?.uri;

        if (!requestUri || requestUri === "metabase://") {
          // Top-level listing: Databases and Root Collections
          this.logInfo('Fetching top-level resources: databases and root collections');

          // Fetch databases
          const databasesResponse = await this.axiosInstance.get<{ data: MetabaseDatabaseResource[] }>('/api/database');
          databasesResponse.data.data.forEach(db => {
            resources.push({
              uri: `metabase://database/${db.id}`,
              name: db.name,
              icon: 'database', // Assuming 'database' is a valid icon
              // content: undefined, // Not setting content for stubs
            });
          });
          this.logInfo(`Fetched ${databasesResponse.data.data.length} databases`);

          // Fetch collections
          const collectionsResponse = await this.axiosInstance.get<MetabaseCollectionResource[]>('/api/collection');
          collectionsResponse.data.forEach(coll => {
            // Assuming top-level collections are those without a parent_id
            // or those explicitly marked (e.g. personal collections might appear at root)
            // The API for /api/collection might return all, so filter for actual root/top-level ones.
            // A common pattern is `parent_id: null` for true top-level user-created collections.
            // "Root" collection itself often has a special ID or status.
            if (coll.parent_id === null || coll.id === 'root' || (coll.personal_owner_id != null && coll.parent_id == undefined )) {
               resources.push({
                uri: `metabase://collection/${coll.id}`,
                name: coll.name,
                icon: 'folder', // Assuming 'folder' is a valid icon
                // content: undefined,
              });
            }
          });
          this.logInfo(`Fetched ${collectionsResponse.data.length} collections, filtered for top-level`);

        } else if (requestUri.startsWith("metabase://database/")) {
          const dbIdMatch = requestUri.match(/^metabase:\/\/database\/(\d+)(\/schema\/([^/]+))?$/);
          if (dbIdMatch) {
            const dbId = dbIdMatch[1];
            const schemaName = dbIdMatch[3];

            if (schemaName) {
              // Listing tables within a specific schema
              this.logInfo(`Fetching tables for database ${dbId}, schema ${schemaName}`);
              const dbMetadataResponse = await this.axiosInstance.get<{ tables: MetabaseTableResource[] }>(`/api/database/${dbId}/metadata`);
              dbMetadataResponse.data.tables.forEach(table => {
                if (table.schema === schemaName) {
                  resources.push({
                    uri: `metabase://database/${dbId}/table/${table.id}`,
                    name: table.display_name || table.name,
                    icon: 'table',
                  });
                }
              });
              this.logInfo(`Fetched ${resources.length} tables in schema ${schemaName} for database ${dbId}`);

            } else {
              // Listing schemas and tables for a database
              this.logInfo(`Fetching schemas and tables for database ${dbId}`);

              // Fetch Schemas
              // Metabase API for schemas of a specific DB: GET /api/database/:id/schemas
              // This returns a list of schema names (strings)
              const schemasResponse = await this.axiosInstance.get<string[]>(`/api/database/${dbId}/schemas`);
              schemasResponse.data.forEach(schema => {
                // Only add schema if it's not empty or "public" if other schemas exist (to avoid clutter if public is the only one)
                // This logic might need refinement based on how Metabase handles schemas (e.g. always show public, or hide if it's the default and only one)
                if (schema) { // Filter out empty schema names if any
                   resources.push({
                    uri: `metabase://database/${dbId}/schema/${encodeURIComponent(schema)}`,
                    name: schema,
                    icon: 'folder', // Using folder icon for schemas
                  });
                }
              });
              this.logInfo(`Fetched ${schemasResponse.data.length} schemas for database ${dbId}`);
              
              // Fetch Tables (those not in a specific schema, or all if schemas are not strongly enforced at top level)
              // The `/api/database/:id/metadata` endpoint includes tables with their schema info.
              // We can list tables that belong to the "default" schema (often null or "public")
              // or decide if we want to mix tables and schemas at this level.
              // For now, let's list tables that are commonly directly under the DB (e.g. in "public" schema if it's the default)
              // More specific table listings will happen under schema URI.
              const dbMetadataResponse = await this.axiosInstance.get<{ tables: MetabaseTableResource[] }>(`/api/database/${dbId}/metadata`);
              dbMetadataResponse.data.tables.forEach(table => {
                // Heuristic: if schemas are present, only show tables from a "default" or "public" schema at this level.
                // If no schemas or only one "public" schema, show all tables.
                // This avoids duplicating tables shown under specific schema URIs if we also list them here.
                // A simple approach: if no schemas were found, or only one schema (e.g. "public"), list all tables.
                // Otherwise, expect users to navigate into a schema to see its tables.
                // Let's list tables that don't have a schema or are in the "public" schema for now.
                // This might need adjustment based on typical Metabase usage.
                if (!table.schema || table.schema === "public" || schemasResponse.data.length === 0 || (schemasResponse.data.length === 1 && schemasResponse.data[0] === "public")) {
                  resources.push({
                    uri: `metabase://database/${dbId}/table/${table.id}`,
                    name: table.display_name || table.name,
                    icon: 'table',
                  });
                }
              });
               this.logInfo(`Fetched tables (potentially filtered) for database ${dbId}`);
            }
          } else {
            this.logError('Invalid database URI format', { uri: requestUri });
            // Potentially throw error or return empty if format is unexpected
          }
        } else if (requestUri.startsWith("metabase://collection/")) {
          const collIdMatch = requestUri.match(/^metabase:\/\/collection\/([^/]+)$/);
          if (collIdMatch) {
            const collectionIdOrRoot = collIdMatch[1];
            this.logInfo(`Fetching items for collection ${collectionIdOrRoot}`);

            // The /api/collection/:id/items endpoint returns a list of items.
            // Each item has a 'model' field (e.g., 'card', 'dashboard', 'collection').
            const itemsResponse = await this.axiosInstance.get<{ data: any[] }>(`/api/collection/${collectionIdOrRoot}/items`);
            
            itemsResponse.data.data.forEach(item => {
              let resource: ResourceSchema | null = null;
              switch (item.model) {
                case 'card':
                  resource = {
                    uri: `metabase://card/${item.id}`,
                    name: item.name || item.display_name || `Card ${item.id}`,
                    icon: 'card',
                  };
                  break;
                case 'dashboard':
                  resource = {
                    uri: `metabase://dashboard/${item.id}`,
                    name: item.name || item.display_name || `Dashboard ${item.id}`,
                    icon: 'dashboard',
                  };
                  break;
                case 'collection':
                  resource = {
                    uri: `metabase://collection/${item.id}`,
                    name: item.name || `Collection ${item.id}`,
                    icon: 'folder',
                  };
                  break;
                // Other model types like 'dataset' (for models) could be handled here if needed.
                default:
                  this.logInfo(`Unhandled item type in collection ${collectionIdOrRoot}: ${item.model} with id ${item.id}`);
              }
              if (resource) {
                resources.push(resource);
              }
            });
            this.logInfo(`Fetched ${resources.length} items for collection ${collectionIdOrRoot}`);
          } else {
            this.logError('Invalid collection URI format', { uri: requestUri });
          }
        } else {
          this.logError(`Unhandled URI format for listing: ${requestUri}`);
        }
        return { resources };

      } catch (error) {
        this.logError('Failed to list resources', error);
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Metabase API error while listing resources: ${error.response?.data?.message || error.message}`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          'Failed to list Metabase resources'
        );
      }
    });

    // 资源模板
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: [
          {
            uriTemplate: 'metabase://dashboard/{id}',
            name: 'Dashboard by ID',
            mimeType: 'application/json',
            description: 'Get a Metabase dashboard by its ID',
          },
          {
            uriTemplate: 'metabase://card/{id}',
            name: 'Card by ID',
            mimeType: 'application/json',
            description: 'Get a Metabase question/card by its ID',
          },
          {
            uriTemplate: 'metabase://database/{id}',
            name: 'Database by ID',
            mimeType: 'application/json',
            description: 'Get a Metabase database by its ID',
          },
          {
            name: "Metabase Table by ID",
            description: "Access a specific Metabase table by its database and table ID.",
            uri_template: "metabase://database/{database_id}/table/{table_id}",
            parameters: [
              { name: "database_id", description: "ID of the database", type: "number" },
              { name: "table_id", description: "ID of the table", type: "number" }
            ]
          },
          {
            name: "Metabase Collection by ID",
            description: "Access a specific Metabase collection by its ID.",
            uri_template: "metabase://collection/{collection_id}",
            parameters: [
              { name: "collection_id", description: "ID of the collection (or 'root')", type: "string" }
            ]
          }
        ],
      };
    });

    // 读取资源
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
      this.logInfo('Reading resource...', { requestStructure: JSON.stringify(request) });
      await this.getSessionToken();

      const uri = request.params?.uri;
      if (!uri) {
        throw new McpError(ErrorCode.InvalidParams, "URI is required for reading a resource.");
      }
      let match;

      try {
        // 处理仪表板资源
        if ((match = uri.match(/^metabase:\/\/dashboard\/(\d+)$/))) {
          const dashboardId = match[1];
          this.logInfo(`Reading dashboard ${dashboardId}`);
          const response = await this.axiosInstance.get<MetabaseDashboardResource>(`/api/dashboard/${dashboardId}`);
          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              content: response.data,
            }]
          };
        }
        // 处理问题/卡片资源
        else if ((match = uri.match(/^metabase:\/\/card\/(\d+)$/))) {
          const cardId = match[1];
          this.logInfo(`Reading card ${cardId}`);
          const response = await this.axiosInstance.get<MetabaseCardResource>(`/api/card/${cardId}`);
          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              content: response.data,
            }]
          };
        }
        // 处理数据库资源
        else if ((match = uri.match(/^metabase:\/\/database\/(\d+)$/))) {
          const databaseId = match[1];
          this.logInfo(`Reading database ${databaseId}`);
          const dbDetailsResponse = await this.axiosInstance.get<MetabaseDatabaseResource>(`/api/database/${databaseId}`);
          const dbMetadataResponse = await this.axiosInstance.get<{ tables: MetabaseTableResource[] }>(`/api/database/${databaseId}/metadata`);
          
          const databaseResource: MetabaseDatabaseResource = {
            ...dbDetailsResponse.data,
            tables: dbMetadataResponse.data.tables.map(table => ({
              ...table,
              uri: `metabase://database/${databaseId}/table/${table.id}`, // Add URI to table
              // Fields might be stubs here, or need another call if full field detail is required at this level
            })),
          };
          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              content: databaseResource,
            }]
          };
        }
        // Handle Collection Resource
        else if ((match = uri.match(/^metabase:\/\/collection\/([^/]+)$/))) {
          const collectionIdOrRoot = match[1];
          this.logInfo(`Reading collection ${collectionIdOrRoot}`);
          const response = await this.axiosInstance.get<MetabaseCollectionResource>(`/api/collection/${collectionIdOrRoot}`);
          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              content: response.data,
            }]
          };
        }
        // Handle Table Resource
        else if ((match = uri.match(/^metabase:\/\/database\/(\d+)\/table\/(card__\d+|\d+)$/))) {
          const dbId = match[1]; // Though not always directly used in /api/table/:id calls, good for context
          const tableId = match[2];
          this.logInfo(`Reading table ${tableId} from database ${dbId}`);

          let tableMetadataUrl: string;
          if (tableId.startsWith("card__")) {
            // Model based on a card. The ID for the API is just the numeric part.
            const modelId = tableId.substring("card__".length);
            // Note: The API endpoint for models might differ or require specific handling.
            // Assuming models (datasets) can be queried via a table-like interface if they have an ID.
            // The prompt mentions /api/table/card__:{card_id}/query_metadata, let's adapt.
            // However, the standard way to get metadata for a model (dataset) is often through /api/card/:id if it's card-based
            // or if it's a persisted model, it might appear under /api/dataset or have a specific table ID.
            // For simplicity, if we have a `card__<ID>` type of table, it's likely a model.
            // Fetching its definition from /api/card/<ID> and then using its result_metadata might be more accurate.
            // Or, if Metabase exposes a direct /api/table/card__<ID> endpoint for metadata, that's fine.
            // The prompt suggests /api/table/{table_id}/query_metadata, let's try with that structure.
            // This part might need verification against Metabase API docs for models.
            // A safer bet for a model is to fetch the card and use its `result_metadata`.
            // Let's assume for now that `tableId` for a model is just its card ID for the purpose of getting metadata.
            // This is a complex area due to Metabase's flexible model definitions.
            // A simple approach: if it's card__, fetch the card and extract metadata.
            this.logInfo(`Reading model (dataset) ${tableId}`);
            const cardResponse = await this.axiosInstance.get<MetabaseCardResource>(`/api/card/${tableId.substring("card__".length)}`);
            const cardData = cardResponse.data;
            if (!cardData.result_metadata) {
               throw new McpError(ErrorCode.NotFound, `Result metadata not found for model ${tableId}`);
            }
            const tableResource: MetabaseTableResource = {
              uri: uri,
              id: tableId, // Keep the card__<ID> format for the resource ID
              name: cardData.name,
              display_name: cardData.name,
              db_id: parseInt(dbId), // This might be tricky as models don't belong to a DB in the same way tables do.
              fields: cardData.result_metadata, // Use the result_metadata from the card
              description: cardData.description,
              entity_type: 'model', // Custom field to denote it's a model
            };
             return { contents: [{ uri: uri, mimeType: "application/json", content: tableResource }] };

          } else {
            // Regular table
            tableMetadataUrl = `/api/table/${tableId}/query_metadata`;
            const response = await this.axiosInstance.get<MetabaseTableResource>(tableMetadataUrl);
            const tableResource: MetabaseTableResource = {
              ...response.data,
              uri: uri, // Ensure URI is part of the resource
              db_id: parseInt(dbId), // Ensure db_id is set from URI
            };
            return {
              contents: [{
                uri: uri,
                mimeType: "application/json",
                content: tableResource,
              }]
            };
          }
        }
        // Handle Schema Resource
        else if ((match = uri.match(/^metabase:\/\/database\/(\d+)\/schema\/([^/]+)$/))) {
          const dbId = match[1];
          const schemaName = decodeURIComponent(match[2]);
          this.logInfo(`Reading schema "${schemaName}" from database ${dbId}`);

          const dbMetadataResponse = await this.axiosInstance.get<{ tables: MetabaseTableResource[] }>(`/api/database/${dbId}/metadata`);
          const tablesInSchema = dbMetadataResponse.data.tables
            .filter(table => table.schema === schemaName)
            .map(table => ({
              ...table,
              uri: `metabase://database/${dbId}/table/${table.id}`, // Add URI to table stub
            }));
          
          const schemaResource = { // Define a simple structure for schema resource
            uri: uri,
            name: schemaName,
            db_id: parseInt(dbId),
            tables: tablesInSchema,
          };

          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              content: schemaResource,
            }]
          };
        } else {
          this.logError(`Invalid or unsupported URI format for ReadResource: ${uri}`);
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid or unsupported URI format: ${uri}`
          );
        }
      } catch (error) {
        this.logError('Failed to read resource', { uri, error });
        if (axios.isAxiosError(error)) {
          if (error.response?.status === 404) {
            throw new McpError(ErrorCode.NotFound, `Resource not found at URI: ${uri}`);
          }
          throw new McpError(
            ErrorCode.InternalError,
            `Metabase API error while reading resource ${uri}: ${error.response?.data?.message || error.message}`
          );
        }
        throw error; // Rethrow other errors (e.g., McpError)
      }
    });
  }

  /**
   * 设置工具处理程序
   */
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "list_dashboards",
            description: "List Metabase dashboards. Can be filtered.",
            inputSchema: {
              type: "object",
              properties: {
                collection_id: { type: "number", description: "Filter by collection ID" },
                archived: { type: "boolean", description: "Filter by archived status (e.g. true to list archived dashboards)" }
              }
            }
          },
          {
            name: "list_cards",
            description: "List Metabase cards (questions/models). Can be filtered.",
            inputSchema: {
              type: "object",
              properties: {
                collection_id: { type: "number", description: "Filter by collection ID" },
                archived: { type: "boolean", description: "Filter by archived status" },
                f: { type: "string", description: "Filter type (e.g., 'archived', 'mine', 'popular', 'table_id')" } // `table_id` can be passed via `f` or a dedicated param
              }
            }
          },
          {
            name: "list_databases",
            description: "List Metabase databases. Can be filtered.",
            inputSchema: {
              type: "object",
              properties: {
                include_tables: { type: "boolean", description: "Include tables for each database" },
                include_cards: { type: "boolean", description: "Include cards (questions/models) related to each database" }
              }
            }
          },
          {
            name: "execute_card",
            description: "Execute a Metabase question/card and get results",
            inputSchema: {
              type: "object",
              properties: {
                card_id: {
                  type: "number",
                  description: "ID of the card/question to execute"
                },
                parameters: {
                  type: "array",
                  description: "Parameters for the card query",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", description: "Parameter type (e.g., 'category', 'date/single')" },
                      target: { type: "array", description: "Target field/dimension for the parameter" },
                      value: { "type": ["string", "number", "array", "boolean"], "description": "Value of the parameter" }, // Changed to allow multiple types
                      id: { type: "string", description: "Parameter ID (optional, sometimes needed)" },
                      slug: { type: "string", description: "Parameter slug (optional, sometimes needed)" }
                    },
                    required: ["type", "target", "value"]
                  }
                }
              },
              required: ["card_id"]
            }
          },
          {
            name: "get_dashboard_details",
            description: "Get full details for a specific dashboard, including its dashcards and parameters.",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: {
                  type: "number",
                  description: "ID of the dashboard"
                }
              },
              required: ["dashboard_id"]
            }
          },
          {
            name: "execute_query", // This is the SQL version
            description: "Execute a SQL query against a specified database.",
            inputSchema: {
              type: "object",
              properties: {
                database_id: {
                  type: "number",
                  description: "ID of the database to query"
                },
                query: {
                  type: "string",
                  description: "The SQL query string to execute."
                },
                template_tags: {
                  type: "object",
                  description: "An object of template tags to substitute in the native SQL query (e.g., {\"tag_name\": \"value\"}).",
                  additionalProperties: { type: "string" }
                }
              },
              required: ["database_id", "query"]
            }
          },
          // CRUD tools are mostly fine, just ensuring they are present.
          // Descriptions and inputSchemas for CRUD tools will be reviewed if needed, but the prompt mainly focuses on new tools and updates to existing list/execute tools.
          {
            name: "create_card",
            description: "Create a new Metabase question (card).",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name of the card" },
                dataset_query: { type: "object", description: "The query for the card (e.g., MBQL or native query)" },
                display: { type: "string", description: "Display type (e.g., 'table', 'line', 'bar')" },
                visualization_settings: { type: "object", description: "Settings for the visualization" },
                collection_id: { type: "number", description: "Optional ID of the collection to save the card in" },
                description: { type: "string", description: "Optional description for the card" }
              },
              required: ["name", "dataset_query", "display", "visualization_settings"]
            }
          },
          {
            name: "update_card",
            description: "Update an existing Metabase question (card).",
            inputSchema: {
              type: "object",
              properties: {
                card_id: { type: "number", description: "ID of the card to update" },
                name: { type: "string", description: "New name for the card" },
                dataset_query: { type: "object", description: "New query for the card" },
                display: { type: "string", description: "New display type" },
                visualization_settings: { type: "object", description: "New visualization settings" },
                collection_id: { type: "number", description: "New collection ID" },
                description: { type: "string", description: "New description" },
                archived: { type: "boolean", description: "Set to true to archive the card" }
              },
              required: ["card_id"]
            }
          },
          {
            name: "delete_card",
            description: "Delete a Metabase question (card).",
            inputSchema: {
              type: "object",
              properties: {
                card_id: { type: "number", description: "ID of the card to delete" },
                hard_delete: { type: "boolean", description: "Set to true for hard delete, false (default) for archive", default: false }
              },
              required: ["card_id"]
            }
          },
          {
            name: "create_dashboard",
            description: "Create a new Metabase dashboard.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name of the dashboard" },
                description: { type: "string", description: "Optional description for the dashboard" },
                parameters: { type: "array", description: "Optional parameters for the dashboard", items: { type: "object" } },
                collection_id: { type: "number", description: "Optional ID of the collection to save the dashboard in" }
              },
              required: ["name"]
            }
          },
          {
            name: "update_dashboard",
            description: "Update an existing Metabase dashboard.",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: { type: "number", description: "ID of the dashboard to update" },
                name: { type: "string", description: "New name for the dashboard" },
                description: { type: "string", description: "New description for the dashboard" },
                parameters: { type: "array", description: "New parameters for the dashboard", items: { type: "object" } },
                collection_id: { type: "number", description: "New collection ID" },
                archived: { type: "boolean", description: "Set to true to archive the dashboard" }
              },
              required: ["dashboard_id"]
            }
          },
          {
            name: "delete_dashboard",
            description: "Delete a Metabase dashboard.",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: { type: "number", description: "ID of the dashboard to delete" },
                hard_delete: { type: "boolean", description: "Set to true for hard delete, false (default) for archive", default: false }
              },
              required: ["dashboard_id"]
            }
          },
          // New Tool Definitions
          {
            name: "get_database_details",
            description: "Get detailed information about a specific database, including its tables and metadata.",
            inputSchema: {
              type: "object",
              properties: {
                database_id: { type: "number", description: "ID of the database" },
                include_tables: { type: "boolean", description: "Set to true to include detailed table metadata (default: false)" },
                include_fields: { type: "boolean", description: "Set to true to include detailed field metadata for tables (default: false)" }
              },
              required: ["database_id"]
            }
          },
          {
            name: "list_database_schemas",
            description: "List all schemas within a specific database.",
            inputSchema: {
              type: "object",
              properties: {
                database_id: { type: "number", description: "ID of the database" }
              },
              required: ["database_id"]
            }
          },
          {
            name: "list_tables_in_schema",
            description: "List all tables within a specific schema of a database.",
            inputSchema: {
              type: "object",
              properties: {
                database_id: { type: "number", description: "ID of the database" },
                schema_name: { type: "string", description: "Name of the schema" }
              },
              required: ["database_id", "schema_name"]
            }
          },
          {
            name: "get_table_details",
            description: "Get detailed metadata for a specific table or a card-based model.",
            inputSchema: {
              type: "object",
              properties: {
                table_id: { type: "number", description: "ID of the table (use for regular tables)" },
                card_model_id: { type: "number", description: "ID of the card that represents a model (use for card-based models)" },
                include_fields: { type: "boolean", description: "Set to true to include detailed field metadata (default: true)" }
              },
              // Note: Actual logic for ensuring only one of table_id or card_model_id is provided will be in CallTool handler
            }
          },
          {
            name: "get_field_distinct_values",
            description: "Get distinct values for a specific field, often used for parameter value population.",
            inputSchema: {
              type: "object",
              properties: {
                field_id: { type: "number", description: "ID of the field" },
                // Add other relevant parameters if the API supports them, e.g., search term, limit
              },
              required: ["field_id"]
            }
          },
          {
            name: "list_collections",
            description: "List Metabase collections. Can filter by parent collection or archived status.",
            inputSchema: {
              type: "object",
              properties: {
                parent_collection_id: { type: "number", description: "Filter by parent collection ID" },
                archived: { type: "boolean", description: "Filter by archived status (e.g. true to list archived collections)" }
              }
            }
          },
          {
            name: "list_collection_items",
            description: "List items (cards, dashboards, sub-collections) within a specific Metabase collection.",
            inputSchema: {
              type: "object",
              properties: {
                collection_id: { type: "string", description: "ID of the collection (use 'root' for the root collection)" },
                models: { type: "array", items: { type: "string" }, description: "Filter by model types (e.g., ['card', 'dashboard', 'collection'])" },
                archived: { type: "boolean", description: "Filter by archived status" }
              },
              required: ["collection_id"]
            }
          },
          {
            name: "get_card_query_metadata",
            description: "Get the query metadata for a specific card (question/model), often to understand its parameters or output columns.",
            inputSchema: {
              type: "object",
              properties: {
                card_id: { type: "number", description: "ID of the card" }
              },
              required: ["card_id"]
            }
          },
          {
            name: "execute_dashboard_card_query",
            description: "Execute a query for a card that is part of a dashboard, applying dashboard parameters.",
            inputSchema: {
              type: "object",
              properties: {
                dashboard_id: { type: "number", description: "ID of the dashboard" },
                dashcard_id: { type: "number", description: "ID of the dashboard card (dashcard)" },
                card_id: { type: "number", description: "ID of the underlying card (question/model)" },
                parameters: {
                  type: "array",
                  description: "Dashboard parameters to apply to the card query. Structure similar to execute_card parameters.",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      target: { type: "array" },
                      value: { "type": ["string", "number", "array", "boolean"] },
                      id: { type: "string" },
                      slug: { type: "string" }
                    },
                    required: ["type", "target", "value"]
                  }
                }
              },
              required: ["dashboard_id", "dashcard_id", "card_id"]
            }
          },
          {
            name: "execute_mbql_query",
            description: "Execute a query defined using Metabase Query Language (MBQL).",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "object", description: "The MBQL query object." },
                parameters: {
                    type: "array",
                    description: "Parameters for the MBQL query, if any.",
                    items: {
                        type: "object",
                        properties: {
                           type: { type: "string" },
                           target: { type: "array" },
                           value: { "type": ["string", "number", "array", "boolean"] }
                        },
                        required: ["type", "target", "value"]
                    }
                }
              },
              required: ["query"]
            }
          },
          {
            name: "export_query_results",
            description: "Export results of a query (card or ad-hoc) in various formats.",
            inputSchema: {
              type: "object",
              properties: {
                query_type: { type: "string", enum: ["card", "native", "mbql"], description: "Type of query to export" },
                export_format: { type: "string", enum: ["csv", "xlsx", "json", "json_api"], description: "Format for the export" },
                card_id: { type: "number", description: "ID of the card (if query_type is 'card')" },
                native_query_details: {
                  type: "object",
                  properties: {
                    database_id: { type: "number" },
                    query: { type: "string" },
                    template_tags: { type: "object", additionalProperties: { type: "string" } }
                  },
                  description: "Details for native SQL query (if query_type is 'native')"
                },
                mbql_query_details: {
                  type: "object",
                  properties: {
                    query: { type: "object" }
                    // Potentially add database_id if MBQL queries can target different DBs than default
                  },
                  description: "Details for MBQL query (if query_type is 'mbql')"
                },
                parameters: { type: "array", description: "Parameters for the query (if applicable for card or MBQL)" }
              },
              required: ["query_type", "export_format"]
              // Conditional requirements (e.g., card_id if query_type is card) handled in CallTool
            }
          },
          {
            name: "get_parameter_values",
            description: "Fetches possible values for a parameter, often used for populating filter dropdowns.",
            inputSchema: {
              type: "object",
              properties: {
                context_type: { type: "string", enum: ["card", "dashboard", "parameter"], description: "Context from which parameter values are being requested." },
                context_id: { type: ["number", "string"], description: "ID of the card, dashboard, or parameter definition." },
                parameter_id_or_slug: { type: "string", description: "ID or slug of the parameter whose values are needed." },
                query: { type: "string", description: "Search term to filter parameter values." },
                constrained_parameters: {
                  type: "array",
                  description: "Values of other parameters that might constrain the values of this parameter.",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, value: { "type": ["string", "number", "array", "boolean"] } }
                  }
                }
              },
              required: ["context_type", "context_id", "parameter_id_or_slug"]
            }
          }
          // Existing CRUD tools (create_card, update_card, etc.) are assumed to be correctly defined as per previous steps / existing code.
          // The prompt focused on ensuring they are covered by the tool listing, which they are.
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logInfo('Calling tool...', { requestStructure: JSON.stringify(request) });
      await this.getSessionToken();

      try {
        const toolName = request.params?.name;
        const args = request.params?.arguments || {};

        switch (toolName) {
          case "list_dashboards": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { collection_id, archived } = args;
            const queryParams: Record<string, any> = {};
            if (collection_id !== undefined) queryParams.collection_id = collection_id;
            if (archived !== undefined) queryParams.archived = archived;

            const response = await this.axiosInstance.get<MetabaseDashboardResource[]>('/api/dashboard', { params: queryParams });
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "list_cards": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { collection_id, archived, f } = args;
            const queryParams: Record<string, any> = {};
            if (collection_id !== undefined) queryParams.collection_id = collection_id;
            if (archived !== undefined) queryParams.archived = archived;
            if (f !== undefined) queryParams.f = f;

            const response = await this.axiosInstance.get<MetabaseCardResource[]>('/api/card', { params: queryParams });
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "list_databases": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { include_tables, include_cards } = args; // These params might not be directly supported by /api/database itself for filtering
                                                        // but are for response shaping if we were to make subsequent calls.
                                                        // For now, we pass them if the API supports them, otherwise they are for future enhancement.
            const queryParams: Record<string, any> = {};
            if (include_tables !== undefined) queryParams.include_tables = include_tables;
            if (include_cards !== undefined) queryParams.include_cards = include_cards;


            const response = await this.axiosInstance.get<{data: MetabaseDatabaseResource[]}>('/api/database', { params: queryParams });
            return {
              toolName,
              // The /api/database endpoint returns an object with a 'data' key containing the array of databases.
              content: [{ type: "application/json", content: response.data.data }]
            };
          }

          case "execute_card": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { card_id, parameters } = args;
            if (!card_id) {
              throw new McpError(ErrorCode.InvalidParams, "Card ID is required for execute_card");
            }

            const response = await this.axiosInstance.post(`/api/card/${card_id}/query`, { parameters: parameters || [] });
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "get_dashboard_details": { // Renamed from get_dashboard_cards
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { dashboard_id } = args;
            if (!dashboard_id) {
              throw new McpError(ErrorCode.InvalidParams, "Dashboard ID is required for get_dashboard_details");
            }

            const response = await this.axiosInstance.get<MetabaseDashboardResource>(`/api/dashboard/${dashboard_id}`);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }
          
          case "execute_query": { // For SQL
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { database_id, query, template_tags } = args;
            
            if (!database_id) {
              throw new McpError(ErrorCode.InvalidParams, "Database ID is required for execute_query");
            }
            if (!query) {
              throw new McpError(ErrorCode.InvalidParams, "Query string is required for execute_query");
            }
            
            const payload = {
              database: database_id,
              type: "native",
              native: {
                query: query,
                template_tags: template_tags || {},
              },
            };
            
            const response = await this.axiosInstance.post('/api/dataset', payload);
            // Assuming response.data is already in MetabaseQueryResult structure or compatible
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "create_card": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { name, dataset_query, display, visualization_settings, collection_id, description } = args;
            if (!name || !dataset_query || !display || !visualization_settings) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Missing required fields for create_card: name, dataset_query, display, visualization_settings"
              );
            }
            const createCardBody = { name, dataset_query, display, visualization_settings, collection_id, description };

            const response = await this.axiosInstance.post<MetabaseCardResource>('/api/card', createCardBody);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "update_card": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { card_id, ...updateFields } = args;
            if (!card_id) {
              throw new McpError(ErrorCode.InvalidParams, "Card ID is required for update_card");
            }
            if (Object.keys(updateFields).length === 0) {
              throw new McpError(ErrorCode.InvalidParams, "No fields provided for update_card");
            }
            const response = await this.axiosInstance.put<MetabaseCardResource>(`/api/card/${card_id}`, updateFields);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "delete_card": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { card_id, hard_delete = false } = args;
            if (!card_id) {
              throw new McpError(ErrorCode.InvalidParams, "Card ID is required for delete_card");
            }

            if (hard_delete) {
              await this.axiosInstance.delete(`/api/card/${card_id}`);
              return {
                toolName,
                content: [{ type: "application/json", content: { message: `Card ${card_id} permanently deleted.` } }]
              };
            } else {
              const response = await this.axiosInstance.put<MetabaseCardResource>(`/api/card/${card_id}`, { archived: true });
              return {
                toolName,
                content: [{ type: "application/json", content: response.data }]
              };
            }
          }

          case "create_dashboard": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { name, description, parameters, collection_id } = args;
            if (!name) {
              throw new McpError(ErrorCode.InvalidParams, "Name is required for create_dashboard");
            }
            const createDashboardBody = { name, description, parameters, collection_id };

            const response = await this.axiosInstance.post<MetabaseDashboardResource>('/api/dashboard', createDashboardBody);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "update_dashboard": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { dashboard_id, ...updateFields } = args;
            if (!dashboard_id) {
              throw new McpError(ErrorCode.InvalidParams, "Dashboard ID is required for update_dashboard");
            }
            if (Object.keys(updateFields).length === 0) {
              throw new McpError(ErrorCode.InvalidParams, "No fields provided for update_dashboard");
            }
            const response = await this.axiosInstance.put<MetabaseDashboardResource>(`/api/dashboard/${dashboard_id}`, updateFields);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "delete_dashboard": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { dashboard_id, hard_delete = false } = args;
            if (!dashboard_id) {
              throw new McpError(ErrorCode.InvalidParams, "Dashboard ID is required for delete_dashboard");
            }

            if (hard_delete) {
              await this.axiosInstance.delete(`/api/dashboard/${dashboard_id}`);
              return {
                toolName,
                content: [{ type: "application/json", content: { message: `Dashboard ${dashboard_id} permanently deleted.` } }]
              };
            } else {
              const response = await this.axiosInstance.put<MetabaseDashboardResource>(`/api/dashboard/${dashboard_id}`, { archived: true });
              return {
                toolName,
                content: [{ type: "application/json", content: response.data }]
              };
            }
          }
          
          case "get_database_details": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { database_id, include_tables = false, include_fields = false } = args;
            if (!database_id) {
              throw new McpError(ErrorCode.InvalidParams, "Database ID is required for get_database_details");
            }

            const dbDetailsResponse = await this.axiosInstance.get<MetabaseDatabaseResource>(`/api/database/${database_id}`);
            let tables: MetabaseTableResource[] | undefined = undefined;

            if (include_tables || include_fields) {
              const dbMetadataResponse = await this.axiosInstance.get<{ tables: MetabaseTableResource[] }>(`/api/database/${database_id}/metadata`);
              tables = dbMetadataResponse.data.tables.map(table => ({
                ...table,
                uri: `metabase://database/${database_id}/table/${table.id}`,
                fields: include_fields ? table.fields : undefined, // Only include fields if requested
              }));
            }
            
            const databaseResource: MetabaseDatabaseResource = {
              ...dbDetailsResponse.data,
              tables: tables || dbDetailsResponse.data.tables, // Use fetched tables if available, else whatever dbDetails had
            };
            return {
              toolName,
              content: [{ type: "application/json", content: databaseResource }]
            };
          }

          case "list_database_schemas": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { database_id } = args;
            if (!database_id) {
              throw new McpError(ErrorCode.InvalidParams, "Database ID is required for list_database_schemas");
            }
            const response = await this.axiosInstance.get<string[]>(`/api/database/${database_id}/schemas`);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "list_tables_in_schema": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { database_id, schema_name } = args;
            if (!database_id || !schema_name) {
              throw new McpError(ErrorCode.InvalidParams, "Database ID and Schema Name are required for list_tables_in_schema");
            }
            const dbMetadataResponse = await this.axiosInstance.get<{ tables: MetabaseTableResource[] }>(`/api/database/${database_id}/metadata`);
            const tablesInSchema = dbMetadataResponse.data.tables
              .filter(table => table.schema === schema_name)
              .map(table => ({ // Return stubs
                uri: `metabase://database/${database_id}/table/${table.id}`,
                id: table.id,
                name: table.name,
                display_name: table.display_name,
                db_id: database_id, // Ensure db_id is part of the stub
                schema: table.schema,
              }));
            return {
              toolName,
              content: [{ type: "application/json", content: tablesInSchema }]
            };
          }

          case "get_table_details": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { table_id, card_model_id, include_fields = true } = args;

            if (!table_id && !card_model_id) {
              throw new McpError(ErrorCode.InvalidParams, "Either table_id or card_model_id is required for get_table_details");
            }
            if (table_id && card_model_id) {
              throw new McpError(ErrorCode.InvalidParams, "Provide either table_id or card_model_id, not both, for get_table_details");
            }

            let tableResource: MetabaseTableResource;

            if (card_model_id) {
              const modelId = card_model_id; // This is numeric as per schema
              this.logInfo(`Fetching details for model (card) ${modelId}`);
              const cardResponse = await this.axiosInstance.get<MetabaseCardResource>(`/api/card/${modelId}`);
              const cardData = cardResponse.data;
              if (!cardData.result_metadata && include_fields) { // Models might not have result_metadata if not successfully run/setup
                 this.logInfo(`Result metadata not found for model ${modelId}, fields will be empty.`);
              }
              // Construct a TableResource-like object from card data
              tableResource = {
                uri: `metabase://model/card__${modelId}`, // Or `metabase://database/{db_id}/table/card__${modelId}` if db_id is known/relevant
                id: `card__${modelId}`,
                name: cardData.name,
                display_name: cardData.display_name || cardData.name,
                db_id: cardData.database_id || 0, // Model might not have a direct db_id in the same way a table does.
                fields: include_fields ? (cardData.result_metadata || []) : [],
                description: cardData.description,
                entity_type: 'model',
                fks: [], // Models don't typically have FKs in the same way as DB tables
                schema_name: undefined, // Models don't have a schema in the DB sense
              };
            } else {
              this.logInfo(`Fetching details for table ${table_id}`);
              // For regular tables, /api/table/:id/query_metadata is preferred for detailed field info
              // However, the prompt also mentions /api/table/:id. Let's use query_metadata for more detail.
              // The base /api/table/:id gives some info but /query_metadata often gives more on fields.
              // Let's assume we want the most detailed view, so /api/table/:id and then merge fields from /query_metadata if needed,
              // or just use /api/table/:id if it's sufficient.
              // The ReadResource handler uses /api/table/:id/query_metadata. Let's be consistent.
              const tableDetailsResponse = await this.axiosInstance.get<MetabaseTableResource>(`/api/table/${table_id}/query_metadata`);
              tableResource = {
                ...tableDetailsResponse.data,
                uri: `metabase://database/${tableDetailsResponse.data.db_id}/table/${table_id}`, // Construct URI
                fields: include_fields ? tableDetailsResponse.data.fields : [],
              };
            }
            return {
              toolName,
              content: [{ type: "application/json", content: tableResource }]
            };
          }

          case "get_field_distinct_values": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { field_id } = args;
            if (!field_id) {
              throw new McpError(ErrorCode.InvalidParams, "Field ID is required for get_field_distinct_values");
            }
            // The API endpoint is GET /api/field/:id/values
            const response = await this.axiosInstance.get(`/api/field/${field_id}/values`);
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }] // response.data structure: [[value], [value], ...] and special_values
            };
          }

          case "list_collections": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { parent_collection_id, archived } = args;
            const queryParams: Record<string, any> = {};
            if (parent_collection_id !== undefined) queryParams.parent_id = parent_collection_id;
            if (archived !== undefined) queryParams.archived = archived;
            
            const response = await this.axiosInstance.get<MetabaseCollectionResource[]>('/api/collection', { params: queryParams });
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "list_collection_items": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { collection_id, models, archived } = args;
            if (!collection_id) {
              throw new McpError(ErrorCode.InvalidParams, "Collection ID is required for list_collection_items");
            }
            const queryParams: Record<string, any> = {};
            if (models && Array.isArray(models) && models.length > 0) {
              // Metabase API expects multiple 'model' query params, e.g., model=card&model=dashboard
              queryParams.model = models; 
            }
            if (archived !== undefined) queryParams.archived = archived;

            const response = await this.axiosInstance.get<{ data: any[], total: number, limit: number, offset: number }>(
              `/api/collection/${collection_id}/items`, { params: queryParams }
            );
            // Map items to their respective resource types if possible (stubs)
            const items = response.data.data.map(item => {
              const baseResource = {
                uri: `metabase://${item.model}/${item.id}`, // Generic URI
                id: item.id,
                name: item.name || item.display_name || `${item.model} ${item.id}`,
                // Add other common fields if available like description, archived status
              };
              switch (item.model) {
                case 'card': return { ...baseResource, icon: 'card' } as MetabaseCardResource; // Cast as stub
                case 'dashboard': return { ...baseResource, icon: 'dashboard' } as MetabaseDashboardResource; // Cast as stub
                case 'collection': return { ...baseResource, icon: 'folder' } as MetabaseCollectionResource; // Cast as stub
                default: return { ...baseResource, model_type: item.model, icon: 'file' }; // Generic resource for unknown types
              }
            });
            return {
              toolName,
              content: [{ type: "application/json", content: items }]
            };
          }

          case "get_card_query_metadata": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { card_id } = args;
            if (!card_id) {
              throw new McpError(ErrorCode.InvalidParams, "Card ID is required for get_card_query_metadata");
            }
            // Option 1: Get full card and extract (as per initial thought)
            // const cardResponse = await this.axiosInstance.get<MetabaseCardResource>(`/api/card/${card_id}`);
            // const { dataset_query, result_metadata, parameters } = cardResponse.data;
            // return { toolName, content: [{ type: "application/json", content: { dataset_query, result_metadata, parameters } }] };
            
            // Option 2: Use /api/card/:id/query_metadata if it's more direct (as per prompt refinement)
            // This endpoint might not exist or might return something different than full card's metadata sections.
            // Let's try to fetch the full card and return its relevant metadata parts, which is safer.
            // If a dedicated endpoint /api/card/:id/query_metadata is confirmed to be better, we can switch.
            // For now, fetching the card gives us dataset_query, result_metadata, and parameters.
            const cardResponse = await this.axiosInstance.get<MetabaseCardResource>(`/api/card/${card_id}`);
            const cardData = cardResponse.data;
            const queryMetadata = {
              dataset_query: cardData.dataset_query,
              result_metadata: cardData.result_metadata,
              parameters: cardData.parameters, // Parameters defined on the card
              // Include other relevant fields if necessary, e.g., cardData.id, cardData.name
            };
            return {
              toolName,
              content: [{ type: "application/json", content: queryMetadata }]
            };
          }
          
          case "execute_dashboard_card_query": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { dashboard_id, dashcard_id, card_id, parameters } = args;
            if (!dashboard_id || !dashcard_id || !card_id) {
              throw new McpError(ErrorCode.InvalidParams, "dashboard_id, dashcard_id, and card_id are required.");
            }
            const payload: { parameters?: any } = {};
            if (parameters) {
              payload.parameters = parameters;
            }
            const response = await this.axiosInstance.post(
              `/api/dashboard/${dashboard_id}/dashcard/${dashcard_id}/card/${card_id}/query`,
              payload
            );
            // Assuming response.data is MetabaseQueryResult or compatible
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "execute_mbql_query": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            // database_id is part of the MBQL query object itself, not a separate top-level param for /api/dataset
            const { query, parameters, ignore_cache } = args; 
            if (!query || !query.database) { // query.database is the database_id for MBQL
              throw new McpError(ErrorCode.InvalidParams, "MBQL query object with a 'database' ID is required.");
            }

            const payload: Record<string, any> = {
              database: query.database, // This comes from the query object
              type: "query", // Indicates an MBQL query
              query: query, // The main MBQL query structure
            };
            if (parameters) payload.parameters = parameters;
            if (ignore_cache !== undefined) payload.ignore_cache = ignore_cache;
            
            const response = await this.axiosInstance.post('/api/dataset', payload);
            // Assuming response.data is MetabaseQueryResult or compatible
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          case "export_query_results": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { query_type, export_format, card_id, native_query_details, mbql_query_details, parameters } = args;

            if (!query_type || !export_format) {
              throw new McpError(ErrorCode.InvalidParams, "query_type and export_format are required.");
            }

            let apiUrl: string;
            let requestBody: any = {};
            let method: 'get' | 'post' = 'post'; // Most export endpoints are POST

            switch (query_type) {
              case "card":
                if (!card_id) throw new McpError(ErrorCode.InvalidParams, "card_id is required for query_type 'card'.");
                apiUrl = `/api/card/${card_id}/query/${export_format}`;
                if (parameters) requestBody.parameters = parameters; // Metabase expects parameters in body for card query exports
                break;
              case "native":
                if (!native_query_details || !native_query_details.database_id || !native_query_details.query) {
                  throw new McpError(ErrorCode.InvalidParams, "native_query_details (database_id, query) are required for query_type 'native'.");
                }
                apiUrl = `/api/dataset/${export_format}`; // Native queries use POST /api/dataset
                requestBody = {
                  database: native_query_details.database_id,
                  type: "native",
                  native: {
                    query: native_query_details.query,
                    template_tags: native_query_details.template_tags || {},
                  },
                  parameters: parameters || [], // Native query parameters if any
                };
                break;
              case "mbql":
                if (!mbql_query_details || !mbql_query_details.query || !mbql_query_details.query.database) { // query.database is the database_id
                  throw new McpError(ErrorCode.InvalidParams, "mbql_query_details (with query.database and query structure) are required for query_type 'mbql'.");
                }
                apiUrl = `/api/dataset/${export_format}`; // MBQL queries use POST /api/dataset
                requestBody = {
                  database: mbql_query_details.query.database,
                  type: "query",
                  query: mbql_query_details.query,
                  parameters: parameters || [],
                };
                break;
              default:
                throw new McpError(ErrorCode.InvalidParams, `Unsupported query_type: ${query_type}`);
            }

            if (export_format === "json_api") { // Special handling for 'json_api' to return structured JSON
              this.logInfo("Executing json_api export as a standard query", { query_type, card_id, native_query_details, mbql_query_details });
              let queryResult;
              if (query_type === "card") {
                queryResult = (await this.axiosInstance.post(`/api/card/${card_id}/query`, { parameters: parameters || [] })).data;
              } else if (query_type === "native") {
                queryResult = (await this.axiosInstance.post('/api/dataset', requestBody)).data;
              } else if (query_type === "mbql") {
                queryResult = (await this.axiosInstance.post('/api/dataset', requestBody)).data;
              } else {
                 throw new McpError(ErrorCode.InternalError, "Could not map json_api to an executable query type.");
              }
              return { toolName, content: [{ type: "application/json", content: queryResult }] };
            }
            
            this.logInfo(`Calling Metabase export API: ${method.toUpperCase()} ${apiUrl}`);
            const response = await this.axiosInstance.request({
                method: method,
                url: apiUrl,
                data: requestBody,
                responseType: 'arraybuffer' // Crucial for handling binary file data
            });

            const contentBase64 = Buffer.from(response.data).toString('base64');
            let mimeType: string;
            switch (export_format) {
              case "csv": mimeType = "text/csv"; break;
              case "xlsx": mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; break;
              case "json": mimeType = "application/json"; break; // This is file json, not json_api
              default: mimeType = "application/octet-stream"; // Fallback
            }

            return {
              toolName,
              content: [{
                type: "application/json", // The MCP content itself is JSON describing the file
                content: {
                  filename: `export.${export_format}`,
                  content_base64: contentBase64,
                  mime_type: mimeType
                }
              }]
            };
          }

          case "get_parameter_values": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { context_type, context_id, parameter_id_or_slug, query, constrained_parameters } = args;

            if (!context_type || !context_id || !parameter_id_or_slug) {
              throw new McpError(ErrorCode.InvalidParams, "context_type, context_id, and parameter_id_or_slug are required.");
            }

            let apiUrl: string;
            const queryParams: Record<string, any> = {};
            if (query) queryParams.query = query;
            if (constrained_parameters && constrained_parameters.length > 0) {
              // Metabase expects constrained parameters as JSON string under a specific key,
              // or sometimes as individual query params. This needs verification.
              // Assuming constrained_parameters is an array of {id: string, value: any}
              // The /api/dashboard/:id/params/:param-key/values endpoint takes query params for other filters
              // For example, if constrained_parameters = [{id: "other_param_slug", value: "val"}],
              // it might translate to ?other_param_slug=val in the URL.
              constrained_parameters.forEach((p: {id: string, value: any}) => {
                queryParams[p.id] = p.value;
              });
            }
            
            switch (context_type) {
              case "card":
                apiUrl = `/api/card/${context_id}/params/${parameter_id_or_slug}`;
                if (query) apiUrl += `/search/${encodeURIComponent(query)}`; else apiUrl += '/values';
                break;
              case "dashboard":
                apiUrl = `/api/dashboard/${context_id}/params/${parameter_id_or_slug}/values`;
                // Search for dashboard params is usually handled by the `query` param if supported by the values endpoint,
                // or might require a different endpoint/logic if specific search interaction is needed.
                // The existing queryParams will handle search query and other constrained params.
                break;
              // `parameter` or `adhoc_field` context might use POST /api/dataset/parameter/values
              // This part requires more specific details on the expected adhoc_parameter_definition for POST.
              // For now, only card and dashboard contexts are fully implemented as they are more common with GET.
              default:
                throw new McpError(ErrorCode.InvalidParams, `Unsupported context_type for get_parameter_values: ${context_type}`);
            }
            
            const response = await this.axiosInstance.get(apiUrl, { params: queryParams });
            return {
              toolName,
              content: [{ type: "application/json", content: response.data }]
            };
          }

          default:
            this.logError(`Unknown tool: ${toolName}`);
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }
      } catch (error) {
        this.logError('Tool execution failed', { toolName: request.params?.name, error });
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = error.response?.data?.message || error.message;
          let errorCode = ErrorCode.InternalError;
          if (status === 400) errorCode = ErrorCode.InvalidParams;
          else if (status === 401 || status === 403) errorCode = ErrorCode.PermissionDenied; // Simplified, real SDK might have specific PermissionDenied
          else if (status === 404) errorCode = ErrorCode.NotFound; // Simplified, real SDK might have specific NotFound
          
          throw new McpError(errorCode, `Metabase API Error: ${message} (Status: ${status})`);
        }
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, `An unexpected error occurred: ${(error as Error).message}`);
      }
    });
  }

  async run() {
    try {
      this.logInfo('Starting Metabase MCP server...');
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.logInfo('Metabase MCP server running on stdio');
    } catch (error) {
      this.logError('Failed to start server', error);
      throw error;
    }
  }
}

// Add global error handlers
process.on('uncaughtException', (error: Error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    message: 'Uncaught Exception',
    error: error.message,
    stack: error.stack
  }));
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    message: 'Unhandled Rejection',
    error: errorMessage
  }));
});

const server = new MetabaseServer();
server.run().catch(console.error);
