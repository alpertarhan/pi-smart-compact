import { Type, type Static } from "typebox";

export const MNEMOPI_READY = "psc-mnemopi-ready-v1";

const target = { dbPath: Type.String(), projectId: Type.String() };
const fact = {
  memoryId: Type.String(),
  kind: Type.String(),
  title: Type.String({ maxLength: 200 }),
  content: Type.String({ minLength: 1, maxLength: 2_000 }),
  relatedPaths: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 }),
};

export const MnemopiMetadataSchema = Type.Object({
  projectId: target.projectId, memoryId: fact.memoryId, kind: fact.kind,
  title: fact.title, relatedPaths: fact.relatedPaths,
});

export const MnemopiRequestSchema = Type.Union([
  Type.Object({ ...target, ...fact, operation: Type.Literal("save") }),
  // Resolve and inspect address the fact by its stable memory id only.
  Type.Object({
    ...target,
    operation: Type.Literal("resolve"),
    memoryId: fact.memoryId,
  }),
  Type.Object({
    ...target,
    operation: Type.Literal("inspect"),
    memoryId: fact.memoryId,
  }),
  Type.Object({
    ...target,
    operation: Type.Literal("recall"),
    query: Type.String({ maxLength: 500 }),
    limit: Type.Integer({ minimum: 1, maximum: 20 }),
    kinds: Type.Optional(Type.Array(Type.String())),
  }),
]);

export const MnemopiOutcomeSchema = Type.Union([
  Type.Object({
    state: Type.Literal("saved"), dbPath: Type.String(), id: Type.String(),
    memoryId: Type.String(), existing: Type.Boolean(),
  }),
  Type.Object({
    state: Type.Literal("resolved"), dbPath: Type.String(), closed: Type.Boolean(),
  }),
  Type.Object({
    state: Type.Literal("inspected"), dbPath: Type.String(),
    fact: Type.Union([
      Type.Object({
        memoryId: Type.String(), kind: Type.String(),
        title: Type.String(), content: Type.String(),
      }),
      Type.Null(),
    ]),
  }),
  Type.Object({
    state: Type.Literal("recalled"), dbPath: Type.String(),
    facts: Type.Array(Type.Object({
      id: Type.String(), memoryId: Type.String(), kind: Type.String(),
      title: Type.String(), content: Type.String(), score: Type.Number(),
    }), { maxItems: 20 }),
  }),
  Type.Object({
    state: Type.Literal("failed"), reason: Type.String(),
    dbPath: Type.Optional(Type.String()),
  }),
  Type.Object({
    state: Type.Literal("unknown"), reason: Type.String(),
    dbPath: Type.Optional(Type.String()),
  }),
]);

export type MnemopiRequest = Static<typeof MnemopiRequestSchema>;
export type MnemopiOutcome = Static<typeof MnemopiOutcomeSchema>;
