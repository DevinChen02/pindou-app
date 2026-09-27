# 云端大模型代理（Cloudflare Worker，可选）

作用：API Key 保存在你自己的 Worker 里，手机上只存一个口令。

1. Cloudflare 控制台 → Workers & Pages → Create → Worker，名字如 `pindou-proxy` → Deploy。
2. Edit code：把本目录的 `worker.js` 全部粘贴进去 → Deploy。
3. Settings → Variables and Secrets，添加（类型 Secret）：
   - `PROXY_TOKEN`：自己设一个长口令
   - `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`：用哪家填哪家
   - 可选（普通变量）`ALLOWED_ORIGIN`：应用网址，如 `https://你的用户名.github.io`
4. 在拼豆计数器 设置 → 云端大模型 → 连接方式选“Worker 代理”，填 Worker 网址和口令，点“保存并启用”。

会用命令行的话也可以：`npx wrangler deploy`，再 `npx wrangler secret put PROXY_TOKEN` 等。
