# Think

对话式的 AI 系统思维工具（个人自用）。设计文档：[docs/SystemsMap_SPEC_v2.md](docs/SystemsMap_SPEC_v2.md)（v2.1）。

## 开发

```
npm install
npm run dev        # 服务 127.0.0.1:5174 + 页面 http://localhost:5173
npm test           # 单元测试（含 core/ 依赖边界检查）
npm run typecheck
npx tsx scripts/smoke-cli.ts [model]   # 真实调用一次 claude -p，检查结构化输出
```

AI 通过本机已登录的 Claude Code CLI 调用（使用订阅，不需要 API key）。
工作区数据默认在 `~/Documents/Think`，不在仓库内。
