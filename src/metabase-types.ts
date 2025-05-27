// Metabase type definitions

export interface MetabaseFieldResource {
  uri?: string; // e.g., metabase://database/1/table/2/field/3
  id: number;
  name: string;
  display_name?: string;
  table_id?: number | string; // string for card-based models like 'card__XYZ'
  base_type: string;
  effective_type?: string;
  semantic_type?: string | null;
  description?: string | null;
  visibility_type?: string;
  fk_target_field_id?: number | null;
  schema?: string;
  // ... other relevant fields from the detailed spec
}

export interface MetabaseTableResource {
  uri?: string; // e.g., metabase://database/1/table/2 or metabase://model/card__123
  id: number | string;
  name: string;
  display_name?: string;
  db_id: number;
  schema?: string | null;
  schema_name?: string | null;
  description?: string | null;
  fields?: MetabaseFieldResource[]; // Could be stubs (URIs) or full objects depending on context
  fks?: any[]; // Define FK structure
  entity_type?: string | null;
  // ... other relevant fields
}

export interface MetabaseDatabaseResource {
  uri?: string; // e.g., metabase://database/1
  id: number;
  name: string;
  engine: string;
  description?: string | null;
  tables?: MetabaseTableResource[]; // Stubs or full objects
  schemas?: string[];
  // ... other relevant fields
}

export interface MetabaseCardResource {
  uri?: string; // e.g., metabase://card/1
  id: number;
  name: string;
  display_name?: string;
  description?: string | null;
  display: string;
  collection_id?: number | null;
  database_id?: number;
  dataset_query: any; // MBQL, can be complex
  visualization_settings: any;
  result_metadata?: MetabaseFieldResource[]; // Describes output columns
  parameters?: any[]; // Card parameter definitions
  archived: boolean;
  type?: "question" | "metric" | "model";
  // ... other relevant fields
}

export interface MetabaseDashboardCardResource {
  // For cards *on* a dashboard
  id: number; // dashcard_id
  card_id?: number | null;
  card?: MetabaseCardResource; // Embedded card details
  size_x: number;
  size_y: number;
  row: number;
  col: number;
  visualization_settings?: any;
  parameter_mappings?: any[];
  // ... other relevant fields
}

export interface MetabaseDashboardResource {
  uri?: string; // e.g., metabase://dashboard/1
  id: number;
  name: string;
  display_name?: string;
  description?: string | null;
  collection_id?: number | null;
  parameters?: any[]; // Dashboard filter definitions
  dashcards?: MetabaseDashboardCardResource[];
  tabs?: any[];
  archived: boolean;
  // ... other relevant fields
}

export interface MetabaseCollectionResource {
  uri?: string; // e.g., metabase://collection/1 or metabase://collection/root
  id: number | "root";
  name: string;
  description?: string | null;
  parent_id?: number | null;
  personal_owner_id?: number | null;
  // ... other relevant fields
}

// Define output structure for query results
export interface MetabaseQueryResultData {
  cols: Array<{ name: string; display_name: string; base_type: string; [key: string]: any }>;
  rows: any[][];
  row_count: number;
  status: string;
  // ... other common fields like database_id, query_time_ms
}

export interface MetabaseQueryResult {
  data: MetabaseQueryResultData;
  status: string;
  // ... other top-level fields from Metabase query responses
}