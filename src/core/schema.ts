// Think 的数据模式（见设计文档第 7 节、第 5.5 节）。
// 只依赖 zod，不依赖界面、文件系统或网络。
import { z } from "zod";

export const SCHEMA_VERSION = 1;

/** 地区 / 语境未指定时的值 */
export const UNSPECIFIED_CONTEXT = "未指定";
/** AI 常写成"未指定地区""未指定（不默认任何国家）"，以"未指定"开头都算未指定 */
export const isContextUnspecified = (c: string | undefined) => !c || !c.trim() || c.trim().startsWith(UNSPECIFIED_CONTEXT);

// ---------- ID ----------

export const NodeId = z.string().regex(/^n\d+$/, "节点 ID 形如 n1");
export const EdgeId = z.string().regex(/^e\d+$/, "边 ID 形如 e1");
/** 补丁内的新节点临时引用，形如 $a、$demand、$焦虑（$ 后接不含空白和 $ 的字符） */
export const Ref = z.string().regex(/^\$[^\s$]{1,40}$/u, "临时引用形如 $a");
/** add_edge 的端点：已有节点 ID 或本补丁中的临时引用 */
export const NodeRef = z.union([NodeId, Ref]);
export const VersionId = z.string().regex(/^v\d{3,}$/, "版本 ID 形如 v001");
export const PatchId = z.string().regex(/^p\d{3,}$/, "补丁 ID 形如 p001");
export const TurnId = z.string().regex(/^t\d{3,}$/, "回合 ID 形如 t001");

const Label = z.string().trim().min(1).max(40);
const Text = z.string().max(2000);

// ---------- 图 ----------

export const Polarity = z.enum(["+", "-", "?"]);
export const Origin = z.enum(["user", "ai"]);
export const NodeStatus = z.enum(["accepted", "rejected"]);
export const EdgeStatus = z.enum(["accepted", "uncertain", "rejected"]);

export const Frame = z.object({
  topic: z.string().trim().min(1),
  phenomenon: z.string().default(""),
  perspective: z.string().default(""),
  time_horizon: z.string().default(""),
  /** 地区 / 语境（国家、城市、群体等）；AI 不得默认某个国家 */
  context: z.string().default(UNSPECIFIED_CONTEXT),
});

export const GraphNode = z.object({
  id: NodeId,
  label: Label,
  status: NodeStatus,
  origin: Origin,
  note: Text.default(""),
});

export const GraphEdge = z.object({
  id: EdgeId,
  from: NodeId,
  to: NodeId,
  polarity: Polarity,
  delay: z.boolean().default(false),
  status: EdgeStatus,
  origin: Origin,
  rationale: Text.default(""),
  contested: z.boolean().default(false),
  confidence: z.number().min(0).max(1).nullable().default(null),
  note: Text.default(""),
});

export const Graph = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    version: VersionId,
    frame: Frame,
    nodes: z.array(GraphNode),
    edges: z.array(GraphEdge),
  })
  .superRefine((g, ctx) => {
    const nodeIds = new Set<string>();
    for (const [i, n] of g.nodes.entries()) {
      if (nodeIds.has(n.id)) ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `重复的节点 ID ${n.id}` });
      nodeIds.add(n.id);
    }
    const edgeIds = new Set<string>();
    for (const [i, e] of g.edges.entries()) {
      if (edgeIds.has(e.id)) ctx.addIssue({ code: "custom", path: ["edges", i, "id"], message: `重复的边 ID ${e.id}` });
      edgeIds.add(e.id);
      for (const end of ["from", "to"] as const) {
        if (!nodeIds.has(e[end])) {
          ctx.addIssue({ code: "custom", path: ["edges", i, end], message: `边 ${e.id} 引用了不存在的节点 ${e[end]}` });
        }
      }
    }
  });

// ---------- 补丁操作（第 7.2 节） ----------

export const SetFrameOp = z.object({
  op: z.literal("set_frame"),
  phenomenon: z.string().optional(),
  perspective: z.string().optional(),
  time_horizon: z.string().optional(),
  context: z.string().optional(),
});

export const AddNodeOp = z.object({
  op: z.literal("add_node"),
  ref: Ref,
  label: Label,
  rationale: Text.optional(),
});

export const UpdateNodeOp = z.object({
  op: z.literal("update_node"),
  id: NodeId,
  label: Label.optional(),
  note: Text.optional(),
});

export const RemoveNodeOp = z.object({
  op: z.literal("remove_node"),
  id: NodeId,
  reason: Text.optional(),
});

export const MergeNodesOp = z.object({
  op: z.literal("merge_nodes"),
  keep: NodeId,
  merge: NodeId,
  label: Label.optional(),
});

export const AddEdgeOp = z.object({
  op: z.literal("add_edge"),
  from: NodeRef,
  to: NodeRef,
  polarity: Polarity,
  delay: z.boolean().optional(),
  rationale: Text,
  contested: z.boolean().optional(),
});

export const UpdateEdgeOp = z.object({
  op: z.literal("update_edge"),
  id: EdgeId,
  polarity: Polarity.optional(),
  delay: z.boolean().optional(),
  status: EdgeStatus.optional(),
  rationale: Text.optional(),
  note: Text.optional(),
  contested: z.boolean().optional(),
});

export const ReverseEdgeOp = z.object({
  op: z.literal("reverse_edge"),
  id: EdgeId,
});

export const RemoveEdgeOp = z.object({
  op: z.literal("remove_edge"),
  id: EdgeId,
  reason: Text.optional(),
});

export const PatchOp = z.discriminatedUnion("op", [
  SetFrameOp,
  AddNodeOp,
  UpdateNodeOp,
  RemoveNodeOp,
  MergeNodesOp,
  AddEdgeOp,
  UpdateEdgeOp,
  ReverseEdgeOp,
  RemoveEdgeOp,
]);

// ---------- 补丁文件（第 7.4 节） ----------

export const PossibleDuplicate = z.object({
  a: NodeRef,
  b: NodeRef,
  reason: Text,
});

export const OpDecision = z.object({
  op_index: z.number().int().min(0),
  decision: z.enum(["accepted", "rejected"]),
  reason: Text.optional(),
  /** true：因依赖的新节点被拒绝而自动拒绝 */
  auto: z.boolean().default(false),
});

export const PatchResolution = z.object({
  resolved_at: z.iso.datetime(),
  decisions: z.array(OpDecision),
  result_version: VersionId.nullable(),
  /** true：崩溃后由完整性修复根据版本文件补记（见 map-store 的 repairMap） */
  recovered: z.boolean().default(false),
});

export const Patch = z.object({
  patch_id: PatchId,
  base_version: VersionId,
  origin: Origin,
  created_at: z.iso.datetime(),
  turn_id: TurnId.nullable().default(null),
  ops: z.array(PatchOp),
  message: Text.default(""),
  question: Text.default(""),
  possible_duplicates: z.array(PossibleDuplicate).default([]),
  resolution: PatchResolution.nullable(),
});

// ---------- 版本文件（第 7.5 节） ----------

export const Version = z
  .object({
    version: VersionId,
    parent_version: VersionId.nullable(),
    patch_id: PatchId.nullable(),
    /** 产生本版本时补丁每一项的决定；崩溃后用于补记补丁的处理结果 */
    decisions: z.array(OpDecision).nullable().default(null),
    created_at: z.iso.datetime(),
    graph: Graph,
  })
  .refine((v) => v.graph.version === v.version, { message: "版本号与图中的 version 不一致", path: ["graph", "version"] });

// ---------- 工作区与 Map 文件（第 9.4、9.5 节） ----------

export const WorkspaceConfig = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  default_model: z.string().default("sonnet"),
  /** 短回合（澄清、回答"为什么"）的思考程度；null 表示用 CLI 默认 */
  effort_short: z.string().nullable().default("low"),
  /** 长回合（种子图、补充）的思考程度；null 表示用 CLI 默认 */
  effort_long: z.string().nullable().default(null),
  privacy_notice_seen: z.boolean().default(false),
});

export const MapMeta = z.object({
  schema_version: z.number().int().min(1),
  title: z.string().trim().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** 分叉来源：源 Map 的文件夹名和版本 */
  parent: z.object({ map: z.string(), version: VersionId }).nullable().default(null),
  archived: z.boolean().default(false),
});

export const Layout = z.object({
  positions: z.record(NodeId, z.object({ x: z.number(), y: z.number() })).default({}),
});

export const Turn = z.object({
  turn_id: TurnId,
  role: z.enum(["user", "ai", "system"]),
  kind: z.enum(["clarify", "patch", "answer"]).optional(),
  text: z.string(),
  question: z.string().optional(),
  patch_id: PatchId.optional(),
  version: VersionId.optional(),
  created_at: z.iso.datetime(),
});

// ---------- AI 输出（第 5.5 节） ----------
// 结构由 CLI 的 --json-schema 保证；内容规则（引用存在、≤3 个新增等）由 M3 的代码校验。

export const AiOutput = z.object({
  kind: z.enum(["clarify", "patch", "answer"]),
  message: Text,
  question: Text,
  ops: z.array(PatchOp),
  possible_duplicates: z.array(PossibleDuplicate),
});

/**
 * 传给 `claude --json-schema` 的 JSON Schema。
 * 用 io: "input" 生成：不带 additionalProperties: false，AI 多写一个无关字段不会让整个输出被 CLI 拒绝
 * （CLI 内部最多重试 5 次，失败时报 error_max_structured_output_retries 且看不到原因）。
 * 多余的字段在 zod 解析时被丢弃；内容规则由 ai-check.ts 检查。
 */
export function aiOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(AiOutput, { target: "draft-7", io: "input" }) as Record<string, unknown>;
}

// ---------- 类型 ----------

export type Polarity = z.infer<typeof Polarity>;
export type Frame = z.infer<typeof Frame>;
export type GraphNode = z.infer<typeof GraphNode>;
export type GraphEdge = z.infer<typeof GraphEdge>;
export type Graph = z.infer<typeof Graph>;
export type PatchOp = z.infer<typeof PatchOp>;
export type Patch = z.infer<typeof Patch>;
export type OpDecision = z.infer<typeof OpDecision>;
export type PatchResolution = z.infer<typeof PatchResolution>;
export type Origin = z.infer<typeof Origin>;
export type EdgeStatus = z.infer<typeof EdgeStatus>;
export type Version = z.infer<typeof Version>;
export type AiOutput = z.infer<typeof AiOutput>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;
export type MapMeta = z.infer<typeof MapMeta>;
export type Layout = z.infer<typeof Layout>;
export type Turn = z.infer<typeof Turn>;
