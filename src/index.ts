#!/usr/bin/env node

// Add AbortController polyfill for older Node.js versions
import AbortController from 'abort-controller';
global.AbortController = global.AbortController || AbortController;

/**
 * Metabase MCP Server
 * Implements interaction with Metabase API, providing:
 * - Dashboard listing
 * - Question listing
 * - Database listing
 * - Query execution
 * - Dashboard details
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequestSchema,
  ListResourcesResult,
  ReadResourceResult,
  Resource
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios, { AxiosInstance } from "axios";
import {
  MetabaseDatabaseResource,
  MetabaseCollectionResource,
  MetabaseTableResource,
  MetabaseCardResource,
  MetabaseDashboardResource
} from "./metabase-types.js";

// Custom error enumeration
enum ErrorCode {
  InternalError = "internal_error",
  InvalidRequest = "invalid_request",
  InvalidParams = "invalid_params",
  MethodNotFound = "method_not_found",
  NotFound = "not_found",
  PermissionDenied = "permission_denied"
}

// Custom error class
class McpError extends Error {
  code: ErrorCode;
  
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "McpError";
  }
}

// Get Metabase configuration from environment variables
const METABASE_URL = process.env.METABASE_URL;
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;

if (!METABASE_URL || !METABASE_USERNAME || !METABASE_PASSWORD) {
  throw new Error("METABASE_URL, METABASE_USERNAME, and METABASE_PASSWORD environment variables are required");
}

// Create custom Schema objects using z.object
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
   * Get Metabase session token
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
      
      // Set default request header
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
   * Setup resource handlers
   */
  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async (request): Promise<ListResourcesResult> => {
      this.logInfo('Listing resources...', { requestStructure: JSON.stringify(request) });
      await this.getSessionToken();
      const resources: Resource[] = [];

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
              mimeType: "application/json"
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
                mimeType: "application/json"
              });
            }
          });
          this.logInfo(`Fetched ${collectionsResponse.data.length} collections, filtered for top-level`);

        } else if (typeof requestUri === 'string' && requestUri.startsWith("metabase://database/")) {
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
                    mimeType: "application/json"
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
                    mimeType: "application/json"
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
                    mimeType: "application/json"
                  });
                }
              });
               this.logInfo(`Fetched tables (potentially filtered) for database ${dbId}`);
            }
          } else {
            this.logError('Invalid database URI format', { uri: requestUri });
            // Potentially throw error or return empty if format is unexpected
          }
        } else if ((requestUri as string).startsWith("metabase://collection/")) {
          const collIdMatch = (requestUri as string).match(/^metabase:\/\/collection\/([^/]+)$/);
          if (collIdMatch) {
            const collectionIdOrRoot = collIdMatch[1];
            this.logInfo(`Fetching items for collection ${collectionIdOrRoot}`);

            // The /api/collection/:id/items endpoint returns a list of items.
            // Each item has a 'model' field (e.g., 'card', 'dashboard', 'collection').
            const itemsResponse = await this.axiosInstance.get<{ data: any[] }>(`/api/collection/${collectionIdOrRoot}/items`);
            
            itemsResponse.data.data.forEach(item => {
              let resource: Resource | null = null;
              switch (item.model) {
                case 'card':
                  resource = {
                    uri: `metabase://card/${item.id}`,
                    name: item.name || item.display_name || `Card ${item.id}`,
                    mimeType: "application/json"
                  };
                  break;
                case 'dashboard':
                  resource = {
                    uri: `metabase://dashboard/${item.id}`,
                    name: item.name || item.display_name || `Dashboard ${item.id}`,
                    mimeType: "application/json"
                  };
                  break;
                case 'collection':
                  resource = {
                    uri: `metabase://collection/${item.id}`,
                    name: item.name || `Collection ${item.id}`,
                    mimeType: "application/json"
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
          this.logError('Invalid collection URI format', { uri: requestUri });
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

    // Resource templates
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
            uriTemplate: "metabase://database/{database_id}/table/{table_id}",
            name: "Metabase Table by ID",
            description: "Access a specific Metabase table by its database and table ID.",
            mimeType: 'application/json'
          },
          {
            uriTemplate: "metabase://collection/{collection_id}",
            name: "Metabase Collection by ID",
            description: "Access a specific Metabase collection by its ID.",
            mimeType: 'application/json'
          }
        ],
      };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
      this.logInfo('Reading resource...', { requestStructure: JSON.stringify(request) });
      await this.getSessionToken();

      const uri = request.params?.uri;
      if (!uri) {
        throw new McpError(ErrorCode.InvalidParams, "URI is required for reading a resource.");
      }
      let match;

      try {
        // Handle dashboard resource
        if ((match = uri.match(/^metabase:\/\/dashboard\/(\d+)$/))) {
          const dashboardId = match[1];
          this.logInfo(`Reading dashboard ${dashboardId}`);
          const response = await this.axiosInstance.get<MetabaseDashboardResource>(`/api/dashboard/${dashboardId}`);
          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        // Handle question/card resource
        else if ((match = uri.match(/^metabase:\/\/card\/(\d+)$/))) {
          const cardId = match[1];
          this.logInfo(`Reading card ${cardId}`);
          const response = await this.axiosInstance.get<MetabaseCardResource>(`/api/card/${cardId}`);
          return {
            contents: [{
              uri: uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        // Handle database resource
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
              text: JSON.stringify(databaseResource, null, 2)
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
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        // Handle Table Resource
        else if ((match = uri.match(/^metabase:\/\/database\/(\d+)\/table\/(card__\d+|\d+)$/))) {
          const dbId = match[1]; // Though not always directly used in /api/table/:id calls, good for context
          const tableId = match[2];
          this.logInfo(`Reading table ${tableId} from database ${dbId}`);

          if (tableId.startsWith("card__")) {
            // Model based on a card. The ID for the API is just the numeric part.
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
             return { contents: [{ uri: uri, mimeType: "application/json", text: JSON.stringify(tableResource, null, 2) }] };

          } else {
            // Regular table
            const tableMetadataUrl = `/api/table/${tableId}/query_metadata`;
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
                text: JSON.stringify(tableResource, null, 2)
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
              text: JSON.stringify(schemaResource, null, 2)
            }]
          };
        } else {
          this.logError('Invalid or unsupported URI format', { uri });
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
   * Setup tool handlers
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
                f: { type: "string", description: "Filter type (e.g., 'archived', 'mine', 'popular', 'table_id')" }
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
                      value: { "type": ["string", "number", "array", "boolean"], "description": "Value of the parameter" },
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
            name: "execute_query",
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
                  additionalProperties: true
                }
              },
              required: ["database_id", "query"]
            }
          },
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
          }
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
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
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
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "list_databases": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { include_tables, include_cards } = args;
            const queryParams: Record<string, any> = {};
            if (include_tables !== undefined) queryParams.include_tables = include_tables;
            if (include_cards !== undefined) queryParams.include_cards = include_cards;

            const response = await this.axiosInstance.get<{data: MetabaseDatabaseResource[]}>('/api/database', { params: queryParams });
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data.data, null, 2)
              }]
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
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "get_dashboard_details": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { dashboard_id } = args;
            if (!dashboard_id) {
              throw new McpError(ErrorCode.InvalidParams, "Dashboard ID is required for get_dashboard_details");
            }

            const response = await this.axiosInstance.get<MetabaseDashboardResource>(`/api/dashboard/${dashboard_id}`);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }
          
          case "execute_query": {
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
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
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
            const createCardBody: any = { name, dataset_query, display, visualization_settings };
            if (collection_id !== undefined) createCardBody.collection_id = collection_id;
            if (description !== undefined) createCardBody.description = description;

            const response = await this.axiosInstance.post<MetabaseCardResource>('/api/card', createCardBody);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
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
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
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
                content: [{
                  type: "text",
                  text: `Card ${card_id} permanently deleted.`
                }]
              };
            } else {
              const response = await this.axiosInstance.put<MetabaseCardResource>(`/api/card/${card_id}`, { archived: true });
              return {
                content: [{
                  type: "text",
                  text: response.data ? `Card ${card_id} archived. Details: ${JSON.stringify(response.data, null, 2)}` : `Card ${card_id} archived.`
                }]
              };
            }
          }

          case "create_dashboard": {
            this.logInfo(`Executing tool: ${toolName}`, { args });
            const { name, description, parameters, collection_id } = args;
            if (!name) {
              throw new McpError(ErrorCode.InvalidParams, "Name is required for create_dashboard");
            }
            const createDashboardBody: any = { name };
            if (description !== undefined) createDashboardBody.description = description;
            if (parameters !== undefined) createDashboardBody.parameters = parameters;
            if (collection_id !== undefined) createDashboardBody.collection_id = collection_id;

            const response = await this.axiosInstance.post<MetabaseDashboardResource>('/api/dashboard', createDashboardBody);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
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
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
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
                content: [{
                  type: "text",
                  text: `Dashboard ${dashboard_id} permanently deleted.`
                }]
              };
            } else {
              const response = await this.axiosInstance.put<MetabaseDashboardResource>(`/api/dashboard/${dashboard_id}`, { archived: true });
              return {
                content: [{
                  type: "text",
                  text: response.data ? `Dashboard ${dashboard_id} archived. Details: ${JSON.stringify(response.data, null, 2)}` : `Dashboard ${dashboard_id} archived.`
                }]
              };
            }
          }

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown tool: ${request.params?.name}`
                }
              ],
              isError: true
            };
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Metabase API error: ${error.response?.data?.message || error.message}`
            }],
            isError: true
          };
        }
        throw error;
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