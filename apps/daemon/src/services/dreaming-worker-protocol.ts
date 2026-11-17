import { Type } from "typebox";

// Worker 与 daemon 之间的受限控制和凭据消息。
export const WorkerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("ready") }),
  Type.Object({
    type: Type.Literal("activity"),
    providerId: Type.String(),
    active: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("failure"),
    phase: Type.String(),
    runIds: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("request"),
    id: Type.Integer({ minimum: 1 }),
    method: Type.Union([
      Type.Literal("session_active"),
      Type.Literal("credential_read"),
      Type.Literal("credential_list"),
      Type.Literal("credential_modify"),
      Type.Literal("credential_delete"),
    ]),
    providerId: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("modify_result"),
    id: Type.Integer({ minimum: 1 }),
    ok: Type.Boolean(),
    value: Type.Optional(Type.Unknown()),
  }),
]);

export const ParentMessageSchema = Type.Union([
  Type.Object({
    type: Type.Literal("init"),
    databasePath: Type.String(),
    sessionsPath: Type.String(),
    globalRoot: Type.String(),
  }),
  Type.Object({ type: Type.Literal("providers_changed") }),
  Type.Object({ type: Type.Literal("shutdown") }),
  Type.Object({
    type: Type.Literal("response"),
    id: Type.Integer({ minimum: 1 }),
    ok: Type.Boolean(),
    value: Type.Optional(Type.Unknown()),
  }),
  Type.Object({
    type: Type.Literal("modify_current"),
    id: Type.Integer({ minimum: 1 }),
    value: Type.Optional(Type.Unknown()),
  }),
]);

export const CredentialSchema = Type.Union([
  Type.Object({
    type: Type.Literal("api_key"),
    key: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
  }),
  Type.Object({
    type: Type.Literal("oauth"),
    refresh: Type.String(),
    access: Type.String(),
    expires: Type.Number(),
  }),
]);

export const CredentialListSchema = Type.Array(
  Type.Object({
    providerId: Type.String(),
    type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
  }),
);
