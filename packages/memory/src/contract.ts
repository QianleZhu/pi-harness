import { type Static, Type } from "typebox";

// 记忆作用域
export const MemoryScope = {
  USER: "user", // 跨项目全局经验记忆
  WORKSPACE: "workspace", // 只属于某个 Workspace（仅由 Dreaming 维护）
} as const;
export type MemoryScope = (typeof MemoryScope)[keyof typeof MemoryScope];

// 记忆来源类型
export const MemorySourceType = {
  MANUAL: "manual", // 用户在设置页手动创建
  SESSION: "session", // 从对话中整理产生
} as const;
export type MemorySourceType = (typeof MemorySourceType)[keyof typeof MemorySourceType];

// 用户个性维度（独立表 user_profiles，仅用户手动维护）
export const UserProfileFacet = {
  BACKGROUND: "background", // 背景信息，例如职业、所在地、当前身份
  COMMUNICATION: "communication", // 沟通习惯，例如偏好中文、回答简洁、先给结论
  EXPERTISE: "expertise", // 专业能力，例如熟悉 TypeScript、React、后端开发
  INTERESTS: "interests", // 长期兴趣，例如 AI Agent、摄影、投资
  PREFERENCES: "preferences", // 一般偏好，例如偏爱 pnpm、深色主题、少写测试
  WORKFLOW: "workflow", // 做事方式，例如先阅读架构再改代码、不自动执行 Git 命令
} as const;
export type UserProfileFacet = (typeof UserProfileFacet)[keyof typeof UserProfileFacet];

export const MemoryScopeSchema = Type.Union([
  Type.Literal(MemoryScope.USER),
  Type.Literal(MemoryScope.WORKSPACE),
]);
export const MemorySourceTypeSchema = Type.Union([
  Type.Literal(MemorySourceType.MANUAL),
  Type.Literal(MemorySourceType.SESSION),
]);
export const UserProfileFacetSchema = Type.Union([
  Type.Literal(UserProfileFacet.BACKGROUND),
  Type.Literal(UserProfileFacet.COMMUNICATION),
  Type.Literal(UserProfileFacet.EXPERTISE),
  Type.Literal(UserProfileFacet.INTERESTS),
  Type.Literal(UserProfileFacet.PREFERENCES),
  Type.Literal(UserProfileFacet.WORKFLOW),
]);

// 一条独立存储的用户个性记录（仅手动增删改）
export const UserProfileItemSchema = Type.Object({
  content: Type.String({ maxLength: 500, minLength: 1 }),
  createdAt: Type.Integer({ minimum: 0 }),
  facet: UserProfileFacetSchema,
  id: Type.String({ format: "uuid" }),
  updatedAt: Type.Integer({ minimum: 0 }),
});
export type UserProfileItem = Static<typeof UserProfileItemSchema>;

// 一条长期记忆（scope='user' 仅存跨项目经验；scope='workspace' 仅由 Dreaming 维护）
export const MemoryRecordSchema = Type.Object({
  content: Type.String({ maxLength: 500, minLength: 1 }), // 记忆正文
  createdAt: Type.Integer({ minimum: 0 }), // 创建时间，Unix 毫秒时间戳
  id: Type.String({ format: "uuid" }), // 记忆唯一 ID
  revision: Type.Integer({ minimum: 1 }), // 修改版本号，用于防止并发覆盖
  scope: MemoryScopeSchema, // user 为跨项目全局记忆，workspace 为项目记忆
  sourceSessionId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]), // 来源 Session，手动创建时为 null
  sourceType: MemorySourceTypeSchema, // manual 为手动创建，session 为对话整理产生
  updatedAt: Type.Integer({ minimum: 0 }), // 最后更新时间，Unix 毫秒时间戳
  workspaceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]), // 所属 Workspace，全局记忆为 null
});
export type MemoryRecord = Static<typeof MemoryRecordSchema>;

export const UserProfileSectionSchema = Type.Object({
  facet: UserProfileFacetSchema,
  items: Type.Array(UserProfileItemSchema),
});
export type UserProfileSection = Static<typeof UserProfileSectionSchema>;

export const UserProfileSchema = Type.Object({
  sections: Type.Array(UserProfileSectionSchema),
  updatedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export type UserProfile = Static<typeof UserProfileSchema>;

export const MemorySettingsSchema = Type.Object({
  generateMemories: Type.Boolean(),
  useMemories: Type.Boolean(),
});
export type MemorySettings = Static<typeof MemorySettingsSchema>;

// Web 记忆设置页只查看和管理「全局记忆」与「用户个性」，不暴露工作区记忆。
export const MemoryStateSchema = Type.Object({
  memories: Type.Array(MemoryRecordSchema),
  profile: UserProfileSchema,
  settings: MemorySettingsSchema,
});
export type MemoryState = Static<typeof MemoryStateSchema>;

// Web API 仅允许创建、修改和删除跨项目全局记忆。
export const CreateMemoryInputSchema = Type.Object({
  content: Type.String({ maxLength: 500, minLength: 1 }),
});
export type CreateMemoryInput = Static<typeof CreateMemoryInputSchema>;

export const UpdateMemoryInputSchema = Type.Object({
  content: Type.String({ maxLength: 500, minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 1 }),
});
export type UpdateMemoryInput = Static<typeof UpdateMemoryInputSchema>;

export const DeleteMemoryInputSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
});
export type DeleteMemoryInput = Static<typeof DeleteMemoryInputSchema>;

export const MemoryParamsSchema = Type.Object({
  memoryId: Type.String({ format: "uuid" }),
});
export type MemoryParams = Static<typeof MemoryParamsSchema>;

// 独立用户个性 CRUD 契约。
export const CreateUserProfileInputSchema = Type.Object({
  content: Type.String({ maxLength: 500, minLength: 1 }),
  facet: UserProfileFacetSchema,
});
export type CreateUserProfileInput = Static<typeof CreateUserProfileInputSchema>;

export const UpdateUserProfileInputSchema = Type.Object({
  content: Type.Optional(Type.String({ maxLength: 500, minLength: 1 })),
  facet: Type.Optional(UserProfileFacetSchema),
});
export type UpdateUserProfileInput = Static<typeof UpdateUserProfileInputSchema>;

export const UserProfileParamsSchema = Type.Object({
  profileId: Type.String({ format: "uuid" }),
});
export type UserProfileParams = Static<typeof UserProfileParamsSchema>;

export const UpdateMemorySettingsInputSchema = Type.Object({
  generateMemories: Type.Optional(Type.Boolean()),
  useMemories: Type.Optional(Type.Boolean()),
});
export type UpdateMemorySettingsInput = Static<typeof UpdateMemorySettingsInputSchema>;
