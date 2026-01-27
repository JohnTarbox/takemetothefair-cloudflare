// Entity types that can have duplicates
export type DuplicateEntityType = "venues" | "events" | "vendors" | "promoters";

// Base entity interface with common fields (without name since it varies)
export interface BaseEntity {
  id: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

// Venue entity
export interface VenueEntity extends BaseEntity {
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  latitude?: number | null;
  longitude?: number | null;
  capacity?: number | null;
  status: string;
  _count?: { events: number };
}

// Promoter entity
export interface PromoterEntity extends BaseEntity {
  userId: string;
  companyName: string;
  description?: string | null;
  website?: string | null;
  verified: boolean;
  _count?: { events: number };
}

// Vendor entity
export interface VendorEntity extends BaseEntity {
  userId: string;
  businessName: string;
  description?: string | null;
  vendorType?: string | null;
  website?: string | null;
  verified: boolean;
  _count?: { eventVendors: number };
}

// Event entity
export interface EventEntity extends BaseEntity {
  name: string;
  description?: string | null;
  promoterId: string;
  venueId: string;
  startDate: Date;
  endDate: Date;
  status: string;
  viewCount: number;
  venue?: { name: string };
  promoter?: { companyName: string };
  _count?: { eventVendors: number };
}

// Union type for all entities
export type DuplicateEntity = VenueEntity | PromoterEntity | VendorEntity | EventEntity;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEntity = any;

// Duplicate pair with similarity score
export interface DuplicatePair {
  entity1: AnyEntity;
  entity2: AnyEntity;
  similarity: number;
  matchedFields: string[];
}

// Duplicate group (all similar entities grouped together)
export interface DuplicateGroup {
  entities: AnyEntity[];
  highestSimilarity: number;
}

// API response for finding duplicates
export interface FindDuplicatesResponse {
  type: DuplicateEntityType;
  threshold: number;
  duplicates: DuplicatePair[];
  totalEntities: number;
}

// Merge preview request
export interface MergePreviewRequest {
  type: DuplicateEntityType;
  primaryId: string;
  duplicateId: string;
}

// Relationship counts for merge preview
export interface RelationshipCounts {
  events?: number;
  eventVendors?: number;
  favorites?: number;
}

// Merge preview response
export interface MergePreviewResponse {
  primary: AnyEntity;
  duplicate: AnyEntity;
  relationshipsToTransfer: RelationshipCounts;
  warnings: string[];
  canMerge: boolean;
}

// Merge request
export interface MergeRequest {
  type: DuplicateEntityType;
  primaryId: string;
  duplicateId: string;
}

// Merge response
export interface MergeResponse {
  success: boolean;
  mergedEntity: AnyEntity;
  transferredRelationships: RelationshipCounts;
  deletedId: string;
}

// Entity name field mapping
export const ENTITY_NAME_FIELD: Record<DuplicateEntityType, string> = {
  venues: "name",
  events: "name",
  vendors: "businessName",
  promoters: "companyName",
};

// Get display name for an entity
export function getEntityDisplayName(entity: AnyEntity, type: DuplicateEntityType): string {
  switch (type) {
    case "venues":
    case "events":
      return entity.name;
    case "vendors":
      return entity.businessName;
    case "promoters":
      return entity.companyName;
    default:
      return "Unknown";
  }
}
