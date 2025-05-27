# metabase-server MCP Server

[![smithery badge](https://smithery.ai/badge/@imlewc/metabase-server)](https://smithery.ai/server/@imlewc/metabase-server)

A Model Context Protocol server for Metabase integration.

This is a TypeScript-based MCP server that implements integration with Metabase API. It allows AI assistants to interact with Metabase, providing access to:

- Detailed Metabase resources (databases, tables, fields, collections, etc.)
- A comprehensive suite of tools for listing, reading, executing, and managing Metabase assets.

## Features

### Resources

The server supports discovery and reading of a wide range of Metabase resources using `metabase://` URIs. These resources can be listed hierarchically and read to get their full JSON representation.

-   **Databases:** `metabase://database/{db_id}`
    -   Includes details, list of tables, and schemas.
-   **Tables:** `metabase://database/{db_id}/table/{table_id}`
    -   Supports both regular tables and card-based models (e.g., `metabase://database/{db_id}/table/card__{card_id}`).
    -   Includes table metadata and fields.
-   **Schemas:** `metabase://database/{db_id}/schema/{schema_name}`
    -   Lists tables within a specific schema.
-   **Collections:** `metabase://collection/{collection_id_or_root}`
    -   Supports listing items within a collection (cards, dashboards, sub-collections).
-   **Cards (Questions/Models):** `metabase://card/{card_id}`
    -   Detailed information about a specific question or model.
-   **Dashboards:** `metabase://dashboard/{dashboard_id}`
    -   Detailed information about a specific dashboard, including its dashcards and parameters.

### Tools

The server provides a rich set of tools to interact with Metabase:

**Listing & Reading Tools:**

-   `list_dashboards`: List Metabase dashboards.
    -   Supports filtering by `collection_id` and `archived` status.
-   `list_cards`: List Metabase cards (questions/models).
    -   Supports filtering by `collection_id`, `archived` status, and `f` (filter type like 'archived', 'mine').
-   `list_databases`: List Metabase databases.
    -   Supports `include_tables` and `include_cards` to embed related resources.
-   `get_dashboard_details`: Get full details for a specific dashboard, including its dashcards and parameters (`dashboard_id`).
-   `get_database_details`: Get detailed information about a specific database (`database_id`), optionally including tables and fields.
-   `list_database_schemas`: List all schemas within a specific database (`database_id`).
-   `list_tables_in_schema`: List all tables within a specific schema of a database (`database_id`, `schema_name`).
-   `get_table_details`: Get detailed metadata for a specific table (`table_id`) or a card-based model (`card_model_id`).
-   `get_field_distinct_values`: Get distinct values for a specific field (`field_id`), useful for parameter population.
-   `list_collections`: List Metabase collections.
    -   Supports filtering by `parent_collection_id` and `archived` status.
-   `list_collection_items`: List items (cards, dashboards, sub-collections) within a specific collection (`collection_id`).
    -   Supports filtering by `models` (e.g., 'card', 'dashboard') and `archived` status.
-   `get_card_query_metadata`: Get query metadata for a card (`card_id`), including `dataset_query`, `result_metadata`, and `parameters`.

**Execution & Export Tools:**

-   `execute_card`: Execute a Metabase question/card (`card_id`) and get results.
    -   Supports passing `parameters` as an array of objects.
-   `execute_query`: Execute a native SQL query against a specified database (`database_id`, `query`).
    -   Supports `template_tags` for substituting values in the SQL query.
-   `execute_dashboard_card_query`: Execute a query for a card that is part of a dashboard (`dashboard_id`, `dashcard_id`, `card_id`), applying dashboard `parameters`.
-   `execute_mbql_query`: Execute a query defined using Metabase Query Language (MBQL) (`query` object, optional `parameters`).
-   `export_query_results`: Export results of a query (from `card`, `native` SQL, or `mbql`) in various formats (`csv`, `xlsx`, `json`, `json_api`).
    -   Returns file content as base64 or structured JSON for `json_api`.

**Parameter & Helper Tools:**

-   `get_parameter_values`: Fetches possible values for a parameter in a given context (`context_type`, `context_id`, `parameter_id_or_slug`).
    -   Supports `query` for searching and `constrained_parameters`.

**CRUD (Create, Read, Update, Delete) Tools:**

-   `create_card`, `update_card`, `delete_card` (supports hard/soft delete)
-   `create_dashboard`, `update_dashboard`, `delete_dashboard` (supports hard/soft delete)

## URI Examples

-   Root (list databases and top-level collections): `metabase://`
-   Database: `metabase://database/1`
-   Schema within a database: `metabase://database/1/schema/public`
-   Table within a database (default schema): `metabase://database/1/table/23`
-   Table within a specific schema: `metabase://database/1/schema/public/table/23` (Note: listing is via schema URI, reading table is direct)
-   Card-based model: `metabase://database/1/table/card__101` (Read via `get_table_details` or resource read)
-   Collection: `metabase://collection/5`
-   Root Collection: `metabase://collection/root`
-   Card/Question: `metabase://card/78`
-   Dashboard: `metabase://dashboard/2`

## Configuration

Before running the server, you need to set the following environment variables:

```bash
# Required environment variables
export METABASE_URL=https://your-metabase-instance.com
export METABASE_USERNAME=your_username
export METABASE_PASSWORD=your_password
```

You can set these environment variables in your shell profile or use a `.env` file with a package like `dotenv`.

## Development

Install dependencies:
```bash
npm install
```

Build the server:
```bash
npm run build
```

For development with auto-rebuild:
```bash
npm run watch
```

## Installation

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "metabase-server": {
      "command": "/path/to/metabase-server/build/index.js",
      "env": {
        "METABASE_URL": "https://your-metabase-instance.com",
        "METABASE_USERNAME": "your_username",
        "METABASE_PASSWORD": "your_password"
      }
    }
  }
}
```

Note: You can also set these environment variables in your system instead of in the config file if you prefer.

### Installing via Smithery

To install metabase-server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@traghav/metabase-server):

```bash
npx -y @smithery/cli install @traghav/metabase-server --client claude
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.
