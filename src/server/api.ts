// 前后端共享的 API 类型
export interface HealthResponse {
  ok: true;
  node: string;
  schemaVersion: number;
}
