export interface ValidationResult {
  url: string;
  entityType: "vendor" | "event" | "venue";
  timestamp: string;
  status: "valid" | "invalid" | "error";
  detectedItems: DetectedItem[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  googleTestUrl: string;
}

export interface DetectedItem {
  type: string;
  status: "valid" | "invalid";
  errorCount: number;
  warningCount: number;
}

export interface ValidationIssue {
  type: "error" | "warning";
  message: string;
  schema: string;
  property?: string;
}

export interface ParsedSitemap {
  vendors: string[];
  events: string[];
  venues: string[];
  all: string[];
}

export interface RunSummary {
  runId: string;
  baseUrl: string;
  startTime: string;
  endTime: string;
  stoppedEarly: boolean;
  summary: {
    totalUrls: number;
    tested: number;
    valid: number;
    invalid: number;
    withWarnings: number;
    errors: number;
  };
  results: ValidationResult[];
}
