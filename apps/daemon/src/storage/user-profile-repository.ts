import type { DatabaseSync } from "node:sqlite";
import {
  type StoredUserProfileInput,
  UserProfileFacet,
  type UserProfileFacet as UserProfileFacetValue,
  type UserProfileItem,
  type UserProfileRepository,
} from "@pi-harness/memory";

const PROFILE_FACETS = new Set<string>(Object.values(UserProfileFacet));

function isUserProfileFacet(value: string): value is UserProfileFacetValue {
  return PROFILE_FACETS.has(value);
}

function mapUserProfile(row: Record<string, unknown>): UserProfileItem {
  const facet = row.facet;
  if (typeof facet !== "string" || !isUserProfileFacet(facet)) {
    throw new Error("Invalid user profile facet");
  }
  return {
    id: String(row.id),
    facet,
    content: String(row.content),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

// 独立管理 user_profiles 表，仅承载用户在 Web UI 手动维护的用户个性。
export class SqliteUserProfileRepository implements UserProfileRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public list(): readonly UserProfileItem[] {
    return this.database
      .prepare("SELECT * FROM user_profiles ORDER BY updated_at DESC, id")
      .all()
      .map(mapUserProfile);
  }

  public find(profileId: string): UserProfileItem | null {
    const row = this.database.prepare("SELECT * FROM user_profiles WHERE id = ?").get(profileId);
    return row === undefined ? null : mapUserProfile(row);
  }

  public findDuplicate(normalizedContent: string, excludeId?: string): UserProfileItem | null {
    const row =
      excludeId === undefined
        ? this.database
            .prepare("SELECT * FROM user_profiles WHERE normalized_content = ?")
            .get(normalizedContent)
        : this.database
            .prepare("SELECT * FROM user_profiles WHERE normalized_content = ? AND id <> ?")
            .get(normalizedContent, excludeId);
    return row === undefined ? null : mapUserProfile(row);
  }

  public create(item: StoredUserProfileInput): void {
    this.database
      .prepare(
        `INSERT INTO user_profiles (id, facet, content, normalized_content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.facet,
        item.content,
        item.normalizedContent,
        item.createdAt,
        item.updatedAt,
      );
  }

  public update(item: StoredUserProfileInput): boolean {
    return (
      this.database
        .prepare(
          `UPDATE user_profiles
           SET facet = ?, content = ?, normalized_content = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(item.facet, item.content, item.normalizedContent, item.updatedAt, item.id).changes ===
      1
    );
  }

  public delete(profileId: string): boolean {
    return (
      this.database.prepare("DELETE FROM user_profiles WHERE id = ?").run(profileId).changes === 1
    );
  }
}
