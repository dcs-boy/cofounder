# Cofounder LLM Provider 改造计划：CLI Provider

## 目标
将 Cofounder 的 LLM 调用从直接 API 改为通过 Claude Code CLI / Codex CLI 调用，使用订阅额度而非按 token 计费。

## 环境
- Claude Code: Pro 订阅
- Codex CLI: ChatGPT Plus 订阅
- Embedding: 保留 OpenAI API（费用极低）

## 核心需求
1. 支持 claude-cli / codex-cli 作为 LLM_PROVIDER
2. **Rate limit 自动恢复**：CLI 因 limit 暂停时，等待恢复后自动继续
3. **断点续传**：利用现有 resume 机制，失败时可从中断点重新开始
4. stream 接口与现有 `{write, cutoff}` 兼容

## 调用链
```
Node → system.run('op:LLM::GEN') → llm.js → provider.inference({model, messages, stream}) → {text, usage}
```

## 修改文件清单

### 新建
1. `utils/claude-cli.js` - Claude Code CLI provider
2. `utils/codex-cli.js` - Codex CLI provider

### 修改
3. `utils/index.js` - 导入新 provider
4. `system/functions/op/llm.js` - provider 选择逻辑（改 5 行）
5. `.env` - 新增 LLM_PROVIDER 选项
6. `system/structure/nodes/op/llm.yaml` - concurrency 改为 1

### 不改
- build.js（已有 retry + resume）
- server.js
- parsers.js
- 所有其他 node function

## Rate Limit 处理策略
Claude Pro 的 rate limit 通常是返回 HTTP 429 或 CLI 输出特定错误信息。
策略：
1. CLI 进程退出码非 0 时，检测 stderr 中是否包含 rate limit 关键词
2. 如果是 rate limit → sleep 指定时间后重试
3. 利用 async-retry 的现有 5 次重试机制
4. 增加重试间隔的 exponential backoff

## 断点续传
build.js 已有 `context.sequence.resume` 机制：
- 每个 step 完成后 state 已写入磁盘
- 如果整个进程崩溃，可以通过 resume_at 参数从指定 step 重新开始
- 不需要额外改造

## 关键细节
- messages 格式：统一使用 OpenAI 格式（现有代码已经这样做）
- stream：CLI 的 stdout 通过 `proc.stdout.on('data')` 转为 stream.write()
- system prompt：Claude Code CLI 支持 `--system-prompt` 参数
- 超长 prompt：通过 stdin pipe 传入，避免参数溢出
- Embedding/向量化：保留 OpenAI API 不变
