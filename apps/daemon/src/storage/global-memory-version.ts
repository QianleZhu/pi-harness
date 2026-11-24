import type { DatabaseSync } from "node:sqlite";

// 为当前跨项目全局记忆（scope='global'）保存不可变的完整发布副本，调用方负责事务。
export function recordGlobalMemoryVersion(database: DatabaseSync, createdAt: number): void {
  database
    .prepare(`INSERT INTO global_memory_versions (version, memories_json, created_at)
    SELECT (SELECT COALESCE(MAX(version), 0) + 1 FROM global_memory_versions),
      COALESCE(json_group_array(json_object(
        'id', id, 'content', content,
        'scope', scope, 'workspaceId', workspace_id, 'sourceType', source_type,
        'sourceSessionId', source_session_id, 'revision', revision,
        'createdAt', created_at, 'updatedAt', updated_at
      )), '[]'), ? FROM memories WHERE scope = 'global' AND status = 'saved'`)
    .run(createdAt);
}
