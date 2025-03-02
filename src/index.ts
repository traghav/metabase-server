#!/usr/bin/env node

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
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

// 从环境变量获取 Metabase 配置
const METABASE_URL = process.env.METABASE_URL;
const METABASE_USERNAME = process.env.METABASE_USERNAME;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD;

if (!METABASE_URL || !METABASE_USERNAME || !METABASE_PASSWORD) {
  throw new Error("METABASE_URL, METABASE_USERNAME, and METABASE_PASSWORD environment variables are required");
}

class MetabaseServer {
  private server: Server;
  private axiosInstance;
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
    
    // 错误处理
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * 获取 Metabase 会话令牌
   */
  private async getSessionToken(): Promise<string> {
    if (this.sessionToken) {
      return this.sessionToken;
    }

    try {
      const response = await this.axiosInstance.post('/api/session', {
        username: METABASE_USERNAME,
        password: METABASE_PASSWORD,
      });

      this.sessionToken = response.data.id;
      
      // 设置默认请求头
      this.axiosInstance.defaults.headers.common['X-Metabase-Session'] = this.sessionToken;
      
      return this.sessionToken as string;
    } catch (error) {
      console.error('Failed to authenticate with Metabase:', error);
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
    // 列出可用资源
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      await this.getSessionToken();

      try {
        // 获取仪表板列表
        const dashboardsResponse = await this.axiosInstance.get('/api/dashboard');
        
        // 将仪表板作为资源返回
        return {
          resources: dashboardsResponse.data.map((dashboard: any) => ({
            uri: `metabase://dashboard/${dashboard.id}`,
            mimeType: "application/json",
            name: dashboard.name,
            description: `Metabase dashboard: ${dashboard.name}`
          }))
        };
      } catch (error) {
        console.error('Failed to list resources:', error);
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
        ],
      };
    });

    // 读取资源
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      await this.getSessionToken();

      const uri = request.params.uri;
      let match;

      try {
        // 处理仪表板资源
        if ((match = uri.match(/^metabase:\/\/dashboard\/(\d+)$/))) {
          const dashboardId = match[1];
          const response = await this.axiosInstance.get(`/api/dashboard/${dashboardId}`);
          
          return {
            contents: [{
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        
        // 处理问题/卡片资源
        else if ((match = uri.match(/^metabase:\/\/card\/(\d+)$/))) {
          const cardId = match[1];
          const response = await this.axiosInstance.get(`/api/card/${cardId}`);
          
          return {
            contents: [{
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        
        // 处理数据库资源
        else if ((match = uri.match(/^metabase:\/\/database\/(\d+)$/))) {
          const databaseId = match[1];
          const response = await this.axiosInstance.get(`/api/database/${databaseId}`);
          
          return {
            contents: [{
              uri: request.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(response.data, null, 2)
            }]
          };
        }
        
        else {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid URI format: ${uri}`
          );
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Metabase API error: ${error.response?.data?.message || error.message}`
          );
        }
        throw error;
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
            description: "List all dashboards in Metabase",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "list_cards",
            description: "List all questions/cards in Metabase",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "list_databases",
            description: "List all databases in Metabase",
            inputSchema: {
              type: "object",
              properties: {}
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
                  type: "object",
                  description: "Optional parameters for the query"
                }
              },
              required: ["card_id"]
            }
          },
          {
            name: "get_dashboard_cards",
            description: "Get all cards in a dashboard",
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
            description: "Execute a SQL query against a Metabase database",
            inputSchema: {
              type: "object",
              properties: {
                database_id: {
                  type: "number",
                  description: "ID of the database to query"
                },
                query: {
                  type: "string",
                  description: "SQL query to execute"
                },
                native_parameters: {
                  type: "array",
                  description: "Optional parameters for the query",
                  items: {
                    type: "object"
                  }
                }
              },
              required: ["database_id", "query"]
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await this.getSessionToken();

      try {
        switch (request.params.name) {
          case "list_dashboards": {
            const response = await this.axiosInstance.get('/api/dashboard');
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "list_cards": {
            const response = await this.axiosInstance.get('/api/card');
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "list_databases": {
            const response = await this.axiosInstance.get('/api/database');
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "execute_card": {
            const cardId = request.params.arguments?.card_id;
            if (!cardId) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Card ID is required"
              );
            }

            const parameters = request.params.arguments?.parameters || {};
            const response = await this.axiosInstance.post(`/api/card/${cardId}/query`, { parameters });
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }

          case "get_dashboard_cards": {
            const dashboardId = request.params.arguments?.dashboard_id;
            if (!dashboardId) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Dashboard ID is required"
              );
            }

            const response = await this.axiosInstance.get(`/api/dashboard/${dashboardId}`);
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data.cards, null, 2)
              }]
            };
          }
          
          case "execute_query": {
            const databaseId = request.params.arguments?.database_id;
            const query = request.params.arguments?.query;
            const nativeParameters = request.params.arguments?.native_parameters || [];
            
            if (!databaseId) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Database ID is required"
              );
            }
            
            if (!query) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "SQL query is required"
              );
            }
            
            // 构建查询请求体
            const queryData = {
              type: "native",
              native: {
                query: query,
                template_tags: {}
              },
              parameters: nativeParameters,
              database: databaseId
            };
            
            const response = await this.axiosInstance.post('/api/dataset', queryData);
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify(response.data, null, 2)
              }]
            };
          }
          
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
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
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Metabase MCP server running on stdio');
  }
}

const server = new MetabaseServer();
server.run().catch(console.error);
